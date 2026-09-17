import type { Channel, Digest, DigestGroup } from "./channels/channel.js";
import type { Db } from "./db.js";

export interface DigestSettings {
  threshold: number;
  maxItems: number;
}

interface Candidate {
  id: number;
  title: string;
  url: string;
  score: number;
  summary: string | null;
  source: string;
  sourceRef: string | null;
  topics: CandidateTopic[];
}

interface CandidateTopic {
  id: number;
  label: string;
}

type CandidateRow = Omit<Candidate, "topics">;

export async function sendDigest({
  db,
  channel,
  settings,
  now = new Date(),
}: {
  db: Db;
  channel: Channel;
  settings: DigestSettings;
  now?: Date;
}): Promise<string> {
  const candidates = loadCandidates(db);

  if (candidates.length === 0) {
    return "No article scored since the last digest: nothing to send.";
  }

  const isDeliverable = (item: Candidate) => item.score >= settings.threshold && item.topics.length > 0;
  const deliverable = candidates.filter(isDeliverable);
  const retained = deliverable.slice(0, settings.maxItems);
  const rejected = candidates.filter((item) => !isDeliverable(item));

  if (retained.length > 0) {
    const digest: Digest = {
      date: now.toISOString().slice(0, 10),
      threshold: settings.threshold,
      groups: groupByTopic(retained),
    };
    await channel.send(digest);
  }

  const markSent = db.prepare("UPDATE raw_items SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const markDiscarded = db.prepare("UPDATE raw_items SET status = 'discarded' WHERE id = ?");
  db.transaction(() => {
    for (const item of retained) markSent.run(item.id);
    for (const item of rejected) markDiscarded.run(item.id);
  })();

  const postponed = deliverable.length - retained.length;
  return (
    `Digest sent: ${retained.length} retained, ${rejected.length} discarded` +
    (postponed > 0 ? `, ${postponed} postponed to the next digest.` : ".")
  );
}

function loadCandidates(db: Db): Candidate[] {
  const rows = db
    .prepare(
      `SELECT id, title, url, score, summary, source, source_ref AS sourceRef
       FROM raw_items
       WHERE status = 'processed'
       ORDER BY score DESC, id DESC`,
    )
    .all() as CandidateRow[];

  const topicRows = db
    .prepare(
      `SELECT it.item_id AS itemId, t.id, t.label
       FROM item_topics it
       JOIN topics t ON t.id = it.topic_id
       JOIN raw_items i ON i.id = it.item_id
       WHERE i.status = 'processed'
       ORDER BY it.item_id, it.position`,
    )
    .all() as ({ itemId: number } & CandidateTopic)[];

  const topicsByItem = new Map<number, CandidateTopic[]>();
  for (const { itemId, ...topic } of topicRows) {
    topicsByItem.set(itemId, [...(topicsByItem.get(itemId) ?? []), topic]);
  }
  return rows.map((row) => ({ ...row, topics: topicsByItem.get(row.id) ?? [] }));
}

function groupByTopic(items: readonly Candidate[]): DigestGroup[] {
  const groups = new Map<number, DigestGroup>();
  for (const item of items) {
    for (const { id, label } of item.topics) {
      const group = groups.get(id) ?? { topicId: id, topic: label, items: [] };
      group.items.push({
        title: item.title,
        url: item.url,
        score: item.score,
        summary: item.summary ?? "",
        source: item.sourceRef ?? item.source,
        topics: item.topics.map((topic) => topic.label),
      });
      groups.set(id, group);
    }
  }
  return [...groups.values()].sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
}

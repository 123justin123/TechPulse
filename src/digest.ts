import type { Channel, Digest, DigestGroup } from "./channels/channel.js";
import type { Db } from "./db.js";

export const UNCLASSIFIED_TOPIC = "Unclassified";

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
  topic: string;
}

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
  const candidates = db
    .prepare(
      `SELECT i.id, i.title, i.url, i.score, i.summary, i.source, i.source_ref AS sourceRef,
              COALESCE(t.label, ?) AS topic
       FROM raw_items i
       LEFT JOIN topics t ON t.id = i.topic_id
       WHERE i.status = 'processed'
       ORDER BY i.score DESC, i.id DESC`,
    )
    .all(UNCLASSIFIED_TOPIC) as Candidate[];

  if (candidates.length === 0) {
    return "No article scored since the last digest: nothing to send.";
  }

  const aboveThreshold = candidates.filter((item) => item.score >= settings.threshold);
  const retained = aboveThreshold.slice(0, settings.maxItems);
  const rejected = candidates.filter((item) => item.score < settings.threshold);

  const digest: Digest = {
    date: now.toISOString().slice(0, 10),
    threshold: settings.threshold,
    totalConsidered: candidates.length,
    groups: groupByTopic(retained),
  };

  await channel.send(digest);

  const markSent = db.prepare("UPDATE raw_items SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const markDiscarded = db.prepare("UPDATE raw_items SET status = 'discarded' WHERE id = ?");
  db.transaction(() => {
    for (const item of retained) markSent.run(item.id);
    for (const item of rejected) markDiscarded.run(item.id);
  })();

  const postponed = aboveThreshold.length - retained.length;
  return (
    `Digest sent: ${retained.length} retained, ${rejected.length} discarded` +
    (postponed > 0 ? `, ${postponed} postponed to the next digest.` : ".")
  );
}

function groupByTopic(items: readonly Candidate[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup["items"]>();
  for (const item of items) {
    const groupItems = groups.get(item.topic) ?? [];
    groupItems.push({
      title: item.title,
      url: item.url,
      score: item.score,
      summary: item.summary ?? "",
      source: item.sourceRef ?? item.source,
    });
    groups.set(item.topic, groupItems);
  }

  return [...groups.entries()]
    .map(([topic, groupItems]) => ({ topic, items: groupItems }))
    .sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
}

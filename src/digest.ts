import { sql } from "kysely";
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
  const candidates = await loadCandidates(db);

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

  await db.transaction().execute(async (trx) => {
    if (retained.length > 0) {
      await trx
        .updateTable("raw_items")
        .set({ status: "sent", sent_at: sql`datetime('now')` })
        .where(
          "id",
          "in",
          retained.map((item) => item.id),
        )
        .execute();
    }
    if (rejected.length > 0) {
      await trx
        .updateTable("raw_items")
        .set({ status: "discarded" })
        .where(
          "id",
          "in",
          rejected.map((item) => item.id),
        )
        .execute();
    }
  });

  const postponed = deliverable.length - retained.length;
  return (
    `Digest sent: ${retained.length} retained, ${rejected.length} discarded` +
    (postponed > 0 ? `, ${postponed} postponed to the next digest.` : ".")
  );
}

async function loadCandidates(db: Db): Promise<Candidate[]> {
  const rows = await db
    .selectFrom("raw_items")
    .select(["id", "title", "url", "score", "summary", "source", "source_ref as sourceRef"])
    .where("status", "=", "processed")
    .where("score", "is not", null)
    .$narrowType<{ score: number }>()
    .orderBy("score", "desc")
    .orderBy("id", "desc")
    .execute();

  const topicRows = await db
    .selectFrom("item_topics")
    .innerJoin("topics", "topics.id", "item_topics.topic_id")
    .innerJoin("raw_items", "raw_items.id", "item_topics.item_id")
    .select(["item_topics.item_id as itemId", "topics.id", "topics.label"])
    .where("raw_items.status", "=", "processed")
    .orderBy("item_topics.item_id")
    .orderBy("item_topics.position")
    .execute();

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

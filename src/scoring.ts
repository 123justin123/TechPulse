import { sql } from "kysely";
import { z } from "zod";
import type { Db, ItemStatus } from "./db/schema.js";
import { errorMessage, type Logger } from "./lib/logger.js";
import { LlmError, type LlmProvider } from "./llm/provider.js";
import { listTopics, type Topic } from "./topics.js";

export interface ScoringSettings {
  batchSize: number;
  maxAttempts: number;
  maxItemsPerRun: number;
  rescoreWindowHours: number;
}

interface PendingItem {
  id: number;
  title: string;
  content: string | null;
  source: string;
  sourceRef: string | null;
}

interface Verdict {
  index: number;
  topics: string[];
  score: number;
  summary: string;
}

function buildSystemPrompt(language: string): string {
  return `You triage a technology news feed for a reader whose interests are defined by the
followed topics.

For each article you receive an index, a title, its source and an excerpt. For each one,
you return the topics it belongs to, a relevance score and a summary.

TOPICS: list every topic from the provided list whose definition the article genuinely
fits, the best fit first. Most articles fit one topic; add another only when the article
is substantially about it too, not when it is merely mentioned. If the article does not
belong to any topic in the list, return an empty list. Never force an approximate match.

SCORE from 0 to 10, measuring relevance for THIS reader, not the general quality of the article:
  0-3  off-topic, or promotional content without technical substance
  4-5  loosely related to the reader's topics, optional reading
  6-7  interesting, worth reading
  8-10 must read: goes deep into one of the topics with real technical substance
An article without any topic never scores above 3. Be strict: a useful digest is a
short digest, and most articles in a feed are of no particular interest to anyone.

SUMMARY: one or two factual sentences, written in ${language}, stating what the article
concretely brings. No hook, no "this article explains that".

Return one verdict per article, reusing the provided index.`;
}

function buildUserPrompt(topics: readonly Topic[], items: readonly PendingItem[]): string {
  const topicSection = topics.map((topic) => `### ${topic.label}\n${topic.description}`).join("\n\n");
  const itemSection = items
    .map(
      (item, index) =>
        `[${index}] TITLE: ${item.title}\n` +
        `    SOURCE: ${item.sourceRef ?? item.source}\n` +
        `    EXCERPT: ${item.content ?? "(no excerpt available)"}`,
    )
    .join("\n\n");

  return `## Followed topics\n\n${topicSection}\n\n## Articles to triage\n\n${itemSection}`;
}

function buildVerdictSchema(topics: readonly Topic[]) {
  return z.object({
    verdicts: z.array(
      z.object({
        index: z.number().int().describe("Index of the article, as given in the prompt."),
        topics: z
          .array(z.enum(topics.map((topic) => topic.label)))
          .describe("Topics the article belongs to, the best fit first. Empty when none fits."),
        score: z.number().int().min(0).max(10),
        summary: z.string(),
      }),
    ),
  });
}

export async function scorePending({
  db,
  llm,
  language,
  settings,
  log,
}: {
  db: Db;
  llm: LlmProvider;
  language: string;
  settings: ScoringSettings;
  log: Logger;
}): Promise<string> {
  const topics = await listTopics(db, { activeOnly: true });
  if (topics.length === 0) {
    return "No active topic, nothing to score.";
  }

  const pending = await db
    .selectFrom("raw_items")
    .select(["id", "title", "content", "source", "source_ref as sourceRef"])
    .where("status", "=", "pending")
    .where("attempts", "<", settings.maxAttempts)
    .orderBy("published_at", (order) => order.desc().nullsLast())
    .orderBy("id", "desc")
    .limit(settings.maxItemsPerRun)
    .execute();

  if (pending.length === 0) {
    return "No pending article.";
  }

  const schema = buildVerdictSchema(topics);
  const systemPrompt = buildSystemPrompt(language);
  const topicIds = new Map(topics.map((topic) => [topic.label, topic.id]));

  let scoredCount = 0;
  let failedCount = 0;

  for (let offset = 0; offset < pending.length; offset += settings.batchSize) {
    const batch = pending.slice(offset, offset + settings.batchSize);
    try {
      const { verdicts } = await llm.completeJson({
        system: systemPrompt,
        prompt: buildUserPrompt(topics, batch),
        schema,
        model: llm.models.scoring,
        effort: "medium",
      });
      scoredCount += await applyVerdicts(db, batch, verdicts, topicIds, settings.maxAttempts);
    } catch (error) {
      if (!(error instanceof LlmError) || error.kind !== "content") {
        const reason = error instanceof LlmError && error.kind === "transient" ? "API unavailable" : "configuration";
        throw new Error(
          `Scoring stopped (${reason}) after ${scoredCount} scored articles, no article penalized: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      log.warn(`Batch of ${batch.length} articles failed, one attempt charged: ${error.message}`);
      await chargeAttempt(db, batch, settings.maxAttempts);
      failedCount += batch.length;
    }
  }

  return `${scoredCount} articles scored, ${failedCount} failed.`;
}

export async function requeueRecentItems(db: Db, windowHours: number): Promise<number> {
  if (windowHours === 0) return 0;
  const { numUpdatedRows } = await db
    .updateTable("raw_items")
    .set({ status: "pending", attempts: 0 })
    .where("status", "in", ["processed", "discarded"])
    .where("fetched_at", ">=", sql<string>`datetime('now', ${`-${windowHours} hours`})`)
    .executeTakeFirst();
  return Number(numUpdatedRows);
}

async function applyVerdicts(
  db: Db,
  batch: readonly PendingItem[],
  verdicts: readonly Verdict[],
  topicIds: ReadonlyMap<string, number>,
  maxAttempts: number,
): Promise<number> {
  const verdictsByIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const unanswered = batch.filter((_, index) => !verdictsByIndex.has(index));

  await db.transaction().execute(async (trx) => {
    for (const [index, item] of batch.entries()) {
      const verdict = verdictsByIndex.get(index);
      if (!verdict) continue;

      await trx
        .updateTable("raw_items")
        .set({
          status: "processed",
          score: verdict.score,
          summary: verdict.summary,
          processed_at: sql`datetime('now')`,
        })
        .where("id", "=", item.id)
        .execute();
      await trx.deleteFrom("item_topics").where("item_id", "=", item.id).execute();

      const itemTopicIds = [...new Set(verdict.topics.flatMap((label) => topicIds.get(label) ?? []))];
      if (itemTopicIds.length > 0) {
        await trx
          .insertInto("item_topics")
          .values(itemTopicIds.map((topicId, position) => ({ item_id: item.id, topic_id: topicId, position })))
          .execute();
      }
    }
    await chargeAttempt(trx, unanswered, maxAttempts);
  });

  return batch.length - unanswered.length;
}

async function chargeAttempt(db: Db, items: readonly PendingItem[], maxAttempts: number): Promise<void> {
  if (items.length === 0) return;
  await db
    .updateTable("raw_items")
    .set((eb) => ({
      attempts: eb("attempts", "+", 1),
      status: sql<ItemStatus>`CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE status END`,
    }))
    .where(
      "id",
      "in",
      items.map((item) => item.id),
    )
    .execute();
}

import { z } from "zod";
import type { Db } from "./db.js";
import { LlmError, type LlmProvider } from "./llm/provider.js";
import { errorMessage, type Logger } from "./logger.js";
import { listTopics, type Topic } from "./topics.js";

export interface ScoringSettings {
  batchSize: number;
  maxAttempts: number;
  maxItemsPerRun: number;
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
  const topics = listTopics(db, { activeOnly: true });
  if (topics.length === 0) {
    return "No active topic, nothing to score.";
  }

  const pending = db
    .prepare(
      `SELECT id, title, content, source, source_ref AS sourceRef
       FROM raw_items
       WHERE status = 'pending' AND attempts < ?
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT ?`,
    )
    .all(settings.maxAttempts, settings.maxItemsPerRun) as PendingItem[];

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
      scoredCount += applyVerdicts(db, batch, verdicts, topicIds, settings.maxAttempts);
    } catch (error) {
      if (!(error instanceof LlmError) || error.kind !== "content") {
        const reason = error instanceof LlmError && error.kind === "transient" ? "API unavailable" : "configuration";
        throw new Error(
          `Scoring stopped (${reason}) after ${scoredCount} scored articles, no article penalized: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      log.warn(`Batch of ${batch.length} articles failed, one attempt charged: ${error.message}`);
      chargeAttempt(db, batch, settings.maxAttempts);
      failedCount += batch.length;
    }
  }

  return `${scoredCount} articles scored, ${failedCount} failed.`;
}

function applyVerdicts(
  db: Db,
  batch: readonly PendingItem[],
  verdicts: readonly Verdict[],
  topicIds: ReadonlyMap<string, number>,
  maxAttempts: number,
): number {
  const markProcessed = db.prepare(
    `UPDATE raw_items
     SET status = 'processed', score = ?, summary = ?, processed_at = datetime('now')
     WHERE id = ?`,
  );
  const clearTopics = db.prepare("DELETE FROM item_topics WHERE item_id = ?");
  const addTopic = db.prepare("INSERT INTO item_topics (item_id, topic_id, position) VALUES (?, ?, ?)");
  const verdictsByIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const unanswered = batch.filter((_, index) => !verdictsByIndex.has(index));

  return db.transaction(() => {
    batch.forEach((item, index) => {
      const verdict = verdictsByIndex.get(index);
      if (!verdict) return;
      markProcessed.run(verdict.score, verdict.summary, item.id);
      clearTopics.run(item.id);
      const itemTopicIds = new Set(verdict.topics.flatMap((label) => topicIds.get(label) ?? []));
      [...itemTopicIds].forEach((topicId, position) => {
        addTopic.run(item.id, topicId, position);
      });
    });
    chargeAttempt(db, unanswered, maxAttempts);
    return batch.length - unanswered.length;
  })();
}

function chargeAttempt(db: Db, items: readonly PendingItem[], maxAttempts: number): void {
  const charge = db.prepare(
    `UPDATE raw_items
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const item of items) charge.run(maxAttempts, item.id);
  })();
}

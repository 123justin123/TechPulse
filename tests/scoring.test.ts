import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sql } from "kysely";
import type { Db, ItemStatus } from "../src/db/schema.js";
import { LlmError, type LlmProvider } from "../src/llm/provider.js";
import { requeueRecentItems, type ScoringSettings, scorePending } from "../src/scoring.js";
import {
  type AnyParams,
  fakeLlm,
  insertItems,
  insertTopic,
  memoryDb,
  recordingLog,
  statusCounts,
  TEST_LANGUAGE,
  totalAttempts,
} from "./support/helpers.js";

const SETTINGS: ScoringSettings = { batchSize: 8, maxAttempts: 3, maxItemsPerRun: 60, rescoreWindowHours: 48 };

function verdictsFor(params: AnyParams, { skipIndex }: { skipIndex?: number } = {}) {
  const itemCount = [...params.prompt.matchAll(/^\[(\d+)\] TITLE/gm)].length;
  return {
    verdicts: Array.from({ length: itemCount }, (_, index) => {
      const isUnclassified = index % 3 === 2;
      return {
        index,
        topics: isUnclassified ? [] : ["Finance"],
        score: isUnclassified ? 1 : 9 - (index % 3),
        summary: `Summary ${index}.`,
      };
    }).filter((verdict) => verdict.index !== skipIndex),
  };
}

async function topicLabelsOf(db: Db, itemId: number): Promise<string[]> {
  const rows = await db
    .selectFrom("item_topics")
    .innerJoin("topics", "topics.id", "item_topics.topic_id")
    .select("topics.label")
    .where("item_topics.item_id", "=", itemId)
    .orderBy("item_topics.position")
    .execute();
  return rows.map((row) => row.label);
}

function stateOf(db: Db, itemId: number) {
  return db.selectFrom("raw_items").select(["status", "attempts"]).where("id", "=", itemId).executeTakeFirstOrThrow();
}

async function setup(itemCount: number) {
  const db = memoryDb();
  await insertTopic(db, "Finance", "Financial markets and fintech.");
  const [firstId = 0, ...otherIds] = await insertItems(db, itemCount);
  return { db, firstId, otherIds, ...recordingLog() };
}

function score(db: Db, llm: LlmProvider, log = recordingLog().log, settings = SETTINGS) {
  return scorePending({ db, llm, language: TEST_LANGUAGE, settings, log });
}

describe("scorePending", () => {
  it("does nothing without an active topic", async () => {
    const db = memoryDb();
    await insertItems(db, 3);
    const { llm, calls } = fakeLlm(() => ({ verdicts: [] }));
    assert.match(await score(db, llm), /No active topic/);
    assert.equal(calls.length, 0);
  });

  it("sends full batches and applies the verdicts", async () => {
    const { db, log } = await setup(16);
    const { llm, calls } = fakeLlm((params) => verdictsFor(params));

    const summary = await score(db, llm, log);

    assert.equal(summary, "16 articles scored, 0 failed.");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.model, "scoring-model");
      assert.equal(call.effort, "medium");
      assert.match(call.system, /written in English/);
    }
    const prompt = calls[0]?.prompt ?? "";
    assert.match(prompt, /### Finance\nFinancial markets and fintech\./);
    assert.match(prompt, /^\[7\] TITLE: Title article 7$/m);

    assert.deepEqual(await statusCounts(db), { processed: 16 });
    const unclassified = await db
      .selectFrom("raw_items")
      .select(["id", "score"])
      .where("title", "=", "Title article 2")
      .executeTakeFirstOrThrow();
    assert.equal(unclassified.score, 1);
    assert.deepEqual(await topicLabelsOf(db, unclassified.id), []);
  });

  it("stores every topic of an article in the order given by the LLM, without duplicates", async () => {
    const { db, firstId, log } = await setup(1);
    await insertTopic(db, "Linux", "The Linux kernel.");
    const { llm } = fakeLlm(() => ({
      verdicts: [{ index: 0, topics: ["Linux", "Finance", "Linux"], score: 8, summary: "Summary." }],
    }));

    await score(db, llm, log);

    assert.deepEqual(await topicLabelsOf(db, firstId), ["Linux", "Finance"]);
  });

  it("keeps an article without verdict pending and charges it an attempt", async () => {
    const { db, firstId, log } = await setup(8);
    const { llm } = fakeLlm((params) => verdictsFor(params, { skipIndex: 0 }));

    await score(db, llm, log);

    assert.deepEqual(await stateOf(db, firstId), { status: "pending", attempts: 1 });
    assert.deepEqual(await statusCounts(db), { pending: 1, processed: 7 });
  });

  it("marks an article without verdict as failed once it reaches the attempt limit", async () => {
    const { db, firstId, log } = await setup(2);
    await db.updateTable("raw_items").set({ attempts: 2 }).where("id", "=", firstId).execute();
    const { llm } = fakeLlm((params) => verdictsFor(params, { skipIndex: 0 }));

    await score(db, llm, log);

    assert.deepEqual(await stateOf(db, firstId), { status: "failed", attempts: 3 });
  });

  it("charges an attempt to a batch with unusable output, then moves on", async () => {
    const { db, log } = await setup(16);
    const { llm } = fakeLlm((params, call) =>
      call === 1
        ? { verdicts: [{ index: 0, topics: ["Made-up topic"], score: 5, summary: "x" }] }
        : verdictsFor(params),
    );

    const summary = await score(db, llm, log);

    assert.equal(summary, "8 articles scored, 8 failed.");
    assert.equal(await totalAttempts(db), 8);
    assert.deepEqual(await statusCounts(db), { pending: 8, processed: 8 });
  });

  it("removes an article from the queue on its third failure", async () => {
    const { db, firstId, log } = await setup(1);
    await db.updateTable("raw_items").set({ attempts: 2 }).where("id", "=", firstId).execute();
    const { llm } = fakeLlm(() => {
      throw new LlmError("Request refused by the model.", "content");
    });

    await score(db, llm, log);

    assert.deepEqual(await stateOf(db, firstId), { status: "failed", attempts: 3 });
  });

  it("stops scoring without penalizing anyone when the API is down", async () => {
    const { db, log } = await setup(16);
    const { llm } = fakeLlm((params, call) => {
      if (call === 2) throw new LlmError("Rate limit reached.", "transient");
      return verdictsFor(params);
    });

    await assert.rejects(
      score(db, llm, log),
      /Scoring stopped \(API unavailable\) after 8 scored articles, no article penalized/,
    );
    assert.equal(await totalAttempts(db), 0);
    assert.deepEqual(await statusCounts(db), { pending: 8, processed: 8 }, "the first batch is kept");
  });

  it("stops scoring on a configuration problem or an unexpected error", async () => {
    for (const failure of [new LlmError("API key rejected.", "config"), new Error("unexpected")]) {
      const { db, log } = await setup(4);
      const { llm } = fakeLlm(() => {
        throw failure;
      });
      await assert.rejects(score(db, llm, log), /Scoring stopped \(configuration\)/);
      assert.equal(await totalAttempts(db), 0);
    }
  });
});

describe("requeueRecentItems", () => {
  it("sends back to scoring the recent articles not sent yet and resets their attempts", async () => {
    const db = memoryDb();
    const ids = await insertItems(db, 6);
    const states: [status: ItemStatus, attempts: number, age: string][] = [
      ["processed", 1, "-1 hours"],
      ["discarded", 0, "-47 hours"],
      ["discarded", 0, "-49 hours"],
      ["sent", 0, "-1 hours"],
      ["failed", 3, "-1 hours"],
      ["pending", 2, "-1 hours"],
    ];
    for (const [index, [status, attempts, age]] of states.entries()) {
      await db
        .updateTable("raw_items")
        .set({ status, attempts, fetched_at: sql`datetime('now', ${age})` })
        .where("id", "=", ids[index] ?? 0)
        .execute();
    }

    assert.equal(await requeueRecentItems(db, 48), 2);

    assert.deepEqual(await db.selectFrom("raw_items").select(["status", "attempts"]).orderBy("id").execute(), [
      { status: "pending", attempts: 0 },
      { status: "pending", attempts: 0 },
      { status: "discarded", attempts: 0 },
      { status: "sent", attempts: 0 },
      { status: "failed", attempts: 3 },
      { status: "pending", attempts: 2 },
    ]);
  });

  it("does nothing when the window is 0", async () => {
    const db = memoryDb();
    await insertItems(db, 1);
    await db.updateTable("raw_items").set({ status: "discarded" }).execute();
    assert.equal(await requeueRecentItems(db, 0), 0);
    assert.deepEqual(await statusCounts(db), { discarded: 1 });
  });
});

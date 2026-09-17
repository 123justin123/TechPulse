import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "../src/db.js";
import { LlmError, type LlmProvider } from "../src/llm/provider.js";
import { type ScoringSettings, scorePending } from "../src/scoring.js";
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
} from "./helpers.js";

const SETTINGS: ScoringSettings = { batchSize: 8, maxAttempts: 3, maxItemsPerRun: 60 };

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

function topicLabelsOf(db: Db, itemId: number | undefined): string[] {
  return (
    db
      .prepare(
        `SELECT t.label FROM item_topics it JOIN topics t ON t.id = it.topic_id
         WHERE it.item_id = ? ORDER BY it.position`,
      )
      .all(itemId) as { label: string }[]
  ).map((row) => row.label);
}

function setup(itemCount: number) {
  const db = memoryDb();
  insertTopic(db, "Finance", "Financial markets and fintech.");
  const ids = insertItems(db, itemCount);
  return { db, ids, ...recordingLog() };
}

function score(db: Db, llm: LlmProvider, log = recordingLog().log, settings = SETTINGS) {
  return scorePending({ db, llm, language: TEST_LANGUAGE, settings, log });
}

describe("scorePending", () => {
  it("does nothing without an active topic", async () => {
    const db = memoryDb();
    insertItems(db, 3);
    const { llm, calls } = fakeLlm(() => ({ verdicts: [] }));
    assert.match(await score(db, llm), /No active topic/);
    assert.equal(calls.length, 0);
  });

  it("sends full batches and applies the verdicts", async () => {
    const { db, log } = setup(16);
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

    assert.deepEqual(statusCounts(db), { processed: 16 });
    const unclassified = db.prepare("SELECT id, score FROM raw_items WHERE title = 'Title article 2'").get() as {
      id: number;
      score: number;
    };
    assert.equal(unclassified.score, 1);
    assert.deepEqual(topicLabelsOf(db, unclassified.id), []);
  });

  it("stores every topic of an article in the order given by the LLM, without duplicates", async () => {
    const { db, ids, log } = setup(1);
    insertTopic(db, "Linux", "The Linux kernel.");
    const { llm } = fakeLlm(() => ({
      verdicts: [{ index: 0, topics: ["Linux", "Finance", "Linux"], score: 8, summary: "Summary." }],
    }));

    await score(db, llm, log);

    assert.deepEqual(topicLabelsOf(db, ids[0]), ["Linux", "Finance"]);
  });

  it("keeps an article without verdict pending and charges it an attempt", async () => {
    const { db, ids, log } = setup(8);
    const { llm } = fakeLlm((params) => verdictsFor(params, { skipIndex: 0 }));

    await score(db, llm, log);

    const first = db.prepare("SELECT status, attempts FROM raw_items WHERE id = ?").get(ids[0]);
    assert.deepEqual(first, { status: "pending", attempts: 1 });
    assert.deepEqual(statusCounts(db), { pending: 1, processed: 7 });
  });

  it("marks an article without verdict as failed once it reaches the attempt limit", async () => {
    const { db, ids, log } = setup(2);
    db.prepare("UPDATE raw_items SET attempts = 2 WHERE id = ?").run(ids[0]);
    const { llm } = fakeLlm((params) => verdictsFor(params, { skipIndex: 0 }));

    await score(db, llm, log);

    assert.deepEqual(db.prepare("SELECT status, attempts FROM raw_items WHERE id = ?").get(ids[0]), {
      status: "failed",
      attempts: 3,
    });
  });

  it("charges an attempt to a batch with unusable output, then moves on", async () => {
    const { db, log } = setup(16);
    const { llm } = fakeLlm((params, call) =>
      call === 1
        ? { verdicts: [{ index: 0, topics: ["Made-up topic"], score: 5, summary: "x" }] }
        : verdictsFor(params),
    );

    const summary = await score(db, llm, log);

    assert.equal(summary, "8 articles scored, 8 failed.");
    assert.equal(totalAttempts(db), 8);
    assert.deepEqual(statusCounts(db), { pending: 8, processed: 8 });
  });

  it("removes an article from the queue on its third failure", async () => {
    const { db, ids, log } = setup(1);
    db.prepare("UPDATE raw_items SET attempts = 2 WHERE id = ?").run(ids[0]);
    const { llm } = fakeLlm(() => {
      throw new LlmError("Request refused by the model.", "content");
    });

    await score(db, llm, log);

    assert.deepEqual(db.prepare("SELECT status, attempts FROM raw_items").get(), { status: "failed", attempts: 3 });
  });

  it("stops scoring without penalizing anyone when the API is down", async () => {
    const { db, log } = setup(16);
    const { llm } = fakeLlm((params, call) => {
      if (call === 2) throw new LlmError("Rate limit reached.", "transient");
      return verdictsFor(params);
    });

    await assert.rejects(
      score(db, llm, log),
      /Scoring stopped \(API unavailable\) after 8 scored articles, no article penalized/,
    );
    assert.equal(totalAttempts(db), 0);
    assert.deepEqual(statusCounts(db), { pending: 8, processed: 8 }, "the first batch is kept");
  });

  it("stops scoring on a configuration problem or an unexpected error", async () => {
    for (const failure of [new LlmError("API key rejected.", "config"), new Error("unexpected")]) {
      const { db, log } = setup(4);
      const { llm } = fakeLlm(() => {
        throw failure;
      });
      await assert.rejects(score(db, llm, log), /Scoring stopped \(configuration\)/);
      assert.equal(totalAttempts(db), 0);
    }
  });
});

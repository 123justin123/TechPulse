import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendDigest, UNCLASSIFIED_TOPIC } from "../src/digest.js";
import { fakeChannel, insertItems, insertTopic, memoryDb, NOW, statusCounts } from "./helpers.js";

const SETTINGS = { threshold: 6, maxItems: 3 };

function scoredDb() {
  const db = memoryDb();
  const finance = insertTopic(db, "Finance");
  const linux = insertTopic(db, "Linux");
  const ids = insertItems(db, 6);
  const scores: [score: number, topicIds: number[]][] = [
    [9, [finance]],
    [8, [linux, finance]],
    [7, [finance]],
    [6, [linux]],
    [5, []],
    [2, [finance]],
  ];
  const markScored = db.prepare(
    "UPDATE raw_items SET status = 'processed', score = ?, summary = 'Summary.' WHERE id = ?",
  );
  const addTopic = db.prepare("INSERT INTO item_topics (item_id, topic_id, position) VALUES (?, ?, ?)");
  scores.forEach(([score, topicIds], index) => {
    markScored.run(score, ids[index]);
    topicIds.forEach((topicId, position) => {
      addTopic.run(ids[index], topicId, position);
    });
  });
  return db;
}

describe("sendDigest", () => {
  it("sends nothing when no article has been scored", async () => {
    const db = memoryDb();
    insertItems(db, 3);
    const { channel, sent } = fakeChannel();
    const summary = await sendDigest({ db, channel, settings: SETTINGS, now: NOW });
    assert.match(summary, /nothing to send/);
    assert.equal(sent.length, 0);
  });

  it("keeps the best articles above the threshold, discards the rest and postpones the overflow", async () => {
    const db = scoredDb();
    const { channel, sent } = fakeChannel();

    const summary = await sendDigest({ db, channel, settings: SETTINGS, now: NOW });

    assert.equal(summary, "Digest sent: 3 retained, 2 discarded, 1 postponed to the next digest.");
    const digest = sent[0];
    assert.equal(digest?.date, "2026-09-12");
    assert.equal(digest?.totalConsidered, 6);
    assert.deepEqual(
      digest?.groups.map((group) => [group.topic, group.items.map((item) => item.score)]),
      [
        ["Finance", [9, 7]],
        ["Linux", [8]],
      ],
      "the topic with the best score comes first",
    );
    assert.deepEqual(statusCounts(db), { sent: 3, processed: 1, discarded: 2 });
  });

  it("shows an article once in the global view, under its main topic, with all its topics", async () => {
    const db = scoredDb();
    const { channel, sent } = fakeChannel();
    await sendDigest({ db, channel, settings: SETTINGS, now: NOW });
    const items = sent[0]?.groups.flatMap((group) =>
      group.items.map((item) => [group.topicId, group.topic, item.score, item.topics]),
    );
    assert.deepEqual(items, [
      [1, "Finance", 9, ["Finance"]],
      [1, "Finance", 7, ["Finance"]],
      [2, "Linux", 8, ["Linux", "Finance"]],
    ]);
  });

  it("lists an article under every one of its topics in the per-topic view", async () => {
    const db = scoredDb();
    const { channel, sent } = fakeChannel();
    await sendDigest({ db, channel, settings: SETTINGS, now: NOW });
    assert.deepEqual(
      sent[0]?.topicGroups.map((group) => [group.topicId, group.topic, group.items.map((item) => item.score)]),
      [
        [1, "Finance", [9, 8, 7]],
        [2, "Linux", [8]],
      ],
    );
  });

  it("groups articles without a topic under the unclassified section", async () => {
    const db = scoredDb();
    const { channel, sent } = fakeChannel();
    await sendDigest({ db, channel, settings: { threshold: 5, maxItems: 10 }, now: NOW });
    assert.ok(sent[0]?.groups.some((group) => group.topic === UNCLASSIFIED_TOPIC));
  });

  it("leaves every status untouched when sending fails", async () => {
    const db = scoredDb();
    const { channel } = fakeChannel({ failWith: new Error("Discord unreachable") });
    await assert.rejects(sendDigest({ db, channel, settings: SETTINGS, now: NOW }), /Discord unreachable/);
    assert.deepEqual(statusCounts(db), { processed: 6 });
  });
});

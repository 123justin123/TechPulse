import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendDigest } from "../src/digest.js";
import { fakeChannel, insertItems, insertTopic, memoryDb, NOW, statusCounts } from "./support/helpers.js";

const SETTINGS = { threshold: 6, maxItems: 3 };

async function scoredDb(scores: [score: number, topicIds: number[]][]) {
  const db = memoryDb();
  await insertTopic(db, "Finance");
  await insertTopic(db, "Linux");
  const ids = await insertItems(db, scores.length);
  for (const [index, [score, topicIds]] of scores.entries()) {
    const itemId = ids[index] ?? 0;
    await db
      .updateTable("raw_items")
      .set({ status: "processed", score, summary: "Summary." })
      .where("id", "=", itemId)
      .execute();
    for (const [position, topicId] of topicIds.entries()) {
      await db.insertInto("item_topics").values({ item_id: itemId, topic_id: topicId, position }).execute();
    }
  }
  return db;
}

const FINANCE = 1;
const LINUX = 2;

const defaultDb = () =>
  scoredDb([
    [9, [FINANCE]],
    [8, [LINUX, FINANCE]],
    [7, [FINANCE]],
    [6, [LINUX]],
    [5, []],
    [2, [FINANCE]],
  ]);

describe("sendDigest", () => {
  it("sends nothing when no article has been scored", async () => {
    const db = memoryDb();
    await insertItems(db, 3);
    const { channel, sent } = fakeChannel();
    const summary = await sendDigest({ db, channel, settings: SETTINGS, now: NOW });
    assert.match(summary, /nothing to send/);
    assert.equal(sent.length, 0);
  });

  it("keeps the best articles above the threshold, discards the rest and postpones the overflow", async () => {
    const db = await defaultDb();
    const { channel, sent } = fakeChannel();

    const summary = await sendDigest({ db, channel, settings: SETTINGS, now: NOW });

    assert.equal(summary, "Digest sent: 3 retained, 2 discarded, 1 postponed to the next digest.");
    assert.equal(sent[0]?.date, "2026-09-12");
    assert.deepEqual(await statusCounts(db), { sent: 3, processed: 1, discarded: 2 });
  });

  it("lists an article under every one of its topics, the best topic first", async () => {
    const db = await defaultDb();
    const { channel, sent } = fakeChannel();

    await sendDigest({ db, channel, settings: SETTINGS, now: NOW });

    assert.deepEqual(
      sent[0]?.groups.map((group) => [
        group.topicId,
        group.topic,
        group.items.map((item) => [item.score, item.topics]),
      ]),
      [
        [
          FINANCE,
          "Finance",
          [
            [9, ["Finance"]],
            [8, ["Linux", "Finance"]],
            [7, ["Finance"]],
          ],
        ],
        [LINUX, "Linux", [[8, ["Linux", "Finance"]]]],
      ],
    );
  });

  it("discards an article without topic even above the threshold, since no channel can receive it", async () => {
    const db = await scoredDb([
      [9, []],
      [7, [FINANCE]],
    ]);
    const { channel, sent } = fakeChannel();

    const summary = await sendDigest({ db, channel, settings: SETTINGS, now: NOW });

    assert.equal(summary, "Digest sent: 1 retained, 1 discarded.");
    assert.deepEqual(
      sent[0]?.groups.map((group) => group.topic),
      ["Finance"],
    );
  });

  it("calls no channel when nothing reaches the threshold, but still discards the articles", async () => {
    const db = await scoredDb([[3, [FINANCE]]]);
    const { channel, sent } = fakeChannel();

    assert.equal(
      await sendDigest({ db, channel, settings: SETTINGS, now: NOW }),
      "Digest sent: 0 retained, 1 discarded.",
    );
    assert.equal(sent.length, 0);
    assert.deepEqual(await statusCounts(db), { discarded: 1 });
  });

  it("leaves every status untouched when sending fails", async () => {
    const db = await defaultDb();
    const { channel } = fakeChannel({ failWith: new Error("Discord unreachable") });
    await assert.rejects(sendDigest({ db, channel, settings: SETTINGS, now: NOW }), /Discord unreachable/);
    assert.deepEqual(await statusCounts(db), { processed: 6 });
  });
});

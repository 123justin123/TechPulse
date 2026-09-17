import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Channel, Digest, TopicState } from "../../src/channels/channel.js";
import { combineChannels, createChannel } from "../../src/channels/index.js";
import { createTopicRoutes } from "../../src/channels/routes.js";
import type { CommandHandler } from "../../src/commands.js";
import { fakeChannel, insertTopic, memoryDb, recordingLog } from "../support/helpers.js";

const DIGEST: Digest = { date: "2026-09-12", threshold: 6, groups: [] };
const FINANCE: TopicState = { id: 1, label: "Finance", description: "Definition.", active: true };

function failingChannel(name: string): Channel {
  const { channel } = fakeChannel({ failWith: new Error(`${name} is down`) });
  return { ...channel, name };
}

describe("combineChannels", () => {
  it("sends the digest to every channel", async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    await combineChannels([first.channel, second.channel], recordingLog().log).send(DIGEST);
    assert.equal(first.sent.length, 1);
    assert.equal(second.sent.length, 1);
  });

  it("logs a partial failure without throwing, so delivered articles are not sent twice", async () => {
    const working = fakeChannel();
    const { log, lines } = recordingLog();
    await combineChannels([working.channel, failingChannel("slack")], log).send(DIGEST);
    assert.equal(working.sent.length, 1);
    assert.ok(lines.some((line) => line.includes("some channels failed: slack: slack is down")));
  });

  it("throws when no channel received the digest", async () => {
    const combined = combineChannels([failingChannel("slack"), failingChannel("telegram")], recordingLog().log);
    await assert.rejects(combined.send(DIGEST), /could not be sent on any channel/);
  });

  it("starts listening on channels that accept commands and skips the others", async () => {
    const handlers: CommandHandler[] = [];
    const listening: Channel = {
      ...fakeChannel().channel,
      async listen(handler) {
        handlers.push(handler);
      },
    };
    const handler: CommandHandler = async () => [];
    await combineChannels([listening, fakeChannel().channel], recordingLog().log).listen?.(handler);
    assert.deepEqual(handlers, [handler]);
  });

  it("syncs topics on every channel that supports it and logs a failure without throwing", async () => {
    const synced: (readonly TopicState[])[] = [];
    const syncing: Channel = {
      ...fakeChannel().channel,
      async syncTopics(topics) {
        synced.push(topics);
      },
    };
    const broken: Channel = {
      ...fakeChannel().channel,
      name: "slack",
      async syncTopics() {
        throw new Error("slack is down");
      },
    };
    const { log, lines } = recordingLog();

    await combineChannels([syncing, broken, fakeChannel().channel], log).syncTopics?.([FINANCE]);

    assert.deepEqual(synced, [[FINANCE]]);
    assert.ok(lines.some((line) => line.includes("Topics could not be synced on slack: slack is down")));
  });
});

describe("createTopicRoutes", () => {
  it("stores one target per channel and topic", async () => {
    const db = memoryDb();
    const topicId = await insertTopic(db, "Finance");
    const discord = createTopicRoutes(db, "discord");
    const slack = createTopicRoutes(db, "slack");

    await discord.set(topicId, "first");
    await discord.set(topicId, "second");
    await slack.set(topicId, "other");

    assert.equal(await discord.get(topicId), "second");
    assert.equal(await slack.get(topicId), "other");
    await discord.delete(topicId);
    assert.equal(await discord.get(topicId), undefined);
    assert.equal(await slack.get(topicId), "other");
  });

  it("refuses a route to an unknown topic and drops routes with their topic", async () => {
    const db = memoryDb();
    const routes = createTopicRoutes(db, "discord");
    await assert.rejects(routes.set(42, "target"), /FOREIGN KEY constraint failed/);

    const topicId = await insertTopic(db, "Finance");
    await routes.set(topicId, "target");
    await db.deleteFrom("topics").where("id", "=", topicId).execute();
    assert.equal(await routes.get(topicId), undefined);
  });
});

describe("createChannel", () => {
  it("builds a channel from its configuration", () => {
    const channel = createChannel(
      {
        name: "discord",
        settings: { botToken: "bot-token", guildId: undefined },
      },
      { db: memoryDb(), log: recordingLog().log },
    );
    assert.equal(channel.name, "discord");
  });
});

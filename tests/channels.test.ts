import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Channel, Digest } from "../src/channels/channel.js";
import { combineChannels, createChannel } from "../src/channels/index.js";
import type { CommandHandler } from "../src/commands.js";
import { fakeChannel, recordingLog } from "./helpers.js";

const DIGEST: Digest = { date: "2026-09-12", threshold: 6, totalConsidered: 0, groups: [] };

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
});

describe("createChannel", () => {
  it("builds a channel from its configuration", () => {
    const channel = createChannel(
      {
        name: "discord",
        settings: { webhookUrl: "https://discord.test/webhook", botToken: undefined, allowedUserIds: [] },
      },
      recordingLog().log,
    );
    assert.equal(channel.name, "discord");
  });
});

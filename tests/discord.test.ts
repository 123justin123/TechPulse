import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Digest } from "../src/channels/channel.js";
import {
  DiscordChannel,
  renderDigest,
  renderReply,
  SLASH_COMMANDS,
  toCommand,
  type WebhookPayload,
} from "../src/channels/discord.js";
import { JOB_NAMES } from "../src/commands.js";
import { recordingLog, startServer, type TestServer } from "./helpers.js";

const DISCORD_ADMINISTRATOR_PERMISSION = "8";
const LONG_SUMMARY = "A summary sentence of realistic length. ".repeat(6);

const embedLength = (message: WebhookPayload): number =>
  (message.embeds ?? []).reduce((total, embed) => total + (embed.title?.length ?? 0) + embed.description.length, 0);

function digestOf(groups: Digest["groups"]): Digest {
  return { date: "2026-09-12", threshold: 6, totalConsidered: 400, groups };
}

describe("renderDigest", () => {
  it("stays under every Discord limit on a large digest without losing any article", () => {
    const messages = renderDigest(
      digestOf(
        Array.from({ length: 25 }, (_, groupIndex) => ({
          topic: `Topic ${groupIndex}`,
          items: Array.from({ length: 5 }, (_, itemIndex) => ({
            title: `Article ${groupIndex}-${itemIndex}`,
            url: `https://example.test/${groupIndex}/${itemIndex}`,
            score: 10 - itemIndex,
            summary: LONG_SUMMARY,
            source: "Test source",
            otherTopics: [],
          })),
        })),
      ),
    );

    assert.ok(messages.length > 1);
    assert.match(messages[0]?.content ?? "", /^\*\*TechPulse — Saturday,? 12 September 2026\*\*/);
    assert.ok(
      messages.slice(1).every((message) => message.content === undefined),
      "header is not repeated",
    );
    assert.ok(messages.every((message) => (message.embeds ?? []).length <= 10));
    assert.ok(messages.every((message) => embedLength(message) <= 6000));
    const descriptions = messages
      .flatMap((message) => message.embeds ?? [])
      .map((embed) => embed.description)
      .join("\n");
    assert.equal(descriptions.match(/example\.test/g)?.length, 125);
  });

  it("spreads a crowded topic over several embeds and truncates a long title", () => {
    const embeds = renderDigest(
      digestOf([
        {
          topic: "T".repeat(400),
          items: Array.from({ length: 60 }, (_, index) => ({
            title: `Article ${index}`,
            url: `https://example.test/${index}`,
            score: 8,
            summary: LONG_SUMMARY,
            source: "Source",
            otherTopics: [],
          })),
        },
      ]),
    ).flatMap((message) => message.embeds ?? []);

    assert.ok(embeds.length > 1);
    assert.ok(embeds.every((embed) => embed.description.length <= 4096));
    assert.equal(embeds[0]?.title?.length, 256);
    assert.ok(embeds.slice(1).every((embed) => embed.title === undefined));
  });

  it("escapes parentheses in urls so markdown links stay intact", () => {
    const [message] = renderDigest(
      digestOf([
        {
          topic: "Wiki",
          items: [
            {
              title: "Page",
              url: "https://wiki.test/A_(b)",
              score: 9,
              summary: "Summary.",
              source: "Wiki",
              otherTopics: [],
            },
          ],
        },
      ]),
    );
    assert.match(message?.embeds?.[0]?.description ?? "", /\(https:\/\/wiki\.test\/A_%28b%29\)/);
  });

  it("mentions the other topics of an article next to its source", () => {
    const [message] = renderDigest(
      digestOf([
        {
          topic: "Rust",
          items: [
            {
              title: "Rust in the kernel",
              url: "https://example.test/rust",
              score: 8,
              summary: "Summary.",
              source: "LWN",
              otherTopics: ["Linux", "C_Lang"],
            },
          ],
        },
      ]),
    );
    assert.match(message?.embeds?.[0]?.description ?? "", /\*LWN · also in Linux, C\\_Lang\*$/);
  });

  it("renders an empty digest as a single text message", () => {
    const messages = renderDigest({ date: "2026-09-12", threshold: 6, totalConsidered: 42, groups: [] });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.embeds, undefined);
    assert.match(messages[0]?.content ?? "", /out of 42 analyzed/);
  });
});

describe("renderReply", () => {
  it("renders titled sections in bold and escapes their markdown", () => {
    assert.deepEqual(renderReply([{ title: "Topic created: C_Lang", body: "Definition." }, { body: "Plain text." }]), [
      "**Topic created: C\\_Lang**\nDefinition.",
      "Plain text.",
    ]);
  });
});

describe("slash commands", () => {
  const invocation = (commandName: string, subcommand: string | null, options: Record<string, string> = {}) => ({
    commandName,
    subcommand,
    option: (name: string) => options[name] ?? null,
  });

  it("maps each slash command to a channel-agnostic command", () => {
    assert.deepEqual(toCommand(invocation("topic", "add", { phrase: "finance" })), {
      name: "topic-add",
      phrase: "finance",
    });
    assert.deepEqual(toCommand(invocation("topic", "remove", { label: "Finance" })), {
      name: "topic-remove",
      label: "Finance",
    });
    assert.deepEqual(toCommand(invocation("topic", "list")), { name: "topic-list" });
    assert.deepEqual(toCommand(invocation("run", null, { job: "digest" })), { name: "run", job: "digest" });
    assert.equal(toCommand(invocation("run", null, { job: "break-everything" })), null);
    assert.equal(toCommand(invocation("unknown", null)), null);
  });

  it("restricts commands to administrators and offers every job", () => {
    assert.deepEqual(
      SLASH_COMMANDS.map((command) => command.name),
      ["topic", "run"],
    );
    assert.ok(
      SLASH_COMMANDS.every((command) => command.default_member_permissions === DISCORD_ADMINISTRATOR_PERMISSION),
    );
    const runCommand = SLASH_COMMANDS.find((command) => command.name === "run");
    const choices = (runCommand?.options?.[0] as { choices?: { value: string }[] } | undefined)?.choices ?? [];
    assert.deepEqual(
      choices.map((choice) => choice.value),
      [...JOB_NAMES],
    );
  });
});

describe("DiscordChannel", () => {
  let responseStatus = 204;
  let rateLimitedResponses = 0;
  let server: TestServer;

  before(async () => {
    server = await startServer(() => {
      if (rateLimitedResponses > 0) {
        rateLimitedResponses--;
        return { status: 429, body: { retry_after: 0.01 } };
      }
      return { status: responseStatus, body: responseStatus === 204 ? undefined : { message: "simulated error" } };
    });
  });

  after(async () => {
    await server.close();
  });

  const createChannel = () =>
    new DiscordChannel(
      { webhookUrl: `${server.url}/webhook`, botToken: undefined, allowedUserIds: [] },
      recordingLog().log,
    );

  it("posts each message to the webhook without allowing mentions", async () => {
    server.requests.length = 0;
    await createChannel().send(
      digestOf([
        {
          topic: "Finance",
          items: [
            {
              title: "Article",
              url: "https://example.test/a",
              score: 9,
              summary: "Summary.",
              source: "Blog",
              otherTopics: [],
            },
          ],
        },
      ]),
    );
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.method, "POST");
    assert.deepEqual(server.requests[0]?.body.allowed_mentions, { parse: [] });
    assert.equal(server.requests[0]?.body.embeds[0].title, "Finance");
  });

  it("waits for the delay requested by Discord, then retries", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 1;
    await createChannel().send(digestOf([]));
    assert.equal(server.requests.length, 2);
  });

  it("gives up after repeated rate limits", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 10;
    await assert.rejects(createChannel().send(digestOf([])), /Discord webhook failed \(429\)/);
    assert.equal(server.requests.length, 3);
    rateLimitedResponses = 0;
  });

  it("reports a failing webhook", async () => {
    responseStatus = 500;
    await assert.rejects(createChannel().send(digestOf([])), /Discord webhook failed \(500\)/);
    responseStatus = 204;
  });

  it("starts without commands when no bot is configured", async () => {
    const { log, lines } = recordingLog();
    const channel = new DiscordChannel({ webhookUrl: server.url, botToken: undefined, allowedUserIds: [] }, log);
    await channel.listen(async () => [{ body: "never called" }]);
    await channel.close();
    assert.ok(lines.some((line) => line.includes("DISCORD_BOT_TOKEN is not set")));
  });
});

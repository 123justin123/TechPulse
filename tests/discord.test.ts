import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Digest, DigestGroup, DigestItem } from "../src/channels/channel.js";
import {
  DiscordChannel,
  renderDigest,
  renderReply,
  renderTopicDigest,
  SLASH_COMMANDS,
  toCommand,
  type WebhookPayload,
} from "../src/channels/discord.js";
import { createTopicRoutes } from "../src/channels/routes.js";
import { JOB_NAMES } from "../src/commands.js";
import { insertTopic, memoryDb, recordingLog, startServer, type TestServer } from "./helpers.js";

const DISCORD_ADMINISTRATOR_PERMISSION = "8";
const LONG_SUMMARY = "A summary sentence of realistic length. ".repeat(6);

const embedLength = (message: WebhookPayload): number =>
  (message.embeds ?? []).reduce((total, embed) => total + (embed.title?.length ?? 0) + embed.description.length, 0);

function itemOf(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: "Article",
    url: "https://example.test/a",
    score: 9,
    summary: "Summary.",
    source: "Blog",
    topics: [],
    ...overrides,
  };
}

function groupOf(topic: string, items: DigestItem[], topicId: number | null = null): DigestGroup {
  return { topicId, topic, items };
}

function digestOf(groups: DigestGroup[], topicGroups: DigestGroup[] = []): Digest {
  return { date: "2026-09-12", threshold: 6, totalConsidered: 400, groups, topicGroups };
}

describe("renderDigest", () => {
  it("stays under every Discord limit on a large digest without losing any article", () => {
    const messages = renderDigest(
      digestOf(
        Array.from({ length: 25 }, (_, groupIndex) =>
          groupOf(
            `Topic ${groupIndex}`,
            Array.from({ length: 5 }, (_, itemIndex) =>
              itemOf({
                title: `Article ${groupIndex}-${itemIndex}`,
                url: `https://example.test/${groupIndex}/${itemIndex}`,
                score: 10 - itemIndex,
                summary: LONG_SUMMARY,
              }),
            ),
          ),
        ),
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
        groupOf(
          "T".repeat(400),
          Array.from({ length: 60 }, (_, index) =>
            itemOf({ title: `Article ${index}`, url: `https://example.test/${index}`, summary: LONG_SUMMARY }),
          ),
        ),
      ]),
    ).flatMap((message) => message.embeds ?? []);

    assert.ok(embeds.length > 1);
    assert.ok(embeds.every((embed) => embed.description.length <= 4096));
    assert.equal(embeds[0]?.title?.length, 256);
    assert.ok(embeds.slice(1).every((embed) => embed.title === undefined));
  });

  it("escapes parentheses in urls so markdown links stay intact", () => {
    const [message] = renderDigest(digestOf([groupOf("Wiki", [itemOf({ url: "https://wiki.test/A_(b)" })])]));
    assert.match(message?.embeds?.[0]?.description ?? "", /\(https:\/\/wiki\.test\/A_%28b%29\)/);
  });

  it("mentions the other topics of an article next to its source", () => {
    const [message] = renderDigest(
      digestOf([groupOf("Rust", [itemOf({ source: "LWN", topics: ["Rust", "Linux", "C_Lang"] })])]),
    );
    assert.match(message?.embeds?.[0]?.description ?? "", /\*LWN · also in Linux, C\\_Lang\*$/);
  });

  it("renders an empty digest as a single text message", () => {
    const messages = renderDigest({ ...digestOf([]), totalConsidered: 42 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.embeds, undefined);
    assert.match(messages[0]?.content ?? "", /out of 42 analyzed/);
  });
});

describe("renderTopicDigest", () => {
  it("titles the message with the topic and leaves the embeds untitled", () => {
    const group = groupOf("Linux", [itemOf({ source: "LWN", topics: ["Rust", "Linux"] })], 2);
    const [message] = renderTopicDigest(digestOf([], [group]), group);
    assert.match(
      message?.content ?? "",
      /^\*\*Linux — Saturday,? 12 September 2026\*\*\n1 articles · threshold 6\/10$/,
    );
    assert.equal(message?.embeds?.[0]?.title, undefined);
    assert.match(message?.embeds?.[0]?.description ?? "", /\*LWN · also in Rust\*$/);
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
  let failingPath: string | undefined;
  let rateLimitedResponses = 0;
  let server: TestServer;

  before(async () => {
    server = await startServer((request) => {
      if (rateLimitedResponses > 0) {
        rateLimitedResponses--;
        return { status: 429, body: { retry_after: 0.01 } };
      }
      const status = request.url === failingPath ? 404 : responseStatus;
      return { status, body: status === 204 ? undefined : { message: "simulated error" } };
    });
  });

  after(async () => {
    await server.close();
  });

  const createChannel = ({ db = memoryDb(), log = recordingLog().log } = {}) =>
    new DiscordChannel(
      { webhookUrl: `${server.url}/webhook`, botToken: undefined, allowedUserIds: [] },
      log,
      createTopicRoutes(db, "discord"),
    );

  it("posts each message to the webhook without allowing mentions", async () => {
    server.requests.length = 0;
    await createChannel().send(digestOf([groupOf("Finance", [itemOf()])]));
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.method, "POST");
    assert.deepEqual(server.requests[0]?.body.allowed_mentions, { parse: [] });
    assert.equal(server.requests[0]?.body.embeds[0].title, "Finance");
  });

  it("also posts each routed topic to its own channel and skips the others", async () => {
    server.requests.length = 0;
    const db = memoryDb();
    const finance = insertTopic(db, "Finance");
    const linux = insertTopic(db, "Linux");
    createTopicRoutes(db, "discord").set(
      linux,
      JSON.stringify({ channelId: "42", webhookUrl: `${server.url}/linux-webhook` }),
    );
    const item = itemOf({ topics: ["Finance", "Linux"] });

    await createChannel({ db }).send(
      digestOf(
        [groupOf("Finance", [item], finance)],
        [groupOf("Finance", [item], finance), groupOf("Linux", [item], linux)],
      ),
    );

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ["/webhook", "/linux-webhook"],
    );
    assert.match(server.requests[1]?.body.content, /^\*\*Linux — /);
  });

  it("keeps posting the other topics when one topic channel fails", async () => {
    server.requests.length = 0;
    failingPath = "/broken-webhook";
    const db = memoryDb();
    const routes = createTopicRoutes(db, "discord");
    const broken = insertTopic(db, "Broken");
    const linux = insertTopic(db, "Linux");
    routes.set(broken, JSON.stringify({ channelId: "1", webhookUrl: `${server.url}/broken-webhook` }));
    routes.set(linux, JSON.stringify({ channelId: "2", webhookUrl: `${server.url}/linux-webhook` }));
    const { log, lines } = recordingLog();

    await createChannel({ db, log }).send(
      digestOf([], [groupOf("Broken", [itemOf()], broken), groupOf("Linux", [itemOf()], linux)]),
    );

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ["/webhook", "/broken-webhook", "/linux-webhook"],
    );
    assert.ok(lines.some((line) => line.includes('Digest of topic "Broken" could not be posted')));
    failingPath = undefined;
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

  it("starts without commands and without topic channels when no bot is configured", async () => {
    const { log, lines } = recordingLog();
    const channel = createChannel({ log });
    await channel.listen(async () => [{ body: "never called" }]);
    await channel.syncTopics([{ id: 1, label: "Finance", description: "Definition.", active: true }]);
    await channel.close();
    assert.ok(lines.some((line) => line.includes("DISCORD_BOT_TOKEN is not set")));
  });
});

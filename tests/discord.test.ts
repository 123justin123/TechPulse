import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Digest, DigestGroup, DigestItem } from "../src/channels/channel.js";
import {
  DiscordChannel,
  renderDigest,
  renderReply,
  SLASH_COMMANDS,
  toCommand,
  type WebhookPayload,
} from "../src/channels/discord.js";
import { createChannelRoutes, topicRoute } from "../src/channels/routes.js";
import { JOB_NAMES } from "../src/commands.js";
import { memoryDb, recordingLog, startServer, type TestServer } from "./helpers.js";

const DISCORD_ADMINISTRATOR_PERMISSION = "8";
const LONG_SUMMARY = "A summary sentence of realistic length. ".repeat(6);

const embedLength = (message: WebhookPayload): number =>
  (message.embeds ?? []).reduce((total, embed) => total + embed.description.length, 0);

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

function groupOf(topicId: number, topic: string, items: DigestItem[]): DigestGroup {
  return { topicId, topic, items };
}

function digestOf(groups: DigestGroup[]): Digest {
  return { date: "2026-09-12", threshold: 6, groups };
}

function render(group: DigestGroup): WebhookPayload[] {
  return renderDigest(digestOf([group]), group);
}

describe("renderDigest", () => {
  it("titles the first message with the topic and the date", () => {
    const [first, ...others] = render(groupOf(1, "C_Lang", [itemOf()]));
    assert.match(
      first?.content ?? "",
      /^\*\*C\\_Lang — Saturday,? 12 September 2026\*\*\n1 article · threshold 6\/10$/,
    );
    assert.equal(others.length, 0);
    assert.equal(render(groupOf(1, "Rust", [itemOf(), itemOf()]))[0]?.content?.includes("2 articles"), true);
  });

  it("stays under every Discord limit on a crowded topic without losing any article", () => {
    const messages = render(
      groupOf(
        1,
        "Rust",
        Array.from({ length: 125 }, (_, index) =>
          itemOf({ title: `Article ${index}`, url: `https://example.test/${index}`, summary: LONG_SUMMARY }),
        ),
      ),
    );

    assert.ok(messages.length > 1);
    assert.ok(
      messages.slice(1).every((message) => message.content === undefined),
      "header is not repeated",
    );
    assert.ok(messages.every((message) => (message.embeds ?? []).length <= 10));
    assert.ok(messages.every((message) => embedLength(message) <= 6000));
    const embeds = messages.flatMap((message) => message.embeds ?? []);
    assert.ok(embeds.every((embed) => embed.description.length <= 4096));
    assert.equal(
      embeds
        .map((embed) => embed.description)
        .join("\n")
        .match(/example\.test/g)?.length,
      125,
    );
  });

  it("escapes parentheses in urls so markdown links stay intact", () => {
    const [message] = render(groupOf(1, "Wiki", [itemOf({ url: "https://wiki.test/A_(b)" })]));
    assert.match(message?.embeds?.[0]?.description ?? "", /\(https:\/\/wiki\.test\/A_%28b%29\)/);
  });

  it("mentions the other topics of an article next to its source", () => {
    const [message] = render(groupOf(2, "Linux", [itemOf({ source: "LWN", topics: ["Rust", "Linux", "C_Lang"] })]));
    assert.match(message?.embeds?.[0]?.description ?? "", /\*LWN · also in Rust, C\\_Lang\*$/);
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

  const FINANCE = groupOf(1, "Finance", [itemOf()]);
  const LINUX = groupOf(2, "Linux", [itemOf()]);

  const createChannel = ({ log = recordingLog().log, routed = [FINANCE, LINUX] } = {}) => {
    const routes = createChannelRoutes(memoryDb(), "discord");
    for (const group of routed) {
      const path = `${group.topic.toLowerCase()}-webhook`;
      routes.set(topicRoute(group.topicId), JSON.stringify({ channelId: path, webhookUrl: `${server.url}/${path}` }));
    }
    return new DiscordChannel({ botToken: "bot-token", allowedUserIds: ["12"], guildId: undefined }, log, routes);
  };

  it("posts each topic to its own channel without allowing mentions", async () => {
    server.requests.length = 0;
    await createChannel().send(digestOf([FINANCE, LINUX]));
    assert.deepEqual(
      server.requests.map((request) => request.url),
      ["/finance-webhook", "/linux-webhook"],
    );
    assert.equal(server.requests[0]?.method, "POST");
    assert.deepEqual(server.requests[0]?.body.allowed_mentions, { parse: [] });
    assert.match(server.requests[1]?.body.content, /^\*\*Linux — /);
  });

  it("logs the topics that failed or have no channel yet and keeps posting the others", async () => {
    server.requests.length = 0;
    failingPath = "/finance-webhook";
    const broken = groupOf(3, "Broken", [itemOf()]);
    const { log, lines } = recordingLog();

    await createChannel({ log }).send(digestOf([FINANCE, broken, LINUX]));

    assert.deepEqual(
      server.requests.map((request) => request.url),
      ["/finance-webhook", "/linux-webhook"],
    );
    const warning = lines.find((line) => line.includes("some topic channels failed")) ?? "";
    assert.match(warning, /Finance: Discord webhook failed \(404\)/);
    assert.match(warning, /Broken: its channel does not exist yet/);
    failingPath = undefined;
  });

  it("fails when no topic channel received the digest, so articles are not marked as sent", async () => {
    await assert.rejects(
      createChannel({ routed: [] }).send(digestOf([FINANCE])),
      /Digest could not be posted to any topic channel \(Finance: its channel does not exist yet\)/,
    );
  });

  it("waits for the delay requested by Discord, then retries", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 1;
    await createChannel().send(digestOf([FINANCE]));
    assert.equal(server.requests.length, 2);
  });

  it("gives up after repeated rate limits", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 10;
    await assert.rejects(createChannel().send(digestOf([FINANCE])), /Discord webhook failed \(429\)/);
    assert.equal(server.requests.length, 3);
    rateLimitedResponses = 0;
  });

  it("reports a failing webhook", async () => {
    responseStatus = 500;
    await assert.rejects(createChannel().send(digestOf([FINANCE])), /Discord webhook failed \(500\)/);
    responseStatus = 204;
  });

  it("skips channel sync while the bot is not logged in", async () => {
    const db = memoryDb();
    const routes = createChannelRoutes(db, "discord");
    const channel = new DiscordChannel(
      { botToken: "bot-token", allowedUserIds: ["12"], guildId: undefined },
      recordingLog().log,
      routes,
    );
    await channel.syncTopics([{ id: 1, label: "Finance", description: "Definition.", active: true }]);
    assert.equal(routes.get(topicRoute(1)), undefined);
  });
});

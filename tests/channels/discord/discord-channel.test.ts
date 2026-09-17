import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DiscordChannel } from "../../../src/channels/discord/discord-channel.js";
import { createTopicRoutes } from "../../../src/channels/routes.js";
import { digestOf, groupOf, itemOf } from "../../support/digest.js";
import { insertTopic, memoryDb, recordingLog, startServer, type TestServer } from "../../support/helpers.js";

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

  const createChannel = async ({ log = recordingLog().log, routed = [FINANCE, LINUX] } = {}) => {
    const db = memoryDb();
    for (const topic of ["Finance", "Linux", "Broken"]) await insertTopic(db, topic);
    const routes = createTopicRoutes(db, "discord");
    for (const group of routed) {
      const path = `${group.topic.toLowerCase()}-webhook`;
      await routes.set(group.topicId, JSON.stringify({ channelId: path, webhookUrl: `${server.url}/${path}` }));
    }
    return new DiscordChannel({ botToken: "bot-token", allowedUserIds: ["12"], guildId: undefined }, log, routes);
  };

  it("posts each topic to its own channel without allowing mentions", async () => {
    server.requests.length = 0;
    await (await createChannel()).send(digestOf([FINANCE, LINUX]));
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

    await (await createChannel({ log })).send(digestOf([FINANCE, broken, LINUX]));

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
      (await createChannel({ routed: [] })).send(digestOf([FINANCE])),
      /Digest could not be posted to any topic channel \(Finance: its channel does not exist yet\)/,
    );
  });

  it("waits for the delay requested by Discord, then retries", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 1;
    await (await createChannel()).send(digestOf([FINANCE]));
    assert.equal(server.requests.length, 2);
  });

  it("gives up after repeated rate limits", async () => {
    server.requests.length = 0;
    rateLimitedResponses = 10;
    await assert.rejects((await createChannel()).send(digestOf([FINANCE])), /Discord webhook failed \(429\)/);
    assert.equal(server.requests.length, 3);
    rateLimitedResponses = 0;
  });

  it("reports a failing webhook", async () => {
    responseStatus = 500;
    await assert.rejects((await createChannel()).send(digestOf([FINANCE])), /Discord webhook failed \(500\)/);
    responseStatus = 204;
  });

  it("skips channel sync while the bot is not logged in", async () => {
    const db = memoryDb();
    const routes = createTopicRoutes(db, "discord");
    const channel = new DiscordChannel(
      { botToken: "bot-token", allowedUserIds: ["12"], guildId: undefined },
      recordingLog().log,
      routes,
    );
    await channel.syncTopics([{ id: 1, label: "Finance", description: "Definition.", active: true }]);
    assert.equal(await routes.get(1), undefined);
  });
});

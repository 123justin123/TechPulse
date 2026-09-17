import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TopicState } from "../src/channels/channel.js";
import {
  ARCHIVE_CATEGORY,
  channelNameOf,
  type DiscordGuildApi,
  type GuildTextChannel,
  parseWebhookUrl,
  readRoute,
  syncTopicChannels,
  TOPIC_CATEGORY,
} from "../src/channels/discord-topics.js";
import { createChannelRoutes, topicRoute } from "../src/channels/routes.js";
import { insertTopic, memoryDb, recordingLog } from "./helpers.js";

interface FakeCategory {
  id: string;
  name: string;
  readOnly: boolean;
}

function fakeGuild() {
  let nextId = 100;
  const categories: FakeCategory[] = [];
  const channels = new Map<string, GuildTextChannel & { name: string }>();
  const webhooks = new Map<string, string[]>();
  const calls: string[] = [];

  const channelOf = (id: string) => {
    const channel = channels.get(id);
    if (!channel) throw new Error(`Unknown channel ${id}`);
    return channel;
  };

  const api: DiscordGuildApi = {
    async findCategory(name) {
      return categories.find((category) => category.name === name)?.id;
    },
    async createCategory(name, { readOnly }) {
      calls.push(`createCategory ${name}`);
      const id = String(nextId++);
      categories.push({ id, name, readOnly });
      return id;
    },
    async fetchTextChannel(id) {
      const channel = channels.get(id);
      return channel && { id: channel.id, parentId: channel.parentId, topic: channel.topic };
    },
    async createTextChannel({ name, topic, parentId }) {
      calls.push(`createTextChannel ${name}`);
      const channel = { id: String(nextId++), name, topic, parentId };
      channels.set(channel.id, channel);
      return { id: channel.id, parentId, topic };
    },
    async setChannelTopic(id, topic) {
      calls.push(`setChannelTopic ${id}`);
      channelOf(id).topic = topic;
    },
    async moveChannel(id, parentId) {
      calls.push(`moveChannel ${id}`);
      channelOf(id).parentId = parentId;
    },
    async hasWebhook(channelId, url) {
      return (webhooks.get(channelId) ?? []).includes(url);
    },
    async createWebhook(channelId) {
      calls.push(`createWebhook ${channelId}`);
      const url = `https://discord.com/api/webhooks/${nextId++}/token`;
      webhooks.set(channelId, [...(webhooks.get(channelId) ?? []), url]);
      return url;
    },
  };

  const categoryNamed = (name: string) => categories.find((category) => category.name === name);
  const channelNamed = (name: string) => [...channels.values()].find((channel) => channel.name === name);
  return { api, channels, webhooks, calls, categoryNamed, channelNamed };
}

function setup() {
  const db = memoryDb();
  const routes = createChannelRoutes(db, "discord");
  const guild = fakeGuild();
  const { log, lines } = recordingLog();
  const rust: TopicState = {
    id: insertTopic(db, "Rust Lang", "The Rust language."),
    label: "Rust Lang",
    description: "The Rust language.",
    active: true,
  };
  const sync = (topics: TopicState[], api = guild.api) => syncTopicChannels({ api, routes, topics, log });
  const routeOf = (topicId: number) => readRoute(routes.get(topicRoute(topicId)));
  return { db, routes, guild, rust, sync, routeOf, lines };
}

describe("syncTopicChannels", () => {
  it("creates a category, a channel and a webhook for an active topic, then remembers the route", async () => {
    const { guild, rust, sync, routeOf } = setup();

    await sync([rust]);

    const category = guild.categoryNamed(TOPIC_CATEGORY);
    assert.equal(category?.readOnly, false);
    const rustChannel = guild.channelNamed("rust-lang");
    assert.deepEqual(rustChannel, {
      id: rustChannel?.id,
      name: "rust-lang",
      topic: "The Rust language.",
      parentId: category?.id,
    });
    assert.deepEqual(routeOf(rust.id), {
      channelId: rustChannel?.id,
      webhookUrl: guild.webhooks.get(rustChannel?.id ?? "")?.[0],
    });
  });

  it("changes nothing on a second sync", async () => {
    const { guild, rust, sync } = setup();
    await sync([rust]);
    guild.calls.length = 0;

    await sync([rust]);

    assert.deepEqual(guild.calls, []);
  });

  it("truncates a long description once instead of updating it on every sync", async () => {
    const { guild, rust, sync } = setup();
    const verbose = { ...rust, description: "x".repeat(2000) };
    await sync([verbose]);
    guild.calls.length = 0;

    await sync([verbose]);

    assert.equal(guild.channelNamed("rust-lang")?.topic?.length, 1024);
    assert.deepEqual(guild.calls, []);
  });

  it("follows the new description of a topic", async () => {
    const { guild, rust, sync } = setup();
    await sync([rust]);

    await sync([{ ...rust, description: "Rust, updated." }]);

    assert.equal(guild.channelNamed("rust-lang")?.topic, "Rust, updated.");
  });

  it("archives the channel of a disabled topic in a read-only category, then restores it", async () => {
    const { guild, rust, sync, routeOf } = setup();
    await sync([rust]);
    const channelId = routeOf(rust.id)?.channelId ?? "";

    await sync([{ ...rust, active: false }]);
    const archive = guild.categoryNamed(ARCHIVE_CATEGORY);
    assert.equal(archive?.readOnly, true);
    assert.equal(guild.channels.get(channelId)?.parentId, archive?.id);

    await sync([rust]);
    assert.equal(guild.channels.get(channelId)?.parentId, guild.categoryNamed(TOPIC_CATEGORY)?.id);
    assert.equal(guild.channels.size, 1, "the archived channel is reused");
  });

  it("recreates a channel or a webhook deleted by hand", async () => {
    const { guild, rust, sync, routeOf } = setup();
    await sync([rust]);
    const firstRoute = routeOf(rust.id);

    guild.webhooks.clear();
    await sync([rust]);
    const withNewWebhook = routeOf(rust.id);
    assert.equal(withNewWebhook?.channelId, firstRoute?.channelId);
    assert.notEqual(withNewWebhook?.webhookUrl, firstRoute?.webhookUrl);

    guild.channels.clear();
    await sync([rust]);
    assert.notEqual(routeOf(rust.id)?.channelId, firstRoute?.channelId);
    assert.equal(guild.channels.size, 1);
  });

  it("forgets the route of a disabled topic whose channel no longer exists", async () => {
    const { routes, guild, rust, sync } = setup();
    await sync([rust]);
    guild.channels.clear();

    await sync([{ ...rust, active: false }]);

    assert.equal(routes.get(topicRoute(rust.id)), undefined);
    assert.equal(guild.categoryNamed(ARCHIVE_CATEGORY), undefined, "no archive category for nothing");
  });

  it("does nothing for a disabled topic that never had a channel", async () => {
    const { guild, rust, sync } = setup();
    await sync([{ ...rust, active: false }]);

    assert.deepEqual(guild.calls, []);
  });

  it("logs a failing topic and keeps syncing the others", async () => {
    const { db, routes, guild, rust, sync, routeOf, lines } = setup();
    const linux: TopicState = { id: insertTopic(db, "Linux"), label: "Linux", description: "Kernel.", active: true };
    const api: DiscordGuildApi = {
      ...guild.api,
      async createTextChannel(options) {
        if (options.name === "rust-lang") throw new Error("Missing Permissions");
        return guild.api.createTextChannel(options);
      },
    };

    await sync([rust, linux], api);

    assert.ok(
      lines.some((line) => line.includes('Channel of topic "Rust Lang" could not be synced: Missing Permissions')),
    );
    assert.equal(routes.get(topicRoute(rust.id)), undefined);
    assert.ok(routeOf(linux.id));
  });
});

describe("channel helpers", () => {
  it("derives a Discord channel name from a topic label", () => {
    assert.equal(channelNameOf("Machine Learning & AI"), "machine-learning-ai");
    assert.equal(channelNameOf("  Sécurité "), "sécurité");
    assert.equal(channelNameOf("日本語 ニュース"), "日本語-ニュース");
    assert.equal(channelNameOf("!!!"), "topic");
  });

  it("reads only well-formed routes", () => {
    assert.deepEqual(readRoute('{"channelId":"1","webhookUrl":"https://x"}'), {
      channelId: "1",
      webhookUrl: "https://x",
    });
    assert.equal(readRoute('{"channelId":1}'), undefined);
    assert.equal(readRoute("not json"), undefined);
    assert.equal(readRoute(undefined), undefined);
  });

  it("extracts the id and token of a webhook url", () => {
    assert.deepEqual(parseWebhookUrl("https://discord.com/api/webhooks/123/abc-DEF_4?wait=true"), {
      id: "123",
      token: "abc-DEF_4",
    });
    assert.throws(() => parseWebhookUrl("https://example.test/hook"), /not a Discord webhook URL/);
  });
});

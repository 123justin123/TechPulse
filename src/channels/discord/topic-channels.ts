import {
  ChannelType,
  type Client,
  DiscordAPIError,
  type Guild,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type TextChannel,
} from "discord.js";
import { errorMessage, type Logger } from "../../lib/logger.js";
import type { TopicState } from "../channel.js";
import type { TopicRoutes } from "../routes.js";

export const TOPIC_CATEGORY = "TechPulse";
export const ARCHIVE_CATEGORY = "TechPulse archive";

const MAX_CHANNEL_NAME_LENGTH = 100;
const MAX_CHANNEL_TOPIC_LENGTH = 1024;
const WEBHOOK_NAME = "TechPulse";

export interface WebhookRoute {
  channelId: string;
  webhookUrl: string;
}

export interface GuildTextChannel {
  id: string;
  parentId: string | null;
  topic: string | null;
}

export interface DiscordGuildApi {
  findCategory(name: string): Promise<string | undefined>;
  createCategory(name: string, options: { readOnly: boolean }): Promise<string>;
  fetchTextChannel(id: string): Promise<GuildTextChannel | undefined>;
  createTextChannel(options: { name: string; topic: string; parentId: string }): Promise<GuildTextChannel>;
  setChannelTopic(id: string, topic: string): Promise<void>;
  moveChannel(id: string, parentId: string): Promise<void>;
  hasWebhook(channelId: string, webhookUrl: string): Promise<boolean>;
  createWebhook(channelId: string): Promise<string>;
}

export function readRoute(target: string | undefined): WebhookRoute | undefined {
  if (!target) return undefined;
  try {
    const { channelId, webhookUrl } = JSON.parse(target) as Partial<WebhookRoute>;
    return typeof channelId === "string" && typeof webhookUrl === "string" ? { channelId, webhookUrl } : undefined;
  } catch {
    return undefined;
  }
}

export function channelNameOf(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME_LENGTH);
  return name || "topic";
}

function channelTopicOf(topic: TopicState): string {
  return topic.description.slice(0, MAX_CHANNEL_TOPIC_LENGTH);
}

export async function syncTopicChannels({
  api,
  routes,
  topics,
  log,
}: {
  api: DiscordGuildApi;
  routes: TopicRoutes;
  topics: readonly TopicState[];
  log: Logger;
}): Promise<void> {
  const categoryIds = new Map<string, Promise<string>>();
  const categoryId = (name: string, readOnly: boolean): Promise<string> => {
    let id = categoryIds.get(name);
    if (!id) {
      id = api.findCategory(name).then((found) => found ?? api.createCategory(name, { readOnly }));
      categoryIds.set(name, id);
    }
    return id;
  };

  const openChannel = async (topic: TopicState): Promise<void> => {
    const route = readRoute(await routes.get(topic.id));
    const parentId = await categoryId(TOPIC_CATEGORY, false);
    const existing = route && (await api.fetchTextChannel(route.channelId));

    let channel: GuildTextChannel;
    if (existing) {
      channel = existing;
      if (channel.parentId !== parentId) {
        await api.moveChannel(channel.id, parentId);
        log.info(`Channel of topic "${topic.label}" restored from the archive.`);
      }
      if (channel.topic !== channelTopicOf(topic)) {
        await api.setChannelTopic(channel.id, channelTopicOf(topic));
      }
    } else {
      const name = channelNameOf(topic.label);
      channel = await api.createTextChannel({ name, topic: channelTopicOf(topic), parentId });
      log.info(`Channel #${name} created for topic "${topic.label}".`);
    }

    const keepsWebhook = route?.channelId === channel.id && (await api.hasWebhook(channel.id, route.webhookUrl));
    const webhookUrl = keepsWebhook ? route.webhookUrl : await api.createWebhook(channel.id);
    await routes.set(topic.id, JSON.stringify({ channelId: channel.id, webhookUrl } satisfies WebhookRoute));
  };

  const archiveChannel = async (topic: TopicState): Promise<void> => {
    const route = readRoute(await routes.get(topic.id));
    if (!route) return;
    const channel = await api.fetchTextChannel(route.channelId);
    if (!channel) {
      await routes.delete(topic.id);
      return;
    }
    const parentId = await categoryId(ARCHIVE_CATEGORY, true);
    if (channel.parentId !== parentId) {
      await api.moveChannel(channel.id, parentId);
      log.info(`Channel of topic "${topic.label}" archived.`);
    }
  };

  for (const topic of topics) {
    try {
      await (topic.active ? openChannel(topic) : archiveChannel(topic));
    } catch (error) {
      log.warn(`Channel of topic "${topic.label}" could not be synced: ${errorMessage(error)}`);
    }
  }
}

export async function createGuildApi(
  client: Client,
  guildId: string | undefined,
  log: Logger,
): Promise<DiscordGuildApi> {
  const guild = await resolveGuild(client, guildId);

  const textChannel = async (channelId: string): Promise<TextChannel> => {
    const channel = await guild.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) throw new Error(`Channel ${channelId} is not a text channel.`);
    return channel;
  };

  return {
    async findCategory(name) {
      const channels = await guild.channels.fetch();
      return channels.find((channel) => channel?.type === ChannelType.GuildCategory && channel.name === name)?.id;
    },

    async createCategory(name, { readOnly }) {
      const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: readOnly ? [readOnlyOverwrite(guild)] : [],
      });
      return category.id;
    },

    async fetchTextChannel(channelId) {
      try {
        const channel = await guild.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) return undefined;
        return { id: channel.id, parentId: channel.parentId, topic: channel.topic };
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return undefined;
        throw error;
      }
    },

    async createTextChannel({ name, topic, parentId }) {
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic,
      });
      return { id: channel.id, parentId: channel.parentId, topic: channel.topic };
    },

    async setChannelTopic(channelId, topic) {
      await (await textChannel(channelId)).setTopic(topic);
    },

    async moveChannel(channelId, parentId) {
      const channel = await textChannel(channelId);
      await channel.setParent(parentId, { lockPermissions: false });
      try {
        await channel.lockPermissions();
      } catch (error) {
        log.warn(
          `#${channel.name} moved, but its permissions could not follow its category ` +
            `(the bot needs Manage Roles): ${errorMessage(error)}`,
        );
      }
    },

    async hasWebhook(channelId, url) {
      const webhooks = await (await textChannel(channelId)).fetchWebhooks();
      return webhooks.has(parseWebhookUrl(url).id);
    },

    async createWebhook(channelId) {
      const created = await (await textChannel(channelId)).createWebhook({ name: WEBHOOK_NAME });
      return created.url;
    },
  };
}

async function resolveGuild(client: Client, guildId: string | undefined): Promise<Guild> {
  if (guildId) return client.guilds.fetch(guildId);
  const guilds = await client.guilds.fetch();
  const [onlyGuild] = guilds.values();
  if (guilds.size === 1 && onlyGuild) return onlyGuild.fetch();
  throw new Error(
    guilds.size === 0
      ? "the bot is not on any server yet: invite it first."
      : `the bot is on ${guilds.size} servers: set DISCORD_GUILD_ID to choose one.`,
  );
}

function readOnlyOverwrite(guild: Guild) {
  return { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] };
}

export function parseWebhookUrl(url: string): { id: string; token: string } {
  const match = /\/webhooks\/(\d+)\/([^/?#]+)/.exec(url);
  if (!match?.[1] || !match[2]) throw new Error("The stored webhook URL is not a Discord webhook URL.");
  return { id: match[1], token: match[2] };
}

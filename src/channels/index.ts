import type { CommandHandler } from "../commands.js";
import type { EnvReader } from "../config/env.js";
import type { Db } from "../db/schema.js";
import { errorMessage, type Logger } from "../lib/logger.js";
import type { Channel, ChannelDefinition, Digest, TopicState } from "./channel.js";
import { discordChannel } from "./discord/index.js";
import { createTopicRoutes } from "./routes.js";

const CHANNEL_DEFINITIONS = {
  discord: discordChannel,
};

type ChannelDefinitions = typeof CHANNEL_DEFINITIONS;
export type ChannelName = keyof ChannelDefinitions;
type SettingsOf<Name extends ChannelName> =
  ChannelDefinitions[Name] extends ChannelDefinition<infer Settings> ? Settings : never;

export type ChannelConfig = { [Name in ChannelName]: { name: Name; settings: SettingsOf<Name> } }[ChannelName];

export const CHANNEL_NAMES = Object.keys(CHANNEL_DEFINITIONS) as ChannelName[];

export function readChannelConfig(name: ChannelName, env: EnvReader): ChannelConfig {
  return { name, settings: CHANNEL_DEFINITIONS[name].readSettings(env) };
}

export function createChannel({ name, settings }: ChannelConfig, { db, log }: { db: Db; log: Logger }): Channel {
  const definition = CHANNEL_DEFINITIONS[name] as ChannelDefinition<unknown>;
  return definition.create(settings, { log: log.child(name), routes: createTopicRoutes(db, name) });
}

export function combineChannels(channels: readonly Channel[], log: Logger): Channel {
  return {
    name: channels.map((channel) => channel.name).join("+"),

    async send(digest: Digest) {
      const results = await Promise.allSettled(channels.map((channel) => channel.send(digest)));
      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [`${channels[index]?.name}: ${errorMessage(result.reason)}`] : [],
      );
      if (failures.length === 0) return;
      if (failures.length === channels.length) {
        throw new Error(`Digest could not be sent on any channel (${failures.join("; ")})`);
      }
      log.warn(`Digest sent, but some channels failed: ${failures.join("; ")}`);
    },

    async listen(handler: CommandHandler) {
      await Promise.all(channels.map((channel) => channel.listen?.(handler)));
    },

    async syncTopics(topics: readonly TopicState[]) {
      const results = await Promise.allSettled(channels.map((channel) => channel.syncTopics?.(topics)));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          log.warn(`Topics could not be synced on ${channels[index]?.name}: ${errorMessage(result.reason)}`);
        }
      });
    },

    async close() {
      await Promise.all(channels.map((channel) => channel.close()));
    },
  };
}

import type { EnvReader } from "../../config/env.js";
import type { ChannelDefinition } from "../channel.js";
import { DiscordChannel, type DiscordSettings } from "./discord-channel.js";

export const discordChannel: ChannelDefinition<DiscordSettings> = {
  readSettings(env: EnvReader): DiscordSettings {
    const botToken = env.required("DISCORD_BOT_TOKEN", "the bot creates the Discord channels and receives commands");
    const allowedUserIds = env.list("DISCORD_ALLOWED_USER_IDS");
    if (allowedUserIds.length === 0) {
      env.problems.push(
        "DISCORD_ALLOWED_USER_IDS is required: without it, anyone on the server could control the bot " +
          "and spend your API quota.",
      );
    }
    return { botToken, allowedUserIds, guildId: env.optional("DISCORD_GUILD_ID") };
  },

  create: (settings, { log, routes }) => new DiscordChannel(settings, log, routes),
};

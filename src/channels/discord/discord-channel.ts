import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  MessageFlags,
} from "discord.js";
import type { CommandHandler } from "../../commands.js";
import { errorMessage, type Logger } from "../../lib/logger.js";
import type { Channel, Digest, TopicState } from "../channel.js";
import type { TopicRoutes } from "../routes.js";
import { packBlocks, renderDigest, renderReply } from "./render.js";
import { SLASH_COMMANDS, toCommand } from "./slash-commands.js";
import { createGuildApi, type DiscordGuildApi, readRoute, syncTopicChannels } from "./topic-channels.js";
import { postWebhook } from "./webhook.js";

export interface DiscordSettings {
  botToken: string;
  allowedUserIds: readonly string[];
  guildId: string | undefined;
}

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;
  private guildApi: Promise<DiscordGuildApi> | undefined;
  private pendingSync: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: DiscordSettings,
    private readonly log: Logger,
    private readonly routes: TopicRoutes,
  ) {}

  async send(digest: Digest): Promise<void> {
    const failures: string[] = [];
    for (const group of digest.groups) {
      try {
        const route = readRoute(await this.routes.get(group.topicId));
        if (!route) throw new Error("its channel does not exist yet");
        for (const payload of renderDigest(digest, group)) {
          await postWebhook(route.webhookUrl, payload, this.log);
        }
      } catch (error) {
        failures.push(`${group.topic}: ${errorMessage(error)}`);
      }
    }

    if (failures.length === 0) return;
    if (failures.length === digest.groups.length) {
      throw new Error(`Digest could not be posted to any topic channel (${failures.join("; ")})`);
    }
    this.log.warn(`Digest posted, but some topic channels failed: ${failures.join("; ")}`);
  }

  syncTopics(topics: readonly TopicState[]): Promise<void> {
    this.pendingSync = this.pendingSync.then(() => this.syncTopicsNow(topics));
    return this.pendingSync;
  }

  private async syncTopicsNow(topics: readonly TopicState[]): Promise<void> {
    const { client, log } = this;
    if (!client) return;
    try {
      this.guildApi ??= createGuildApi(client, this.settings.guildId, log);
      await syncTopicChannels({ api: await this.guildApi, routes: this.routes, topics, log });
    } catch (error) {
      this.guildApi = undefined;
      log.error(`Discord channels could not be synced: ${errorMessage(error)}`);
    }
  }

  async listen(handler: CommandHandler): Promise<void> {
    const { botToken, allowedUserIds } = this.settings;
    const { log } = this;
    const allowedUsers = new Set(allowedUserIds);
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    const registerCommands = async (guild: Guild): Promise<void> => {
      try {
        await guild.commands.set(SLASH_COMMANDS);
        log.info(`Commands registered on server "${guild.name}".`);
      } catch (error) {
        log.error(`Could not register commands on server "${guild.name}": ${errorMessage(error)}`);
      }
    };

    client.once(Events.ClientReady, async (readyClient) => {
      log.info(`Bot logged in as ${readyClient.user.tag}.`);
      await Promise.all(readyClient.guilds.cache.map((guild) => registerCommands(guild)));
    });
    client.on(Events.GuildCreate, (guild) => void registerCommands(guild));
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) void this.handleInteraction(interaction, handler, allowedUsers);
    });
    client.on(Events.Error, (error) => log.error(`Discord client error: ${error.message}`));

    try {
      await client.login(botToken);
      this.client = client;
    } catch (error) {
      log.error(`Bot login failed, commands and channels are disabled: ${errorMessage(error)}`);
      await client.destroy();
    }
  }

  async close(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  private async handleInteraction(
    interaction: ChatInputCommandInteraction,
    handler: CommandHandler,
    allowedUsers: ReadonlySet<string>,
  ): Promise<void> {
    const { log } = this;
    try {
      if (!allowedUsers.has(interaction.user.id)) {
        await interaction.reply({
          content: "You are not allowed to control TechPulse.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const command = toCommand({
        commandName: interaction.commandName,
        subcommand: interaction.options.getSubcommand(false),
        option: (name) => interaction.options.getString(name),
      });
      if (!command) {
        await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
        return;
      }

      log.info(`Command ${command.name} received from ${interaction.user.tag}.`);
      await interaction.deferReply();
      const [firstChunk = "Done.", ...otherChunks] = packBlocks(renderReply(await handler(command)));
      await interaction.editReply(firstChunk);
      for (const chunk of otherChunks) {
        await interaction.followUp(chunk);
      }
    } catch (error) {
      log.error(`Command handling failed: ${errorMessage(error)}`);
      const content = `Failed: ${errorMessage(error)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content).catch(() => undefined);
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  }
}

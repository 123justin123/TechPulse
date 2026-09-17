import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  type Command,
  type CommandHandler,
  type CommandReply,
  isJobName,
  JOB_NAMES,
  type JobName,
} from "../commands.js";
import type { EnvReader } from "../env.js";
import { sleep } from "../http.js";
import { errorMessage, type Logger } from "../logger.js";
import type { Channel, ChannelDefinition, Digest } from "./channel.js";

const MAX_MESSAGE_LENGTH = 1900;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
const MAX_EMBED_TITLE_LENGTH = 256;
const MAX_TOTAL_EMBED_LENGTH = 6000;

const WEBHOOK_TIMEOUT_MS = 15_000;
const WEBHOOK_MAX_ATTEMPTS = 3;

const COLOR_MUST_READ = 0x2ecc71;
const COLOR_NOTABLE = 0x3498db;
const COLOR_ORDINARY = 0x95a5a6;

const JOB_LABELS: Record<JobName, string> = {
  collect: "Collect sources",
  score: "Score articles",
  digest: "Send digest",
};

export const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("topic")
    .setDescription("Manage the topics followed by TechPulse")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Follow one or several new topics")
        .addStringOption((option) =>
          option.setName("phrase").setDescription("Describe in one sentence what you want to follow").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Stop following a topic")
        .addStringOption((option) =>
          option.setName("label").setDescription("Topic name, as shown by /topic list").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List topics")),
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("Run a job now instead of waiting for its schedule")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("job")
        .setDescription("Job to run")
        .setRequired(true)
        .addChoices(...JOB_NAMES.map((job) => ({ name: JOB_LABELS[job], value: job }))),
    ),
].map((command) => command.toJSON());

export interface SlashInvocation {
  commandName: string;
  subcommand: string | null;
  option(name: string): string | null;
}

export function toCommand({ commandName, subcommand, option }: SlashInvocation): Command | null {
  if (commandName === "topic") {
    switch (subcommand) {
      case "add":
        return { name: "topic-add", phrase: option("phrase") ?? "" };
      case "remove":
        return { name: "topic-remove", label: option("label") ?? "" };
      case "list":
        return { name: "topic-list" };
      default:
        return null;
    }
  }
  if (commandName === "run") {
    const job = option("job");
    return isJobName(job) ? { name: "run", job } : null;
  }
  return null;
}

export interface DiscordEmbed {
  title?: string | undefined;
  description: string;
  color: number;
}

export interface WebhookPayload {
  content?: string | undefined;
  embeds?: DiscordEmbed[];
}

export interface DiscordSettings {
  webhookUrl: string;
  botToken: string | undefined;
  allowedUserIds: readonly string[];
}

export const discordChannel: ChannelDefinition<DiscordSettings> = {
  readSettings(env: EnvReader): DiscordSettings {
    const webhookUrl = env.url("DISCORD_WEBHOOK_URL", "the Discord channel posts the digest there");
    const botToken = env.optional("DISCORD_BOT_TOKEN");
    const allowedUserIds = env.list("DISCORD_ALLOWED_USER_IDS");
    if (botToken && allowedUserIds.length === 0) {
      env.problems.push(
        "DISCORD_ALLOWED_USER_IDS is required when DISCORD_BOT_TOKEN is set: without it, " +
          "anyone on the server could control the bot and spend your API quota.",
      );
    }
    return { webhookUrl, botToken, allowedUserIds };
  },

  create: (settings, log) => new DiscordChannel(settings, log),
};

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;

  constructor(
    private readonly settings: DiscordSettings,
    private readonly log: Logger,
  ) {}

  async send(digest: Digest): Promise<void> {
    for (const payload of renderDigest(digest)) {
      await postWebhook(this.settings.webhookUrl, payload, this.log);
    }
  }

  async listen(handler: CommandHandler): Promise<void> {
    const { botToken, allowedUserIds } = this.settings;
    const { log } = this;
    if (!botToken) {
      log.warn("DISCORD_BOT_TOKEN is not set: /topic and /run are disabled, the digest is still sent.");
      return;
    }

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
      log.error(`Bot login failed, commands disabled: ${errorMessage(error)}`);
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

export function renderReply(reply: CommandReply): string[] {
  return reply.map(({ title, body }) => (title ? `**${escapeMarkdown(title)}**\n${body}` : body));
}

export function renderDigest(digest: Digest): WebhookPayload[] {
  const formattedDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(
    new Date(`${digest.date}T12:00:00`),
  );
  const retainedCount = digest.groups.reduce((total, group) => total + group.items.length, 0);

  if (retainedCount === 0) {
    return [
      {
        content:
          `**TechPulse — ${formattedDate}**\n` +
          `No article above the threshold (${digest.threshold}/10) out of ${digest.totalConsidered} analyzed.`,
      },
    ];
  }

  const header =
    `**TechPulse — ${formattedDate}**\n` +
    `${retainedCount} articles retained out of ${digest.totalConsidered} analyzed · threshold ${digest.threshold}/10`;

  const embeds = digest.groups.flatMap((group): DiscordEmbed[] => {
    const itemBlocks = group.items.map(
      (item) =>
        `**[${item.score}/10 — ${escapeMarkdown(item.title)}](${escapeUrl(item.url)})**\n` +
        `${item.summary}\n*${[item.source, ...alsoIn(item.otherTopics)].join(" · ")}*`,
    );
    const color = colorForScore(group.items[0]?.score ?? 0);
    return packBlocks(itemBlocks, MAX_EMBED_DESCRIPTION_LENGTH).map((description, index) => ({
      title: index === 0 ? group.topic.slice(0, MAX_EMBED_TITLE_LENGTH) : undefined,
      description,
      color,
    }));
  });

  return packEmbeds(embeds, header);
}

function alsoIn(topics: readonly string[]): string[] {
  return topics.length > 0 ? [`also in ${topics.map(escapeMarkdown).join(", ")}`] : [];
}

function colorForScore(score: number): number {
  if (score >= 9) return COLOR_MUST_READ;
  if (score >= 7) return COLOR_NOTABLE;
  return COLOR_ORDINARY;
}

function packBlocks(blocks: readonly string[], maxLength = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const block of blocks) {
    const extendedChunk = currentChunk ? `${currentChunk}\n\n${block}` : block;
    if (extendedChunk.length <= maxLength) {
      currentChunk = extendedChunk;
      continue;
    }
    if (currentChunk) chunks.push(currentChunk);
    currentChunk = block.slice(0, maxLength);
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

function packEmbeds(embeds: readonly DiscordEmbed[], header: string): WebhookPayload[] {
  const messages: WebhookPayload[] = [];
  let currentEmbeds: DiscordEmbed[] = [];
  let currentLength = 0;

  const flush = (): void => {
    if (currentEmbeds.length === 0) return;
    messages.push({ content: messages.length === 0 ? header : undefined, embeds: currentEmbeds });
    currentEmbeds = [];
    currentLength = 0;
  };

  for (const embed of embeds) {
    const embedLength = (embed.title?.length ?? 0) + embed.description.length;
    if (currentEmbeds.length >= MAX_EMBEDS_PER_MESSAGE || currentLength + embedLength > MAX_TOTAL_EMBED_LENGTH) {
      flush();
    }
    currentEmbeds.push(embed);
    currentLength += embedLength;
  }
  flush();

  return messages;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\[\]])/g, "\\$1");
}

function escapeUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

async function postWebhook(url: string, payload: WebhookPayload, log: Logger, attempt = 1): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  if (response.status === 429 && attempt < WEBHOOK_MAX_ATTEMPTS) {
    const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
    const retryAfterSeconds = body.retry_after ?? 1;
    log.warn(`Discord rate limit, retrying in ${retryAfterSeconds} s.`);
    await sleep(retryAfterSeconds * 1000);
    return postWebhook(url, payload, log, attempt + 1);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed (${response.status}): ${detail}`);
  }
}

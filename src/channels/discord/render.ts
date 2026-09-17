import type { CommandReply } from "../../commands.js";
import type { Digest, DigestGroup } from "../channel.js";

const MAX_MESSAGE_LENGTH = 1900;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
const MAX_TOTAL_EMBED_LENGTH = 6000;

const COLOR_MUST_READ = 0x2ecc71;
const COLOR_NOTABLE = 0x3498db;
const COLOR_ORDINARY = 0x95a5a6;

export interface DiscordEmbed {
  description: string;
  color: number;
}

export interface WebhookPayload {
  content?: string | undefined;
  embeds?: DiscordEmbed[];
}

export function renderDigest(digest: Digest, group: DigestGroup): WebhookPayload[] {
  const count = group.items.length;
  const header =
    `**${escapeMarkdown(group.topic)} — ${formatDate(digest.date)}**\n` +
    `${count} ${count === 1 ? "article" : "articles"} · threshold ${digest.threshold}/10`;
  return packEmbeds(groupEmbeds(group), header);
}

export function renderReply(reply: CommandReply): string[] {
  return reply.map(({ title, body }) => (title ? `**${escapeMarkdown(title)}**\n${body}` : body));
}

function groupEmbeds(group: DigestGroup): DiscordEmbed[] {
  const itemBlocks = group.items.map((item) => {
    const otherTopics = item.topics.filter((topic) => topic !== group.topic);
    const alsoIn = otherTopics.length > 0 ? [`also in ${otherTopics.map(escapeMarkdown).join(", ")}`] : [];
    return (
      `**[${item.score}/10 — ${escapeMarkdown(item.title)}](${escapeUrl(item.url)})**\n` +
      `${item.summary}\n*${[item.source, ...alsoIn].join(" · ")}*`
    );
  });
  const color = colorForScore(group.items[0]?.score ?? 0);
  return packBlocks(itemBlocks, MAX_EMBED_DESCRIPTION_LENGTH).map((description) => ({
    description,
    color,
  }));
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(new Date(`${date}T12:00:00`));
}

function colorForScore(score: number): number {
  if (score >= 9) return COLOR_MUST_READ;
  if (score >= 7) return COLOR_NOTABLE;
  return COLOR_ORDINARY;
}

export function packBlocks(blocks: readonly string[], maxLength = MAX_MESSAGE_LENGTH): string[] {
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
    const embedLength = embed.description.length;
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

import type { CommandHandler } from "../commands.js";
import type { EnvReader } from "../config/env.js";
import type { Logger } from "../lib/logger.js";
import type { Topic } from "../topics.js";
import type { ChannelRoutes } from "./routes.js";

export interface DigestItem {
  title: string;
  url: string;
  score: number;
  summary: string;
  source: string;
  topics: string[];
}

export interface DigestGroup {
  topicId: number;
  topic: string;
  items: DigestItem[];
}

export interface Digest {
  date: string;
  threshold: number;
  groups: DigestGroup[];
}

export type TopicState = Pick<Topic, "id" | "label" | "description" | "active">;

export interface Channel {
  readonly name: string;
  send(digest: Digest): Promise<void>;
  listen?(handler: CommandHandler): Promise<void>;
  syncTopics?(topics: readonly TopicState[]): Promise<void>;
  close(): Promise<void>;
}

export interface ChannelContext {
  log: Logger;
  routes: ChannelRoutes;
}

export interface ChannelDefinition<Settings> {
  readSettings(env: EnvReader): Settings;
  create(settings: Settings, context: ChannelContext): Channel;
}

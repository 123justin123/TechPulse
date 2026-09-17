import type { CommandHandler } from "../commands.js";
import type { EnvReader } from "../env.js";
import type { Logger } from "../logger.js";
import type { Topic } from "../topics.js";
import type { TopicRoutes } from "./routes.js";

export interface DigestItem {
  title: string;
  url: string;
  score: number;
  summary: string;
  source: string;
  topics: string[];
}

export interface DigestGroup {
  topicId: number | null;
  topic: string;
  items: DigestItem[];
}

export interface Digest {
  date: string;
  threshold: number;
  totalConsidered: number;
  groups: DigestGroup[];
  topicGroups: DigestGroup[];
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
  routes: TopicRoutes;
}

export interface ChannelDefinition<Settings> {
  readSettings(env: EnvReader): Settings;
  create(settings: Settings, context: ChannelContext): Channel;
}

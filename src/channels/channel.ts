import type { CommandHandler } from "../commands.js";
import type { EnvReader } from "../env.js";
import type { Logger } from "../logger.js";

export interface DigestItem {
  title: string;
  url: string;
  score: number;
  summary: string;
  source: string;
}

export interface DigestGroup {
  topic: string;
  items: DigestItem[];
}

export interface Digest {
  date: string;
  threshold: number;
  totalConsidered: number;
  groups: DigestGroup[];
}

export interface Channel {
  readonly name: string;
  send(digest: Digest): Promise<void>;
  listen?(handler: CommandHandler): Promise<void>;
  close(): Promise<void>;
}

export interface ChannelDefinition<Settings> {
  readSettings(env: EnvReader): Settings;
  create(settings: Settings, log: Logger): Channel;
}

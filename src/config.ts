import { CHANNEL_NAMES, type ChannelConfig, type ChannelName, readChannelConfig } from "./channels/index.js";
import { createEnvReader, type Environment, type EnvReader } from "./env.js";
import { PROVIDER_NAMES, type ProviderName } from "./llm/provider.js";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

export interface Config {
  logLevel: LogLevel;
  timezone: string | undefined;
  language: string;
  files: { database: string; feeds: string };
  llm: { provider: ProviderName; apiKey: string; models: { topic?: string; scoring?: string } };
  channels: ChannelConfig[];
  collect: { maxItemAgeDays: number };
  scoring: { batchSize: number; maxAttempts: number; maxItemsPerRun: number };
  digest: { threshold: number; maxItems: number };
  cron: { collect: string; score: string; digest: string };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

export function loadConfig(environment: Environment = process.env): Config {
  const env = createEnvReader(environment);

  const provider = env.oneOf("LLM_PROVIDER", PROVIDER_NAMES, "anthropic");
  const apiKey = env.required("LLM_API_KEY", "it is the API key of the selected provider");

  const channels = readChannels(env);
  const logLevel = env.oneOf("LOG_LEVEL", LOG_LEVELS, "info");

  const settings = {
    timezone: env.optional("TZ"),
    language: env.optional("DIGEST_LANGUAGE") ?? "English",
    files: {
      database: env.optional("DB_PATH") ?? "./data/techpulse.db",
      feeds: env.optional("FEEDS_FILE") ?? "./config/feeds.json",
    },
    collect: { maxItemAgeDays: env.integer("MAX_ITEM_AGE_DAYS", 7, 1) },
    scoring: {
      batchSize: env.integer("AI_BATCH_SIZE", 8, 1),
      maxAttempts: env.integer("AI_MAX_ATTEMPTS", 3, 1),
      maxItemsPerRun: env.integer("AI_MAX_ITEMS_PER_RUN", 60, 1),
    },
    digest: {
      threshold: env.integer("DIGEST_SCORE_THRESHOLD", 6, 0, 10),
      maxItems: env.integer("DIGEST_MAX_ITEMS", 25, 1),
    },
    cron: {
      collect: env.cron("CRON_COLLECT", "0 */2 * * *"),
      score: env.cron("CRON_SCORE", "20 */2 * * *"),
      digest: env.cron("CRON_DIGEST", "0 8 * * *"),
    },
  };

  if (env.problems.length > 0 || !provider || !logLevel) {
    throw new ConfigError(env.problems);
  }

  return {
    ...settings,
    logLevel,
    llm: {
      provider,
      apiKey,
      models: {
        topic: env.optional("LLM_TOPIC_MODEL"),
        scoring: env.optional("LLM_SCORING_MODEL"),
      },
    },
    channels,
  };
}

function readChannels(env: EnvReader): ChannelConfig[] {
  const allowedNames = CHANNEL_NAMES.join(", ");
  const names = [...new Set(env.list("CHANNELS"))];
  if (names.length === 0) {
    env.problems.push(`CHANNELS is required: comma-separated list of output channels among ${allowedNames}.`);
    return [];
  }

  const unknownNames = names.filter((name) => !isChannelName(name));
  if (unknownNames.length > 0) {
    env.problems.push(
      `CHANNELS contains unknown channels (${unknownNames.join(", ")}); allowed values: ${allowedNames}.`,
    );
  }

  return names.filter(isChannelName).map((name) => readChannelConfig(name, env));
}

function isChannelName(name: string): name is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(name);
}

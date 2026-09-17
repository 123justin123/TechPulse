import "dotenv/config";
import { combineChannels, createChannel } from "./channels/index.js";
import { createCommandHandler } from "./commands.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { type Db, openDatabase } from "./db.js";
import { sendDigest } from "./digest.js";
import { createHttp } from "./http.js";
import { createLlmProvider } from "./llm/index.js";
import { createLogger, errorMessage, type Logger } from "./logger.js";
import { MigrationError } from "./migrations/index.js";
import { createScheduler } from "./scheduler.js";
import { scorePending } from "./scoring.js";
import { createPageDescriber } from "./sources/enrich.js";
import { collectAll, loadSources } from "./sources/index.js";
import { listTopics } from "./topics.js";

function readConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function openDatabaseOrExit(log: Logger): Promise<Db> {
  try {
    return await openDatabase(config.files.database, log);
  } catch (error) {
    if (error instanceof MigrationError) {
      log.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfigOrExit();
const log = createLogger("techpulse", config.logLevel);
const db = await openDatabaseOrExit(log.child("db"));
const http = createHttp();
const llm = createLlmProvider(config.llm);
const channel = combineChannels(
  config.channels.map((channelConfig) => createChannel(channelConfig, { db, log })),
  log.child("channels"),
);
const syncTopics = async (): Promise<void> => {
  await channel.syncTopics?.(listTopics(db));
};

const scheduler = createScheduler({
  log: log.child("scheduler"),
  timezone: config.timezone,
  jobs: [
    {
      name: "collect",
      cron: config.cron.collect,
      runOnStart: true,
      run: async () =>
        collectAll(db, await loadSources(config.files.feeds, http), {
          log: log.child("collect"),
          maxItemAgeDays: config.collect.maxItemAgeDays,
          describePage: createPageDescriber(http),
        }),
    },
    {
      name: "score",
      cron: config.cron.score,
      runOnStart: true,
      run: () =>
        scorePending({
          db,
          llm,
          language: config.language,
          settings: config.scoring,
          log: log.child("score"),
        }),
    },
    {
      name: "digest",
      cron: config.cron.digest,
      runOnStart: false,
      run: async () => {
        await syncTopics();
        return sendDigest({ db, channel, settings: config.digest });
      },
    },
  ],
});

log.info(
  `Database ready. LLM: ${config.llm.provider}, ` +
    `topics with ${llm.models.topic}, scoring with ${llm.models.scoring}. Channels: ${channel.name}.`,
);

await channel.listen?.(
  createCommandHandler({
    db,
    llm,
    language: config.language,
    rescoreWindowHours: config.scoring.rescoreWindowHours,
    runJob: (job) => scheduler.runNow(job),
    syncTopics,
  }),
);
await syncTopics();
scheduler.start();

let isShuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`${signal} received, shutting down.`);
  await scheduler.stop();
  await channel.close();
  db.close();
  process.exit(0);
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
process.on("unhandledRejection", (reason) => log.error(`Unhandled promise rejection: ${errorMessage(reason)}`));

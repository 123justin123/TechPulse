import cron, { type ScheduledTask } from "node-cron";
import { errorMessage, type Logger } from "./logger.js";

export interface Job {
  name: string;
  cron: string;
  runOnStart: boolean;
  run: () => Promise<string>;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  runNow(name: string): Promise<string>;
}

export function createScheduler({
  jobs,
  log,
  timezone,
}: {
  jobs: readonly Job[];
  log: Logger;
  timezone?: string | undefined;
}): Scheduler {
  const runningJobs = new Set<string>();
  const tasks: ScheduledTask[] = [];

  async function runNow(name: string): Promise<string> {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`Unknown job: ${name}.`);

    if (runningJobs.has(name)) {
      return `Job "${name}" is already running.`;
    }

    runningJobs.add(name);
    const startedAt = Date.now();
    try {
      const summary = await job.run();
      log.info(`${name} finished in ${Math.round((Date.now() - startedAt) / 1000)} s: ${summary}`);
      return summary;
    } catch (error) {
      log.error(`${name} failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      runningJobs.delete(name);
    }
  }

  const runInBackground = (name: string): Promise<void> =>
    runNow(name).then(
      () => undefined,
      () => undefined,
    );

  return {
    runNow,

    start() {
      for (const job of jobs) {
        tasks.push(cron.schedule(job.cron, () => runInBackground(job.name), timezone ? { timezone } : {}));
        log.info(`${job.name} scheduled "${job.cron}"${timezone ? ` (${timezone})` : ""}.`);
      }

      void (async () => {
        for (const job of jobs.filter((candidate) => candidate.runOnStart)) {
          await runInBackground(job.name);
        }
      })();
    },

    async stop() {
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
}

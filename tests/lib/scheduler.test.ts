import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler, type Job } from "../../src/lib/scheduler.js";
import { recordingLog } from "../support/helpers.js";

const NEVER = "0 0 1 1 *";

function job(name: string, run: () => Promise<string>, runOnStart = false): Job {
  return { name, cron: NEVER, runOnStart, run };
}

describe("scheduler", () => {
  it("returns the job summary and logs it", async () => {
    const { log, lines } = recordingLog();
    const scheduler = createScheduler({ log, jobs: [job("collect", async () => "12 new articles.")] });

    assert.equal(await scheduler.runNow("collect"), "12 new articles.");
    assert.ok(lines.some((line) => /collect finished in \d+ s: 12 new articles\./.test(line)));
  });

  it("refuses to start a job that is already running", async () => {
    let releaseJob: () => void = () => {};
    const jobReleased = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const scheduler = createScheduler({
      log: recordingLog().log,
      jobs: [
        job("score", async () => {
          await jobReleased;
          return "done";
        }),
      ],
    });

    const firstRun = scheduler.runNow("score");
    assert.match(await scheduler.runNow("score"), /already running/);
    releaseJob();
    assert.equal(await firstRun, "done");
  });

  it("propagates a failure, logs it and allows a later run", async () => {
    const { log, lines } = recordingLog();
    let attempt = 0;
    const scheduler = createScheduler({
      log,
      jobs: [
        job("digest", async () => {
          attempt++;
          if (attempt === 1) throw new Error("Discord unreachable");
          return "Digest sent.";
        }),
      ],
    });

    await assert.rejects(scheduler.runNow("digest"), /Discord unreachable/);
    assert.ok(lines.some((line) => line.includes("digest failed: Discord unreachable")));
    assert.equal(await scheduler.runNow("digest"), "Digest sent.");
    await assert.rejects(scheduler.runNow("unknown"), /Unknown job/);
  });

  it("runs startup jobs in order, one after the other", async () => {
    const events: string[] = [];
    const step = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${name}:end`);
      return name;
    };
    const scheduler = createScheduler({
      log: recordingLog().log,
      jobs: [job("collect", step("collect"), true), job("score", step("score"), true), job("digest", step("digest"))],
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await scheduler.stop();

    assert.deepEqual(events, ["collect:start", "collect:end", "score:start", "score:end"]);
  });
});

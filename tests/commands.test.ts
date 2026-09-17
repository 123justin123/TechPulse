import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCommandHandler, type JobName } from "../src/commands.js";
import { LlmError } from "../src/llm/provider.js";
import { fakeLlm, memoryDb, TEST_LANGUAGE } from "./helpers.js";

const FINANCE = { label: "Finance", description: "Financial markets and fintech." };

function setup({
  respond = () => ({ topics: [FINANCE] }),
  runJob,
}: {
  respond?: () => unknown;
  runJob?: (job: JobName) => Promise<string>;
} = {}) {
  const { llm, calls } = fakeLlm(respond);
  const ranJobs: JobName[] = [];
  const handle = createCommandHandler({
    db: memoryDb(),
    llm,
    language: TEST_LANGUAGE,
    runJob:
      runJob ??
      (async (job) => {
        ranJobs.push(job);
        return `Summary of ${job}.`;
      }),
  });
  return { handle, calls, ranJobs };
}

describe("command handler", () => {
  it("creates a topic and shows what the LLM deduced", async () => {
    const { handle } = setup();
    const reply = await handle({ name: "topic-add", phrase: "I want to follow finance" });
    assert.deepEqual(reply, [{ title: "Topic created: Finance", body: "Financial markets and fintech." }]);
  });

  it("shows one section per topic deduced from the sentence", async () => {
    const linux = { label: "Linux", description: "The Linux kernel." };
    const { handle } = setup({ respond: () => ({ topics: [linux, FINANCE] }) });
    assert.deepEqual(await handle({ name: "topic-add", phrase: "linux and finance" }), [
      { title: "Topic created: Linux", body: "The Linux kernel." },
      { title: "Topic created: Finance", body: "Financial markets and fintech." },
    ]);
  });

  it("asks for a sentence instead of calling the LLM for nothing", async () => {
    const { handle, calls } = setup();
    const [section] = await handle({ name: "topic-add", phrase: "  " });
    assert.match(section?.body ?? "", /Describe in one sentence/);
    assert.equal(calls.length, 0);
  });

  it("disables a topic, reports an unknown one and lists each topic state", async () => {
    const { handle } = setup();
    assert.match((await handle({ name: "topic-list" }))[0]?.body ?? "", /No topic yet/);

    await handle({ name: "topic-add", phrase: "finance" });
    assert.match((await handle({ name: "topic-remove", label: "Finance" }))[0]?.body ?? "", /disabled/);
    assert.deepEqual(await handle({ name: "topic-remove", label: "Cooking" }), [
      { body: 'No active topic named "Cooking".' },
    ]);
    assert.deepEqual(await handle({ name: "topic-list" }), [
      { title: "○ Finance (inactive)", body: "Financial markets and fintech." },
    ]);
  });

  it("delegates run to the scheduler and returns its summary", async () => {
    const { handle, ranJobs } = setup();
    assert.deepEqual(await handle({ name: "run", job: "digest" }), [{ body: "Summary of digest." }]);
    assert.deepEqual(ranJobs, ["digest"]);
  });

  it("turns an error into a readable reply instead of throwing", async () => {
    const failingJob = setup({
      runJob: async () => {
        throw new Error("Scoring stopped (configuration)");
      },
    });
    assert.deepEqual(await failingJob.handle({ name: "run", job: "score" }), [
      { body: "Failed: Scoring stopped (configuration)" },
    ]);

    const failingLlm = setup({
      respond: () => {
        throw new LlmError("API key rejected.", "config");
      },
    });
    assert.deepEqual(await failingLlm.handle({ name: "topic-add", phrase: "finance" }), [
      { body: "Failed: API key rejected." },
    ]);
  });
});

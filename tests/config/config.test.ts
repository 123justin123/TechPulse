import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/config.js";
import type { Environment } from "../../src/config/env.js";

const BASE_ENV = {
  CHANNELS: "discord",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_ALLOWED_USER_IDS: "12",
  LLM_API_KEY: "sk-ant-test",
};

function problemsOf(env: Environment): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return error.problems;
  }
  assert.fail("the configuration should have been rejected");
}

describe("loadConfig", () => {
  it("applies default values", () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.llm.provider, "anthropic");
    assert.equal(config.llm.apiKey, "sk-ant-test");
    assert.deepEqual(config.llm.models, { topic: undefined, scoring: undefined });
    assert.equal(config.language, "English");
    assert.equal(config.files.database, "./data/techpulse.db");
    assert.deepEqual(config.cron, { collect: "0 */2 * * *", score: "20 */2 * * *", digest: "0 8 * * *" });
    assert.deepEqual(config.digest, { threshold: 6, maxItems: 25 });
    assert.deepEqual(config.channels, [
      {
        name: "discord",
        settings: { botToken: "bot-token", allowedUserIds: ["12"], guildId: undefined },
      },
    ]);
  });

  it("reports every problem at once", () => {
    const problems = problemsOf({});
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /CHANNELS is required/);
    assert.match(problems.join("\n"), /LLM_API_KEY is required/);
  });

  it("reads the settings of each selected channel only", () => {
    const problems = problemsOf({ LLM_API_KEY: "sk-ant-test", CHANNELS: "discord" });
    assert.deepEqual(problems, [
      "DISCORD_BOT_TOKEN is required: the bot creates the Discord channels and receives commands.",
      "DISCORD_ALLOWED_USER_IDS is required: without it, anyone on the server could control the bot and spend your API quota.",
    ]);
  });

  it("rejects unknown channels and ignores duplicates", () => {
    const problems = problemsOf({ ...BASE_ENV, CHANNELS: "discord, carrier-pigeon" });
    assert.deepEqual(problems, ["CHANNELS contains unknown channels (carrier-pigeon); allowed values: discord."]);

    const config = loadConfig({ ...BASE_ENV, CHANNELS: "discord,discord" });
    assert.equal(config.channels.length, 1);
  });

  it("lists the allowed providers", () => {
    const problems = problemsOf({ ...BASE_ENV, LLM_PROVIDER: "mistral" });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /anthropic, openai, gemini/);
  });

  it("reads the same variables whatever the provider", () => {
    const config = loadConfig({
      ...BASE_ENV,
      LLM_PROVIDER: "gemini",
      LLM_API_KEY: "g-test",
      LLM_SCORING_MODEL: "gemini-flash-latest",
    });
    assert.equal(config.llm.provider, "gemini");
    assert.equal(config.llm.apiKey, "g-test");
    assert.deepEqual(config.llm.models, { topic: undefined, scoring: "gemini-flash-latest" });
  });

  it("treats an empty variable as missing", () => {
    const config = loadConfig({
      ...BASE_ENV,
      LLM_PROVIDER: "",
      LLM_TOPIC_MODEL: "   ",
      DIGEST_SCORE_THRESHOLD: "",
      DIGEST_LANGUAGE: " ",
    });
    assert.equal(config.llm.provider, "anthropic");
    assert.equal(config.llm.models.topic, undefined);
    assert.equal(config.digest.threshold, 6);
    assert.equal(config.language, "English");
  });

  it("reads the allowed user ids and the optional server id of the bot", () => {
    const config = loadConfig({ ...BASE_ENV, DISCORD_ALLOWED_USER_IDS: " 12, 34 ,,", DISCORD_GUILD_ID: " 99 " });
    assert.deepEqual(config.channels[0]?.settings, {
      botToken: "bot-token",
      allowedUserIds: ["12", "34"],
      guildId: "99",
    });
  });

  it("rejects invalid numbers and schedules", () => {
    const problems = problemsOf({
      ...BASE_ENV,
      AI_BATCH_SIZE: "many",
      DIGEST_SCORE_THRESHOLD: "11",
      CRON_DIGEST: "every morning",
    });
    const report = problems.join("\n");
    assert.equal(problems.length, 3);
    assert.match(report, /AI_BATCH_SIZE must be an integer greater than or equal to 1/);
    assert.match(report, /DIGEST_SCORE_THRESHOLD must be an integer between 0 and 10/);
    assert.match(report, /CRON_DIGEST is not a valid cron expression/);
  });
});

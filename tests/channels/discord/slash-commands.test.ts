import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SLASH_COMMANDS, toCommand } from "../../../src/channels/discord/slash-commands.js";
import { JOB_NAMES } from "../../../src/commands.js";

const DISCORD_ADMINISTRATOR_PERMISSION = "8";

describe("slash commands", () => {
  const invocation = (commandName: string, subcommand: string | null, options: Record<string, string> = {}) => ({
    commandName,
    subcommand,
    option: (name: string) => options[name] ?? null,
  });

  it("maps each slash command to a channel-agnostic command", () => {
    assert.deepEqual(toCommand(invocation("topic", "add", { phrase: "finance" })), {
      name: "topic-add",
      phrase: "finance",
    });
    assert.deepEqual(toCommand(invocation("topic", "remove", { label: "Finance" })), {
      name: "topic-remove",
      label: "Finance",
    });
    assert.deepEqual(toCommand(invocation("topic", "list")), { name: "topic-list" });
    assert.deepEqual(toCommand(invocation("run", null, { job: "digest" })), { name: "run", job: "digest" });
    assert.equal(toCommand(invocation("run", null, { job: "break-everything" })), null);
    assert.equal(toCommand(invocation("unknown", null)), null);
  });

  it("restricts commands to administrators and offers every job", () => {
    assert.deepEqual(
      SLASH_COMMANDS.map((command) => command.name),
      ["topic", "run"],
    );
    assert.ok(
      SLASH_COMMANDS.every((command) => command.default_member_permissions === DISCORD_ADMINISTRATOR_PERMISSION),
    );
    const runCommand = SLASH_COMMANDS.find((command) => command.name === "run");
    const choices = (runCommand?.options?.[0] as { choices?: { value: string }[] } | undefined)?.choices ?? [];
    assert.deepEqual(
      choices.map((choice) => choice.value),
      [...JOB_NAMES],
    );
  });
});

import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { type Command, isJobName, JOB_NAMES, type JobName } from "../../commands.js";

const JOB_LABELS: Record<JobName, string> = {
  collect: "Collect sources",
  score: "Score articles",
  digest: "Send digest",
};

export const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("topic")
    .setDescription("Manage the topics followed by TechPulse")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Follow one or several new topics")
        .addStringOption((option) =>
          option.setName("phrase").setDescription("Describe in one sentence what you want to follow").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Stop following a topic")
        .addStringOption((option) =>
          option.setName("label").setDescription("Topic name, as shown by /topic list").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List topics")),
  new SlashCommandBuilder()
    .setName("run")
    .setDescription("Run a job now instead of waiting for its schedule")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("job")
        .setDescription("Job to run")
        .setRequired(true)
        .addChoices(...JOB_NAMES.map((job) => ({ name: JOB_LABELS[job], value: job }))),
    ),
].map((command) => command.toJSON());

export interface SlashInvocation {
  commandName: string;
  subcommand: string | null;
  option(name: string): string | null;
}

export function toCommand({ commandName, subcommand, option }: SlashInvocation): Command | null {
  if (commandName === "topic") {
    switch (subcommand) {
      case "add":
        return { name: "topic-add", phrase: option("phrase") ?? "" };
      case "remove":
        return { name: "topic-remove", label: option("label") ?? "" };
      case "list":
        return { name: "topic-list" };
      default:
        return null;
    }
  }
  if (commandName === "run") {
    const job = option("job");
    return isJobName(job) ? { name: "run", job } : null;
  }
  return null;
}

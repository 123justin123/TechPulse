import type { Db } from "./db.js";
import type { LlmProvider } from "./llm/provider.js";
import { errorMessage } from "./logger.js";
import { requeueRecentItems } from "./scoring.js";
import { addTopics, listTopics, removeTopic } from "./topics.js";

export const JOB_NAMES = ["collect", "score", "digest"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: unknown): value is JobName {
  return (JOB_NAMES as readonly unknown[]).includes(value);
}

export type Command =
  | { name: "topic-add"; phrase: string }
  | { name: "topic-remove"; label: string }
  | { name: "topic-list" }
  | { name: "run"; job: JobName };

export interface ReplySection {
  title?: string;
  body: string;
}

export type CommandReply = ReplySection[];

export type CommandHandler = (command: Command) => Promise<CommandReply>;

export interface CommandHandlerDependencies {
  db: Db;
  llm: LlmProvider;
  language: string;
  rescoreWindowHours: number;
  runJob: (job: JobName) => Promise<string>;
  syncTopics: () => Promise<void>;
}

const text = (body: string): CommandReply => [{ body }];

export function createCommandHandler({
  db,
  llm,
  language,
  rescoreWindowHours,
  runJob,
  syncTopics,
}: CommandHandlerDependencies): CommandHandler {
  return async (command) => {
    try {
      switch (command.name) {
        case "topic-add": {
          const topics = await addTopics({ db, llm, language }, command.phrase);
          await syncTopics();
          const requeuedCount = requeueRecentItems(db, rescoreWindowHours);
          const reply: CommandReply = topics.map((topic) => ({
            title: `${topicOutcome(topic)}: ${topic.label}`,
            body: topic.description,
          }));
          if (requeuedCount > 0) {
            reply.push({
              body: `${requeuedCount} articles from the last ${rescoreWindowHours} h will be rescored on the next score run.`,
            });
          }
          return reply;
        }

        case "topic-remove":
          if (!removeTopic(db, command.label)) return text(`No active topic named "${command.label}".`);
          await syncTopics();
          return text(`Topic "${command.label}" disabled. Already classified articles keep it.`);

        case "topic-list": {
          const topics = listTopics(db);
          if (topics.length === 0) return text("No topic yet. Add one to start scoring articles.");
          return topics.map((topic) => ({
            title: `${topic.active ? "●" : "○"} ${topic.label}${topic.active ? "" : " (inactive)"}`,
            body: topic.description,
          }));
        }

        case "run":
          return text(await runJob(command.job));
      }
    } catch (error) {
      return text(`Failed: ${errorMessage(error)}`);
    }
  };
}

function topicOutcome({ created, reactivated }: { created: boolean; reactivated: boolean }): string {
  if (created) return "Topic created";
  if (reactivated) return "Topic reactivated";
  return "Topic updated";
}

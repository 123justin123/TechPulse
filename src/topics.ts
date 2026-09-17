import { z } from "zod";
import type { Db } from "./db/schema.js";
import { plainText } from "./lib/text.js";
import type { LlmProvider } from "./llm/provider.js";

export interface Topic {
  id: number;
  label: string;
  description: string;
  rawInput: string;
  active: boolean;
  createdAt: string;
}

export interface RegisteredTopic {
  id: number;
  label: string;
  description: string;
  created: boolean;
  reactivated: boolean;
}

const TopicSchema = z.object({
  label: z.string().describe("Short topic name, 1 to 3 words, capitalized."),
  description: z
    .string()
    .describe(
      "Detailed definition of the topic in 2 to 4 sentences, used to classify articles: " +
        "what belongs to the topic, its typical subtopics, and what does NOT belong to it.",
    ),
});

const TopicListSchema = z.object({
  topics: z.array(TopicSchema).describe("One entry per distinct subject, in the order the user mentioned them."),
});

function buildSystemPrompt(language: string): string {
  return `You structure areas of interest for a technology news aggregator.

The user describes, in one sentence, one or several subjects they want to follow.
Produce one topic per distinct subject. Split only subjects that would be read
separately in a digest (e.g. "Rust and Kubernetes" gives two topics); keep a subject
and its own facets together (e.g. "Rust and its ecosystem" gives one topic).

For each topic, you produce:
- a short label, used as a section heading in a daily digest;
- a description, injected verbatim into the prompt of an article classifier.

The description is a working tool, not a presentation text. Write it as a definition
meant for a classifier: state the scope of the topic, name the subtopics and technologies
that typically belong to it, and explicitly delimit what does not belong to it in order
to avoid false positives.

When a subject matches one of the existing topics you are given, reuse its label exactly,
character for character, instead of inventing a new one: the label identifies the topic.

Never write in the second person and never address the user. Write plain text: no HTML
entities, no markdown.
Write the label and the description in ${language}.`;
}

function buildUserPrompt(existingTopics: readonly Topic[], rawInput: string): string {
  const existingSection =
    existingTopics.length > 0
      ? `Existing topics:\n\n${existingTopics.map((topic) => `- ${topic.label}: ${topic.description}`).join("\n")}\n\n`
      : "";
  return `${existingSection}Areas of interest expressed by the user:\n\n${rawInput}`;
}

export async function addTopics(
  { db, llm, language }: { db: Db; llm: LlmProvider; language: string },
  phrase: string,
): Promise<RegisteredTopic[]> {
  const rawInput = phrase.trim();
  if (!rawInput) throw new Error("Describe in one sentence what you want to follow.");

  const { topics } = await llm.completeJson({
    system: buildSystemPrompt(language),
    prompt: buildUserPrompt(await listTopics(db), rawInput),
    schema: TopicListSchema,
    model: llm.models.topic,
    effort: "high",
  });

  const deduced = uniqueByLabel(
    topics.map(({ label, description }) => ({ label: plainText(label), description: plainText(description) })),
  );
  if (deduced.length === 0) throw new Error("No topic could be deduced from this sentence.");

  return db.transaction().execute(async (trx) => {
    const registered: RegisteredTopic[] = [];
    for (const topic of deduced) registered.push(await saveTopic(trx, topic, rawInput));
    return registered;
  });
}

function uniqueByLabel<T extends { label: string }>(topics: T[]): T[] {
  const seen = new Set<string>();
  return topics.filter((topic) => {
    const key = topic.label.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function saveTopic(
  db: Db,
  { label, description }: Pick<Topic, "label" | "description">,
  rawInput: string,
): Promise<RegisteredTopic> {
  const existing = await db.selectFrom("topics").select(["id", "active"]).where("label", "=", label).executeTakeFirst();

  if (existing) {
    await db
      .updateTable("topics")
      .set({ description, raw_input: rawInput, active: 1 })
      .where("id", "=", existing.id)
      .execute();
    return { id: existing.id, label, description, created: false, reactivated: existing.active === 0 };
  }

  const { id } = await db
    .insertInto("topics")
    .values({ label, description, raw_input: rawInput })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id, label, description, created: true, reactivated: false };
}

export async function removeTopic(db: Db, label: string): Promise<boolean> {
  const { numUpdatedRows } = await db
    .updateTable("topics")
    .set({ active: 0 })
    .where("label", "=", label.trim())
    .where("active", "=", 1)
    .executeTakeFirst();
  return numUpdatedRows > 0n;
}

export async function listTopics(db: Db, { activeOnly = false }: { activeOnly?: boolean } = {}): Promise<Topic[]> {
  const rows = await db
    .selectFrom("topics")
    .select(["id", "label", "description", "raw_input", "active", "created_at"])
    .$if(activeOnly, (query) => query.where("active", "=", 1))
    .orderBy("active", "desc")
    .orderBy("label", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    rawInput: row.raw_input,
    active: row.active === 1,
    createdAt: row.created_at,
  }));
}

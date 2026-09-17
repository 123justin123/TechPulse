import { z } from "zod";
import type { Db } from "./db.js";
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

interface TopicRow {
  id: number;
  label: string;
  description: string;
  rawInput: string;
  active: 0 | 1;
  createdAt: string;
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

Never write in the second person and never address the user.
Write the label and the description in ${language}.`;
}

export async function addTopics(
  { db, llm, language }: { db: Db; llm: LlmProvider; language: string },
  phrase: string,
): Promise<RegisteredTopic[]> {
  const rawInput = phrase.trim();
  if (!rawInput) throw new Error("Describe in one sentence what you want to follow.");

  const { topics } = await llm.completeJson({
    system: buildSystemPrompt(language),
    prompt: `Areas of interest expressed by the user:\n\n${rawInput}`,
    schema: TopicListSchema,
    model: llm.models.topic,
    effort: "high",
  });

  const deduced = uniqueByLabel(topics);
  if (deduced.length === 0) throw new Error("No topic could be deduced from this sentence.");

  return db.transaction(() => deduced.map((topic) => saveTopic(db, topic, rawInput)))();
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

function saveTopic(db: Db, deduced: Pick<Topic, "label" | "description">, rawInput: string): RegisteredTopic {
  const existing = db.prepare("SELECT id, active FROM topics WHERE label = ?").get(deduced.label) as
    | Pick<TopicRow, "id" | "active">
    | undefined;

  if (existing) {
    db.prepare("UPDATE topics SET description = ?, raw_input = ?, active = 1 WHERE id = ?").run(
      deduced.description,
      rawInput,
      existing.id,
    );
    return { ...deduced, id: existing.id, created: false, reactivated: existing.active === 0 };
  }

  const { lastInsertRowid } = db
    .prepare("INSERT INTO topics (label, description, raw_input) VALUES (?, ?, ?)")
    .run(deduced.label, deduced.description, rawInput);
  return { ...deduced, id: Number(lastInsertRowid), created: true, reactivated: false };
}

export function removeTopic(db: Db, label: string): boolean {
  return db.prepare("UPDATE topics SET active = 0 WHERE label = ? AND active = 1").run(label.trim()).changes > 0;
}

export function listTopics(db: Db, { activeOnly = false }: { activeOnly?: boolean } = {}): Topic[] {
  const rows = db
    .prepare(
      `SELECT id, label, description, raw_input AS rawInput, active, created_at AS createdAt
       FROM topics ${activeOnly ? "WHERE active = 1" : ""}
       ORDER BY active DESC, label ASC`,
    )
    .all() as TopicRow[];
  return rows.map((row) => ({ ...row, active: row.active === 1 }));
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTopics, listTopics, removeTopic } from "../src/topics.js";
import { fakeLlm, memoryDb, TEST_LANGUAGE } from "./helpers.js";

const FINANCE = {
  label: "Finance",
  description: "Financial markets and fintech. Excludes fundraising news without a technical angle.",
};
const LINUX = { label: "Linux", description: "The Linux kernel and distributions." };

const deduced = (...topics: (typeof FINANCE)[]) => ({ topics });

describe("topics", () => {
  it("deduces the topic with the topic model and high effort, and keeps the original sentence", async () => {
    const db = memoryDb();
    const { llm, calls } = fakeLlm(() => deduced(FINANCE));

    const topics = await addTopics({ db, llm, language: "French" }, "  I want to follow finance  ");

    assert.deepEqual(topics, [{ ...FINANCE, id: 1, created: true, reactivated: false }]);
    assert.equal(calls[0]?.model, "topic-model");
    assert.equal(calls[0]?.effort, "high");
    assert.match(calls[0]?.system ?? "", /structure areas of interest/);
    assert.match(calls[0]?.system ?? "", /Write the label and the description in French\./);
    assert.match(calls[0]?.prompt ?? "", /I want to follow finance$/);
    const [saved] = listTopics(db);
    assert.equal(saved?.rawInput, "I want to follow finance");
    assert.equal(saved?.active, true);
  });

  it("updates an existing topic and reactivates it when it was disabled", async () => {
    const db = memoryDb();
    const { llm } = fakeLlm(() => deduced(FINANCE));
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopics(dependencies, "finance");

    const [updated] = await addTopics(dependencies, "finance again");
    assert.equal(updated?.created, false);
    assert.equal(updated?.reactivated, false);

    assert.equal(removeTopic(db, "finance"), true, "labels are compared case-insensitively");
    const [reactivated] = await addTopics(dependencies, "finance, the comeback");
    assert.equal(reactivated?.reactivated, true);
    assert.equal(listTopics(db).length, 1);
  });

  it("registers every distinct topic of a sentence and ignores duplicated labels", async () => {
    const db = memoryDb();
    const { llm } = fakeLlm(() => deduced(LINUX, FINANCE, { ...FINANCE, label: "finance" }));

    const topics = await addTopics({ db, llm, language: TEST_LANGUAGE }, "linux and finance");

    assert.deepEqual(
      topics.map((topic) => [topic.id, topic.label, topic.created]),
      [
        [1, "Linux", true],
        [2, "Finance", true],
      ],
    );
    assert.deepEqual(
      listTopics(db).map((topic) => [topic.label, topic.rawInput]),
      [
        ["Finance", "linux and finance"],
        ["Linux", "linux and finance"],
      ],
    );
  });

  it("fails without saving anything when the LLM deduces no topic", async () => {
    const db = memoryDb();
    const { llm } = fakeLlm(() => deduced());
    await assert.rejects(addTopics({ db, llm, language: TEST_LANGUAGE }, "hello"), /No topic could be deduced/);
    assert.equal(listTopics(db).length, 0);
  });

  it("rejects an empty sentence without calling the LLM", async () => {
    const { llm, calls } = fakeLlm(() => deduced(FINANCE));
    await assert.rejects(
      addTopics({ db: memoryDb(), llm, language: TEST_LANGUAGE }, "   "),
      /Describe in one sentence/,
    );
    assert.equal(calls.length, 0);
  });

  it("disables without deleting and lists active topics first", async () => {
    const db = memoryDb();
    const { llm } = fakeLlm(() => deduced(LINUX, FINANCE));
    await addTopics({ db, llm, language: TEST_LANGUAGE }, "linux and finance");

    assert.equal(removeTopic(db, "Linux"), true);
    assert.equal(removeTopic(db, "Linux"), false, "already disabled");
    assert.deepEqual(
      listTopics(db).map((topic) => [topic.label, topic.active]),
      [
        ["Finance", true],
        ["Linux", false],
      ],
    );
    assert.deepEqual(
      listTopics(db, { activeOnly: true }).map((topic) => topic.label),
      ["Finance"],
    );
  });
});

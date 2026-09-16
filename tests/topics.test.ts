import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTopic, listTopics, removeTopic } from "../src/topics.js";
import { fakeLlm, memoryDb, TEST_LANGUAGE } from "./helpers.js";

const FINANCE = {
  label: "Finance",
  description: "Financial markets and fintech. Excludes fundraising news without a technical angle.",
};

describe("topics", () => {
  it("deduces the topic with the topic model and high effort, and keeps the original sentence", async () => {
    const db = memoryDb();
    const { llm, calls } = fakeLlm(() => FINANCE);

    const topic = await addTopic({ db, llm, language: "French" }, "  I want to follow finance  ");

    assert.deepEqual(topic, { ...FINANCE, id: 1, created: true, reactivated: false });
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
    const { llm } = fakeLlm(() => FINANCE);
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopic(dependencies, "finance");

    const updated = await addTopic(dependencies, "finance again");
    assert.equal(updated.created, false);
    assert.equal(updated.reactivated, false);

    assert.equal(removeTopic(db, "finance"), true, "labels are compared case-insensitively");
    const reactivated = await addTopic(dependencies, "finance, the comeback");
    assert.equal(reactivated.reactivated, true);
    assert.equal(listTopics(db).length, 1);
  });

  it("rejects an empty sentence without calling the LLM", async () => {
    const { llm, calls } = fakeLlm(() => FINANCE);
    await assert.rejects(addTopic({ db: memoryDb(), llm, language: TEST_LANGUAGE }, "   "), /Describe in one sentence/);
    assert.equal(calls.length, 0);
  });

  it("disables without deleting and lists active topics first", async () => {
    const db = memoryDb();
    const responses = [{ ...FINANCE, label: "Linux" }, FINANCE];
    const { llm } = fakeLlm((_params, call) => responses[call - 1]);
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopic(dependencies, "linux");
    await addTopic(dependencies, "finance");

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

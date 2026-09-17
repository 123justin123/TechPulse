import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTopics, listTopics, removeTopic } from "../src/topics.js";
import { fakeLlm, memoryDb, TEST_LANGUAGE } from "./support/helpers.js";

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
    const [saved] = await listTopics(db);
    assert.equal(saved?.rawInput, "I want to follow finance");
    assert.equal(saved?.active, true);
  });

  it("gives the LLM every existing topic, archived ones included, so it can reuse their exact label", async () => {
    const db = memoryDb();
    const { llm, calls } = fakeLlm((_params, call) => deduced(call === 1 ? LINUX : FINANCE));
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopics(dependencies, "linux");
    await removeTopic(db, "Linux");

    await addTopics(dependencies, "self-hosting");

    assert.doesNotMatch(calls[0]?.prompt ?? "", /Existing topics/);
    assert.match(
      calls[1]?.prompt ?? "",
      /^Existing topics:\n\n- Linux: The Linux kernel and distributions\.\n\nAreas of interest expressed by the user:\n\nself-hosting$/,
    );
    assert.match(calls[1]?.system ?? "", /reuse its label exactly/);
  });

  it("updates an existing topic and reactivates it when it was disabled", async () => {
    const db = memoryDb();
    const { llm } = fakeLlm(() => deduced(FINANCE));
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopics(dependencies, "finance");

    const [updated] = await addTopics(dependencies, "finance again");
    assert.equal(updated?.created, false);
    assert.equal(updated?.reactivated, false);

    assert.equal(await removeTopic(db, "finance"), true, "labels are compared case-insensitively");
    const [reactivated] = await addTopics(dependencies, "finance, the comeback");
    assert.equal(reactivated?.reactivated, true);
    assert.equal((await listTopics(db)).length, 1);
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
      (await listTopics(db)).map((topic) => [topic.label, topic.rawInput]),
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
    assert.equal((await listTopics(db)).length, 0);
  });

  it("decodes HTML entities written by the LLM, so an accented label matches its existing topic", async () => {
    const db = memoryDb();
    const responses = [
      { label: "Auto-hébergement", description: "Serveurs personnels." },
      { label: " Auto-h&eacute;bergement ", description: "Serveurs &amp; services personnels." },
    ];
    const { llm } = fakeLlm((_params, call) => deduced(responses[call - 1] ?? FINANCE));
    const dependencies = { db, llm, language: TEST_LANGUAGE };
    await addTopics(dependencies, "self-hosting");

    const [topic] = await addTopics(dependencies, "self-hosting again");

    assert.deepEqual(topic, {
      id: 1,
      label: "Auto-hébergement",
      description: "Serveurs & services personnels.",
      created: false,
      reactivated: false,
    });
    assert.equal((await listTopics(db)).length, 1);
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

    assert.equal(await removeTopic(db, "Linux"), true);
    assert.equal(await removeTopic(db, "Linux"), false, "already disabled");
    assert.deepEqual(
      (await listTopics(db)).map((topic) => [topic.label, topic.active]),
      [
        ["Finance", true],
        ["Linux", false],
      ],
    );
    assert.deepEqual(
      (await listTopics(db, { activeOnly: true })).map((topic) => topic.label),
      ["Finance"],
    );
  });
});

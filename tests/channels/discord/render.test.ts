import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DigestGroup } from "../../../src/channels/channel.js";
import { renderDigest, renderReply, type WebhookPayload } from "../../../src/channels/discord/render.js";
import { digestOf, groupOf, itemOf } from "../../support/digest.js";

const LONG_SUMMARY = "A summary sentence of realistic length. ".repeat(6);

const embedLength = (message: WebhookPayload): number =>
  (message.embeds ?? []).reduce((total, embed) => total + embed.description.length, 0);

function render(group: DigestGroup): WebhookPayload[] {
  return renderDigest(digestOf([group]), group);
}

describe("renderDigest", () => {
  it("titles the first message with the topic and the date", () => {
    const [first, ...others] = render(groupOf(1, "C_Lang", [itemOf()]));
    assert.match(
      first?.content ?? "",
      /^\*\*C\\_Lang — Saturday,? 12 September 2026\*\*\n1 article · threshold 6\/10$/,
    );
    assert.equal(others.length, 0);
    assert.equal(render(groupOf(1, "Rust", [itemOf(), itemOf()]))[0]?.content?.includes("2 articles"), true);
  });

  it("stays under every Discord limit on a crowded topic without losing any article", () => {
    const messages = render(
      groupOf(
        1,
        "Rust",
        Array.from({ length: 125 }, (_, index) =>
          itemOf({ title: `Article ${index}`, url: `https://example.test/${index}`, summary: LONG_SUMMARY }),
        ),
      ),
    );

    assert.ok(messages.length > 1);
    assert.ok(
      messages.slice(1).every((message) => message.content === undefined),
      "header is not repeated",
    );
    assert.ok(messages.every((message) => (message.embeds ?? []).length <= 10));
    assert.ok(messages.every((message) => embedLength(message) <= 6000));
    const embeds = messages.flatMap((message) => message.embeds ?? []);
    assert.ok(embeds.every((embed) => embed.description.length <= 4096));
    assert.equal(
      embeds
        .map((embed) => embed.description)
        .join("\n")
        .match(/example\.test/g)?.length,
      125,
    );
  });

  it("escapes parentheses in urls so markdown links stay intact", () => {
    const [message] = render(groupOf(1, "Wiki", [itemOf({ url: "https://wiki.test/A_(b)" })]));
    assert.match(message?.embeds?.[0]?.description ?? "", /\(https:\/\/wiki\.test\/A_%28b%29\)/);
  });

  it("mentions the other topics of an article next to its source", () => {
    const [message] = render(groupOf(2, "Linux", [itemOf({ source: "LWN", topics: ["Rust", "Linux", "C_Lang"] })]));
    assert.match(message?.embeds?.[0]?.description ?? "", /\*LWN · also in Rust, C\\_Lang\*$/);
  });
});

describe("renderReply", () => {
  it("renders titled sections in bold and escapes their markdown", () => {
    assert.deepEqual(renderReply([{ title: "Topic created: C_Lang", body: "Definition." }, { body: "Plain text." }]), [
      "**Topic created: C\\_Lang**\nDefinition.",
      "Plain text.",
    ]);
  });
});

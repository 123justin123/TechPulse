import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanExcerpt, htmlToText } from "../src/sources/excerpt.js";

describe("htmlToText", () => {
  it("keeps block boundaries, decodes entities and drops scripts", () => {
    const html = `<article><h2>Rust &amp; Go</h2><p>It&#39;s <em>fast</em>&nbsp;&gt; C.</p>
      <script>alert("<p>injected</p>")</script><p>Second<br>line</p></article>`;
    assert.equal(htmlToText(html), "Rust & Go\n\nIt's fast > C.\n\nSecond\nline");
  });

  it("reads plain text unchanged", () => {
    assert.equal(htmlToText("A plain   summary."), "A plain summary.");
  });
});

describe("cleanExcerpt", () => {
  it("drops bare URL lines and the WordPress footer, and keeps paragraphs", () => {
    const text = [
      "First paragraph   with  spaces.",
      "",
      "",
      "Second paragraph.",
      "Article URL: https://example.test/post",
      "https://example.test/other",
      "The post Something appeared first on Some Blog.",
    ].join("\n");
    assert.equal(cleanExcerpt(text), "First paragraph with spaces.\n\nSecond paragraph.");
  });

  it("keeps URLs that are part of a sentence", () => {
    assert.equal(cleanExcerpt("Read more at https://example.test today."), "Read more at https://example.test today.");
  });

  it("truncates and returns null when nothing is left", () => {
    assert.equal(cleanExcerpt("abcdef", 3), "abc");
    assert.equal(cleanExcerpt("https://example.test"), null);
    assert.equal(cleanExcerpt(null), null);
  });
});

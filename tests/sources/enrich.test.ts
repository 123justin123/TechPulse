import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichShortExcerpts, extractMetaDescription } from "../../src/sources/enrich.js";
import type { CollectedItem } from "../../src/sources/source.js";
import { recordingLog } from "../support/helpers.js";

const LONG_DESCRIPTION = "A page description long enough to be useful. ".repeat(6).trim();

const item = (url: string, content: string | null): CollectedItem => ({
  sourceRef: "ref",
  title: "Title",
  url,
  content,
});

describe("extractMetaDescription", () => {
  it("prefers og:description, whatever the attribute order or quoting", () => {
    const html = `<html><head>
      <meta name="description" content="Plain description">
      <meta content='Open Graph &amp; "quotes" > more' property="og:description" />
    </head><body></body></html>`;
    assert.equal(extractMetaDescription(html), 'Open Graph & "quotes" > more');
  });

  it("falls back to the other description tags, and ignores meta tags in the body", () => {
    assert.equal(extractMetaDescription('<meta name="twitter:description" content="Card">'), "Card");
    assert.equal(
      extractMetaDescription('<head><title>None</title></head><body><meta name="description" content="Late"></body>'),
      null,
    );
  });
});

describe("enrichShortExcerpts", () => {
  it("prepends the page description to short excerpts only", async () => {
    const describedUrls: string[] = [];
    const items = await enrichShortExcerpts(
      [item("https://a.test/short", "Points: 134"), item("https://a.test/long", "x".repeat(300))],
      async (url) => {
        describedUrls.push(url);
        return LONG_DESCRIPTION;
      },
      recordingLog().log,
    );

    assert.deepEqual(describedUrls, ["https://a.test/short"]);
    assert.equal(items[0]?.content, `${LONG_DESCRIPTION}\nPoints: 134`);
    assert.equal(items[1]?.content, "x".repeat(300));
  });

  it("keeps the excerpt when the description is missing, shorter or unreachable", async () => {
    const { log, lines } = recordingLog();
    const items = await enrichShortExcerpts(
      [
        item("https://a.test/none", "Short."),
        item("https://a.test/tiny", "Short enough."),
        item("https://a.test/down", null),
      ],
      async (url) => {
        if (url.endsWith("none")) return null;
        if (url.endsWith("tiny")) return "Tiny.";
        throw new Error("HTTP 403");
      },
      log,
    );

    assert.deepEqual(
      items.map((enriched) => enriched.content),
      ["Short.", "Short enough.", null],
    );
    assert.ok(lines.some((line) => line.includes("No page description for https://a.test/down: HTTP 403")));
  });
});

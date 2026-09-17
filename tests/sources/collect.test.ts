import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { collectAll, loadSources } from "../../src/sources/index.js";
import type { CollectedItem, Source } from "../../src/sources/source.js";
import { fakeHttp, memoryDb, NOW, recordingLog } from "../support/helpers.js";

function source(name: string, collect: () => Promise<CollectedItem[]>): Source {
  return { name, collect };
}

const noDescription = async (): Promise<string | null> => null;

const item = (url: string, overrides: Partial<CollectedItem> = {}): CollectedItem => ({
  sourceRef: "ref",
  title: `Title of ${url}`,
  url,
  ...overrides,
});

describe("collectAll", () => {
  it("saves items, deduplicates across sources and survives a failing source", async () => {
    const db = memoryDb();
    const { log, lines } = recordingLog();

    const summary = await collectAll(
      db,
      [
        source("rss", async () => [item("https://a.test/1"), item("https://a.test/2")]),
        source("blog", async () => {
          throw new Error("API unreachable");
        }),
        source("forum", async () => [item("https://a.test/2"), item("https://a.test/3")]),
      ],
      { log, maxItemAgeDays: 7, describePage: noDescription, now: NOW },
    );

    assert.equal(summary, "3 new articles (rss 2, blog failed, forum 1).");
    const rows = await db.selectFrom("raw_items").select(["url", "source"]).orderBy("url").execute();
    assert.deepEqual(rows, [
      { url: "https://a.test/1", source: "rss" },
      { url: "https://a.test/2", source: "rss" },
      { url: "https://a.test/3", source: "forum" },
    ]);
    assert.ok(lines.some((line) => line.includes("Source blog failed: API unreachable")));
  });

  it("saves a fast source without waiting for a slow one", async () => {
    const db = memoryDb();
    let releaseSlowSource: () => void = () => {};
    const slowSourceReleased = new Promise<void>((resolve) => {
      releaseSlowSource = resolve;
    });

    const collecting = collectAll(
      db,
      [
        source("forum", async () => {
          await slowSourceReleased;
          return [item("https://slow.test/1")];
        }),
        source("rss", async () => [item("https://fast.test/1")]),
      ],
      { log: recordingLog().log, maxItemAgeDays: 7, describePage: noDescription, now: NOW },
    );

    const savedUrls = () => db.selectFrom("raw_items").select("url").execute();
    for (let tick = 0; tick < 100 && (await savedUrls()).length === 0; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(await savedUrls(), [{ url: "https://fast.test/1" }]);

    releaseSlowSource();
    assert.equal(await collecting, "2 new articles (forum 1, rss 1).");
  });

  it("passes the freshness horizon to sources", async () => {
    let since: Date | undefined;
    const spy: Source = {
      name: "rss",
      collect: async (context) => {
        since = context.since;
        return [];
      },
    };
    await collectAll(memoryDb(), [spy], {
      log: recordingLog().log,
      maxItemAgeDays: 7,
      describePage: noDescription,
      now: NOW,
    });
    assert.equal(since?.toISOString(), "2026-09-05T12:00:00.000Z");
  });

  it("skips items without title or url and truncates long excerpts", async () => {
    const db = memoryDb();
    await collectAll(
      db,
      [
        source("rss", async () => [
          item("  "),
          item("https://a.test/untitled", { title: " " }),
          item("https://a.test/long", { content: "word ".repeat(1000) }),
        ]),
      ],
      { log: recordingLog().log, maxItemAgeDays: 7, describePage: noDescription, now: NOW },
    );
    const rows = await db
      .selectFrom("raw_items")
      .select(["url", (eb) => eb.fn<number>("length", ["content"]).as("size")])
      .execute();
    assert.deepEqual(rows, [{ url: "https://a.test/long", size: 1499 }]);
  });
});

describe("collectAll enrichment", () => {
  it("cleans and enriches only articles that are not in the database yet", async () => {
    const db = memoryDb();
    const describedUrls: string[] = [];
    const describePage = async (url: string) => {
      describedUrls.push(url);
      return "A description long enough to be useful. ".repeat(6).trim();
    };
    const collect = () =>
      collectAll(
        db,
        [
          source("rss", async () => [
            item("https://a.test/short", { content: "Article URL: https://a.test/short\nPoints: 134" }),
          ]),
        ],
        { log: recordingLog().log, maxItemAgeDays: 7, describePage, now: NOW },
      );

    await collect();
    await collect();

    assert.deepEqual(describedUrls, ["https://a.test/short"]);
    const { content } = await db.selectFrom("raw_items").select("content").executeTakeFirstOrThrow();
    assert.match(content ?? "", /^A description long enough to be useful\./);
    assert.match(content ?? "", /\nPoints: 134$/);
  });
});

describe("loadSources", () => {
  async function writeFeedsFile(feeds: unknown): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "techpulse-"));
    const file = path.join(directory, "feeds.json");
    await fs.writeFile(file, JSON.stringify(feeds));
    return file;
  }

  it("builds the RSS source from the feeds file", async () => {
    const file = await writeFeedsFile([{ name: "Blog", url: "https://blog.test/feed" }]);
    const sources = await loadSources(file, fakeHttp(() => "").http);
    assert.deepEqual(
      sources.map((source) => source.name),
      ["rss"],
    );
  });

  it("returns no source for an empty feeds file", async () => {
    const file = await writeFeedsFile([]);
    assert.deepEqual(await loadSources(file, fakeHttp(() => "").http), []);
  });

  it("explains what is wrong in an invalid file", async () => {
    const file = await writeFeedsFile([{ url: "not a url" }]);
    await assert.rejects(loadSources(file, fakeHttp(() => "").http), /feeds\.json is invalid/);
  });
});

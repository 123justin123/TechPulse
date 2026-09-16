import fs from "node:fs/promises";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Http } from "../http.js";
import { errorMessage, type Logger } from "../logger.js";
import { enrichShortExcerpts, type PageDescriber } from "./enrich.js";
import { cleanExcerpt } from "./excerpt.js";
import { createRssSource } from "./rss.js";
import { type CollectedItem, daysBefore, type Source } from "./source.js";

const FeedsFileSchema = z.array(z.object({ name: z.string().optional(), url: z.url() }));

export interface CollectOptions {
  log: Logger;
  maxItemAgeDays: number;
  describePage: PageDescriber;
  now?: Date;
}

export async function loadSources(feedsFile: string, http: Http): Promise<Source[]> {
  const feeds = await readJsonFile(feedsFile, FeedsFileSchema);
  return feeds.length > 0 ? [createRssSource(feeds, http)] : [];
}

export async function collectAll(
  db: Db,
  sources: readonly Source[],
  { log, maxItemAgeDays, describePage, now = new Date() }: CollectOptions,
): Promise<string> {
  const since = daysBefore(now, maxItemAgeDays);
  let insertedTotal = 0;

  const sourceReports = await Promise.all(
    sources.map(async (source) => {
      const sourceLog = log.child(source.name);
      try {
        const collectedItems = await source.collect({ log: sourceLog, now, since });
        const newItems = selectNewItems(db, collectedItems);
        const enrichedItems = await enrichShortExcerpts(newItems, describePage, sourceLog);
        const insertedCount = saveItems(db, source.name, enrichedItems);
        insertedTotal += insertedCount;
        return `${source.name} ${insertedCount}`;
      } catch (error) {
        log.warn(`Source ${source.name} failed: ${errorMessage(error)}`);
        return `${source.name} failed`;
      }
    }),
  );

  return `${insertedTotal} new articles (${sourceReports.join(", ") || "no active source"}).`;
}

async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is unreadable: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function selectNewItems(db: Db, items: readonly CollectedItem[]): CollectedItem[] {
  const isKnown = db.prepare("SELECT 1 FROM raw_items WHERE url = ?");
  const seenUrls = new Set<string>();

  return items.flatMap((item) => {
    const url = item.url.trim();
    const title = item.title.trim();
    if (!url || !title || seenUrls.has(url) || isKnown.get(url)) return [];
    seenUrls.add(url);
    return [{ ...item, url, title, content: cleanExcerpt(item.content) }];
  });
}

function saveItems(db: Db, sourceName: string, items: readonly CollectedItem[]): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO raw_items (source, source_ref, title, url, content, published_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return db.transaction(() => {
    let insertedCount = 0;
    for (const item of items) {
      insertedCount += insert.run(
        sourceName,
        item.sourceRef,
        item.title,
        item.url,
        item.content ?? null,
        item.publishedAt ?? null,
      ).changes;
    }
    return insertedCount;
  })();
}

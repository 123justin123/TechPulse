import { Parser } from "htmlparser2";
import type { Http } from "../http.js";
import { errorMessage, type Logger } from "../logger.js";
import { cleanExcerpt } from "./excerpt.js";
import { type CollectedItem, mapWithConcurrency } from "./source.js";

export type PageDescriber = (url: string) => Promise<string | null>;

const MIN_EXCERPT_LENGTH = 200;
const MAX_CONCURRENT_PAGE_REQUESTS = 8;
const PAGE_TIMEOUT_MS = 10_000;
const DESCRIPTION_KEYS = ["og:description", "description", "twitter:description"] as const;

export function extractMetaDescription(html: string): string | null {
  const descriptions = new Map<string, string>();

  const parser = new Parser({
    onopentag(name, attributes) {
      if (name !== "meta") return;
      const key = (attributes.property ?? attributes.name)?.toLowerCase();
      const content = attributes.content?.trim();
      if (key && content && !descriptions.has(key)) descriptions.set(key, content);
    },
    onclosetag(name) {
      if (name === "head") parser.pause();
    },
  });
  parser.end(html);

  return DESCRIPTION_KEYS.map((key) => descriptions.get(key)).find(Boolean) ?? null;
}

export function createPageDescriber(http: Http): PageDescriber {
  return async (url) =>
    extractMetaDescription(await http.text(url, { accept: "text/html", timeoutMs: PAGE_TIMEOUT_MS }));
}

export async function enrichShortExcerpts(
  items: readonly CollectedItem[],
  describePage: PageDescriber,
  log: Logger,
): Promise<CollectedItem[]> {
  return mapWithConcurrency(items, MAX_CONCURRENT_PAGE_REQUESTS, async (item) => {
    const excerpt = item.content ?? "";
    if (excerpt.length >= MIN_EXCERPT_LENGTH) return item;

    try {
      const description = cleanExcerpt(await describePage(item.url));
      if (!description || description.length <= excerpt.length) return item;
      return { ...item, content: cleanExcerpt(excerpt ? `${description}\n${excerpt}` : description) };
    } catch (error) {
      log.debug(`No page description for ${item.url}: ${errorMessage(error)}`);
      return item;
    }
  });
}

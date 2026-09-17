import Parser from "rss-parser";
import type { Http } from "../lib/http.js";
import { errorMessage } from "../lib/logger.js";
import { htmlToText } from "./excerpt.js";
import { type CollectedItem, isFresh, mapWithConcurrency, type Source } from "./source.js";

export interface FeedConfig {
  name?: string | undefined;
  url: string;
}

const FEED_ACCEPT_HEADER = "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8";
const MAX_CONCURRENT_FEEDS = 8;

const parser = new Parser();

type FeedEntry = Parser.Item & Record<string, unknown>;

export function createRssSource(feeds: readonly FeedConfig[], http: Http): Source {
  return {
    name: "rss",

    async collect({ log, since }) {
      const itemsPerFeed = await mapWithConcurrency(feeds, MAX_CONCURRENT_FEEDS, async (feed) => {
        try {
          const parsedFeed = await parser.parseString(await http.text(feed.url, { accept: FEED_ACCEPT_HEADER }));
          return (parsedFeed.items ?? []).flatMap((entry): CollectedItem[] => {
            const publishedAt = entry.isoDate ?? entry.pubDate ?? null;
            if (!entry.title || !entry.link || !isFresh(publishedAt, since)) return [];
            return [
              {
                sourceRef: feed.name ?? parsedFeed.title ?? feed.url,
                title: entry.title,
                url: entry.link,
                content: longestText(entry),
                publishedAt,
              },
            ];
          });
        } catch (error) {
          log.warn(`Feed skipped (${feed.name ?? feed.url}): ${errorMessage(error)}`);
          return [];
        }
      });

      return itemsPerFeed.flat();
    },
  };
}

function longestText(entry: FeedEntry): string | null {
  const texts = [entry["content:encoded"], entry.content, entry.summary]
    .filter((field): field is string => typeof field === "string")
    .map(htmlToText);
  return texts.reduce<string | null>((longest, text) => (text.length > (longest?.length ?? 0) ? text : longest), null);
}

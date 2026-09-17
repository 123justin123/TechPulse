import type { Digest, DigestGroup, DigestItem } from "../../src/channels/channel.js";

export function itemOf(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: "Article",
    url: "https://example.test/a",
    score: 9,
    summary: "Summary.",
    source: "Blog",
    topics: [],
    ...overrides,
  };
}

export function groupOf(topicId: number, topic: string, items: DigestItem[]): DigestGroup {
  return { topicId, topic, items };
}

export function digestOf(groups: DigestGroup[]): Digest {
  return { date: "2026-09-12", threshold: 6, groups };
}

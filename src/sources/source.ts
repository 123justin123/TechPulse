import type { Logger } from "../lib/logger.js";

const DAY_MS = 86_400_000;

export interface CollectedItem {
  sourceRef: string;
  title: string;
  url: string;
  content?: string | null;
  publishedAt?: string | null;
}

export interface CollectContext {
  log: Logger;
  now: Date;
  since: Date;
}

export interface Source {
  readonly name: string;
  collect(context: CollectContext): Promise<CollectedItem[]>;
}

export function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}

export function isFresh(publishedAt: string | null | undefined, since: Date): boolean {
  if (!publishedAt) return true;
  const publishedTime = Date.parse(publishedAt);
  return Number.isNaN(publishedTime) || publishedTime >= since.getTime();
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

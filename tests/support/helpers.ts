import http from "node:http";
import type { AddressInfo } from "node:net";
import SQLite from "better-sqlite3";
import type { Channel, Digest } from "../../src/channels/channel.js";
import { connect } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrations/index.js";
import type { Db, ItemStatus } from "../../src/db/schema.js";
import type { Http, RequestOptions } from "../../src/lib/http.js";
import { createLogger, type Logger } from "../../src/lib/logger.js";
import {
  type CompleteJsonParams,
  isMalformedOutput,
  LlmError,
  type LlmProvider,
  type ModelChoice,
} from "../../src/llm/provider.js";

export const NOW = new Date("2026-09-12T12:00:00Z");
export const TEST_LANGUAGE = "English";

const MIGRATED_DATABASE = await (async () => {
  const sqlite = new SQLite(":memory:");
  await migrate(connect(sqlite));
  return sqlite.serialize();
})();

export function memoryDb(): Db {
  return connect(new SQLite(MIGRATED_DATABASE));
}

export function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger("test", "debug", (_level, line) => void lines.push(line)), lines };
}

export type AnyParams = CompleteJsonParams<unknown>;

export function fakeLlm(
  respond: (params: AnyParams, call: number) => unknown,
  models: ModelChoice = { topic: "topic-model", scoring: "scoring-model" },
): { llm: LlmProvider; calls: AnyParams[] } {
  const calls: AnyParams[] = [];
  const llm: LlmProvider = {
    models,
    async completeJson<T>(params: CompleteJsonParams<T>): Promise<T> {
      const call = calls.push(params as unknown as AnyParams);
      const value = await respond(params as unknown as AnyParams, call);
      try {
        return params.schema.parse(value);
      } catch (error) {
        if (isMalformedOutput(error)) throw new LlmError("JSON does not match the schema.", "content", error);
        throw error;
      }
    },
  };
  return { llm, calls };
}

export function fakeChannel({ failWith }: { failWith?: Error } = {}): { channel: Channel; sent: Digest[] } {
  const sent: Digest[] = [];
  const channel: Channel = {
    name: "fake",
    async send(digest) {
      if (failWith) throw failWith;
      sent.push(digest);
    },
    async close() {},
  };
  return { channel, sent };
}

export function fakeHttp(respond: (url: string, options?: RequestOptions) => string | Promise<string>): {
  http: Http;
  requests: { url: string; options: RequestOptions | undefined }[];
} {
  const requests: { url: string; options: RequestOptions | undefined }[] = [];
  const http: Http = {
    async text(url, options) {
      requests.push({ url, options });
      return respond(url, options);
    },
    json: async <T>(url: string, options?: RequestOptions): Promise<T> =>
      JSON.parse(await http.text(url, options)) as T,
  };
  return { http, requests };
}

export async function insertTopic(
  db: Db,
  label: string,
  description = `Definition of topic ${label}.`,
): Promise<number> {
  const { id } = await db
    .insertInto("topics")
    .values({ label, description, raw_input: label })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

export async function insertItems(
  db: Db,
  count: number,
  { prefix = "article" }: { prefix?: string } = {},
): Promise<number[]> {
  const rows = await db
    .insertInto("raw_items")
    .values(
      Array.from({ length: count }, (_, index) => ({
        source: "rss",
        source_ref: "Test feed",
        title: `Title ${prefix} ${index}`,
        url: `https://example.test/${prefix}/${index}`,
        content: `Excerpt ${prefix} ${index}.`,
        published_at: new Date(NOW.getTime() - index * 3_600_000).toISOString(),
      })),
    )
    .returning("id")
    .execute();
  return rows.map((row) => row.id);
}

export async function statusCounts(db: Db): Promise<Partial<Record<ItemStatus, number>>> {
  const rows = await db
    .selectFrom("raw_items")
    .select(["status", (eb) => eb.fn.countAll<number>().as("count")])
    .groupBy("status")
    .execute();
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export async function totalAttempts(db: Db): Promise<number> {
  const { total } = await db
    .selectFrom("raw_items")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("attempts"), eb.lit(0)).as("total"))
    .executeTakeFirstOrThrow();
  return total;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface ServerReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startServer(handle: (request: RecordedRequest) => ServerReply): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      const request: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      };
      requests.push(request);
      const { status, body, headers } = handle(request);
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import type { Channel, Digest } from "../src/channels/channel.js";
import { type Db, IN_MEMORY_DATABASE, openDatabase } from "../src/db.js";
import type { Http, RequestOptions } from "../src/http.js";
import {
  type CompleteJsonParams,
  isMalformedOutput,
  LlmError,
  type LlmProvider,
  type ModelChoice,
} from "../src/llm/provider.js";
import { createLogger, type Logger } from "../src/logger.js";

export const NOW = new Date("2026-09-12T12:00:00Z");
export const TEST_LANGUAGE = "English";

const MIGRATED_DATABASE = await openDatabase(IN_MEMORY_DATABASE).then((db) => {
  const image = db.serialize();
  db.close();
  return image;
});

export function memoryDb(): Db {
  const db = new Database(MIGRATED_DATABASE);
  db.pragma("foreign_keys = ON");
  return db;
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

export function insertTopic(db: Db, label: string, description = `Definition of topic ${label}.`): number {
  return Number(
    db.prepare("INSERT INTO topics (label, description, raw_input) VALUES (?, ?, ?)").run(label, description, label)
      .lastInsertRowid,
  );
}

export function insertItems(db: Db, count: number, { prefix = "article" }: { prefix?: string } = {}): number[] {
  const insert = db.prepare(
    "INSERT INTO raw_items (source, source_ref, title, url, content, published_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  return Array.from({ length: count }, (_, index) =>
    Number(
      insert.run(
        "rss",
        "Test feed",
        `Title ${prefix} ${index}`,
        `https://example.test/${prefix}/${index}`,
        `Excerpt ${prefix} ${index}.`,
        new Date(NOW.getTime() - index * 3_600_000).toISOString(),
      ).lastInsertRowid,
    ),
  );
}

export function statusCounts(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS count FROM raw_items GROUP BY status").all() as {
    status: string;
    count: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export function totalAttempts(db: Db): number {
  return (db.prepare("SELECT COALESCE(SUM(attempts), 0) AS total FROM raw_items").get() as { total: number }).total;
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

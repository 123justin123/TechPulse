import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export type ItemStatus = "pending" | "processed" | "sent" | "discarded" | "failed";

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT    NOT NULL,
    raw_input   TEXT    NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE raw_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT    NOT NULL,
    source_ref   TEXT,
    title        TEXT    NOT NULL,
    url          TEXT    NOT NULL UNIQUE,
    content      TEXT,
    published_at TEXT,
    fetched_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    status       TEXT    NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    topic_id     INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    score        INTEGER,
    summary      TEXT,
    processed_at TEXT,
    sent_at      TEXT
  );

  CREATE INDEX idx_raw_items_status  ON raw_items(status);
  CREATE INDEX idx_raw_items_pending ON raw_items(status, attempts);
  CREATE INDEX idx_raw_items_digest  ON raw_items(status, score DESC);
  `,
];

export const IN_MEMORY_DATABASE = ":memory:";

export function openDatabase(file: string): Db {
  if (file !== IN_MEMORY_DATABASE) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("foreign_keys = ON");

  for (let version = schemaVersion(db); version < MIGRATIONS.length; version++) {
    const statements = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(statements);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

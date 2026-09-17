import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "./logger.js";
import { migrate } from "./migrations/index.js";

export type Db = Database.Database;

export type ItemStatus = "pending" | "processed" | "sent" | "discarded" | "failed";

export const IN_MEMORY_DATABASE = ":memory:";

export async function openDatabase(file: string, log?: Logger): Promise<Db> {
  if (file !== IN_MEMORY_DATABASE) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  for (const name of await migrate(db)) {
    log?.info(`Migration ${name} applied.`);
  }
  return db;
}

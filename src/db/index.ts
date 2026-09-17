import fs from "node:fs";
import path from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Logger } from "../lib/logger.js";
import { migrate } from "./migrations/index.js";
import type { Database, Db } from "./schema.js";

export const IN_MEMORY_DATABASE = ":memory:";

export function connect(database: SQLite.Database): Db {
  database.pragma("foreign_keys = ON");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database }) });
}

export async function openDatabase(file: string, log?: Logger): Promise<Db> {
  if (file !== IN_MEMORY_DATABASE) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = connect(new SQLite(file));
  for (const name of await migrate(db)) {
    log?.info(`Migration ${name} applied.`);
  }
  return db;
}

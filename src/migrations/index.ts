import { Kysely, SqliteDialect } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import type { Db } from "../db.js";
import { errorMessage } from "../logger.js";
import * as initial from "./0001_initial.js";

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  "0001_initial": initial,
};

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export async function migrate(
  db: Db,
  { migrations = MIGRATIONS }: { migrations?: Readonly<Record<string, Migration>> } = {},
): Promise<string[]> {
  const migrator = new Migrator({
    db: new Kysely<unknown>({ dialect: new SqliteDialect({ database: db }) }),
    provider: { getMigrations: async () => inTransactions(migrations) },
  });

  const { error, results = [] } = await migrator.migrateToLatest();
  if (error) {
    const failed = results.find((result) => result.status === "Error");
    const message = failed
      ? `Migration ${failed.migrationName} failed and was rolled back: ${errorMessage(error)}`
      : `Migrations could not run: ${errorMessage(error)}`;
    throw new MigrationError(message, { cause: error });
  }
  return results.map((result) => result.migrationName);
}

function inTransactions(migrations: Readonly<Record<string, Migration>>): Record<string, Migration> {
  return Object.fromEntries(
    Object.entries(migrations).map(([name, migration]) => [
      name,
      { up: (db) => db.transaction().execute((trx) => migration.up(trx)) } satisfies Migration,
    ]),
  );
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import SQLite from "better-sqlite3";
import { type Kysely, sql } from "kysely";
import { connect } from "../../src/db/index.js";
import { MIGRATIONS, MigrationError, migrate } from "../../src/db/migrations/index.js";
import type { Db } from "../../src/db/schema.js";

const emptyDb = (): Db => connect(new SQLite(":memory:"));

async function appliedNames(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  return rows.map((row) => row.name);
}

async function tableNames(db: Db): Promise<string[]> {
  return (await db.introspection.getTables()).map((table) => table.name);
}

const createTable = (name: string) => ({
  async up(db: Kysely<unknown>) {
    await db.schema.createTable(name).addColumn("id", "integer").execute();
  },
});

describe("migrate", () => {
  it("applies every migration once and records it", async () => {
    const db = emptyDb();

    assert.deepEqual(await migrate(db), ["0001_initial"]);
    assert.deepEqual(await migrate(db), []);

    assert.deepEqual(await appliedNames(db), Object.keys(MIGRATIONS));
    assert.deepEqual(await tableNames(db), ["item_topics", "raw_items", "topic_routes", "topics"]);
  });

  it("keeps labels case-insensitive and fills the default values of an article", async () => {
    const db = emptyDb();
    await migrate(db);
    const insertTopic = (label: string) =>
      db.insertInto("topics").values({ label, description: "d", raw_input: "r" }).execute();
    await insertTopic("Finance");

    await assert.rejects(insertTopic("FINANCE"), /UNIQUE constraint failed/);
    await db
      .insertInto("raw_items")
      .values({ source: "rss", title: "Article", url: "https://example.test/a" })
      .execute();
    const article = await db
      .selectFrom("raw_items")
      .select(["status", "attempts", "fetched_at"])
      .executeTakeFirstOrThrow();
    assert.equal(article.status, "pending");
    assert.equal(article.attempts, 0);
    assert.match(article.fetched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("deletes the topics of an article along with the article", async () => {
    const db = emptyDb();
    await migrate(db);
    await db.insertInto("topics").values({ label: "Finance", description: "d", raw_input: "r" }).execute();
    await db
      .insertInto("raw_items")
      .values({ source: "rss", title: "Article", url: "https://example.test/a" })
      .execute();
    await db.insertInto("item_topics").values({ item_id: 1, topic_id: 1, position: 0 }).execute();

    await db.deleteFrom("raw_items").execute();

    assert.deepEqual(await db.selectFrom("item_topics").selectAll().execute(), []);
  });

  it("applies only the migrations added since the last start", async () => {
    const db = emptyDb();
    await migrate(db, { migrations: { "0001_a": createTable("a") } });

    const applied = await migrate(db, { migrations: { "0001_a": createTable("a"), "0002_b": createTable("b") } });

    assert.deepEqual(applied, ["0002_b"]);
    assert.deepEqual(await tableNames(db), ["a", "b"]);
  });

  it("refuses to start when the database has a migration unknown to the code", async () => {
    const db = emptyDb();
    await migrate(db, { migrations: { "0001_a": createTable("a"), "0002_b": createTable("b") } });

    await assert.rejects(
      migrate(db, { migrations: { "0001_a": createTable("a") } }),
      (error) => error instanceof MigrationError && /0002_b/.test(error.message),
    );
  });

  it("rolls back a failing migration entirely and does not record it", async () => {
    const db = emptyDb();
    const migrations = {
      "0001_a": createTable("a"),
      "0002_b": {
        async up(kysely: Kysely<unknown>) {
          await kysely.schema.createTable("b").addColumn("id", "integer").execute();
          await sql`INSERT INTO missing_table VALUES (1)`.execute(kysely);
        },
      },
    };

    await assert.rejects(
      migrate(db, { migrations }),
      (error) =>
        error instanceof MigrationError &&
        /Migration 0002_b failed and was rolled back: no such table: missing_table/.test(error.message),
    );

    assert.deepEqual(await tableNames(db), ["a"]);
    assert.deepEqual(await appliedNames(db), ["0001_a"]);
  });
});

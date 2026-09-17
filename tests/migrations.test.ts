import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { type Kysely, sql } from "kysely";
import type { Db } from "../src/db.js";
import { MIGRATIONS, MigrationError, migrate } from "../src/migrations/index.js";

function emptyDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

const appliedNames = (db: Db) =>
  (db.prepare("SELECT name FROM kysely_migration ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const tableExists = (db: Db, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

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

    assert.deepEqual(appliedNames(db), Object.keys(MIGRATIONS));
    for (const table of ["topics", "raw_items", "item_topics", "channel_routes"]) {
      assert.ok(tableExists(db, table), `${table} exists`);
    }
  });

  it("keeps labels case-insensitive and fills the default values of an article", async () => {
    const db = emptyDb();
    await migrate(db);
    const insertTopic = db.prepare("INSERT INTO topics (label, description, raw_input) VALUES (?, 'd', 'r')");
    insertTopic.run("Finance");

    assert.throws(() => insertTopic.run("FINANCE"), /UNIQUE constraint failed/);
    db.prepare("INSERT INTO raw_items (source, title, url) VALUES ('rss', 'Article', 'https://example.test/a')").run();
    assert.deepEqual(db.prepare("SELECT status, attempts, fetched_at IS NOT NULL AS fetched FROM raw_items").get(), {
      status: "pending",
      attempts: 0,
      fetched: 1,
    });
  });

  it("deletes the topics of an article along with the article", async () => {
    const db = emptyDb();
    await migrate(db);
    db.prepare("INSERT INTO topics (label, description, raw_input) VALUES ('Finance', 'Definition.', 'finance')").run();
    db.prepare("INSERT INTO raw_items (source, title, url) VALUES ('rss', 'Article', 'https://example.test/a')").run();
    db.prepare("INSERT INTO item_topics (item_id, topic_id, position) VALUES (1, 1, 0)").run();

    db.prepare("DELETE FROM raw_items").run();

    assert.deepEqual(db.prepare("SELECT * FROM item_topics").all(), []);
  });

  it("applies only the migrations added since the last start", async () => {
    const db = emptyDb();
    await migrate(db, { migrations: { "0001_a": createTable("a") } });

    const applied = await migrate(db, { migrations: { "0001_a": createTable("a"), "0002_b": createTable("b") } });

    assert.deepEqual(applied, ["0002_b"]);
    assert.ok(tableExists(db, "b"));
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

    assert.ok(tableExists(db, "a"));
    assert.ok(!tableExists(db, "b"));
    assert.deepEqual(appliedNames(db), ["0001_a"]);
  });
});

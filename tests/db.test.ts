import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { type Db, migrate, schemaVersion } from "../src/db.js";

function databaseAtVersion(version?: number): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, version);
  db.prepare("INSERT INTO topics (label, description, raw_input) VALUES ('Finance', 'Definition.', 'finance')").run();
  return db;
}

describe("database migrations", () => {
  it("moves the single topic of each article into item_topics without losing data", () => {
    const db = databaseAtVersion(1);
    const insert = db.prepare(
      "INSERT INTO raw_items (source, title, url, status, score, topic_id) VALUES ('rss', ?, ?, 'processed', ?, ?)",
    );
    insert.run("Classified", "https://example.test/a", 8, 1);
    insert.run("Unclassified", "https://example.test/b", 2, null);

    migrate(db);

    assert.equal(schemaVersion(db), 2);
    assert.deepEqual(db.prepare("SELECT id, title, score FROM raw_items ORDER BY id").all(), [
      { id: 1, title: "Classified", score: 8 },
      { id: 2, title: "Unclassified", score: 2 },
    ]);
    assert.deepEqual(db.prepare("SELECT item_id, topic_id, position FROM item_topics").all(), [
      { item_id: 1, topic_id: 1, position: 0 },
    ]);
    const columns = (db.prepare("PRAGMA table_info(raw_items)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.ok(!columns.includes("topic_id"));
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  });

  it("deletes the topics of an article along with the article", () => {
    const db = databaseAtVersion();
    db.prepare("INSERT INTO raw_items (source, title, url) VALUES ('rss', 'Article', 'https://example.test/a')").run();
    db.prepare("INSERT INTO item_topics (item_id, topic_id, position) VALUES (1, 1, 0)").run();

    db.prepare("DELETE FROM raw_items").run();

    assert.deepEqual(db.prepare("SELECT * FROM item_topics").all(), []);
  });
});

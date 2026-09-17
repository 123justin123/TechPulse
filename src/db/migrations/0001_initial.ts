import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("topics")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("label", "text", (col) => col.notNull().unique().modifyEnd(sql`COLLATE NOCASE`))
    .addColumn("description", "text", (col) => col.notNull())
    .addColumn("raw_input", "text", (col) => col.notNull())
    .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createTable("raw_items")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("source_ref", "text")
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull().unique())
    .addColumn("content", "text")
    .addColumn("published_at", "text")
    .addColumn("fetched_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("score", "integer")
    .addColumn("summary", "text")
    .addColumn("processed_at", "text")
    .addColumn("sent_at", "text")
    .execute();

  await db.schema.createIndex("idx_raw_items_status").on("raw_items").column("status").execute();
  await db.schema.createIndex("idx_raw_items_pending").on("raw_items").columns(["status", "attempts"]).execute();
  await db.schema.createIndex("idx_raw_items_digest").on("raw_items").columns(["status", "score desc"]).execute();

  await db.schema
    .createTable("item_topics")
    .addColumn("item_id", "integer", (col) => col.notNull().references("raw_items.id").onDelete("cascade"))
    .addColumn("topic_id", "integer", (col) => col.notNull().references("topics.id").onDelete("cascade"))
    .addColumn("position", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("item_topics_pk", ["item_id", "topic_id"])
    .execute();

  await db.schema.createIndex("idx_item_topics_topic").on("item_topics").column("topic_id").execute();

  await db.schema
    .createTable("topic_routes")
    .addColumn("channel", "text", (col) => col.notNull())
    .addColumn("topic_id", "integer", (col) => col.notNull().references("topics.id").onDelete("cascade"))
    .addColumn("target", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("topic_routes_pk", ["channel", "topic_id"])
    .execute();
}

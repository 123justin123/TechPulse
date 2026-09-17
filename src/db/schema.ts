import type { Generated, Kysely } from "kysely";

export type ItemStatus = "pending" | "processed" | "sent" | "discarded" | "failed";

export interface TopicsTable {
  id: Generated<number>;
  label: string;
  description: string;
  raw_input: string;
  active: Generated<0 | 1>;
  created_at: Generated<string>;
}

export interface RawItemsTable {
  id: Generated<number>;
  source: string;
  source_ref: string | null;
  title: string;
  url: string;
  content: string | null;
  published_at: string | null;
  fetched_at: Generated<string>;
  status: Generated<ItemStatus>;
  attempts: Generated<number>;
  score: number | null;
  summary: string | null;
  processed_at: string | null;
  sent_at: string | null;
}

export interface ItemTopicsTable {
  item_id: number;
  topic_id: number;
  position: number;
}

export interface ChannelRoutesTable {
  channel: string;
  route: string;
  target: string;
}

export interface Database {
  topics: TopicsTable;
  raw_items: RawItemsTable;
  item_topics: ItemTopicsTable;
  channel_routes: ChannelRoutesTable;
}

export type Db = Kysely<Database>;

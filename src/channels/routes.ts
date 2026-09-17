import type { Db } from "../db.js";

export interface TopicRoutes {
  get(topicId: number): string | undefined;
  set(topicId: number, target: string): void;
  delete(topicId: number): void;
}

export function createTopicRoutes(db: Db, channel: string): TopicRoutes {
  const select = db.prepare("SELECT target FROM topic_routes WHERE channel = ? AND topic_id = ?");
  const upsert = db.prepare(
    `INSERT INTO topic_routes (channel, topic_id, target) VALUES (?, ?, ?)
     ON CONFLICT (channel, topic_id) DO UPDATE SET target = excluded.target`,
  );
  const remove = db.prepare("DELETE FROM topic_routes WHERE channel = ? AND topic_id = ?");

  return {
    get: (topicId) => (select.get(channel, topicId) as { target: string } | undefined)?.target,
    set: (topicId, target) => void upsert.run(channel, topicId, target),
    delete: (topicId) => void remove.run(channel, topicId),
  };
}

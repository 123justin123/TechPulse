import type { Db } from "../db/schema.js";

export interface TopicRoutes {
  get(topicId: number): Promise<string | undefined>;
  set(topicId: number, target: string): Promise<void>;
  delete(topicId: number): Promise<void>;
}

export function createTopicRoutes(db: Db, channel: string): TopicRoutes {
  return {
    async get(topicId) {
      const row = await db
        .selectFrom("topic_routes")
        .select("target")
        .where("channel", "=", channel)
        .where("topic_id", "=", topicId)
        .executeTakeFirst();
      return row?.target;
    },

    async set(topicId, target) {
      await db
        .insertInto("topic_routes")
        .values({ channel, topic_id: topicId, target })
        .onConflict((conflict) => conflict.columns(["channel", "topic_id"]).doUpdateSet({ target }))
        .execute();
    },

    async delete(topicId) {
      await db.deleteFrom("topic_routes").where("channel", "=", channel).where("topic_id", "=", topicId).execute();
    },
  };
}

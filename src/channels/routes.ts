import type { Db } from "../db.js";

export function topicRoute(topicId: number): string {
  return `topic:${topicId}`;
}

export interface ChannelRoutes {
  get(route: string): Promise<string | undefined>;
  set(route: string, target: string): Promise<void>;
  delete(route: string): Promise<void>;
}

export function createChannelRoutes(db: Db, channel: string): ChannelRoutes {
  return {
    async get(route) {
      const row = await db
        .selectFrom("channel_routes")
        .select("target")
        .where("channel", "=", channel)
        .where("route", "=", route)
        .executeTakeFirst();
      return row?.target;
    },

    async set(route, target) {
      await db
        .insertInto("channel_routes")
        .values({ channel, route, target })
        .onConflict((conflict) => conflict.columns(["channel", "route"]).doUpdateSet({ target }))
        .execute();
    },

    async delete(route) {
      await db.deleteFrom("channel_routes").where("channel", "=", channel).where("route", "=", route).execute();
    },
  };
}

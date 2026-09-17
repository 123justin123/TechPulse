import type { Db } from "../db.js";

export function topicRoute(topicId: number): string {
  return `topic:${topicId}`;
}

export interface ChannelRoutes {
  get(route: string): string | undefined;
  set(route: string, target: string): void;
  delete(route: string): void;
}

export function createChannelRoutes(db: Db, channel: string): ChannelRoutes {
  const select = db.prepare("SELECT target FROM channel_routes WHERE channel = ? AND route = ?");
  const upsert = db.prepare(
    `INSERT INTO channel_routes (channel, route, target) VALUES (?, ?, ?)
     ON CONFLICT (channel, route) DO UPDATE SET target = excluded.target`,
  );
  const remove = db.prepare("DELETE FROM channel_routes WHERE channel = ? AND route = ?");

  return {
    get: (route) => (select.get(channel, route) as { target: string } | undefined)?.target,
    set: (route, target) => void upsert.run(channel, route, target),
    delete: (route) => void remove.run(channel, route),
  };
}

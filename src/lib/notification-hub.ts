import type { Response } from "express";

type Subscriber = { userId: string; res: Response };

const subscribers = new Set<Subscriber>();

export function addNotificationSubscriber(userId: string, res: Response) {
  const sub = { userId, res };
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

/** Ask connected desks to reload. `all` reaches every open portal. */
export function pushNotifications(userIds: Set<string> | "all") {
  const chunk = `event: notification\ndata: {"refresh":true}\n\n`;
  for (const sub of subscribers) {
    if (userIds !== "all" && !userIds.has(sub.userId)) continue;
    try {
      sub.res.write(chunk);
    } catch {
      subscribers.delete(sub);
    }
  }
}

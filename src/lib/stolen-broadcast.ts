import type { Response } from "express";

type Subscriber = { userId: string; res: Response };

const subscribers = new Set<Subscriber>();

export function addStolenSubscriber(userId: string, res: Response) {
  const sub = { userId, res };
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

/** Tell connected dashboards in the recipient set to reload their alerts. */
export function pushStolen(userIds: Set<string>) {
  if (userIds.size === 0) return;
  const chunk = `event: stolen\ndata: {"refresh":true}\n\n`;
  for (const sub of subscribers) {
    if (!userIds.has(sub.userId)) continue;
    try {
      sub.res.write(chunk);
    } catch {
      subscribers.delete(sub);
    }
  }
}

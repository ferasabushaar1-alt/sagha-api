import { db } from "../db/client.js";
import { supportInquiries, type User } from "../db/schema.js";
import { notifySupportInquiry, safeNotify } from "./notifications.service.js";

export async function createSupportInquiry(user: User, message: string) {
  const text = message.trim();
  const [row] = await db
    .insert(supportInquiries)
    .values({ userId: user.id, message: text })
    .returning();
  if (!row) throw new Error("Support inquiry was not stored");
  const reference = `SG-${row.id.slice(0, 8).toUpperCase()}`;
  await safeNotify(notifySupportInquiry(user, reference, text));
  return { id: row.id, reference, createdAt: row.createdAt };
}

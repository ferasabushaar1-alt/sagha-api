import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db/client.js";
import {
  conversationReads,
  conversations,
  messages,
  orders,
  products,
  users,
  type User,
} from "../db/schema.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

export type StartConversationInput = {
  /** Required when the caller is a retailer. */
  workshopId?: string;
  /** Required when the caller is a workshop. */
  retailerId?: string;
  productId?: string;
  orderId?: string;
};

function assertChatParticipant(user: User) {
  if (user.role !== "retailer" && user.role !== "workshop" && user.role !== "admin") {
    throw forbidden("Only retailers, workshops, and admins can use chat");
  }
}

async function getConversationOrThrow(conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw notFound("Conversation not found");
  return row;
}

function assertCanAccessConversation(user: User, conv: typeof conversations.$inferSelect) {
  if (user.role === "admin") return;
  if (user.id !== conv.retailerId && user.id !== conv.workshopId) {
    throw forbidden("You are not a participant in this conversation");
  }
}

async function resolveParties(user: User, input: StartConversationInput) {
  let retailerId: string;
  let workshopId: string;

  if (user.role === "retailer") {
    if (!input.workshopId) throw badRequest("workshopId is required");
    retailerId = user.id;
    workshopId = input.workshopId;
  } else if (user.role === "workshop") {
    if (!input.retailerId) throw badRequest("retailerId is required");
    retailerId = input.retailerId;
    workshopId = user.id;
  } else if (user.role === "admin") {
    if (!input.retailerId || !input.workshopId) {
      throw badRequest("retailerId and workshopId are required for admin");
    }
    retailerId = input.retailerId;
    workshopId = input.workshopId;
  } else {
    throw forbidden("Only retailers and workshops can start conversations");
  }

  if (retailerId === workshopId) {
    throw badRequest("Retailer and workshop must be different users");
  }

  const [retailer] = await db
    .select()
    .from(users)
    .where(eq(users.id, retailerId))
    .limit(1);
  if (!retailer || retailer.role !== "retailer") {
    throw badRequest("Invalid retailer");
  }

  const [workshop] = await db
    .select()
    .from(users)
    .where(eq(users.id, workshopId))
    .limit(1);
  if (!workshop || workshop.role !== "workshop") {
    throw badRequest("Invalid workshop");
  }

  if (input.productId) {
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!product) throw badRequest("Invalid product");
    if (product.workshopId !== workshopId) {
      throw badRequest("Product does not belong to this workshop");
    }
  }

  if (input.orderId) {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    if (!order) throw badRequest("Invalid order");
    if (order.retailerId !== retailerId || order.workshopId !== workshopId) {
      throw badRequest("Order parties must match the conversation parties");
    }
  }

  return { retailerId, workshopId };
}

/** Find an existing thread with the same parties + optional product/order, or create one. */
export async function startOrGetConversation(
  user: User,
  input: StartConversationInput,
) {
  assertChatParticipant(user);
  const { retailerId, workshopId } = await resolveParties(user, input);

  const productCond = input.productId
    ? eq(conversations.productId, input.productId)
    : isNull(conversations.productId);
  const orderCond = input.orderId
    ? eq(conversations.orderId, input.orderId)
    : isNull(conversations.orderId);

  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.retailerId, retailerId),
        eq(conversations.workshopId, workshopId),
        productCond,
        orderCond,
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({
      retailerId,
      workshopId,
      productId: input.productId ?? null,
      orderId: input.orderId ?? null,
    })
    .returning();

  return created;
}

export async function listConversations(user: User) {
  assertChatParticipant(user);

  const retailer = alias(users, "retailer");
  const workshop = alias(users, "workshop");

  const conditions =
    user.role === "admin"
      ? undefined
      : user.role === "retailer"
        ? eq(conversations.retailerId, user.id)
        : eq(conversations.workshopId, user.id);

  const rows = await db
    .select({
      id: conversations.id,
      retailerId: conversations.retailerId,
      workshopId: conversations.workshopId,
      productId: conversations.productId,
      orderId: conversations.orderId,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      retailerBusinessName: retailer.businessName,
      retailerFullName: retailer.fullName,
      retailerAvatarPath: retailer.avatarPath,
      workshopBusinessName: workshop.businessName,
      workshopFullName: workshop.fullName,
      workshopAvatarPath: workshop.avatarPath,
      productName: products.name,
      productNameAr: products.nameAr,
      lastMessageText: sql<string | null>`(
        SELECT m.message_text FROM messages m
        WHERE m.conversation_id = ${conversations.id}
        ORDER BY m.created_at DESC LIMIT 1
      )`,
      lastMessageAt: sql<Date | null>`(
        SELECT m.created_at FROM messages m
        WHERE m.conversation_id = ${conversations.id}
        ORDER BY m.created_at DESC LIMIT 1
      )`,
      unread: sql<number>`CASE
        WHEN (
          SELECT m.sender_id FROM messages m
          WHERE m.conversation_id = ${conversations.id}
          ORDER BY m.created_at DESC LIMIT 1
        ) IS NULL THEN 0
        WHEN (
          SELECT m.sender_id FROM messages m
          WHERE m.conversation_id = ${conversations.id}
          ORDER BY m.created_at DESC LIMIT 1
        ) = ${user.id} THEN 0
        WHEN COALESCE((
          SELECT r.read_at FROM conversation_reads r
          WHERE r.conversation_id = ${conversations.id} AND r.user_id = ${user.id}
        ), 0) < COALESCE((
          SELECT m.created_at FROM messages m
          WHERE m.conversation_id = ${conversations.id}
          ORDER BY m.created_at DESC LIMIT 1
        ), 0) THEN 1
        ELSE 0
      END`,
    })
    .from(conversations)
    .innerJoin(retailer, eq(conversations.retailerId, retailer.id))
    .innerJoin(workshop, eq(conversations.workshopId, workshop.id))
    .leftJoin(products, eq(conversations.productId, products.id))
    .where(conditions)
    .orderBy(desc(conversations.updatedAt));

  return rows.map((row) => ({
    ...row,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lastMessageAt: row.lastMessageAt != null ? toIso(row.lastMessageAt) : null,
    unread: Number(row.unread) === 1,
  }));
}

export async function listMessages(user: User, conversationId: string) {
  assertChatParticipant(user);
  const conv = await getConversationOrThrow(conversationId);
  assertCanAccessConversation(user, conv);

  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      messageText: messages.messageText,
      createdAt: messages.createdAt,
      senderFullName: users.fullName,
      senderBusinessName: users.businessName,
      senderRole: users.role,
      senderAvatarPath: users.avatarPath,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  await markConversationRead(user, conversationId);

  return {
    conversation: conv,
    messages: rows.map((m) => ({
      ...m,
      createdAt: toIso(m.createdAt),
    })),
  };
}

export async function markConversationRead(user: User, conversationId: string) {
  assertChatParticipant(user);
  const conv = await getConversationOrThrow(conversationId);
  assertCanAccessConversation(user, conv);
  const now = new Date();
  const updated = await db
    .update(conversationReads)
    .set({ readAt: now })
    .where(
      and(
        eq(conversationReads.conversationId, conversationId),
        eq(conversationReads.userId, user.id),
      ),
    )
    .returning({ userId: conversationReads.userId });
  if (updated.length > 0) return;
  await db.insert(conversationReads).values({
    conversationId,
    userId: user.id,
    readAt: now,
  });
}

function toIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (/^\d+$/.test(value.trim()) && Number.isFinite(n)) {
      const ms = n < 1e12 ? n * 1000 : n;
      return new Date(ms).toISOString();
    }
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function sendMessage(
  user: User,
  conversationId: string,
  messageText: string,
) {
  assertChatParticipant(user);
  const text = messageText.trim();
  if (!text) throw badRequest("messageText is required");
  if (text.length > 4000) throw badRequest("Message is too long (max 4000)");

  const conv = await getConversationOrThrow(conversationId);
  assertCanAccessConversation(user, conv);

  if (user.role !== "admin") {
    if (user.id !== conv.retailerId && user.id !== conv.workshopId) {
      throw forbidden("You cannot send messages in this conversation");
    }
  } else {
    throw forbidden("Admins cannot send messages in trade conversations");
  }

  const now = new Date();
  const [msg] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: user.id,
      messageText: text,
      createdAt: now,
    })
    .returning();

  await db
    .update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, conversationId));

  await markConversationRead(user, conversationId);

  return {
    ...msg,
    createdAt: toIso(msg.createdAt ?? now),
  };
}

export async function getConversation(user: User, conversationId: string) {
  assertChatParticipant(user);
  const conv = await getConversationOrThrow(conversationId);
  assertCanAccessConversation(user, conv);
  return conv;
}

/** Deletes a conversation and its messages (cascade). Participants only. */
export async function deleteConversation(user: User, conversationId: string) {
  assertChatParticipant(user);
  const conv = await getConversationOrThrow(conversationId);
  assertCanAccessConversation(user, conv);

  if (user.role === "admin") {
    // Admins may delete any thread
  } else if (user.id !== conv.retailerId && user.id !== conv.workshopId) {
    throw forbidden("You cannot delete this conversation");
  }

  await db.delete(conversations).where(eq(conversations.id, conversationId));
  return { ok: true as const, id: conversationId };
}

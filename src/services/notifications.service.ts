import { and, desc, eq, gt, inArray, notExists, or } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  creditAccounts,
  notificationReads,
  notifications,
  users,
  type NotificationType,
  type User,
} from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { pushNotifications } from "../lib/notification-hub.js";

export type NotificationAudience = "all" | "trade" | "admin";
export type NotificationRefKind =
  | "report"
  | "user"
  | "order"
  | "scrap"
  | "account";

type NoticeInput = {
  type: NotificationType;
  title: string;
  message: string;
  titleAr?: string;
  messageAr?: string;
  referenceId?: string | null;
  referenceKind?: NotificationRefKind | null;
  audience?: NotificationAudience;
  actorId?: string | null;
};

export type NotificationView = {
  id: string;
  type: string;
  title: string;
  message: string;
  referenceId: string | null;
  referenceKind: string | null;
  isRead: boolean;
  createdAt: Date;
};

const BROADCAST = "broadcast";

export async function safeNotify(work: Promise<unknown>) {
  try {
    await work;
  } catch (err) {
    console.error("notification failed", err);
  }
}

function present(
  row: typeof notifications.$inferSelect,
  isRead: boolean,
  locale: "en" | "ar",
): NotificationView {
  const arabic = locale === "ar";
  return {
    id: row.id,
    type: row.type,
    title: arabic ? row.titleAr || row.title : row.title,
    message: arabic ? row.messageAr || row.message : row.message,
    referenceId: row.referenceId,
    referenceKind: row.referenceKind,
    isRead,
    createdAt: row.createdAt,
  };
}

function seesBroadcast(user: User, audience: string, actorId: string | null) {
  if (actorId && actorId === user.id) return false;
  if (audience === "admin") return user.role === "admin";
  if (audience === "trade") {
    return user.role === "workshop" || user.role === "retailer" || user.role === "admin";
  }
  return true;
}

async function insertNotice(
  recipientId: string,
  input: NoticeInput,
  isRead = false,
) {
  const [row] = await db
    .insert(notifications)
    .values({
      recipientId,
      type: input.type,
      title: input.title,
      message: input.message,
      titleAr: input.titleAr ?? null,
      messageAr: input.messageAr ?? null,
      referenceId: input.referenceId ?? null,
      referenceKind: input.referenceKind ?? null,
      audience: input.audience ?? "all",
      actorId: input.actorId ?? null,
      isRead,
    })
    .returning();
  return row;
}

export async function notifyUser(recipientId: string, input: NoticeInput) {
  const row = await insertNotice(recipientId, input);
  if (row) pushNotifications(new Set([recipientId]));
  return row;
}

export async function notifyUsers(recipientIds: Iterable<string>, input: NoticeInput) {
  const ids = [...new Set(recipientIds)].filter(Boolean);
  if (!ids.length) return [];
  const rows = await db
    .insert(notifications)
    .values(
      ids.map((recipientId) => ({
        recipientId,
        type: input.type,
        title: input.title,
        message: input.message,
        titleAr: input.titleAr ?? null,
        messageAr: input.messageAr ?? null,
        referenceId: input.referenceId ?? null,
        referenceKind: input.referenceKind ?? null,
        audience: input.audience ?? "all",
        actorId: input.actorId ?? null,
        isRead: false,
      })),
    )
    .returning();
  pushNotifications(new Set(ids));
  return rows;
}

export async function notifyBroadcast(input: NoticeInput) {
  const row = await insertNotice(BROADCAST, {
    ...input,
    audience: input.audience ?? "trade",
  });
  pushNotifications("all");
  return row;
}

async function activeAdminIds() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.isActive, true)));
  return rows.map((row) => row.id);
}

async function counterpartyIds(userId: string) {
  const rows = await db
    .select({
      retailerId: creditAccounts.retailerId,
      workshopId: creditAccounts.workshopId,
    })
    .from(creditAccounts)
    .where(
      or(
        eq(creditAccounts.retailerId, userId),
        eq(creditAccounts.workshopId, userId),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.retailerId === userId ? row.workshopId : row.retailerId);
  }
  ids.delete(userId);
  return [...ids];
}

function unreadBroadcastFilter(userId: string) {
  return notExists(
    db
      .select({ id: notificationReads.notificationId })
      .from(notificationReads)
      .where(
        and(
          eq(notificationReads.notificationId, notifications.id),
          eq(notificationReads.userId, userId),
        ),
      ),
  );
}

export async function listNotifications(
  user: User,
  locale: "en" | "ar",
  unreadOnly = false,
) {
  const personalUnread = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, user.id),
        eq(notifications.isRead, false),
      ),
    )
    .orderBy(desc(notifications.createdAt));

  const personalRead = unreadOnly
    ? []
    : await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.recipientId, user.id),
            eq(notifications.isRead, true),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(40);

  const unreadBroadcasts = (
    await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, BROADCAST),
          unreadBroadcastFilter(user.id),
        ),
      )
      .orderBy(desc(notifications.createdAt))
  ).filter((row) => seesBroadcast(user, row.audience, row.actorId));

  const recentBroadcasts = unreadOnly
    ? []
    : await db
        .select()
        .from(notifications)
        .where(eq(notifications.recipientId, BROADCAST))
        .orderBy(desc(notifications.createdAt))
        .limit(40);
  const recentIds = recentBroadcasts.map((row) => row.id);
  const readRows = recentIds.length
    ? await db
        .select({ id: notificationReads.notificationId })
        .from(notificationReads)
        .where(
          and(
            eq(notificationReads.userId, user.id),
            inArray(notificationReads.notificationId, recentIds),
          ),
        )
    : [];
  const readBroadcasts = new Set(readRows.map((row) => row.id));
  const visibleRead = recentBroadcasts.filter(
    (row) =>
      readBroadcasts.has(row.id) &&
      seesBroadcast(user, row.audience, row.actorId),
  );

  const views = [
    ...personalUnread.map((row) => present(row, false, locale)),
    ...personalRead.map((row) => present(row, true, locale)),
    ...unreadBroadcasts.map((row) => present(row, false, locale)),
    ...visibleRead.map((row) => present(row, true, locale)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const unreadCount = personalUnread.length + unreadBroadcasts.length;
  return { notifications: views, unreadCount };
}

export async function markNotificationsRead(user: User, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 50);
  if (!unique.length) return;
  const rows = await db
    .select()
    .from(notifications)
    .where(inArray(notifications.id, unique));

  const personal = rows.filter((row) => row.recipientId === user.id);
  const broadcasts = rows.filter(
    (row) =>
      row.recipientId === BROADCAST &&
      seesBroadcast(user, row.audience, row.actorId),
  );

  if (personal.length) {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.recipientId, user.id),
          inArray(
            notifications.id,
            personal.map((row) => row.id),
          ),
        ),
      );
  }
  if (broadcasts.length) {
    await db
      .insert(notificationReads)
      .values(
        broadcasts.map((row) => ({
          notificationId: row.id,
          userId: user.id,
        })),
      )
      .onConflictDoNothing();
  }
}

export async function markAllNotificationsRead(user: User) {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(eq(notifications.recipientId, user.id), eq(notifications.isRead, false)),
    );

  const broadcasts = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, BROADCAST),
        unreadBroadcastFilter(user.id),
      ),
    );
  const visible = broadcasts.filter((row) =>
    seesBroadcast(user, row.audience, row.actorId),
  );
  if (!visible.length) return;
  await db
    .insert(notificationReads)
    .values(
      visible.map((row) => ({
        notificationId: row.id,
        userId: user.id,
      })),
    )
    .onConflictDoNothing();
}

export async function publishBroadcast(input: NoticeInput) {
  if (!input.title.trim() || !input.message.trim()) {
    throw badRequest("Title and message are required");
  }
  return notifyBroadcast({
    ...input,
    actorId: null,
    audience: input.audience ?? "trade",
  });
}

export async function notifyStolenRecovered(input: {
  reportId: string;
  actorId: string;
  recipientIds: string[];
  karat: number;
  weightGrams: string;
  city: string;
  country: string;
}) {
  await notifyUsers(input.recipientIds, {
    type: "STOLEN_ALERT",
    actorId: input.actorId,
    referenceId: input.reportId,
    referenceKind: "report",
    title: "Registry item recovered",
    titleAr: "تم العثور على القطعة",
    message: `${input.karat}K · ${input.weightGrams} g · ${input.city}, ${input.country} is recovered and archived.`,
    messageAr: `${input.karat} عيار · ${input.weightGrams} غ · ${input.city}، ${input.country}. تم العثور عليها وأُرشفت.`,
  });
}

export async function notifyStolenRegistry(input: {
  reportId: string;
  reporterId: string;
  kind: string;
  karat: number;
  weightGrams: string;
  city: string;
  country: string;
  description: string;
}) {
  const kindEn = input.kind === "lost" ? "Lost" : "Stolen";
  const kindAr = input.kind === "lost" ? "مفقود" : "مسروق";
  const blurb = input.description.trim().slice(0, 140);
  await notifyBroadcast({
    type: "STOLEN_ALERT",
    audience: "trade",
    actorId: input.reporterId,
    referenceId: input.reportId,
    referenceKind: "report",
    title: `${kindEn} gold reported`,
    titleAr: `بلاغ ذهب ${kindAr}`,
    message: `${input.karat}K · ${input.weightGrams} g · ${input.city}, ${input.country}. ${blurb}`,
    messageAr: `${input.karat} عيار · ${input.weightGrams} غ · ${input.city}، ${input.country}. ${blurb}`,
  });
}

export async function notifyScrapStolenMatch(input: {
  workshopId: string;
  reportId: string;
  karat: number;
  weightGrams: string;
  city: string;
}) {
  await notifyUser(input.workshopId, {
    type: "STOLEN_ALERT",
    referenceId: input.reportId,
    referenceKind: "report",
    title: "Incoming scrap matches the registry",
    titleAr: "كسر وارد يطابق السجل",
    message: `${input.karat}K · ${input.weightGrams} g · ${input.city}. Hold settlement until the report is checked.`,
    messageAr: `${input.karat} عيار · ${input.weightGrams} غ · ${input.city}. أوقف التسوية حتى مراجعة البلاغ.`,
  });
}

export async function notifyMemberRegistered(user: User) {
  const admins = await activeAdminIds();
  const name = user.businessName || user.fullName;
  await notifyUsers(
    admins.filter((id) => id !== user.id),
    {
      type: "NEW_MEMBER",
      referenceId: user.id,
      referenceKind: "user",
      title: "New house awaiting verification",
      titleAr: "منشأة جديدة بانتظار التحقق",
      message: `${name} (${user.role}) registered in ${user.city || user.country}.`,
      messageAr: `${name} (${user.role === "workshop" ? "ورشة" : "محل"}) سجّلت في ${user.city || user.country}.`,
    },
  );
}

export async function notifyMemberVerified(user: User) {
  const name = user.businessName || user.fullName;
  await notifyUser(user.id, {
    type: "NEW_MEMBER",
    referenceId: user.id,
    referenceKind: "user",
    title: "Your house is verified",
    titleAr: "تم التحقق من منشأتك",
    message: "You can trade on the Sagha desk.",
    messageAr: "يمكنكم التداول على مكتب صاغة.",
  });
  const admins = (await activeAdminIds()).filter((id) => id !== user.id);
  await notifyUsers(admins, {
    type: "NEW_MEMBER",
    referenceId: user.id,
    referenceKind: "user",
    title: "House verified",
    titleAr: "تم التحقق من منشأة",
    message: `${name} is now verified.`,
    messageAr: `${name} أصبحت متحقَّقاً منها.`,
  });
}

export async function notifyAccountClosed(user: User, houseName: string) {
  const ids = await activeAdminIds();
  await notifyUsers(ids, {
    type: "PROFILE_UPDATE",
    audience: "admin",
    actorId: user.id,
    referenceId: user.id,
    referenceKind: "user",
    title: "House closed its account",
    titleAr: "أغلقت منشأة حسابها",
    message: `${houseName} (${user.role}) closed this account. Trade rows stay on the ledger without the house credentials.`,
    messageAr: `${houseName} (${user.role}) أغلقت هذا الحساب. تبقى قيود التجارة في الدفتر دون بيانات الدخول.`,
  });
}

export async function notifySupportInquiry(
  user: User,
  reference: string,
  message: string,
) {
  const ids = await activeAdminIds();
  const name = user.businessName || user.fullName;
  const clipped = message.trim().slice(0, 500);
  await notifyUsers(ids, {
    type: "PROFILE_UPDATE",
    audience: "admin",
    actorId: user.id,
    referenceId: user.id,
    referenceKind: "user",
    title: `Support ${reference}`,
    titleAr: `دعم ${reference}`,
    message: `${name} (${user.email}): ${clipped}`,
    messageAr: `${name} (${user.email}): ${clipped}`,
  });
}

export async function notifyProfileChanged(user: User, fields: string[]) {
  if (!fields.length) return;
  const name = user.businessName || user.fullName;
  const listed = fields.join(", ");
  const ids = new Set<string>([
    ...(await activeAdminIds()),
    ...(await counterpartyIds(user.id)),
  ]);
  ids.delete(user.id);
  await notifyUsers([...ids], {
    type: "PROFILE_UPDATE",
    referenceId: user.id,
    referenceKind: "user",
    title: "Business details updated",
    titleAr: "تم تحديث بيانات منشأة",
    message: `${name} updated ${listed}.`,
    messageAr: `${name} حدّثت ${listed}.`,
  });
}

export async function notifyOrderEvent(input: {
  orderId: string;
  retailerId: string;
  workshopId: string;
  event: "spot" | "confirmed" | "fulfilled" | "completed" | "cancelled" | "expired";
}) {
  const copy = {
    spot: {
      title: "Spot locked",
      titleAr: "تم قفل سعر الذهب",
      message: "The wholesale order locked the spot price at placement.",
      messageAr: "قُفل سعر الذهب مع تسجيل طلب الجملة.",
    },
    confirmed: {
      title: "Order confirmed",
      titleAr: "تم تأكيد الطلب",
      message: "The workshop confirmed the wholesale order.",
      messageAr: "أكّدت الورشة طلب الجملة.",
    },
    fulfilled: {
      title: "Order fulfilled",
      titleAr: "تم تجهيز الطلب",
      message: "The wholesale order is fulfilled.",
      messageAr: "تم تجهيز طلب الجملة.",
    },
    completed: {
      title: "Order completed",
      titleAr: "اكتمل الطلب",
      message: "The wholesale order is complete.",
      messageAr: "اكتمل طلب الجملة.",
    },
    cancelled: {
      title: "Order cancelled",
      titleAr: "أُلغي الطلب",
      message: "The wholesale order was cancelled.",
      messageAr: "أُلغي طلب الجملة.",
    },
    expired: {
      title: "Reservation expired",
      titleAr: "انتهت مهلة الحجز",
      message: "A pending order passed its reservation time and stock was returned.",
      messageAr: "تجاوز طلب معلّق مهلة الحجز وأُعيد المخزون.",
    },
  }[input.event];

  await notifyUsers([input.retailerId, input.workshopId], {
    type: "ORDER_STATUS",
    referenceId: input.orderId,
    referenceKind: "order",
    ...copy,
  });
}

export async function notifyScrapSpotLocked(input: {
  scrapId: string;
  retailerId: string;
  karat: number;
  weightGrams: string;
}) {
  await notifyUser(input.retailerId, {
    type: "ORDER_STATUS",
    referenceId: input.scrapId,
    referenceKind: "scrap",
    title: "Scrap spot locked",
    titleAr: "تم قفل سعر الكسر",
    message: `Assay quote locked at ${input.karat}K · ${input.weightGrams} g.`,
    messageAr: `قُفل عرض المعايرة عند ${input.karat} عيار · ${input.weightGrams} غ.`,
  });
}

async function recentCreditWarning(accountId: string, recipientId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, "CREDIT_WARNING"),
        eq(notifications.referenceId, accountId),
        eq(notifications.recipientId, recipientId),
        eq(notifications.isRead, false),
        gt(notifications.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function notifyCreditPressure(input: {
  accountId: string;
  retailerId: string;
  workshopId: string;
  balanceCents: number;
  creditLimitCents: number | null;
  currency: string;
}) {
  if (input.creditLimitCents == null || input.creditLimitCents <= 0) return;
  const ratio = input.balanceCents / input.creditLimitCents;
  if (ratio < 0.8) return;
  if (await recentCreditWarning(input.accountId, input.retailerId)) return;
  const pct = Math.min(999, Math.round(ratio * 100));
  await notifyUsers([input.retailerId, input.workshopId], {
    type: "CREDIT_WARNING",
    referenceId: input.accountId,
    referenceKind: "account",
    title: "Credit line is tight",
    titleAr: "خط الائتمان اقترب من الحد",
    message: `Balance is ${pct}% of the ${input.currency} limit.`,
    messageAr: `الرصيد عند ${pct}٪ من حد ${input.currency}.`,
  });
}

export async function notifyCreditBlocked(input: {
  retailerId: string;
  workshopId: string;
  currency: string;
}) {
  await notifyUsers([input.retailerId, input.workshopId], {
    type: "CREDIT_WARNING",
    referenceKind: "account",
    title: "Credit limit reached",
    titleAr: "بلغ حد الائتمان",
    message: `An order was stopped because it exceeds the open ${input.currency} line.`,
    messageAr: `توقف طلب لأنه يتجاوز خط ${input.currency} المفتوح.`,
  });
}

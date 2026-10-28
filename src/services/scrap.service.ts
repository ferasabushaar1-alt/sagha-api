/**
 * Scrap / كسر desk — submit → assay/quote → accept → settle (cash or order credit).
 */
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  orders,
  scrapSubmissions,
  users,
  type ScrapKarat,
  type User,
} from "../db/schema.js";
import {
  isAppCurrency,
  usdCentsToCurrency,
  type AppCurrency,
} from "../lib/currencies.js";
import { resolveUnitsPerUsd } from "./fx.service.js";
import {
  badRequest,
  forbidden,
  notFound,
} from "../lib/errors.js";
import { assertVerified } from "../lib/verification.js";
import { scrapMeltValueCents } from "../lib/pricing.js";
import {
  orderOutstandingCents,
  postScrapCredit,
} from "./credit.service.js";
import { getMarketRates } from "./market-rates.service.js";
import {
  archiveMatchedScrap,
  rememberArchive,
} from "./archive.service.js";
import {
  attachStolenMatches,
  notifyScrapMatches,
} from "./stolen.service.js";
import {
  notifyScrapSpotLocked,
  safeNotify,
} from "./notifications.service.js";

const SCRAP_KARATS: ScrapKarat[] = [14, 18, 21, 22, 24];

function assertKarat(value: number): ScrapKarat {
  if (!SCRAP_KARATS.includes(value as ScrapKarat)) {
    throw badRequest("Karat must be one of 14, 18, 21, 22, 24");
  }
  return value as ScrapKarat;
}

export type SubmitScrapInput = {
  workshopId?: string;
  workshopIds?: string[];
  estimatedWeightGrams: number;
  estimatedKarat: number;
  description?: string;
  notes?: string;
  currency?: AppCurrency;
};

export type QuoteScrapInput = {
  assayedWeightGrams: number;
  assayedKarat: number;
  refiningFeeCents: number;
  quoteNotes?: string;
};

export type SettleScrapInput = {
  /** cash = mark paid; credit = apply net to an unpaid/partial order */
  method: "cash" | "credit";
  creditOrderId?: string;
  idempotencyKey: string;
};

export async function submitScrap(retailer: User, input: SubmitScrapInput) {
  if (retailer.role !== "retailer") {
    throw forbidden("Only retailers can submit scrap gold");
  }
  if (retailer.verificationStatus !== "verified") {
    throw forbidden("Retailer must be verified to submit scrap");
  }

  const workshopIds = [
    ...new Set(
      [...(input.workshopIds ?? []), input.workshopId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  if (workshopIds.length === 0) {
    throw badRequest("Select at least one workshop");
  }
  if (workshopIds.includes(retailer.id)) {
    throw badRequest("Cannot submit scrap to yourself");
  }

  const weight = Number(input.estimatedWeightGrams);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw badRequest("Estimated weight must be > 0");
  }
  const karat = assertKarat(input.estimatedKarat);
  const currencyRaw = input.currency ?? "USD";
  if (!isAppCurrency(currencyRaw)) {
    throw badRequest("Unsupported currency");
  }

  const workshops = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, workshopIds),
        eq(users.role, "workshop"),
        eq(users.verificationStatus, "verified"),
        eq(users.isActive, true),
      ),
    );

  if (workshops.length !== workshopIds.length) {
    throw badRequest("One or more workshops are not available for scrap");
  }

  const description = input.description?.trim() || null;
  const notes = input.notes?.trim() || null;

  const created = await db
    .insert(scrapSubmissions)
    .values(
      workshopIds.map((workshopId) => ({
        retailerId: retailer.id,
        workshopId,
        status: "submitted" as const,
        paymentStatus: "unpaid" as const,
        currency: currencyRaw,
        description,
        notes,
        estimatedWeightGrams: weight.toFixed(3),
        estimatedKarat: karat,
      })),
    )
    .returning();

  try {
    await notifyScrapMatches(created);
  } catch (err) {
    console.error("stolen scrap match failed", err);
  }
  return created;
}

export async function listScrap(user: User, status?: string) {
  const party =
    user.role === "admin"
      ? undefined
      : user.role === "workshop"
        ? eq(scrapSubmissions.workshopId, user.id)
        : eq(scrapSubmissions.retailerId, user.id);

  const conditions = [];
  if (party) conditions.push(party);
  if (status) conditions.push(eq(scrapSubmissions.status, status));

  const rows = await db
    .select({
      ...getTableColumns(scrapSubmissions),
      workshopBusinessName: users.businessName,
    })
    .from(scrapSubmissions)
    .innerJoin(users, eq(scrapSubmissions.workshopId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(scrapSubmissions.submittedAt));

  if (user.role !== "workshop") return rows;
  return attachStolenMatches(user.country, rows);
}

export async function getScrap(user: User, scrapId: string) {
  return loadScrap(user, scrapId);
}

/** Workshop assays scrap and issues melt quote with locked spot. */
export async function quoteScrap(
  user: User,
  scrapId: string,
  input: QuoteScrapInput,
) {
  assertVerified(user);
  const scrap = await loadScrapForWorkshopOrAdmin(user, scrapId);
  if (scrap.status !== "submitted") {
    throw badRequest("Only submitted scrap can be quoted");
  }

  const weight = Number(input.assayedWeightGrams);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw badRequest("Assayed weight must be > 0");
  }
  const karat = assertKarat(input.assayedKarat);
  const fee = Math.round(Number(input.refiningFeeCents));
  if (!Number.isFinite(fee) || fee < 0) {
    throw badRequest("Refining fee must be >= 0");
  }

  const rates = await getMarketRates();
  const spot = rates.spotCentsPerGramFine;
  if (!Number.isFinite(spot) || spot <= 0) {
    throw badRequest("Invalid gold spot price");
  }

  const meltUsdCents = scrapMeltValueCents({
    weightGrams: weight,
    karat,
    spotCentsPerGram: spot,
  });
  const scrapCurrency = isAppCurrency(scrap.currency)
    ? scrap.currency
    : ("USD" as AppCurrency);
  const { unitsPerUsd } = await resolveUnitsPerUsd(scrapCurrency);
  const meltValueCents = usdCentsToCurrency(
    meltUsdCents,
    scrapCurrency,
    unitsPerUsd,
  );
  // Refining fee is entered in the scrap settlement currency.
  if (fee > meltValueCents) {
    throw badRequest("Refining fee cannot exceed melt value");
  }
  const netValueCents = meltValueCents - fee;

  const [updated] = await db
    .update(scrapSubmissions)
    .set({
      status: "quoted",
      assayedWeightGrams: weight.toFixed(3),
      assayedKarat: karat,
      goldSpotPriceCentsPerGram: spot,
      spotLockedAt: new Date(),
      spotRateId: rates.rateId,
      spotSource: rates.source,
      spotOfficial: rates.official,
      meltValueCents,
      refiningFeeCents: fee,
      netValueCents,
      quoteNotes: input.quoteNotes?.trim() || null,
      quotedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scrapSubmissions.id, scrapId))
    .returning();

  if (updated) {
    await safeNotify(
      notifyScrapSpotLocked({
        scrapId: updated.id,
        retailerId: updated.retailerId,
        karat: updated.assayedKarat ?? updated.estimatedKarat,
        weightGrams: updated.assayedWeightGrams ?? updated.estimatedWeightGrams,
      }),
    );
  }

  return updated;
}

/** Workshop declines the submission before quoting. */
export async function declineScrap(
  user: User,
  scrapId: string,
  reason: string,
) {
  const scrap = await loadScrapForWorkshopOrAdmin(user, scrapId);
  if (scrap.status !== "submitted") {
    throw badRequest("Only submitted scrap can be declined");
  }
  if (!reason.trim()) throw badRequest("Decline reason is required");

  const [updated] = await db
    .update(scrapSubmissions)
    .set({
      status: "declined",
      rejectionReason: reason.trim(),
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scrapSubmissions.id, scrapId))
    .returning();

  return updated;
}

export async function acceptScrap(user: User, scrapId: string) {
  const scrap = await loadScrap(user, scrapId);
  if (user.role === "workshop") {
    throw forbidden("Only the retailer can accept a scrap quote");
  }
  if (user.role === "retailer" && scrap.retailerId !== user.id) {
    throw forbidden("Not your scrap submission");
  }
  if (scrap.status !== "quoted") {
    throw badRequest("Only quoted scrap can be accepted");
  }

  const [updated] = await db
    .update(scrapSubmissions)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scrapSubmissions.id, scrapId))
    .returning();

  return updated;
}

/** Retailer rejects the workshop quote. */
export async function rejectScrapQuote(
  user: User,
  scrapId: string,
  reason?: string,
) {
  const scrap = await loadScrap(user, scrapId);
  if (user.role !== "retailer" && user.role !== "admin") {
    throw forbidden("Only the retailer can reject a scrap quote");
  }
  if (user.role === "retailer" && scrap.retailerId !== user.id) {
    throw forbidden("Not your scrap submission");
  }
  if (scrap.status !== "quoted") {
    throw badRequest("Only quoted scrap can be rejected");
  }

  const [updated] = await db
    .update(scrapSubmissions)
    .set({
      status: "rejected",
      rejectionReason: reason?.trim() || null,
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scrapSubmissions.id, scrapId))
    .returning();

  return updated;
}

export async function cancelScrap(user: User, scrapId: string) {
  const scrap = await loadScrap(user, scrapId);
  if (user.role === "workshop") {
    throw forbidden("Workshops cannot cancel; decline instead");
  }
  if (user.role === "retailer" && scrap.retailerId !== user.id) {
    throw forbidden("Not your scrap submission");
  }
  if (!["submitted", "quoted"].includes(scrap.status)) {
    throw badRequest("Only submitted or quoted scrap can be cancelled");
  }

  const [updated] = await db
    .update(scrapSubmissions)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scrapSubmissions.id, scrapId))
    .returning();

  return updated;
}

/**
 * Settle accepted scrap: cash payout or credit against an open order
 * between the same retailer and workshop.
 */
async function replaySettledScrap(
  scrap: typeof scrapSubmissions.$inferSelect,
) {
  if (!scrap.creditOrderId) return { scrap, order: null };
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, scrap.creditOrderId))
    .limit(1);
  return { scrap, order: order ?? null };
}

export async function settleScrap(
  user: User,
  scrapId: string,
  input: SettleScrapInput,
) {
  assertVerified(user);
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) throw badRequest("Idempotency-Key header is required");
  const scrap = await loadScrapForWorkshopOrAdmin(user, scrapId);
  if (
    scrap.status === "settled" &&
    scrap.settlementIdempotencyKey === idempotencyKey
  ) {
    await rememberArchive(archiveMatchedScrap(scrap, user.id));
    return replaySettledScrap(scrap);
  }
  if (scrap.status !== "accepted") {
    throw badRequest("Only accepted scrap can be settled");
  }
  if (scrap.netValueCents == null || scrap.netValueCents < 0) {
    throw badRequest("Scrap has no net value to settle");
  }

  const netValue = scrap.netValueCents;
  const orderId =
    input.method === "credit" ? input.creditOrderId : undefined;
  if (input.method === "credit" && !orderId) {
    throw badRequest("creditOrderId is required for credit settlement");
  }

  let order: typeof orders.$inferSelect | undefined;
  if (orderId) {
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) throw notFound("Order not found");
    if (row.retailerId !== scrap.retailerId || row.workshopId !== scrap.workshopId) {
      throw badRequest("Credit order must be between the same retailer and workshop");
    }
    if (row.status === "cancelled") {
      throw badRequest("Cannot credit a cancelled order");
    }
    if (row.paymentStatus === "paid" || row.paymentStatus === "refunded") {
      throw badRequest("Order is already fully settled");
    }
    if (row.currency !== scrap.currency) {
      throw badRequest("Scrap and order currencies must match");
    }
    order = row;
  }

  const settled = await db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;

    // One settlement per scrap — losers of a concurrent race get zero rows.
    const [claimed] = await tx
      .update(scrapSubmissions)
      .set({
        status: "settled",
        paymentStatus: input.method === "cash" ? "paid" : "credited",
        creditOrderId: orderId ?? null,
        settlementIdempotencyKey: idempotencyKey,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scrapSubmissions.id, scrapId),
          eq(scrapSubmissions.status, "accepted"),
        ),
      )
      .returning();

    if (!claimed) {
      const [current] = await tx
        .select()
        .from(scrapSubmissions)
        .where(eq(scrapSubmissions.id, scrapId))
        .limit(1);
      if (
        current?.status === "settled" &&
        current.settlementIdempotencyKey === idempotencyKey
      ) {
        return { scrap: current, order: order ?? null };
      }
      throw badRequest("Scrap is no longer accepted (already settled)");
    }

    if (input.method === "cash") {
      // Cash is paid outside the ledger. Do not post scrap_credit, or the
      // retailer becomes a creditor while the workshop also pays the melt.
      return { scrap: claimed, order: null };
    }
    if (!order || !orderId) {
      throw badRequest("creditOrderId is required for credit settlement");
    }

    const outstanding = await orderOutstandingCents(orderId, exec);
    if (outstanding <= 0) {
      throw badRequest("Order has no outstanding balance to credit");
    }

    const appliedToOrder = Math.min(netValue, outstanding);
    const remainder = netValue - appliedToOrder;

    await postScrapCredit({
      retailerId: claimed.retailerId,
      workshopId: claimed.workshopId,
      currency: claimed.currency as AppCurrency,
      scrapId,
      amountCents: appliedToOrder,
      orderId,
      createdBy: user.id,
      executor: exec,
    });

    if (remainder > 0) {
      await postScrapCredit({
        retailerId: claimed.retailerId,
        workshopId: claimed.workshopId,
        currency: claimed.currency as AppCurrency,
        scrapId,
        amountCents: remainder,
        orderId: null,
        createdBy: user.id,
        executor: exec,
      });
    }

    const afterOutstanding = await orderOutstandingCents(orderId, exec);
    const nextPayment: "partial" | "paid" =
      afterOutstanding <= 0 ? "paid" : "partial";

    const [updatedOrder] = await exec
      .update(orders)
      .set({
        paymentStatus: nextPayment,
        notes: appendCreditNote(
          order.notes,
          scrapId,
          appliedToOrder,
          order.currency,
          remainder,
        ),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();

    return { scrap: claimed, order: updatedOrder ?? null };
  });
  await rememberArchive(archiveMatchedScrap(settled.scrap, user.id));
  return settled;
}

/** Eligible unpaid/partial orders for credit settlement (same parties). */
export async function listCreditOrders(user: User, scrapId: string) {
  const scrap = await loadScrap(user, scrapId);
  if (user.role === "retailer" && scrap.retailerId !== user.id) {
    throw forbidden("Not your scrap submission");
  }
  if (user.role === "workshop" && scrap.workshopId !== user.id) {
    throw forbidden("Not your scrap submission");
  }

  return db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.retailerId, scrap.retailerId),
        eq(orders.workshopId, scrap.workshopId),
        inArray(orders.paymentStatus, ["unpaid", "partial"]),
        inArray(orders.status, [
          "pending",
          "confirmed",
          "fulfilled",
          "completed",
        ]),
        eq(orders.currency, scrap.currency),
      ),
    )
    .orderBy(desc(orders.placedAt));
}

function appendCreditNote(
  existing: string | null,
  scrapId: string,
  appliedCents: number,
  currency: string,
  remainderCents = 0,
) {
  let line = `Scrap credit ${scrapId.slice(0, 8)}…: ${(appliedCents / 100).toFixed(2)} ${currency} applied to order`;
  if (remainderCents > 0) {
    line += ` (+${(remainderCents / 100).toFixed(2)} ${currency} unallocated)`;
  }
  return existing ? `${existing}\n${line}` : line;
}

function assertScrapAccess(
  user: User,
  scrap: typeof scrapSubmissions.$inferSelect,
) {
  if (user.role === "admin") return;
  if (user.role === "workshop" && scrap.workshopId === user.id) return;
  if (user.role === "retailer" && scrap.retailerId === user.id) return;
  throw forbidden("No access to this scrap submission");
}

async function loadScrap(user: User, scrapId: string) {
  const [scrap] = await db
    .select()
    .from(scrapSubmissions)
    .where(eq(scrapSubmissions.id, scrapId))
    .limit(1);
  if (!scrap) throw notFound("Scrap submission not found");
  assertScrapAccess(user, scrap);
  return scrap;
}

async function loadScrapForWorkshopOrAdmin(user: User, scrapId: string) {
  const scrap = await loadScrap(user, scrapId);
  if (user.role === "retailer") {
    throw forbidden("Only the workshop (or admin) can perform this action");
  }
  return scrap;
}

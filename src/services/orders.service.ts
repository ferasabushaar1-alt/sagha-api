import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  orderItems,
  orders,
  products,
  users,
  type User,
} from "../db/schema.js";
import {
  badRequest,
  forbidden,
  notFound,
  AppError,
} from "../lib/errors.js";
import {
  convertCents,
  isAppCurrency,
  usdCentsToCurrency,
  type AppCurrency,
} from "../lib/currencies.js";
import { priceLine } from "../lib/pricing.js";
import { assertVerified } from "../lib/verification.js";
import {
  assertAccountWithinLimitAfterPost,
  assertWithinCreditLimit,
  getOrCreateAccount,
  orderOutstandingCents,
  postOrderCancelSettlement,
  postOrderInvoice,
  postOrderPayment,
} from "./credit.service.js";
import { getUnitsPerUsdMap, resolveUnitsPerUsd } from "./fx.service.js";
import { getMarketRates } from "./market-rates.service.js";
import {
  decrementStock,
  getMakingTiersMap,
  incrementStock,
} from "./products.service.js";
import {
  archiveCompletedInvoice,
  rememberArchive,
} from "./archive.service.js";
import {
  notifyCreditBlocked,
  notifyCreditPressure,
  notifyOrderEvent,
  safeNotify,
} from "./notifications.service.js";

/** Pending orders hard-reserve stock until confirm or TTL expiry. */
export const ORDER_PENDING_TTL_MS = Math.max(
  60_000,
  Number(process.env.ORDER_PENDING_TTL_MS ?? 2 * 60 * 60 * 1000),
);

export type PlaceOrderItem = {
  productId: string;
  quantity: number;
};

export type PlaceOrderInput = {
  workshopId: string;
  items: PlaceOrderItem[];
  /** @deprecated Ignored — server locks active market/official spot. */
  goldSpotPriceCentsPerGram?: number;
  /** Settlement currency (defaults to first product currency). */
  currency?: AppCurrency;
  notes?: string;
  /** Client Idempotency-Key — required for safe retries. */
  idempotencyKey?: string;
};

export async function placeOrder(retailer: User, input: PlaceOrderInput) {
  if (retailer.role !== "retailer") {
    throw forbidden("Only retailers can place wholesale orders");
  }
  if (retailer.verificationStatus !== "verified") {
    throw forbidden("Retailer must be verified to place orders");
  }
  if (!input.items.length) throw badRequest("Order must include at least one item");
  if (input.workshopId === retailer.id) {
    throw badRequest("Cannot order from yourself");
  }

  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key is required to place an order");
  }
  if (idempotencyKey.length > 128) {
    throw badRequest("Idempotency-Key is too long");
  }

  // Replay prior successful place with the same key.
  const [existing] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.retailerId, retailer.id),
        eq(orders.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, existing.id));
    return { order: existing, items, replayed: true as const };
  }

  // Aggregate duplicate product lines so stock checks stay consistent.
  const qtyByProduct = new Map<string, number>();
  for (const line of input.items) {
    if (line.quantity <= 0) throw badRequest("Quantity must be > 0");
    qtyByProduct.set(
      line.productId,
      (qtyByProduct.get(line.productId) ?? 0) + line.quantity,
    );
  }
  const aggregatedItems = [...qtyByProduct.entries()].map(
    ([productId, quantity]) => ({ productId, quantity }),
  );

  const [workshop] = await db
    .select()
    .from(users)
    .where(eq(users.id, input.workshopId))
    .limit(1);

  if (
    !workshop ||
    workshop.role !== "workshop" ||
    workshop.verificationStatus !== "verified" ||
    !workshop.isActive
  ) {
    throw badRequest("Workshop is not available for orders");
  }

  // Immutable spot lock from active official rate (or live/fallback feed).
  const rates = await getMarketRates();
  const spot = rates.spotCentsPerGramFine;
  const spotLockedAt = new Date();
  if (!Number.isFinite(spot) || spot <= 0) {
    throw badRequest("Invalid gold spot price");
  }

  const productIds = aggregatedItems.map((i) => i.productId);
  const catalog = await db
    .select()
    .from(products)
    .where(
      and(
        inArray(products.id, productIds),
        eq(products.workshopId, input.workshopId),
        eq(products.status, "active"),
      ),
    );

  if (catalog.length !== productIds.length) {
    throw badRequest("One or more products are invalid or inactive for this workshop");
  }

  const byId = new Map(catalog.map((p) => [p.id, p]));
  const currencyRaw = input.currency ?? catalog[0].currency;
  if (!isAppCurrency(currencyRaw)) {
    throw badRequest("Unsupported currency");
  }
  const currency = currencyRaw;
  const { unitsPerUsd: orderFx, rateId: fxRateId } =
    await resolveUnitsPerUsd(currency);
  const unitsMap = await getUnitsPerUsdMap();
  unitsMap[currency] = orderFx;
  for (const product of catalog) {
    if (!isAppCurrency(product.currency)) continue;
    if (product.currency === "USD" || product.currency === currency) continue;
    const locked = await resolveUnitsPerUsd(product.currency);
    unitsMap[product.currency] = locked.unitsPerUsd;
  }

  const tiersByProduct = await getMakingTiersMap(productIds);

  const priced = aggregatedItems.map((line) => {
    const product = byId.get(line.productId)!;
    if (product.stockQty < line.quantity) {
      throw badRequest(`Insufficient stock for ${product.name}`);
    }
    if (!isAppCurrency(product.currency)) {
      throw badRequest(`Unsupported product currency for ${product.name}`);
    }

    const karat = product.karat as 18 | 21;
    const weight = Number(product.weightGrams);
    const makingTiers = (tiersByProduct.get(product.id) ?? []).map((t) => ({
      minQty: t.minQty,
      maxQty: t.maxQty,
      makingChargeCents: t.makingChargeCents,
    }));
    // Gold priced in USD from spot; making in product currency — then convert.
    const pricedUsd = priceLine({
      weightGrams: weight,
      karat,
      spotCentsPerGram: spot,
      makingChargeCents: product.makingChargeCents,
      quantity: line.quantity,
      makingTiers,
    });

    const qty = line.quantity;
    const lineGoldValueCents = usdCentsToCurrency(
      pricedUsd.unitGoldValueCents * qty,
      currency,
      orderFx,
    );
    const lineMakingChargeCents = convertCents(
      pricedUsd.unitMakingChargeCents * qty,
      product.currency,
      currency,
      unitsMap,
    );
    const pricedLine = {
      purityFactor: pricedUsd.purityFactor,
      unitGoldValueCents: Math.round(lineGoldValueCents / qty),
      unitMakingChargeCents: Math.round(lineMakingChargeCents / qty),
      makingTier: pricedUsd.makingTier,
      lineGoldValueCents,
      lineMakingChargeCents,
      lineTotalCents: lineGoldValueCents + lineMakingChargeCents,
    };

    return { product, quantity: line.quantity, karat, weight, pricedLine };
  });

  const goldValueCents = priced.reduce(
    (s, p) => s + p.pricedLine.lineGoldValueCents,
    0,
  );
  const makingChargesCents = priced.reduce(
    (s, p) => s + p.pricedLine.lineMakingChargeCents,
    0,
  );
  const totalCents = goldValueCents + makingChargesCents;
  void fxRateId;

  // Unpaid wholesale orders draw against the workshop credit line.
  try {
    await assertWithinCreditLimit({
      retailerId: retailer.id,
      workshopId: input.workshopId,
      currency,
      additionalCents: totalCents,
    });
  } catch (err) {
    if (err instanceof AppError && /credit limit/i.test(err.message)) {
      await safeNotify(
        notifyCreditBlocked({
          retailerId: retailer.id,
          workshopId: input.workshopId,
          currency,
        }),
      );
    }
    throw err;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const exec = tx as unknown as typeof db;
      // Lock account row then check limit (BUG-018).
      await assertWithinCreditLimit({
        retailerId: retailer.id,
        workshopId: input.workshopId,
        currency,
        additionalCents: totalCents,
        executor: exec,
      });

      const [order] = await tx
        .insert(orders)
        .values({
          retailerId: retailer.id,
          workshopId: input.workshopId,
          status: "pending",
          paymentStatus: "unpaid",
          currency,
          fxUnitsPerUsd: String(orderFx),
          goldSpotPriceCentsPerGram: spot,
          spotLockedAt,
          spotRateId: rates.rateId,
          spotSource: rates.source,
          spotOfficial: rates.official,
          spotVerificationImagePath: rates.verificationImagePath,
          goldValueCents,
          makingChargesCents,
          totalCents,
          notes: input.notes ?? null,
          idempotencyKey,
        })
        .returning();

      const lines = [];
      for (const p of priced) {
        // Hard stock reservation: deduct immediately; TTL job releases if still pending.
        await decrementStock(p.product.id, p.quantity, exec);

        const [item] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            productId: p.product.id,
            productName: p.product.name,
            karat: p.karat,
            unitWeightGrams: p.weight.toFixed(3),
            quantity: p.quantity,
            purityFactor: p.pricedLine.purityFactor.toFixed(6),
            unitGoldValueCents: p.pricedLine.unitGoldValueCents,
            unitMakingChargeCents: p.pricedLine.unitMakingChargeCents,
            makingTierMinQty: p.pricedLine.makingTier?.minQty ?? null,
            makingTierMaxQty: p.pricedLine.makingTier?.maxQty ?? null,
            lineGoldValueCents: p.pricedLine.lineGoldValueCents,
            lineMakingChargeCents: p.pricedLine.lineMakingChargeCents,
            lineTotalCents: p.pricedLine.lineTotalCents,
          })
          .returning();
        lines.push(item);
      }

      await postOrderInvoice({
        retailerId: retailer.id,
        workshopId: input.workshopId,
        currency,
        orderId: order.id,
        totalCents,
        createdBy: retailer.id,
        executor: exec,
      });

      const account = await getOrCreateAccount(
        retailer.id,
        input.workshopId,
        currency,
        exec,
      );
      await assertAccountWithinLimitAfterPost(account.id, currency, exec);

      return { order, items: lines, replayed: false as const };
    });

    if (!result.replayed && result.order) {
      await safeNotify(
        notifyOrderEvent({
          orderId: result.order.id,
          retailerId: result.order.retailerId,
          workshopId: result.order.workshopId,
          event: "spot",
        }),
      );
      const account = await getOrCreateAccount(
        result.order.retailerId,
        result.order.workshopId,
        result.order.currency as AppCurrency,
      );
      await safeNotify(
        notifyCreditPressure({
          accountId: account.id,
          retailerId: account.retailerId,
          workshopId: account.workshopId,
          balanceCents: account.balanceCents,
          creditLimitCents: account.creditLimitCents,
          currency: account.currency,
        }),
      );
    }

    return result;
  } catch (err) {
    // Concurrent duplicate key → replay the winner's order.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|unique|constraint/i.test(message)) {
      const [again] = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.retailerId, retailer.id),
            eq(orders.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (again) {
        const items = await db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, again.id));
        return { order: again, items, replayed: true as const };
      }
    }
    if (err instanceof AppError && /credit limit/i.test(err.message)) {
      await safeNotify(
        notifyCreditBlocked({
          retailerId: retailer.id,
          workshopId: input.workshopId,
          currency,
        }),
      );
    }
    throw err;
  }
}

export async function listOrders(user: User, status?: string) {
  const party =
    user.role === "admin"
      ? undefined
      : user.role === "workshop"
        ? eq(orders.workshopId, user.id)
        : eq(orders.retailerId, user.id);

  const conditions = [];
  if (party) conditions.push(party);
  if (status) conditions.push(eq(orders.status, status));

  const rows = await db
    .select()
    .from(orders)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.placedAt));

  return rows;
}

export async function getOrder(user: User, orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw notFound("Order not found");
  assertOrderAccess(user, order);

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  return { order, items };
}

export async function confirmOrder(user: User, orderId: string) {
  assertVerified(user);
  const order = await loadOrderForWorkshopOrAdmin(user, orderId);
  if (order.status !== "pending") {
    throw badRequest("Only pending orders can be confirmed");
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({
        status: "confirmed",
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
      .returning();
    if (!row) throw badRequest("Only pending orders can be confirmed");
    return row;
  });

  await safeNotify(
    notifyOrderEvent({
      orderId: updated.id,
      retailerId: updated.retailerId,
      workshopId: updated.workshopId,
      event: "confirmed",
    }),
  );
  return updated;
}

export async function fulfillOrder(user: User, orderId: string) {
  assertVerified(user);
  const order = await loadOrderForWorkshopOrAdmin(user, orderId);
  if (order.status !== "confirmed") {
    throw badRequest("Only confirmed orders can be fulfilled");
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({
        status: "fulfilled",
        fulfilledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "confirmed")))
      .returning();
    if (!row) throw badRequest("Only confirmed orders can be fulfilled");
    return row;
  });

  await safeNotify(
    notifyOrderEvent({
      orderId: updated.id,
      retailerId: updated.retailerId,
      workshopId: updated.workshopId,
      event: "fulfilled",
    }),
  );
  return updated;
}

export async function completeOrder(user: User, orderId: string) {
  assertVerified(user);
  if (user.role !== "workshop" && user.role !== "admin") {
    throw forbidden("Only the workshop can complete and settle an order");
  }
  const order = await loadOrderForParty(user, orderId);
  if (order.status !== "fulfilled") {
    throw badRequest("Only fulfilled orders can be completed");
  }

  const updated = await db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;
    const [claimed] = await exec
      .update(orders)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "fulfilled")))
      .returning();
    if (!claimed) {
      throw badRequest("Only fulfilled orders can be completed");
    }

    let paymentStatus = claimed.paymentStatus;
    if (paymentStatus === "unpaid" || paymentStatus === "partial") {
      const outstanding = await orderOutstandingCents(orderId, exec);
      if (outstanding > 0) {
        await postOrderPayment({
          retailerId: claimed.retailerId,
          workshopId: claimed.workshopId,
          currency: claimed.currency as AppCurrency,
          orderId,
          amountCents: outstanding,
          createdBy: user.id,
          note: "Settled on order complete",
          idempotencyKey: `order-complete:${orderId}`,
          executor: exec,
        });
      }
      paymentStatus = "paid";
    }

    const [finished] = await exec
      .update(orders)
      .set({ paymentStatus, updatedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    return finished ?? claimed;
  });

  if (updated) {
    await rememberArchive(archiveCompletedInvoice(updated, user.id));
    await safeNotify(
      notifyOrderEvent({
        orderId: updated.id,
        retailerId: updated.retailerId,
        workshopId: updated.workshopId,
        event: "completed",
      }),
    );
  }
  return updated;
}

export async function cancelOrder(user: User, orderId: string) {
  assertVerified(user);
  const order = await loadOrderForParty(user, orderId);
  if (!["pending", "confirmed"].includes(order.status)) {
    throw badRequest("Only pending or confirmed orders can be cancelled");
  }

  // Retailer can cancel pending only; workshop/admin can cancel pending|confirmed
  if (
    user.role === "retailer" &&
    order.status !== "pending"
  ) {
    throw forbidden("Retailers can only cancel pending orders");
  }

  const updated = await cancelOrderInternal(order, user.id);
  if (updated) {
    await safeNotify(
      notifyOrderEvent({
        orderId: updated.id,
        retailerId: updated.retailerId,
        workshopId: updated.workshopId,
        event: "cancelled",
      }),
    );
  }
  return updated;
}

/**
 * Restock + money-conserving ledger unwind. Used by user cancel and TTL expiry.
 */
export async function cancelOrderInternal(
  order: typeof orders.$inferSelect,
  createdBy: string | null,
  options?: { reason?: string },
) {
  if (!["pending", "confirmed"].includes(order.status)) {
    throw badRequest("Only pending or confirmed orders can be cancelled");
  }

  return db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;

    // Claim cancel atomically — concurrent TTL/user cancel loses here (BUG-017).
    const noteSuffix = options?.reason ? `\n[${options.reason}]` : "";
    const [claimed] = await tx
      .update(orders)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        notes: order.notes
          ? `${order.notes}${noteSuffix}`
          : options?.reason ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orders.id, order.id),
          inArray(orders.status, ["pending", "confirmed"]),
        ),
      )
      .returning();

    if (!claimed) {
      throw badRequest("Order already cancelled or not cancellable");
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    for (const item of items) {
      await incrementStock(item.productId, item.quantity, exec);
    }

    const settlement = await postOrderCancelSettlement({
      retailerId: claimed.retailerId,
      workshopId: claimed.workshopId,
      currency: claimed.currency as AppCurrency,
      orderId: claimed.id,
      totalCents: claimed.totalCents,
      createdBy,
      executor: exec,
    });

    const paymentStatus =
      settlement.cashPaid > 0 || settlement.scrapApplied > 0
        ? "refunded"
        : "unpaid";

    const [updated] = await tx
      .update(orders)
      .set({
        paymentStatus,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, claimed.id))
      .returning();

    return updated ?? claimed;
  });
}

/**
 * Hard-reservation TTL: cancel stale pending orders and return stock to inventory.
 * Confirmed+ orders are never auto-expired (workshop has accepted the hold).
 */
export async function expireStalePendingOrders(
  ttlMs: number = ORDER_PENDING_TTL_MS,
) {
  const cutoff = new Date(Date.now() - ttlMs);
  const stale = await db
    .select()
    .from(orders)
    .where(and(eq(orders.status, "pending"), lt(orders.placedAt, cutoff)));

  const cancelled = [];
  for (const order of stale) {
    try {
      const updated = await cancelOrderInternal(order, null, {
        reason: `Auto-cancelled: pending reservation TTL (${Math.round(ttlMs / 3600000)}h)`,
      });
      cancelled.push(updated);
      if (updated) {
        await safeNotify(
          notifyOrderEvent({
            orderId: updated.id,
            retailerId: updated.retailerId,
            workshopId: updated.workshopId,
            event: "expired",
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Lost race to concurrent cancel — expected, not an error.
      if (/already cancelled|not cancellable/i.test(msg)) continue;
      console.error(`[expireStalePendingOrders] failed for ${order.id}:`, msg);
    }
  }
  return { expired: cancelled.length, orders: cancelled, cutoff, ttlMs };
}

export async function updatePayment(
  user: User,
  orderId: string,
  input: {
    paymentStatus: "unpaid" | "partial" | "paid" | "refunded";
    paymentProofPath?: string;
    /** Cents for partial payment; paid settles remaining if omitted */
    amountCents?: number;
    /** Dedupes retries of the same payment application */
    idempotencyKey?: string;
  },
) {
  assertVerified(user);
  if (user.role !== "workshop" && user.role !== "admin") {
    throw forbidden("Only the workshop can post a payment");
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key header is required");
  }
  const order = await loadOrderForParty(user, orderId);
  if (order.status === "cancelled") {
    throw badRequest("Cannot update payment on a cancelled order");
  }

  return db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;

    if (input.paymentStatus === "refunded") {
      throw badRequest(
        "Refunds are posted by cancelling the order or refunding a return",
      );
    }

    if (input.paymentStatus === "paid" || input.paymentStatus === "partial") {
      const outstanding = await orderOutstandingCents(orderId, exec);
      let payCents = input.amountCents;
      if (input.paymentStatus === "paid") {
        // Always settle remaining only — never overpay via explicit amount.
        payCents = outstanding;
      }
      if (!payCents || payCents <= 0) {
        if (input.paymentStatus === "partial") {
          throw badRequest(
            outstanding <= 0
              ? "Order has no outstanding balance"
              : "Partial payment requires a positive amountCents",
          );
        }
        // paid with nothing outstanding: just sync status below
      } else {
        await postOrderPayment({
          retailerId: order.retailerId,
          workshopId: order.workshopId,
          currency: order.currency as AppCurrency,
          orderId,
          amountCents: payCents,
          createdBy: user.id,
          idempotencyKey,
          executor: exec,
        });
      }
    }

    const outstanding = await orderOutstandingCents(orderId, exec);
    let paymentStatus = input.paymentStatus;
    if (input.paymentStatus === "paid" || input.paymentStatus === "partial") {
      paymentStatus = outstanding <= 0 ? "paid" : "partial";
    }

    const [updated] = await exec
      .update(orders)
      .set({
        paymentStatus,
        paymentProofPath:
          input.paymentProofPath !== undefined
            ? input.paymentProofPath
            : order.paymentProofPath,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();

    return updated;
  });
}

function assertOrderAccess(
  user: User,
  order: typeof orders.$inferSelect,
) {
  if (user.role === "admin") return;
  if (user.role === "workshop" && order.workshopId === user.id) return;
  if (user.role === "retailer" && order.retailerId === user.id) return;
  throw forbidden("No access to this order");
}

async function loadOrderForParty(user: User, orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw notFound("Order not found");
  assertOrderAccess(user, order);
  return order;
}

async function loadOrderForWorkshopOrAdmin(user: User, orderId: string) {
  const order = await loadOrderForParty(user, orderId);
  if (user.role === "retailer") {
    throw forbidden("Only the workshop (or admin) can perform this action");
  }
  return order;
}

/** Exported for returns service */
export async function getOrderWithItemsInternal(orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw notFound("Order not found");
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return { order, items };
}

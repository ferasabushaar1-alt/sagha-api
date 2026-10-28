import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  orders,
  returnItems,
  returns,
  type User,
} from "../db/schema.js";
import type { AppCurrency } from "../lib/currencies.js";
import {
  badRequest,
  forbidden,
  notFound,
} from "../lib/errors.js";
import { assertVerified } from "../lib/verification.js";
import { postReturnRefund } from "./credit.service.js";
import { getOrderWithItemsInternal } from "./orders.service.js";
import { incrementStock } from "./products.service.js";

export type ReturnLineInput = {
  orderItemId: string;
  quantity: number;
  conditionNotes?: string;
};

export type CreateReturnInput = {
  orderId: string;
  reason: string;
  items: ReturnLineInput[];
};

export async function requestReturn(retailer: User, input: CreateReturnInput) {
  if (retailer.role !== "retailer") {
    throw forbidden("Only retailers can request returns");
  }
  if (!input.items.length) throw badRequest("Return must include at least one item");

  const { order, items: orderLines } = await getOrderWithItemsInternal(
    input.orderId,
  );

  if (order.retailerId !== retailer.id) {
    throw forbidden("Not your order");
  }
  if (!["fulfilled", "completed"].includes(order.status)) {
    throw badRequest("Returns are only allowed on fulfilled or completed orders");
  }

  const lineById = new Map(orderLines.map((l) => [l.id, l]));

  // Sum already-returned qty per order_item (active returns only)
  const existing = await db
    .select({
      orderItemId: returnItems.orderItemId,
      qty: sql<number>`coalesce(sum(${returnItems.quantity}), 0)`.mapWith(Number),
    })
    .from(returnItems)
    .innerJoin(returns, eq(returnItems.returnId, returns.id))
    .where(
      and(
        eq(returns.orderId, order.id),
        inArray(returns.status, [
          "requested",
          "approved",
          "received",
          "refunded",
        ]),
      ),
    )
    .groupBy(returnItems.orderItemId);

  const returnedSoFar = new Map(
    existing.map((r) => [r.orderItemId, Number(r.qty)]),
  );

  const prepared = input.items.map((line) => {
    const orderLine = lineById.get(line.orderItemId);
    if (!orderLine) {
      throw badRequest(`Order item ${line.orderItemId} not on this order`);
    }
    if (line.quantity <= 0) throw badRequest("Return quantity must be > 0");

    const already = returnedSoFar.get(line.orderItemId) ?? 0;
    if (already + line.quantity > orderLine.quantity) {
      throw badRequest(
        `Cannot return more than ordered for ${orderLine.productName}`,
      );
    }

    const unitRefund = Math.round(
      orderLine.lineTotalCents / orderLine.quantity,
    );
    const refundCents = unitRefund * line.quantity;
    const weightGrams = (
      Number(orderLine.unitWeightGrams) * line.quantity
    ).toFixed(3);

    return {
      orderLine,
      quantity: line.quantity,
      weightGrams,
      refundCents,
      conditionNotes: line.conditionNotes ?? null,
    };
  });

  const refundCents = prepared.reduce((s, p) => s + p.refundCents, 0);

  return db.transaction(async (tx) => {
    // Re-check returned qty inside the TX so two concurrent requests cannot over-return.
    const lockedExisting = await tx
      .select({
        orderItemId: returnItems.orderItemId,
        qty: sql<number>`coalesce(sum(${returnItems.quantity}), 0)`.mapWith(
          Number,
        ),
      })
      .from(returnItems)
      .innerJoin(returns, eq(returnItems.returnId, returns.id))
      .where(
        and(
          eq(returns.orderId, order.id),
          inArray(returns.status, [
            "requested",
            "approved",
            "received",
            "refunded",
          ]),
        ),
      )
      .groupBy(returnItems.orderItemId);

    const lockedReturned = new Map(
      lockedExisting.map((r) => [r.orderItemId, Number(r.qty)]),
    );
    for (const p of prepared) {
      const already = lockedReturned.get(p.orderLine.id) ?? 0;
      if (already + p.quantity > p.orderLine.quantity) {
        throw badRequest(
          `Cannot return more than ordered for ${p.orderLine.productName}`,
        );
      }
    }

    const [ret] = await tx
      .insert(returns)
      .values({
        orderId: order.id,
        retailerId: retailer.id,
        workshopId: order.workshopId,
        status: "requested",
        reason: input.reason,
        currency: order.currency,
        refundCents,
      })
      .returning();

    const lines = [];
    for (const p of prepared) {
      const [ri] = await tx
        .insert(returnItems)
        .values({
          returnId: ret.id,
          orderItemId: p.orderLine.id,
          productId: p.orderLine.productId,
          quantity: p.quantity,
          weightGrams: p.weightGrams,
          refundCents: p.refundCents,
          conditionNotes: p.conditionNotes,
        })
        .returning();
      lines.push(ri);
    }

    return { return: ret, items: lines };
  });
}

export async function listReturns(user: User, status?: string) {
  const party =
    user.role === "admin"
      ? undefined
      : user.role === "workshop"
        ? eq(returns.workshopId, user.id)
        : eq(returns.retailerId, user.id);

  const conditions = [];
  if (party) conditions.push(party);
  if (status) conditions.push(eq(returns.status, status));

  return db
    .select()
    .from(returns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(returns.requestedAt));
}

export async function getReturn(user: User, returnId: string) {
  const ret = await loadReturn(user, returnId);
  const items = await db
    .select()
    .from(returnItems)
    .where(eq(returnItems.returnId, returnId));
  return { return: ret, items };
}

export async function approveReturn(user: User, returnId: string) {
  assertVerified(user);
  const ret = await loadReturnForWorkshopOrAdmin(user, returnId);
  if (ret.status !== "requested") {
    throw badRequest("Only requested returns can be approved");
  }

  const [updated] = await db
    .update(returns)
    .set({
      status: "approved",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(returns.id, returnId))
    .returning();

  return updated;
}

export async function rejectReturn(
  user: User,
  returnId: string,
  reason: string,
) {
  assertVerified(user);
  const ret = await loadReturnForWorkshopOrAdmin(user, returnId);
  if (ret.status !== "requested") {
    throw badRequest("Only requested returns can be rejected");
  }

  const [updated] = await db
    .update(returns)
    .set({
      status: "rejected",
      rejectionReason: reason,
      decidedAt: new Date(),
      refundCents: 0,
      updatedAt: new Date(),
    })
    .where(eq(returns.id, returnId))
    .returning();

  return updated;
}

export async function receiveReturn(user: User, returnId: string) {
  assertVerified(user);
  await loadReturnForWorkshopOrAdmin(user, returnId);

  return db.transaction(async (tx) => {
    // Claim first — concurrent receives cannot both restock (BUG-023).
    const [claimed] = await tx
      .update(returns)
      .set({
        status: "received",
        receivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(returns.id, returnId), eq(returns.status, "approved")))
      .returning();

    if (!claimed) {
      throw badRequest("Only approved returns can be marked received");
    }

    const items = await tx
      .select()
      .from(returnItems)
      .where(eq(returnItems.returnId, returnId));

    for (const item of items) {
      await incrementStock(
        item.productId,
        item.quantity,
        tx as unknown as typeof db,
      );
    }

    return claimed;
  });
}

export async function refundReturn(user: User, returnId: string) {
  assertVerified(user);
  await loadReturnForWorkshopOrAdmin(user, returnId);

  return db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;

    const [claimed] = await tx
      .update(returns)
      .set({
        status: "refunded",
        refundedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(returns.id, returnId), eq(returns.status, "received")))
      .returning();

    if (!claimed) {
      throw badRequest("Only received returns can be refunded");
    }

    const posted = await postReturnRefund({
      retailerId: claimed.retailerId,
      workshopId: claimed.workshopId,
      currency: claimed.currency as AppCurrency,
      orderId: claimed.orderId,
      returnId: claimed.id,
      refundCents: claimed.refundCents,
      createdBy: user.id,
      executor: exec,
    });
    const applied = posted ? Math.abs(posted.amountCents) : 0;
    if (applied !== claimed.refundCents) {
      await tx
        .update(returns)
        .set({ refundCents: applied, updatedAt: new Date() })
        .where(eq(returns.id, claimed.id));
      claimed.refundCents = applied;
    }

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, claimed.orderId))
      .limit(1);

    const refundedRows = await tx
      .select({
        sum: sql<number>`coalesce(sum(${returns.refundCents}), 0)`.mapWith(
          Number,
        ),
      })
      .from(returns)
      .where(
        and(
          eq(returns.orderId, claimed.orderId),
          eq(returns.status, "refunded"),
        ),
      );
    const refundedTotal = Number(refundedRows[0]?.sum ?? 0);

    if (order && refundedTotal >= order.totalCents) {
      await tx
        .update(orders)
        .set({
          paymentStatus: "refunded",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, claimed.orderId));
    }

    return claimed;
  });
}

export async function cancelReturn(user: User, returnId: string) {
  assertVerified(user);
  const ret = await loadReturn(user, returnId);
  if (ret.status !== "requested") {
    throw badRequest("Only requested returns can be cancelled");
  }
  if (user.role === "workshop") {
    throw forbidden("Workshops should reject, not cancel, a return request");
  }

  const [updated] = await db
    .update(returns)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(eq(returns.id, returnId))
    .returning();

  return updated;
}

function assertReturnAccess(user: User, ret: typeof returns.$inferSelect) {
  if (user.role === "admin") return;
  if (user.role === "workshop" && ret.workshopId === user.id) return;
  if (user.role === "retailer" && ret.retailerId === user.id) return;
  throw forbidden("No access to this return");
}

async function loadReturn(user: User, returnId: string) {
  const [ret] = await db
    .select()
    .from(returns)
    .where(eq(returns.id, returnId))
    .limit(1);
  if (!ret) throw notFound("Return not found");
  assertReturnAccess(user, ret);
  return ret;
}

async function loadReturnForWorkshopOrAdmin(user: User, returnId: string) {
  const ret = await loadReturn(user, returnId);
  if (user.role === "retailer") {
    throw forbidden("Only the workshop (or admin) can perform this action");
  }
  return ret;
}

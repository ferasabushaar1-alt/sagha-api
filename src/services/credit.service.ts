/**
 * Buyer credit & aging ledger (دفتر الدين والائتمان).
 * Balance > 0 = retailer owes workshop (AR from workshop view).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  creditAccounts,
  creditLedgerEntries,
  orders,
  users,
  type CreditEntryType,
  type User,
} from "../db/schema.js";
import type { AppCurrency } from "../lib/currencies.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../lib/errors.js";
import { assertVerified } from "../lib/verification.js";

export type AgingBuckets = {
  currentCents: number;
  days31to60Cents: number;
  days61to90Cents: number;
  days90PlusCents: number;
  totalOutstandingCents: number;
};

export type CreditAccountSummary = typeof creditAccounts.$inferSelect & {
  retailerBusinessName: string | null;
  retailerFullName: string | null;
  workshopBusinessName: string | null;
  workshopFullName: string | null;
  availableCreditCents: number | null;
  aging: AgingBuckets;
};

type DbLike = typeof db;

function dayAge(from: Date, now = new Date()) {
  return Math.floor((now.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function toDate(value: Date | number | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function getOrCreateAccount(
  retailerId: string,
  workshopId: string,
  currency: AppCurrency,
  executor: DbLike = db,
) {
  if (retailerId === workshopId) {
    throw badRequest("Credit account parties must differ");
  }

  const [existing] = await executor
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.retailerId, retailerId),
        eq(creditAccounts.workshopId, workshopId),
        eq(creditAccounts.currency, currency),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await executor
    .insert(creditAccounts)
    .values({
      retailerId,
      workshopId,
      currency,
      balanceCents: 0,
      creditLimitCents: null,
    })
    .returning();

  return created;
}

async function postEntry(
  input: {
    accountId: string;
    entryType: CreditEntryType;
    amountCents: number;
    orderId?: string | null;
    scrapId?: string | null;
    note?: string | null;
    createdBy?: string | null;
    idempotencyKey?: string | null;
  },
  executor: DbLike = db,
) {
  if (!Number.isFinite(input.amountCents) || input.amountCents === 0) {
    throw badRequest("Ledger amount must be a non-zero integer");
  }
  const amount = Math.trunc(input.amountCents);

  const [account] = await executor
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, input.accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");

  const balanceAfter = account.balanceCents + amount;

  const [entry] = await executor
    .insert(creditLedgerEntries)
    .values({
      accountId: input.accountId,
      entryType: input.entryType,
      amountCents: amount,
      balanceAfterCents: balanceAfter,
      orderId: input.orderId ?? null,
      scrapId: input.scrapId ?? null,
      note: input.note?.trim() || null,
      idempotencyKey: input.idempotencyKey?.trim() || null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  await executor
    .update(creditAccounts)
    .set({ balanceCents: balanceAfter, updatedAt: new Date() })
    .where(eq(creditAccounts.id, input.accountId));

  return { entry, balanceCents: balanceAfter };
}

/** Idempotent: skip if an invoice entry already exists for this order. */
export async function postOrderInvoice(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  orderId: string;
  totalCents: number;
  createdBy?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;
  if (input.totalCents <= 0) return null;

  const [existing] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, input.orderId),
        eq(creditLedgerEntries.entryType, "invoice"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );

  const { entry } = await postEntry(
    {
      accountId: account.id,
      entryType: "invoice",
      amountCents: input.totalCents,
      orderId: input.orderId,
      note: `Wholesale order ${input.orderId.slice(0, 8)}`,
      createdBy: input.createdBy,
    },
    executor,
  );
  return entry;
}

export async function postOrderReversal(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  orderId: string;
  totalCents: number;
  createdBy?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;
  if (input.totalCents <= 0) return null;

  const [existing] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, input.orderId),
        eq(creditLedgerEntries.entryType, "reversal"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  // Only reverse if an invoice was posted
  const [invoice] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, input.orderId),
        eq(creditLedgerEntries.entryType, "invoice"),
      ),
    )
    .limit(1);
  if (!invoice) return null;

  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );

  // Reverse the full invoice. Payments + scrap credits remain, so net order
  // contribution becomes -(cash + scrap applied) — retailer store credit —
  // without a separate refund/restore that can double-credit after over-settle.
  const reverseAmount = Math.min(
    input.totalCents,
    Math.max(invoice.amountCents, 0),
  );
  if (reverseAmount <= 0) return null;

  const { entry } = await postEntry(
    {
      accountId: account.id,
      entryType: "reversal",
      amountCents: -reverseAmount,
      orderId: input.orderId,
      note: `Order cancelled ${input.orderId.slice(0, 8)}`,
      createdBy: input.createdBy,
    },
    executor,
  );
  return entry;
}

const RETURN_REFUND_NOTE_PREFIX = "Return refund ";

async function sumEntryTypeAbs(
  orderId: string,
  entryType: CreditEntryType,
  executor: DbLike,
) {
  const rows = await executor
    .select({
      sum: sql<number>`coalesce(sum(${creditLedgerEntries.amountCents}), 0)`.mapWith(
        Number,
      ),
    })
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, orderId),
        eq(creditLedgerEntries.entryType, entryType),
      ),
    );
  return Math.abs(Number(rows[0]?.sum ?? 0));
}

async function findNoteEntry(
  orderId: string,
  entryType: CreditEntryType,
  notePrefix: string,
  executor: DbLike,
) {
  const rows = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, orderId),
        eq(creditLedgerEntries.entryType, entryType),
      ),
    );
  return rows.find((r) => (r.note ?? "").startsWith(notePrefix)) ?? null;
}

/**
 * Money-conserving cancel settlement:
 * Reverse the full invoice. Existing payment / scrap_credit rows stay, so the
 * order net becomes -(cash paid + scrap applied to this order) as store credit.
 * Does NOT post extra refund/restore rows (those double-credited after scrap
 * over-settlement — BUG-016).
 */
export async function postOrderCancelSettlement(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  orderId: string;
  totalCents: number;
  createdBy?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;

  const cashPaid = await sumEntryTypeAbs(input.orderId, "payment", executor);
  const scrapApplied = await sumEntryTypeAbs(
    input.orderId,
    "scrap_credit",
    executor,
  );

  const reversal = await postOrderReversal(input);

  return {
    reversal,
    refund: null,
    scrapRestore: null,
    cashPaid,
    scrapApplied,
  };
}

/** Credit retailer for a processed return (idempotent per return id). */
export async function postReturnRefund(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  orderId: string;
  returnId: string;
  refundCents: number;
  createdBy?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;
  if (input.refundCents <= 0) return null;

  const note = `${RETURN_REFUND_NOTE_PREFIX}${input.returnId}`;
  const existing = await findNoteEntry(
    input.orderId,
    "refund",
    note,
    executor,
  );
  if (existing) return existing;

  // Also match exact note in case prefix search used shorter id
  const [byExact] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, input.orderId),
        eq(creditLedgerEntries.entryType, "refund"),
        eq(creditLedgerEntries.note, note),
      ),
    )
    .limit(1);
  if (byExact) return byExact;

  const net = await orderOutstandingCents(input.orderId, executor);
  const cashPaid = await sumEntryTypeAbs(input.orderId, "payment", executor);
  // Payments are already inside `net`, so adding cash back is the funded ceiling.
  // Prior refunds are already inside `net`, so they are not subtracted again.
  const room = Math.max(0, net + cashPaid);
  const apply = Math.min(Math.trunc(input.refundCents), room);
  if (apply <= 0) return null;

  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );

  const { entry } = await postEntry(
    {
      accountId: account.id,
      entryType: "refund",
      amountCents: -apply,
      orderId: input.orderId,
      note,
      createdBy: input.createdBy,
    },
    executor,
  );
  return entry;
}

const PAYMENT_IDEMPOTENCY_NOTE_PREFIX = "Payment idem:";

/**
 * Serialize credit-account access inside a TX (SQLite write lock on the row),
 * then enforce limit against the locked balance.
 */
export async function assertWithinCreditLimit(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  additionalCents: number;
  executor?: DbLike;
}) {
  if (input.additionalCents <= 0) return;

  const executor = input.executor ?? db;
  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );

  // Touch the row so concurrent checkouts serialize on this account.
  await executor
    .update(creditAccounts)
    .set({ updatedAt: new Date() })
    .where(eq(creditAccounts.id, account.id));

  const [locked] = await executor
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, account.id))
    .limit(1);
  if (!locked) throw notFound("Credit account not found");

  if (locked.creditLimitCents == null) return;

  const projected = locked.balanceCents + input.additionalCents;
  if (projected > locked.creditLimitCents) {
    const available = Math.max(
      0,
      locked.creditLimitCents - locked.balanceCents,
    );
    throw badRequest(
      `Order exceeds credit limit (available ${(available / 100).toFixed(2)} ${input.currency})`,
    );
  }
}

/** Re-check limit after posting an invoice (rolls back TX if breached). */
export async function assertAccountWithinLimitAfterPost(
  accountId: string,
  currency: AppCurrency,
  executor: DbLike = db,
) {
  const [account] = await executor
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");
  if (account.creditLimitCents == null) return;
  if (account.balanceCents > account.creditLimitCents) {
    const over = account.balanceCents - account.creditLimitCents;
    throw badRequest(
      `Order exceeds credit limit (over by ${(over / 100).toFixed(2)} ${currency})`,
    );
  }
}

export async function postOrderPayment(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  orderId: string;
  amountCents: number;
  createdBy?: string | null;
  note?: string;
  /** When set, duplicate POSTs with the same key return the existing entry. */
  idempotencyKey?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;
  if (input.amountCents <= 0) {
    throw badRequest("Payment amount must be > 0");
  }
  const key = input.idempotencyKey?.trim();
  if (!key) throw badRequest("Idempotency-Key is required");

  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );
  const replay = await findIdempotentEntry(account.id, key, executor);
  if (replay) {
    if ((replay.orderId ?? null) !== input.orderId) {
      throw conflict("Idempotency-Key was already used");
    }
    return replay;
  }
  const legacy = await findLegacyPayment(input.orderId, key, executor);
  if (legacy) return legacy;

  // Never apply more than remaining outstanding on this order.
  const outstanding = await orderOutstandingCents(input.orderId, executor);
  if (outstanding <= 0) {
    return null;
  }
  const applyCents = Math.min(Math.trunc(input.amountCents), outstanding);
  if (applyCents <= 0) return null;

  const { entry } = await postEntry(
    {
      accountId: account.id,
      entryType: "payment",
      amountCents: -applyCents,
      orderId: input.orderId,
      note: input.note ?? `Payment on order ${input.orderId.slice(0, 8)}`,
      idempotencyKey: key,
      createdBy: input.createdBy,
    },
    executor,
  );
  return entry;
}

async function findIdempotentEntry(
  accountId: string,
  key: string,
  executor: DbLike,
) {
  const [row] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.accountId, accountId),
        eq(creditLedgerEntries.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findLegacyPayment(
  orderId: string,
  key: string,
  executor: DbLike,
) {
  const notePrefix = `${PAYMENT_IDEMPOTENCY_NOTE_PREFIX}${key}`;
  const rows = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.orderId, orderId),
        eq(creditLedgerEntries.entryType, "payment"),
      ),
    );
  return rows.find((row) => (row.note ?? "").startsWith(notePrefix)) ?? null;
}

export async function postScrapCredit(input: {
  retailerId: string;
  workshopId: string;
  currency: AppCurrency;
  scrapId: string;
  amountCents: number;
  orderId?: string | null;
  createdBy?: string | null;
  executor?: DbLike;
}) {
  const executor = input.executor ?? db;
  if (input.amountCents <= 0) return null;

  // Idempotent per (scrap, order link): allows one order-applied row and one
  // unallocated remainder row for the same scrap submission.
  const orderLink =
    input.orderId != null && input.orderId !== ""
      ? eq(creditLedgerEntries.orderId, input.orderId)
      : isNull(creditLedgerEntries.orderId);

  const [existing] = await executor
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.scrapId, input.scrapId),
        eq(creditLedgerEntries.entryType, "scrap_credit"),
        orderLink,
      ),
    )
    .limit(1);
  if (existing) return existing;

  const account = await getOrCreateAccount(
    input.retailerId,
    input.workshopId,
    input.currency,
    executor,
  );

  const { entry } = await postEntry(
    {
      accountId: account.id,
      entryType: "scrap_credit",
      amountCents: -Math.trunc(input.amountCents),
      orderId: input.orderId ?? null,
      scrapId: input.scrapId,
      note: input.orderId
        ? `Scrap credit applied to order ${input.orderId.slice(0, 8)}`
        : `Scrap unallocated credit ${input.scrapId.slice(0, 8)}`,
      createdBy: input.createdBy,
    },
    executor,
  );
  return entry;
}

export async function orderOutstandingCents(
  orderId: string,
  executor: DbLike = db,
) {
  const rows = await executor
    .select({
      sum: sql<number>`coalesce(sum(${creditLedgerEntries.amountCents}), 0)`.mapWith(
        Number,
      ),
    })
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.orderId, orderId));

  return Number(rows[0]?.sum ?? 0);
}

function assertAccountAccess(
  user: User,
  account: typeof creditAccounts.$inferSelect,
) {
  if (user.role === "admin") return;
  if (user.role === "workshop" && account.workshopId === user.id) return;
  if (user.role === "retailer" && account.retailerId === user.id) return;
  throw forbidden("No access to this credit account");
}

async function computeAging(accountId: string): Promise<AgingBuckets> {
  const entries = await db
    .select()
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.accountId, accountId))
    .orderBy(creditLedgerEntries.createdAt);

  // Per-order net (positive = still owed)
  const byOrder = new Map<
    string,
    { net: number; firstInvoiceAt: Date | null }
  >();
  let unallocatedCredit = 0;

  for (const e of entries) {
    if (e.orderId) {
      const cur = byOrder.get(e.orderId) ?? {
        net: 0,
        firstInvoiceAt: null,
      };
      cur.net += e.amountCents;
      if (e.entryType === "invoice") {
        const d = toDate(e.createdAt);
        if (d && (!cur.firstInvoiceAt || d < cur.firstInvoiceAt)) {
          cur.firstInvoiceAt = d;
        }
      }
      byOrder.set(e.orderId, cur);
    } else if (e.amountCents < 0) {
      unallocatedCredit += -e.amountCents;
    } else {
      // adjustment without order — treat as current
      unallocatedCredit -= e.amountCents;
    }
  }

  const buckets: AgingBuckets = {
    currentCents: 0,
    days31to60Cents: 0,
    days61to90Cents: 0,
    days90PlusCents: 0,
    totalOutstandingCents: 0,
  };

  const open: { net: number; age: number }[] = [];
  for (const v of byOrder.values()) {
    if (v.net > 0) {
      open.push({
        net: v.net,
        age: v.firstInvoiceAt ? dayAge(v.firstInvoiceAt) : 0,
      });
    } else if (v.net < 0) {
      unallocatedCredit += -v.net;
    }
  }

  // Apply unallocated credits oldest-first
  open.sort((a, b) => b.age - a.age);
  for (const row of open) {
    let net = row.net;
    if (unallocatedCredit > 0) {
      const apply = Math.min(unallocatedCredit, net);
      net -= apply;
      unallocatedCredit -= apply;
    }
    if (net <= 0) continue;
    buckets.totalOutstandingCents += net;
    if (row.age <= 30) buckets.currentCents += net;
    else if (row.age <= 60) buckets.days31to60Cents += net;
    else if (row.age <= 90) buckets.days61to90Cents += net;
    else buckets.days90PlusCents += net;
  }

  // If credits exceed invoices, outstanding can be 0 while balance is negative
  return buckets;
}

async function enrichAccount(
  account: typeof creditAccounts.$inferSelect,
): Promise<CreditAccountSummary> {
  const [retailer] = await db
    .select()
    .from(users)
    .where(eq(users.id, account.retailerId))
    .limit(1);
  const [workshop] = await db
    .select()
    .from(users)
    .where(eq(users.id, account.workshopId))
    .limit(1);

  const aging = await computeAging(account.id);
  const available =
    account.creditLimitCents == null
      ? null
      : Math.max(0, account.creditLimitCents - Math.max(0, account.balanceCents));

  return {
    ...account,
    retailerBusinessName: retailer?.businessName ?? null,
    retailerFullName: retailer?.fullName ?? null,
    workshopBusinessName: workshop?.businessName ?? null,
    workshopFullName: workshop?.fullName ?? null,
    availableCreditCents: available,
    aging,
  };
}

/**
 * @deprecated Do not call from GET paths — invented payment/refund rows and
 * drifted balances (BUG-006). Kept for optional admin repair only; no-ops
 * missing invoices for active orders without fabricating settlements.
 */
export async function syncAccountFromOrders(accountId: string) {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");

  const partyOrders = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.retailerId, account.retailerId),
        eq(orders.workshopId, account.workshopId),
        eq(orders.currency, account.currency),
        inArray(orders.status, [
          "pending",
          "confirmed",
          "fulfilled",
          "completed",
        ]),
      ),
    );

  // Safe subset: ensure invoice rows exist for open orders only (idempotent).
  for (const order of partyOrders) {
    await postOrderInvoice({
      retailerId: order.retailerId,
      workshopId: order.workshopId,
      currency: order.currency as AppCurrency,
      orderId: order.id,
      totalCents: order.totalCents,
    });
  }

  const [fresh] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  return fresh!;
}

export async function listAccounts(user: User) {
  const party =
    user.role === "admin"
      ? undefined
      : user.role === "workshop"
        ? eq(creditAccounts.workshopId, user.id)
        : eq(creditAccounts.retailerId, user.id);

  // Create empty accounts for order pairs — does not rewrite ledger history.
  await ensureAccountsFromOrders(user);

  const rows = await db
    .select()
    .from(creditAccounts)
    .where(party)
    .orderBy(desc(creditAccounts.updatedAt));

  const summaries: CreditAccountSummary[] = [];
  for (const row of rows) {
    summaries.push(await enrichAccount(row));
  }
  return summaries;
}

async function ensureAccountsFromOrders(user: User) {
  const party =
    user.role === "admin"
      ? undefined
      : user.role === "workshop"
        ? eq(orders.workshopId, user.id)
        : eq(orders.retailerId, user.id);

  const rows = await db
    .select({
      retailerId: orders.retailerId,
      workshopId: orders.workshopId,
      currency: orders.currency,
    })
    .from(orders)
    .where(party);

  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.retailerId}:${r.workshopId}:${r.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await getOrCreateAccount(
      r.retailerId,
      r.workshopId,
      r.currency as AppCurrency,
    );
  }
}

export async function getAccountDetail(user: User, accountId: string) {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");
  assertAccountAccess(user, account);

  const summary = await enrichAccount(account);
  const entries = await db
    .select()
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.accountId, accountId))
    .orderBy(desc(creditLedgerEntries.createdAt))
    .limit(200);

  const openOrders = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.retailerId, account.retailerId),
        eq(orders.workshopId, account.workshopId),
        eq(orders.currency, account.currency),
        inArray(orders.paymentStatus, ["unpaid", "partial"]),
        inArray(orders.status, [
          "pending",
          "confirmed",
          "fulfilled",
          "completed",
        ]),
      ),
    )
    .orderBy(desc(orders.placedAt));

  const openWithOutstanding = [];
  for (const o of openOrders) {
    const outstanding = await orderOutstandingCents(o.id);
    openWithOutstanding.push({
      ...o,
      outstandingCents: Math.max(0, outstanding),
    });
  }

  return {
    account: summary,
    entries,
    openOrders: openWithOutstanding,
  };
}

/** Record a settlement payment (optionally allocated to an order). */
export async function recordSettlement(
  user: User,
  accountId: string,
  input: {
    amountMajor: number;
    orderId?: string;
    note?: string;
    idempotencyKey: string;
  },
) {
  assertVerified(user);
  if (user.role !== "workshop" && user.role !== "admin") {
    throw forbidden("Only the workshop can record a settlement");
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) throw badRequest("Idempotency-Key header is required");

  const amountCents = Math.round(Number(input.amountMajor) * 100);
  if (!(amountCents > 0)) throw badRequest("Amount must be > 0");

  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");
  assertAccountAccess(user, account);

  if (input.orderId) {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    if (!order) throw notFound("Order not found");
    if (
      order.retailerId !== account.retailerId ||
      order.workshopId !== account.workshopId ||
      order.currency !== account.currency
    ) {
      throw badRequest("Order does not belong to this credit account");
    }
    if (order.status === "cancelled") {
      throw badRequest("Cannot settle a cancelled order");
    }

    return db.transaction(async (tx) => {
      const exec = tx as unknown as typeof db;
      const entry = await postOrderPayment({
        retailerId: account.retailerId,
        workshopId: account.workshopId,
        currency: account.currency as AppCurrency,
        orderId: order.id,
        amountCents,
        createdBy: user.id,
        note: input.note,
        idempotencyKey,
        executor: exec,
      });

      const outstanding = await orderOutstandingCents(order.id, exec);
      await exec
        .update(orders)
        .set({
          paymentStatus: outstanding <= 0 ? "paid" : "partial",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      const [fresh] = await exec
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.id, accountId))
        .limit(1);

      return { entry, account: fresh! };
    });
  }

  // Unallocated payment / account-level settlement
  return db.transaction(async (tx) => {
    const exec = tx as unknown as typeof db;
    const replay = await findIdempotentEntry(accountId, idempotencyKey, exec);
    if (replay) {
      if (replay.orderId) throw conflict("Idempotency-Key was already used");
      const [fresh] = await exec
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.id, accountId))
        .limit(1);
      return { entry: replay, account: fresh! };
    }
    await exec
      .update(creditAccounts)
      .set({ updatedAt: new Date() })
      .where(eq(creditAccounts.id, accountId));
    const [locked] = await exec
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, accountId))
      .limit(1);
    if (!locked) throw notFound("Credit account not found");
    if (locked.balanceCents <= 0) {
      throw badRequest("Nothing outstanding on this account");
    }
    if (amountCents > locked.balanceCents) {
      throw badRequest("Settlement exceeds the open balance");
    }
    const { entry } = await postEntry(
      {
        accountId,
        entryType: "payment",
        amountCents: -amountCents,
        note: input.note?.trim() || "Account settlement",
        idempotencyKey,
        createdBy: user.id,
      },
      exec,
    );
    const [fresh] = await exec
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, accountId))
      .limit(1);
    return { entry, account: fresh! };
  });
}

export async function setCreditLimit(
  user: User,
  accountId: string,
  creditLimitMajor: number | null,
) {
  assertVerified(user);
  if (user.role !== "workshop" && user.role !== "admin") {
    throw forbidden("Only workshops can set credit limits");
  }

  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Credit account not found");
  assertAccountAccess(user, account);

  let limitCents: number | null = null;
  if (creditLimitMajor != null) {
    if (!(creditLimitMajor >= 0) || !Number.isFinite(creditLimitMajor)) {
      throw badRequest("Credit limit must be >= 0");
    }
    limitCents = Math.round(creditLimitMajor * 100);
  }

  const [updated] = await db
    .update(creditAccounts)
    .set({ creditLimitCents: limitCents, updatedAt: new Date() })
    .where(eq(creditAccounts.id, accountId))
    .returning();

  return enrichAccount(updated);
}

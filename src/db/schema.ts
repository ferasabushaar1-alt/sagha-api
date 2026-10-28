import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
};

export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    phone: text("phone").unique(),
    passwordHash: text("password_hash"),
    authUserId: text("auth_user_id").unique(),
    role: text("role").notNull(),
    fullName: text("full_name").notNull(),
    businessName: text("business_name"),
    country: text("country").notNull().default("SY"),
    city: text("city"),
    address: text("address"),
    verificationStatus: text("verification_status").notNull().default("pending"),
    licenseNumber: text("license_number"),
    taxId: text("tax_id"),
    idDocumentPath: text("id_document_path"),
    licenseDocumentPath: text("license_document_path"),
    avatarPath: text("avatar_path"),
    verificationNotes: text("verification_notes"),
    rejectionReason: text("rejection_reason"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    verifiedBy: text("verified_by"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /** Incremented on logout and suspension so older JWTs stop matching. */
    sessionVersion: integer("session_version").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    check(
      "users_role_check",
      sql`${t.role} in ('workshop', 'retailer', 'admin')`,
    ),
    check(
      "users_verification_status_check",
      sql`${t.verificationStatus} in ('pending', 'verified', 'rejected', 'suspended')`,
    ),
    check("users_country_check", sql`${t.country} in ('SY', 'LB')`),
  ],
);

/** One-time password reset codes. The raw token is emailed; only the hash is stored. */
export const passwordResets = sqliteTable("password_resets", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const products = sqliteTable(
  "products",
  {
    id: id(),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    description: text("description"),
    descriptionAr: text("description_ar"),
    sku: text("sku"),
    category: text("category").notNull().default("other"),
    karat: integer("karat").notNull(),
    weightGrams: text("weight_grams").notNull(),
    makingChargeCents: integer("making_charge_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    stockQty: integer("stock_qty").notNull().default(0),
    imagePath: text("image_path"),
    status: text("status").notNull().default("draft"),
    ...timestamps,
  },
  (t) => [
    unique("products_workshop_sku_unique").on(t.workshopId, t.sku),
    check("products_karat_check", sql`${t.karat} in (18, 21)`),
    check("products_making_check", sql`${t.makingChargeCents} >= 0`),
    check("products_currency_check", sql`${t.currency} in ('USD', 'SYP', 'LBP')`),
    check("products_stock_check", sql`${t.stockQty} >= 0`),
    check(
      "products_status_check",
      sql`${t.status} in ('draft', 'active', 'archived')`,
    ),
    check(
      "products_category_check",
      sql`${t.category} in ('rings', 'chains', 'earrings', 'bracelets', 'necklaces', 'bangles', 'pendants', 'sets', 'other')`,
    ),
  ],
);

/** Volume breaks for making charges (per-unit fee by quantity band). */
export const productMakingTiers = sqliteTable(
  "product_making_tiers",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    minQty: integer("min_qty").notNull(),
    /** null = open-ended (e.g. 21+) */
    maxQty: integer("max_qty"),
    makingChargeCents: integer("making_charge_cents").notNull(),
    ...timestamps,
  },
  (t) => [
    check("product_making_tiers_min_qty_check", sql`${t.minQty} >= 1`),
    check(
      "product_making_tiers_max_qty_check",
      sql`${t.maxQty} is null or ${t.maxQty} >= ${t.minQty}`,
    ),
    check(
      "product_making_tiers_charge_check",
      sql`${t.makingChargeCents} >= 0`,
    ),
  ],
);

export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    currency: text("currency").notNull().default("USD"),
    /**
     * Major units of order currency per 1 USD, locked at checkout
     * (USD=1, SYP/LBP = admin FX). Stored as text decimal.
     */
    fxUnitsPerUsd: text("fx_units_per_usd").notNull().default("1"),
    goldSpotPriceCentsPerGram: integer("gold_spot_price_cents_per_gram").notNull(),
    /** Immutable snapshot of the spot used to price this order. */
    spotLockedAt: integer("spot_locked_at", { mode: "timestamp_ms" }),
    spotRateId: text("spot_rate_id"),
    spotSource: text("spot_source"),
    spotOfficial: integer("spot_official", { mode: "boolean" }),
    spotVerificationImagePath: text("spot_verification_image_path"),
    goldValueCents: integer("gold_value_cents").notNull().default(0),
    makingChargesCents: integer("making_charges_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes"),
    paymentProofPath: text("payment_proof_path"),
    /**
     * Client Idempotency-Key for POST /orders (unique per retailer).
     * SQLite UNIQUE allows multiple NULLs for legacy/unkeyed clients.
     */
    idempotencyKey: text("idempotency_key"),
    placedAt: integer("placed_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    unique("orders_retailer_idempotency_unique").on(
      t.retailerId,
      t.idempotencyKey,
    ),
    check(
      "orders_status_check",
      sql`${t.status} in ('pending', 'confirmed', 'fulfilled', 'completed', 'cancelled')`,
    ),
    check(
      "orders_payment_status_check",
      sql`${t.paymentStatus} in ('unpaid', 'partial', 'paid', 'refunded')`,
    ),
    check("orders_currency_check", sql`${t.currency} in ('USD', 'SYP', 'LBP')`),
    check("orders_spot_check", sql`${t.goldSpotPriceCentsPerGram} > 0`),
    check("orders_distinct_parties", sql`${t.retailerId} <> ${t.workshopId}`),
  ],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(),
    karat: integer("karat").notNull(),
    unitWeightGrams: text("unit_weight_grams").notNull(),
    quantity: integer("quantity").notNull(),
    purityFactor: text("purity_factor").notNull(),
    unitGoldValueCents: integer("unit_gold_value_cents").notNull(),
    unitMakingChargeCents: integer("unit_making_charge_cents").notNull(),
    /** Snapshot of the volume tier applied at checkout (if any). */
    makingTierMinQty: integer("making_tier_min_qty"),
    makingTierMaxQty: integer("making_tier_max_qty"),
    lineGoldValueCents: integer("line_gold_value_cents").notNull(),
    lineMakingChargeCents: integer("line_making_charge_cents").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("order_items_order_product_unique").on(t.orderId, t.productId),
    check("order_items_karat_check", sql`${t.karat} in (18, 21)`),
    check("order_items_qty_check", sql`${t.quantity} > 0`),
  ],
);

export const returns = sqliteTable(
  "returns",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("requested"),
    reason: text("reason").notNull(),
    rejectionReason: text("rejection_reason"),
    currency: text("currency").notNull().default("USD"),
    refundCents: integer("refund_cents").notNull().default(0),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }),
    refundedAt: integer("refunded_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    check(
      "returns_status_check",
      sql`${t.status} in ('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled')`,
    ),
    check("returns_currency_check", sql`${t.currency} in ('USD', 'SYP', 'LBP')`),
    check("returns_distinct_parties", sql`${t.retailerId} <> ${t.workshopId}`),
  ],
);

export const returnItems = sqliteTable(
  "return_items",
  {
    id: id(),
    returnId: text("return_id")
      .notNull()
      .references(() => returns.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    weightGrams: text("weight_grams").notNull(),
    refundCents: integer("refund_cents").notNull().default(0),
    conditionNotes: text("condition_notes"),
    ...timestamps,
  },
  (t) => [
    unique("return_items_return_order_item_unique").on(t.returnId, t.orderItemId),
    check("return_items_qty_check", sql`${t.quantity} > 0`),
  ],
);

/** Retailer ↔ workshop messaging threads (optionally tied to a product or order). */
export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    productId: text("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    check(
      "conversations_distinct_parties",
      sql`${t.retailerId} <> ${t.workshopId}`,
    ),
  ],
);

/** Per-house cursor so a thread's unread mark follows the account, not one phone. */
export const conversationReads = sqliteTable(
  "conversation_reads",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const messages = sqliteTable("messages", {
  id: id(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  senderId: text("sender_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  messageText: text("message_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Admin-published official gold spot (with optional verification photo). */
export const goldSpotRates = sqliteTable("gold_spot_rates", {
  id: id(),
  spotCentsPerGramFine: integer("spot_cents_per_gram_fine").notNull(),
  currency: text("currency").notNull().default("USD"),
  verificationImagePath: text("verification_image_path"),
  notes: text("notes"),
  setBy: text("set_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Scrap / كسر desk — retailer submits old gold; workshop assays & quotes.
 * Settlement can be cash or credit against an open wholesale order.
 */
export const scrapSubmissions = sqliteTable(
  "scrap_submissions",
  {
    id: id(),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("submitted"),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    currency: text("currency").notNull().default("USD"),
    description: text("description"),
    notes: text("notes"),
    /** Retailer estimate */
    estimatedWeightGrams: text("estimated_weight_grams").notNull(),
    estimatedKarat: integer("estimated_karat").notNull(),
    /** Workshop assay (set on quote) */
    assayedWeightGrams: text("assayed_weight_grams"),
    assayedKarat: integer("assayed_karat"),
    /** Spot lock at quote time */
    goldSpotPriceCentsPerGram: integer("gold_spot_price_cents_per_gram"),
    spotLockedAt: integer("spot_locked_at", { mode: "timestamp_ms" }),
    spotRateId: text("spot_rate_id"),
    spotSource: text("spot_source"),
    spotOfficial: integer("spot_official", { mode: "boolean" }),
    /** Quote amounts */
    meltValueCents: integer("melt_value_cents"),
    refiningFeeCents: integer("refining_fee_cents"),
    netValueCents: integer("net_value_cents"),
    quoteNotes: text("quote_notes"),
    rejectionReason: text("rejection_reason"),
    /** Optional credit against wholesale order (same parties) */
    creditOrderId: text("credit_order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    quotedAt: integer("quoted_at", { mode: "timestamp_ms" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    settlementIdempotencyKey: text("settlement_idempotency_key"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    check(
      "scrap_status_check",
      sql`${t.status} in ('submitted', 'quoted', 'accepted', 'declined', 'rejected', 'settled', 'cancelled')`,
    ),
    check(
      "scrap_payment_status_check",
      sql`${t.paymentStatus} in ('unpaid', 'paid', 'credited')`,
    ),
    check("scrap_currency_check", sql`${t.currency} in ('USD', 'SYP', 'LBP')`),
    check(
      "scrap_estimated_karat_check",
      sql`${t.estimatedKarat} in (14, 18, 21, 22, 24)`,
    ),
    check(
      "scrap_assayed_karat_check",
      sql`${t.assayedKarat} is null or ${t.assayedKarat} in (14, 18, 21, 22, 24)`,
    ),
    check("scrap_distinct_parties", sql`${t.retailerId} <> ${t.workshopId}`),
  ],
);

/**
 * Credit account per retailer↔workshop↔currency relationship.
 * balanceCents > 0 ⇒ retailer owes workshop (accounts receivable).
 */
export const creditAccounts = sqliteTable(
  "credit_accounts",
  {
    id: id(),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currency: text("currency").notNull().default("USD"),
    /** null = no formal limit */
    creditLimitCents: integer("credit_limit_cents"),
    /** Running AR balance (retailer debt). */
    balanceCents: integer("balance_cents").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("credit_accounts_pair_currency_unique").on(
      t.retailerId,
      t.workshopId,
      t.currency,
    ),
    check("credit_accounts_currency_check", sql`${t.currency} in ('USD', 'SYP', 'LBP')`),
    check("credit_accounts_distinct_parties", sql`${t.retailerId} <> ${t.workshopId}`),
  ],
);

/**
 * Immutable ledger postings. Signed amountCents from workshop AR view:
 * positive = retailer owes more; negative = payment/credit reducing debt.
 */
export const creditLedgerEntries = sqliteTable(
  "credit_ledger_entries",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id, { onDelete: "cascade" }),
    entryType: text("entry_type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    balanceAfterCents: integer("balance_after_cents").notNull(),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    scrapId: text("scrap_id").references(() => scrapSubmissions.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    idempotencyKey: text("idempotency_key"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check(
      "credit_ledger_entry_type_check",
      sql`${t.entryType} in ('invoice', 'payment', 'scrap_credit', 'reversal', 'adjustment', 'refund')`,
    ),
    check("credit_ledger_amount_nonzero", sql`${t.amountCents} <> 0`),
  ],
);

/**
 * Admin FX: major units of currency per 1 USD (SYP, LBP).
 * USD is always 1 and not stored as a row.
 */
export const fxRates = sqliteTable(
  "fx_rates",
  {
    id: id(),
    currency: text("currency").notNull(),
    /** Decimal string, e.g. "15000" SYP per 1 USD */
    unitsPerUsd: text("units_per_usd").notNull(),
    notes: text("notes"),
    setBy: text("set_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("fx_rates_currency_check", sql`${t.currency} in ('SYP', 'LBP')`),
  ],
);

/** Stolen & lost gold registry. Contact fields are never part of the public DTO. */
export const stolenReports = sqliteTable(
  "stolen_reports",
  {
    id: id(),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    weightGrams: text("weight_grams").notNull(),
    karat: integer("karat").notNull(),
    photoPath: text("photo_path").notNull(),
    /** Basename only. Served through an authenticated route, not /media. */
    invoicePath: text("invoice_path"),
    invoiceReference: text("invoice_reference"),
    incidentDate: text("incident_date").notNull(),
    country: text("country").notNull(),
    city: text("city").notNull(),
    location: text("location"),
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone").notNull(),
    contactEmail: text("contact_email").notNull(),
    status: text("status").notNull().default("active"),
    recoveredAt: integer("recovered_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    check("stolen_reports_kind_check", sql`${t.kind} in ('stolen', 'lost')`),
    check(
      "stolen_reports_karat_check",
      sql`${t.karat} in (14, 18, 21, 22, 24)`,
    ),
    check("stolen_reports_country_check", sql`${t.country} in ('SY', 'LB')`),
    check(
      "stolen_reports_status_check",
      sql`${t.status} in ('active', 'recovered')`,
    ),
  ],
);

/** One row per workshop, retailer, or admin who should see a report or a scrap match. */
export const stolenAlerts = sqliteTable(
  "stolen_alerts",
  {
    id: id(),
    reportId: text("report_id")
      .notNull()
      .references(() => stolenReports.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scrapId: text("scrap_id").references(() => scrapSubmissions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("stolen_alerts_kind_check", sql`${t.kind} in ('registry', 'scrap')`),
  ],
);

/**
 * Retained copies of resolved records. Source rows stay on the books.
 * Nothing in this table is deleted through the API; retentionUntil is the audit horizon.
 */
export const archives = sqliteTable(
  "archives",
  {
    id: id(),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    country: text("country"),
    city: text("city"),
    currency: text("currency"),
    amountCents: integer("amount_cents"),
    weightGrams: text("weight_grams"),
    karat: integer("karat"),
    status: text("status").notNull(),
    partyA: text("party_a"),
    partyB: text("party_b"),
    reason: text("reason").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    archivedBy: text("archived_by").references(() => users.id, {
      onDelete: "set null",
    }),
    retentionUntil: integer("retention_until", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    unique("archives_kind_source_unique").on(t.kind, t.sourceId),
    check(
      "archives_kind_check",
      sql`${t.kind} in ('stolen_report', 'scrap_intake', 'invoice', 'settlement')`,
    ),
    check(
      "archives_reason_check",
      sql`${t.reason} in ('recovered', 'matched', 'completed', 'settled', 'manual')`,
    ),
  ],
);

/** Audit of who opened an owner's phone and email. */
export const stolenContactOpens = sqliteTable("stolen_contact_opens", {
  id: id(),
  reportId: text("report_id")
    .notNull()
    .references(() => stolenReports.id, { onDelete: "cascade" }),
  openedBy: text("opened_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** contact = owner details revealed; invoice = private proof file opened */
  action: text("action").notNull().default("contact"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductMakingTier = typeof productMakingTiers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type FxRate = typeof fxRates.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Return = typeof returns.$inferSelect;
export type ReturnItem = typeof returnItems.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type GoldSpotRate = typeof goldSpotRates.$inferSelect;
export type ScrapSubmission = typeof scrapSubmissions.$inferSelect;
export type CreditAccount = typeof creditAccounts.$inferSelect;
export type CreditLedgerEntry = typeof creditLedgerEntries.$inferSelect;
export type StolenReport = typeof stolenReports.$inferSelect;
export type ArchiveRecord = typeof archives.$inferSelect;

export const NOTIFICATION_TYPES = [
  "STOLEN_ALERT",
  "NEW_MEMBER",
  "PROFILE_UPDATE",
  "CREDIT_WARNING",
  "ORDER_STATUS",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * recipient_id is a user id, or the literal "broadcast" for every matching audience.
 * Broadcast rows stay unread on the row itself; each house marks them in notification_reads.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    recipientId: text("recipient_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    titleAr: text("title_ar"),
    messageAr: text("message_ar"),
    referenceId: text("reference_id"),
    referenceKind: text("reference_kind"),
    /** all | trade (workshop, retailer, admin) | admin */
    audience: text("audience").notNull().default("all"),
    actorId: text("actor_id"),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check(
      "notifications_type_check",
      sql`${t.type} in ('STOLEN_ALERT', 'NEW_MEMBER', 'PROFILE_UPDATE', 'CREDIT_WARNING', 'ORDER_STATUS')`,
    ),
    check(
      "notifications_audience_check",
      sql`${t.audience} in ('all', 'trade', 'admin')`,
    ),
    check(
      "notifications_reference_kind_check",
      sql`${t.referenceKind} is null or ${t.referenceKind} in ('report', 'user', 'order', 'scrap', 'account')`,
    ),
  ],
);

export const notificationReads = sqliteTable(
  "notification_reads",
  {
    notificationId: text("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.userId] }),
  ],
);

/** A merchant inquiry delivered to platform administrators. */
export const supportInquiries = sqliteTable("support_inquiries", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  message: text("message").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Notification = typeof notifications.$inferSelect;
export type SupportInquiry = typeof supportInquiries.$inferSelect;

export type UserRole = "workshop" | "retailer" | "admin";
export type VerificationStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "suspended";
export type ScrapKarat = 14 | 18 | 21 | 22 | 24;
export type ScrapStatus =
  | "submitted"
  | "quoted"
  | "accepted"
  | "declined"
  | "rejected"
  | "settled"
  | "cancelled";
export type CreditEntryType =
  | "invoice"
  | "payment"
  | "scrap_credit"
  | "reversal"
  | "adjustment"
  | "refund";

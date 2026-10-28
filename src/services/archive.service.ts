import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  archives,
  creditAccounts,
  creditLedgerEntries,
  orders,
  scrapSubmissions,
  stolenAlerts,
  stolenReports,
  type CreditAccount,
  type CreditLedgerEntry,
  type Order,
  type ScrapSubmission,
  type StolenReport,
  type User,
} from "../db/schema.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { assertVerified } from "../lib/verification.js";

const KINDS = ["stolen_report", "scrap_intake", "invoice", "settlement"] as const;
export type ArchiveKind = (typeof KINDS)[number];

const RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 500;

export type ArchiveView = {
  id: string;
  kind: string;
  sourceId: string;
  title: string;
  summary: string;
  country: string | null;
  city: string | null;
  currency: string | null;
  amountCents: number | null;
  weightGrams: string | null;
  karat: number | null;
  status: string;
  reason: string;
  occurredAt: Date;
  archivedAt: Date;
  retentionUntil: Date;
};

function clip(value: string, max: number) {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function likeTerm(raw: string | undefined) {
  const cleaned = raw?.trim().toLowerCase().replace(/[%_]/g, "") ?? "";
  return cleaned ? `%${cleaned}%` : null;
}

function present(row: typeof archives.$inferSelect): ArchiveView {
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.sourceId,
    title: row.title,
    summary: row.summary,
    country: row.country,
    city: row.city,
    currency: row.currency,
    amountCents: row.amountCents,
    weightGrams: row.weightGrams,
    karat: row.karat,
    status: row.status,
    reason: row.reason,
    occurredAt: row.occurredAt,
    archivedAt: row.archivedAt,
    retentionUntil: row.retentionUntil,
  };
}

async function putArchive(values: {
  kind: ArchiveKind;
  sourceId: string;
  title: string;
  summary: string;
  country?: string | null;
  city?: string | null;
  currency?: string | null;
  amountCents?: number | null;
  weightGrams?: string | null;
  karat?: number | null;
  status: string;
  partyA?: string | null;
  partyB?: string | null;
  reason: "recovered" | "matched" | "completed" | "settled" | "manual";
  occurredAt: Date;
  archivedBy: string | null;
}) {
  const now = new Date();
  const inserted = await db
    .insert(archives)
    .values({
      ...values,
      country: values.country ?? null,
      city: values.city ?? null,
      currency: values.currency ?? null,
      amountCents: values.amountCents ?? null,
      weightGrams: values.weightGrams ?? null,
      karat: values.karat ?? null,
      partyA: values.partyA ?? null,
      partyB: values.partyB ?? null,
      archivedAt: now,
      archivedBy: values.archivedBy,
      retentionUntil: new Date(now.getTime() + RETENTION_MS),
    })
    .onConflictDoNothing({ target: [archives.kind, archives.sourceId] })
    .returning({ id: archives.id });
  return inserted.length > 0;
}

export async function rememberArchive(work: Promise<unknown>) {
  try {
    await work;
  } catch (err) {
    console.error("archive failed", err);
  }
}

export async function archiveStolenReport(
  row: StolenReport,
  archivedBy: string | null,
  reason: "recovered" | "manual" = "recovered",
) {
  if (row.status !== "recovered") return false;
  return putArchive({
    kind: "stolen_report",
    sourceId: row.id,
    title: clip(row.description, 120),
    summary: `${row.karat}K · ${row.weightGrams} g · ${row.city}`,
    country: row.country,
    city: row.city,
    weightGrams: row.weightGrams,
    karat: row.karat,
    status: "recovered",
    partyA: row.reporterId,
    reason,
    occurredAt: row.recoveredAt ?? row.updatedAt,
    archivedBy,
  });
}

export async function archiveMatchedScrap(
  scrap: ScrapSubmission,
  archivedBy: string | null,
  reason: "matched" | "manual" = "matched",
) {
  if (scrap.status !== "settled") return false;
  const [match] = await db
    .select({ id: stolenAlerts.id })
    .from(stolenAlerts)
    .where(eq(stolenAlerts.scrapId, scrap.id))
    .limit(1);
  if (!match) return false;
  const weight = scrap.assayedWeightGrams ?? scrap.estimatedWeightGrams;
  const karat = scrap.assayedKarat ?? scrap.estimatedKarat;
  return putArchive({
    kind: "scrap_intake",
    sourceId: scrap.id,
    title: clip(scrap.description?.trim() || "Matched scrap intake", 120),
    summary: `${karat}K · ${weight} g · ${scrap.currency}`,
    currency: scrap.currency,
    amountCents: scrap.netValueCents,
    weightGrams: weight,
    karat,
    status: "settled",
    partyA: scrap.retailerId,
    partyB: scrap.workshopId,
    reason,
    occurredAt: scrap.settledAt ?? scrap.updatedAt,
    archivedBy,
  });
}

export async function archiveCompletedInvoice(
  order: Order,
  archivedBy: string | null,
  reason: "completed" | "manual" = "completed",
) {
  if (order.status !== "completed") return false;
  return putArchive({
    kind: "invoice",
    sourceId: order.id,
    title: `Invoice ${order.id.slice(0, 8)}`,
    summary: `${order.currency} · ${order.totalCents} minor units`,
    currency: order.currency,
    amountCents: order.totalCents,
    status: "completed",
    partyA: order.retailerId,
    partyB: order.workshopId,
    reason,
    occurredAt: order.completedAt ?? order.updatedAt,
    archivedBy,
  });
}

export async function archiveSettlement(
  entry: CreditLedgerEntry,
  account: CreditAccount,
  archivedBy: string | null,
  reason: "settled" | "manual" = "settled",
) {
  if (entry.entryType !== "payment") return false;
  return putArchive({
    kind: "settlement",
    sourceId: entry.id,
    title: "Credit settlement",
    summary: clip(entry.note?.trim() || account.currency, 180),
    currency: account.currency,
    amountCents: Math.abs(entry.amountCents),
    status: "settled",
    partyA: account.retailerId,
    partyB: account.workshopId,
    reason,
    occurredAt: entry.createdAt,
    archivedBy,
  });
}

function canSee(user: User, row: { kind: string; partyA: string | null; partyB: string | null; country: string | null }) {
  if (user.role === "admin") return true;
  if (row.partyA === user.id || row.partyB === user.id) return true;
  return row.kind === "stolen_report" && row.country === user.country;
}

export async function listArchives(
  user: User,
  filters: {
    kind?: ArchiveKind;
    q?: string;
    country?: "SY" | "LB";
    from?: string;
    to?: string;
    sort?: "newest" | "heaviest";
  },
) {
  assertVerified(user);
  const conditions = [];
  if (user.role !== "admin") {
    conditions.push(
      or(
        eq(archives.partyA, user.id),
        eq(archives.partyB, user.id),
        and(eq(archives.kind, "stolen_report"), eq(archives.country, user.country)),
      ),
    );
  }
  if (filters.kind) conditions.push(eq(archives.kind, filters.kind));
  if (filters.country) conditions.push(eq(archives.country, filters.country));
  const term = likeTerm(filters.q);
  if (term) {
    conditions.push(
      sql`(lower(${archives.title}) like ${term} or lower(${archives.summary}) like ${term} or lower(coalesce(${archives.city}, '')) like ${term})`,
    );
  }
  if (filters.from) {
    const from = Date.parse(`${filters.from}T00:00:00Z`);
    if (!Number.isFinite(from)) throw badRequest("From date is invalid");
    conditions.push(gte(archives.occurredAt, new Date(from)));
  }
  if (filters.to) {
    const to = Date.parse(`${filters.to}T23:59:59Z`);
    if (!Number.isFinite(to)) throw badRequest("To date is invalid");
    conditions.push(lte(archives.occurredAt, new Date(to)));
  }
  const order =
    filters.sort === "heaviest"
      ? [sql`CAST(coalesce(${archives.weightGrams}, '0') AS REAL) DESC`, desc(archives.archivedAt)]
      : [desc(archives.archivedAt)];
  const rows = await db
    .select()
    .from(archives)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(...order)
    .limit(200);
  return rows.filter((row) => canSee(user, row)).map(present);
}

export async function archiveSource(
  user: User,
  kind: ArchiveKind,
  sourceId: string,
) {
  assertVerified(user);
  if (kind === "stolen_report") {
    const [row] = await db
      .select()
      .from(stolenReports)
      .where(eq(stolenReports.id, sourceId))
      .limit(1);
    if (!row) throw notFound("Registry report not found");
    if (user.role !== "admin" && user.id !== row.reporterId) {
      throw forbidden("Only the reporter or an admin can archive this report");
    }
    if (row.status !== "recovered") {
      throw badRequest("Only a recovered report can be archived");
    }
    await archiveStolenReport(row, user.id, "manual");
  } else if (kind === "scrap_intake") {
    const [row] = await db
      .select()
      .from(scrapSubmissions)
      .where(eq(scrapSubmissions.id, sourceId))
      .limit(1);
    if (!row) throw notFound("Scrap intake not found");
    if (
      user.role !== "admin" &&
      user.id !== row.retailerId &&
      user.id !== row.workshopId
    ) {
      throw forbidden("Not a party to this scrap intake");
    }
    if (row.status !== "settled") {
      throw badRequest("Only a settled intake can be archived");
    }
    const [match] = await db
      .select({ id: stolenAlerts.id })
      .from(stolenAlerts)
      .where(eq(stolenAlerts.scrapId, row.id))
      .limit(1);
    if (!match) {
      throw badRequest("Only an intake that matched the registry can be archived");
    }
    await archiveMatchedScrap(row, user.id, "manual");
  } else if (kind === "invoice") {
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, sourceId))
      .limit(1);
    if (!row) throw notFound("Invoice not found");
    if (
      user.role !== "admin" &&
      user.id !== row.retailerId &&
      user.id !== row.workshopId
    ) {
      throw forbidden("Not a party to this invoice");
    }
    if (row.status !== "completed") {
      throw badRequest("Only a completed invoice can be archived");
    }
    await archiveCompletedInvoice(row, user.id, "manual");
  } else {
    const [entry] = await db
      .select()
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.id, sourceId))
      .limit(1);
    if (!entry) throw notFound("Settlement not found");
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, entry.accountId))
      .limit(1);
    if (!account) throw notFound("Credit account not found");
    if (
      user.role !== "admin" &&
      user.id !== account.retailerId &&
      user.id !== account.workshopId
    ) {
      throw forbidden("Not a party to this settlement");
    }
    if (entry.entryType !== "payment") {
      throw badRequest("Only a credit settlement can be archived");
    }
    await archiveSettlement(entry, account, user.id, "manual");
  }

  const [saved] = await db
    .select()
    .from(archives)
    .where(and(eq(archives.kind, kind), eq(archives.sourceId, sourceId)))
    .limit(1);
  if (!saved || !canSee(user, saved)) throw notFound("Archive record not found");
  return present(saved);
}

export async function collectResolved(user: User) {
  assertVerified(user);
  if (user.role !== "admin") throw forbidden("Only an admin can collect the archive");

  const reports = await db
    .select()
    .from(stolenReports)
    .where(eq(stolenReports.status, "recovered"))
    .limit(SWEEP_LIMIT);
  let stolen = 0;
  for (const row of reports) {
    if (await archiveStolenReport(row, user.id)) stolen += 1;
  }

  const scraps = await db
    .select()
    .from(scrapSubmissions)
    .where(eq(scrapSubmissions.status, "settled"))
    .limit(SWEEP_LIMIT);
  let scrap = 0;
  for (const row of scraps) {
    if (await archiveMatchedScrap(row, user.id)) scrap += 1;
  }

  const completed = await db
    .select()
    .from(orders)
    .where(eq(orders.status, "completed"))
    .limit(SWEEP_LIMIT);
  let invoices = 0;
  for (const row of completed) {
    if (await archiveCompletedInvoice(row, user.id)) invoices += 1;
  }

  const payments = await db
    .select({
      entry: creditLedgerEntries,
      account: creditAccounts,
    })
    .from(creditLedgerEntries)
    .innerJoin(creditAccounts, eq(creditLedgerEntries.accountId, creditAccounts.id))
    .where(eq(creditLedgerEntries.entryType, "payment"))
    .limit(SWEEP_LIMIT);
  let settlements = 0;
  for (const row of payments) {
    if (await archiveSettlement(row.entry, row.account, user.id)) settlements += 1;
  }

  return { stolen, scrap, invoices, settlements };
}

export function isArchiveKind(value: string): value is ArchiveKind {
  return (KINDS as readonly string[]).includes(value);
}

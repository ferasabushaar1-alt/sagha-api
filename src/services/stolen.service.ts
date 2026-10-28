import fs from "node:fs";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  stolenAlerts,
  stolenContactOpens,
  stolenReports,
  users,
  type ScrapKarat,
  type StolenReport,
  type User,
} from "../db/schema.js";
import { badRequest, forbidden, notFound, tooMany } from "../lib/errors.js";
import { pushStolen } from "../lib/stolen-broadcast.js";
import {
  archiveStolenReport,
  rememberArchive,
} from "./archive.service.js";
import {
  notifyScrapStolenMatch,
  notifyStolenRecovered,
  notifyStolenRegistry,
  safeNotify,
} from "./notifications.service.js";
import {
  stolenInvoiceFile,
  stolenPhotoPublicPath,
} from "../lib/stolenUpload.js";

const KARATS: ScrapKarat[] = [14, 18, 21, 22, 24];

export type CreateStolenInput = {
  kind: "stolen" | "lost";
  description: string;
  weightGrams: number;
  karat: number;
  incidentDate: string;
  country: "SY" | "LB";
  city: string;
  location?: string;
  invoiceReference?: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

export type StolenPublic = {
  id: string;
  kind: "stolen" | "lost";
  description: string;
  weightGrams: string;
  karat: number;
  photoPath: string;
  hasInvoice: boolean;
  incidentDate: string;
  country: string;
  city: string;
  location: string | null;
  status: "active" | "recovered";
  createdAt: Date;
};

export type StolenMemberView = StolenPublic & {
  invoiceReference: string | null;
  isOwner: boolean;
};

export type StolenMatch = {
  id: string;
  kind: string;
  description: string;
  karat: number;
  weightGrams: string;
  city: string;
  country: string;
};

function assertKarat(value: number): ScrapKarat {
  if (!KARATS.includes(value as ScrapKarat)) {
    throw badRequest("Karat must be one of 14, 18, 21, 22, 24");
  }
  return value as ScrapKarat;
}

function toPublic(row: StolenReport): StolenPublic {
  return {
    id: row.id,
    kind: row.kind as "stolen" | "lost",
    description: row.description,
    weightGrams: row.weightGrams,
    karat: row.karat,
    photoPath: row.photoPath,
    hasInvoice: Boolean(row.invoicePath),
    incidentDate: row.incidentDate,
    country: row.country,
    city: row.city,
    location: row.location,
    status: row.status as "active" | "recovered",
    createdAt: row.createdAt,
  };
}

function memberCanSeeProof(user: User, row: StolenReport) {
  return (
    user.role === "admin" ||
    user.id === row.reporterId ||
    user.verificationStatus === "verified"
  );
}

/** Same karat, and weight within 20% or 1.5 g, whichever is wider. */
export function weightsMatch(reportGrams: string, intakeGrams: number) {
  const reported = Number(reportGrams);
  if (!Number.isFinite(reported) || reported <= 0) return false;
  if (!Number.isFinite(intakeGrams) || intakeGrams <= 0) return false;
  const tolerance = Math.max(1.5, reported * 0.2);
  return Math.abs(reported - intakeGrams) <= tolerance;
}

async function loadReport(id: string) {
  const [row] = await db
    .select()
    .from(stolenReports)
    .where(eq(stolenReports.id, id))
    .limit(1);
  if (!row) throw notFound("Registry report not found");
  return row;
}

function likeTerm(raw: string | undefined) {
  const cleaned = raw?.trim().toLowerCase().replace(/[%_]/g, "") ?? "";
  return cleaned ? `%${cleaned}%` : null;
}

export async function listStolenReports(filters: {
  country?: "SY" | "LB";
  city?: string;
  karat?: number;
  status?: "active" | "recovered" | "all";
  q?: string;
  minWeight?: number;
  maxWeight?: number;
  incidentFrom?: string;
  incidentTo?: string;
  sort?: "newest" | "heaviest";
}) {
  const conditions = [];
  const status = filters.status ?? "active";
  if (status !== "all") conditions.push(eq(stolenReports.status, status));
  if (filters.country) conditions.push(eq(stolenReports.country, filters.country));
  const city = likeTerm(filters.city);
  if (city) conditions.push(sql`lower(${stolenReports.city}) like ${city}`);
  if (filters.karat) {
    assertKarat(filters.karat);
    conditions.push(eq(stolenReports.karat, filters.karat));
  }
  const q = likeTerm(filters.q);
  if (q) conditions.push(sql`lower(${stolenReports.description}) like ${q}`);
  if (filters.minWeight != null) {
    if (!(filters.minWeight >= 0)) throw badRequest("Minimum weight is invalid");
    conditions.push(
      sql`CAST(${stolenReports.weightGrams} AS REAL) >= ${filters.minWeight}`,
    );
  }
  if (filters.maxWeight != null) {
    if (!(filters.maxWeight >= 0)) throw badRequest("Maximum weight is invalid");
    conditions.push(
      sql`CAST(${stolenReports.weightGrams} AS REAL) <= ${filters.maxWeight}`,
    );
  }
  if (
    filters.minWeight != null &&
    filters.maxWeight != null &&
    filters.minWeight > filters.maxWeight
  ) {
    throw badRequest("Minimum weight cannot exceed maximum weight");
  }
  if (filters.incidentFrom) {
    conditions.push(gte(stolenReports.incidentDate, filters.incidentFrom));
  }
  if (filters.incidentTo) {
    conditions.push(lte(stolenReports.incidentDate, filters.incidentTo));
  }
  if (
    filters.incidentFrom &&
    filters.incidentTo &&
    filters.incidentFrom > filters.incidentTo
  ) {
    throw badRequest("Incident start cannot be after the end date");
  }

  const order =
    filters.sort === "heaviest"
      ? [
          sql`CAST(${stolenReports.weightGrams} AS REAL) DESC`,
          desc(stolenReports.createdAt),
        ]
      : [desc(stolenReports.createdAt)];

  const rows = await db
    .select()
    .from(stolenReports)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(...order)
    .limit(200);
  return rows.map(toPublic);
}

export async function getStolenReport(id: string, viewer?: User | null) {
  const row = await loadReport(id);
  const pub = toPublic(row);
  if (!viewer || !memberCanSeeProof(viewer, row)) return pub;
  const isOwner = viewer.id === row.reporterId;
  const member: StolenMemberView = {
    ...pub,
    isOwner,
    invoiceReference: isOwner ? row.invoiceReference : null,
  };
  return member;
}

export async function createStolenReport(
  reporter: User,
  input: CreateStolenInput,
  files: { photoName: string; invoiceName?: string },
) {
  const karat = assertKarat(input.karat);
  const weight = Number(input.weightGrams);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100000) {
    throw badRequest("Weight must be greater than 0");
  }
  const incident = Date.parse(`${input.incidentDate}T00:00:00Z`);
  if (!Number.isFinite(incident)) throw badRequest("Incident date is invalid");
  if (incident > Date.now() + 24 * 60 * 60 * 1000) {
    throw badRequest("Incident date cannot be in the future");
  }

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(stolenReports)
      .values({
        reporterId: reporter.id,
        kind: input.kind,
        description: input.description.trim(),
        weightGrams: weight.toFixed(3),
        karat,
        photoPath: stolenPhotoPublicPath(files.photoName),
        invoicePath: files.invoiceName ? files.invoiceName : null,
        invoiceReference: input.invoiceReference?.trim() || null,
        incidentDate: input.incidentDate,
        country: input.country,
        city: input.city.trim(),
        location: input.location?.trim() || null,
        contactName: input.contactName.trim(),
        contactPhone: input.contactPhone.trim(),
        contactEmail: input.contactEmail.trim().toLowerCase(),
        status: "active",
      })
      .returning();
    if (!row) throw badRequest("Could not file the report");

    const recipients = await tx
      .select({
        id: users.id,
        role: users.role,
        country: users.country,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          inArray(users.role, ["workshop", "retailer", "admin"]),
        ),
      );
    const targets = recipients.filter(
      (r) =>
        r.id !== reporter.id &&
        (r.role === "admin" || r.country === input.country),
    );
    if (targets.length) {
      await tx.insert(stolenAlerts).values(
        targets.map((r) => ({
          reportId: row.id,
          recipientId: r.id,
          kind: "registry" as const,
        })),
      );
    }
    return { row, targetIds: targets.map((r) => r.id) };
  });

  pushStolen(new Set(inserted.targetIds));
  await safeNotify(
    notifyStolenRegistry({
      reportId: inserted.row.id,
      reporterId: reporter.id,
      kind: inserted.row.kind,
      karat: inserted.row.karat,
      weightGrams: inserted.row.weightGrams,
      city: inserted.row.city,
      country: inserted.row.country,
      description: inserted.row.description,
    }),
  );
  return toPublic(inserted.row);
}

async function regionalRecipientIds(country: string, excludeId: string) {
  const recipients = await db
    .select({ id: users.id, role: users.role, country: users.country })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        inArray(users.role, ["workshop", "retailer", "admin"]),
      ),
    );
  return recipients
    .filter(
      (row) =>
        row.id !== excludeId &&
        (row.role === "admin" || row.country === country),
    )
    .map((row) => row.id);
}

export async function recoverStolenReport(user: User, id: string) {
  const row = await loadReport(id);
  if (user.role !== "admin" && user.id !== row.reporterId) {
    throw forbidden("Only the reporter or an admin can close this report");
  }

  const claimed = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(stolenReports)
      .set({
        status: "recovered",
        recoveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(stolenReports.id, id), eq(stolenReports.status, "active")))
      .returning();
    if (!updated) return null;
    const watchers = await tx
      .select({ id: stolenAlerts.recipientId })
      .from(stolenAlerts)
      .where(
        and(eq(stolenAlerts.reportId, id), isNull(stolenAlerts.seenAt)),
      );
    await tx
      .update(stolenAlerts)
      .set({ seenAt: new Date() })
      .where(and(eq(stolenAlerts.reportId, id), isNull(stolenAlerts.seenAt)));
    return { updated, watcherIds: watchers.map((watcher) => watcher.id) };
  });

  const current = claimed?.updated ?? (await loadReport(id));
  if (current.status === "recovered") {
    await rememberArchive(archiveStolenReport(current, user.id));
  }
  if (claimed) {
    const recipientIds = await regionalRecipientIds(current.country, user.id);
    pushStolen(new Set([...claimed.watcherIds, ...recipientIds]));
    await safeNotify(
      notifyStolenRecovered({
        reportId: current.id,
        actorId: user.id,
        recipientIds,
        karat: current.karat,
        weightGrams: current.weightGrams,
        city: current.city,
        country: current.country,
      }),
    );
  }
  return getStolenReport(id, user);
}

const REGISTRY_LOOKUP_LIMIT = 30;
const REGISTRY_LOOKUP_WINDOW_MS = 60 * 60 * 1000;

async function logRegistryAccess(
  userId: string,
  reportId: string,
  action: "contact" | "invoice",
) {
  const since = new Date(Date.now() - REGISTRY_LOOKUP_WINDOW_MS);
  const [countRow] = await db
    .select({
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(stolenContactOpens)
    .where(
      and(
        eq(stolenContactOpens.openedBy, userId),
        eq(stolenContactOpens.action, action),
        gte(stolenContactOpens.createdAt, since),
      ),
    );
  if (Number(countRow?.n ?? 0) >= REGISTRY_LOOKUP_LIMIT) {
    throw tooMany(
      action === "contact"
        ? "Too many contact lookups. Try again in an hour."
        : "Too many invoice views. Try again in an hour.",
    );
  }
  await db.insert(stolenContactOpens).values({
    reportId,
    openedBy: userId,
    action,
  });
}

export async function openStolenContact(user: User, id: string) {
  const row = await loadReport(id);
  await logRegistryAccess(user.id, row.id, "contact");
  const [reporter] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.reporterId))
    .limit(1);
  const canMessage =
    (user.role === "workshop" && reporter?.role === "retailer") ||
    (user.role === "retailer" && reporter?.role === "workshop");
  return {
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    invoiceReference: row.invoiceReference,
    reporterId: row.reporterId,
    reporterRole: reporter?.role ?? null,
    businessName: reporter?.businessName || reporter?.fullName || null,
    canMessage,
  };
}

export async function stolenInvoiceAbsolute(user: User, id: string) {
  const row = await loadReport(id);
  if (!memberCanSeeProof(user, row)) {
    throw forbidden("Invoice proof is limited to verified houses");
  }
  if (!row.invoicePath) throw notFound("No invoice proof on this report");
  const full = stolenInvoiceFile(row.invoicePath);
  if (!fs.existsSync(full)) throw notFound("Invoice proof is missing");
  await logRegistryAccess(user.id, row.id, "invoice");
  return full;
}

export async function listStolenAlerts(userId: string) {
  return db
    .select({
      id: stolenAlerts.id,
      kind: stolenAlerts.kind,
      reportId: stolenAlerts.reportId,
      scrapId: stolenAlerts.scrapId,
      createdAt: stolenAlerts.createdAt,
      reportKind: stolenReports.kind,
      description: stolenReports.description,
      karat: stolenReports.karat,
      weightGrams: stolenReports.weightGrams,
      country: stolenReports.country,
      city: stolenReports.city,
      status: stolenReports.status,
    })
    .from(stolenAlerts)
    .innerJoin(stolenReports, eq(stolenAlerts.reportId, stolenReports.id))
    .where(
      and(
        eq(stolenAlerts.recipientId, userId),
        isNull(stolenAlerts.seenAt),
        eq(stolenReports.status, "active"),
      ),
    )
    .orderBy(desc(stolenAlerts.createdAt))
    .limit(20);
}

export async function markStolenAlertsSeen(userId: string, ids?: string[]) {
  const conditions = [
    eq(stolenAlerts.recipientId, userId),
    isNull(stolenAlerts.seenAt),
  ];
  if (ids && ids.length > 0) conditions.push(inArray(stolenAlerts.id, ids));
  await db
    .update(stolenAlerts)
    .set({ seenAt: new Date() })
    .where(and(...conditions));
}

type ScrapIntake = {
  id: string;
  workshopId: string;
  estimatedKarat: number;
  estimatedWeightGrams: string;
};

/** Persist a scrap-desk alert for each active report the intake resembles. */
export async function notifyScrapMatches(scraps: ScrapIntake[]) {
  if (!scraps.length) return;
  const workshopIds = [...new Set(scraps.map((s) => s.workshopId))];
  const workshops = await db
    .select({ id: users.id, country: users.country })
    .from(users)
    .where(inArray(users.id, workshopIds));
  const countryByWorkshop = new Map(workshops.map((w) => [w.id, w.country]));
  const countries = [...new Set(workshops.map((w) => w.country))];
  if (!countries.length) return;

  const reports = await db
    .select()
    .from(stolenReports)
    .where(
      and(
        eq(stolenReports.status, "active"),
        inArray(stolenReports.country, countries),
      ),
    );

  const alerts: {
    reportId: string;
    recipientId: string;
    scrapId: string;
    kind: "scrap";
  }[] = [];
  const notifyUsers = new Set<string>();
  for (const scrap of scraps) {
    const country = countryByWorkshop.get(scrap.workshopId);
    if (!country) continue;
    const hits = reports.filter(
      (report) =>
        report.country === country &&
        report.karat === scrap.estimatedKarat &&
        weightsMatch(report.weightGrams, Number(scrap.estimatedWeightGrams)),
    );
    for (const hit of hits) {
      alerts.push({
        reportId: hit.id,
        recipientId: scrap.workshopId,
        scrapId: scrap.id,
        kind: "scrap",
      });
      notifyUsers.add(scrap.workshopId);
    }
  }
  if (!alerts.length) return;
  await db.insert(stolenAlerts).values(alerts);
  pushStolen(notifyUsers);
  const seen = new Set<string>();
  for (const alert of alerts) {
    const key = `${alert.recipientId}:${alert.scrapId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const report = reports.find((row) => row.id === alert.reportId);
    if (!report) continue;
    await safeNotify(
      notifyScrapStolenMatch({
        workshopId: alert.recipientId,
        reportId: report.id,
        karat: report.karat,
        weightGrams: report.weightGrams,
        city: report.city,
      }),
    );
  }
}

export async function attachStolenMatches<
  T extends {
    estimatedKarat: number;
    estimatedWeightGrams: string;
    assayedKarat?: number | null;
    assayedWeightGrams?: string | null;
  },
>(country: string, rows: T[]) {
  if (!rows.length) {
    return rows.map((row) => ({ ...row, stolenMatches: [] as StolenMatch[] }));
  }
  const reports = await db
    .select({
      id: stolenReports.id,
      kind: stolenReports.kind,
      description: stolenReports.description,
      karat: stolenReports.karat,
      weightGrams: stolenReports.weightGrams,
      city: stolenReports.city,
      country: stolenReports.country,
    })
    .from(stolenReports)
    .where(
      and(eq(stolenReports.status, "active"), eq(stolenReports.country, country)),
    );
  return rows.map((row) => {
    const candidates = [
      {
        karat: row.estimatedKarat,
        weight: Number(row.estimatedWeightGrams),
      },
    ];
    if (row.assayedKarat && row.assayedWeightGrams) {
      candidates.push({
        karat: row.assayedKarat,
        weight: Number(row.assayedWeightGrams),
      });
    }
    return {
      ...row,
      stolenMatches: reports
        .filter((report) =>
          candidates.some(
            (candidate) =>
              report.karat === candidate.karat &&
              weightsMatch(report.weightGrams, candidate.weight),
          ),
        )
        .map((report) => ({
          id: report.id,
          kind: report.kind,
          description: report.description,
          karat: report.karat,
          weightGrams: report.weightGrams,
          city: report.city,
          country: report.country,
        })),
    };
  });
}

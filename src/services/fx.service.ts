/**
 * Admin FX management — units of SYP/LBP per 1 USD.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { fxRates, type User } from "../db/schema.js";
import { type AppCurrency, SUPPORTED_CURRENCIES } from "../lib/currencies.js";
import { badRequest, forbidden } from "../lib/errors.js";

export type FxSnapshot = {
  base: "USD";
  currencies: AppCurrency[];
  /** Major units of each currency per 1 USD */
  unitsPerUsd: Record<AppCurrency, number>;
  asOf: Record<AppCurrency, string | null>;
  rateIds: Record<AppCurrency, string | null>;
};

const DEFAULT_UNITS: Record<AppCurrency, number> = {
  USD: 1,
  SYP: 15000,
  LBP: 89500,
};

export async function getActiveFxRate(currency: "SYP" | "LBP") {
  const [row] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), eq(fxRates.isActive, true)))
    .orderBy(desc(fxRates.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getFxSnapshot(): Promise<FxSnapshot> {
  const unitsPerUsd: Record<AppCurrency, number> = { ...DEFAULT_UNITS };
  const asOf: Record<AppCurrency, string | null> = {
    USD: null,
    SYP: null,
    LBP: null,
  };
  const rateIds: Record<AppCurrency, string | null> = {
    USD: null,
    SYP: null,
    LBP: null,
  };

  for (const currency of ["SYP", "LBP"] as const) {
    const row = await getActiveFxRate(currency);
    if (row) {
      const n = Number(row.unitsPerUsd);
      if (n > 0) unitsPerUsd[currency] = n;
      asOf[currency] =
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(Number(row.createdAt)).toISOString();
      rateIds[currency] = row.id;
    }
  }

  return {
    base: "USD",
    currencies: [...SUPPORTED_CURRENCIES],
    unitsPerUsd,
    asOf,
    rateIds,
  };
}

/**
 * Locked rate for a settlement currency (major units per 1 USD).
 * Display snapshots may still show DEFAULT_UNITS. A locked trade may not.
 */
export async function resolveUnitsPerUsd(currency: AppCurrency): Promise<{
  unitsPerUsd: number;
  rateId: string | null;
}> {
  if (currency === "USD") return { unitsPerUsd: 1, rateId: null };
  const row = await getActiveFxRate(currency);
  const unitsPerUsd = Number(row?.unitsPerUsd);
  if (!row || !(unitsPerUsd > 0)) {
    throw badRequest(`No active ${currency} exchange rate`);
  }
  return { unitsPerUsd, rateId: row.id };
}

export async function listFxHistory(limit = 30) {
  return db
    .select()
    .from(fxRates)
    .orderBy(desc(fxRates.createdAt))
    .limit(limit);
}

export async function publishFxRate(
  admin: User,
  input: {
    currency: "SYP" | "LBP";
    unitsPerUsd: number;
    notes?: string;
  },
) {
  if (admin.role !== "admin") {
    throw forbidden("Only admins can publish FX rates");
  }
  if (input.currency !== "SYP" && input.currency !== "LBP") {
    throw badRequest("FX currency must be SYP or LBP");
  }
  if (!(input.unitsPerUsd > 0) || !Number.isFinite(input.unitsPerUsd)) {
    throw badRequest("unitsPerUsd must be a positive number");
  }

  await db
    .update(fxRates)
    .set({ isActive: false })
    .where(
      and(eq(fxRates.currency, input.currency), eq(fxRates.isActive, true)),
    );

  const [row] = await db
    .insert(fxRates)
    .values({
      currency: input.currency,
      unitsPerUsd: String(input.unitsPerUsd),
      notes: input.notes?.trim() || null,
      setBy: admin.id,
      isActive: true,
    })
    .returning();

  return row;
}

export async function getUnitsPerUsdMap(): Promise<Record<AppCurrency, number>> {
  const snap = await getFxSnapshot();
  return snap.unitsPerUsd;
}

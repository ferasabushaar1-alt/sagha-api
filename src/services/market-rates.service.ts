/**
 * Gold spot + Syrian karat breakdown (24K / 21K / 18K).
 * Prefers admin-published official rate; otherwise live feed / fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db } from "../db/client.js";
import { goldSpotRates, type User } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { publicDir } from "../lib/paths.js";

const TROY_OUNCE_GRAMS = 31.1034768;
const CACHE_TTL_MS = 60_000;
const FALLBACK_USD_PER_OZ = 2650;

export type KaratRate = {
  karat: 24 | 21 | 18;
  purity: number;
  priceCentsPerGram: number;
  priceUsdPerGram: number;
};

export type MarketRatesSnapshot = {
  currency: "USD";
  spotCentsPerGramFine: number;
  spotUsdPerGramFine: number;
  spotUsdPerTroyOz: number;
  karats: KaratRate[];
  asOf: string;
  source: string;
  live: boolean;
  cached: boolean;
  nextRefreshAt: string;
  /** Admin-controlled official rate */
  official: boolean;
  rateId: string | null;
  verificationImagePath: string | null;
  notes: string | null;
  setBy: string | null;
};

type CacheEntry = {
  expiresAt: number;
  snapshot: MarketRatesSnapshot;
};

let feedCache: CacheEntry | null = null;

function purity(karat: 24 | 21 | 18) {
  return karat / 24;
}

function buildKarats(spotCentsPerGramFine: number): KaratRate[] {
  return ([24, 21, 18] as const).map((karat) => {
    const p = purity(karat);
    const priceCentsPerGram = Math.round(spotCentsPerGramFine * p);
    return {
      karat,
      purity: p,
      priceCentsPerGram,
      priceUsdPerGram: priceCentsPerGram / 100,
    };
  });
}

function snapshotFromCentsPerGram(
  spotCentsPerGramFine: number,
  meta: {
    source: string;
    live: boolean;
    cached: boolean;
    official: boolean;
    rateId?: string | null;
    verificationImagePath?: string | null;
    notes?: string | null;
    setBy?: string | null;
    asOf?: Date;
  },
): MarketRatesSnapshot {
  const spotUsdPerGramFine = spotCentsPerGramFine / 100;
  const spotUsdPerTroyOz = spotUsdPerGramFine * TROY_OUNCE_GRAMS;
  const now = meta.asOf?.getTime() ?? Date.now();
  return {
    currency: "USD",
    spotCentsPerGramFine,
    spotUsdPerGramFine: Number(spotUsdPerGramFine.toFixed(4)),
    spotUsdPerTroyOz: Number(spotUsdPerTroyOz.toFixed(2)),
    karats: buildKarats(spotCentsPerGramFine),
    asOf: new Date(now).toISOString(),
    source: meta.source,
    live: meta.live,
    cached: meta.cached,
    nextRefreshAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    official: meta.official,
    rateId: meta.rateId ?? null,
    verificationImagePath: meta.verificationImagePath ?? null,
    notes: meta.notes ?? null,
    setBy: meta.setBy ?? null,
  };
}

function snapshotFromUsdPerOz(
  usdPerOz: number,
  source: string,
  live: boolean,
  cached: boolean,
): MarketRatesSnapshot {
  const spotUsdPerGramFine = usdPerOz / TROY_OUNCE_GRAMS;
  const spotCentsPerGramFine = Math.round(spotUsdPerGramFine * 100);
  return snapshotFromCentsPerGram(spotCentsPerGramFine, {
    source,
    live,
    cached,
    official: false,
  });
}

async function fetchUsdPerTroyOz(): Promise<{ usdPerOz: number; source: string } | null> {
  const envFixed = process.env.GOLD_SPOT_USD_PER_OZ;
  if (envFixed && Number(envFixed) > 0) {
    return { usdPerOz: Number(envFixed), source: "env:GOLD_SPOT_USD_PER_OZ" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch("https://api.metals.live/v1/spot/gold", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    let usdPerOz: number | null = null;
    if (Array.isArray(data) && data.length) {
      const last = data[data.length - 1];
      if (Array.isArray(last) && typeof last[1] === "number") {
        usdPerOz = last[1];
      } else if (typeof last === "number") {
        usdPerOz = last;
      }
    } else if (data && typeof data === "object" && "price" in data) {
      const price = (data as { price: unknown }).price;
      if (typeof price === "number") usdPerOz = price;
    }
    if (usdPerOz && usdPerOz > 0) {
      return { usdPerOz, source: "metals.live" };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getActiveOfficialRate() {
  const [row] = await db
    .select()
    .from(goldSpotRates)
    .where(eq(goldSpotRates.isActive, true))
    .orderBy(desc(goldSpotRates.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listOfficialRates(limit = 20) {
  return db
    .select()
    .from(goldSpotRates)
    .orderBy(desc(goldSpotRates.createdAt))
    .limit(limit);
}

export async function getMarketRates(): Promise<MarketRatesSnapshot> {
  const official = await getActiveOfficialRate();
  if (official) {
    const asOf =
      official.createdAt instanceof Date
        ? official.createdAt
        : new Date(Number(official.createdAt));
    return snapshotFromCentsPerGram(official.spotCentsPerGramFine, {
      source: "admin-official",
      live: true,
      cached: false,
      official: true,
      rateId: official.id,
      verificationImagePath: official.verificationImagePath,
      notes: official.notes,
      setBy: official.setBy,
      asOf,
    });
  }

  const now = Date.now();
  if (feedCache && feedCache.expiresAt > now) {
    return { ...feedCache.snapshot, cached: true };
  }

  const live = await fetchUsdPerTroyOz();
  const snapshot = live
    ? snapshotFromUsdPerOz(live.usdPerOz, live.source, true, false)
    : snapshotFromUsdPerOz(FALLBACK_USD_PER_OZ, "fallback", false, false);

  feedCache = {
    expiresAt: now + CACHE_TTL_MS,
    snapshot: { ...snapshot, cached: false },
  };

  return snapshot;
}

export type PublishOfficialRateInput = {
  /** Major USD units per gram fine, e.g. 85.50 */
  spotUsdPerGramFine: number;
  notes?: string;
  verificationImagePath?: string | null;
};

export async function publishOfficialRate(
  admin: User,
  input: PublishOfficialRateInput,
) {
  if (admin.role !== "admin") {
    throw badRequest("Only admins can publish official rates");
  }
  if (!(input.spotUsdPerGramFine > 0) || !Number.isFinite(input.spotUsdPerGramFine)) {
    throw badRequest("spotUsdPerGramFine must be a positive number");
  }

  const spotCentsPerGramFine = Math.round(input.spotUsdPerGramFine * 100);
  if (spotCentsPerGramFine < 1) {
    throw badRequest("Spot price is too small");
  }

  // Deactivate previous active rates
  await db
    .update(goldSpotRates)
    .set({ isActive: false })
    .where(eq(goldSpotRates.isActive, true));

  const [row] = await db
    .insert(goldSpotRates)
    .values({
      spotCentsPerGramFine,
      currency: "USD",
      verificationImagePath: input.verificationImagePath ?? null,
      notes: input.notes?.trim() || null,
      setBy: admin.id,
      isActive: true,
    })
    .returning();

  // Clear feed cache so next read picks official immediately
  feedCache = null;

  return row;
}

function resolveLocalImagePath(publicPath: string | null | undefined): string | null {
  if (!publicPath) return null;
  // Stored as /media/market-sheets/xxx.jpg → public/market-sheets/xxx.jpg
  const relative = publicPath.replace(/^\/media\/?/, "");
  const full = path.join(publicDir(), relative);
  return fs.existsSync(full) ? full : null;
}

/** Build a PDF Buffer with official price + optional verification image. */
export async function buildOfficialRatePdf(): Promise<{
  buffer: Buffer;
  filename: string;
}> {
  const rates = await getMarketRates();
  if (!rates.official) {
    throw badRequest("No official admin gold rate is published yet");
  }

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc
    .fontSize(22)
    .fillColor("#1a2332")
    .text("Sagha — Official Gold Spot Report", { align: "left" });
  doc.moveDown(0.3);
  doc
    .fontSize(11)
    .fillColor("#666")
    .text("صاغة — تقرير سعر الذهب الرسمي");
  doc.moveDown();

  doc
    .fontSize(12)
    .fillColor("#1a2332")
    .text(`Published: ${new Date(rates.asOf).toLocaleString("en-GB")}`);
  doc.text(`Source: ${rates.source} (admin official)`);
  if (rates.notes) doc.text(`Notes: ${rates.notes}`);
  doc.moveDown();

  doc.fontSize(14).text("Fine gold spot (24K)");
  doc
    .fontSize(20)
    .fillColor("#b08d3a")
    .text(`$${rates.spotUsdPerGramFine.toFixed(2)} / gram`);
  doc
    .fontSize(11)
    .fillColor("#1a2332")
    .text(`$${rates.spotUsdPerTroyOz.toFixed(2)} / troy oz`);
  doc.moveDown();

  doc.fontSize(14).text("Syrian karat breakdown (per gram)");
  doc.moveDown(0.4);
  for (const k of rates.karats) {
    doc
      .fontSize(12)
      .text(
        `${k.karat}K  ·  ${(k.purity * 100).toFixed(2)}%  ·  $${k.priceUsdPerGram.toFixed(2)} / g`,
      );
  }

  const imagePath = resolveLocalImagePath(rates.verificationImagePath);
  if (imagePath) {
    doc.moveDown();
    doc.fontSize(14).text("Verification sheet");
    doc.moveDown(0.3);
    try {
      doc.image(imagePath, {
        fit: [480, 360],
        align: "center",
      });
    } catch {
      doc.fontSize(10).fillColor("#666").text("(Could not embed verification image)");
    }
  } else {
    doc.moveDown();
    doc
      .fontSize(10)
      .fillColor("#666")
      .text("No verification image attached to this rate.");
  }

  doc.moveDown(2);
  doc
    .fontSize(9)
    .fillColor("#999")
    .text(`Generated by Sagha · ${new Date().toISOString()}`, {
      align: "center",
    });

  doc.end();
  const buffer = await done;
  const day = new Date(rates.asOf).toISOString().slice(0, 10);
  return {
    buffer,
    filename: `sagha-gold-spot-${day}.pdf`,
  };
}

export function clearMarketRatesCache() {
  feedCache = null;
}

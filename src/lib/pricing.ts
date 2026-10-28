/** Purity as karat/24 (18K → 0.75, 21K → 0.875). */
export function purityFactor(karat: number): number {
  return karat / 24;
}

/** Fine grams = weight × (karat / 24). */
export function fineGrams(weightGrams: number, karat: number): number {
  return weightGrams * purityFactor(karat);
}

/**
 * Scrap / كسر melt value before refining fee.
 * spot = minor units per gram of fine (24K) gold.
 */
export function scrapMeltValueCents(input: {
  weightGrams: number;
  karat: number;
  spotCentsPerGram: number;
}): number {
  return Math.round(
    fineGrams(input.weightGrams, input.karat) * input.spotCentsPerGram,
  );
}

/**
 * Gold value for one unit (one piece of given weight).
 * spot = minor units per gram of fine (24K) gold.
 */
export function unitGoldValueCents(input: {
  weightGrams: number;
  karat: 18 | 21;
  spotCentsPerGram: number;
}): number {
  const factor = purityFactor(input.karat);
  return Math.round(input.weightGrams * factor * input.spotCentsPerGram);
}

export type MakingTierInput = {
  minQty: number;
  maxQty: number | null;
  makingChargeCents: number;
};

/**
 * Pick the making-charge tier for a quantity.
 * Falls back to the product's base making charge when no tier matches.
 */
export function resolveMakingCharge(
  baseMakingChargeCents: number,
  quantity: number,
  tiers: MakingTierInput[] = [],
): {
  makingChargeCents: number;
  tier: MakingTierInput | null;
} {
  if (!(quantity > 0) || !tiers.length) {
    return { makingChargeCents: baseMakingChargeCents, tier: null };
  }
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  const match = sorted.find(
    (t) =>
      quantity >= t.minQty && (t.maxQty == null || quantity <= t.maxQty),
  );
  if (!match) {
    return { makingChargeCents: baseMakingChargeCents, tier: null };
  }
  return { makingChargeCents: match.makingChargeCents, tier: match };
}

export function priceLine(input: {
  weightGrams: number;
  karat: 18 | 21;
  spotCentsPerGram: number;
  makingChargeCents: number;
  quantity: number;
  /** Optional volume tiers — overrides makingChargeCents when matched */
  makingTiers?: MakingTierInput[];
}) {
  const resolved = resolveMakingCharge(
    input.makingChargeCents,
    input.quantity,
    input.makingTiers ?? [],
  );
  const unitGold = unitGoldValueCents(input);
  const unitMaking = resolved.makingChargeCents;
  const qty = input.quantity;
  return {
    purityFactor: purityFactor(input.karat),
    unitGoldValueCents: unitGold,
    unitMakingChargeCents: unitMaking,
    makingTier: resolved.tier,
    lineGoldValueCents: unitGold * qty,
    lineMakingChargeCents: unitMaking * qty,
    lineTotalCents: (unitGold + unitMaking) * qty,
  };
}

/** Validate non-overlapping quantity bands (sorted by minQty). */
export function validateMakingTiers(tiers: MakingTierInput[]): string | null {
  if (!tiers.length) return null;
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (!(t.minQty >= 1) || !Number.isInteger(t.minQty)) {
      return "Tier minQty must be an integer >= 1";
    }
    if (t.maxQty != null) {
      if (!Number.isInteger(t.maxQty) || t.maxQty < t.minQty) {
        return "Tier maxQty must be null or an integer >= minQty";
      }
    }
    if (!(t.makingChargeCents >= 0) || !Number.isInteger(t.makingChargeCents)) {
      return "Tier making charge must be a non-negative integer (cents)";
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.maxQty == null) {
        return "Only the last tier may be open-ended (no maxQty)";
      }
      if (t.minQty <= prev.maxQty) {
        return "Making-charge tiers must not overlap";
      }
      if (t.minQty !== prev.maxQty + 1) {
        return "Making-charge tiers must be contiguous (no quantity gaps)";
      }
    } else if (t.minQty !== 1) {
      return "First making-charge tier must start at quantity 1";
    }
  }
  return null;
}

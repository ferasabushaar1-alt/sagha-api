/** Supported settlement / product currencies. Spot gold remains USD-based. */
export const SUPPORTED_CURRENCIES = ["USD", "SYP", "LBP"] as const;
export type AppCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isAppCurrency(value: unknown): value is AppCurrency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * Convert minor units between currencies via USD pivot.
 * `unitsPerUsd` = how many major units of that currency equal 1 USD
 * (USD → 1, SYP → e.g. 15000, LBP → e.g. 89500).
 */
export function convertCents(
  amountCents: number,
  from: AppCurrency,
  to: AppCurrency,
  unitsPerUsd: Record<AppCurrency, number>,
): number {
  if (from === to) return Math.round(amountCents);
  const fromRate = unitsPerUsd[from];
  const toRate = unitsPerUsd[to];
  if (!(fromRate > 0) || !(toRate > 0)) {
    throw new Error(`Missing FX rate for ${from}→${to}`);
  }
  // cents → major → USD → target major → cents
  const fromMajor = amountCents / 100;
  const usdMajor = fromMajor / fromRate;
  const toMajor = usdMajor * toRate;
  return Math.round(toMajor * 100);
}

/** Convert USD minor units to target currency using units-per-USD rate. */
export function usdCentsToCurrency(
  usdCents: number,
  to: AppCurrency,
  unitsPerUsd: number,
): number {
  if (to === "USD") return Math.round(usdCents);
  if (!(unitsPerUsd > 0)) throw new Error(`Invalid FX rate for ${to}`);
  return Math.round((usdCents / 100) * unitsPerUsd * 100);
}

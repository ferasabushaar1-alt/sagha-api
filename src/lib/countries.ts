export const COUNTRIES = ["SY", "LB"] as const;

export type CountryCode = (typeof COUNTRIES)[number];

export function isCountryCode(value: string): value is CountryCode {
  return (COUNTRIES as readonly string[]).includes(value);
}

export const COUNTRY_LABELS: Record<CountryCode, { en: string; ar: string }> = {
  SY: { en: "Syria", ar: "سوريا" },
  LB: { en: "Lebanon", ar: "لبنان" },
};

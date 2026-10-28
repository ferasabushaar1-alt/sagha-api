export const PRODUCT_CATEGORIES = [
  "rings",
  "chains",
  "earrings",
  "bracelets",
  "necklaces",
  "bangles",
  "pendants",
  "sets",
  "other",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export function isProductCategory(value: string): value is ProductCategory {
  return (PRODUCT_CATEGORIES as readonly string[]).includes(value);
}

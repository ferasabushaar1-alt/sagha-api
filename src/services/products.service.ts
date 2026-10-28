import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  productMakingTiers,
  products,
  users,
  type User,
} from "../db/schema.js";
import {
  isProductCategory,
  type ProductCategory,
} from "../lib/categories.js";
import type { AppCurrency } from "../lib/currencies.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import {
  validateMakingTiers,
  type MakingTierInput,
} from "../lib/pricing.js";

export type CreateProductInput = {
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  sku?: string;
  category?: ProductCategory;
  karat: 18 | 21;
  weightGrams: number;
  makingChargeCents: number;
  currency?: AppCurrency;
  stockQty?: number;
  imagePath?: string;
  status?: "draft" | "active";
  makingTiers?: MakingTierInput[];
};

export type MakingTierDto = {
  id?: string;
  minQty: number;
  maxQty: number | null;
  makingChargeCents: number;
};

export type CatalogFilters = {
  karat?: 18 | 21;
  workshopId?: string;
  category?: ProductCategory;
  /** Filter workshops by country (SY / LB). Empty = all countries. */
  country?: string;
  /** Free-text smart search across product + workshop fields */
  q?: string;
  mine?: User;
};

export async function createProduct(workshop: User, input: CreateProductInput) {
  assertVerifiedWorkshop(workshop);

  if (input.status === "active" && workshop.verificationStatus !== "verified") {
    throw forbidden("Only verified workshops can publish products");
  }

  const category = input.category ?? "other";
  if (!isProductCategory(category)) {
    throw badRequest("Invalid product category");
  }

  if (input.makingTiers?.length) {
    const err = validateMakingTiers(input.makingTiers);
    if (err) throw badRequest(err);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        workshopId: workshop.id,
        name: input.name,
        nameAr: input.nameAr ?? null,
        description: input.description ?? null,
        descriptionAr: input.descriptionAr ?? null,
        sku: input.sku ?? null,
        category,
        karat: input.karat,
        weightGrams: input.weightGrams.toFixed(3),
        makingChargeCents: input.makingChargeCents,
        currency: input.currency ?? "USD",
        stockQty: input.stockQty ?? 0,
        imagePath: input.imagePath ?? null,
        status: input.status ?? "draft",
      })
      .returning();

    if (input.makingTiers?.length) {
      await replaceTiers(row.id, input.makingTiers, tx as unknown as typeof db);
    }

    const tiers = await listTiersForProducts([row.id], tx as unknown as typeof db);
    return { ...row, makingTiers: tiers.get(row.id) ?? [] };
  });
}

export async function updateProduct(
  workshop: User,
  productId: string,
  patch: Partial<CreateProductInput>,
) {
  assertVerifiedWorkshop(workshop);
  const product = await getOwnedProduct(workshop.id, productId);

  if (patch.category !== undefined && !isProductCategory(patch.category)) {
    throw badRequest("Invalid product category");
  }

  if (patch.makingTiers !== undefined) {
    const err = validateMakingTiers(patch.makingTiers);
    if (err) throw badRequest(err);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({
        name: patch.name ?? product.name,
        nameAr:
          patch.nameAr !== undefined ? patch.nameAr : product.nameAr,
        description:
          patch.description !== undefined
            ? patch.description
            : product.description,
        descriptionAr:
          patch.descriptionAr !== undefined
            ? patch.descriptionAr
            : product.descriptionAr,
        sku: patch.sku !== undefined ? patch.sku : product.sku,
        category: patch.category ?? product.category,
        karat: patch.karat ?? product.karat,
        weightGrams:
          patch.weightGrams !== undefined
            ? patch.weightGrams.toFixed(3)
            : product.weightGrams,
        makingChargeCents:
          patch.makingChargeCents ?? product.makingChargeCents,
        currency: patch.currency ?? (product.currency as AppCurrency),
        stockQty: patch.stockQty ?? product.stockQty,
        imagePath:
          patch.imagePath !== undefined ? patch.imagePath : product.imagePath,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId))
      .returning();

    if (patch.makingTiers !== undefined) {
      await replaceTiers(
        productId,
        patch.makingTiers,
        tx as unknown as typeof db,
      );
    }

    const tiers = await listTiersForProducts(
      [productId],
      tx as unknown as typeof db,
    );
    return { ...row, makingTiers: tiers.get(productId) ?? [] };
  });
}

/** Replace all volume tiers for a product (empty array clears). */
export async function setProductMakingTiers(
  workshop: User,
  productId: string,
  tiers: MakingTierInput[],
) {
  assertVerifiedWorkshop(workshop);
  await getOwnedProduct(workshop.id, productId);
  const err = validateMakingTiers(tiers);
  if (err) throw badRequest(err);

  await replaceTiers(productId, tiers);
  const map = await listTiersForProducts([productId]);
  return map.get(productId) ?? [];
}

export async function setProductStatus(
  workshop: User,
  productId: string,
  status: "draft" | "active" | "archived",
) {
  assertVerifiedWorkshop(workshop);
  await getOwnedProduct(workshop.id, productId);

  if (status === "active" && workshop.verificationStatus !== "verified") {
    throw forbidden("Only verified workshops can activate products");
  }

  const [row] = await db
    .update(products)
    .set({ status, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning();

  return row;
}

export async function listCatalog(filters: CatalogFilters) {
  // Workshop viewing own catalog (all statuses) — still support q/category
  if (filters.mine?.role === "workshop") {
    const conditions = [eq(products.workshopId, filters.mine.id)];
    if (filters.category) conditions.push(eq(products.category, filters.category));
    if (filters.karat) conditions.push(eq(products.karat, filters.karat));
    if (filters.q?.trim()) {
      const term = `%${filters.q.trim().toLowerCase()}%`;
      conditions.push(
        sql`(lower(${products.name}) LIKE ${term}
          OR lower(coalesce(${products.nameAr}, '')) LIKE ${term}
          OR lower(coalesce(${products.description}, '')) LIKE ${term}
          OR lower(coalesce(${products.descriptionAr}, '')) LIKE ${term}
          OR lower(coalesce(${products.sku}, '')) LIKE ${term}
          OR lower(coalesce(${products.category}, '')) LIKE ${term})`,
      );
    }
    const rows = await db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt));
    return attachMakingTiers(rows);
  }

  const conditions = [
    eq(products.status, "active"),
    eq(users.verificationStatus, "verified"),
    eq(users.role, "workshop"),
    eq(users.isActive, true),
  ];
  if (filters.karat) conditions.push(eq(products.karat, filters.karat));
  if (filters.workshopId) {
    conditions.push(eq(products.workshopId, filters.workshopId));
  }
  if (filters.category) {
    conditions.push(eq(products.category, filters.category));
  }
  if (filters.country) {
    conditions.push(eq(users.country, filters.country));
  }
  if (filters.q?.trim()) {
    const term = `%${filters.q.trim().toLowerCase()}%`;
    conditions.push(
      sql`(lower(${products.name}) LIKE ${term}
        OR lower(coalesce(${products.nameAr}, '')) LIKE ${term}
        OR lower(coalesce(${products.description}, '')) LIKE ${term}
        OR lower(coalesce(${products.descriptionAr}, '')) LIKE ${term}
        OR lower(coalesce(${products.sku}, '')) LIKE ${term}
        OR lower(coalesce(${products.category}, '')) LIKE ${term}
        OR lower(coalesce(${users.businessName}, '')) LIKE ${term}
        OR lower(coalesce(${users.city}, '')) LIKE ${term}
        OR lower(coalesce(${users.country}, '')) LIKE ${term}
        OR lower(coalesce(${users.fullName}, '')) LIKE ${term})`,
    );
  }

  const rows = await db
    .select({
      id: products.id,
      workshopId: products.workshopId,
      name: products.name,
      nameAr: products.nameAr,
      description: products.description,
      descriptionAr: products.descriptionAr,
      sku: products.sku,
      category: products.category,
      karat: products.karat,
      weightGrams: products.weightGrams,
      makingChargeCents: products.makingChargeCents,
      currency: products.currency,
      stockQty: products.stockQty,
      imagePath: products.imagePath,
      status: products.status,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      workshopBusinessName: users.businessName,
      workshopCity: users.city,
      workshopCountry: users.country,
    })
    .from(products)
    .innerJoin(users, eq(products.workshopId, users.id))
    .where(and(...conditions))
    .orderBy(desc(products.createdAt));
  return attachMakingTiers(rows);
}

/** Facets for smart filters: verified workshops + categories in stock. */
export async function getCatalogFilters() {
  const workshops = await db
    .select({
      id: users.id,
      businessName: users.businessName,
      city: users.city,
      country: users.country,
    })
    .from(users)
    .where(
      and(
        eq(users.role, "workshop"),
        eq(users.verificationStatus, "verified"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.businessName);

  const categoryRows = await db
    .selectDistinct({ category: products.category })
    .from(products)
    .innerJoin(users, eq(products.workshopId, users.id))
    .where(
      and(
        eq(products.status, "active"),
        eq(users.verificationStatus, "verified"),
        eq(users.isActive, true),
      ),
    );

  const categories = categoryRows
    .map((r) => r.category)
    .filter(Boolean)
    .sort();

  const countries = Array.from(
    new Set(workshops.map((w) => w.country).filter(Boolean)),
  ).sort();

  return { workshops, categories, countries };
}

export async function getProduct(productId: string, viewer?: User) {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!row) throw notFound("Product not found");

  if (row.status !== "active") {
    const isOwner =
      viewer?.role === "workshop" && viewer.id === row.workshopId;
    const isAdmin = viewer?.role === "admin";
    if (!isOwner && !isAdmin) throw notFound("Product not found");
  }

  const [withTiers] = await attachMakingTiers([row]);
  return withTiers;
}

async function listTiersForProducts(
  productIds: string[],
  executor: typeof db = db,
) {
  const map = new Map<string, MakingTierDto[]>();
  if (!productIds.length) return map;
  const rows = await executor
    .select()
    .from(productMakingTiers)
    .where(inArray(productMakingTiers.productId, productIds))
    .orderBy(asc(productMakingTiers.minQty));
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    list.push({
      id: r.id,
      minQty: r.minQty,
      maxQty: r.maxQty,
      makingChargeCents: r.makingChargeCents,
    });
    map.set(r.productId, list);
  }
  return map;
}

async function attachMakingTiers<T extends { id: string }>(rows: T[]) {
  const tiers = await listTiersForProducts(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    makingTiers: tiers.get(r.id) ?? [],
  }));
}

async function replaceTiers(
  productId: string,
  tiers: MakingTierInput[],
  executor: typeof db = db,
) {
  await executor
    .delete(productMakingTiers)
    .where(eq(productMakingTiers.productId, productId));
  if (!tiers.length) return;
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  await executor.insert(productMakingTiers).values(
    sorted.map((t) => ({
      productId,
      minQty: t.minQty,
      maxQty: t.maxQty,
      makingChargeCents: t.makingChargeCents,
    })),
  );
}

/** Used by order service to price lines with volume breaks. */
export async function getMakingTiersMap(productIds: string[]) {
  return listTiersForProducts(productIds);
}

async function getOwnedProduct(workshopId: string, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workshopId, workshopId)))
    .limit(1);
  if (!row) throw notFound("Product not found");
  return row;
}

function assertVerifiedWorkshop(user: User) {
  if (user.role !== "workshop") {
    throw forbidden("Only workshops can manage products");
  }
  if (user.verificationStatus !== "verified") {
    throw forbidden("Workshop must be verified to manage products");
  }
}

/** Used by order service — decrement stock atomically. */
export async function decrementStock(
  productId: string,
  qty: number,
  tx: typeof db,
) {
  const result = await tx
    .update(products)
    .set({
      stockQty: sql`${products.stockQty} - ${qty}`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(products.id, productId), sql`${products.stockQty} >= ${qty}`),
    )
    .returning();

  if (!result.length) {
    throw badRequest(`Insufficient stock for product ${productId}`);
  }
  return result[0];
}

export async function incrementStock(
  productId: string,
  qty: number,
  tx: typeof db = db,
) {
  const [row] = await tx
    .update(products)
    .set({
      stockQty: sql`${products.stockQty} + ${qty}`,
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId))
    .returning();
  return row;
}

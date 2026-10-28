import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { PRODUCT_CATEGORIES } from "../lib/categories.js";
import * as productsService from "../services/products.service.js";

const categoryEnum = z.enum(PRODUCT_CATEGORIES);

const makingTierSchema = z.object({
  minQty: z.number().int().positive(),
  maxQty: z.number().int().positive().nullable(),
  makingChargeCents: z.number().int().nonnegative(),
});

const createSchema = z.object({
  name: z.string().min(2),
  nameAr: z.string().min(2).optional(),
  description: z.string().optional(),
  descriptionAr: z.string().optional(),
  sku: z.string().optional(),
  category: categoryEnum.optional(),
  karat: z.union([z.literal(18), z.literal(21)]),
  weightGrams: z.number().positive(),
  makingChargeCents: z.number().int().nonnegative(),
  currency: z.enum(["USD", "SYP", "LBP"]).optional(),
  stockQty: z.number().int().nonnegative().optional(),
  imagePath: z.string().optional(),
  status: z.enum(["draft", "active"]).optional(),
  makingTiers: z.array(makingTierSchema).optional(),
});

const updateSchema = createSchema.partial();

const tiersBodySchema = z.object({
  makingTiers: z.array(makingTierSchema),
});

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  karat: z.enum(["18", "21"]).optional(),
  workshopId: z.string().uuid().optional(),
  category: categoryEnum.optional(),
  country: z.enum(["SY", "LB"]).optional(),
  q: z.string().max(120).optional(),
  mine: z.enum(["true", "false"]).optional(),
});

export const productsRouter = Router();

productsRouter.get(
  "/filters",
  requireAuth,
  async (_req, res, next) => {
    try {
      const filters = await productsService.getCatalogFilters();
      res.json({
        ...filters,
        allCategories: PRODUCT_CATEGORIES,
      });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.get(
  "/",
  requireAuth,
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const q = req.query as {
        karat?: "18" | "21";
        workshopId?: string;
        category?: (typeof PRODUCT_CATEGORIES)[number];
        country?: "SY" | "LB";
        q?: string;
        mine?: "true" | "false";
      };
      const list = await productsService.listCatalog({
        karat: q.karat ? (Number(q.karat) as 18 | 21) : undefined,
        workshopId: q.workshopId,
        category: q.category,
        country: q.country,
        q: q.q,
        mine: q.mine === "true" ? user : undefined,
      });
      res.json({ products: list });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.get(
  "/:id",
  requireAuth,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const product = await productsService.getProduct(req.params.id, user);
      res.json({ product });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.post(
  "/",
  requireAuth,
  requireRoles("workshop"),
  requireVerified,
  validate({ body: createSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const product = await productsService.createProduct(user, req.body);
      res.status(201).json({ product });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.patch(
  "/:id",
  requireAuth,
  requireRoles("workshop"),
  requireVerified,
  validate({ params: idParams, body: updateSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const product = await productsService.updateProduct(
        user,
        req.params.id,
        req.body,
      );
      res.json({ product });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.put(
  "/:id/making-tiers",
  requireAuth,
  requireRoles("workshop"),
  requireVerified,
  validate({ params: idParams, body: tiersBodySchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const makingTiers = await productsService.setProductMakingTiers(
        user,
        req.params.id,
        req.body.makingTiers,
      );
      res.json({ makingTiers });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.post(
  "/:id/publish",
  requireAuth,
  requireRoles("workshop"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const product = await productsService.setProductStatus(
        user,
        req.params.id,
        "active",
      );
      res.json({ product });
    } catch (err) {
      next(err);
    }
  },
);

productsRouter.post(
  "/:id/archive",
  requireAuth,
  requireRoles("workshop"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const product = await productsService.setProductStatus(
        user,
        req.params.id,
        "archived",
      );
      res.json({ product });
    } catch (err) {
      next(err);
    }
  },
);

import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import {
  requireIdempotencyKey,
  type IdempotentRequest,
} from "../middleware/idempotency.js";
import { validate } from "../middleware/validate.js";
import * as scrapService from "../services/scrap.service.js";

const karatEnum = z.union([
  z.literal(14),
  z.literal(18),
  z.literal(21),
  z.literal(22),
  z.literal(24),
]);

const submitSchema = z
  .object({
    workshopId: z.string().uuid().optional(),
    workshopIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    estimatedWeightGrams: z.number().positive(),
    estimatedKarat: karatEnum,
    description: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
    currency: z.enum(["USD", "SYP", "LBP"]).optional(),
  })
  .refine((body) => Boolean(body.workshopId) || (body.workshopIds?.length ?? 0) > 0, {
    message: "Select at least one workshop",
  });

const quoteSchema = z.object({
  assayedWeightGrams: z.number().positive(),
  assayedKarat: karatEnum,
  refiningFeeCents: z.number().int().nonnegative(),
  quoteNotes: z.string().max(1000).optional(),
});

const declineSchema = z.object({
  reason: z.string().min(3).max(500),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const settleSchema = z.object({
  method: z.enum(["cash", "credit"]),
  creditOrderId: z.string().uuid().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z
    .enum([
      "submitted",
      "quoted",
      "accepted",
      "declined",
      "rejected",
      "settled",
      "cancelled",
    ])
    .optional(),
});

export const scrapRouter = Router();

scrapRouter.use(requireAuth);

scrapRouter.post(
  "/",
  requireRoles("retailer"),
  requireVerified,
  validate({ body: submitSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scraps = await scrapService.submitScrap(user, req.body);
      res.status(201).json({ scraps, scrap: scraps[0] });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.get(
  "/",
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const status = (req.query as { status?: string }).status;
      const list = await scrapService.listScrap(user, status);
      res.json({ scraps: list });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.get(
  "/:id",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.getScrap(user, req.params.id);
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.get(
  "/:id/credit-orders",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const orders = await scrapService.listCreditOrders(user, req.params.id);
      res.json({ orders });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/quote",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams, body: quoteSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.quoteScrap(
        user,
        req.params.id,
        req.body,
      );
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/decline",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams, body: declineSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.declineScrap(
        user,
        req.params.id,
        req.body.reason,
      );
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/accept",
  requireRoles("retailer", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.acceptScrap(user, req.params.id);
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/reject",
  requireRoles("retailer", "admin"),
  requireVerified,
  validate({ params: idParams, body: rejectSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.rejectScrapQuote(
        user,
        req.params.id,
        req.body.reason,
      );
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/cancel",
  requireRoles("retailer", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const scrap = await scrapService.cancelScrap(user, req.params.id);
      res.json({ scrap });
    } catch (err) {
      next(err);
    }
  },
);

scrapRouter.post(
  "/:id/settle",
  requireRoles("workshop", "admin"),
  requireVerified,
  requireIdempotencyKey,
  validate({ params: idParams, body: settleSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await scrapService.settleScrap(user, req.params.id, {
        ...req.body,
        idempotencyKey: (req as IdempotentRequest).idempotencyKey,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

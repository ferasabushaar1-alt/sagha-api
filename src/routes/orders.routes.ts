import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import { requireIdempotencyKey, type IdempotentRequest } from "../middleware/idempotency.js";
import { validate } from "../middleware/validate.js";
import * as invoiceService from "../services/invoice.service.js";
import * as ordersService from "../services/orders.service.js";

const placeSchema = z.object({
  workshopId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  /** Ignored — server locks active official/live spot at checkout. */
  goldSpotPriceCentsPerGram: z.number().int().positive().optional(),
  currency: z.enum(["USD", "SYP", "LBP"]).optional(),
  notes: z.string().optional(),
  /** Optional body mirror of Idempotency-Key header */
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const paymentSchema = z.object({
  paymentStatus: z.enum(["unpaid", "partial", "paid", "refunded"]),
  paymentProofPath: z.string().optional(),
  /** Optional cents for partial payments; paid settles remaining if omitted */
  amountCents: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z
    .enum(["pending", "confirmed", "fulfilled", "completed", "cancelled"])
    .optional(),
});

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

ordersRouter.post(
  "/",
  requireRoles("retailer"),
  requireVerified,
  validate({ body: placeSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const headerKey = req.get("idempotency-key")?.trim();
      const idempotencyKey =
        headerKey ||
        (req.body as { idempotencyKey?: string }).idempotencyKey;
      const result = await ordersService.placeOrder(user, {
        ...req.body,
        idempotencyKey,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.get(
  "/",
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const status = (req.query as { status?: string }).status;
      const list = await ordersService.listOrders(user, status);
      res.json({ orders: list });
    } catch (err) {
      next(err);
    }
  },
);

/** Manually sweep expired pending stock reservations (also runs on a timer). */
ordersRouter.post(
  "/expire-stale",
  requireRoles("admin"),
  async (_req, res, next) => {
    try {
      const result = await ordersService.expireStalePendingOrders();
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.get(
  "/:id",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await ordersService.getOrder(user, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.get(
  "/:id/invoice.pdf",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const { buffer, filename } = await invoiceService.buildOrderInvoicePdf(
        user,
        req.params.id,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  "/:id/confirm",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const order = await ordersService.confirmOrder(user, req.params.id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  "/:id/fulfill",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const order = await ordersService.fulfillOrder(user, req.params.id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  "/:id/complete",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const order = await ordersService.completeOrder(user, req.params.id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.post(
  "/:id/cancel",
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const order = await ordersService.cancelOrder(user, req.params.id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.patch(
  "/:id/payment",
  requireRoles("workshop", "admin"),
  requireVerified,
  requireIdempotencyKey,
  validate({ params: idParams, body: paymentSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const order = await ordersService.updatePayment(user, req.params.id, {
        ...req.body,
        idempotencyKey: (req as IdempotentRequest).idempotencyKey,
      });
      res.json({ order });
    } catch (err) {
      next(err);
    }
  },
);

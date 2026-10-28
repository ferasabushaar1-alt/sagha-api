import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as returnsService from "../services/returns.service.js";

const createSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().min(3),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().positive(),
        conditionNotes: z.string().optional(),
      }),
    )
    .min(1),
});

const rejectSchema = z.object({
  reason: z.string().min(3),
});

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z
    .enum([
      "requested",
      "approved",
      "rejected",
      "received",
      "refunded",
      "cancelled",
    ])
    .optional(),
});

export const returnsRouter = Router();

returnsRouter.use(requireAuth);

returnsRouter.post(
  "/",
  requireRoles("retailer"),
  requireVerified,
  validate({ body: createSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await returnsService.requestReturn(user, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.get(
  "/",
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const status = (req.query as { status?: string }).status;
      const list = await returnsService.listReturns(user, status);
      res.json({ returns: list });
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.get(
  "/:id",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await returnsService.getReturn(user, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.post(
  "/:id/approve",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const ret = await returnsService.approveReturn(user, req.params.id);
      res.json({ return: ret });
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.post(
  "/:id/reject",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams, body: rejectSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const ret = await returnsService.rejectReturn(
        user,
        req.params.id,
        req.body.reason,
      );
      res.json({ return: ret });
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.post(
  "/:id/receive",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const ret = await returnsService.receiveReturn(user, req.params.id);
      res.json({ return: ret });
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.post(
  "/:id/refund",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const ret = await returnsService.refundReturn(user, req.params.id);
      res.json({ return: ret });
    } catch (err) {
      next(err);
    }
  },
);

returnsRouter.post(
  "/:id/cancel",
  requireRoles("retailer", "admin"),
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const ret = await returnsService.cancelReturn(user, req.params.id);
      res.json({ return: ret });
    } catch (err) {
      next(err);
    }
  },
);

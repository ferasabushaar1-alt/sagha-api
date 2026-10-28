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
import {
  archiveSettlement,
  rememberArchive,
} from "../services/archive.service.js";
import * as creditService from "../services/credit.service.js";

const idParams = z.object({ id: z.string().uuid() });

const settleSchema = z.object({
  /** Major currency units, e.g. 150.50 */
  amount: z.number().positive(),
  orderId: z.string().uuid().optional(),
  note: z.string().max(500).optional(),
});

const limitSchema = z.object({
  /** null clears the limit (unlimited) */
  creditLimit: z.number().nonnegative().nullable(),
});

export const creditRouter = Router();

creditRouter.use(requireAuth);

creditRouter.get("/", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const accounts = await creditService.listAccounts(user);
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

creditRouter.get(
  "/:id",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const detail = await creditService.getAccountDetail(user, req.params.id);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

creditRouter.post(
  "/:id/settle",
  requireRoles("workshop", "admin"),
  requireVerified,
  requireIdempotencyKey,
  validate({ params: idParams, body: settleSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await creditService.recordSettlement(user, req.params.id, {
        amountMajor: req.body.amount,
        orderId: req.body.orderId,
        note: req.body.note,
        idempotencyKey: (req as IdempotentRequest).idempotencyKey,
      });
      if (result.entry) {
        await rememberArchive(
          archiveSettlement(result.entry, result.account, user.id),
        );
      }
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

creditRouter.patch(
  "/:id/limit",
  requireRoles("workshop", "admin"),
  requireVerified,
  validate({ params: idParams, body: limitSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const account = await creditService.setCreditLimit(
        user,
        req.params.id,
        req.body.creditLimit,
      );
      res.json({ account });
    } catch (err) {
      next(err);
    }
  },
);

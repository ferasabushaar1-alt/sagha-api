import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as fxService from "../services/fx.service.js";

const publishSchema = z.object({
  currency: z.enum(["SYP", "LBP"]),
  /** Major units of this currency per 1 USD */
  unitsPerUsd: z.number().positive(),
  notes: z.string().max(500).optional(),
});

export const fxRouter = Router();

fxRouter.use(requireAuth);

fxRouter.get("/", async (_req, res, next) => {
  try {
    const rates = await fxService.getFxSnapshot();
    res.json({ rates });
  } catch (err) {
    next(err);
  }
});

fxRouter.get(
  "/history",
  requireRoles("admin"),
  async (_req, res, next) => {
    try {
      const history = await fxService.listFxHistory();
      res.json({ rates: history });
    } catch (err) {
      next(err);
    }
  },
);

fxRouter.post(
  "/",
  requireRoles("admin"),
  validate({ body: publishSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const rate = await fxService.publishFxRate(user, req.body);
      const rates = await fxService.getFxSnapshot();
      res.status(201).json({ rate, rates });
    } catch (err) {
      next(err);
    }
  },
);

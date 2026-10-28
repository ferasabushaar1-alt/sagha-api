import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as supportService from "../services/support.service.js";

const inquirySchema = z.object({
  message: z.string().trim().min(24).max(4000),
});

export const supportRouter = Router();

supportRouter.use(requireAuth);

supportRouter.post(
  "/",
  validate({ body: inquirySchema }),
  async (req, res, next) => {
    try {
      const inquiry = await supportService.createSupportInquiry(
        (req as AuthedRequest).user,
        req.body.message,
      );
      res.status(201).json({ inquiry });
    } catch (err) {
      next(err);
    }
  },
);

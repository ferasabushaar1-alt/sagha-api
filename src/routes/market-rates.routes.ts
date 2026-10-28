import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  type AuthedRequest,
} from "../middleware/auth.js";
import { badRequest } from "../lib/errors.js";
import {
  marketSheetPublicPath,
  marketSheetUpload,
} from "../lib/marketSheetUpload.js";
import * as marketRatesService from "../services/market-rates.service.js";

export const marketRatesRouter = Router();

marketRatesRouter.use(requireAuth);

/**
 * GET /api/market-rates
 * Official admin rate when published; otherwise live feed / fallback.
 */
marketRatesRouter.get(
  "/",
  requireRoles("retailer", "workshop", "admin"),
  async (_req, res, next) => {
    try {
      const rates = await marketRatesService.getMarketRates();
      res.json({ rates });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/market-rates/history
 * Recent official rates (admin).
 */
marketRatesRouter.get(
  "/history",
  requireRoles("admin"),
  async (_req, res, next) => {
    try {
      const history = await marketRatesService.listOfficialRates(30);
      res.json({ rates: history });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/market-rates/report.pdf
 * PDF of current official price + verification image.
 */
marketRatesRouter.get(
  "/report.pdf",
  requireRoles("retailer", "workshop", "admin"),
  async (_req, res, next) => {
    try {
      const { buffer, filename } = await marketRatesService.buildOfficialRatePdf();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`,
      );
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

const publishBody = z.object({
  spotUsdPerGramFine: z.coerce.number().positive(),
  notes: z.string().max(500).optional(),
});

/**
 * POST /api/market-rates/official
 * Admin publishes a new official spot (multipart: sheet image optional).
 * Fields: spotUsdPerGramFine, notes?, sheet? (file)
 */
marketRatesRouter.post(
  "/official",
  requireRoles("admin"),
  (req, res, next) => {
    marketSheetUpload.single("sheet")(req, res, (err) => {
      if (err) {
        if (err instanceof Error && err.message === "INVALID_IMAGE_TYPE") {
          return next(badRequest("Image must be jpeg, png, webp, or gif"));
        }
        if (err && typeof err === "object" && "code" in err) {
          const code = (err as { code?: string }).code;
          if (code === "LIMIT_FILE_SIZE") {
            return next(badRequest("Image must be 5MB or smaller"));
          }
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const parsed = publishBody.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues.map((i) => i.message).join("; "),
          "VALIDATION_ERROR",
        );
      }

      const file = req.file;
      const verificationImagePath = file
        ? marketSheetPublicPath(file.filename)
        : null;

      const admin = (req as AuthedRequest).user;
      const rate = await marketRatesService.publishOfficialRate(admin, {
        spotUsdPerGramFine: parsed.data.spotUsdPerGramFine,
        notes: parsed.data.notes,
        verificationImagePath,
      });

      const rates = await marketRatesService.getMarketRates();
      res.status(201).json({ rate, rates });
    } catch (err) {
      next(err);
    }
  },
);

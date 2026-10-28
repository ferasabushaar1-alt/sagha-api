import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireVerified, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  archiveSource,
  collectResolved,
  listArchives,
  type ArchiveKind,
} from "../services/archive.service.js";

export const archiveRouter = Router();

const listQuery = z.object({
  kind: z.enum(["stolen_report", "scrap_intake", "invoice", "settlement"]).optional(),
  q: z.string().trim().max(120).optional(),
  country: z.enum(["SY", "LB"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["newest", "heaviest"]).optional(),
});

const fileSchema = z.object({
  kind: z.enum(["stolen_report", "scrap_intake", "invoice", "settlement"]),
  sourceId: z.string().uuid(),
});

archiveRouter.get(
  "/",
  requireAuth,
  requireVerified,
  validate({ query: listQuery }),
  async (req, res, next) => {
    try {
      const query = req.query as unknown as z.infer<typeof listQuery>;
      const records = await listArchives((req as AuthedRequest).user, query);
      res.json({ archives: records });
    } catch (err) {
      next(err);
    }
  },
);

archiveRouter.post(
  "/",
  requireAuth,
  requireVerified,
  validate({ body: fileSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof fileSchema>;
      const archive = await archiveSource(
        (req as AuthedRequest).user,
        body.kind as ArchiveKind,
        body.sourceId,
      );
      res.status(201).json({ archive });
    } catch (err) {
      next(err);
    }
  },
);

archiveRouter.post("/collect", requireAuth, requireVerified, async (req, res, next) => {
  try {
    const filed = await collectResolved((req as AuthedRequest).user);
    res.json({ filed });
  } catch (err) {
    next(err);
  }
});

import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { addStolenSubscriber } from "../lib/stolen-broadcast.js";
import { stolenUpload } from "../lib/stolenUpload.js";
import {
  optionalAuth,
  requireAuth,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createStolenReport,
  getStolenReport,
  listStolenAlerts,
  listStolenReports,
  markStolenAlertsSeen,
  openStolenContact,
  recoverStolenReport,
  stolenInvoiceAbsolute,
} from "../services/stolen.service.js";

export const stolenRouter = Router();

const createSchema = z.object({
  kind: z.enum(["stolen", "lost"]),
  description: z.string().trim().min(8).max(2000),
  weightGrams: z.coerce.number().positive().max(100000),
  karat: z.coerce.number().int(),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  country: z.enum(["SY", "LB"]),
  city: z.string().trim().min(1).max(120),
  location: z.string().trim().max(300).optional(),
  invoiceReference: z.string().trim().max(120).optional(),
  contactName: z.string().trim().min(2).max(160),
  contactPhone: z.string().trim().min(6).max(40),
  contactEmail: z.string().trim().email().max(160),
});

const listQuery = z.object({
  country: z.enum(["SY", "LB"]).optional(),
  city: z.string().trim().max(120).optional(),
  karat: z.coerce.number().int().optional(),
  status: z.enum(["active", "recovered", "all"]).optional(),
  q: z.string().trim().max(120).optional(),
  minWeight: z.coerce.number().nonnegative().optional(),
  maxWeight: z.coerce.number().nonnegative().optional(),
  incidentFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  incidentTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["newest", "heaviest"]).optional(),
});

const seenSchema = z.object({
  ids: z.array(z.string().min(1)).max(50).optional(),
});

function uploaded(
  req: Request,
): { photo?: Express.Multer.File; invoice?: Express.Multer.File } {
  const files = req.files as
    | { photo?: Express.Multer.File[]; invoice?: Express.Multer.File[] }
    | undefined;
  return { photo: files?.photo?.[0], invoice: files?.invoice?.[0] };
}

function unlinkUploads(req: Request) {
  const { photo, invoice } = uploaded(req);
  for (const file of [photo, invoice]) {
    if (file) fs.unlink(file.path, () => {});
  }
}

function acceptUpload(req: Request, res: Response, next: NextFunction) {
  stolenUpload.fields([
    { name: "photo", maxCount: 1 },
    { name: "invoice", maxCount: 1 },
  ])(req, res, (err: unknown) => {
    if (err) {
      const message =
        err instanceof Error && err.message === "INVALID_IMAGE_TYPE"
          ? "Photograph and invoice proof must be jpeg, png, webp, or gif"
          : "Upload failed. Each file must be an image under 5 MB";
      return next(badRequest(message));
    }
    validate({ body: createSchema })(req, res, (verr) => {
      if (verr) {
        unlinkUploads(req);
        return next(verr);
      }
      const { photo } = uploaded(req);
      if (!photo) {
        unlinkUploads(req);
        return next(badRequest("Photograph is required"));
      }
      next();
    });
  });
}

stolenRouter.get(
  "/stream",
  requireAuth,
  (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`: ok\n\n`);
    const stop = addStolenSubscriber(user.id, res);
    const beat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 25000);
    req.on("close", () => {
      clearInterval(beat);
      stop();
    });
  },
);

stolenRouter.get("/alerts", requireAuth, async (req, res, next) => {
  try {
    const alerts = await listStolenAlerts((req as AuthedRequest).user.id);
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

stolenRouter.post(
  "/alerts/seen",
  requireAuth,
  validate({ body: seenSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof seenSchema>;
      await markStolenAlertsSeen((req as AuthedRequest).user.id, body.ids);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

stolenRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const reports = await listStolenReports(query);
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

stolenRouter.post(
  "/",
  requireAuth,
  requireVerified,
  acceptUpload,
  async (req, res, next) => {
    try {
      const { photo, invoice } = uploaded(req);
      if (!photo) throw badRequest("Photograph is required");
      const body = req.body as z.infer<typeof createSchema>;
      const report = await createStolenReport(
        (req as AuthedRequest).user,
        body,
        { photoName: photo.filename, invoiceName: invoice?.filename },
      );
      res.status(201).json({ report });
    } catch (err) {
      unlinkUploads(req);
      next(err);
    }
  },
);

stolenRouter.get("/:id/invoice", requireAuth, requireVerified, async (req, res, next) => {
  try {
    const full = await stolenInvoiceAbsolute(
      (req as AuthedRequest).user,
      String(req.params.id),
    );
    const ext = path.extname(full).toLowerCase();
    const type =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/jpeg";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    next(err);
  }
});

stolenRouter.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const viewer = (req as AuthedRequest).user;
    const report = await getStolenReport(String(req.params.id), viewer);
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

stolenRouter.post(
  "/:id/contact",
  requireAuth,
  requireVerified,
  async (req, res, next) => {
    try {
      const contact = await openStolenContact(
        (req as AuthedRequest).user,
        String(req.params.id),
      );
      res.json({ contact });
    } catch (err) {
      next(err);
    }
  },
);

stolenRouter.post("/:id/recover", requireAuth, async (req, res, next) => {
  try {
    const report = await recoverStolenReport(
      (req as AuthedRequest).user,
      String(req.params.id),
    );
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

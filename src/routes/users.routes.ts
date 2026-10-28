import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { avatarUpload } from "../lib/avatarUpload.js";
import { badRequest } from "../lib/errors.js";
import {
  requireAuth,
  requireRoles,
  requireVerified,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as usersService from "../services/users.service.js";

const docsSchema = z.object({
  licenseNumber: z.string().optional(),
  taxId: z.string().optional(),
  idDocumentPath: z.string().optional(),
  licenseDocumentPath: z.string().optional(),
  country: z.enum(["SY", "LB"]).optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().trim().max(40).optional(),
});

const verifySchema = z.object({
  notes: z.string().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(3),
});

const idParams = z.object({ id: z.string().uuid() });

export const usersRouter = Router();

usersRouter.use(requireAuth);

function uploadAvatarMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  avatarUpload.single("avatar")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(badRequest("Image must be 2MB or smaller"));
        return;
      }
      next(badRequest(err.message));
      return;
    }
    if (err instanceof Error && err.message === "INVALID_IMAGE_TYPE") {
      next(
        badRequest("Only JPEG, PNG, WebP, and GIF images are allowed"),
      );
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

usersRouter.post(
  "/me/avatar",
  uploadAvatarMiddleware,
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const file = req.file;
      if (!file) {
        throw badRequest('Missing file field "avatar"');
      }
      const avatarPath = `/media/avatars/${file.filename}`;
      const updated = await usersService.updateAvatar(user, avatarPath);
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.patch(
  "/me/verification-docs",
  validate({ body: docsSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const updated = await usersService.updateVerificationDocs(user, req.body);
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get(
  "/pending",
  requireRoles("admin"),
  async (_req, res, next) => {
    try {
      const list = await usersService.listPendingVerifications();
      res.json({ users: list });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.post(
  "/:id/verify",
  requireRoles("admin"),
  validate({ params: idParams, body: verifySchema }),
  async (req, res, next) => {
    try {
      const admin = (req as AuthedRequest).user;
      const updated = await usersService.verifyUser(
        admin,
        req.params.id,
        req.body.notes,
      );
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.post(
  "/:id/reject",
  requireRoles("admin"),
  validate({ params: idParams, body: rejectSchema }),
  async (req, res, next) => {
    try {
      const admin = (req as AuthedRequest).user;
      const updated = await usersService.rejectUser(
        admin,
        req.params.id,
        req.body.reason,
      );
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.post(
  "/:id/suspend",
  requireRoles("admin"),
  validate({
    params: idParams,
    body: z.object({ reason: z.string().optional() }),
  }),
  async (req, res, next) => {
    try {
      const admin = (req as AuthedRequest).user;
      const updated = await usersService.suspendUser(
        admin,
        req.params.id,
        req.body.reason,
      );
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get(
  "/:id/card",
  requireVerified,
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const card = await usersService.getMemberCard(
        (req as AuthedRequest).user,
        req.params.id,
      );
      res.json({ user: card });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get(
  "/:id",
  requireRoles("admin"),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = await usersService.getUserById(req.params.id);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  },
);

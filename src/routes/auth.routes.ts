import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { clearAuthCookie, setAuthCookie } from "../lib/auth-cookie.js";
import { publicUser } from "../lib/serialize.js";
import * as usersService from "../services/users.service.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().min(8).optional(),
  role: z.enum(["workshop", "retailer"]),
  fullName: z.string().min(2),
  businessName: z.string().min(2),
  country: z.enum(["SY", "LB"]).optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  licenseNumber: z.string().optional(),
  taxId: z.string().optional(),
  idDocumentPath: z.string().optional(),
  licenseDocumentPath: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  "/register",
  validate({ body: registerSchema }),
  async (req, res, next) => {
    try {
      const result = await usersService.register(req.body);
      res.setHeader("Cache-Control", "no-store");
      setAuthCookie(res, result.token);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/login",
  validate({ body: loginSchema }),
  async (req, res, next) => {
    try {
      const result = await usersService.login(req.body.email, req.body.password);
      res.setHeader("Cache-Control", "no-store");
      setAuthCookie(res, result.token);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/forgot-password",
  validate({
    body: z.object({
      email: z.string().email(),
    }),
  }),
  async (req, res, next) => {
    try {
      await usersService.requestPasswordReset(req.body.email);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/reset-password",
  validate({
    body: z.object({
      token: z.string().trim().min(20).max(200),
      password: z.string().min(8).max(200),
    }),
  }),
  async (req, res, next) => {
    try {
      await usersService.resetPassword(req.body.token, req.body.password);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = (req as AuthedRequest).user;
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: publicUser(user) });
});

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(200),
});

authRouter.post(
  "/account/delete",
  requireAuth,
  validate({ body: deleteAccountSchema }),
  async (req, res, next) => {
    try {
      await usersService.deleteOwnAccount(
        (req as AuthedRequest).user,
        req.body.password,
      );
      clearAuthCookie(res);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    await usersService.revokeSessions((req as AuthedRequest).user.id);
    clearAuthCookie(res);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

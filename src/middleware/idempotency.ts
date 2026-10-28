import type { NextFunction, Request, Response } from "express";
import { badRequest } from "../lib/errors.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type IdempotentRequest = Request & { idempotencyKey: string };

export function requireIdempotencyKey(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const key = req.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) {
    return next(
      badRequest("Idempotency-Key header is required (8–128 characters)"),
    );
  }
  (req as IdempotentRequest).idempotencyKey = key;
  next();
}

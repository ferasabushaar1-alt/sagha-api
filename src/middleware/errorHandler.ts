import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code ?? "APP_ERROR",
      },
    });
  }

  // Unique constraint (Postgres 23505 or SQLite UNIQUE)
  if (err && typeof err === "object") {
    const code = "code" in err ? String((err as { code: unknown }).code) : "";
    const message =
      "message" in err ? String((err as { message: unknown }).message) : "";
    if (
      code === "23505" ||
      code === "SQLITE_CONSTRAINT_UNIQUE" ||
      code.includes("CONSTRAINT") ||
      /unique/i.test(message)
    ) {
      return res.status(409).json({
        error: { message: "Resource already exists", code: "CONFLICT" },
      });
    }
  }

  console.error(err);
  return res.status(500).json({
    error: { message: "Internal server error", code: "INTERNAL" },
  });
}

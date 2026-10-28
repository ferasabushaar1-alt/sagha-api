import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, type User, type UserRole } from "../db/schema.js";
import { readAuthCookie, setAuthCookie } from "../lib/auth-cookie.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifyToken } from "../lib/jwt.js";

export type AuthedRequest = Request & { user: User };

/**
 * HttpOnly cookie first, then a Bearer token. Query-string tokens are ignored.
 * The cookie wins when both are present so a script cannot override the session.
 */
export function readSessionToken(req: Request): string | null {
  const cookie = readAuthCookie(req);
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const bearer = header.slice(7).trim();
  if (!bearer.includes(".")) return null;
  return bearer;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readSessionToken(req);
    if (!token) throw unauthorized("Missing Bearer token");
    const payload = verifyToken(token);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user || !user.isActive || payload.sv !== user.sessionVersion) {
      throw unauthorized("Invalid session");
    }
    if (!readAuthCookie(req)) setAuthCookie(res, token);

    (req as AuthedRequest).user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Attaches a user when the bearer token is valid. Public routes stay anonymous otherwise. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const token = readSessionToken(req);
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (user?.isActive && payload.sv === user.sessionVersion) {
      (req as AuthedRequest).user = user;
    }
  } catch {
    /* A bad token must not block the public registry. */
  }
  next();
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role as UserRole)) {
      return next(forbidden(`Requires role: ${roles.join(" | ")}`));
    }
    next();
  };
}

export function requireVerified(req: Request, _res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user.role === "admin") return next();
  if (user.verificationStatus !== "verified") {
    return next(
      forbidden("Account must be verified before performing this action"),
    );
  }
  next();
}

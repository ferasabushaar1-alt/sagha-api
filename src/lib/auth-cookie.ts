import type { Request, Response } from "express";
import { tokenMaxAgeSeconds } from "./jwt.js";

export const AUTH_COOKIE = "sagha_token";

export function readAuthCookie(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== AUTH_COOKIE) continue;
    const value = decodeURIComponent(rest.join("=")).trim();
    if (!value || !value.includes(".")) return null;
    return value;
  }
  return null;
}

export function setAuthCookie(res: Response, token: string) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${tokenMaxAgeSeconds()}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(res: Response) {
  const parts = [
    `${AUTH_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

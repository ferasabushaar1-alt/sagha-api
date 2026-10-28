import jwt from "jsonwebtoken";
import type { UserRole } from "../db/schema.js";

export type AuthTokenPayload = {
  sub: string;
  role: UserRole;
  email: string;
  /** users.session_version at issue time. Logout and suspension increment it. */
  sv: number;
};

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is required");
  return s;
}

const DEFAULT_TTL = "12h";

/** Cookie Max-Age, aligned with the JWT lifetime. */
export function tokenMaxAgeSeconds(): number {
  const raw = (process.env.JWT_EXPIRES_IN ?? DEFAULT_TTL).trim();
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) return 12 * 60 * 60;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return amount * multiplier;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, secret(), {
    expiresIn: (process.env.JWT_EXPIRES_IN ??
      DEFAULT_TTL) as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, secret(), {
    algorithms: ["HS256"],
  }) as AuthTokenPayload;
  return decoded;
}

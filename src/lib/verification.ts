import type { User } from "../db/schema.js";
import { forbidden } from "./errors.js";

/** Admins may act before a house is verified. Everyone else must be verified. */
export function assertVerified(user: User) {
  if (user.role === "admin") return;
  if (user.verificationStatus !== "verified") {
    throw forbidden("Account must be verified before performing this action");
  }
}

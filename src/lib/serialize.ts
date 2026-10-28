import type { User } from "../db/schema.js";

export function publicUser(user: User) {
  const { passwordHash: _password, sessionVersion: _session, ...rest } = user;
  return rest;
}

const SAMPLE_SECRETS = new Set([
  "dev-secret-change-me-in-production",
  "change-me",
  "secret",
]);

/** Fail fast when a production process is still pointed at the sample secret or has no database. */
export function assertCloudEnv(force = false) {
  if (!force && process.env.NODE_ENV !== "production") return;

  const secret = process.env.JWT_SECRET?.trim() ?? "";
  if (secret.length < 24 || SAMPLE_SECRETS.has(secret)) {
    throw new Error(
      "Set JWT_SECRET to a unique value of at least 24 characters before starting in production.",
    );
  }

  const remote = process.env.LIBSQL_URL?.trim() ?? "";
  const file = process.env.SQLITE_PATH?.trim() || process.env.SAGHA_DATA_DIR?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (/^postgres(ql)?:/i.test(databaseUrl) || /^postgres(ql)?:/i.test(remote)) {
    throw new Error(
      "Sagha stores the ledger in SQLite. Use LIBSQL_URL for Turso, or SQLITE_PATH on one persistent disk.",
    );
  }
  if (remote && !remote.startsWith("file:") && !process.env.LIBSQL_AUTH_TOKEN?.trim()) {
    throw new Error("LIBSQL_AUTH_TOKEN is required when LIBSQL_URL points at Turso.");
  }
  if (!remote && !file) {
    throw new Error("Set SQLITE_PATH on a persistent disk, or LIBSQL_URL for Turso.");
  }
}

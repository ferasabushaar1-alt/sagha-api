import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

function sqliteFile(): string {
  const explicit = process.env.SQLITE_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const root = process.env.SAGHA_DATA_DIR?.trim();
  if (root) return path.resolve(root, "sagha.db");
  return path.resolve(process.cwd(), "data", "sagha.db");
}

function openClient(): { sqlite: Client; label: string } {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (/^postgres(ql)?:/i.test(databaseUrl)) {
    throw new Error(
      "DATABASE_URL is a Postgres connection string. Sagha stores the ledger in SQLite. Use LIBSQL_URL for Turso, or SQLITE_PATH on one persistent disk.",
    );
  }

  const remote = process.env.LIBSQL_URL?.trim();
  if (remote) {
    if (remote.startsWith("file:")) {
      return { sqlite: createClient({ url: remote }), label: remote };
    }
    const authToken = process.env.LIBSQL_AUTH_TOKEN?.trim();
    if (!authToken) {
      throw new Error("LIBSQL_AUTH_TOKEN is required for a remote LIBSQL_URL");
    }
    return { sqlite: createClient({ url: remote, authToken }), label: remote };
  }

  const sqlitePath = sqliteFile();
  const dir = path.dirname(sqlitePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileUrl = `file:${sqlitePath.replace(/\\/g, "/")}`;
  return { sqlite: createClient({ url: fileUrl }), label: sqlitePath };
}

const opened = openClient();

export const sqlite = opened.sqlite;
export const db = drizzle(sqlite, { schema });
export const DB_FILE = opened.label;

/**
 * Enables FK enforcement on this connection.
 * initDatabase calls this after rebuilding tables that still referenced
 * dropped *__old_fx parents. SQLite does not enable foreign keys by default.
 */
export async function enableForeignKeys() {
  await sqlite.execute("PRAGMA foreign_keys = ON");
}

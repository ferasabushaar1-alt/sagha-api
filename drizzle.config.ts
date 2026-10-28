import "dotenv/config";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

const sqlitePath =
  process.env.SQLITE_PATH ?? path.resolve(process.cwd(), "data", "sagha.db");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${sqlitePath.replace(/\\/g, "/")}`,
  },
});

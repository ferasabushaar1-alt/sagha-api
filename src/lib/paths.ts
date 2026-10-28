import "dotenv/config";
import path from "node:path";

/** Volume root in production. Locally this stays the API working directory. */
export function dataRoot(): string {
  const configured = process.env.SAGHA_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return process.cwd();
}

export function publicDir(): string {
  return path.join(dataRoot(), "public");
}

export function privateDir(...parts: string[]): string {
  return path.join(dataRoot(), "private", ...parts);
}

/**
 * Resolve a Unicode TTF that can render Latin + Arabic for invoices.
 * Falls back to PDFKit's built-in Helvetica when no system font is found.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.SAGHA_PDF_FONT,
  // Windows
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\tahoma.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  // macOS
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  // Linux
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
  path.join(os.homedir(), ".fonts", "Arial.ttf"),
].filter(Boolean) as string[];

let cached: string | null | undefined;

export function resolvePdfFontPath(): string | null {
  if (cached !== undefined) return cached;
  for (const candidate of CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {
      // try next
    }
  }
  cached = null;
  return null;
}

import fs from "node:fs";
import path from "node:path";
import multer, { type FileFilterCallback } from "multer";
import type { Request } from "express";

import { publicDir } from "./paths.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const sheetsDir = path.join(publicDir(), "market-sheets");
    fs.mkdirSync(sheetsDir, { recursive: true });
    cb(null, sheetsDir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
      ? ext === ".jpeg"
        ? ".jpg"
        : ext
      : ".jpg";
    cb(null, `sheet-${Date.now()}${safeExt}`);
  },
});

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cb(new Error("INVALID_IMAGE_TYPE"));
    return;
  }
  cb(null, true);
}

export const marketSheetUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

export function marketSheetPublicPath(filename: string) {
  return `/media/market-sheets/${filename}`;
}

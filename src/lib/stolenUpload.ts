import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer, { type FileFilterCallback } from "multer";
import type { Request } from "express";

import { privateDir, publicDir } from "./paths.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const storage = multer.diskStorage({
  destination(_req, file, cb) {
    const dir = file.fieldname === "invoice" ? privateDir("stolen-invoices") : path.join(publicDir(), "stolen");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
      ? ext === ".jpeg"
        ? ".jpg"
        : ext
      : ".jpg";
    cb(null, `stolen-${randomUUID()}${safeExt}`);
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

export const stolenUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
});

export function stolenPhotoPublicPath(filename: string) {
  return `/media/stolen/${path.basename(filename)}`;
}

export function stolenInvoiceFile(filename: string) {
  return path.join(privateDir("stolen-invoices"), path.basename(filename));
}

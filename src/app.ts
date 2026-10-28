import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { publicDir } from "./lib/paths.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.routes.js";
import { chatRouter } from "./routes/chat.routes.js";
import { creditRouter } from "./routes/credit.routes.js";
import { fxRouter } from "./routes/fx.routes.js";
import { marketRatesRouter } from "./routes/market-rates.routes.js";
import { ordersRouter } from "./routes/orders.routes.js";
import { productsRouter } from "./routes/products.routes.js";
import { returnsRouter } from "./routes/returns.routes.js";
import { scrapRouter } from "./routes/scrap.routes.js";
import { archiveRouter } from "./routes/archive.routes.js";
import { stolenRouter } from "./routes/stolen.routes.js";
import { notificationsRouter } from "./routes/notifications.routes.js";
import { supportRouter } from "./routes/support.routes.js";
import { usersRouter } from "./routes/users.routes.js";

/** Explicit allowlist. Never reflects an origin that is not on the list. */
function allowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production") return [];
  return ["http://localhost:3000"];
}

export function createApp() {
  const app = express();

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins().includes(origin)) {
          callback(null, origin);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Product photos and other static media
  app.use("/media", express.static(publicDir()));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "sagha-api", version: "0.1.0" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/returns", returnsRouter);
  app.use("/api/scrap", scrapRouter);
  app.use("/api/stolen", stolenRouter);
  app.use("/api/archives", archiveRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/credit", creditRouter);
  app.use("/api/fx", fxRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/market-rates", marketRatesRouter);

  app.use(errorHandler);
  return app;
}

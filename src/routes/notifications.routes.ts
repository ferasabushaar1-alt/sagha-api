import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { addNotificationSubscriber } from "../lib/notification-hub.js";
import {
  requireAuth,
  requireRoles,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  publishBroadcast,
} from "../services/notifications.service.js";

export const notificationsRouter = Router();

const listQuery = z.object({
  unread: z.enum(["0", "1"]).optional(),
  locale: z.enum(["en", "ar"]).optional(),
});

const readSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
});

const broadcastSchema = z.object({
  type: z.enum([
    "STOLEN_ALERT",
    "NEW_MEMBER",
    "PROFILE_UPDATE",
    "CREDIT_WARNING",
    "ORDER_STATUS",
  ]),
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(1000),
  titleAr: z.string().trim().max(160).optional(),
  messageAr: z.string().trim().max(1000).optional(),
  referenceId: z.string().trim().max(80).optional(),
  referenceKind: z
    .enum(["report", "user", "order", "scrap", "account"])
    .optional(),
  audience: z.enum(["all", "trade", "admin"]).optional(),
});

notificationsRouter.use(requireAuth);

notificationsRouter.get("/stream", (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`: ok\n\n`);
  const stop = addNotificationSubscriber(user.id, res);
  const beat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);
  req.on("close", () => {
    clearInterval(beat);
    stop();
  });
});

notificationsRouter.get("/", validate({ query: listQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const result = await listNotifications(
      (req as AuthedRequest).user,
      query.locale ?? "en",
      query.unread === "1",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post(
  "/read",
  validate({ body: readSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof readSchema>;
      await markNotificationsRead((req as AuthedRequest).user, body.ids);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

notificationsRouter.post("/read-all", async (req, res, next) => {
  try {
    await markAllNotificationsRead((req as AuthedRequest).user);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post(
  "/broadcast",
  requireRoles("admin"),
  validate({ body: broadcastSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof broadcastSchema>;
      const notification = await publishBroadcast(body);
      res.status(201).json({ notification });
    } catch (err) {
      next(err);
    }
  },
);

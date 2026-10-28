import { Router } from "express";
import { z } from "zod";
import {
  requireAuth,
  requireRoles,
  type AuthedRequest,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as chatService from "../services/chat.service.js";

const idParams = z.object({ id: z.string().uuid() });

const startSchema = z
  .object({
    workshopId: z.string().uuid().optional(),
    retailerId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    orderId: z.string().uuid().optional(),
  })
  .refine((b) => b.workshopId || b.retailerId, {
    message: "workshopId or retailerId is required",
  });

const sendSchema = z.object({
  messageText: z.string().min(1).max(4000),
});

export const chatRouter = Router();

chatRouter.use(requireAuth);
chatRouter.use(requireRoles("retailer", "workshop", "admin"));

/** List conversations for the current user (admin sees all). */
chatRouter.get("/", async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const list = await chatService.listConversations(user);
    res.json({ conversations: list });
  } catch (err) {
    next(err);
  }
});

/** Start or reopen a conversation between a retailer and a workshop. */
chatRouter.post(
  "/",
  requireRoles("retailer", "workshop", "admin"),
  validate({ body: startSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const conversation = await chatService.startOrGetConversation(
        user,
        req.body,
      );
      res.status(201).json({ conversation });
    } catch (err) {
      next(err);
    }
  },
);

/** Fetch a single conversation. */
chatRouter.get(
  "/:id",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const conversation = await chatService.getConversation(
        user,
        req.params.id,
      );
      res.json({ conversation });
    } catch (err) {
      next(err);
    }
  },
);

/** List messages in a conversation (oldest first). */
chatRouter.get(
  "/:id/messages",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await chatService.listMessages(user, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/** Record that this house has read the thread. */
chatRouter.post(
  "/:id/read",
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      await chatService.markConversationRead(user, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/** Send a message in a conversation. */
chatRouter.post(
  "/:id/messages",
  requireRoles("retailer", "workshop"),
  validate({ params: idParams, body: sendSchema }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const message = await chatService.sendMessage(
        user,
        req.params.id,
        req.body.messageText,
      );
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  },
);

/** Delete a conversation (and its messages). */
chatRouter.delete(
  "/:id",
  requireRoles("retailer", "workshop", "admin"),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = await chatService.deleteConversation(user, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

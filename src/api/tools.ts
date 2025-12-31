import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "../db/client";
import { ApiError } from "../core/errors";
import { requireMenuForRestaurant, requireRestaurantById } from "../core/tenant";
import { buildDraftSummary, parseMenu, searchMenu, Selection } from "../core/menu";
import { parseOrThrow } from "./validation";
import { buildToastOrderPayload } from "../toast/mapper";
import { priceOrder, submitOrder } from "../toast/orders";
import { buildCloverOrderPayload } from "../clover/mapper";
import { priceOrderClover, submitOrderClover } from "../clover/orders";
import { getOrderByClientOrderId } from "../core/idempotency";
import { getTwilioClient } from "../core/twilio";
import { config } from "../core/config";

export const toolsRouter = Router();

const restaurantIdQuerySchema = z.object({
  restaurant_id: z.string().uuid(),
});

const searchSchema = z.object({
  restaurant_id: z.string().uuid(),
  query: z.string().min(1),
});

const selectionSchema: z.ZodType<Selection> = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1),
  modifiers: z
    .array(
      z.object({
        groupId: z.string().min(1),
        optionIds: z.array(z.string().min(1)),
      })
    )
    .default([]),
  specialInstructions: z.string().min(1).optional(),
});

const draftSchema = z.object({
  restaurant_id: z.string().uuid(),
  call_id: z.string().uuid(),
  selections: z.array(selectionSchema).min(1),
  notes: z.string().optional(),
  pickup_name: z.string().optional(),
  pickup_phone: z.string().optional(),
  client_order_id: z.string().optional(),
});

const priceSchema = z.object({
  restaurant_id: z.string().uuid(),
  order_id: z.string().uuid(),
});

const submitSchema = z.object({
  restaurant_id: z.string().uuid(),
  order_id: z.string().uuid(),
  client_order_id: z.string().min(1),
});

const sendSmsSchema = z.object({
  to: z.string().min(1),
  message: z.string().min(1),
});

toolsRouter.get("/menu", async (req, res, next) => {
  try {
    const query = parseOrThrow(restaurantIdQuerySchema, req.query);
    await requireRestaurantById(query.restaurant_id);
    const menuRow = await requireMenuForRestaurant(query.restaurant_id);
    const menu = parseMenu(menuRow.normalized_json);

    res.json({
      restaurant_id: query.restaurant_id,
      version: menuRow.version,
      last_sync_at: menuRow.last_sync_at,
      menu,
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/search_menu", async (req, res, next) => {
  try {
    const body = parseOrThrow(searchSchema, req.body);
    await requireRestaurantById(body.restaurant_id);
    const menuRow = await requireMenuForRestaurant(body.restaurant_id);
    const menu = parseMenu(menuRow.normalized_json);

    const matches = searchMenu(menu, body.query, 5);
    const groupIndex = new Map(menu.modifierGroups.map((group) => [group.id, group] as const));
    const optionIndex = new Map(menu.modifierOptions.map((option) => [option.id, option] as const));

    const results = matches.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      priceCents: item.priceCents,
      modifierGroups: item.modifierGroupIds.map((groupId) => {
        const group = groupIndex.get(groupId);
        return {
          id: groupId,
          name: group?.name,
          requiredMin: group?.requiredMin ?? 0,
          requiredMax: group?.requiredMax ?? 0,
          options: (group?.optionIds || []).map((optionId) => {
            const option = optionIndex.get(optionId);
            return {
              id: optionId,
              name: option?.name,
              priceDeltaCents: option?.priceDeltaCents ?? 0,
            };
          }),
        };
      }),
    }));

    res.json({ results });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/draft_order", async (req, res, next) => {
  try {
    const body = parseOrThrow(draftSchema, req.body);
    await requireRestaurantById(body.restaurant_id);

    const callResult = await db.query<{ id: string; restaurant_id: string }>(
      "SELECT id, restaurant_id FROM calls WHERE id = $1",
      [body.call_id]
    );
    const call = callResult.rows[0];
    if (!call || call.restaurant_id !== body.restaurant_id) {
      throw new ApiError(404, "call not found for restaurant");
    }

    const menuRow = await requireMenuForRestaurant(body.restaurant_id);
    const menu = parseMenu(menuRow.normalized_json);
    const draftSummary = buildDraftSummary(menu, body.selections, body.notes, body.pickup_name, body.pickup_phone);

    const orderId = randomUUID();
    const clientOrderId = body.client_order_id || orderId;

    const draftJson = {
      selections: body.selections,
      notes: body.notes,
      pickupName: body.pickup_name,
      pickupPhone: body.pickup_phone,
      summary: draftSummary,
    };

    await db.query(
      "INSERT INTO orders (id, restaurant_id, call_id, status, draft_json, client_order_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [orderId, body.restaurant_id, body.call_id, "draft", draftJson, clientOrderId]
    );

    res.json({
      order_id: orderId,
      draft_summary: draftSummary,
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/price_order", async (req, res, next) => {
  try {
    const body = parseOrThrow(priceSchema, req.body);
    const restaurant = await requireRestaurantById(body.restaurant_id);

    const orderResult = await db.query<{
      id: string;
      restaurant_id: string;
      draft_json: any;
    }>("SELECT id, restaurant_id, draft_json FROM orders WHERE id = $1", [body.order_id]);

    const order = orderResult.rows[0];
    if (!order || order.restaurant_id !== body.restaurant_id) {
      throw new ApiError(404, "order not found for restaurant");
    }

    const menuRow = await requireMenuForRestaurant(body.restaurant_id);
    const selections = order.draft_json?.selections;
    if (!Array.isArray(selections) || selections.length === 0) {
      throw new ApiError(400, "draft selections missing");
    }

    const provider = restaurant.pos_provider || "toast";
    if (provider !== "toast" && provider !== "clover") {
      throw new ApiError(400, `unsupported pos provider: ${provider}`);
    }
    const draftPayload = {
      selections,
      notes: order.draft_json?.notes,
      pickupName: order.draft_json?.pickupName,
      pickupPhone: order.draft_json?.pickupPhone,
    };

    const pricingResponse =
      provider === "clover"
        ? await priceOrderClover(body.restaurant_id, buildCloverOrderPayload(menuRow.normalized_json, draftPayload))
        : await priceOrder(body.restaurant_id, buildToastOrderPayload(menuRow.normalized_json, draftPayload));

    await db.query("UPDATE orders SET priced_json = $1, status = $2 WHERE id = $3", [pricingResponse, "priced", body.order_id]);

    res.json({
      order_id: body.order_id,
      totals: (pricingResponse as any)?.totals || null,
      priced_summary: pricingResponse,
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/submit_order", async (req, res, next) => {
  try {
    const body = parseOrThrow(submitSchema, req.body);
    const restaurant = await requireRestaurantById(body.restaurant_id);

    const existingByClientId = await getOrderByClientOrderId(body.client_order_id);
    if (existingByClientId) {
      if (existingByClientId.toast_order_id) {
        return res.json({
          toast_order_id: existingByClientId.toast_order_id,
          confirmation_text: "Order already submitted.",
        });
      }
      if (existingByClientId.id !== body.order_id) {
        throw new ApiError(409, "client_order_id already used for another order");
      }
    }

    const orderResult = await db.query<{
      id: string;
      restaurant_id: string;
      draft_json: any;
      toast_order_id: string | null;
      client_order_id: string;
    }>(
      "SELECT id, restaurant_id, draft_json, toast_order_id, client_order_id FROM orders WHERE id = $1",
      [body.order_id]
    );

    const order = orderResult.rows[0];
    if (!order || order.restaurant_id !== body.restaurant_id) {
      throw new ApiError(404, "order not found for restaurant");
    }

    if (order.toast_order_id) {
      return res.json({
        toast_order_id: order.toast_order_id,
        confirmation_text: "Order already submitted.",
      });
    }

    if (order.client_order_id !== body.client_order_id) {
      await db.query("UPDATE orders SET client_order_id = $1 WHERE id = $2", [body.client_order_id, body.order_id]);
    }

    const menuRow = await requireMenuForRestaurant(body.restaurant_id);
    const selections = order.draft_json?.selections;
    if (!Array.isArray(selections) || selections.length === 0) {
      throw new ApiError(400, "draft selections missing");
    }

    const provider = restaurant.pos_provider || "toast";
    if (provider !== "toast" && provider !== "clover") {
      throw new ApiError(400, `unsupported pos provider: ${provider}`);
    }
    const draftPayload = {
      selections,
      notes: order.draft_json?.notes,
      pickupName: order.draft_json?.pickupName,
      pickupPhone: order.draft_json?.pickupPhone,
    };

    const submitResponse =
      provider === "clover"
        ? await submitOrderClover(body.restaurant_id, buildCloverOrderPayload(menuRow.normalized_json, draftPayload))
        : await submitOrder(body.restaurant_id, buildToastOrderPayload(menuRow.normalized_json, draftPayload));

    const toastOrderId =
      (submitResponse as any)?.orderGuid ||
      (submitResponse as any)?.order_id ||
      (submitResponse as any)?.orderId ||
      (submitResponse as any)?.id ||
      null;

    await db.query(
      "UPDATE orders SET toast_order_id = $1, status = $2 WHERE id = $3",
      [toastOrderId, "confirmed", body.order_id]
    );

    res.json({
      toast_order_id: toastOrderId,
      confirmation_text: "Order submitted to restaurant.",
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/send_sms", async (req, res, next) => {
  try {
    const body = parseOrThrow(sendSmsSchema, req.body);
    const client = getTwilioClient();

    if (!client || !config.twilioFromNumber) {
      return res.json({
        status: "stubbed",
        message: "twilio credentials missing",
      });
    }

    const message = await client.messages.create({
      to: body.to,
      from: config.twilioFromNumber,
      body: body.message,
    });

    res.json({ status: "sent", sid: message.sid });
  } catch (error) {
    next(error);
  }
});

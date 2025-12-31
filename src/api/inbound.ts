import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client";
import { ApiError } from "../core/errors";
import { getRestaurantByPhone } from "../core/tenant";
import { parseOrThrow } from "./validation";

export const inboundRouter = Router();

const inboundSchema = z.object({
  To: z.string().min(1),
  From: z.string().min(1),
});

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

inboundRouter.post("/inbound", async (req, res, next) => {
  try {
    const body = parseOrThrow(inboundSchema, req.body);
    const restaurant = await getRestaurantByPhone(body.To);
    if (!restaurant) {
      throw new ApiError(404, "restaurant not found for inbound number");
    }

    const callResult = await db.query<{ id: string }>(
      "INSERT INTO calls (restaurant_id, from_number, to_number) VALUES ($1, $2, $3) RETURNING id",
      [restaurant.id, body.From, body.To]
    );
    const callId = callResult.rows[0]?.id;

    // Example: start Vapi with metadata { restaurant_id, call_id } via your telephony layer.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling ${escapeXml(restaurant.name)}. Connecting you now.</Say>
</Response>`;

    res.type("text/xml").status(200).send(twiml);
  } catch (error) {
    next(error);
  }
});

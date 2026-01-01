import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client";
import { ApiError } from "../core/errors";
import { getRestaurantByPhone } from "../core/tenant";
import { parseOrThrow } from "./validation";
import { config } from "../core/config";

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

    const protoHeader = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || "https";
    const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || "";
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const wsProto = proto === "https" ? "wss" : "ws";
    const wsUrl = new URL(`${wsProto}://${host}/twilio-stream`);
    wsUrl.searchParams.set("restaurant_id", restaurant.id);
    if (callId) {
      wsUrl.searchParams.set("call_id", callId);
    }
    wsUrl.searchParams.set("from", body.From);
    wsUrl.searchParams.set("to", body.To);

    const twiml =
      config.vapiApiKey && config.vapiAssistantId
        ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to our AI assistant now.</Say>
  <Connect>
    <Stream url="${escapeXml(wsUrl.toString())}">
      <Parameter name="restaurant_id" value="${escapeXml(restaurant.id)}" />
      <Parameter name="call_id" value="${escapeXml(callId || "")}" />
      <Parameter name="from" value="${escapeXml(body.From)}" />
      <Parameter name="to" value="${escapeXml(body.To)}" />
    </Stream>
  </Connect>
</Response>`
        : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling ${escapeXml(restaurant.name)}. Connecting you now.</Say>
</Response>`;

    res.type("text/xml").status(200).send(twiml);
  } catch (error) {
    next(error);
  }
});

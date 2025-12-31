import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "./validation";
import { ApiError } from "../core/errors";
import { config } from "../core/config";
import { requireRestaurantById } from "../core/tenant";
import { db } from "../db/client";
import { exchangeCloverCode } from "../clover/auth";

export const cloverRouter = Router();

const callbackSchema = z.object({
  code: z.string().optional(),
  merchant_id: z.string().optional(),
  state: z.string().optional(),
  restaurant_id: z.string().uuid().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function resolveRedirectUri(req: { headers: Record<string, string | string[] | undefined> }) {
  if (config.cloverRedirectUri) {
    return config.cloverRedirectUri;
  }
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || "https";
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || "";
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  return `${proto}://${host}/clover/callback`;
}

cloverRouter.get("/clover/callback", async (req, res, next) => {
  try {
    const query = parseOrThrow(callbackSchema, req.query);

    if (query.error) {
      throw new ApiError(400, "clover authorization failed", {
        error: query.error,
        description: query.error_description,
      });
    }

    const code = query.code;
    const merchantId = query.merchant_id;
    const restaurantId = query.restaurant_id || query.state;

    const baseUrl = config.cloverEnvironment.toLowerCase().includes("prod")
      ? config.cloverProdBaseUrl
      : config.cloverSandboxBaseUrl;

    if (!code || !merchantId) {
      const redirectUri = resolveRedirectUri(req);
      const authorizeUrl = config.cloverClientId
        ? `${baseUrl}/oauth/authorize?client_id=${encodeURIComponent(
            config.cloverClientId
          )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(restaurantId || "")}`
        : null;

      res.status(400).json({
        error: "missing code or merchant_id",
        hint: "Authorize the app using Clover OAuth and ensure redirect includes code and merchant_id.",
        authorize_url: authorizeUrl,
      });
      return;
    }

    if (!restaurantId) {
      throw new ApiError(400, "missing restaurant_id", {
        hint: "Pass restaurant_id as state in the OAuth authorize URL.",
      });
    }

    const restaurant = await requireRestaurantById(restaurantId);
    if (restaurant.pos_provider !== "clover") {
      await db.query("UPDATE restaurants SET pos_provider = $1 WHERE id = $2", ["clover", restaurantId]);
    }

    if (!config.cloverClientId || !config.cloverClientSecret) {
      throw new ApiError(500, "clover client credentials not configured");
    }

    const redirectUri = resolveRedirectUri(req);
    const tokenResponse = await exchangeCloverCode({
      baseUrl,
      clientId: config.cloverClientId,
      clientSecret: config.cloverClientSecret,
      code,
      redirectUri,
    });

    const expiresAt = new Date(Date.now() + Number(tokenResponse.expiresIn) * 1000);

    await db.query(
      "INSERT INTO clover_credentials (restaurant_id, merchant_id, client_id, client_secret, environment, access_token, token_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (restaurant_id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret, environment = EXCLUDED.environment, access_token = EXCLUDED.access_token, token_expires_at = EXCLUDED.token_expires_at",
      [
        restaurantId,
        merchantId,
        config.cloverClientId,
        config.cloverClientSecret,
        config.cloverEnvironment,
        tokenResponse.accessToken,
        expiresAt.toISOString(),
      ]
    );

    res.json({
      status: "connected",
      restaurant_id: restaurantId,
      merchant_id: merchantId,
      token_expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

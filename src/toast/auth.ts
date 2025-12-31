import { db } from "../db/client";
import { config } from "../core/config";
import { ApiError } from "../core/errors";
import { logger } from "../core/logger";

export type ToastCredentials = {
  restaurant_id: string;
  restaurant_guid: string;
  client_id: string;
  client_secret: string;
  environment: string;
  access_token: string | null;
  token_expires_at: string | null;
};

function resolveBaseUrl(environment: string): string {
  const normalized = environment.toLowerCase();
  if (normalized.includes("prod")) {
    return config.toastProdBaseUrl;
  }
  return config.toastSandboxBaseUrl;
}

export async function getToastToken(restaurantId: string): Promise<{
  token: string;
  baseUrl: string;
  restaurantGuid: string;
}> {
  const result = await db.query<ToastCredentials>(
    "SELECT restaurant_id, restaurant_guid, client_id, client_secret, environment, access_token, token_expires_at FROM toast_credentials WHERE restaurant_id = $1",
    [restaurantId]
  );
  const creds = result.rows[0];
  if (!creds) {
    throw new ApiError(400, "toast credentials not configured for restaurant");
  }

  const baseUrl = resolveBaseUrl(creds.environment);
  if (config.toastMock) {
    return { token: "mock-token", baseUrl, restaurantGuid: creds.restaurant_guid };
  }

  if (creds.access_token && creds.token_expires_at) {
    const expiresAt = new Date(creds.token_expires_at).getTime();
    if (Date.now() + 60_000 < expiresAt) {
      return { token: creds.access_token, baseUrl, restaurantGuid: creds.restaurant_guid };
    }
  }

  const authUrl = `${baseUrl}/authentication/v1/authentication/login`;
  const body = {
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    userAccessType: "Restaurant",
    restaurantGuid: creds.restaurant_guid,
  };

  const response = await fetch(authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    logger.error({ status: response.status, text }, "toast auth failed");
    throw new ApiError(502, "toast auth failed", { status: response.status, body: payload || text });
  }

  const token = payload?.accessToken || payload?.access_token;
  const expiresIn = payload?.expiresIn || payload?.expires_in || 3600;
  if (!token) {
    throw new ApiError(502, "toast auth response missing token", { body: payload || text });
  }

  const expiresAt = new Date(Date.now() + Number(expiresIn) * 1000);
  await db.query(
    "UPDATE toast_credentials SET access_token = $1, token_expires_at = $2 WHERE restaurant_id = $3",
    [token, expiresAt.toISOString(), restaurantId]
  );

  return { token, baseUrl, restaurantGuid: creds.restaurant_guid };
}

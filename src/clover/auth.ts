import { db } from "../db/client";
import { config } from "../core/config";
import { ApiError } from "../core/errors";
import { logger } from "../core/logger";

export type CloverCredentials = {
  restaurant_id: string;
  merchant_id: string;
  client_id: string;
  client_secret: string;
  environment: string;
  access_token: string | null;
  token_expires_at: string | null;
};

function resolveBaseUrl(environment: string): string {
  const normalized = environment.toLowerCase();
  if (normalized.includes("prod")) {
    return config.cloverProdBaseUrl;
  }
  return config.cloverSandboxBaseUrl;
}

export async function exchangeCloverCode(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const authUrl = `${input.baseUrl}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });

  const response = await fetch(authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    logger.error({ status: response.status, text }, "clover oauth failed");
    throw new ApiError(502, "clover oauth failed", { status: response.status, body: payload || text });
  }

  const token = payload?.access_token || payload?.accessToken;
  const expiresIn = payload?.expires_in || payload?.expiresIn || 3600;
  if (!token) {
    throw new ApiError(502, "clover oauth response missing token", { body: payload || text });
  }

  return { accessToken: token, expiresIn: Number(expiresIn) };
}

export async function getCloverToken(restaurantId: string): Promise<{
  token: string;
  baseUrl: string;
  merchantId: string;
}> {
  const result = await db.query<CloverCredentials>(
    "SELECT restaurant_id, merchant_id, client_id, client_secret, environment, access_token, token_expires_at FROM clover_credentials WHERE restaurant_id = $1",
    [restaurantId]
  );
  const creds = result.rows[0];
  if (!creds) {
    throw new ApiError(400, "clover credentials not configured for restaurant");
  }

  const baseUrl = resolveBaseUrl(creds.environment);
  if (config.cloverMock) {
    return { token: "mock-token", baseUrl, merchantId: creds.merchant_id };
  }

  if (creds.access_token && creds.token_expires_at) {
    const expiresAt = new Date(creds.token_expires_at).getTime();
    if (Date.now() + 60_000 < expiresAt) {
      return { token: creds.access_token, baseUrl, merchantId: creds.merchant_id };
    }
  }

  // If token expired and no refresh flow available, require re-auth via OAuth callback.
  throw new ApiError(401, "clover access token expired; re-authorize the merchant");

  // return { token, baseUrl, merchantId: creds.merchant_id };
}

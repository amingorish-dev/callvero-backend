import { config } from "../core/config";
import { ApiError } from "../core/errors";
import { getCloverToken } from "./auth";

async function postClover(
  baseUrl: string,
  path: string,
  token: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const status = response.status >= 500 ? 502 : 400;
    throw new ApiError(status, "clover request failed", { status: response.status, body: data || text });
  }

  return data || {};
}

export async function priceOrderClover(restaurantId: string, payload: Record<string, unknown>): Promise<unknown> {
  if (config.cloverMock) {
    return {
      pricingMode: "mock",
      totals: {
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    };
  }

  const { token, baseUrl, merchantId } = await getCloverToken(restaurantId);
  // TODO: replace with Clover pricing/validation endpoint once confirmed.
  return postClover(baseUrl, `/v3/merchants/${merchantId}/orders`, token, payload);
}

export async function submitOrderClover(restaurantId: string, payload: Record<string, unknown>): Promise<unknown> {
  if (config.cloverMock) {
    return {
      orderId: `mock-${Date.now()}`,
      status: "SUBMITTED",
    };
  }

  const { token, baseUrl, merchantId } = await getCloverToken(restaurantId);
  // TODO: replace with Clover submit/checkout endpoint once confirmed.
  return postClover(baseUrl, `/v3/merchants/${merchantId}/orders`, token, payload);
}

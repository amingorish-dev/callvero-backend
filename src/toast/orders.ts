import { config } from "../core/config";
import { ApiError } from "../core/errors";
import { getToastToken } from "./auth";

async function postToast(
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
    throw new ApiError(status, "toast request failed", { status: response.status, body: data || text });
  }

  return data || {};
}

export async function priceOrder(restaurantId: string, payload: Record<string, unknown>): Promise<unknown> {
  if (config.toastMock) {
    return {
      pricingMode: "mock",
      totals: {
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    };
  }

  const { token, baseUrl, restaurantGuid } = await getToastToken(restaurantId);
  const payloadWithGuid = { ...payload, restaurantGuid };
  return postToast(baseUrl, "/orders/v2/prices", token, payloadWithGuid);
}

export async function submitOrder(restaurantId: string, payload: Record<string, unknown>): Promise<unknown> {
  if (config.toastMock) {
    return {
      orderGuid: `mock-${Date.now()}`,
      status: "SUBMITTED",
    };
  }

  const { token, baseUrl, restaurantGuid } = await getToastToken(restaurantId);
  const payloadWithGuid = { ...payload, restaurantGuid };
  return postToast(baseUrl, "/orders/v2/orders", token, payloadWithGuid);
}

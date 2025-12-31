import { config } from "../core/config";
import { ApiError } from "../core/errors";
import { buildDraftSummary, parseMenu } from "../core/menu";
import { getCloverToken } from "./auth";
import { buildCloverOrderPayload, type DraftOrder } from "./mapper";

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

export async function priceOrderClover(menuInput: unknown, draft: DraftOrder): Promise<unknown> {
  const menu = parseMenu(menuInput);
  const summary = buildDraftSummary(menu, draft.selections, draft.notes, draft.pickupName, draft.pickupPhone);
  return {
    pricingMode: config.cloverMock ? "mock" : "local",
    totals: {
      subtotalCents: summary.subtotalCents,
      taxCents: 0,
      totalCents: summary.subtotalCents,
    },
    summary,
  };
}

export async function submitOrderClover(
  restaurantId: string,
  menuInput: unknown,
  draft: DraftOrder
): Promise<unknown> {
  if (config.cloverMock) {
    return {
      orderId: `mock-${Date.now()}`,
      status: "SUBMITTED",
    };
  }

  const { token, baseUrl, merchantId } = await getCloverToken(restaurantId);
  const orderPayload = buildCloverOrderPayload(menuInput, draft);

  const orderResponse = await postClover(baseUrl, `/v3/merchants/${merchantId}/orders`, token, {
    title: orderPayload.title,
    note: orderPayload.note,
    phone: orderPayload.phone,
  });

  const orderId =
    (orderResponse as any)?.id ||
    (orderResponse as any)?.orderId ||
    (orderResponse as any)?.order_id ||
    null;
  if (!orderId) {
    throw new ApiError(502, "clover order missing id", { order: orderResponse });
  }

  for (const lineItem of orderPayload.lineItems) {
    const quantity = Math.max(1, Number(lineItem.quantity || 1));
    for (let count = 0; count < quantity; count += 1) {
      const created = await postClover(
        baseUrl,
        `/v3/merchants/${merchantId}/orders/${orderId}/line_items`,
        token,
        {
          item: { id: lineItem.itemId },
        }
      );

      const lineItemId = (created as any)?.id;
      if (!lineItemId) {
        throw new ApiError(502, "clover line item missing id", { lineItem: created });
      }

      for (const modification of lineItem.modifications || []) {
        await postClover(
          baseUrl,
          `/v3/merchants/${merchantId}/orders/${orderId}/line_items/${lineItemId}/modifications`,
          token,
          {
            modifier: { id: modification.modifierOptionId },
          }
        );
      }
    }
  }

  return {
    orderId,
    status: "SUBMITTED",
  };
}

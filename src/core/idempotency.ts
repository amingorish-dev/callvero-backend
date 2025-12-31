import { db } from "../db/client";

export type OrderRow = {
  id: string;
  restaurant_id: string;
  call_id: string | null;
  status: string;
  draft_json: unknown;
  priced_json: unknown | null;
  toast_order_id: string | null;
  client_order_id: string;
  created_at: string;
};

export async function getOrderByClientOrderId(clientOrderId: string): Promise<OrderRow | null> {
  const result = await db.query<OrderRow>(
    "SELECT id, restaurant_id, call_id, status, draft_json, priced_json, toast_order_id, client_order_id, created_at FROM orders WHERE client_order_id = $1",
    [clientOrderId]
  );
  return result.rows[0] || null;
}

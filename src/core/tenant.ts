import { db } from "../db/client";
import { ApiError } from "./errors";

export type Restaurant = {
  id: string;
  name: string;
  phone_number: string;
  timezone: string;
  status: string;
  pos_provider: string;
};

export type MenuRow = {
  restaurant_id: string;
  version: number;
  normalized_json: unknown;
  source_hash: string;
  last_sync_at: string;
};

export async function getRestaurantByPhone(phoneNumber: string): Promise<Restaurant | null> {
  const result = await db.query<Restaurant>(
    "SELECT id, name, phone_number, timezone, status, pos_provider FROM restaurants WHERE phone_number = $1",
    [phoneNumber]
  );
  return result.rows[0] || null;
}

export async function requireRestaurantById(restaurantId: string): Promise<Restaurant> {
  const result = await db.query<Restaurant>(
    "SELECT id, name, phone_number, timezone, status, pos_provider FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  const restaurant = result.rows[0];
  if (!restaurant) {
    throw new ApiError(404, "restaurant not found");
  }
  if (restaurant.status !== "active") {
    throw new ApiError(403, "restaurant is inactive");
  }
  return restaurant;
}

export async function requireMenuForRestaurant(restaurantId: string): Promise<MenuRow> {
  const result = await db.query<MenuRow>(
    "SELECT restaurant_id, version, normalized_json, source_hash, last_sync_at FROM menus WHERE restaurant_id = $1",
    [restaurantId]
  );
  const menu = result.rows[0];
  if (!menu) {
    throw new ApiError(404, "menu not found for restaurant");
  }
  return menu;
}

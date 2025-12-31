import { randomUUID, createHash } from "crypto";
import { db, closeDb } from "./client";
import { logger } from "../core/logger";

const sampleMenu = {
  categories: [
    { id: "cat-burgers", name: "Burgers", itemIds: ["item-classic-burger", "item-veggie-burger"] },
    { id: "cat-sides", name: "Sides", itemIds: ["item-fries", "item-salad"] },
    { id: "cat-drinks", name: "Drinks", itemIds: ["item-soda", "item-water"] },
  ],
  items: [
    {
      id: "item-classic-burger",
      name: "Classic Burger",
      priceCents: 1199,
      description: "Beef patty, lettuce, tomato, house sauce.",
      modifierGroupIds: ["mod-cheese", "mod-extras"],
      synonyms: ["burger", "cheeseburger"],
    },
    {
      id: "item-veggie-burger",
      name: "Veggie Burger",
      priceCents: 1299,
      description: "House veggie patty with fresh toppings.",
      modifierGroupIds: ["mod-cheese", "mod-extras"],
      synonyms: ["veggie", "vegetarian burger"],
    },
    {
      id: "item-fries",
      name: "French Fries",
      priceCents: 399,
      description: "Crispy fries with sea salt.",
      modifierGroupIds: ["mod-fry-size"],
      synonyms: ["fries", "chips"],
    },
    {
      id: "item-salad",
      name: "House Salad",
      priceCents: 599,
      description: "Mixed greens, tomato, cucumber.",
      modifierGroupIds: ["mod-dressing"],
      synonyms: ["salad"],
    },
    {
      id: "item-soda",
      name: "Soft Drink",
      priceCents: 249,
      description: "Choice of Coke, Sprite, or Fanta.",
      modifierGroupIds: ["mod-soda-type"],
      synonyms: ["soda", "soft drink"],
    },
    {
      id: "item-water",
      name: "Bottled Water",
      priceCents: 199,
      description: "Still water.",
      modifierGroupIds: [],
      synonyms: ["water"],
    },
  ],
  modifierGroups: [
    {
      id: "mod-cheese",
      name: "Cheese",
      requiredMin: 1,
      requiredMax: 1,
      optionIds: ["opt-cheddar", "opt-swiss", "opt-none"],
    },
    {
      id: "mod-extras",
      name: "Extras",
      requiredMin: 0,
      requiredMax: 3,
      optionIds: ["opt-bacon", "opt-avocado", "opt-jalapeno"],
    },
    {
      id: "mod-fry-size",
      name: "Size",
      requiredMin: 1,
      requiredMax: 1,
      optionIds: ["opt-regular", "opt-large"],
    },
    {
      id: "mod-dressing",
      name: "Dressing",
      requiredMin: 1,
      requiredMax: 1,
      optionIds: ["opt-ranch", "opt-vinaigrette", "opt-caesar"],
    },
    {
      id: "mod-soda-type",
      name: "Soda Type",
      requiredMin: 1,
      requiredMax: 1,
      optionIds: ["opt-coke", "opt-sprite", "opt-fanta"],
    },
  ],
  modifierOptions: [
    { id: "opt-cheddar", name: "Cheddar", priceDeltaCents: 0 },
    { id: "opt-swiss", name: "Swiss", priceDeltaCents: 0 },
    { id: "opt-none", name: "No Cheese", priceDeltaCents: 0 },
    { id: "opt-bacon", name: "Bacon", priceDeltaCents: 199 },
    { id: "opt-avocado", name: "Avocado", priceDeltaCents: 179 },
    { id: "opt-jalapeno", name: "Jalapeno", priceDeltaCents: 79 },
    { id: "opt-regular", name: "Regular", priceDeltaCents: 0 },
    { id: "opt-large", name: "Large", priceDeltaCents: 150 },
    { id: "opt-ranch", name: "Ranch", priceDeltaCents: 0 },
    { id: "opt-vinaigrette", name: "Vinaigrette", priceDeltaCents: 0 },
    { id: "opt-caesar", name: "Caesar", priceDeltaCents: 0 },
    { id: "opt-coke", name: "Coke", priceDeltaCents: 0 },
    { id: "opt-sprite", name: "Sprite", priceDeltaCents: 0 },
    { id: "opt-fanta", name: "Fanta", priceDeltaCents: 0 },
  ],
};

async function seed() {
  const restaurantId = process.env.SEED_RESTAURANT_ID || randomUUID();
  const phoneNumber = process.env.SEED_PHONE_NUMBER || "+15551234567";
  const name = process.env.SEED_RESTAURANT_NAME || "Sample Diner";
  const timezone = process.env.SEED_RESTAURANT_TIMEZONE || "America/Los_Angeles";
  const posProvider = process.env.SEED_POS_PROVIDER || "toast";

  await db.query(
    "INSERT INTO restaurants (id, name, phone_number, timezone, status, pos_provider) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, pos_provider = EXCLUDED.pos_provider",
    [restaurantId, name, phoneNumber, timezone, "active", posProvider]
  );

  const sourceHash = createHash("sha256").update(JSON.stringify(sampleMenu)).digest("hex");

  await db.query(
    "INSERT INTO menus (restaurant_id, version, normalized_json, source_hash, last_sync_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (restaurant_id) DO UPDATE SET version = EXCLUDED.version, normalized_json = EXCLUDED.normalized_json, source_hash = EXCLUDED.source_hash, last_sync_at = now()",
    [restaurantId, 1, sampleMenu, sourceHash]
  );

  const toastGuid = process.env.SEED_TOAST_RESTAURANT_GUID;
  const toastClientId = process.env.SEED_TOAST_CLIENT_ID;
  const toastClientSecret = process.env.SEED_TOAST_CLIENT_SECRET;
  const toastEnvironment = process.env.SEED_TOAST_ENVIRONMENT || "sandbox";

  if (toastGuid && toastClientId && toastClientSecret) {
    await db.query(
      "INSERT INTO toast_credentials (restaurant_id, restaurant_guid, client_id, client_secret, environment) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_guid = EXCLUDED.restaurant_guid, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret, environment = EXCLUDED.environment",
      [restaurantId, toastGuid, toastClientId, toastClientSecret, toastEnvironment]
    );
  }

  const cloverMerchantId = process.env.SEED_CLOVER_MERCHANT_ID;
  const cloverClientId = process.env.SEED_CLOVER_CLIENT_ID;
  const cloverClientSecret = process.env.SEED_CLOVER_CLIENT_SECRET;
  const cloverEnvironment = process.env.SEED_CLOVER_ENVIRONMENT || "sandbox";

  if (cloverMerchantId && cloverClientId && cloverClientSecret) {
    await db.query(
      "INSERT INTO clover_credentials (restaurant_id, merchant_id, client_id, client_secret, environment) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (restaurant_id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret, environment = EXCLUDED.environment",
      [restaurantId, cloverMerchantId, cloverClientId, cloverClientSecret, cloverEnvironment]
    );
  }

  logger.info({ restaurantId, phoneNumber }, "seed complete");
}

seed()
  .catch((error) => {
    logger.error({ error }, "seed failed");
    process.exit(1);
  })
  .finally(() => closeDb());

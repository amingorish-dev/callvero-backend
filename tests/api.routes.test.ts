import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Client } from "pg";
import { createHash, randomUUID } from "crypto";
import type { Express } from "express";
import { createTestDatabase, dropTestDatabase, type TestDatabase } from "./helpers/db";

const sampleMenu = {
  categories: [
    { id: "cat-burgers", name: "Burgers", itemIds: ["item-classic-burger"] },
  ],
  items: [
    {
      id: "item-classic-burger",
      name: "Classic Burger",
      priceCents: 1199,
      description: "Beef patty, lettuce, tomato.",
      modifierGroupIds: ["mod-cheese"],
      synonyms: ["burger", "cheeseburger"],
    },
  ],
  modifierGroups: [
    {
      id: "mod-cheese",
      name: "Cheese",
      requiredMin: 1,
      requiredMax: 1,
      optionIds: ["opt-cheddar", "opt-none"],
    },
  ],
  modifierOptions: [
    { id: "opt-cheddar", name: "Cheddar", priceDeltaCents: 0 },
    { id: "opt-none", name: "No Cheese", priceDeltaCents: 0 },
  ],
};

let app: Express;
let dbInfo: TestDatabase;
let client: Client;
let restaurantId: string;

beforeAll(async () => {
  process.env.TOAST_MOCK = "true";
  process.env.CLOVER_MOCK = "true";
  process.env.LOG_LEVEL = "fatal";

  dbInfo = await createTestDatabase();
  process.env.DATABASE_URL = dbInfo.databaseUrl;

  const { runMigrations } = await import("../src/db/migrationsRunner");
  await runMigrations(dbInfo.databaseUrl);

  client = new Client({ connectionString: dbInfo.databaseUrl });
  await client.connect();

  restaurantId = randomUUID();
  await client.query(
    "INSERT INTO restaurants (id, name, phone_number, timezone, status) VALUES ($1, $2, $3, $4, $5)",
    [restaurantId, "Test Kitchen", "+15551234567", "America/Los_Angeles", "active"]
  );

  const sourceHash = createHash("sha256").update(JSON.stringify(sampleMenu)).digest("hex");
  await client.query(
    "INSERT INTO menus (restaurant_id, version, normalized_json, source_hash, last_sync_at) VALUES ($1, $2, $3, $4, now())",
    [restaurantId, 1, sampleMenu, sourceHash]
  );

  const { createApp } = await import("../src/app");
  app = createApp();
});

afterAll(async () => {
  const { closeDb } = await import("../src/db/client");
  await closeDb();
  await client.end();
  await dropTestDatabase(dbInfo);
});

describe("API routes", () => {
  it("returns health", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("rejects inbound calls for unknown numbers", async () => {
    const response = await request(app)
      .post("/inbound")
      .type("form")
      .send({ To: "+15550009999", From: "+15550001111" });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("restaurant not found for inbound number");
  });

  it("creates calls for inbound requests", async () => {
    const response = await request(app)
      .post("/inbound")
      .type("form")
      .send({ To: "+15551234567", From: "+15550002222" });

    expect(response.status).toBe(200);
    expect(response.text).toContain("<Response>");

    const callResult = await client.query(
      "SELECT id FROM calls WHERE restaurant_id = $1 AND from_number = $2 AND to_number = $3 ORDER BY started_at DESC LIMIT 1",
      [restaurantId, "+15550002222", "+15551234567"]
    );

    expect(callResult.rowCount).toBe(1);
  });

  it("serves menu for tenant", async () => {
    const response = await request(app).get(`/tools/menu?restaurant_id=${restaurantId}`);
    expect(response.status).toBe(200);
    expect(response.body.menu.items.length).toBe(sampleMenu.items.length);
  });

  it("searches menu with modifiers", async () => {
    const response = await request(app)
      .post("/tools/search_menu")
      .send({ restaurant_id: restaurantId, query: "burger" });

    expect(response.status).toBe(200);
    expect(response.body.results[0].id).toBe("item-classic-burger");
    expect(response.body.results[0].modifierGroups.length).toBe(1);
  });

  it("creates a draft order", async () => {
    const callResult = await client.query(
      "INSERT INTO calls (restaurant_id, from_number, to_number) VALUES ($1, $2, $3) RETURNING id",
      [restaurantId, "+15550003333", "+15551234567"]
    );
    const callId = callResult.rows[0].id;

    const response = await request(app)
      .post("/tools/draft_order")
      .send({
        restaurant_id: restaurantId,
        call_id: callId,
        selections: [
          {
            itemId: "item-classic-burger",
            quantity: 2,
            modifiers: [{ groupId: "mod-cheese", optionIds: ["opt-cheddar"] }],
          },
        ],
        notes: "Extra napkins",
        pickup_name: "Taylor",
        pickup_phone: "+15550004444",
      });

    expect(response.status).toBe(200);
    expect(response.body.order_id).toBeDefined();
    expect(response.body.draft_summary.subtotalCents).toBe(2398);
  });

  it("prices and submits an order with idempotency", async () => {
    const callResult = await client.query(
      "INSERT INTO calls (restaurant_id, from_number, to_number) VALUES ($1, $2, $3) RETURNING id",
      [restaurantId, "+15550005555", "+15551234567"]
    );
    const callId = callResult.rows[0].id;

    const draftResponse = await request(app)
      .post("/tools/draft_order")
      .send({
        restaurant_id: restaurantId,
        call_id: callId,
        selections: [
          {
            itemId: "item-classic-burger",
            quantity: 1,
            modifiers: [{ groupId: "mod-cheese", optionIds: ["opt-cheddar"] }],
          },
        ],
        pickup_name: "Jordan",
        pickup_phone: "+15550006666",
      });

    const orderId = draftResponse.body.order_id;

    const priceResponse = await request(app)
      .post("/tools/price_order")
      .send({ restaurant_id: restaurantId, order_id: orderId });

    expect(priceResponse.status).toBe(200);
    expect(priceResponse.body.totals).toBeDefined();

    const submitResponse = await request(app)
      .post("/tools/submit_order")
      .send({ restaurant_id: restaurantId, order_id: orderId, client_order_id: "client-test-001" });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.toast_order_id).toMatch(/mock-/);

    const retryResponse = await request(app)
      .post("/tools/submit_order")
      .send({ restaurant_id: restaurantId, order_id: orderId, client_order_id: "client-test-001" });

    expect(retryResponse.status).toBe(200);
    expect(retryResponse.body.toast_order_id).toBe(submitResponse.body.toast_order_id);
    expect(retryResponse.body.confirmation_text).toBe("Order already submitted.");
  });

  it("routes pricing and submission to Clover when configured", async () => {
    const cloverRestaurantId = randomUUID();
    await client.query(
      "INSERT INTO restaurants (id, name, phone_number, timezone, status, pos_provider) VALUES ($1, $2, $3, $4, $5, $6)",
      [cloverRestaurantId, "Clover Cafe", "+15551239999", "America/Los_Angeles", "active", "clover"]
    );

    const sourceHash = createHash("sha256").update(JSON.stringify(sampleMenu)).digest("hex");
    await client.query(
      "INSERT INTO menus (restaurant_id, version, normalized_json, source_hash, last_sync_at) VALUES ($1, $2, $3, $4, now())",
      [cloverRestaurantId, 1, sampleMenu, sourceHash]
    );

    await client.query(
      "INSERT INTO clover_credentials (restaurant_id, merchant_id, client_id, client_secret, environment) VALUES ($1, $2, $3, $4, $5)",
      [cloverRestaurantId, "merchant-123", "client-123", "secret-123", "sandbox"]
    );

    const callResult = await client.query(
      "INSERT INTO calls (restaurant_id, from_number, to_number) VALUES ($1, $2, $3) RETURNING id",
      [cloverRestaurantId, "+15550007777", "+15551239999"]
    );
    const callId = callResult.rows[0].id;

    const draftResponse = await request(app)
      .post("/tools/draft_order")
      .send({
        restaurant_id: cloverRestaurantId,
        call_id: callId,
        selections: [
          {
            itemId: "item-classic-burger",
            quantity: 1,
            modifiers: [{ groupId: "mod-cheese", optionIds: ["opt-cheddar"] }],
          },
        ],
        pickup_name: "Casey",
        pickup_phone: "+15550008888",
      });

    const orderId = draftResponse.body.order_id;

    const priceResponse = await request(app)
      .post("/tools/price_order")
      .send({ restaurant_id: cloverRestaurantId, order_id: orderId });

    expect(priceResponse.status).toBe(200);
    expect(priceResponse.body.priced_summary.pricingMode).toBe("mock");

    const submitResponse = await request(app)
      .post("/tools/submit_order")
      .send({ restaurant_id: cloverRestaurantId, order_id: orderId, client_order_id: "clover-test-001" });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.toast_order_id).toMatch(/mock-/);
  });
});

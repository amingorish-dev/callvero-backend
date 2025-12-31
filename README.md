# Callvero Backend

Production-grade MVP backend for a multi-restaurant voice ordering agent.

## Stack
- Node.js 20+
- TypeScript + Express
- Postgres (SQL migrations)
- Pino logging
- Zod validation

## Setup
```bash
npm install
```

Create a `.env` file:
```bash
DATABASE_URL=postgres://user:password@localhost:5432/callvero
PORT=3000
LOG_LEVEL=info

# Toast
TOAST_SANDBOX_BASE_URL=https://api-sandbox.toasttab.com
TOAST_PROD_BASE_URL=https://api.toasttab.com
TOAST_MOCK=true
TOAST_TIMEOUT_MS=10000

# Clover
CLOVER_SANDBOX_BASE_URL=https://sandbox.dev.clover.com
CLOVER_PROD_BASE_URL=https://api.clover.com
CLOVER_MOCK=true
CLOVER_TIMEOUT_MS=10000
CLOVER_CLIENT_ID=
CLOVER_CLIENT_SECRET=
CLOVER_REDIRECT_URI=
CLOVER_ENVIRONMENT=sandbox

# Twilio (optional for SMS)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

Run migrations and seed data:
```bash
npm run db:migrate
npm run db:seed
```

Start the server:
```bash
npm run dev
# or
npm run build
npm start
```

## Database schema
Migrations live in `src/db/migrations`.

## Seed data
The seed script creates one restaurant, menu, and (optionally) Toast credentials if the env vars are present.

Optional seed env vars:
```bash
SEED_RESTAURANT_ID=
SEED_RESTAURANT_NAME=Sample Diner
SEED_RESTAURANT_TIMEZONE=America/Los_Angeles
SEED_PHONE_NUMBER=+15551234567
SEED_POS_PROVIDER=toast

SEED_TOAST_RESTAURANT_GUID=
SEED_TOAST_CLIENT_ID=
SEED_TOAST_CLIENT_SECRET=
SEED_TOAST_ENVIRONMENT=sandbox

SEED_CLOVER_MERCHANT_ID=
SEED_CLOVER_CLIENT_ID=
SEED_CLOVER_CLIENT_SECRET=
SEED_CLOVER_ENVIRONMENT=sandbox
```

## API
### Inbound (Twilio)
`POST /inbound` expects Twilio form fields `To` and `From`. It resolves the restaurant tenant by `To` and creates a call row.

### Tools (Vapi)
All tool requests must include `restaurant_id` and are validated against tenant ownership.

- `GET /tools/menu?restaurant_id=...`
- `POST /tools/search_menu { restaurant_id, query }`
- `POST /tools/draft_order { restaurant_id, call_id, selections, notes, pickup_name, pickup_phone }`
- `POST /tools/price_order { restaurant_id, order_id }`
- `POST /tools/submit_order { restaurant_id, order_id, client_order_id }`
- `POST /tools/send_sms { to, message }`
- `GET  /clover/callback?code=...&merchant_id=...&state=<restaurant_id>` (OAuth callback)
- `POST /clover/sync_menu { restaurant_id }` (imports Clover inventory into normalized menu)

## Normalized menu format
Stored in `menus.normalized_json`.

```json
{
  "categories": [{ "id": "cat-1", "name": "Burgers", "itemIds": ["item-1"] }],
  "items": [
    {
      "id": "item-1",
      "name": "Classic Burger",
      "priceCents": 1199,
      "description": "Optional",
      "modifierGroupIds": ["mod-1"],
      "synonyms": ["burger", "cheeseburger"],
      "externalIds": {
        "clover": { "itemId": "CLOVER_ITEM_ID" },
        "toast": { "itemId": "TOAST_ITEM_ID" }
      }
    }
  ],
  "modifierGroups": [
    {
      "id": "mod-1",
      "name": "Cheese",
      "requiredMin": 1,
      "requiredMax": 1,
      "optionIds": ["opt-1"],
      "externalIds": { "clover": { "modifierGroupId": "CLOVER_GROUP_ID" } }
    }
  ],
  "modifierOptions": [
    {
      "id": "opt-1",
      "name": "Cheddar",
      "priceDeltaCents": 0,
      "externalIds": { "clover": { "modifierOptionId": "CLOVER_OPTION_ID" } }
    }
  ]
}
```

Selections format:
```json
[
  {
    "itemId": "item-1",
    "quantity": 1,
    "modifiers": [{ "groupId": "mod-1", "optionIds": ["opt-1"] }],
    "specialInstructions": "Optional"
  }
]
```

### Example curl
Replace the IDs with values from your database.

```bash
curl -X GET "http://localhost:3000/tools/menu?restaurant_id=RESTAURANT_UUID"
```

```bash
curl -X POST http://localhost:3000/tools/search_menu \
  -H "Content-Type: application/json" \
  -d '{"restaurant_id":"RESTAURANT_UUID","query":"burger"}'
```

```bash
curl -X POST http://localhost:3000/tools/draft_order \
  -H "Content-Type: application/json" \
  -d '{
    "restaurant_id":"RESTAURANT_UUID",
    "call_id":"CALL_UUID",
    "selections":[
      {
        "itemId":"item-classic-burger",
        "quantity":1,
        "modifiers":[
          {"groupId":"mod-cheese","optionIds":["opt-cheddar"]}
        ]
      }
    ],
    "pickup_name":"Alex",
    "pickup_phone":"+15551230000"
  }'
```

```bash
curl -X POST http://localhost:3000/tools/price_order \
  -H "Content-Type: application/json" \
  -d '{"restaurant_id":"RESTAURANT_UUID","order_id":"ORDER_UUID"}'
```

```bash
curl -X POST http://localhost:3000/tools/submit_order \
  -H "Content-Type: application/json" \
  -d '{"restaurant_id":"RESTAURANT_UUID","order_id":"ORDER_UUID","client_order_id":"CLIENT_ORDER_ID"}'
```

## Add restaurants / phone numbers
Insert into `restaurants` and `menus` with your restaurant UUID and phone number, then map Toast credentials in `toast_credentials`.
To use Clover for a tenant, set `restaurants.pos_provider = 'clover'` and insert credentials in `clover_credentials`.

### Clover OAuth (sandbox)
Set Clover app env vars in your runtime (`CLOVER_CLIENT_ID`, `CLOVER_CLIENT_SECRET`, `CLOVER_REDIRECT_URI`), then authorize:

```text
https://sandbox.dev.clover.com/oauth/authorize?client_id=<CLOVER_CLIENT_ID>&redirect_uri=<CLOVER_REDIRECT_URI>&state=<restaurant_id>
```

After approval you should be redirected to:
```
<CLOVER_REDIRECT_URI>?code=AUTH_CODE&merchant_id=MERCHANT_ID&state=<restaurant_id>
```

The callback endpoint `GET /clover/callback` stores the token and merchant ID in `clover_credentials`.

Example SQL:
```sql
INSERT INTO restaurants (id, name, phone_number, timezone, status)
VALUES ('<uuid>', 'My Restaurant', '+15551239999', 'America/Chicago', 'active');

INSERT INTO menus (restaurant_id, version, normalized_json, source_hash, last_sync_at)
VALUES ('<uuid>', 1, '{...}', 'hash', now());

INSERT INTO toast_credentials (restaurant_id, restaurant_guid, client_id, client_secret, environment)
VALUES ('<uuid>', '<toast-guid>', '<client-id>', '<client-secret>', 'sandbox');

INSERT INTO clover_credentials (restaurant_id, merchant_id, client_id, client_secret, environment)
VALUES ('<uuid>', '<merchant-id>', '<client-id>', '<client-secret>', 'sandbox');
```

## Notes
- The Toast mapper is intentionally minimal and marked with TODOs to adapt to the exact Toast schema.
- If `TOAST_MOCK=true`, pricing/submission returns stubbed responses.

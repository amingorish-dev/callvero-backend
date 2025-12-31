CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone_number text NOT NULL UNIQUE,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE toast_credentials (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  restaurant_guid text NOT NULL,
  client_id text NOT NULL,
  client_secret text NOT NULL,
  environment text NOT NULL,
  access_token text,
  token_expires_at timestamptz
);

CREATE TABLE menus (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  normalized_json jsonb NOT NULL,
  source_hash text NOT NULL,
  last_sync_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  from_number text NOT NULL,
  to_number text NOT NULL,
  transcript text,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  status text NOT NULL,
  draft_json jsonb NOT NULL,
  priced_json jsonb,
  toast_order_id text,
  client_order_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_restaurant_id_idx ON orders(restaurant_id);
CREATE INDEX calls_restaurant_id_idx ON calls(restaurant_id);

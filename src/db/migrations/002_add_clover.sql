ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS pos_provider text NOT NULL DEFAULT 'toast';

CREATE TABLE IF NOT EXISTS clover_credentials (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  merchant_id text NOT NULL,
  client_id text NOT NULL,
  client_secret text NOT NULL,
  environment text NOT NULL,
  access_token text,
  token_expires_at timestamptz
);

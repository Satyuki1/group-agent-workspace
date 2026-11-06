CREATE TABLE runtime_credentials (
  token_hash text PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES spaces(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE space_runtimes (
  space_id uuid PRIMARY KEY REFERENCES spaces(id),
  endpoint text NOT NULL,
  encrypted_bridge_key text NOT NULL,
  state text NOT NULL CHECK(state IN ('starting','ready','stopped','failed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_usage (
  id bigserial PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES spaces(id),
  model text NOT NULL,
  status integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

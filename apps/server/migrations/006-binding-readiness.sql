ALTER TABLE session_bindings ADD COLUMN ready boolean NOT NULL DEFAULT true;
ALTER TABLE session_bindings ADD COLUMN initialization_error text;

ALTER TABLE relay_outbox ADD COLUMN lease_owner text;
ALTER TABLE relay_outbox ADD COLUMN lease_until timestamptz;

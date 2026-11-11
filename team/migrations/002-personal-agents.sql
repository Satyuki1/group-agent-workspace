ALTER TABLE agents
  ADD COLUMN personal_owner uuid REFERENCES users,
  ADD COLUMN local_bot_id text,
  ADD CHECK ((personal_owner IS NULL) = (local_bot_id IS NULL)),
  ADD UNIQUE (personal_owner, local_bot_id);

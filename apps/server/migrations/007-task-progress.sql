ALTER TABLE tasks ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb;

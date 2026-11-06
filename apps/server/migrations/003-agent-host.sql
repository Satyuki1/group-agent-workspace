ALTER TABLE tasks ADD COLUMN baseline_cursor bigint;
ALTER TABLE tasks ADD COLUMN admitted_at timestamptz;
ALTER TABLE tasks ADD COLUMN started_at timestamptz;
ALTER TABLE tasks ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX tasks_active_binding ON tasks(session_binding_id)
  WHERE status IN ('running','waiting_approval','waiting_input','needs_review');

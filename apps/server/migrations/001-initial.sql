CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  public_key text NOT NULL UNIQUE,
  encrypted_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invitations (
  token_hash text PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay_outbox (
  event_id text PRIMARY KEY,
  actor_public_key text NOT NULL,
  event jsonb NOT NULL,
  purpose text NOT NULL,
  subject_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_outbox_pending ON relay_outbox(next_attempt_at) WHERE state='pending';
CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  public_key text NOT NULL UNIQUE,
  encrypted_key text NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL,
  role text NOT NULL CHECK (role IN ('personal','coordinator','specialist')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE spaces (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('personal','group')),
  owner_id uuid REFERENCES users(id),
  conversation_id text UNIQUE,
  root_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='personal' AND owner_id IS NOT NULL AND conversation_id IS NULL) OR (kind='group' AND conversation_id IS NOT NULL AND owner_id IS NULL))
);
CREATE UNIQUE INDEX personal_space ON spaces(owner_id) WHERE kind='personal';
CREATE TABLE agent_memberships (
  agent_id uuid NOT NULL REFERENCES agents(id),
  space_id uuid NOT NULL REFERENCES spaces(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(agent_id,space_id)
);
CREATE TABLE session_bindings (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES spaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  thread_id text NOT NULL DEFAULT '',
  dsh_session_id text NOT NULL,
  UNIQUE(space_id,agent_id,thread_id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES spaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  requester_id uuid REFERENCES users(id),
  source_event_id text NOT NULL,
  parent_id uuid REFERENCES tasks(id),
  session_binding_id uuid REFERENCES session_bindings(id),
  input jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','waiting_approval','waiting_input','completed','failed','cancelled','needs_review')),
  lane text NOT NULL CHECK(lane IN ('fast','slow')),
  lease_owner text,
  lease_until timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,space_id,source_event_id)
);
CREATE INDEX tasks_queue ON tasks(lane,created_at) WHERE status='queued';
CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  operation jsonb NOT NULL,
  operation_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved','rejected','expired','executing','completed','needs_review')),
  decided_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_checkpoints (scope text PRIMARY KEY, cursor jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

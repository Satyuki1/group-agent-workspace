CREATE TABLE users (
  id uuid PRIMARY KEY, username text UNIQUE NOT NULL, name text NOT NULL,
  password text NOT NULL, admin boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true
);
CREATE TABLE login_sessions (
  token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, expires_at timestamptz NOT NULL
);
CREATE TABLE invitations (
  token text PRIMARY KEY, expires_at timestamptz NOT NULL, reset_user uuid REFERENCES users
);
CREATE TABLE agents (
  id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL, instructions text NOT NULL,
  model text NOT NULL, tools boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true
);
CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE conversations (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('dm','group','agent')),
  name text NOT NULL, owner_id uuid NOT NULL REFERENCES users, direct_key text UNIQUE,
  next_seq bigint NOT NULL DEFAULT 0, router_since bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE members (
  conversation_id uuid NOT NULL REFERENCES conversations, user_id uuid NOT NULL REFERENCES users,
  read_seq bigint NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id,user_id)
);
CREATE INDEX members_user ON members(user_id);
CREATE TABLE bindings (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations, agent_id uuid NOT NULL REFERENCES agents,
  joined_seq bigint NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX active_binding ON bindings(conversation_id,agent_id) WHERE active;
CREATE TABLE messages (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations, seq bigint NOT NULL,
  user_id uuid REFERENCES users, agent_id uuid REFERENCES agents, client_id uuid,
  text text NOT NULL, reply_id uuid REFERENCES messages, mentions uuid[] NOT NULL DEFAULT '{}',
  mention_all boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'complete',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,seq), UNIQUE(user_id,client_id),
  CHECK ((user_id IS NULL) <> (agent_id IS NULL))
);
CREATE TABLE attachments (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations,
  uploader_id uuid REFERENCES users, message_id uuid REFERENCES messages,
  name text NOT NULL, media_type text NOT NULL, size integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE TABLE runs (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations,
  source_id uuid NOT NULL REFERENCES messages, binding_id uuid REFERENCES bindings, reply_id uuid REFERENCES messages,
  kind text NOT NULL CHECK (kind IN ('agent','route')), status text NOT NULL DEFAULT 'queued',
  lease uuid, lease_until timestamptz, position integer NOT NULL DEFAULT 0,
  progress text, approval jsonb, decision text, outcome text, started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_run_once ON runs(source_id,binding_id) WHERE kind='agent';
CREATE UNIQUE INDEX route_once ON runs(source_id) WHERE kind='route';
CREATE INDEX run_queue ON runs(status,created_at);
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, conversation_id uuid REFERENCES conversations,
  user_id uuid REFERENCES users, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

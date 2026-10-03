CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_codes (
  id text PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email, expires_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS memberships (
  room_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY,
  room_id text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_by text REFERENCES users(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_connections (
  id text PRIMARY KEY,
  room_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_connections_room ON mcp_connections(room_id);

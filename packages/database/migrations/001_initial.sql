CREATE TABLE IF NOT EXISTS resources (
 id text PRIMARY KEY, project_id text NOT NULL, kind text NOT NULL,
 data jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_project_kind ON resources(project_id,kind);
CREATE TABLE IF NOT EXISTS events (
 seq bigserial PRIMARY KEY, id text UNIQUE NOT NULL, project_id text NOT NULL,
 actor_id text NOT NULL, type text NOT NULL, resource_id text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id,seq);
CREATE TABLE IF NOT EXISTS commands (
 actor_id text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(actor_id,key)
);
CREATE TABLE IF NOT EXISTS credentials (
 hash text PRIMARY KEY, actor jsonb NOT NULL, expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS documents (project_id text PRIMARY KEY, state bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- OAuth broker persistence. Apply ONLY to a dedicated broker database.
-- Do not apply to the Nubis production Supabase database.
-- Why: preserve OAuth transactions, workspace bindings, and encrypted upstream
-- credentials across restarts. Browser/MCP clients must have no SQL access.
-- Apply: psql "$NUBIS_BROKER_DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file.sql
-- Verify: broker storage integration tests and full PKCE/refresh/revocation test.
-- The database login is server-only. Encryption keys live outside this database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS nubis_broker;
REVOKE ALL ON SCHEMA nubis_broker FROM PUBLIC;
CREATE TABLE IF NOT EXISTS nubis_broker.artifacts (
  kind text NOT NULL,
  id text NOT NULL,
  payload text NOT NULL,
  grant_id text,
  uid text,
  user_code text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS broker_artifacts_grant ON nubis_broker.artifacts (grant_id);
CREATE INDEX IF NOT EXISTS broker_artifacts_uid ON nubis_broker.artifacts (kind, uid);
CREATE TABLE IF NOT EXISTS nubis_broker.connections (
  grant_id text PRIMARY KEY,
  interaction_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  client_id text NOT NULL,
  workspace_id uuid NOT NULL,
  client_name text NOT NULL,
  workspace_name text NOT NULL,
  scopes text[] NOT NULL,
  upstream_session text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE nubis_broker.connections ADD COLUMN IF NOT EXISTS refresh_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS broker_connections_user ON nubis_broker.connections (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS broker_one_live_connection
  ON nubis_broker.connections (user_id, client_id, workspace_id)
  WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION nubis_broker.immutable_connection_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.grant_id, NEW.interaction_id, NEW.user_id, NEW.client_id, NEW.workspace_id)
     IS DISTINCT FROM
     (OLD.grant_id, OLD.interaction_id, OLD.user_id, OLD.client_id, OLD.workspace_id) THEN
    RAISE EXCEPTION 'Connection binding is immutable; create a new authorization';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER broker_immutable_connection_binding
BEFORE UPDATE ON nubis_broker.connections FOR EACH ROW
EXECUTE FUNCTION nubis_broker.immutable_connection_binding();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nubis_broker FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA nubis_broker FROM PUBLIC;
COMMIT;

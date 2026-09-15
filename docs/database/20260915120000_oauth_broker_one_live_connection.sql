-- Dedicated broker database only, never Nubis Supabase.
-- Why: re-auth to the same workspace replaces the previous live grant. One
-- live row per user/client/workspace keeps stacked grants from surviving a race.
-- Apply after 20260914090000_oauth_broker.sql using the broker database owner.
-- Verify: a second consent for the same client/workspace revokes the prior grant.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS broker_one_live_connection
  ON nubis_broker.connections (user_id, client_id, workspace_id)
  WHERE revoked_at IS NULL;
COMMIT;

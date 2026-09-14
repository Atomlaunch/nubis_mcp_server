-- Dedicated TEST broker database only, never Nubis Supabase.
-- Why: the running broker must not hold the PostgreSQL bootstrap superuser login.
-- Apply after 20260914090000_oauth_broker.sql using psql as the database owner.
-- Set BROKER_RUNTIME_PASSWORD in the database container's secret environment.
-- Verify: runtime login can read/write broker tables; rolsuper/rolcreatedb/
-- rolcreaterole/rolbypassrls are false; PUBLIC cannot use the broker schema.
-- Existing credentials are not rotated by re-running this file.
\set ON_ERROR_STOP on
\getenv runtime_password BROKER_RUNTIME_PASSWORD
BEGIN;
SELECT format('CREATE ROLE nubis_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nubis_broker')
\gexec
GRANT CONNECT ON DATABASE nubis_broker_test TO nubis_broker;
GRANT USAGE ON SCHEMA nubis_broker TO nubis_broker;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA nubis_broker TO nubis_broker;
COMMIT;

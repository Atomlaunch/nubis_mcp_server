-- LOCAL POLICY ACCEPTANCE ONLY. Never apply to Supabase or Railway.
-- Why: exercise existing production task/comment policy functions with synthetic roles.
-- This is minimal supporting schema, not a full production database snapshot.
-- Apply only in a fresh localhost DB named nubis_mcp_policy_acceptance, through
-- server/production-policy.test.ts, which loads unchanged policy function SQL
-- from the PMTool migrations. Verify with that test; fixtures are retained.
DO $$ BEGIN
 IF current_database() <> 'nubis_mcp_policy_acceptance' THEN RAISE EXCEPTION 'Wrong policy fixture database'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
CREATE TYPE pm_permission_resource AS ENUM ('tasks','tasks_team');
CREATE TYPE pm_permission_action AS ENUM ('read','create','update','delete');
CREATE TABLE pm_members(project_id uuid,user_id uuid,role text,PRIMARY KEY(project_id,user_id));
CREATE TABLE pm_team_members(team_id uuid,user_id uuid,PRIMARY KEY(team_id,user_id));
CREATE TABLE pm_role_permissions(project_id uuid,role text,resource pm_permission_resource,action pm_permission_action);
CREATE TABLE pm_agent_keys(user_id uuid,revoked_at timestamptz,rotated_at timestamptz);
CREATE TABLE pm_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,team_id uuid,_assignee uuid,created_by uuid,title text NOT NULL,description text,board text DEFAULT 'inbox',context text);
CREATE TABLE pm_comments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid,task_id uuid,user_id uuid,content text);
ALTER TABLE pm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_comments ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role,anon;
GRANT SELECT,INSERT,UPDATE,DELETE ON pm_tasks,pm_comments TO authenticated;
GRANT SELECT ON pm_tasks,pm_comments TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE POLICY "SERVICE ROLE" ON pm_tasks FOR ALL TO service_role USING(true);

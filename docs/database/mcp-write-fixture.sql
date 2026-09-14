-- LOCAL TEST FIXTURE ONLY. Never apply to Supabase or the broker's real-test DB.
-- Creates minimal application relationships and explicit permission-based RLS for
-- real PostgREST write acceptance. This is not a copy of production RLS.
-- Apply to a fresh localhost database named nubis_mcp_write_acceptance.
-- Verify with server/write-integration.test.ts; retain fixtures for inspection.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'nubis_mcp_write_acceptance' THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mcp_fixture_authenticator') THEN CREATE ROLE mcp_fixture_authenticator LOGIN NOINHERIT PASSWORD 'local-write-fixture-only'; END IF;
END $$;
GRANT anon, authenticated, service_role TO mcp_fixture_authenticator;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role, anon;
CREATE TABLE pm_projects(id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE pm_members(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES pm_projects,user_id uuid NOT NULL,member_kind text NOT NULL DEFAULT 'human',can_create boolean NOT NULL DEFAULT true,can_update boolean NOT NULL DEFAULT true);
CREATE TABLE pm_branches(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES pm_projects,name text NOT NULL);
CREATE TABLE pm_task_boards(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES pm_branches,name text NOT NULL,position integer NOT NULL DEFAULT 0,is_default boolean NOT NULL DEFAULT true);
CREATE TABLE pm_task_board_columns(id uuid PRIMARY KEY,board_id uuid NOT NULL REFERENCES pm_task_boards,name text NOT NULL,position integer NOT NULL,behavior text NOT NULL,legacy_status_key text);
CREATE TABLE pm_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES pm_projects,branch_id uuid REFERENCES pm_branches,board_id uuid REFERENCES pm_task_boards,board_column_id uuid REFERENCES pm_task_board_columns,title text NOT NULL,description text,board text NOT NULL DEFAULT 'inbox',parent_task_id uuid REFERENCES pm_tasks,sort_order numeric,task_number integer,created_by uuid,_assignee uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),github_item_type text,github_file_path text,github_repo_name text,priority text,due_date timestamptz,completed_at timestamptz);
CREATE TABLE pm_task_blockers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid REFERENCES pm_tasks,blocker_task_id uuid REFERENCES pm_tasks);
CREATE TABLE pm_comments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid REFERENCES pm_projects,task_id uuid REFERENCES pm_tasks,parent_id uuid REFERENCES pm_comments,content text,created_by uuid,created_at timestamptz DEFAULT now());
CREATE FUNCTION fixture_member(workspace uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT FROM pm_members WHERE project_id=workspace AND user_id=auth.uid() AND member_kind='human') $$;
CREATE FUNCTION fixture_can(workspace uuid,action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT FROM pm_members WHERE project_id=workspace AND user_id=auth.uid() AND member_kind='human' AND CASE action WHEN 'create' THEN can_create WHEN 'update' THEN can_update ELSE true END) $$;
ALTER TABLE pm_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_task_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_task_board_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_task_blockers ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_projects ON pm_projects FOR SELECT TO authenticated USING(fixture_member(id));
CREATE POLICY read_members ON pm_members FOR SELECT TO authenticated USING(fixture_member(project_id));
CREATE POLICY read_branches ON pm_branches FOR SELECT TO authenticated USING(fixture_member(project_id));
CREATE POLICY read_boards ON pm_task_boards FOR SELECT TO authenticated USING(EXISTS(SELECT FROM pm_branches b WHERE b.id=pm_task_boards.project_id));
CREATE POLICY read_columns ON pm_task_board_columns FOR SELECT TO authenticated USING(EXISTS(SELECT FROM pm_task_boards b WHERE b.id=pm_task_board_columns.board_id));
CREATE POLICY read_tasks ON pm_tasks FOR SELECT TO authenticated USING(fixture_member(project_id));
CREATE POLICY create_tasks ON pm_tasks FOR INSERT TO authenticated WITH CHECK(fixture_can(project_id,'create') AND created_by=auth.uid());
CREATE POLICY update_tasks ON pm_tasks FOR UPDATE TO authenticated USING(fixture_can(project_id,'update')) WITH CHECK(fixture_can(project_id,'update'));
CREATE POLICY read_comments ON pm_comments FOR SELECT TO authenticated USING(fixture_member(project_id));
CREATE POLICY read_blockers ON pm_task_blockers FOR SELECT TO authenticated USING(EXISTS(SELECT FROM pm_tasks t WHERE t.id=pm_task_blockers.task_id));
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT,UPDATE ON pm_tasks TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
REVOKE ALL ON FUNCTION fixture_member(uuid),fixture_can(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fixture_member(uuid),fixture_can(uuid,text) TO authenticated;
COMMIT;

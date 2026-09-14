-- LOCAL TEST FIXTURE ONLY, not a production migration.
-- Adds context/comment coverage to the existing isolated write fixture.
-- Apply once on nubis_mcp_write_acceptance, then run npm run test:writes.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'nubis_mcp_write_acceptance' THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
END $$;
ALTER TABLE pm_tasks ADD COLUMN context text;
ALTER TABLE pm_comments ADD COLUMN user_id uuid;
GRANT INSERT ON pm_comments TO authenticated;
CREATE POLICY create_comments ON pm_comments FOR INSERT TO authenticated WITH CHECK(
 user_id=auth.uid() AND fixture_can(project_id,'update') AND EXISTS(
  SELECT FROM pm_tasks t WHERE t.id=pm_comments.task_id AND t.project_id=pm_comments.project_id
 )
);
COMMIT;
NOTIFY pgrst, 'reload schema';

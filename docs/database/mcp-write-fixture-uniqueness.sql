-- LOCAL TEST ONLY. Matches the existing production task-number uniqueness rule.
-- Apply once to the isolated fixture; verify with npm run test:writes.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'nubis_mcp_write_acceptance' THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
END $$;
ALTER TABLE pm_tasks ADD CONSTRAINT pm_tasks_project_id_task_number_key UNIQUE(project_id,task_number);
COMMIT;
NOTIFY pgrst, 'reload schema';

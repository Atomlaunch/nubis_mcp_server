import assert from "node:assert/strict";
import { insertWorkspaceTask } from "./task-create.js";
const conflict = {
  code: "23505",
  message:
    'duplicate key violates constraint "pm_tasks_project_id_task_number_key"',
};
function fixture(errors: Array<any>, readError: any = null) {
  const rows: Array<any> = [];
  let max = 40;
  const db = {
    from: () => {
      let column = "",
        row: any;
      const q: any = {
        select: (value: string) => {
          column = value;
          return q;
        },
        eq: () => q,
        order: () => q,
        limit: () => q,
        insert: (value: any) => {
          row = value;
          return q;
        },
        single: async () => {
          if (row) {
            rows.push(row);
            const error =
              errors[Math.min(rows.length - 1, errors.length - 1)] ?? null;
            if (error?.code === "23505") max++;
            return { data: error ? null : row, error };
          }
          return {
            data: readError
              ? null
              : column === "task_number"
                ? { task_number: max }
                : { sort_order: 1000 },
            error: readError,
          };
        },
      };
      return q;
    },
  };
  return { db: db as any, rows };
}
const retry = fixture([conflict, null]);
const created = await insertWorkspaceTask(retry.db, "workspace-a", {
  title: "Concurrent task",
  project_id: "must-not-override",
});
assert.equal(created.error, null);
assert.deepEqual(
  retry.rows.map((r) => r.task_number),
  [41, 42],
);
assert.ok(retry.rows.every((r) => r.project_id === "workspace-a"));
for (const error of [
  { code: "", message: "Network outcome unknown" },
  { code: "42501", message: "Permission denied" },
  { code: "23505", message: "Different unique constraint" },
]) {
  const f = fixture([error]);
  assert.equal(
    (await insertWorkspaceTask(f.db, "workspace-a", { title: "Test" })).error,
    error,
  );
  assert.equal(
    f.rows.length,
    1,
    "do not replay uncertain or unrelated failures",
  );
}
const exhausted = fixture([conflict]);
assert.equal(
  (
    await insertWorkspaceTask(exhausted.db, "workspace-a", {
      title: "Contention",
    })
  ).error,
  conflict,
);
assert.equal(exhausted.rows.length, 8, "contention retries are bounded");
const unreadable = fixture([], { code: "42501", message: "Read denied" });
assert.ok(
  (
    await insertWorkspaceTask(unreadable.db, "workspace-a", {
      title: "Cannot inspect numbering",
    })
  ).error,
);
assert.equal(unreadable.rows.length, 0);
console.log(
  "Task creation retry, ambiguous failure, permission, workspace binding and bounded-contention tests passed",
);

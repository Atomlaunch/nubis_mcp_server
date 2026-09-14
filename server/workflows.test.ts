import assert from "node:assert/strict";
import { resolveRouting, projectInput, type Workflow } from "./workflows.js";
const project = "11111111-1111-4111-8111-111111111111";
const board: Workflow = {
  id: "board",
  project_id: project,
  name: "Support",
  position: 0,
  is_default: true,
  columns: [
    {
      id: "intake",
      board_id: "board",
      name: "New",
      position: 0,
      behavior: "active",
      legacy_status_key: null,
    },
    {
      id: "review",
      board_id: "board",
      name: "Review",
      position: 1,
      behavior: "active",
      legacy_status_key: null,
    },
    {
      id: "resolved",
      board_id: "board",
      name: "Resolved",
      position: 2,
      behavior: "done",
      legacy_status_key: null,
    },
  ],
};
assert.deepEqual(resolveRouting({ board_column_id: "review" }, [board]), {
  branch_id: project,
  board_id: "board",
  board_column_id: "review",
  board: "in-progress",
});
assert.equal(
  resolveRouting({ board_column_id: "resolved" }, [board]).board,
  "done",
);
assert.equal(
  resolveRouting({ project_id: project }, [board]).board_column_id,
  "intake",
);
assert.deepEqual(
  resolveRouting({ title: "Rename" }, [board], {
    branch_id: project,
    board_id: "board",
    board_column_id: "review",
  }),
  {},
);
assert.deepEqual(
  resolveRouting({ project_id: null }, [board], {
    branch_id: project,
    board_id: "board",
  }),
  { branch_id: null, board_id: null, board_column_id: null, board: "inbox" },
);
assert.throws(
  () => resolveRouting({ board_column_id: "foreign" }, [board]),
  /not found/,
);
assert.throws(
  () => resolveRouting({ board_id: "foreign" }, [board]),
  /not found/,
);
assert.throws(
  () =>
    resolveRouting({ board_column_id: "review", board_id: "other" }, [board]),
  /does not belong/,
);
assert.throws(
  () =>
    resolveRouting(
      {
        board_column_id: "review",
        project_id: "22222222-2222-4222-8222-222222222222",
      },
      [board],
    ),
  /does not belong/,
);
assert.throws(
  () =>
    resolveRouting({ board: "in-progress" }, [board], { board_id: "board" }),
  /ambiguous/,
);
assert.equal(
  resolveRouting({ board: "done" }, [board], { board_id: "board" })
    .board_column_id,
  "resolved",
);
assert.equal(resolveRouting({ board: "completed" }, []).board, "done");
assert.throws(
  () => projectInput({ project_id: project, bolt_id: null }),
  /conflict/,
);
assert.equal(projectInput({ bolt_id: project }), project);
assert.throws(() => resolveRouting({ project_id: project }, []), /no default/);
console.log("Workflow routing tests passed (15 assertions)");

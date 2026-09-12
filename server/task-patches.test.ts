import assert from "node:assert/strict";
import {
  appendTaskContext,
  bulkTaskNumbers,
  buildTaskUpdatePatch,
  isMissingRow,
} from "./task-patches.js";

assert.equal(isMissingRow({ code: "PGRST116" }), true);
assert.equal(isMissingRow({ message: "JSON object requested, multiple (or no) rows returned" }), false);
assert.equal(isMissingRow({ message: "Results contain 0 rows" }), true);
assert.equal(isMissingRow(null), false);

assert.equal(appendTaskContext(null, "new"), "new");
assert.equal(appendTaskContext("old", "new"), "old\n\nnew");
assert.equal(appendTaskContext("old", ""), "old");

{
  const nums = bulkTaskNumbers(10, 2000, 3);
  assert.deepEqual(nums, [
    { task_number: 11, sort_order: 3000 },
    { task_number: 12, sort_order: 4000 },
    { task_number: 13, sort_order: 5000 },
  ]);
}

{
  assert.deepEqual(buildTaskUpdatePatch({ taskID: "t1" }), {});
  assert.deepEqual(buildTaskUpdatePatch({ title: "Keep me" }), {
    title: "Keep me",
  });
  assert.deepEqual(
    buildTaskUpdatePatch({ title: undefined, description: null }),
    { title: undefined, description: null }
  );
}

console.log("task-patches tests passed");

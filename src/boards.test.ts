import assert from "node:assert/strict";
import {
  LIVE_BOARD_STATUS_KEYS,
  mapSchemaBoard,
  toLiveBoardStatusKey,
} from "./boards.js";

assert.equal(toLiveBoardStatusKey("backlog"), "inbox");
assert.equal(toLiveBoardStatusKey("completed"), "done");
assert.equal(toLiveBoardStatusKey("Backlog"), "inbox");
assert.equal(toLiveBoardStatusKey("COMPLETED"), "done");

for (const key of LIVE_BOARD_STATUS_KEYS) {
  assert.equal(toLiveBoardStatusKey(key), key, `live key ${key} must not remap`);
}

assert.equal(mapSchemaBoard({ board: "backlog" }).board, "inbox");
assert.equal(mapSchemaBoard({ board: "completed", limit: 5 }).board, "done");
assert.equal(mapSchemaBoard({ board: "inbox" }).board, "inbox");
assert.equal(mapSchemaBoard({ limit: 5 }).board, undefined);

console.log("src/boards.test.ts: ok");

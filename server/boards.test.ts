import assert from "node:assert/strict";
import { LIVE_BOARD_STATUS_KEYS, toLiveBoardStatusKey } from "./boards.js";

assert.equal(toLiveBoardStatusKey("backlog"), "inbox");
assert.equal(toLiveBoardStatusKey("completed"), "done");
assert.equal(toLiveBoardStatusKey("inbox"), "inbox");
assert.equal(toLiveBoardStatusKey("done"), "done");
assert.equal(toLiveBoardStatusKey("closed"), "closed");

for (const key of LIVE_BOARD_STATUS_KEYS) {
  assert.equal(toLiveBoardStatusKey(key), key);
}

console.log("server/boards.test.ts: ok");

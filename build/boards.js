"use strict";
/**
 * Live Nubis board keys, matching PMTool `src/lib/boards.ts`.
 * MCP aliases: backlog → inbox, completed → done.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_BOARD_KEYS = exports.LIVE_BOARD_STATUS_KEYS = void 0;
exports.toLiveBoardStatusKey = toLiveBoardStatusKey;
exports.mapSchemaBoard = mapSchemaBoard;
exports.LIVE_BOARD_STATUS_KEYS = [
    "inbox",
    "priority",
    "bugs",
    "in-progress",
    "reviewing",
    "done",
    "closed",
];
exports.MCP_BOARD_KEYS = [
    ...exports.LIVE_BOARD_STATUS_KEYS,
    "backlog",
    "completed",
];
const UI_TO_LIVE_STATUS_KEY = {
    backlog: "inbox",
    completed: "done",
};
function toLiveBoardStatusKey(value) {
    const trimmed = value.trim();
    const aliased = UI_TO_LIVE_STATUS_KEY[trimmed.toLowerCase()];
    if (aliased)
        return aliased;
    return trimmed;
}
/** Map `schema.board` onto a live key when present. */
function mapSchemaBoard(schema) {
    if (typeof schema.board !== "string" || !schema.board.trim())
        return schema;
    return { ...schema, board: toLiveBoardStatusKey(schema.board) };
}

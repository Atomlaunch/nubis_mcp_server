/**
 * Live Nubis board keys, matching PMTool `src/lib/boards.ts`.
 * MCP aliases: backlog → inbox, completed → done.
 */

export const LIVE_BOARD_STATUS_KEYS = [
  "inbox",
  "priority",
  "bugs",
  "in-progress",
  "reviewing",
  "done",
  "closed",
] as const;

export type LiveBoardStatusKey = (typeof LIVE_BOARD_STATUS_KEYS)[number];

export const MCP_BOARD_KEYS = [
  ...LIVE_BOARD_STATUS_KEYS,
  "backlog",
  "completed",
] as const;

export type McpBoardKey = (typeof MCP_BOARD_KEYS)[number];

const UI_TO_LIVE_STATUS_KEY: Record<string, LiveBoardStatusKey> = {
  backlog: "inbox",
  completed: "done",
};

export function toLiveBoardStatusKey(value: string): string {
  const trimmed = value.trim();
  const aliased = UI_TO_LIVE_STATUS_KEY[trimmed.toLowerCase()];
  if (aliased) return aliased;
  return trimmed;
}

/** Map `schema.board` onto a live key when present. */
export function mapSchemaBoard<T extends { board?: unknown }>(schema: T): T {
  if (typeof schema.board !== "string" || !schema.board.trim()) return schema;
  return { ...schema, board: toLiveBoardStatusKey(schema.board) };
}

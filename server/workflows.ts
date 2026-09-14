import { toLiveBoardStatusKey } from "./boards.js";

export type Column = {
  id: string;
  board_id: string;
  name: string;
  position: number;
  behavior: "active" | "done" | "closed";
  legacy_status_key: string | null;
};
export type Workflow = {
  id: string;
  project_id: string;
  name: string;
  position: number;
  is_default: boolean;
  columns: Column[];
};
type TaskRouting = {
  branch_id?: string | null;
  board_id?: string | null;
  board_column_id?: string | null;
  board?: string;
};
const provided = (input: Record<string, unknown>, key: string) =>
  input[key] !== undefined;
export function projectInput(
  input: Record<string, unknown>,
): string | null | undefined {
  if (
    provided(input, "project_id") &&
    provided(input, "bolt_id") &&
    input.project_id !== input.bolt_id
  )
    throw new Error("project_id and bolt_id conflict");
  const value = provided(input, "project_id")
    ? input.project_id
    : input.bolt_id;
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ))
  )
    throw new Error("Project must be a UUID or null");
  return value as string | null | undefined;
}
export function legacyStatus(column: Column): string {
  if (column.behavior !== "active") return column.behavior;
  const value = column.legacy_status_key;
  return value && !["done", "completed", "closed"].includes(value)
    ? toLiveBoardStatusKey(value)
    : "in-progress";
}

/** Catalog must already be restricted to the authenticated workspace. */
export function resolveRouting(
  input: Record<string, unknown>,
  catalog: Workflow[],
  current?: TaskRouting,
): TaskRouting {
  const project = projectInput(input);
  if (
    current &&
    !["board", "board_id", "board_column_id", "project_id", "bolt_id"].some(
      (key) => provided(input, key),
    )
  )
    return {};
  if (project === null) {
    if (input.board_id || input.board_column_id)
      throw new Error("A workflow requires a project");
    return {
      branch_id: null,
      board_id: null,
      board_column_id: null,
      board:
        typeof input.board === "string"
          ? toLiveBoardStatusKey(input.board)
          : "inbox",
    };
  }
  if (
    current &&
    project === current.branch_id &&
    !["board", "board_id", "board_column_id"].some((key) =>
      provided(input, key),
    )
  )
    return {};
  const changedProject =
    project !== undefined && project !== current?.branch_id;
  let board: Workflow | undefined;
  let column: Column | undefined;
  if (input.board_column_id) {
    board = catalog.find((item) =>
      item.columns.some((c) => c.id === input.board_column_id),
    );
    column = board?.columns.find((c) => c.id === input.board_column_id);
    if (!column || !board)
      throw new Error("Column not found in this workspace");
    if (input.board_id && input.board_id !== board.id)
      throw new Error("Column does not belong to selected board");
  } else if (input.board_id) {
    board = catalog.find((item) => item.id === input.board_id);
    if (!board) throw new Error("Board not found in this workspace");
  } else if (!changedProject && current?.board_id) {
    board = catalog.find((item) => item.id === current.board_id);
    if (!board)
      throw new Error("Current workflow is unavailable; select another board");
  }
  if (board && project !== undefined && board.project_id !== project)
    throw new Error("Board does not belong to selected project");
  const targetProject =
    project ?? board?.project_id ?? current?.branch_id ?? null;
  if (!board && targetProject)
    board = catalog.find(
      (item) => item.project_id === targetProject && item.is_default,
    );
  if (!board) {
    if (targetProject)
      throw new Error("Project has no default workflow; choose a board");
    return {
      branch_id: null,
      board_id: null,
      board_column_id: null,
      board:
        typeof input.board === "string"
          ? toLiveBoardStatusKey(input.board)
          : current?.board || "inbox",
    };
  }
  if (!column && input.board) {
    const requested = toLiveBoardStatusKey(String(input.board));
    const matches = board.columns.filter(
      (c) => c.legacy_status_key && legacyStatus(c) === requested,
    );
    const candidates = matches.length
      ? matches
      : board.columns.filter((c) => c.behavior === requested);
    if (candidates.length !== 1)
      throw new Error(
        "Legacy status is unavailable or ambiguous; use board_column_id from get_task_boards",
      );
    column = candidates[0];
  }
  if (!column)
    column = [...board.columns]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .find((c) => c.behavior === "active");
  if (!column)
    throw new Error("Workflow has no active column; choose board_column_id");
  return {
    branch_id: board.project_id,
    board_id: board.id,
    board_column_id: column.id,
    board: legacyStatus(column),
  };
}

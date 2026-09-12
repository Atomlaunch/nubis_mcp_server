export function isMissingRow(
  error: { code?: string; message?: string } | null | undefined
): boolean {
  if (!error) return false;
  if (error.code === "PGRST116") return true;
  return /0 rows/i.test(error.message ?? "");
}

export function schemaFieldProvided(
  schema: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  return Boolean(schema && Object.prototype.hasOwnProperty.call(schema, key));
}

export function appendTaskContext(
  existing: string | null | undefined,
  added: string
): string {
  const current = existing ?? "";
  if (!current) return added;
  if (!added) return current;
  return `${current}\n\n${added}`;
}

export function bulkTaskNumbers(
  baseNumber: number,
  baseSort: number,
  count: number
): Array<{ task_number: number; sort_order: number }> {
  return Array.from({ length: count }, (_, i) => ({
    task_number: baseNumber + i + 1,
    sort_order: baseSort + (i + 1) * 1000,
  }));
}

export function buildTaskUpdatePatch(
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!schema) return patch;

  if (schemaFieldProvided(schema, "title")) {
    patch.title = schema.title;
  }
  if (schemaFieldProvided(schema, "description")) {
    patch.description = schema.description;
  }
  if (schemaFieldProvided(schema, "board") && schema.board != null) {
    patch.board = schema.board;
  }
  if (schemaFieldProvided(schema, "bolt_id")) {
    patch.branch_id = schema.bolt_id || null;
  }
  if (schemaFieldProvided(schema, "parent_task_id")) {
    patch.parent_task_id = schema.parent_task_id || null;
  }
  if (schemaFieldProvided(schema, "github_item_type")) {
    patch.github_item_type = schema.github_item_type || null;
  }
  if (schemaFieldProvided(schema, "github_file_path")) {
    patch.github_file_path = schema.github_file_path || null;
  }
  if (schemaFieldProvided(schema, "github_repo_name")) {
    patch.github_repo_name = schema.github_repo_name || null;
  }

  return patch;
}

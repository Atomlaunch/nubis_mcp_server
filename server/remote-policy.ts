export const MCP_SCOPES = ["nubis.tasks.read", "nubis.tasks.write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

// Explicit allowlists: adding a stdio tool does not automatically expose it remotely.
const readTools = [
  "get_projects",
  "get_boltz",
  "get_task_boards",
  "get_tasks",
  "get_task_details",
  "get_task_context",
  "get_task_images",
  "work_on_task",
];
const writeTools = [
  "create_task",
  "update_task",
  "move_task",
  "add_comment",
  "add_context_to_task",
];
const readEndpoints = [
  "get_projects",
  "get_boltz",
  "get_task_boards",
  "get_tasks",
  "get_task",
  "get_task_context",
  "get_task_images",
  "work_on_task",
];
const writeEndpoints = [
  "create_task",
  "update_task",
  "move_task",
  "add_comment",
  "add_context_to_task",
];

export function allowsTool(scopes: readonly string[], name: string): boolean {
  return (
    (scopes.includes(MCP_SCOPES[0]) && readTools.includes(name)) ||
    (scopes.includes(MCP_SCOPES[1]) && writeTools.includes(name))
  );
}
export function allowsEndpoint(
  scopes: readonly string[],
  name: string,
): boolean {
  return (
    (scopes.includes(MCP_SCOPES[0]) && readEndpoints.includes(name)) ||
    (scopes.includes(MCP_SCOPES[1]) && writeEndpoints.includes(name))
  );
}

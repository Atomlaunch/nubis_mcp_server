import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRow } from "./task-patches.js";

/** The existing workspace/task-number unique constraint arbitrates concurrent creators. */
export async function insertWorkspaceTask(
  db: SupabaseClient,
  workspaceId: string,
  fields: Record<string, unknown>,
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [number, order] = await Promise.all([
      db
        .from("pm_tasks")
        .select("task_number")
        .eq("project_id", workspaceId)
        .order("task_number", { ascending: false })
        .limit(1)
        .single(),
      db
        .from("pm_tasks")
        .select("sort_order")
        .eq("project_id", workspaceId)
        .order("sort_order", { ascending: false })
        .limit(1)
        .single(),
    ]);
    if (number.error && !isMissingRow(number.error))
      return { ...number, data: null };
    if (order.error && !isMissingRow(order.error))
      return { ...order, data: null };
    const inserted = await db
      .from("pm_tasks")
      .insert({
        ...fields,
        project_id: workspaceId,
        task_number: (number.data?.task_number || 0) + 1,
        sort_order: (order.data?.sort_order || 0) + 1000,
      })
      .select("*")
      .single();
    // Only this confirmed unique violation proves the insert did not happen.
    // Never retry an ambiguous network failure, permission denial or another constraint.
    const numberingConflict =
      inserted.error?.code === "23505" &&
      inserted.error.message.includes("pm_tasks_project_id_task_number_key");
    if (!numberingConflict || attempt === 7) return inserted;
  }
  throw new Error("Unreachable task creation state");
}

import { Express, Request, Response } from "express";
import { authorizeMcpRequest } from "../index.js";
import { appendTaskContext, isMissingRow } from "../task-patches.js";

/**
 * Registers the /add_context_to_task endpoint with the Express app.
 * @param app Express application instance
 */
export function registerAddContextToTaskEndpoint(app: Express): void {
  app.post("/add_context_to_task", async (req: Request, res: Response): Promise<void> => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json({ success: false, ...auth.body });
      return;
    }
    const { workspaceId, schema, api_usage, db } = auth;
    if (!schema?.taskID || !schema?.context) {
      res.status(400).json({ success: false, error: "Missing required fields", api_usage });
      return;
    }
    const { data: existing, error: fetchError } = await db
      .from("pm_tasks")
      .select("id, context")
      .eq("id", schema.taskID)
      .eq("project_id", workspaceId)
      .maybeSingle();
    if (fetchError && !isMissingRow(fetchError)) {
      res.status(500).json({ success: false, error: fetchError.message, api_usage });
      return;
    }
    if (!existing) {
      res.status(404).json({ success: false, error: "Task not found", api_usage });
      return;
    }

    const nextContext = appendTaskContext(existing.context, schema.context);
    const { data, error: insertError } = await db
      .from("pm_tasks")
      .update({
        context: nextContext,
      })
      .eq("id", schema.taskID)
      .eq("project_id", workspaceId)
      .select("id, context")
      .maybeSingle();
    if (insertError) {
      res.status(500).json({ success: false, error: insertError.message, api_usage });
      return;
    }
    if (!data) {
      res.status(404).json({ success: false, error: "Task not found", api_usage });
      return;
    }
    res.json({
      success: true,
      error: null,
      data: { taskID: schema.taskID, context: data.context },
      api_usage,
    });
  });
}

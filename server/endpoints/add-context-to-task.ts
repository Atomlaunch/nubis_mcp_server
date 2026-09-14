import { Express, Request, Response } from "express";
import { authorizeMcpRequest } from "../index.js";
import { appendTaskContext, isMissingRow } from "../task-patches.js";

export function registerAddContextToTaskEndpoint(
  app: Express,
  register: (
    path: string,
    handler: (req: Request, res: Response) => Promise<void>,
  ) => void = (path, handler) => {
    app.post(path, handler);
  },
): void {
  register("/add_context_to_task", async (req, res) => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json({ success: false, ...auth.body });
      return;
    }
    const { workspaceId, schema, api_usage, db } = auth;
    if (!schema?.taskID || !schema?.context) {
      res
        .status(400)
        .json({ success: false, error: "Missing required fields", api_usage });
      return;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data: existing, error: fetchError } = await db
        .from("pm_tasks")
        .select("id, context, xmin")
        .eq("id", schema.taskID)
        .eq("project_id", workspaceId)
        .maybeSingle();
      if (fetchError && !isMissingRow(fetchError)) {
        res
          .status(500)
          .json({ success: false, error: fetchError.message, api_usage });
        return;
      }
      if (!existing) {
        res
          .status(404)
          .json({ success: false, error: "Task not found", api_usage });
        return;
      }
      // Use the row's MVCC version, not context text in a URL (which leaks
      // content into request logs and breaks on large notes).
      // Retry only a confirmed zero-row update, never an uncertain write error.
      const update = db
        .from("pm_tasks")
        .update({
          context: appendTaskContext(existing.context, schema.context),
        })
        .eq("id", schema.taskID)
        .eq("project_id", workspaceId);
      const { data, error } = await update
        .eq("xmin", existing.xmin)
        .select("id, context")
        .maybeSingle();
      if (error) {
        res
          .status(500)
          .json({ success: false, error: error.message, api_usage });
        return;
      }
      if (!data) continue;
      res.json({
        success: true,
        error: null,
        data: { taskID: schema.taskID, context: data.context },
        api_usage,
      });
      return;
    }
    res.status(409).json({
      success: false,
      error:
        "Context changed concurrently or the update was not permitted. Reload before retrying.",
      api_usage,
    });
  });
}

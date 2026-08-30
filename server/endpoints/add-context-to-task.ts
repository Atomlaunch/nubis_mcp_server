import { Express, Request, Response } from "express";
import { authorizeMcpRequest } from "../index.js";

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
    const { schema, api_usage, db } = auth;
    if (!schema?.taskID || !schema?.context) {
      res.status(400).json({ success: false, error: "Missing required fields" });
      return;
    }
    const { error: insertError } = await db
      .from("pm_tasks")
      .update({
        context: schema.context,
      })
      .eq("id", schema.taskID);
    if (insertError) {
      res.status(500).json({ success: false, error: insertError.message, api_usage });
      return;
    }
    res.json({
      success: true,
      error: null,
      data: { taskID: schema.taskID, context: schema.context },
      api_usage,
    });
  });
}

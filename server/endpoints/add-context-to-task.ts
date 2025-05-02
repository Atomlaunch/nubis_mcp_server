import { Express, Request, Response } from "express";
import { supabase } from "../index.js";
import { checkUserApiKey } from "../index.js";

/**
 * Request body for addContextToTask endpoint.
 */
export type AddContextToTaskRequest = {
  workspaceId: string;
  apiKey: string;
  schema: {
    taskID: string;
    context: string;
  };
};

/**
 * Response body for addContextToTask endpoint.
 */
export type AddContextToTaskResponse = {
  success: boolean;
  error: string | null;
  data?: {
    taskID: string;
    context: string;
  };
  api_usage?: {
    count: "descending";
    remaining_calls: number;
    total_limit: number;
  };
};

/**
 * Registers the /add_context_to_task endpoint with the Express app.
 * @param app Express application instance
 */
export function registerAddContextToTaskEndpoint(app: Express): void {
  app.post("/add_context_to_task", async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, apiKey, schema } = req.body as AddContextToTaskRequest;
    if (!workspaceId || !apiKey || !schema?.taskID || !schema?.context) {
      res.status(400).json({ success: false, error: "Missing required fields" });
      return;
    }
    // Check user API key
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      res.status(401).json({ success: false, error: auth.error, api_usage: auth.api_usage });
      return;
    }
    // Add context to task (assumes a pm_task_context table exists)
    const { error: insertError } = await supabase
      .from("pm_tasks")
      .update({
        context: schema.context,
      })
      .eq("id", schema.taskID);
    if (insertError) {
      res.status(500).json({ success: false, error: insertError.message, api_usage: auth.api_usage });
      return;
    }
    res.json({
      success: true,
      error: null,
      data: { taskID: schema.taskID, context: schema.context },
      api_usage: auth.api_usage,
    });
  });
}

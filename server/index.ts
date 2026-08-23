import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";



// Register all new endpoints from server/endpoints here for maintainability
import { registerAddContextToTaskEndpoint } from "./endpoints/add-context-to-task.js";
import { credentialsFromRequest } from "./request-auth.js";

dotenv.config();

const SUPABASE_URL: string = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY: string =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PORT: number = Number(process.env.PORT) || 4000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment"
  );
}

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

app.set("trust proxy", true);
app.use(express.json());

// Rate limit middleware
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5000, // limit each IP to 50 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error:
      "Too many requests, please try again later. (500 requests per 5 minutes)",
  },
});

// Apply rate limiter to all routes
app.use(apiLimiter);

/**
 * Health check endpoint.
 */
app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok" });
});

// Log Request
app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.url}`);
  next();
});

// Helper to validate API key and return a Supabase client for the user
export async function checkUserApiKey(apiKey: string, workspaceId: string) {
  try {
    if (!workspaceId) {
      return {
        success: false,
        error: "workspaceId is required",
        api_usage: null
      };
    }
    if (!apiKey) {
      return {
        success: false,
        error: "apiKey is required",
        api_usage: null
      };
    }
    // Validate apiKey in api_key table
    const { data, error } = await supabase
      .from("api_keys")
      .select("*")
      .eq("api_key", apiKey)
      .single();
    if (error || !data) {
      return {
        success: false,
        error: "Invalid or unauthorized apiKey",
        api_usage: null
      };
    }

    const { user_id } = data;

    // Check for Permissions
    const { data: workspaceData, error: workspaceError } = await supabase
      .from("pm_members")
      .select("id, role")
      .eq("project_id", workspaceId)
      .eq("user_id", user_id)
      .single();
    if (workspaceError || !workspaceData) {
      return {
        success: false,
        error: `User does not have access to workspace ${workspaceId}`,
        api_usage: null
      };
    }

    const role = workspaceData.role;
    const is_admin = role === "owner" || role === "admin";

    // check if user has access to workspace
    if (!is_admin) {
      const { data: permissionsData, error: permissionsError } = await supabase
        .from("pm_role_permissions")
        .select("*")
        .eq("project_id", workspaceId)
        .eq("role", workspaceData.role)
        .eq("resource", "api_calls")
        .single();
      if (permissionsError || !permissionsData) {
        return {
          success: false,
          error: "User does not have access to resource api_calls",
          api_usage: null
        };
      }
    }

    // Query workspace subscription to get plan limits
    const { data: subscription } = await supabase
      .from("workspace_subscriptions")
      .select(`
        status,
        subscription_plans (
          name,
          price_monthly,
          features
        )
      `)
      .eq("project_id", workspaceId)
      .eq("status", "active")
      .single();

    // Extract plan info - default to free tier limits if no subscription
    const priceMonthly = (subscription?.subscription_plans as any)?.price_monthly || 0;
    const isPaidPlan = priceMonthly > 0;
    const planName = (subscription?.subscription_plans as any)?.name || "Stratus";

    // For paid plans, skip limit checking entirely (unlimited API calls)
    if (isPaidPlan) {
      console.log(
        `API call for workspace ${workspaceId} on paid plan "${planName}" - unlimited calls`
      );
      return {
        success: true,
        error: null,
        api_usage: {
          remaining_calls: "unlimited",
          total_limit: "unlimited",
          plan: planName
        }
      };
    }

    // For free plans, check and enforce API usage limits
    const { data: apiUsageData, error: apiUsageError } = await supabase
      .from("api_usage")
      .select("*")
      .eq("project_id", workspaceId)
      .single();
    if (apiUsageError || !apiUsageData) {
      return {
        success: false,
        error: `API usage limit not found for workspace ${workspaceId}`,
        api_usage: null
      };
    }

    if (apiUsageData.remaining_calls <= 0) {
      return {
        success: false,
        error: "API usage limit exceeded",
        api_usage: {
          remaining_calls: apiUsageData.remaining_calls,
          total_limit: apiUsageData.total_limit,
          plan: planName
        }
      };
    }

    // Update API Usage - 1
    const { error: updateError } = await supabase
      .from("api_usage")
      .update({ remaining_calls: apiUsageData.remaining_calls - 1 })
      .eq("project_id", workspaceId);

    if (updateError) {
      return {
        success: false,
        error: "Failed to update API usage",
        api_usage: {
          remaining_calls: apiUsageData.remaining_calls,
          total_limit: apiUsageData.total_limit,
          plan: planName
        }
      };
    }
    console.log(
      `API usage updated for workspace ${workspaceId} on plan "${planName}", Total Calls: ${apiUsageData.total_limit}, Remaining Calls: ${apiUsageData.remaining_calls - 1}`
    );

    // Return if user has access to workspace
    return {
      success: true,
      error: null,
      api_usage: {
        remaining_calls: apiUsageData.remaining_calls - 1,
        total_limit: apiUsageData.total_limit,
        plan: planName
      }
    };
  } catch (error) {
    console.error(error);
    return {
      success: false,
      error: "Failed to check user API key",
      api_usage: null
    };
  }
}

export async function getUserProfile(apiKey: string) {
  try {
    if (!apiKey) throw new Error("apiKey is required");
    const { data, error } = await supabase
      .from("api_keys")
      .select("*")
      .eq("api_key", apiKey)
      .single();
    if (error || !data) throw new Error("Invalid or unauthorized apiKey");

    // Get userID
    const { user_id } = data;
    return { data: user_id, error: null };
  } catch (error) {
    console.error(error);
    return { data: null, error: null };
  }
}

const TASK_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DeletedTaskSummary = {
  id: string;
  title: string;
  task_number: number | null;
  board: string | null;
};

/**
 * Delete tasks that belong to the authenticated workspace only.
 * Related rows (comments, labels, blockers, commits, assignments) cascade in the DB.
 * Missing / invalid / other-workspace IDs are reported instead of failing the batch.
 */
export async function deleteWorkspaceTasks(
  workspaceId: string,
  taskIDs: unknown[]
): Promise<{ deleted: DeletedTaskSummary[]; missing: string[]; error: string | null }> {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of taskIDs) {
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  if (uniqueIds.length === 0) {
    return { deleted: [], missing: [], error: null };
  }

  const invalidOrMalformed = uniqueIds.filter((id) => !TASK_ID_UUID_RE.test(id));
  const lookupIds = uniqueIds.filter((id) => TASK_ID_UUID_RE.test(id));

  if (lookupIds.length === 0) {
    return { deleted: [], missing: invalidOrMalformed, error: null };
  }

  const { data: existing, error: lookupError } = await supabase
    .from("pm_tasks")
    .select("id, title, task_number, board")
    .eq("project_id", workspaceId)
    .in("id", lookupIds);

  if (lookupError) {
    return { deleted: [], missing: [], error: lookupError.message };
  }

  const foundIds = new Set((existing || []).map((task) => task.id as string));
  const missing = uniqueIds.filter((id) => !foundIds.has(id));
  const toDelete = lookupIds.filter((id) => foundIds.has(id));

  if (toDelete.length === 0) {
    return { deleted: [], missing, error: null };
  }

  // pm_tasks.blocked_by_task_id is ON DELETE NO ACTION; clear same-workspace refs first.
  const { error: unblockError } = await supabase
    .from("pm_tasks")
    .update({ blocked_by_task_id: null })
    .eq("project_id", workspaceId)
    .in("blocked_by_task_id", toDelete);

  if (unblockError) {
    return { deleted: [], missing, error: unblockError.message };
  }

  const { data: deletedRows, error: deleteError } = await supabase
    .from("pm_tasks")
    .delete()
    .eq("project_id", workspaceId)
    .in("id", toDelete)
    .select("id, title, task_number, board");

  if (deleteError) {
    return { deleted: [], missing, error: deleteError.message };
  }

  return {
    deleted: (deletedRows || []) as DeletedTaskSummary[],
    missing,
    error: null,
  };
}

/**
 * Get all Boltz
 */
app.post("/get_boltz", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  console.log({ workspaceId, apiKey, schema });
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: boltzError } = await supabase
    .from("pm_branches")
    .select("*")
    .eq("project_id", workspaceId);
  if (boltzError) {
    res.status(500).json({ error: boltzError.message, api_usage: auth.api_usage });
    return;
  }
  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Return tasks for a workspace
 */
app.post("/get_tasks", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  console.log({ workspaceId, apiKey, schema });
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  let query = supabase
    .from("pm_tasks")
    .select(
      `*, branch_id, board, parent_task_id, sort_order, task_number, created_by, github_item_type, github_file_path, github_repo_name, pm_task_blockers!pm_task_blockers_task_id_fkey(id, blocker_task_id, task_id)`
    )
    .order("created_at", { ascending: false })
    .eq("project_id", workspaceId);

  if (schema?.bolt_id) {
    query = query.eq("branch_id", schema.bolt_id);
  }

  if (schema?.board) {
    query = query.in("board", [schema.board]);
  }

  if (schema?.limit) {
    query = query.limit(schema.limit);
  }

  const { data, error: tasksError } = await query;

  if (tasksError) {
    res.status(500).json({ error: tasksError.message, api_usage: auth.api_usage });
    return;
  }
  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Return task by ID
 */
app.post("/get_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  console.log({ workspaceId, apiKey, schema });
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: taskError } = await supabase
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  // Get SubTasks
  const { data: subTasks, error: subTasksError } = await supabase
    .from("pm_tasks")
    .select(
      "id, task_number, title, description, board, images, branch_id, github_item_type, github_file_path, github_repo_name, pm_task_blockers!pm_task_blockers_task_id_fkey(id, blocker_task_id, task_id)"
    )
    .order("sort_order", { ascending: false })
    .eq("project_id", workspaceId)
    .eq("parent_task_id", data?.id);

  if (subTasksError) {
    console.error({ subTasksError });
    res.status(500).json({ error: subTasksError.message, api_usage: auth.api_usage });
    return;
  }

  // Get Task Comments
  const { data: comments, error: commentsError } = await supabase
    .from("pm_comments")
    .select("*")
    .eq("task_id", schema?.taskID)
    .eq("project_id", workspaceId);

  if (commentsError) {
    console.error({ commentsError });
    res.status(500).json({ error: commentsError.message, api_usage: auth.api_usage });
    return;
  }

  data.subtasks = subTasks ? [subTasks] : [];
  data.comments = comments ? [comments] : [];
  if (taskError) {
    res.status(500).json({ error: taskError.message, api_usage: auth.api_usage });
    return;
  }
  res.json({ data, api_usage: auth.api_usage });
});

/** 
 * Get Task Context
 */
app.post("/get_task_context", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: taskError } = await supabase
    .from("pm_tasks")
    .select("context")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError) {
    res.status(500).json({ error: taskError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Return task images by ID
 */
app.post(
  "/get_task_images",
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, apiKey, schema } = req.body as {
      workspaceId: string;
      apiKey: string;
      schema: any;
    };
    console.log({ workspaceId, apiKey, schema });
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
      return;
    }

    const { data, error: taskError } = await supabase
      .from("pm_tasks")
      .select("images")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError) {
      res.status(500).json({ error: taskError.message, api_usage: auth.api_usage });
      return;
    }
    res.json({ data, api_usage: auth.api_usage });
  }
);

/**
 * Return work on task
 */
app.post(
  "/work_on_task",
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, apiKey, schema } = req.body as {
      workspaceId: string;
      apiKey: string;
      schema: any;
    };
    console.log({ workspaceId, apiKey, schema });
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
      return;
    }

    /* const { error: updateError } = await supabase
      .from("pm_tasks")
      .update({ board: "in-progress" })
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId);
    if (updateError) {
      res.status(500).json({ error: updateError.message, api_usage: auth.api_usage });
      return;
    } */

    const { data, error: taskError } = await supabase
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError) throw new Error(taskError.message);

    // Return updated task
    res.json({ data, api_usage: auth.api_usage });
  }
);

/**
 * Return explain_task
 */
app.post(
  "/explain_task",
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, apiKey, schema } = req.body as {
      workspaceId: string;
      apiKey: string;
      schema: any;
    };
    console.log({ workspaceId, apiKey, schema });
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
      return;
    }

    const { data, error: taskError } = await supabase
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError) throw new Error(taskError.message);

    res.json({ data, api_usage: auth.api_usage });
  }
);

/**
 * Return move_task
 */
app.post("/move_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  console.log({ workspaceId, apiKey, schema });
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { error: updateError } = await supabase
    .from("pm_tasks")
    .update({ board: schema?.board })
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId);
  if (updateError) {
    res.status(500).json({ error: updateError.message, api_usage: auth.api_usage });
    return;
  }

  const { data, error: taskError } = await supabase
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError) throw new Error(taskError.message);

  res.json({ data, api_usage: auth.api_usage });
});

/**
 *  Return Create Task
 */
app.post("/create_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  console.log({ workspaceId, apiKey, schema });
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data: userId, error: userError } = await getUserProfile(apiKey);
  console.log({ userId, userError });
  if (!userId || userError) {
    res.status(401).json({ error: "Unauthorized", api_usage: auth.api_usage });
    return;
  }

  // Get max task number for the project
  const { data: maxTaskNumber } = await supabase
    .from("pm_tasks")
    .select("task_number")
    .eq("project_id", workspaceId)
    .order("task_number", { ascending: false })
    .limit(1)
    .single();

  // Get max sort order
  const { data: maxSortOrder } = await supabase
    .from("pm_tasks")
    .select("sort_order")
    .eq("project_id", workspaceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();

  const { data, error: insertError } = await supabase
    .from("pm_tasks")
    .insert({
      title: schema?.title,
      description: schema?.description,
      board: schema?.board || "inbox",
      parent_task_id: schema?.parent_task_id || null,
      project_id: workspaceId,
      sort_order: (maxSortOrder?.sort_order || 0) + 1000,
      task_number: (maxTaskNumber?.task_number || 0) + 1,
      branch_id: schema?.bolt_id || null,
      github_item_type: schema?.github_item_type || null,
      github_file_path: schema?.github_file_path || null,
      github_repo_name: schema?.github_repo_name || null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Update task
 */
app.post("/update_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };

  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data: userId, error: userError } = await getUserProfile(apiKey);
  if (!userId || userError) {
    res.status(401).json({ error: "Unauthorized", api_usage: auth.api_usage });
    return;
  }

  // get task data
  const { data: task, error: taskError } = await supabase
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError) {
    res.status(500).json({ error: taskError.message, api_usage: auth.api_usage });
    return;
  }

  const { data, error: updateError } = await supabase
    .from("pm_tasks")
    .update({
      title: schema?.title,
      description: schema?.description,
      board: schema?.board || task?.board || "inbox",
      branch_id: schema?.bolt_id || task?.branch_id || null,
      parent_task_id: schema?.parent_task_id || task?.parent_task_id || null,
      github_item_type: schema?.github_item_type || task?.github_item_type || null,
      github_file_path: schema?.github_file_path || task?.github_file_path || null,
      github_repo_name: schema?.github_repo_name || task?.github_repo_name || null,
    })
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .select("*")
    .single();
  if (updateError) {
    res.status(500).json({ error: updateError.message, api_usage: auth.api_usage });
    return;
  }
  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Delete a single task in the authenticated workspace.
 * Missing IDs are reported instead of failing the request.
 */
app.post("/delete_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = credentialsFromRequest(req);
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  if (typeof schema?.taskID !== "string" || !schema.taskID.trim()) {
    res.status(400).json({ error: "taskID is required", api_usage: auth.api_usage });
    return;
  }

  const result = await deleteWorkspaceTasks(workspaceId, [schema.taskID]);
  if (result.error) {
    res.status(500).json({ error: result.error, api_usage: auth.api_usage });
    return;
  }

  res.json({
    data: {
      deleted: result.deleted[0] || null,
      missing: result.missing,
    },
    api_usage: auth.api_usage,
  });
});

/**
 * Delete multiple tasks in the authenticated workspace.
 * Missing IDs are reported per id; the rest of the batch still deletes.
 */
app.post("/delete_tasks", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = credentialsFromRequest(req);
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  if (!Array.isArray(schema?.taskIDs)) {
    res.status(400).json({ error: "taskIDs must be an array", api_usage: auth.api_usage });
    return;
  }

  const result = await deleteWorkspaceTasks(workspaceId, schema.taskIDs);
  if (result.error) {
    res.status(500).json({ error: result.error, api_usage: auth.api_usage });
    return;
  }

  res.json({
    data: {
      deleted: result.deleted,
      missing: result.missing,
    },
    api_usage: auth.api_usage,
  });
});

/**
 *  Return Create Bulk Tasks
 */
app.post(
  "/create_bulk_tasks",
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, apiKey, schema } = req.body as {
      workspaceId: string;
      apiKey: string;
      schema: any;
    };
    console.log({ workspaceId, apiKey, schema });
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
      return;
    }

    const userId = await getUserProfile(apiKey);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized", api_usage: auth.api_usage });
      return;
    }

    // Get max task number for the project
    const { data: maxTaskNumber } = await supabase
      .from("pm_tasks")
      .select("task_number")
      .eq("project_id", workspaceId)
      .order("task_number", { ascending: false })
      .limit(1)
      .single();

    // Get max sort order
    const { data: maxSortOrder } = await supabase
      .from("pm_tasks")
      .select("sort_order")
      .eq("project_id", workspaceId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .single();

    const { data, error: insertError } = await supabase
      .from("pm_tasks")
      .insert(
        schema?.tasks.map((task: any) => ({
          title: task.title,
          description: task.description,
          board: task.board || "inbox",
          parent_task_id: task.parent_task_id || null,
          project_id: workspaceId,
          sort_order: (maxSortOrder?.sort_order || 0) + 1000,
          task_number: (maxTaskNumber?.task_number || 0) + 1,
          created_by: userId,
        }))
      )
      .select("*");
    if (insertError) {
      res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
      return;
    }

    res.json({ data, api_usage: auth.api_usage });
  }
);

registerAddContextToTaskEndpoint(app);

/**
 * Add Comment to Task
 */
app.post("/add_comment", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data: userId, error: userError } = await getUserProfile(apiKey);
  if (!userId || userError) {
    res.status(401).json({ error: "Unauthorized", api_usage: auth.api_usage });
    return;
  }

  const { data, error: insertError } = await supabase
    .from("pm_comments")
    .insert({
      task_id: schema?.taskID,
      project_id: workspaceId,
      content: schema?.content,
      parent_id: schema?.parent_id || null,
      user_id: userId,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Add Blocker to Task
 */
app.post("/add_blocker", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: insertError } = await supabase
    .from("pm_task_blockers")
    .insert({
      task_id: schema?.taskID,
      blocker_task_id: schema?.blocker_task_id,
      project_id: workspaceId,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Remove Blocker from Task
 */
app.post("/remove_blocker", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { error: deleteError } = await supabase
    .from("pm_task_blockers")
    .delete()
    .eq("task_id", schema?.taskID)
    .eq("blocker_task_id", schema?.blocker_task_id)
    .eq("project_id", workspaceId);

  if (deleteError) {
    res.status(500).json({ error: deleteError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data: { removed: true, task_id: schema?.taskID, blocker_task_id: schema?.blocker_task_id }, api_usage: auth.api_usage });
});

/**
 * Get Labels for Workspace
 */
app.post("/get_labels", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: labelsError } = await supabase
    .from("pm_labels")
    .select("*")
    .eq("project_id", workspaceId);

  if (labelsError) {
    res.status(500).json({ error: labelsError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Add Label to Task
 */
app.post("/add_label_to_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  // Verify task belongs to workspace
  const { data: task, error: taskError } = await supabase
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage: auth.api_usage });
    return;
  }

  const { data, error: insertError } = await supabase
    .from("pm_task_labels")
    .insert({
      task_id: schema?.taskID,
      label_id: schema?.label_id,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Remove Label from Task
 */
app.post("/remove_label_from_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  // Verify task belongs to workspace
  const { data: task, error: taskError } = await supabase
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage: auth.api_usage });
    return;
  }

  const { error: deleteError } = await supabase
    .from("pm_task_labels")
    .delete()
    .eq("task_id", schema?.taskID)
    .eq("label_id", schema?.label_id);

  if (deleteError) {
    res.status(500).json({ error: deleteError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data: { removed: true, task_id: schema?.taskID, label_id: schema?.label_id }, api_usage: auth.api_usage });
});

/**
 * Get Task Commits
 */
app.post("/get_task_commits", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  // Verify task belongs to workspace
  const { data: task, error: taskError } = await supabase
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage: auth.api_usage });
    return;
  }

  const { data, error: commitsError } = await supabase
    .from("pm_task_commits")
    .select("*")
    .eq("task_id", schema?.taskID)
    .order("linked_at", { ascending: false });

  if (commitsError) {
    res.status(500).json({ error: commitsError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Link Commit to Task
 */
app.post("/link_commit_to_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data: userId, error: userError } = await getUserProfile(apiKey);
  if (!userId || userError) {
    res.status(401).json({ error: "Unauthorized", api_usage: auth.api_usage });
    return;
  }

  // Verify task belongs to workspace
  const { data: task, error: taskError } = await supabase
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage: auth.api_usage });
    return;
  }

  const { data, error: insertError } = await supabase
    .from("pm_task_commits")
    .insert({
      task_id: schema?.taskID,
      commit_sha: schema?.commit_sha,
      repo_name: schema?.repo_name,
      commit_message: schema?.commit_message || null,
      commit_author: schema?.commit_author || null,
      linked_by: userId,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Get Teams for Workspace
 */
app.post("/get_teams", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: teamsError } = await supabase
    .from("pm_teams")
    .select("*")
    .eq("project_id", workspaceId);

  if (teamsError) {
    res.status(500).json({ error: teamsError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Get Team Members
 */
app.post("/get_team_members", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as {
    workspaceId: string;
    apiKey: string;
    schema: any;
  };
  const auth = await checkUserApiKey(apiKey, workspaceId);
  if (!auth.success) {
    res.status(401).json({ error: auth.error, api_usage: auth.api_usage });
    return;
  }

  const { data, error: membersError } = await supabase
    .from("pm_team_members")
    .select(`
      *,
      profiles:user_id (
        id,
        email,
        full_name,
        avatar_url
      )
    `)
    .eq("team_id", schema?.team_id)
    .eq("project_id", workspaceId);

  if (membersError) {
    res.status(500).json({ error: membersError.message, api_usage: auth.api_usage });
    return;
  }

  res.json({ data, api_usage: auth.api_usage });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Privileged middleware server running on port ${PORT}`);
});

export default app;

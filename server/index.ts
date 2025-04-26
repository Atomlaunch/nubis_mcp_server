import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

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

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

app.set("trust proxy", true);
app.use(express.json());

// Rate limit middleware
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 10 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error:
      "Too many requests, please try again later. (50 requests per 10 minutes)",
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
async function checkUserApiKey(apiKey: string, workspaceId: string) {
  try {
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!apiKey) throw new Error("apiKey is required");
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

    // Check API Usage
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
          count: "descending",
          remaining_calls: apiUsageData.remaining_calls,
          total_limit: apiUsageData.total_limit
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
          count: "descending",
          remaining_calls: apiUsageData.remaining_calls,
          total_limit: apiUsageData.total_limit
        }
      };
    }
    console.log(
      `API usage updated for workspace ${workspaceId}, Total Calls: ${apiUsageData.total_limit}, Remaining Calls: ${apiUsageData.remaining_calls - 1}`
    );

    // Return if user has access to workspace
    return {
      success: true,
      error: null,
      api_usage: {
        count: "descending",
        remaining_calls: apiUsageData.remaining_calls - 1,
        total_limit: apiUsageData.total_limit
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

async function getUserProfile(apiKey: string) {
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
    .order("sort_order", { ascending: false })
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

  data.subtasks = subTasks ? [subTasks] : [];
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

    const { error: updateError } = await supabase
      .from("pm_tasks")
      .update({ board: "in-progress" })
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
      board: schema?.board || "backlog",
      parent_task_id: schema?.parent_task_id || null,
      project_id: workspaceId,
      sort_order: (maxSortOrder?.sort_order || 0) + 1000,
      task_number: (maxTaskNumber?.task_number || 0) + 1,
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
      board: schema?.board || task?.board || "backlog",
      branch_id: schema?.bolt_id || task?.branch_id || null,
      parent_task_id: schema?.parent_task_id || task?.parent_task_id || null,
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
          board: task.board || "backlog",
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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Privileged middleware server running on port ${PORT}`);
});

export default app;

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
    if (error || !data) throw new Error("Invalid or unauthorized apiKey");

    const { user_id } = data;
    // check if user has access to workspace
    const { data: workspaceData, error: workspaceError } = await supabase
      .from("pm_members")
      .select("id")
      .eq("project_id", workspaceId)
      .eq("user_id", user_id)
      .single();
    if (workspaceError || !workspaceData)
      throw new Error(`User does not have access to workspace ${workspaceId}`);
    // Return if user has access to workspace
    return true;
  } catch (error) {
    console.error(error);
    return false;
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
    return user_id;
  } catch (error) {
    console.error(error);
    return null;
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
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data, error } = await supabase
    .from("pm_branches")
    .select("*")
    .eq("project_id", workspaceId);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
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
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let query = supabase
    .from("pm_tasks")
    .select(
      "id, task_number, title, description, board, images, bolt: branch_id(id, name), github_item_type, github_file_path, github_repo_name"
    )
    .order("sort_order", { ascending: true })
    .eq("project_id", workspaceId)
    .limit(schema?.limit);

  if (schema?.bolt_id) {
    query = query.eq("branch_id", schema.bolt_id);
  }

  if (schema?.board) {
    query = query.in("board", [schema.board]);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  
  res.json({ data });
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
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data, error } = await supabase
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  // Get SubTasks
  const { data: subTasks, error: subTasksError } = await supabase
    .from("pm_tasks")
    .select(
      "id, task_number, title, description, board, images, bolt: branch_id(name), github_item_type, github_file_path, github_repo_name"
    )
    .order("sort_order", { ascending: true })
    .eq("project_id", workspaceId)
    .eq("parent_task_id", data?.id);

  if (subTasksError) {
    console.error({ subTasksError });
    res.status(500).json({ error: subTasksError.message });
    return;
  }

  data.subtasks = subTasks ? [subTasks] : [];
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
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
    const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
    if (!checkUserApiKeyResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { data, error } = await supabase
      .from("pm_tasks")
      .select("images")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ data });
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
    const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
    if (!checkUserApiKeyResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { error: updateError } = await supabase
      .from("pm_tasks")
      .update({ board: "in-progress" })
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId);
    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    const { data, error } = await supabase
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (error) throw new Error(error.message);

    // Return updated task
    res.json({ data });
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
    const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
    if (!checkUserApiKeyResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { data, error } = await supabase
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (error) throw new Error(error.message);

    res.json({ data });
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
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { error: updateError } = await supabase
    .from("pm_tasks")
    .update({ board: schema?.board })
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId);
  if (updateError) {
    res.status(500).json({ error: updateError.message });
    return;
  }

  const { data, error } = await supabase
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (error) throw new Error(error.message);

  res.json({ data });
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
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = await getUserProfile(apiKey);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
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
    res.status(500).json({ error: insertError.message });
    return;
  }

  res.json({ data });
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
    const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
    if (!checkUserApiKeyResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const userId = await getUserProfile(apiKey);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
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
      res.status(500).json({ error: insertError.message });
      return;
    }

    res.json({ data });
  }
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Privileged middleware server running on port ${PORT}`);
});

export default app;

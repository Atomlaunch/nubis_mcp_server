import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

dotenv.config();

const SUPABASE_URL: string = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PORT: number = Number(process.env.PORT) || 4000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment");
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

// Rate limit middleware
const apiLimiter = rateLimit({
  windowMs: 20 * 60 * 1000, // 20 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: "Too many requests, please try again later. (100 requests per 20 minutes)" }
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
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!apiKey) throw new Error("apiKey is required");
    // Validate apiKey in api_key table
    const { data, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('api_key', apiKey)
      .single();
    if (error || !data) throw new Error("Invalid or unauthorized apiKey");
    
    const { user_id } = data;
    // check if user has access to workspace
    const { data: workspaceData, error: workspaceError } = await supabase
      .from('pm_members')
      .select('id')
      .eq('project_id', workspaceId)
      .eq('user_id', user_id)
      .single();
    if (workspaceError || !workspaceData) throw new Error(`User does not have access to workspace ${workspaceId}`);
    // Return if user has access to workspace
    return true;
  }

/**
 * Return tasks for a workspace
 */
app.post("/get_tasks", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { data, error } = await supabase
  .from('pm_tasks')
  .select('id, task_number, title, description, board, images')
  .order('sort_order', { ascending: true })
  .eq('project_id', workspaceId)
  .in('board', schema?.board ? [schema.board] : ['bugs', 'backlog', 'priority', 'in-progress', 'reviewing', 'completed'])
  .limit(schema?.limit);
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
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { data, error } = await supabase
    .from('pm_tasks')
    .select('*')
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId)
    .single();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

/**
 * Return task images by ID
 */
app.post("/get_task_images", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { data, error } = await supabase
    .from('pm_tasks')
    .select('images')
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId)
    .single();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

/** 
 * Return work on task
 */
app.post("/work_on_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { error: updateError } = await supabase
    .from('pm_tasks')
    .update({ board: 'in-progress' })
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId);
  if (updateError) {
    res.status(500).json({ error: updateError.message });
    return;
  }
  
  const { data, error } = await supabase
    .from('pm_tasks')
    .select('*')
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId)
    .single();
  if (error) throw new Error(error.message);

  // Return updated task
  res.json({ data });
});

/**
 * Return explain_setup 
 */
app.post("/explain_setup", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { data, error } = await supabase
    .from('pm_tasks')
    .select('*')
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId)
    .single();
  if (error) throw new Error(error.message);
  
  res.json({ data });
});

/**
 * Return move_task
 */
app.post("/move_task", async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, apiKey, schema } = req.body as { workspaceId: string; apiKey: string; schema: any };
  console.log({ workspaceId, apiKey, schema });
  const checkUserApiKeyResult = await checkUserApiKey(apiKey, workspaceId);
  if (!checkUserApiKeyResult) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  
  const { error: updateError } = await supabase
    .from('pm_tasks')
    .update({ board: schema?.board })
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId);
  if (updateError) {
    res.status(500).json({ error: updateError.message });
    return;
  }
  
  const { data, error } = await supabase
    .from('pm_tasks')
    .select('*')
    .eq('id', schema?.taskID)
    .eq('project_id', workspaceId)
    .single();
  if (error) throw new Error(error.message);
  
  res.json({ data });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Privileged middleware server running on port ${PORT}`);
});

export default app;
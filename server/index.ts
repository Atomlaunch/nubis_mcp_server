import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";



// Register all new endpoints from server/endpoints here for maintainability
import { registerAddContextToTaskEndpoint } from "./endpoints/add-context-to-task.js";
import {
  agentKeyApiKeysLookupError,
  authKindFromSecret,
  credentialsFromRequest,
  isOwnerEquivalentRole,
  redactSecrets,
  taskIDFromBody,
  taskIDsFromBody,
  type AuthKind,
} from "./request-auth.js";
import { toLiveBoardStatusKey } from "./boards.js";
import {
  agentModeConfigBody,
  callEdgeFunction,
  edgeNotWiredBody,
  sessionFromAgentTokenPayload,
} from "./agent-edge.js";
import {
  bulkTaskNumbers,
  buildTaskUpdatePatch,
  isMissingRow,
} from "./task-patches.js";

dotenv.config();

const SUPABASE_URL: string = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY: string =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY: string = process.env.SUPABASE_ANON_KEY || "";
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

app.set("trust proxy", 1);
app.use(express.json());

// Rate limit middleware
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5000, // limit each IP to 5000 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error:
      "Too many requests, please try again later. (5000 requests per 5 minutes)",
  },
});

// Apply rate limiter to all routes
app.use(apiLimiter);

const agentSessionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many agent-session requests, please try again later. (20 per 5 minutes)",
  },
});

/**
 * Health check endpoint.
 */
app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok" });
});

// Log Request — never print raw apiKey / nubis_ag_ / JWTs.
app.use((req, _res, next) => {
  console.log(`Request: ${req.method} ${req.url}`);
  if (req.body && typeof req.body === "object") {
    console.log(redactSecrets(req.body));
  }
  next();
});

// Helper to validate API key and return a Supabase client for the user
export async function checkUserApiKey(apiKey: string, workspaceId: string) {
  try {
    if (!workspaceId) {
      return {
        success: false,
        error: "workspaceId is required",
        api_usage: null,
        userId: null,
      };
    }
    if (!apiKey) {
      return {
        success: false,
        error: "apiKey is required",
        api_usage: null,
        userId: null,
      };
    }
    const agentKeyError = agentKeyApiKeysLookupError(apiKey);
    if (agentKeyError) {
      return {
        success: false,
        error: agentKeyError,
        api_usage: null,
        userId: null,
      };
    }
    if (authKindFromSecret(apiKey) !== "workspace_api_key") {
      return {
        success: false,
        error: "checkUserApiKey is workspace-key-only. Exchange agent keys via POST /agent-session.",
        api_usage: null,
        userId: null,
      };
    }
    // Validate apiKey in api_key table (workspace MCP keys only — never nubis_ag_)
    const { data, error } = await supabase
      .from("api_keys")
      .select("*")
      .eq("api_key", apiKey)
      .single();
    if (error || !data) {
      return {
        success: false,
        error: "Invalid or unauthorized apiKey",
        api_usage: null,
        userId: null,
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
        api_usage: null,
        userId: null,
      };
    }

    const role = workspaceData.role;
    const is_admin = isOwnerEquivalentRole(role);

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
          api_usage: null,
          userId: null,
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
        userId: user_id,
        api_usage: {
          remaining_calls: "unlimited",
          total_limit: "unlimited",
          plan: planName
        }
      };
    }

    // For free plans, check and enforce API usage limits.
    // Compare-and-swap so concurrent requests cannot both decrement the same remaining_calls value.
    const { data: apiUsageData, error: apiUsageError } = await supabase
      .from("api_usage")
      .select("*")
      .eq("project_id", workspaceId)
      .single();
    if (apiUsageError || !apiUsageData) {
      return {
        success: false,
        error: `API usage limit not found for workspace ${workspaceId}`,
        api_usage: null,
        userId: null,
      };
    }

    const totalLimit = apiUsageData.total_limit;
    let remaining = apiUsageData.remaining_calls;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (remaining <= 0) {
        return {
          success: false,
          error: "API usage limit exceeded",
          api_usage: {
            remaining_calls: remaining,
            total_limit: totalLimit,
            plan: planName
          },
          userId: null,
        };
      }

      const { data: updated, error: updateError } = await supabase
        .from("api_usage")
        .update({ remaining_calls: remaining - 1 })
        .eq("project_id", workspaceId)
        .eq("remaining_calls", remaining)
        .gt("remaining_calls", 0)
        .select("remaining_calls, total_limit")
        .maybeSingle();

      if (updateError) {
        return {
          success: false,
          error: "Failed to update API usage",
          api_usage: {
            remaining_calls: remaining,
            total_limit: totalLimit,
            plan: planName
          },
          userId: null,
        };
      }

      if (updated) {
        console.log(
          `API usage updated for workspace ${workspaceId} on plan "${planName}", Total Calls: ${updated.total_limit}, Remaining Calls: ${updated.remaining_calls}`
        );
        return {
          success: true,
          error: null,
          userId: user_id,
          api_usage: {
            remaining_calls: updated.remaining_calls,
            total_limit: updated.total_limit,
            plan: planName
          }
        };
      }

      const { data: latest } = await supabase
        .from("api_usage")
        .select("remaining_calls, total_limit")
        .eq("project_id", workspaceId)
        .single();
      remaining = latest?.remaining_calls ?? 0;
    }

    return {
      success: false,
      error: "Failed to update API usage",
      api_usage: {
        remaining_calls: remaining,
        total_limit: totalLimit,
        plan: planName
      },
      userId: null,
    };
  } catch (error) {
    console.error(error);
    return {
      success: false,
      error: "Failed to check user API key",
      api_usage: null,
      userId: null,
    };
  }
}

export async function getUserProfile(apiKey: string) {
  try {
    if (!apiKey) throw new Error("apiKey is required");
    const agentKeyError = agentKeyApiKeysLookupError(apiKey);
    if (agentKeyError) {
      return { data: null, error: agentKeyError };
    }
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
    const message =
      error instanceof Error ? error.message : "Failed to get user profile";
    return { data: null, error: message };
  }
}

type McpAuthOk = {
  ok: true;
  authKind: AuthKind;
  workspaceId: string;
  schema: any;
  api_usage: any;
  userId: string | null;
  role: string | null;
  db: SupabaseClient;
  accessToken: string | null;
};

type McpAuthFail = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
};

function failAuth(status: number, body: Record<string, unknown>): McpAuthFail {
  return { ok: false, status, body };
}

function supabaseForAgentJwt(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function exchangeAgentKey(
  agentKey: string
): Promise<{ accessToken: string; userId: string | null } | McpAuthFail> {
  if (!SUPABASE_ANON_KEY) {
    return failAuth(
      501,
      agentModeConfigBody(
        "Missing SUPABASE_ANON_KEY. Agent session cannot be created."
      )
    );
  }
  const result = await callEdgeFunction({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    functionName: "agent-token",
    body: { api_key: agentKey, apiKey: agentKey },
  });
  if (!result.ok) {
    return failAuth(result.status, result.body);
  }
  const session = sessionFromAgentTokenPayload(result.data);
  if (!session) {
    return failAuth(501, edgeNotWiredBody("agent-token"));
  }
  return { accessToken: session.access_token, userId: session.user.id ?? null };
}

async function userIdFromAgentJwt(
  accessToken: string
): Promise<{ userId: string } | McpAuthFail> {
  if (!SUPABASE_ANON_KEY) {
    return failAuth(
      501,
      agentModeConfigBody("Missing SUPABASE_ANON_KEY. Cannot verify agent JWT.")
    );
  }
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.getUser(accessToken);
  if (error || !data.user) {
    return failAuth(401, { error: "Invalid or expired agent session JWT" });
  }
  return { userId: data.user.id };
}

function isRelationMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || Boolean(error.message?.includes("does not exist"));
}

/**
 * Workspace MCP keys keep the api_keys + service-role path.
 * Agent keys/JWTs never SELECT api_keys and never use the service-role client for DB writes.
 */
export async function authorizeMcpRequest(
  req: Request,
  options: {
    membership?: "none" | "required" | "admin";
    agentOnly?: boolean;
    allowMissingWorkspace?: boolean;
  } = {}
): Promise<McpAuthOk | McpAuthFail> {
  const membership = options.membership ?? "required";
  const creds = credentialsFromRequest(req);
  const { workspaceId, apiKey, schema, authKind } = creds;

  if (!apiKey) {
    return failAuth(401, { error: "apiKey is required", api_usage: null });
  }
  if (!options.allowMissingWorkspace && !workspaceId) {
    return failAuth(400, { error: "workspaceId is required", api_usage: null });
  }
  if (!authKind) {
    return failAuth(401, { error: "Unable to determine auth kind", api_usage: null });
  }

  if (authKind === "workspace_api_key") {
    if (options.agentOnly) {
      return failAuth(403, {
        error:
          "This endpoint requires an agent session (NUBIS_AGENT_KEY), not a workspace API key.",
      });
    }
    const auth = await checkUserApiKey(apiKey, workspaceId);
    if (!auth.success) {
      return failAuth(401, { error: auth.error, api_usage: auth.api_usage });
    }
    const profile = await getUserProfile(apiKey);
    const userId = auth.userId || profile.data;
    if (profile.error && !userId) {
      return failAuth(401, {
        error: profile.error,
        api_usage: auth.api_usage,
      });
    }
    if (!userId) {
      return failAuth(401, {
        error: "Unauthorized",
        api_usage: auth.api_usage,
      });
    }
    return {
      ok: true,
      authKind,
      workspaceId,
      schema,
      api_usage: auth.api_usage,
      userId,
      role: null,
      db: supabase,
      accessToken: null,
    };
  }

  if (!SUPABASE_ANON_KEY) {
    return failAuth(
      501,
      agentModeConfigBody("Missing SUPABASE_ANON_KEY.")
    );
  }

  let accessToken = apiKey;
  if (authKind === "agent_key") {
    const exchanged = await exchangeAgentKey(apiKey);
    if ("status" in exchanged) return exchanged;
    accessToken = exchanged.accessToken;
  }

  const verified = await userIdFromAgentJwt(accessToken);
  if ("status" in verified) return verified;
  const userId = verified.userId;
  const db = supabaseForAgentJwt(accessToken);
  const agentUsage = {
    remaining_calls: "unlimited",
    total_limit: "unlimited",
    plan: "agent-session",
  };

  if (membership === "none") {
    return {
      ok: true,
      authKind: "agent_jwt",
      workspaceId,
      schema,
      api_usage: agentUsage,
      userId,
      role: null,
      db,
      accessToken,
    };
  }

  const { data: member, error: memberError } = await db
    .from("pm_members")
    .select("id, role, member_kind")
    .eq("project_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError) {
    if (isRelationMissing(memberError)) {
      return failAuth(501, edgeNotWiredBody("pm_members"));
    }
    return failAuth(403, {
      error: memberError.message || "Unable to load agent membership",
      code: "AGENT_NOT_A_MEMBER",
    });
  }

  if (!member) {
    return failAuth(403, {
      error:
        "Agent is not a member of this workspace. Agents join when a human owner/admin mints them in Settings (invite-agent).",
      code: "AGENT_NOT_A_MEMBER",
    });
  }

  if (membership === "admin" && member.role !== "admin") {
    return failAuth(403, {
      error: "This tool requires an agent admin. Agent members cannot mint other agents. Rotate/revoke stay in Settings (human owner/admin).",
      code: "AGENT_ADMIN_REQUIRED",
    });
  }

  return {
    ok: true,
    authKind: "agent_jwt",
    workspaceId,
    schema,
    api_usage: agentUsage,
    userId,
    role: member.role as string,
    db,
    accessToken,
  };
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
  taskIDs: unknown[],
  db: SupabaseClient = supabase
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

  const { data: existing, error: lookupError } = await db
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
  const { error: unblockError } = await db
    .from("pm_tasks")
    .update({ blocked_by_task_id: null })
    .eq("project_id", workspaceId)
    .in("blocked_by_task_id", toDelete);

  if (unblockError) {
    return { deleted: [], missing, error: unblockError.message };
  }

  const { data: deletedRows, error: deleteError } = await db
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
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, api_usage, db } = auth;

  const { data, error: boltzError } = await db
    .from("pm_branches")
    .select("*")
    .eq("project_id", workspaceId);
  if (boltzError) {
    res.status(500).json({ error: boltzError.message, api_usage });
    return;
  }
  res.json({ data, api_usage });
});

/**
 * Return tasks for a workspace
 */
app.post("/get_tasks", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  let query = db
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
    query = query.in("board", [toLiveBoardStatusKey(String(schema.board))]);
  }

  if (schema?.limit) {
    query = query.limit(schema.limit);
  }

  const { data, error: tasksError } = await query;

  if (tasksError) {
    res.status(500).json({ error: tasksError.message, api_usage });
    return;
  }
  res.json({ data, api_usage });
});

/**
 * Return task by ID
 */
app.post("/get_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data, error: taskError } = await db
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !data) {
    const status = isMissingRow(taskError) ? 404 : 500;
    res.status(status).json({
      error: isMissingRow(taskError) ? "Task not found" : taskError?.message || "Task not found",
      api_usage,
    });
    return;
  }

  // Get SubTasks
  const { data: subTasks, error: subTasksError } = await db
    .from("pm_tasks")
    .select(
      "id, task_number, title, description, board, images, branch_id, github_item_type, github_file_path, github_repo_name, pm_task_blockers!pm_task_blockers_task_id_fkey(id, blocker_task_id, task_id)"
    )
    .order("sort_order", { ascending: false })
    .eq("project_id", workspaceId)
    .eq("parent_task_id", data.id);

  if (subTasksError) {
    console.error({ subTasksError });
    res.status(500).json({ error: subTasksError.message, api_usage });
    return;
  }

  // Get Task Comments
  const { data: comments, error: commentsError } = await db
    .from("pm_comments")
    .select("*")
    .eq("task_id", schema?.taskID)
    .eq("project_id", workspaceId);

  if (commentsError) {
    console.error({ commentsError });
    res.status(500).json({ error: commentsError.message, api_usage });
    return;
  }

  data.subtasks = subTasks || [];
  data.comments = comments || [];
  res.json({ data, api_usage });
});

/** 
 * Get Task Context
 */
app.post("/get_task_context", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data, error: taskError } = await db
    .from("pm_tasks")
    .select("context")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError) {
    res.status(500).json({ error: taskError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Return task images by ID
 */
app.post(
  "/get_task_images",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }
    const { workspaceId, schema, api_usage, db } = auth;

    const { data, error: taskError } = await db
      .from("pm_tasks")
      .select("images")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError) {
      res.status(500).json({ error: taskError.message, api_usage });
      return;
    }
    res.json({ data, api_usage });
  }
);

/**
 * Return work on task
 */
app.post(
  "/work_on_task",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }
    const { workspaceId, schema, api_usage, db } = auth;

    const { data, error: taskError } = await db
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError || !data) {
      const status = isMissingRow(taskError) ? 404 : 500;
      res.status(status).json({
        error: isMissingRow(taskError) ? "Task not found" : taskError?.message || "Task not found",
        api_usage,
      });
      return;
    }

    res.json({ data, api_usage });
  }
);

/**
 * Return explain_task
 */
app.post(
  "/explain_task",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }
    const { workspaceId, schema, api_usage, db } = auth;

    const { data, error: taskError } = await db
      .from("pm_tasks")
      .select("*")
      .eq("id", schema?.taskID)
      .eq("project_id", workspaceId)
      .single();
    if (taskError || !data) {
      const status = isMissingRow(taskError) ? 404 : 500;
      res.status(status).json({
        error: isMissingRow(taskError) ? "Task not found" : taskError?.message || "Task not found",
        api_usage,
      });
      return;
    }

    res.json({ data, api_usage });
  }
);

/**
 * Return move_task
 */
app.post("/move_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;
  const liveBoard = schema?.board
    ? toLiveBoardStatusKey(String(schema.board))
    : schema?.board;

  const { error: updateError } = await db
    .from("pm_tasks")
    .update({ board: liveBoard })
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId);
  if (updateError) {
    res.status(500).json({ error: updateError.message, api_usage });
    return;
  }

  const { data, error: taskError } = await db
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError || !data) {
    const status = isMissingRow(taskError) ? 404 : 500;
    res.status(status).json({
      error: isMissingRow(taskError) ? "Task not found" : taskError?.message || "Task not found",
      api_usage,
    });
    return;
  }

  res.json({ data, api_usage });
});

/**
 *  Return Create Task
 */
app.post("/create_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db, userId } = auth;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized", api_usage });
    return;
  }

  const { data: maxTaskNumber } = await db
    .from("pm_tasks")
    .select("task_number")
    .eq("project_id", workspaceId)
    .order("task_number", { ascending: false })
    .limit(1)
    .single();

  const { data: maxSortOrder } = await db
    .from("pm_tasks")
    .select("sort_order")
    .eq("project_id", workspaceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();

  const board = schema?.board
    ? toLiveBoardStatusKey(String(schema.board))
    : "inbox";

  const { data, error: insertError } = await db
    .from("pm_tasks")
    .insert({
      title: schema?.title,
      description: schema?.description,
      board,
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
    res.status(500).json({ error: insertError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Update task
 */
app.post("/update_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db, userId } = auth;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized", api_usage });
    return;
  }

  const { data: task, error: taskError } = await db
    .from("pm_tasks")
    .select("*")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();
  if (taskError || !task) {
    const status = isMissingRow(taskError) ? 404 : 500;
    res.status(status).json({
      error: isMissingRow(taskError) ? "Task not found" : taskError?.message || "Task not found",
      api_usage,
    });
    return;
  }

  const patch = buildTaskUpdatePatch(schema);
  if (schema?.board) {
    patch.board = toLiveBoardStatusKey(String(schema.board));
  }

  if (Object.keys(patch).length === 0) {
    res.json({ data: task, api_usage });
    return;
  }

  const { data, error: updateError } = await db
    .from("pm_tasks")
    .update(patch)
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .select("*")
    .single();
  if (updateError) {
    res.status(500).json({ error: updateError.message, api_usage });
    return;
  }
  res.json({ data, api_usage });
});

/**
 * Delete a single task in the authenticated workspace.
 * Missing IDs are reported instead of failing the request.
 */
app.post("/delete_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, api_usage, db } = auth;

  const taskID = taskIDFromBody(req.body ?? {});
  if (!taskID) {
    res.status(400).json({ error: "taskID is required", api_usage });
    return;
  }

  const result = await deleteWorkspaceTasks(workspaceId, [taskID], db);
  if (result.error) {
    res.status(500).json({ error: result.error, api_usage });
    return;
  }

  res.json({
    data: {
      deleted: result.deleted[0] || null,
      missing: result.missing,
    },
    api_usage,
  });
});

/**
 * Delete multiple tasks in the authenticated workspace.
 * Missing IDs are reported per id; the rest of the batch still deletes.
 */
app.post("/delete_tasks", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, api_usage, db } = auth;

  const taskIDs = taskIDsFromBody(req.body ?? {});
  if (!taskIDs) {
    res.status(400).json({ error: "taskIDs must be an array", api_usage });
    return;
  }

  const result = await deleteWorkspaceTasks(workspaceId, taskIDs, db);
  if (result.error) {
    res.status(500).json({ error: result.error, api_usage });
    return;
  }

  res.json({
    data: {
      deleted: result.deleted,
      missing: result.missing,
    },
    api_usage,
  });
});

/**
 *  Return Create Bulk Tasks
 */
app.post(
  "/create_bulk_tasks",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await authorizeMcpRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }
    const { workspaceId, schema, api_usage, db, userId } = auth;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized", api_usage });
      return;
    }

    const { data: maxTaskNumber } = await db
      .from("pm_tasks")
      .select("task_number")
      .eq("project_id", workspaceId)
      .order("task_number", { ascending: false })
      .limit(1)
      .single();

    const { data: maxSortOrder } = await db
      .from("pm_tasks")
      .select("sort_order")
      .eq("project_id", workspaceId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .single();

    const tasks = Array.isArray(schema?.tasks) ? schema.tasks : [];
    if (tasks.length === 0) {
      res.status(400).json({ error: "tasks array is required", api_usage });
      return;
    }

    const numbers = bulkTaskNumbers(
      maxTaskNumber?.task_number || 0,
      maxSortOrder?.sort_order || 0,
      tasks.length
    );

    const { data, error: insertError } = await db
      .from("pm_tasks")
      .insert(
        tasks.map((task: any, i: number) => ({
          title: task.title,
          description: task.description,
          board: task.board
            ? toLiveBoardStatusKey(String(task.board))
            : "inbox",
          parent_task_id: task.parent_task_id || null,
          project_id: workspaceId,
          sort_order: numbers[i].sort_order,
          task_number: numbers[i].task_number,
          created_by: userId,
        }))
      )
      .select("*");
    if (insertError) {
      res.status(500).json({ error: insertError.message, api_usage });
      return;
    }

    res.json({ data, api_usage });
  }
);

registerAddContextToTaskEndpoint(app);

/**
 * Add Comment to Task
 */
app.post("/add_comment", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db, userId } = auth;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized", api_usage });
    return;
  }

  const { data, error: insertError } = await db
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
    res.status(500).json({ error: insertError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Add Blocker to Task
 */
app.post("/add_blocker", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data, error: insertError } = await db
    .from("pm_task_blockers")
    .insert({
      task_id: schema?.taskID,
      blocker_task_id: schema?.blocker_task_id,
      project_id: workspaceId,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Remove Blocker from Task
 */
app.post("/remove_blocker", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { error: deleteError } = await db
    .from("pm_task_blockers")
    .delete()
    .eq("task_id", schema?.taskID)
    .eq("blocker_task_id", schema?.blocker_task_id)
    .eq("project_id", workspaceId);

  if (deleteError) {
    res.status(500).json({ error: deleteError.message, api_usage });
    return;
  }

  res.json({ data: { removed: true, task_id: schema?.taskID, blocker_task_id: schema?.blocker_task_id }, api_usage });
});

/**
 * Get Labels for Workspace
 */
app.post("/get_labels", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, api_usage, db } = auth;

  const { data, error: labelsError } = await db
    .from("pm_labels")
    .select("*")
    .eq("project_id", workspaceId);

  if (labelsError) {
    res.status(500).json({ error: labelsError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Add Label to Task
 */
app.post("/add_label_to_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data: task, error: taskError } = await db
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage });
    return;
  }

  const { data, error: insertError } = await db
    .from("pm_task_labels")
    .insert({
      task_id: schema?.taskID,
      label_id: schema?.label_id,
    })
    .select("*")
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Remove Label from Task
 */
app.post("/remove_label_from_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data: task, error: taskError } = await db
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage });
    return;
  }

  const { error: deleteError } = await db
    .from("pm_task_labels")
    .delete()
    .eq("task_id", schema?.taskID)
    .eq("label_id", schema?.label_id);

  if (deleteError) {
    res.status(500).json({ error: deleteError.message, api_usage });
    return;
  }

  res.json({ data: { removed: true, task_id: schema?.taskID, label_id: schema?.label_id }, api_usage });
});

/**
 * Get Task Commits
 */
app.post("/get_task_commits", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data: task, error: taskError } = await db
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage });
    return;
  }

  const { data, error: commitsError } = await db
    .from("pm_task_commits")
    .select("*")
    .eq("task_id", schema?.taskID)
    .order("linked_at", { ascending: false });

  if (commitsError) {
    res.status(500).json({ error: commitsError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Link Commit to Task
 */
app.post("/link_commit_to_task", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db, userId } = auth;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized", api_usage });
    return;
  }

  const { data: task, error: taskError } = await db
    .from("pm_tasks")
    .select("id")
    .eq("id", schema?.taskID)
    .eq("project_id", workspaceId)
    .single();

  if (taskError || !task) {
    res.status(404).json({ error: "Task not found in workspace", api_usage });
    return;
  }

  const { data, error: insertError } = await db
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
    res.status(500).json({ error: insertError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Get Teams for Workspace
 */
app.post("/get_teams", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, api_usage, db } = auth;

  const { data, error: teamsError } = await db
    .from("pm_teams")
    .select("*")
    .eq("project_id", workspaceId);

  if (teamsError) {
    res.status(500).json({ error: teamsError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Get Team Members
 */
app.post("/get_team_members", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const { workspaceId, schema, api_usage, db } = auth;

  const { data, error: membersError } = await db
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
    res.status(500).json({ error: membersError.message, api_usage });
    return;
  }

  res.json({ data, api_usage });
});

/**
 * Exchange a raw nubis_ag_ key for a GoTrue JWT. No membership required.
 * Middleware for stdio — not an MCP tool.
 * Edge `agent-token` must use password grant (not generateLink / magic-link).
 */
app.post(
  "/agent-session",
  agentSessionLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const creds = credentialsFromRequest(req);
    if (!creds.apiKey || creds.authKind !== "agent_key") {
      res.status(400).json({
        error: "Body apiKey must be a nubis_ag_ agent key",
        code: "AGENT_KEY_REQUIRED",
      });
      return;
    }
    if (!SUPABASE_ANON_KEY) {
      res.status(501).json(
        agentModeConfigBody("Missing SUPABASE_ANON_KEY. Agent session cannot be created.")
      );
      return;
    }
    const result = await callEdgeFunction({
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      functionName: "agent-token",
      body: { api_key: creds.apiKey, apiKey: creds.apiKey },
    });
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const session = sessionFromAgentTokenPayload(result.data);
    if (!session) {
      res.status(501).json(edgeNotWiredBody("agent-token"));
      return;
    }
    res.json({
      access_token: session.access_token,
      expires_in: session.expires_in,
      user: { id: session.user.id },
    });
  }
);

app.post("/list_agent_memberships", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req, {
    membership: "none",
    agentOnly: true,
    allowMissingWorkspace: true,
  });
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { data, error } = await auth.db
    .from("pm_members")
    .select("id, project_id, role, member_kind")
    .eq("user_id", auth.userId);
  if (error) {
    if (isRelationMissing(error)) {
      res.status(501).json(edgeNotWiredBody("pm_members"));
      return;
    }
    res.status(500).json({ error: error.message, api_usage: auth.api_usage });
    return;
  }
  res.json({ data, api_usage: auth.api_usage });
});

/**
 * Agent admin mints a **member** principal via Edge `invite-agent`.
 * Humans mint/rotate/revoke in Settings. Never owner. Never agent→admin.
 */
app.post("/mint_agent", async (req: Request, res: Response): Promise<void> => {
  const auth = await authorizeMcpRequest(req, {
    membership: "admin",
    agentOnly: true,
  });
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }
  const requestedRole = String(auth.schema?.role || "member");
  if (requestedRole !== "member") {
    res.status(403).json({
      error: "Agent admins may mint agent members only. Human owner/admin mint agent admins in Settings.",
      code: "MEMBER_ROLE_ONLY",
    });
    return;
  }
  if (!auth.accessToken || !SUPABASE_ANON_KEY) {
    res.status(501).json(
      agentModeConfigBody("Agent JWT or SUPABASE_ANON_KEY missing.")
    );
    return;
  }
  const schema = (auth.schema || {}) as Record<string, unknown>;
  const result = await callEdgeFunction({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    functionName: "invite-agent",
    accessToken: auth.accessToken,
    body: {
      ...schema,
      role: "member",
      project_id: auth.workspaceId,
      workspaceId: auth.workspaceId,
    },
  });
  if (!result.ok) {
    res.status(result.status).json(result.body);
    return;
  }
  res.status(result.status === 201 ? 201 : 200).json({
    data: result.data,
    api_usage: auth.api_usage,
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Privileged middleware server running on port ${PORT}`);
});

export default app;

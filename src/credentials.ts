/**
 * Resolve Nubis workspace + API key at request time.
 *
 * Cursor/npx connectors use several env names, and the README documents
 * `--workspaceID` / `--access-token`. JSON.stringify drops undefined keys, so
 * a missing snapshot at import used to POST a body with no workspaceId.
 */

const WORKSPACE_ENV_VARS = [
  "NUBIS_WORKSPACE_ID",
  "NUBIS_WORKSPACEID",
  "WORKSPACE_ID",
] as const;

const API_KEY_ENV_VARS = [
  "NUBIS_API_KEY",
  "NUBIS_ACCESS_TOKEN",
  "ACCESS_TOKEN",
] as const;

export type CredentialSources = {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = trimmed(env[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Read `--flag value` or `--flag=value` from argv. Values that look like
 * another flag are ignored so a bare `--workspaceID --access-token` is empty.
 */
export function argvFlag(flag: string, argv: readonly string[]): string {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return "";
      return next.trim();
    }
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length).trim();
    }
  }
  return "";
}

export function resolveClientCredentials(
  sources: CredentialSources = {}
): { workspaceId: string; apiKey: string } {
  const env = sources.env ?? process.env;
  const argv = sources.argv ?? process.argv;

  const workspaceId =
    argvFlag("--workspaceID", argv) || firstEnv(env, WORKSPACE_ENV_VARS);
  const apiKey =
    argvFlag("--access-token", argv) || firstEnv(env, API_KEY_ENV_VARS);

  if (!workspaceId) {
    throw new Error(
      "workspaceId is required. Set NUBIS_WORKSPACE_ID, NUBIS_WORKSPACEID, or WORKSPACE_ID, or pass --workspaceID."
    );
  }
  if (!apiKey) {
    throw new Error(
      "apiKey is required. Set NUBIS_API_KEY, NUBIS_ACCESS_TOKEN, or ACCESS_TOKEN, or pass --access-token."
    );
  }

  return { workspaceId, apiKey };
}

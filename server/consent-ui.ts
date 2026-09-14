import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

/** Optional same-origin consent hosting; never expose the rest of the repository or SPA routes. */
export function registerConsentUi(
  app: Express,
  directory: string | undefined,
  supabaseUrl: string,
) {
  if (!directory) return;
  const root = resolve(directory),
    index = join(root, "index.html");
  const html = readFileSync(index, "utf8");
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim())
    .map(
      (match) =>
        `'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`,
    );
  const auth = new URL(supabaseUrl),
    websocket = new URL(auth.origin);
  websocket.protocol = auth.protocol === "https:" ? "wss:" : "ws:";
  const policy = `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://fb73ar500x.ufs.sh; media-src https://fb73ar500x.ufs.sh; font-src 'self' data:; connect-src 'self' ${auth.origin} ${websocket.origin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
  app.use(
    "/assets",
    express.static(join(root, "assets"), {
      dotfiles: "deny",
      fallthrough: false,
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.get(
    [
      "/login",
      "/auth/callback",
      "/oauth/consent",
      "/mcp/connect",
      "/workspace/:workspaceId/mcp-setup",
      "/terms",
      "/privacy",
    ],
    (_req, res) => {
      res.setHeader("Content-Security-Policy", policy);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(html);
    },
  );
}

/**
 * Sentry for the privileged HTTP middleware (mcp-server.nubis.app).
 * Init is a no-op without SENTRY_DSN so local/dev still starts.
 * Never invent a DSN. Never send request bodies, API keys, JWTs, or agent keys.
 */

import type { ErrorRequestHandler, Express, NextFunction, Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { redactSecrets } from "./request-auth.js";

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-access-token",
]);

export function sentryDsn(): string {
  return (process.env.SENTRY_DSN || "").trim();
}

export function sentryEnabled(): boolean {
  return sentryDsn().length > 0;
}

function tracesSampleRate(): number {
  const raw = (process.env.SENTRY_TRACES_SAMPLE_RATE || "").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1);
}

export function scrubSentryEvent<T extends { request?: unknown; extra?: unknown; contexts?: unknown; user?: unknown }>(
  event: T
): T {
  const request = event.request as Record<string, unknown> | undefined;
  if (request && typeof request === "object") {
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    const headers = request.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const nextHeaders: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (SECRET_HEADER_NAMES.has(key.toLowerCase())) {
          nextHeaders[key] = "[redacted]";
        } else {
          nextHeaders[key] = value;
        }
      }
      request.headers = nextHeaders;
    }
  }

  if ("user" in event) {
    delete event.user;
  }

  if (event.extra) {
    event.extra = redactSecrets(event.extra);
  }
  if (event.contexts) {
    event.contexts = redactSecrets(event.contexts);
  }
  return event;
}

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = sentryDsn();
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment:
      (process.env.SENTRY_ENVIRONMENT || "").trim() ||
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.NODE_ENV ||
      "production",
    release: (process.env.SENTRY_RELEASE || "").trim() || undefined,
    sendDefaultPii: false,
    tracesSampleRate: tracesSampleRate(),
    beforeSend(event) {
      return scrubSentryEvent(event) as typeof event;
    },
  });

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason);
  });
  process.on("uncaughtException", (error) => {
    Sentry.captureException(error);
  });
}

/**
 * Express 4 does not pass rejected async route promises to error middleware.
 * Wrap handlers so thrown/rejected errors become `next(err)` and can be captured.
 */
export function installExpressAsyncErrorForwarding(app: Express): void {
  const wrap = (handler: unknown): unknown => {
    if (typeof handler !== "function") return handler;
    if (handler.length >= 4) return handler;
    const fn = handler as (...args: unknown[]) => unknown;
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = fn(req, res, next);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).catch(next);
        }
      } catch (err) {
        next(err);
      }
    };
  };

  for (const method of ["get", "post", "put", "patch", "delete", "use"] as const) {
    const original = (app[method] as (...args: unknown[]) => Express).bind(app);
    (app as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map(wrap));
  }
}

export function sentryErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (sentryEnabled()) {
      Sentry.captureException(err);
    } else {
      console.error(err);
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  };
}

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { exportJWK, generateKeyPair } from "jose";
import Provider, { type Configuration } from "oidc-provider";
import {
  applyNativeDcrDefaults,
  CURSOR_MCP_REDIRECT_URIS,
  isNativeOrLoopbackRedirect,
  nativeDcrClientMetadata,
} from "./dcr-native.js";

const mixed = [...CURSOR_MCP_REDIRECT_URIS];

assert.equal(isNativeOrLoopbackRedirect(mixed[0]), true);
assert.equal(isNativeOrLoopbackRedirect(mixed[1]), false);
assert.equal(isNativeOrLoopbackRedirect(mixed[2]), true);
assert.equal(
  isNativeOrLoopbackRedirect("http://127.0.0.1:5190/callback"),
  true,
);

{
  const metadata: { application_type?: string; redirect_uris: string[] } = {
    redirect_uris: mixed,
  };
  applyNativeDcrDefaults(metadata);
  assert.equal(metadata.application_type, "native");
}

{
  const metadata = { application_type: "web", redirect_uris: mixed };
  applyNativeDcrDefaults(metadata, "web");
  assert.equal(metadata.application_type, "web");
}

{
  const metadata = { application_type: "web", redirect_uris: mixed };
  applyNativeDcrDefaults(metadata);
  assert.equal(metadata.application_type, "native");
}

{
  const metadata: { application_type?: string; redirect_uris: string[] } = {
    redirect_uris: ["https://www.cursor.com/agents/mcp/oauth/callback"],
  };
  applyNativeDcrDefaults(metadata);
  assert.equal(metadata.application_type, undefined);
}

const keys = await generateKeyPair("RS256");
const providerConfig: Configuration = {
  jwks: { keys: [{ ...(await exportJWK(keys.privateKey)), alg: "RS256" }] },
  cookies: { keys: ["test-cookie-key-must-be-long-enough"] },
  features: {
    devInteractions: { enabled: false },
    registration: { enabled: true, initialAccessToken: false },
  },
  pkce: { required: () => true },
  responseTypes: ["code"],
  clientAuthMethods: ["none"],
  clientDefaults: {
    token_endpoint_auth_method: "none",
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
  },
};

async function listen(provider: Provider) {
  const app = express();
  app.use("/oauth", provider.callback());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    register: `http://127.0.0.1:${port}/oauth/reg`,
  };
}

async function register(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const cursorBody = {
  client_name: "Cursor",
  redirect_uris: mixed,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const failing = await listen(new Provider("http://127.0.0.1/oauth", providerConfig));
const passing = await listen(
  new Provider("http://127.0.0.1/oauth", {
    ...providerConfig,
    extraClientMetadata: nativeDcrClientMetadata,
  }),
);
try {
  const denied = await register(failing.register, cursorBody);
  assert.equal(denied.status, 400, await denied.clone().text());
  assert.equal(
    (await denied.json()).error_description,
    "redirect_uris must only contain web uris",
  );

  const created = await register(passing.register, cursorBody);
  assert.equal(created.status, 201, await created.clone().text());
  const payload = await created.json();
  assert.equal(payload.application_type, "native");
  assert.deepEqual(payload.redirect_uris, mixed);

  const webOnly = await register(passing.register, {
    ...cursorBody,
    redirect_uris: ["https://www.cursor.com/agents/mcp/oauth/callback"],
  });
  assert.equal(webOnly.status, 201, await webOnly.clone().text());
  assert.equal((await webOnly.json()).application_type, "web");
} finally {
  failing.server.close();
  passing.server.close();
}

console.log(
  "Cursor mixed DCR payload defaults to native; web-only HTTPS stays web",
);

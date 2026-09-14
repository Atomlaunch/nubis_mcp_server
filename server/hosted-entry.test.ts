import assert from "node:assert/strict";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { chromium } from "playwright";
import { randomBytes } from "node:crypto";
const base = process.env.NUBIS_HOSTED_TEST_URL;
if (base !== "https://broker-test.up.railway.app")
  throw new Error("Explicit isolated hosted test URL required");
const metadata = await (
  await fetch(base + "/.well-known/oauth-authorization-server/oauth")
).json();
for (const name of [
  "authorization_endpoint",
  "registration_endpoint",
  "token_endpoint",
  "jwks_uri",
])
  assert.ok(metadata[name].startsWith(base + "/oauth/"), name);
let client: any,
  verifier = "",
  authorization: URL | undefined;
const callback = "http://127.0.0.1:5190/callback";
const provider: OAuthClientProvider = {
  redirectUrl: callback,
  clientMetadata: {
    client_name: "Hosted SDK acceptance probe",
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
  state: () => randomBytes(20).toString("hex"),
  clientInformation: () => client,
  saveClientInformation: (value) => {
    client = value;
  },
  tokens: () => undefined,
  saveTokens: () => {},
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  codeVerifier: () => verifier,
  redirectToAuthorization: (value) => {
    authorization = value;
  },
};
assert.equal(
  await auth(provider, {
    serverUrl: new URL(base + "/mcp"),
    scope: "nubis.tasks.read",
  }),
  "REDIRECT",
);
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) =>
    errors.push(`${e.name}: ${e.message.replace(/https?:\/\/\S+/g, "[URL]")}`),
  );
  await page.goto(authorization!.href);
  await page
    .getByRole("button", { name: "Continue to Nubis sign-in" })
    .waitFor();
  await page.getByRole("button", { name: "Continue to Nubis sign-in" }).click();
  await page.waitForURL(
    (url) => url.origin === base && url.pathname === "/login",
    { timeout: 25000 },
  );
  await page.locator("input[type=email]").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Hosted official SDK discovery/registration/PKCE → real browser consent → actual Supabase authorization → hosted login passed. Human sign-in is still required.",
  );
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const origin = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? process.env.PUBLIC_ORIGIN ?? "https://localhost:8787";
const useBrowser = process.argv.includes("--browser");
const resource = origin + "/mcp";
const scope = "browser:use";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");
let mcpSession = "";
let accessToken = "";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(origin + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(60000) });
}

async function post(path: string, data: unknown): Promise<Response> {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(data) });
}

async function tokenRequest(data: Record<string, string>): Promise<Response> {
  return request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });
}

async function objectBody(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  assert.ok(typeof field === "string" && field.length > 0, `Missing string field: ${name}`);
  return field;
}

async function rpc(id: number, method: string, params?: unknown) {
  const response = await request("/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + accessToken,
    ...(mcpSession ? { "Mcp-Session-Id": mcpSession, "MCP-Protocol-Version": "2025-03-26" } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  assert.equal(response.status, 200, `MCP ${method} returned HTTP ${response.status}`);
  mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
  if (response.headers.get("Content-Type")?.includes("application/json")) return response.json();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`MCP ${method} ended without a result.`);
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = JSON.parse(line.slice(5));
        if (data.id === id) return data;
      }
    }
  } finally {
    await reader.cancel();
  }
}

assert.equal((await request("/health")).status, 200);
const anonymous = await request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(anonymous.status, 401);
assert.match(anonymous.headers.get("WWW-Authenticate") ?? "", /resource_metadata=/);
assert.equal((await request("/mcp", { headers: { Authorization: "Bearer invalid" } })).status, 401);
assert.equal((await request("/sse")).status, 404);
assert.equal((await request("/agents/playwright-mcp/test")).status, 404);
console.log("PASS: public HTTPS/HTTP health; anonymous and forged credentials denied; no alternate MCP route.");

const metadata = await objectBody(await request("/.well-known/oauth-authorization-server"));
assert.ok(Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes("S256"));
assert.equal(metadata.issuer, origin);
const protectedResource = await objectBody(await request("/.well-known/oauth-protected-resource/mcp"));
assert.equal(protectedResource.resource, resource);
const deniedClient = await post("/oauth/register", { client_name: "disallowed-test", redirect_uris: ["https://evil.example/callback"] });
assert.equal(deniedClient.status, 400);
const registered = await post("/oauth/register", { client_name: "Kitesurf verification", redirect_uris: [redirectUri],
  token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
assert.equal(registered.status, 201);
const clientId = stringField(await objectBody(registered), "client_id");
const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri,
  scope, resource, state, code_challenge: challenge, code_challenge_method: "S256" });
const untrustedAuthorization = await request("/authorize?" + params);
assert.equal(untrustedAuthorization.status, 200);
assert.equal(untrustedAuthorization.headers.get("Location"), null);
const lockedPage = await untrustedAuthorization.text();
assert.match(lockedPage, /id="owner-key"/);
assert.match(lockedPage, /id="consent" type="submit">Allow ChatGPT/);
assert.match(lockedPage, /Cloudflare browser quota/);
assert.doesNotMatch(lockedPage, /data-csrf|data-flow|Sign in/);
assert.equal(untrustedAuthorization.headers.get("Set-Cookie"), null);
const forgedSessionPage = await (await request("/authorize?" + params, {
  headers: { Cookie: "__Host-kitesurf-session=" + randomBytes(32).toString("hex") },
})).text();
assert.match(forgedSessionPage, /id="owner-key"/);
assert.match(forgedSessionPage, /id="consent" type="submit">Allow ChatGPT/);
assert.equal((await tokenRequest({ grant_type: "client_credentials", client_id: clientId })).status, 400);
for (const path of ["/auth/register/options", "/auth/register/verify", "/auth/passkey/options", "/auth/passkey/verify", "/auth/key", "/auth/logout"]) {
  assert.equal((await post(path, {})).status, 404);
}
assert.doesNotMatch(lockedPage, /passkey|webauthn/i);
console.log("PASS: registering a ChatGPT client grants no access; key entry and consent share one form, and login/session routes are absent.");

const key = readFileSync(new URL("../.secrets/owner-access-key", import.meta.url), "utf8").trim();
const query = "?" + params;
assert.equal((await request("/auth/consent", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ key, query }) })).status, 403);
assert.equal((await post("/auth/consent", { key: "incorrect", query })).status, 401);
assert.equal((await post("/auth/consent", { query })).status, 401);
assert.equal((await request("/auth/revoke", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ key }) })).status, 403);
assert.equal((await post("/auth/revoke", {})).status, 401);
const consent = await post("/auth/consent", { key, query });
assert.equal(consent.status, 200);
assert.equal(consent.headers.get("Set-Cookie"), null);
const callback = new URL(stringField(await objectBody(consent), "redirectTo"));
assert.equal(callback.origin + callback.pathname, redirectUri);
assert.equal(callback.searchParams.get("iss"), origin);
assert.equal(callback.searchParams.get("state"), state);
console.log("PASS: one-step owner-key approval without cookies, same-origin protection, key-gated revocation, issuer/state binding.");

const grant = { grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirectUri,
  client_id: clientId, code_verifier: verifier, resource };
assert.equal((await tokenRequest({ ...grant, code_verifier: randomBytes(32).toString("base64url") })).status, 400);
const exchanged = await tokenRequest(grant);
assert.equal(exchanged.status, 200);
const tokens = await objectBody(exchanged);
accessToken = stringField(tokens, "access_token");
const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: stringField(tokens, "refresh_token"), client_id: clientId, resource });
assert.equal(refreshed.status, 200);
const fresh = await objectBody(refreshed);
accessToken = stringField(fresh, "access_token");
console.log("PASS: PKCE, access-token issuance and refresh.");

try {
  const initialized = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kitesurf-verification", version: "1.0.0" } });
  assert.ok(initialized.result?.serverInfo);
  const listed = await rpc(2, "tools/list");
  assert.ok(listed.result?.tools.some((tool: { name: string }) => tool.name === "browser_navigate"));
  console.log(`PASS: authenticated MCP initialize and ${listed.result.tools.length} discoverable tools.`);
  if (useBrowser) {
    const navigation = await rpc(3, "tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
    assert.ok(!navigation.error && !navigation.result?.isError, "Browser navigation failed: " + JSON.stringify(navigation));
    assert.match(JSON.stringify(navigation.result), /Example Domain/);
    const screenshot = await rpc(4, "tools/call", { name: "browser_take_screenshot", arguments: {} });
    assert.ok(screenshot.result?.content.some((item: { type: string }) => item.type === "image"), "Screenshot did not contain an image.");
    console.log("PASS: live Cloudflare browser navigated to example.com and returned a screenshot.");
  }
} finally {
  if (useBrowser && mcpSession) {
    await rpc(5, "tools/call", { name: "browser_close", arguments: {} });
    console.log("Browser closed.");
  }
  if (mcpSession) await request("/mcp", { method: "DELETE", headers: { Authorization: "Bearer " + accessToken, "Mcp-Session-Id": mcpSession } });
  assert.equal((await tokenRequest(grant)).status, 400);
  assert.equal((await request("/mcp", { headers: { Authorization: "Bearer " + accessToken } })).status, 401);
  console.log("PASS: authorization-code replay rejected and its grant revoked.");
  const revocationUrl = new URL(stringField(metadata, "revocation_endpoint"));
  assert.equal(revocationUrl.origin, origin);
  const revoked = await request(revocationUrl.pathname, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: stringField(fresh, "refresh_token"), token_type_hint: "refresh_token", client_id: clientId }) });
  assert.equal(revoked.status, 200);
}
console.log("Verification complete. No tokens were printed or saved.");

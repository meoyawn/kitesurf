import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createTestHarness, type Unstable_RawConfig } from "wrangler";
import { JSONRPCResponseSchema } from "@modelcontextprotocol/sdk/types.js";

const origin = "https://kitesurf.example";
const ownerKey = "test-only-owner-key";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const server = createTestHarness();
const worker = server.getWorker<Env>();
let temporary: string | undefined;
let requestId = 0;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(origin + path, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${++requestId}`, ...headers,
  }, body: JSON.stringify(body), redirect: "manual" });

async function authorization() {
  const registered = await post("/oauth/register", { client_name: "Kitesurf test", redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.equal(registered.status, 201);
  const body = await registered.json();
  assert.ok(typeof body === "object" && body !== null && "client_id" in body && typeof body.client_id === "string");
  const clientId = body.client_id;
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: "browser:use", resource: origin + "/mcp", state: randomBytes(16).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  return { clientId, verifier, params, query: "?" + params };
}

const token = (body: Record<string, string>) =>
  worker.fetch(origin + "/oauth/token", { method: "POST", headers: {
    "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": `192.0.2.${++requestId}`,
  }, body: new URLSearchParams(body) });

async function approve(query: string) {
  const response = await post("/auth/consent", { key: ownerKey, query });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null);
  const body = await response.json();
  assert.ok(typeof body === "object" && body !== null && "redirectTo" in body && typeof body.redirectTo === "string");
  return new URL(body.redirectTo);
}

async function tokenBody(response: { json(): Promise<unknown> }) {
  const body = await response.json();
  assert.ok(typeof body === "object" && body !== null && "access_token" in body && typeof body.access_token === "string" &&
    "refresh_token" in body && typeof body.refresh_token === "string");
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

describe("owner authorization without login sessions", function suite() {
  beforeAll(async function start() {
    const config: Unstable_RawConfig = parse(await readFile("wrangler.jsonc", "utf8"));
    // The pinned local runtime supports the same date used by scripts/dev.fish.
    config.compatibility_date = "2026-09-07";
    config.main = resolve(config.main!);
    config.assets = { ...config.assets, directory: resolve(config.assets!.directory!) };
    temporary = await mkdtemp(join(tmpdir(), "kitesurf-auth-test-"));
    const configPath = join(temporary, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config));
    await server.update({ workers: [{ configPath, vars: { PUBLIC_ORIGIN: origin },
      secrets: { OWNER_KEY_HASH: createHash("sha256").update(ownerKey).digest("hex") } }] });
    await server.listen();
  }, 30000);
  afterAll(async function stop() {
    await server.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  test("key entry and consent share one form and viewing pages creates no pending state", async function pages() {
    const env = await worker.getEnv();
    assert.equal("AUTH_DB" in env, false);
    const { query } = await authorization();
    const before = await env.OAUTH_KV.list();
    const response = await worker.fetch(origin + "/authorize" + query, { headers: { Cookie: "__Host-kitesurf-session=old-session" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const html = await response.text();
    assert.match(html, /<form id="key-form" method="post" action="\/auth\/consent">/);
    assert.match(html, /id="owner-key" type="password"/);
    assert.match(html, /id="consent" type="submit">Allow ChatGPT/);
    assert.match(html, /Cloudflare browser quota/);
    assert.doesNotMatch(html, /data-csrf|data-flow|Sign in|Sign out/);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
    const home = await worker.fetch(origin + "/");
    assert.equal(home.headers.get("Set-Cookie"), null);
    const homeHtml = await home.text();
    assert.match(homeHtml, /action="\/auth\/revoke"/);
    assert.match(homeHtml, /id="owner-key"/);
    assert.match(homeHtml, /Revoke ChatGPT access/);
    assert.deepEqual(await env.OAUTH_KV.list(), before);
  });

  test("approval and revocation require a fresh key and a same-origin JSON request", async function boundaries() {
    const { query } = await authorization();
    for (const path of ["/auth/consent", "/auth/revoke"]) {
      for (const key of [undefined, null, 123, "", "incorrect", "x".repeat(201)]) {
        assert.equal((await post(path, { key, query }, { Cookie: "__Host-kitesurf-session=old-session", "X-CSRF-Token": "old-csrf" })).status, 401);
      }
      assert.equal((await post(path, null)).status, 401);
      assert.equal((await post(path, { key: ownerKey, query }, { Origin: "https://evil.example" })).status, 403);
      assert.equal((await post(path, { key: ownerKey, query }, { Origin: "" })).status, 403);
      assert.equal((await post(path, { key: ownerKey, query }, { "Content-Type": "application/x-www-form-urlencoded" })).status, 403);
    }
    for (const path of ["/auth/key", "/auth/logout"]) assert.equal((await post(path, { key: ownerKey })).status, 404);
    const malformed = await worker.fetch(origin + "/auth/consent", { method: "POST", headers: {
      Origin: origin, "Content-Type": "application/json",
    }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await post("/auth/consent", { key: ownerKey })).status, 400);
    assert.equal((await post("/auth/consent", { key: ownerKey, query: "https://evil.example/authorize" })).status, 400);
  });

  test("submission revalidates clients, callbacks, scopes, audiences, response types and PKCE", async function validation() {
    const { params, query } = await authorization();
    assert.equal((await worker.fetch(origin + "/authorize" + query)).status, 200);
    for (const [name, value] of [
      ["client_id", "unregistered-client"],
      ["client_id", "https://evil.example/client.json"],
      ["redirect_uri", "https://evil.example/callback"],
      ["redirect_uri", "https://chatgpt.com/connector/oauth/unregistered"],
      ["scope", "browser:use admin"],
      ["resource", "https://evil.example/mcp"],
      ["response_type", "token"],
      ["code_challenge", ""],
      ["code_challenge_method", "plain"],
    ]) {
      const changed = new URLSearchParams(params);
      changed.set(name, value);
      const response = await post("/auth/consent", { key: ownerKey, query: "?" + changed });
      assert.equal(response.status, 400, name);
      assert.equal(response.headers.get("Location"), null);
      assert.equal(response.headers.get("Set-Cookie"), null);
    }
    const env = await worker.getEnv();
    await env.OAUTH_KV.delete("client:" + params.get("client_id"));
    assert.equal((await post("/auth/consent", { key: ownerKey, query })).status, 400);
  });

  test("OAuth codes remain single-use and refresh works without the owner key", async function tokens() {
    const { clientId, verifier, params, query } = await authorization();
    const callback = await approve(query);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), params.get("state"));
    assert.equal(callback.searchParams.get("iss"), origin);
    assert.equal((await post("/auth/consent", { query })).status, 401);
    const grant = { grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirectUri,
      client_id: clientId, code_verifier: verifier, resource: origin + "/mcp" };
    assert.equal((await token({ ...grant, code_verifier: randomBytes(32).toString("base64url") })).status, 400);
    const exchanged = await token(grant);
    assert.equal(exchanged.status, 200);
    const tokens = await tokenBody(exchanged);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: clientId, resource: origin + "/mcp" });
    assert.equal(refreshed.status, 200);
    const fresh = await tokenBody(refreshed);
    assert.ok(fresh.accessToken);
    assert.notEqual(fresh.refreshToken, tokens.refreshToken);
    const initialized = await worker.fetch(origin + "/mcp", { method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + fresh.accessToken,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kitesurf-test", version: "1.0.0" },
    } }) });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get("mcp-session-id"), null);
    const initializedBody = JSONRPCResponseSchema.parse(await initialized.json());
    assert.ok("result" in initializedBody);
    const result = initializedBody.result;
    assert.ok(typeof result === "object" && result !== null && "serverInfo" in result);
    assert.equal((await token(grant)).status, 400);
    assert.equal((await worker.fetch(origin + "/mcp", { headers: { Authorization: "Bearer " + fresh.accessToken } })).status, 401);
  });

  test("the owner key revokes all grants and prevents access and refresh without issuing a session", async function revocation() {
    const grants = [];
    for (let index = 0; index < 2; index++) {
      const { clientId, verifier, query } = await authorization();
      const callback = await approve(query);
      const exchanged = await token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirectUri,
        client_id: clientId, code_verifier: verifier, resource: origin + "/mcp" });
      assert.equal(exchanged.status, 200);
      const tokens = await tokenBody(exchanged);
      grants.push({ clientId, tokens });
    }
    assert.equal((await post("/auth/revoke", {}, { Authorization: "Bearer " + grants[0].tokens.accessToken })).status, 401);
    const revoked = await post("/auth/revoke", { key: ownerKey });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.headers.get("Set-Cookie"), null);
    for (const { clientId, tokens } of grants) {
      assert.equal((await worker.fetch(origin + "/mcp", { headers: { Authorization: "Bearer " + tokens.accessToken } })).status, 401);
      assert.equal((await token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: clientId, resource: origin + "/mcp" })).status, 400);
    }
    assert.equal((await post("/auth/revoke", {})).status, 401);
    assert.equal((await worker.scheduled({ cron: "17 3 * * *" })).outcome, "ok");
  });
});

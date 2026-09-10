import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const origin = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? process.env.PUBLIC_ORIGIN ?? "https://localhost:8787";
const useYandex = process.argv.includes("--yandex");
const useSites = process.argv.includes("--sites");
const useBrowser = process.argv.includes("--browser") || useYandex || useSites;
const resource = origin + "/mcp";
const scope = "browser:use";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");
let mcpSession = "";
let accessToken = "";
let browserUsed = false;

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
assert.match(lockedPage, /interact with links and forms using your private browser/);
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
    browserUsed = true;
    const navigation = await rpc(3, "tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
    assert.ok(!navigation.error && !navigation.result?.isError, "Browser navigation failed: " + JSON.stringify(navigation));
    assert.match(JSON.stringify(navigation.result), /Example Domain/);
    const linkRef = navigation.result.structuredContent.result.elements.find((element: { href?: string }) => element.href)?.ref;
    assert.equal(typeof linkRef, "number", "Navigation did not return a clickable link reference.");
    mcpSession = "";
    await rpc(4, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kitesurf-reconnected", version: "1.0.0" } });
    const snapshot = await rpc(5, "tools/call", { name: "browser_snapshot", arguments: {} });
    assert.ok(!snapshot.error && !snapshot.result?.isError, "Snapshot after reconnect failed.");
    assert.match(JSON.stringify(snapshot.result), /Example Domain/, "MCP reconnect lost the navigated page.");
    const click = await rpc(6, "tools/call", { name: "browser_click", arguments: { ref: linkRef } });
    assert.ok(!click.error && !click.result?.isError, "Click after reconnect failed: " + JSON.stringify(click));
    assert.match(JSON.stringify(click.result), /iana\.org/, "Click did not follow the original page's link.");
    console.log("PASS: live browser preserved its page and link reference across MCP reconnect and followed the link.");
    const opened = await rpc(700, "tools/call", { name: "browser_tabs", arguments: { action: "new", url: "https://example.com" } });
    assert.ok(!opened.error && !opened.result?.isError, "Opening a tab failed");
    const tabs = opened.result.structuredContent.result.tabs as { id: number; selected: boolean }[];
    assert.equal(tabs.length, 2);
    const selected = tabs.find(tab => tab.selected)!;
    const closed = await rpc(701, "tools/call", { name: "browser_tabs", arguments: { action: "close", id: selected.id } });
    assert.ok(!closed.error && !closed.result?.isError, "Closing a tab failed");
    assert.equal(closed.result.structuredContent.result.tabs.length, 1);
    const restored = await rpc(702, "tools/call", { name: "browser_snapshot", arguments: {} });
    assert.match(JSON.stringify(restored.result), /iana\.org/);
    console.log("PASS: MCP created and closed a second tab and restored the first page.");
    if (useYandex) {
      const url = "https://yandex.ru/jobs/vacancies/city_kazan?profession=backend-developer&profession=system-developer&skills=74&skills=378&skills=64&skills=160&pro_levels=senior";
      const selector = 'a[class*="VacancySnippet_titleLink"]';
      const expression = "Array.from(document.querySelectorAll(" + JSON.stringify(selector) + ")).map(el=>({title:el.textContent.trim(),href:el.href}))";
      let id = 10;
      async function tool(name: string, args = {}) {
        const response = await rpc(id++, "tools/call", { name, arguments: args });
        assert.ok(!response.error && !response.result?.isError, name + " failed: " + JSON.stringify(response));
        return response.result.structuredContent.result;
      }
      const started = performance.now();
      await tool("browser_navigate", { url });
      const before = await tool("browser_evaluate", { expression }) as { title: string; href: string }[];
      assert.equal(before.length, 20, "Expected exactly 20 openings before scrolling");
      const beforeStatus = await tool("browser_status");
      assert.ok(!beforeStatus.network.events.some((event: { url: string }) => event.url.includes("cursor=")), "Pagination ran before scrolling");
      const scrollStarted = performance.now();
      await tool("browser_scroll", { bottom: true });
      await tool("browser_wait_for", { expression: "document.querySelectorAll(" + JSON.stringify(selector) + ").length===21", timeout: 10_000 });
      const after = await tool("browser_evaluate", { expression }) as { title: string; href: string }[];
      assert.equal(after.length, 21);
      assert.equal(new Set(after.map(job => job.href)).size, 21, "Expected 21 distinct jobs");
      assert.ok(before.every(job => after.some(next => next.href === job.href)), "Scrolling lost an existing job");
      const added = after.filter(job => !before.some(previous => previous.href === job.href));
      assert.equal(added.length, 1);
      const status = await tool("browser_status");
      assert.ok(status.network.events.some((event: { url: string; status: number }) => event.url.includes("cursor=") && event.status === 200), "Page did not fetch its next cursor");
      const report = {
        before: before.length, after: after.length, added,
        elapsedMs: Math.round(performance.now() - started), scrollMs: Math.round(performance.now() - scrollStarted),
        wasmMemoryBytes: status.wasmMemoryBytes, requests: status.network.requests, scriptErrors: status.errors,
        quickJsUsedBytes: status.quickJsUsedBytes, rustHeapUsedBytes: status.rustHeapUsedBytes,
      };
      writeFileSync(new URL("../.wrangler/yandex-result.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
      console.log("PASS: live Yandex 20→21 after scrolling. " + JSON.stringify(report));
    }
    if (useSites) {
      const cases = [
        { url: "https://news.ycombinator.com/", selector: ".athing", title: "Hacker News" },
        { url: "https://en.wikipedia.org/wiki/WebAssembly", selector: "#firstHeading", title: "WebAssembly" },
        { url: "https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelector", selector: "h1", title: "querySelector" },
      ];
      const reports = [];
      let id = 800;
      for (const site of cases) {
        const started = performance.now();
        try {
          const response = await rpc(id++, "tools/call", { name: "browser_navigate", arguments: { url: site.url } });
          assert.ok(!response.error && !response.result?.isError, JSON.stringify(response));
          const snapshot = response.result.structuredContent.result;
          assert.ok(snapshot.title.includes(site.title), "Unexpected title: " + snapshot.title);
          assert.ok(snapshot.text.length > 100, "No readable page content");
          const selected = await rpc(id++, "tools/call", { name: "browser_evaluate", arguments: { expression: "document.querySelectorAll(" + JSON.stringify(site.selector) + ").length" } });
          assert.ok(!selected.error && !selected.result?.isError && selected.result.structuredContent.result > 0, "Expected page elements are missing");
          const status = await rpc(id++, "tools/call", { name: "browser_status", arguments: {} });
          reports.push({ url: site.url, passed: true, elapsedMs: Math.round(performance.now() - started), title: snapshot.title, ...status.result.structuredContent.result });
          console.log("PASS: live site content and selectors: " + site.url);
        } catch (error) {
          reports.push({ url: site.url, passed: false, elapsedMs: Math.round(performance.now() - started), error: String(error) });
          console.error("FAIL: live site: " + site.url + " " + String(error));
        }
      }
      writeFileSync(new URL("../.wrangler/sites-result.json", import.meta.url), JSON.stringify(reports, null, 2) + "\n");
      assert.ok(reports.every(report => report.passed), "A live site smoke test failed; see .wrangler/sites-result.json");
    }
  }
} finally {
  if (browserUsed) {
    await rpc(8, "tools/call", { name: "browser_close", arguments: {} });
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

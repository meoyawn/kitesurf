import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { boundedBody, digest, escapeHtml, isChatGptClient, isChatGptRedirect, sameOrigin, verifyOwnerKey } from "../src/security.ts";

describe("Kitesurf access boundaries", function suite() {
  test("only exact ChatGPT callback paths are allowed", function callbacks() {
    assert.equal(isChatGptRedirect("https://chatgpt.com/connector_platform_oauth_redirect"), true);
    assert.equal(isChatGptRedirect("https://chatgpt.com/connector/oauth/callback_123"), true);
    for (const uri of [
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
      "https://chatgpt.com@evil.example/connector_platform_oauth_redirect",
      "http://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect/extra",
      "https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example",
      "https://chatgpt.com/connector_platform_oauth_redirect#fragment",
      "https://chatgpt.com/", "https://evil.example/callback", "javascript:alert(1)",
    ]) assert.equal(isChatGptRedirect(uri), false, uri);
  });

  test("CIMD resolution is limited to ChatGPT metadata URLs", function metadata() {
    assert.equal(isChatGptClient("https://chatgpt.com/oauth/client.json"), true);
    assert.equal(isChatGptClient("https://chatgpt.com/oauth/abc-123/client.json"), true);
    assert.equal(isChatGptClient("https://127.0.0.1/metadata.json"), false);
    assert.equal(isChatGptClient("https://evil.example/client.json"), false);
    assert.equal(isChatGptClient("https://chatgpt.com/oauth/client.json?redirect=https://evil.example"), false);
  });

  test("owner authentication fails closed for wrong or missing secrets", async function keys() {
    const expected = await digest("test-only-owner-key");
    assert.equal(await verifyOwnerKey("test-only-owner-key", expected), true);
    assert.equal(await verifyOwnerKey("incorrect", expected), false);
    assert.equal(await verifyOwnerKey("test-only-owner-key", ""), false);
  });

  test("login and consent reject cross-origin and form requests", function origins() {
    const origin = "https://kitesurf.example";
    assert.equal(sameOrigin(new Request(origin, { headers: { Origin: origin, "Content-Type": "application/json" } }), origin), true);
    assert.equal(sameOrigin(new Request(origin, { headers: { Origin: "https://evil.example", "Content-Type": "application/json" } }), origin), false);
    assert.equal(sameOrigin(new Request(origin, { headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } }), origin), false);
    assert.equal(sameOrigin(new Request(origin), origin), false);
  });

  test("large chunked bodies are stopped even without Content-Length", async function bodies() {
    const request = new Request("https://kitesurf.example", { method: "POST", body: "x".repeat(65) });
    assert.equal(await boundedBody(request, 64), null);
    const small = new Request("https://kitesurf.example", { method: "POST", body: "hello" });
    assert.deepEqual(await boundedBody(small, 64), new TextEncoder().encode("hello"));
  });

  test("authorization page attributes cannot inject HTML", function escaping() {
    assert.equal(escapeHtml('"><script>alert(1)</script>'), "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

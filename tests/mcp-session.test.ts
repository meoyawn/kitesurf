import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserTools } from "../src/browser-tools.ts";
import { createMcpHarness } from "../scripts/mcp-harness-client.ts";
import { makePage } from "./browser-fixture.ts";

const html = `<!doctype html><title>Chat fixture</title>
<button id="more">Load more</button><p id="count">20</p>
<div style="height:4000px;width:2000px"></div>
<script>document.querySelector('#more').onclick=function(){
  const count=document.querySelector('#count');count.textContent=String(Number(count.textContent)+1);
};</script>`;
const fixture = async () => new Response(html, { headers: { "content-type": "text/html" } });
const createHarness = () => createMcpHarness(createBrowserTools(makePage, fixture));

function value(result: CallToolResult): unknown {
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent.result;
}

describe("ChatGPT conversation metadata through MCP HTTP and WASM", function suite() {
  test("initializes, lists tools, and sends chat metadata outside tool arguments", async function wire() {
    const harness = createHarness();
    try {
      const chat = await harness.connect("chat-a");
      assert.equal((await chat.listTools()).tools.length, 26);
      assert.deepEqual(value(await chat.callTool({ name: "browser_open", arguments: { url: "about:blank" } })), { url: "about:blank", title: "" });
      const messages = harness.exchanges.flatMap(exchange => exchange.message ? [exchange.message] : []);
      assert.ok(messages.some(message => "method" in message && message.method === "initialize"));
      assert.ok(messages.some(message => "method" in message && message.method === "notifications/initialized"));
      const call = harness.exchanges.find(exchange => exchange.message && "method" in exchange.message && exchange.message.method === "tools/call");
      assert.ok(call?.message && "params" in call.message);
      assert.deepEqual(call.message.params, { name: "browser_open", arguments: { url: "about:blank" }, _meta: { "openai/session": "chat-a" } });
      assert.equal(call.method, "POST");
      assert.equal(call.headers["content-type"], "application/json");
      assert.match(call.headers.accept, /application\/json/);
      assert.match(call.headers.accept, /text\/event-stream/);
      assert.ok(call.headers["mcp-protocol-version"]);
      assert.equal(call.headers["mcp-session-id"], undefined);
      assert.equal(call.status, 200);
    } finally { await harness.close(); }
  });

  test("interleaved chats scroll and click their own tab, including after reconnect", async function continuity() {
    const harness = createHarness();
    try {
      let a = await harness.connect("chat-a");
      const b = await harness.connect("chat-b");
      value(await a.callTool({ name: "browser_open", arguments: { url: "https://page.test/a" } }));
      const before = value(await a.callTool({ name: "browser_tab_list" }));
      const snapshot = value(await a.callTool({ name: "browser_snapshot" })) as { refs: Record<string, { name: string }> };
      const ref = Object.entries(snapshot.refs).find(entry => entry[1].name === "Load more")?.[0];
      assert.ok(ref);
      value(await b.callTool({ name: "browser_open", arguments: { url: "https://page.test/b" } }));
      value(await a.callTool({ name: "browser_scroll", arguments: { direction: "down", amount: 300 } }));
      await a.close();
      a = await harness.connect("chat-a");
      const script = "({url:location.href,count:document.querySelector('#count').textContent,y:scrollY})";
      assert.deepEqual(value(await a.callTool({ name: "browser_eval", arguments: { script } })), { url: "https://page.test/a", count: "20", y: 300 });
      value(await a.callTool({ name: "browser_click", arguments: { selector: "@" + ref } }));
      assert.deepEqual(value(await a.callTool({ name: "browser_tab_list" })), before);
      // Clicking brings the original button back into view before activating it.
      assert.deepEqual(value(await a.callTool({ name: "browser_eval", arguments: { script } })), { url: "https://page.test/a", count: "21", y: 0 });
      assert.deepEqual(value(await b.callTool({ name: "browser_eval", arguments: { script } })), { url: "https://page.test/b", count: "20", y: 0 });
      const stolen = await b.callTool({ name: "browser_click", arguments: { selector: "@" + ref } });
      assert.equal(stolen.isError, true);
      assert.match(JSON.stringify(stolen.content), /Unknown or stale reference/);
    } finally { await harness.close(); }
  });

  test("cookies and close-all stay inside the chat, namespace and browser session", async function isolation() {
    const harness = createHarness();
    try {
      const a = await harness.connect("chat-a");
      const b = await harness.connect("chat-b");
      const args = { namespace: "work", session: "login" };
      value(await a.callTool({ name: "browser_open", arguments: { ...args, url: "https://page.test/a" } }));
      value(await a.callTool({ name: "browser_eval", arguments: { ...args, script: "document.cookie='owner=a; path=/'" } }));
      value(await a.callTool({ name: "browser_tab_new", arguments: { ...args, url: "https://page.test/a2" } }));
      assert.equal(value(await a.callTool({ name: "browser_eval", arguments: { ...args, script: "document.cookie" } })), "owner=a");
      value(await b.callTool({ name: "browser_open", arguments: { ...args, url: "https://page.test/b" } }));
      assert.equal(value(await b.callTool({ name: "browser_eval", arguments: { ...args, script: "document.cookie" } })), "");
      value(await a.callTool({ name: "browser_open", arguments: { namespace: "work", session: "other" } }));
      value(await a.callTool({ name: "browser_open", arguments: { namespace: "personal" } }));
      value(await a.callTool({ name: "browser_close", arguments: { ...args, all: true } }));
      assert.deepEqual(value(await a.callTool({ name: "browser_status", arguments: args })), { open: false });
      assert.deepEqual(value(await a.callTool({ name: "browser_status", arguments: { namespace: "work", session: "other" } })), { open: false });
      assert.equal(value(await a.callTool({ name: "browser_get_url", arguments: { namespace: "personal" } })), "about:blank");
      assert.equal(value(await b.callTool({ name: "browser_get_url", arguments: args })), "https://page.test/b");
    } finally { await harness.close(); }
  });

  test("concurrent connections for one chat share a tab and serialize actions", async function concurrency() {
    const harness = createHarness();
    try {
      const a = await harness.connect("chat-a");
      const reconnect = await harness.connect("chat-a");
      value(await a.callTool({ name: "browser_open", arguments: { url: "https://page.test/a" } }));
      const script = "new Promise(resolve=>{const count=document.querySelector('#count');const before=Number(count.textContent);setTimeout(()=>{count.textContent=String(before+1);resolve(before+1)},10)})";
      const results = await Promise.all([
        a.callTool({ name: "browser_eval", arguments: { script } }),
        reconnect.callTool({ name: "browser_eval", arguments: { script } }),
      ]);
      assert.deepEqual(results.map(value).sort(), [21, 22]);
      assert.equal(value(await a.callTool({ name: "browser_get_text", arguments: { selector: "#count" } })), "22");
      assert.deepEqual(value(await a.callTool({ name: "browser_tab_list" })), value(await reconnect.callTool({ name: "browser_tab_list" })));
      const failed = await a.callTool({ name: "browser_click", arguments: { selector: "#missing" } });
      assert.equal(failed.isError, true);
      value(await reconnect.callTool({ name: "browser_click", arguments: { selector: "#more" } }));
      assert.equal(value(await a.callTool({ name: "browser_get_text", arguments: { selector: "#count" } })), "23");
    } finally { await harness.close(); }
  });

  test("missing metadata uses a separate legacy scope and invalid metadata fails closed", async function metadata() {
    const harness = createHarness();
    try {
      const chat = await harness.connect("default");
      const legacy = await harness.connect();
      value(await chat.callTool({ name: "browser_open", arguments: { url: "https://page.test/chat" } }));
      assert.deepEqual(value(await legacy.callTool({ name: "browser_status" })), { open: false });
      value(await legacy.callTool({ name: "browser_open", arguments: { url: "https://page.test/legacy" } }));
      for (const session of ["", null, 7, {}, []]) {
        const result = await chat.callTool({ name: "browser_close", arguments: { all: true }, _meta: { "openai/session": session } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /openai\/session/);
      }
      assert.equal(value(await chat.callTool({ name: "browser_get_url" })), "https://page.test/chat");
      assert.equal(value(await legacy.callTool({ name: "browser_get_url" })), "https://page.test/legacy");
      value(await legacy.callTool({ name: "browser_close", arguments: { all: true } }));
      assert.equal(value(await chat.callTool({ name: "browser_get_url" })), "https://page.test/chat");
    } finally { await harness.close(); }
  });

  test("recreating the browser loses its live tab despite the same chat metadata", async function restart() {
    const old = createHarness();
    try {
      const chat = await old.connect("chat-a");
      value(await chat.callTool({ name: "browser_open", arguments: { url: "https://page.test/a" } }));
    } finally { await old.close(); }
    const fresh = createHarness();
    try {
      const chat = await fresh.connect("chat-a");
      const result = await chat.callTool({ name: "browser_scroll", arguments: { direction: "down", amount: 300 } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /No open page/);
      value(await chat.callTool({ name: "browser_open", arguments: { url: "https://page.test/a" } }));
    } finally { await fresh.close(); }
  });
});

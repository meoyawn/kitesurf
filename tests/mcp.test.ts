import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, CallToolResultSchema, JSONRPCResponseSchema, ListToolsRequestSchema, ListToolsResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectBrowserTools, mcpFetch, type BrowserTools } from "../src/mcp.ts";

function browserServer() {
  const server = new Server({ name: "test-browser", version: "1.0.0" }, { capabilities: { tools: {} } });
  let page = "";
  let count = 20;
  server.setRequestHandler(ListToolsRequestSchema, async function list() {
    return { tools: ["browser_navigate", "browser_click", "browser_snapshot", "browser_close"].map(name => ({
      name, inputSchema: { type: "object" as const },
    })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async function call(request) {
    switch (request.params.name) {
      case "browser_navigate":
        page = String(request.params.arguments?.url);
        count = 20;
        break;
      case "browser_click": {
        if (!page || request.params.arguments?.ref !== "load-more") throw new Error("No current snapshot available");
        const previous = count;
        await new Promise(resolve => setTimeout(resolve, 10));
        count = previous + 20;
        break;
      }
      case "browser_close":
        page = "";
        break;
    }
    return { content: [{ type: "text", text: page ? `${page}: ${count} openings; ref=load-more` : "No open pages" }] };
  });
  return server;
}

function rpc(browser: BrowserTools, method: string, params?: unknown, session?: string) {
  return mcpFetch(new Request("https://kitesurf.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), browser);
}

async function call(browser: BrowserTools, name: string, args = {}, session?: string): Promise<CallToolResult> {
  const response = await rpc(browser, "tools/call", { name, arguments: args }, session);
  assert.equal(response.status, 200);
  const body = JSONRPCResponseSchema.parse(await response.json());
  assert.ok("result" in body, JSON.stringify(body));
  const result = CallToolResultSchema.parse(body.result);
  assert.ok(!result.isError, text(result));
  return result;
}

const text = (result: CallToolResult) => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");

describe("MCP browser continuity", function suite() {
  test("navigation and repeated load-more clicks survive new MCP connections", async function reconnect() {
    const server = browserServer();
    const browser = await connectBrowserTools(server);
    try {
      const initialized = await rpc(browser, "initialize", {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
      });
      assert.equal(initialized.status, 200);
      assert.equal(initialized.headers.get("mcp-session-id"), null);
      const listed = JSONRPCResponseSchema.parse(await (await rpc(browser, "tools/list")).json());
      assert.ok("result" in listed);
      assert.equal(ListToolsResultSchema.parse(listed.result).tools.length, 4);
      assert.match(text(await call(browser, "browser_navigate", { url: "https://jobs.example" })), /20 openings/);
      await rpc(browser, "initialize", {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reconnected", version: "1" },
      });
      assert.match(text(await call(browser, "browser_click", { ref: "load-more" })), /40 openings/);
      assert.match(text(await call(browser, "browser_click", { ref: "load-more" }, "legacy-session")), /60 openings/);
      assert.match(text(await call(browser, "browser_snapshot")), /https:\/\/jobs.example: 60 openings/);
    } finally {
      await server.close();
    }
  });

  test("simultaneous requests with identical RPC IDs cannot overwrite browser actions", async function concurrent() {
    const server = browserServer();
    const browser = await connectBrowserTools(server);
    try {
      await call(browser, "browser_navigate", { url: "https://jobs.example" });
      const results = await Promise.all([
        call(browser, "browser_click", { ref: "load-more" }),
        call(browser, "browser_click", { ref: "load-more" }),
      ]);
      assert.deepEqual(results.map(text), [
        "https://jobs.example: 40 openings; ref=load-more",
        "https://jobs.example: 60 openings; ref=load-more",
      ]);
    } finally {
      await server.close();
    }
  });

  test("a failed tool call does not poison the browser queue", async function failure() {
    const server = browserServer();
    const browser = await connectBrowserTools(server);
    try {
      await assert.rejects(browser.callTool({ name: "browser_click", arguments: { ref: "missing" } }), /No current snapshot/);
      assert.match(text(await call(browser, "browser_navigate", { url: "https://jobs.example" })), /20 openings/);
      assert.match(text(await call(browser, "browser_click", { ref: "load-more" })), /40 openings/);
    } finally {
      await server.close();
    }
  });

  test("explicit close releases the page without breaking future MCP calls", async function close() {
    const server = browserServer();
    const browser = await connectBrowserTools(server);
    try {
      await call(browser, "browser_navigate", { url: "https://jobs.example" });
      assert.equal(text(await call(browser, "browser_close")), "No open pages");
      assert.equal(text(await call(browser, "browser_snapshot")), "No open pages");
      assert.match(text(await call(browser, "browser_navigate", { url: "https://other.example" })), /other.example: 20 openings/);
    } finally {
      await server.close();
    }
  });

  test("independent browser instances have independent page state", async function isolated() {
    const first = browserServer();
    const second = browserServer();
    try {
      const a = await connectBrowserTools(first);
      const b = await connectBrowserTools(second);
      await call(a, "browser_navigate", { url: "https://jobs.example" });
      assert.equal(text(await call(b, "browser_snapshot")), "No open pages");
    } finally {
      await first.close();
      await second.close();
    }
  });
});

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, CallToolResultSchema, JSONRPCResponseSchema, ListToolsRequestSchema, ListToolsResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectBrowserTools, mcpFetch, type BrowserTools } from "../src/mcp.ts";
import { manageBrowserLimits } from "../src/browser-limits.ts";

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

describe("MCP browser limit reporting", function suite() {
  test.each([false, true])("named limits and retry guidance reach the LLM through the MCP transports (protocol error: %s)", async function limitResponse(protocolError) {
    const server = browserServer();
    const upstreamError = "Error: Error processing the request: Unable to create new browser: code: 429: message: Too many requests";
    server.setRequestHandler(CallToolRequestSchema, async function rejectLaunch() {
      if (protocolError) throw new Error(upstreamError);
      return { isError: true, content: [{ type: "text", text: upstreamError }], structuredContent: { upstream: "preserved" } };
    });
    try {
      const browser = manageBrowserLimits(await connectBrowserTools(server), {
        async limits() {
          return {
            activeSessions: [{ id: "private-browser-session" }], maxConcurrentSessions: 1,
            allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 12_500,
          };
        },
        async history() { return []; },
      });
      const response = await rpc(browser, "tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
      assert.equal(response.status, 200);
      const body = JSONRPCResponseSchema.parse(await response.json());
      assert.ok("result" in body);
      const result = CallToolResultSchema.parse(body.result);
      assert.equal(result.isError, true);
      assert.deepEqual(result.content[0], { type: "text", text: protocolError ? `McpError: MCP error -32603: ${upstreamError}` : upstreamError });
      if (!protocolError) assert.equal(result.structuredContent?.upstream, "preserved");
      assert.partialDeepStrictEqual(result.structuredContent, {
        browserLimit: {
          service: "cloudflare_browser_run", status: 429, upstreamMessage: "Too many requests",
          limitsHit: [{ limit: "concurrent_browsers" }, { limit: "browser_launch_rate", retryAfterMs: 12_500 }],
          accountLimits: { activeBrowsers: 1, maxConcurrentBrowsers: 1 },
        },
      });
      assert.equal(result.content[1].type, "text");
      if (result.content[1].type !== "text") throw new Error("Missing text diagnostic");
      const diagnosticText = result.content[1].text;
      assert.deepEqual(JSON.parse(diagnosticText.slice(diagnosticText.indexOf("\n") + 1)), result.structuredContent?.browserLimit);
      assert.doesNotMatch(text(result), /private-browser-session/);
    } finally {
      await server.close();
    }
  });
});

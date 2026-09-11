import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, JSONRPCMessageSchema, type CallToolRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpFetch, type BrowserTools } from "../src/mcp.ts";

type Exchange = { method: string; headers: Record<string, string>; message?: JSONRPCMessage; status?: number };

/** Simulate chat metadata over serialized HTTP requests to the real MCP handler. */
export function createMcpHarness(browser: BrowserTools & { close(): Promise<void> }, onExchange?: (exchange: Exchange) => void) {
  const exchanges: Exchange[] = [];
  const clients = new Set<Client>();

  async function route(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init);
    const exchange: Exchange = {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      message: request.method === "POST" ? JSONRPCMessageSchema.parse(await request.clone().json()) : undefined,
    };
    exchanges.push(exchange);
    const response = await mcpFetch(request, browser);
    exchange.status = response.status;
    onExchange?.(exchange);
    return response;
  }

  async function connect(session?: string) {
    const client = new Client({ name: "kitesurf-chat-harness", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp"), { fetch: route });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close();
      throw error;
    }
    clients.add(client);
    return {
      listTools: () => client.listTools(),
      async callTool(params: CallToolRequest["params"]) {
        return CallToolResultSchema.parse(await client.callTool({
          ...params,
          _meta: { ...(session === undefined ? {} : { "openai/session": session }), ...params._meta },
        }, CallToolResultSchema, { timeout: 180_000 }));
      },
      async close() {
        await client.close();
        clients.delete(client);
      },
    };
  }

  return {
    connect,
    exchanges,
    async close() {
      try { await Promise.all(Array.from(clients, client => client.close())); }
      finally { clients.clear(); await browser.close(); }
    },
  };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

export type BrowserTools = Pick<Client, "listTools" | "callTool">;

/** Connect once to the browser server and serialize operations on its selected tab. */
export async function connectBrowserTools(server: Server): Promise<BrowserTools> {
  const client = new Client({ name: "kitesurf-browser", version: "0.1.0" });
  const transports = InMemoryTransport.createLinkedPair();
  await server.connect(transports[1]);
  await client.connect(transports[0]);
  let pending: Promise<unknown> = Promise.resolve();
  return {
    listTools: () => client.listTools(),
    callTool(params: CallToolRequest["params"]) {
      const result = pending.then(function run() {
        return client.callTool(params);
      });
      pending = result.catch(function recover() {});
      return result;
    },
  };
}

/** Transport connections may end between tool calls; browser state belongs to the owner. */
export async function mcpFetch(request: Request, browser: BrowserTools): Promise<Response> {
  const server = new Server({ name: "Kitesurf", version: "0.1.0" }, {
    capabilities: { tools: {} },
    instructions: "Browser tabs persist across tool calls and MCP reconnects. The owner shares one browser; use tabs for separate pages. Call browser_close when finished to release the browser. Sessions expire after five minutes without browser activity.",
  });
  server.setRequestHandler(ListToolsRequestSchema, () => browser.listTools());
  server.setRequestHandler(CallToolRequestSchema, request => browser.callTool(request.params));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

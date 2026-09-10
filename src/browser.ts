import { DurableObject } from "cloudflare:workers";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserTools } from "./browser-tools.ts";
import { createPage } from "./browser-engine.ts";

/** The browser outlives individual MCP transports, including client reconnects. */
export class BrowserMCP extends DurableObject<Env> {
  private browser = createBrowserTools(createPage);

  async listTools() {
    return this.browser.listTools();
  }

  async callTool(params: CallToolRequest["params"]) {
    return this.browser.callTool(params);
  }

  async alarm() {
    // Consume alarms left by older deployments without closing an active browsing session.
  }
}

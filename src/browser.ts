import { DurableObject } from "cloudflare:workers";
import { endpointURLString, history, limits, sessions } from "@cloudflare/playwright";
import { createMcpServer } from "@cloudflare/playwright-mcp";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { connectBrowserTools, type BrowserTools } from "./mcp.ts";
import { manageBrowserLimits } from "./browser-limits.ts";

/** The browser outlives individual MCP transports, including client reconnects. */
export class PlaywrightMCP extends DurableObject<Env> {
  private browser?: Promise<BrowserTools>;

  private tools(): Promise<BrowserTools> {
    if (!this.browser) {
      const endpoint = new URL(endpointURLString(this.env.BROWSER));
      endpoint.searchParams.set("keep_alive", "60000");
      this.browser = createMcpServer(endpoint).then(connectBrowserTools).then(browser => manageBrowserLimits(browser, {
        limits: () => limits(this.env.BROWSER),
        history: () => history(this.env.BROWSER),
        sessions: () => sessions(this.env.BROWSER),
      })).catch(error => {
        this.browser = undefined;
        throw error;
      });
    }
    return this.browser;
  }

  async listTools() {
    return (await this.tools()).listTools();
  }

  async callTool(params: CallToolRequest["params"]) {
    return (await this.tools()).callTool(params);
  }
}

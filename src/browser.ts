import { DurableObject } from "cloudflare:workers";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserTools } from "./browser-tools.ts";
import { createPage } from "./browser-engine.ts";

/** The browser outlives individual MCP transports, including client reconnects. */
export class BrowserMCP extends DurableObject<Env> {
  private browser = createBrowserTools(createPage);
  private busy = 0;
  private lastActivity = 0;

  async listTools() {
    return this.browser.listTools();
  }

  async callTool(params: CallToolRequest["params"]) {
    this.busy++;
    this.lastActivity = Date.now();
    try {
      await this.ctx.storage.setAlarm(this.lastActivity + 60_000);
      return await this.browser.callTool(params);
    } finally {
      this.busy--;
      this.lastActivity = Date.now();
      await this.ctx.storage.setAlarm(this.lastActivity + 60_000);
    }
  }

  async alarm() {
    if (this.busy || Date.now() - this.lastActivity < 60_000) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    await this.browser.close();
  }
}

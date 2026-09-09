import { z } from "zod";
import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserPage } from "./browser-runtime.ts";
import { browserUrl, createBrowserNetwork, type BrowserNetwork } from "./browser-network.ts";

const target = { selector: z.string().min(1).max(2048).optional(), ref: z.number().int().nonnegative().optional() };
const schemas = {
  browser_navigate: z.object({ url: z.string().url().max(8192) }).strict(),
  browser_snapshot: z.object({}).strict(),
  browser_click: z.object(target).strict(),
  browser_fill: z.object({ ...target, text: z.string().max(64 * 1024) }).strict(),
  browser_evaluate: z.object({ expression: z.string().min(1).max(64 * 1024) }).strict(),
  browser_scroll: z.object({ y: z.number().finite().optional(), bottom: z.boolean().optional() }).strict(),
  browser_wait_for: z.object({ expression: z.string().min(1).max(64 * 1024), timeout: z.number().int().min(0).max(10_000).default(5000) }).strict(),
  browser_status: z.object({}).strict(),
  browser_tabs: z.object({ action: z.enum(["list", "new", "select", "close"]), id: z.number().int().positive().optional(), url: z.string().url().max(8192).optional() }).strict(),
  browser_close: z.object({}).strict(),
};
const targetProperties = { selector: { type: "string", description: "CSS selector" }, ref: { type: "integer", description: "Node reference from a snapshot" } };
const definitions: { name: keyof typeof schemas; description: string; properties?: Record<string, object>; required?: string[] }[] = [
  { name: "browser_navigate", description: "Load an HTTP(S) page and execute its JavaScript inside the Worker. Replaces the current page.", properties: { url: { type: "string" } }, required: ["url"] },
  { name: "browser_snapshot", description: "Read page text and links/forms with numeric node references." },
  { name: "browser_click", description: "Click a node by ref or CSS selector. Follows link and form navigation.", properties: targetProperties },
  { name: "browser_fill", description: "Fill an input, textarea or select by ref or CSS selector; dispatch input/change events.", properties: { ...targetProperties, text: { type: "string" } }, required: ["text"] },
  { name: "browser_evaluate", description: "Evaluate a synchronous JavaScript expression in the page; returns JSON. Use browser_wait_for for asynchronous page activity.", properties: { expression: { type: "string" } }, required: ["expression"] },
  { name: "browser_scroll", description: "Scroll to a vertical offset or traverse to the bottom; process intersection observers and asynchronous page work.", properties: { y: { type: "number" }, bottom: { type: "boolean" } } },
  { name: "browser_wait_for", description: "Run pending page tasks until a synchronous expression is truthy or timeout expires (milliseconds, max 10000).", properties: { expression: { type: "string" }, timeout: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["expression"] },
  { name: "browser_status", description: "Inspect the open page, recent script errors, requests and allocated WASM memory without opening a browser." },
  { name: "browser_tabs", description: "List, create, select or close tabs. New requires url; select and close require id. Up to four tabs share the browser memory budget.", properties: { action: { type: "string", enum: ["list", "new", "select", "close"] }, id: { type: "integer" }, url: { type: "string" } }, required: ["action"] },
  { name: "browser_close", description: "Release all tabs, cookies and the WASM instance. Close when browsing is finished." },
];
const tools: Tool[] = definitions.map(function tool(definition) {
  return {
    name: definition.name, description: definition.description,
    inputSchema: { type: "object", properties: definition.properties || {}, required: definition.required || [], additionalProperties: false },
    annotations: { readOnlyHint: ["browser_status", "browser_snapshot"].includes(definition.name), openWorldHint: true },
  };
});

function element(args: { ref?: number; selector?: string }) {
  if (args.selector) return "document.querySelector(" + JSON.stringify(args.selector) + ")";
  if (args.ref !== undefined) return "_wrap(" + args.ref + ")";
  throw new Error("Provide ref or selector");
}

/** Tabs and a serial action queue survive MCP transport reconnects. */
export function createBrowserTools(makePage: (url: string, html: string, network: BrowserNetwork, browser: object) => Promise<BrowserPage>, fetcher: typeof fetch = fetch) {
  type Tab = { id: number; page?: BrowserPage; network?: BrowserNetwork };
  const tabs = new Map<number, Tab>();
  const scope = {};
  let tab: Tab | undefined;
  let nextId = 0;
  let pending: Promise<unknown> = Promise.resolve();

  function newTab() {
    if (tabs.size >= 4) throw new Error("Close a tab before opening another (maximum four)");
    tab = { id: ++nextId };
    tabs.set(tab.id, tab);
    return tab;
  }
  async function closeTab(id: number) {
    const target = tabs.get(id);
    if (!target) throw new Error("Unknown tab: " + id);
    tabs.delete(id);
    if (tab === target) tab = Array.from(tabs.values()).at(-1);
    target.network?.close();
    await target.page?.close();
  }
  async function close() {
    for (const id of tabs.keys()) await closeTab(id);
  }
  async function navigate(url: string, method = "GET", body?: string) {
    browserUrl(url);
    const target = tab || newTab();
    const previous = target.page; target.page = undefined;
    await previous?.close();
    target.network = target.network?.next() || createBrowserNetwork(fetcher);
    try {
      const response = await target.network.download(url, { method, body, headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined });
      if (response.blocked) throw new Error("Navigation blocked by the Obscura tracker list");
      target.page = await makePage(response.url, response.body, target.network, scope);
      await target.page.start();
    }
    catch (error) { await closeTab(target.id); throw error; }
  }
  function current() {
    if (!tab?.page) throw new Error("No open page; call browser_navigate");
    return tab.page;
  }
  function snapshot() {
    if (!tab?.page) return { open: false };
    return tab.page.snapshot();
  }
  async function finish() {
    await tab?.page?.settle(1500);
    for (let count = 0; count < 5; count++) {
      const navigation = tab?.page?.takeNavigation();
      if (!navigation) return;
      await navigate(navigation.url, navigation.method, navigation.body);
    }
    throw new Error("Page exceeded five script navigations");
  }
  async function call(params: CallToolRequest["params"]): Promise<CallToolResult> {
    try {
      const name = params.name as keyof typeof schemas;
      if (!Object.hasOwn(schemas, name)) throw new Error("Unknown browser tool: " + params.name);
      const args = params.arguments || {};
      schemas[name].parse(args);
      tab?.page?.begin();
      let output: unknown;
      switch (name) {
        case "browser_navigate": await navigate(schemas.browser_navigate.parse(args).url); await finish(); output = snapshot(); break;
        case "browser_snapshot": output = snapshot(); break;
        case "browser_click":
          current().evaluate("(()=>{const el=" + element(schemas.browser_click.parse(args)) + ";if(!el||!el.isConnected)throw Error('Element missing or stale');el.click();return true})()");
          await finish(); output = snapshot(); break;
        case "browser_fill": {
          const input = schemas.browser_fill.parse(args);
          current().evaluate("(()=>{const el=" + element(input) + ";if(!el||!['INPUT','TEXTAREA','SELECT'].includes(el.tagName))throw Error('Expected an input, textarea or select');const proto=el.tagName==='INPUT'?HTMLInputElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el," + JSON.stringify(input.text) + ");else el.value=" + JSON.stringify(input.text) + ";el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
          await finish(); output = snapshot(); break;
        }
        case "browser_evaluate": output = current().evaluate(schemas.browser_evaluate.parse(args).expression); await finish(); break;
        case "browser_scroll": {
          const input = schemas.browser_scroll.parse(args);
          if (input.bottom) {
            const destination = Number(current().evaluate("Math.max(0,document.documentElement.scrollHeight-innerHeight)"));
            let position = Number(current().evaluate("scrollY"));
            for (let step = 0; step < 100 && position < destination; step++) {
              position = Math.min(destination, position + 576);
              current().evaluate("scrollTo(0," + position + ")");
              await current().settle(50);
            }
          } else current().evaluate("scrollTo(0," + String(input.y ?? 720) + ")");
          await finish(); output = snapshot(); break;
        }
        case "browser_wait_for": {
          const input = schemas.browser_wait_for.parse(args);
          const deadline = Date.now() + input.timeout;
          while (!current().evaluate(input.expression)) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for expression");
            await current().settle(Math.min(100, Math.max(1, deadline - Date.now())));
          }
          output = snapshot(); break;
        }
        case "browser_tabs": {
          const input = schemas.browser_tabs.parse(args);
          if (input.action === "new") {
            if (!input.url) throw new Error("New tab requires url");
            browserUrl(input.url);
            newTab(); await navigate(input.url); await finish();
          } else if (input.action !== "list") {
            if (!input.id || !tabs.has(input.id)) throw new Error("Select/close requires an existing tab id");
            if (input.action === "close") await closeTab(input.id);
            else tab = tabs.get(input.id);
          }
          output = { tabs: Array.from(tabs.values(), function info(item) { return { id: item.id, selected: item === tab, url: item.page?.status().url }; }) };
          break;
        }
        case "browser_status": output = tab?.page ? { open: true, tab: tab.id, tabs: tabs.size, ...tab.page.status() } : { open: false }; break;
        case "browser_close": await close(); output = { open: false }; break;
      }
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { result: output } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof WebAssembly.RuntimeError || /instruction budget|interrupted|out of memory|WASM runtime failed/i.test(message)) await close();
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }
  function callTool(params: CallToolRequest["params"]) {
    const result = pending.then(function run() { return call(params); });
    pending = result.catch(function recover() {});
    return result;
  }
  return {
    async listTools() { return { tools }; },
    callTool,
    async close() { await pending; await close(); },
  };
}

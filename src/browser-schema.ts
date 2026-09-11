import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const selector = z.string().min(1).describe("Element @e reference from the current tab's snapshot, or a CSS selector.");
const waitTimeoutMs = z.number().int().positive().optional().describe("Maximum time for the wait condition, in milliseconds.");
const common = {
  session: z.string().min(1).optional().describe("Isolated browser session name; defaults to default."),
  namespace: z.string().min(1).optional().describe("Namespace for isolated browser sessions."),
  allowedDomains: z.array(z.string().min(1)).optional().describe("Allow only these domains or *.domain patterns, including redirects and page requests. Retained until changed."),
  timeoutMs: z.number().int().positive().default(120_000).describe("Maximum duration of the tool call in milliseconds."),
};
const object = <T extends z.ZodRawShape>(shape: T) => z.object({ ...common, ...shape }).strict();

/** Agent-browser core profile, with browser_ names and Worker-native transport options. */
export const browserSchemas = {
  browser_tools_profiles: object({}),
  browser_open: object({ url: z.string().min(1).optional().describe("HTTP(S) URL or bare host. Omit to keep the current page or open about:blank.") }),
  browser_read: object({
    url: z.string().min(1).optional(), raw: z.boolean().optional(), requireMd: z.boolean().optional(),
    llms: z.enum(["index", "full"]).optional(), outline: z.boolean().optional(), filter: z.string().optional(),
    readTimeoutMs: z.number().int().positive().optional(),
  }),
  browser_snapshot: object({
    interactive: z.boolean().default(true), compact: z.boolean().default(false),
    depth: z.number().int().nonnegative().optional(), selector: selector.optional(), includeUrls: z.boolean().default(false),
  }),
  browser_reload: object({}),
  browser_click: object({ selector, newTab: z.boolean().default(false) }),
  browser_fill: object({ selector, text: z.string() }),
  browser_check: object({ selector }),
  browser_uncheck: object({ selector }),
  browser_select: object({ selector, values: z.array(z.string()).min(1) }),
  browser_scroll: object({ direction: z.enum(["up", "down", "left", "right"]).default("down"), amount: z.number().int().nonnegative().default(300), selector: selector.optional() }),
  browser_wait_ms: object({ ms: z.number().int().nonnegative() }),
  browser_wait_for_selector: object({ selector, waitTimeoutMs }),
  browser_wait_for_text: object({ text: z.string(), waitTimeoutMs }),
  browser_wait_for_load: object({ state: z.enum(["load", "domcontentloaded", "networkidle"]), waitTimeoutMs }),
  browser_wait_for_function: object({ expression: z.string().min(1), waitTimeoutMs }),
  browser_get_text: object({ selector }),
  browser_get_url: object({}),
  browser_get_title: object({}),
  browser_status: object({}),
  browser_tab_new: object({ url: z.string().min(1).optional(), label: z.string().min(1).optional() }),
  browser_tab_list: object({}),
  browser_tab_switch: object({ tab: z.string().min(1).describe("Tab ID (t1) or label.") }),
  browser_tab_close: object({ tab: z.string().min(1).optional().describe("Tab ID or label; omit for the current tab.") }),
  browser_eval: object({ script: z.string().min(1).describe("Page JavaScript expression or script; returned promises are awaited.") }),
  browser_close: object({ all: z.boolean().default(false).describe("Close all sessions in this namespace.") }),
};

const descriptions: Record<keyof typeof browserSchemas, string> = {
  browser_tools_profiles: "Describe the active core profile and Worker capabilities.",
  browser_open: "Open the browser and optionally navigate. Bare hosts use HTTPS. Navigation runs page scripts and retains session cookies.",
  browser_read: "Read the active DOM, or fetch a URL without navigating. Prefer Markdown, discover nearest-ancestor llms.txt, extract readable HTML, and optionally filter sections or return an outline.",
  browser_snapshot: "Read an accessibility tree with stable @e references. Defaults to interactive elements; interactive=false includes page structure and text.",
  browser_reload: "Reload the current page and run its scripts, retaining session cookies.",
  browser_click: "Click an element by @e reference or CSS selector. newTab opens its link in a new tab.",
  browser_fill: "Focus, clear and fill an editable field, dispatching input and change events.",
  browser_check: "Ensure a checkbox, radio button or ARIA switch is checked.",
  browser_uncheck: "Ensure a checkbox or ARIA switch is unchecked.",
  browser_select: "Select one or more options by value or visible label and dispatch input/change events.",
  browser_scroll: "Scroll the page or a selected element in any direction and process page activity.",
  browser_wait_ms: "Wait for a fixed duration while processing page tasks.",
  browser_wait_for_selector: "Wait until an element is present and visible.",
  browser_wait_for_text: "Wait until visible page text contains the requested text.",
  browser_wait_for_load: "Wait for DOMContentLoaded, load, or 500 milliseconds without pending network activity.",
  browser_wait_for_function: "Process page tasks until a synchronous JavaScript expression becomes truthy.",
  browser_get_text: "Read visible text from an element.",
  browser_get_url: "Read the active tab's current URL, including page history changes.",
  browser_get_title: "Read the active tab's title.",
  browser_status: "Inspect script errors, requests and shared WASM memory without opening a browser.",
  browser_tab_new: "Create and select a tab, optionally with a URL and unique label. Omit URL for about:blank.",
  browser_tab_list: "List IDs, labels, titles and URLs of tabs in this session.",
  browser_tab_switch: "Select a tab by stable ID or label.",
  browser_tab_close: "Close a tab by ID or label, or close the current tab.",
  browser_eval: "Execute page JavaScript, including scripts and asynchronous expressions, and return its JSON result.",
  browser_close: "Release the session's tabs, cookies, storage, references and WASM memory. all=true closes every session in this namespace.",
};
const readOnly = new Set([
  "browser_tools_profiles", "browser_read", "browser_snapshot", "browser_wait_ms", "browser_wait_for_selector",
  "browser_wait_for_text", "browser_wait_for_load", "browser_wait_for_function", "browser_get_text", "browser_get_url", "browser_get_title", "browser_tab_list", "browser_status",
]);

export const browserToolDefinitions: Tool[] = Object.entries(browserSchemas).map(function definition([name, schema]) {
  const { $schema: _dialect, ...inputSchema } = toJsonSchemaCompat(schema, { pipeStrategy: "input" });
  return {
    name, description: descriptions[name as keyof typeof descriptions], inputSchema: { ...inputSchema, type: "object" },
    annotations: { readOnlyHint: readOnly.has(name), openWorldHint: name !== "browser_tools_profiles" },
  };
});

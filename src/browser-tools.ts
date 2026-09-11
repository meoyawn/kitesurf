import { CookieJar } from "tough-cookie";
import type { z } from "zod";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserPage } from "./browser-runtime.ts";
import { browserUrl, checkBrowserDomain, createBrowserNetwork, normalizeBrowserUrl, type BrowserNetwork, type BrowserNetworkPolicy } from "./browser-network.ts";
import { browserSchemas, browserToolDefinitions } from "./browser-schema.ts";
import { browserPageScript } from "./browser-page-script.ts";
import { formatRead, readBrowserUrl, readHtmlScript, type ReadDocument } from "./browser-read.ts";

type ToolName = keyof typeof browserSchemas;
type ToolCall = { [Name in ToolName]: { name: Name; args: z.output<typeof browserSchemas[Name]> } }[ToolName];
type Tab = { id: string; label?: string; page?: BrowserPage; network?: BrowserNetwork; refs: Map<string, number>; nodeRefs: Map<number, string> };
type Session = { namespace: string; tabs: Map<string, Tab>; tab?: Tab; runningTab?: Tab; jar: CookieJar; policy: BrowserNetworkPolicy };
type SnapshotNode = { nodeId?: number; role: string; name: string; depth: number; interactive?: boolean; href?: string; value?: string; disabled?: boolean; checked?: boolean | string; selected?: boolean; level?: number };

/** All sessions share one bounded WASM heap. Calls serialize across MCP reconnects. */
export function createBrowserTools(makePage: (url: string, html: string, network: BrowserNetwork, browser: object) => Promise<BrowserPage>, fetcher: typeof fetch = fetch) {
  const sessions = new Map<string, Session>();
  const scope = {};
  let nextTab = 0, nextRef = 0;
  let pending: Promise<unknown> = Promise.resolve();

  function getSession(namespace = "default", name = "default") {
    const key = JSON.stringify([namespace, name]);
    let session = sessions.get(key);
    if (!session) {
      session = { namespace, tabs: new Map(), jar: new CookieJar(), policy: {} };
      sessions.set(key, session);
    }
    return session;
  }
  function current(session: Session): BrowserPage {
    if (!session.tab?.page) throw new Error("No open page; call browser_open");
    session.runningTab = session.tab;
    return session.tab.page;
  }
  function info(session: Session) {
    if (!session.tab?.page) return { open: false };
    return current(session).evaluate("({url:location.href,title:document.title})");
  }
  function resolveTab(session: Session, value?: string) {
    const tab = value === undefined ? session.tab : session.tabs.get(value) || Array.from(session.tabs.values()).find(tab => tab.label === value);
    if (!tab) throw new Error("Unknown tab: " + (value || "current"));
    return tab;
  }
  function newTab(session: Session, label?: string) {
    if (label && (session.tabs.has(label) || /^t\d+$/.test(label) || Array.from(session.tabs.values()).some(tab => tab.label === label))) throw new Error("Tab label must be unique and must not look like a tab ID");
    const tab: Tab = { id: "t" + ++nextTab, label, refs: new Map(), nodeRefs: new Map() };
    session.tabs.set(tab.id, tab); session.tab = tab;
    return tab;
  }
  async function closeTab(session: Session, tab: Tab) {
    session.tabs.delete(tab.id);
    if (session.tab === tab) session.tab = Array.from(session.tabs.values()).at(-1);
    tab.refs.clear(); tab.nodeRefs.clear(); tab.network?.close();
    await tab.page?.close();
  }
  async function closeSession(session: Session) {
    for (const tab of session.tabs.values()) await closeTab(session, tab);
    session.jar.removeAllCookiesSync();
    for (const [key, value] of sessions) if (value === session) sessions.delete(key);
  }
  async function closeAll() {
    for (const session of sessions.values()) await closeSession(session);
  }
  async function navigate(session: Session, value: string, method = "GET", body?: string) {
    const url = normalizeBrowserUrl(value);
    if (url !== "about:blank") checkBrowserDomain(browserUrl(url), session.policy.allowedDomains);
    const tab = session.tab || newTab(session);
    session.runningTab = tab;
    await tab.page?.close(); tab.page = undefined;
    tab.refs.clear(); tab.nodeRefs.clear();
    tab.network = createBrowserNetwork(fetcher, session.jar, session.policy);
    try {
      const response = url === "about:blank" ? { url, body: "<!doctype html><html><head></head><body></body></html>", blocked: false } : await tab.network.download(url, { method, body, headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined });
      if (response.blocked) throw new Error("Navigation blocked by the Obscura tracker list");
      tab.page = await makePage(response.url, response.body, tab.network, scope);
      await tab.page.start();
    } catch (error) { await closeTab(session, tab); throw error; }
  }
  async function finish(session: Session, settle = true) {
    if (settle) await session.tab?.page?.settle();
    while (true) {
      session.policy.signal?.throwIfAborted();
      const navigation = session.tab?.page?.takeNavigation();
      if (!navigation) return;
      await navigate(session, navigation.url, navigation.method, navigation.body);
    }
  }
  function target(session: Session, selector?: string): { selector?: string; nodeId?: number } {
    if (selector?.startsWith("@")) {
      const nodeId = session.tab?.refs.get(selector.slice(1));
      if (nodeId === undefined) throw new Error("Unknown or stale reference; take a fresh browser_snapshot in this tab");
      return { nodeId };
    }
    return selector === undefined ? {} : { selector };
  }
  function pageOperation(session: Session, operation: string, args: object = {}) {
    return current(session).evaluate("(" + browserPageScript + ")(" + JSON.stringify(operation) + "," + JSON.stringify(args) + ")");
  }
  function snapshot(session: Session, args: z.output<typeof browserSchemas.browser_snapshot>) {
    const data = pageOperation(session, "snapshot", { ...args, ...target(session, args.selector) }) as { url: string; title: string; nodes: SnapshotNode[] };
    const tab = session.tab!;
    const previousRefs = tab.nodeRefs;
    tab.nodeRefs = new Map();
    tab.refs.clear();
    const refs: Record<string, { role: string; name: string }> = {};
    const lines: string[] = [];
    for (const node of data.nodes) {
      let ref: string | undefined;
      if (node.nodeId !== undefined && (node.interactive || node.role === "heading" || node.role === "img")) {
        ref = previousRefs.get(node.nodeId) || "e" + ++nextRef;
        tab.nodeRefs.set(node.nodeId, ref); tab.refs.set(ref, node.nodeId);
        refs[ref] = { role: node.role, name: node.name };
      }
      lines.push("  ".repeat(args.interactive ? 0 : node.depth) + "- " + node.role + (node.name ? " " + JSON.stringify(node.name) : "") +
        (ref ? " [ref=" + ref + "]" : "") + (node.level ? " [level=" + node.level + "]" : "") +
        (node.disabled ? " [disabled]" : "") + (node.checked === true || node.checked === "true" ? " [checked]" : node.checked === "mixed" ? " [mixed]" : "") +
        (node.selected ? " [selected]" : "") + (node.href ? " " + node.href : "") + (node.value ? " value=" + JSON.stringify(node.value) : ""));
    }
    return { url: data.url, title: data.title, snapshot: lines.join("\n"), refs };
  }
  function listTabs(session: Session) {
    return { tabs: Array.from(session.tabs.values(), function entry(tab) {
      const page = tab.page?.evaluate("({url:location.href,title:document.title})") as { url: string; title: string } | undefined;
      return { id: tab.id, label: tab.label, selected: tab === session.tab, ...page };
    }) };
  }
  async function waitFor(session: Session, condition: () => unknown, timeout = 25_000) {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      session.policy.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Timed out waiting for page condition");
      await current(session).settle(Math.min(100, Math.max(1, deadline - Date.now())));
      await finish(session, false);
    }
  }
  async function evaluate(session: Session, script: string) {
    const page = current(session);
    const key = JSON.stringify("__kitesurf_eval_" + crypto.randomUUID().replaceAll("-", ""));
    let asynchronous = false;
    try {
      let state = page.evaluate("(()=>{const value=(0,eval)(" + JSON.stringify(script) + ");if(!value||typeof value.then!=='function')return {value:value??null};const state={done:false};Object.defineProperty(globalThis," + key + ",{value:state,configurable:true});Promise.resolve(value).then(value=>{state.value=value??null;state.done=true},error=>{state.error=String(error);state.done=true});return {pending:true}})()") as { pending?: boolean; value?: unknown; error?: string };
      asynchronous = Boolean(state.pending);
      if (asynchronous) {
        await waitFor(session, function done() { return page.evaluate("globalThis[" + key + "].done"); }, 120_000);
        state = page.evaluate("globalThis[" + key + "]") as typeof state;
      }
      if ("error" in state) throw new Error(state.error || "Page promise rejected");
      await finish(session);
      return state.value;
    } finally {
      if (asynchronous && session.tab?.page === page) {
        try { page.evaluate("delete globalThis[" + key + "]"); } catch { /* A faulted or aborted VM is disposed by the caller. */ }
      }
    }
  }
  async function execute(session: Session, call: ToolCall): Promise<unknown> {
    const { name, args } = call;
    switch (name) {
      case "browser_tools_profiles": return { activeProfiles: ["core"], tools: browserToolDefinitions.map(tool => tool.name), engine: "Obscura layout + stealth + QuickJS", excluded: ["screenshots", "painting", "keyboard input", "back/forward history", "AI chat"], sessionsShareWasmHeap: true };
      case "browser_open":
        if (args.url || !session.tab?.page) { await navigate(session, args.url || "about:blank"); await finish(session, false); }
        return info(session);
      case "browser_reload": await navigate(session, String(current(session).evaluate("location.href"))); await finish(session, false); return info(session);
      case "browser_snapshot": return snapshot(session, args);
      case "browser_read": {
        if (!args.url && !args.llms && !args.requireMd) {
          const document = pageOperation(session, "read", { raw: args.raw }) as ReadDocument;
          return { url: document.url, title: document.title, source: "dom", content: formatRead(document, args) };
        }
        const controller = new AbortController();
        const timer = setTimeout(function timeout() { controller.abort(new Error("Read timed out")); }, args.readTimeoutMs || 30_000);
        const policy = { allowedDomains: session.policy.allowedDomains, signal: session.policy.signal ? AbortSignal.any([session.policy.signal, controller.signal]) : controller.signal };
        const network = createBrowserNetwork(fetcher, new CookieJar(), policy);
        try {
          return await readBrowserUrl({ ...args, url: args.url || String(current(session).evaluate("location.href")) }, network, async function parseHtml(url, html) {
            const page = await makePage(url, html, network, scope);
            try { return page.evaluate(readHtmlScript) as ReadDocument; }
            finally { await page.close(); }
          });
        } finally { clearTimeout(timer); network.close(); }
      }
      case "browser_click":
        if (args.newTab) {
          const element = pageOperation(session, "target", target(session, args.selector)) as { href?: string };
          if (!element.href) throw new Error("newTab requires a link with an HTTP(S) URL");
          const url = normalizeBrowserUrl(element.href);
          checkBrowserDomain(browserUrl(url), session.policy.allowedDomains);
          newTab(session); await navigate(session, url);
        } else pageOperation(session, "click", target(session, args.selector));
        await finish(session); return info(session);
      case "browser_fill": pageOperation(session, "fill", { ...target(session, args.selector), text: args.text }); await finish(session); return info(session);
      case "browser_check": case "browser_uncheck": pageOperation(session, "check", { ...target(session, args.selector), checked: name === "browser_check" }); await finish(session); return info(session);
      case "browser_select": { const values = pageOperation(session, "select", { ...target(session, args.selector), values: args.values }); await finish(session); return { values }; }
      case "browser_scroll": { const position = pageOperation(session, "scroll", { ...target(session, args.selector), direction: args.direction, amount: args.amount }); await finish(session); return position; }
      case "browser_wait_ms": {
        const deadline = Date.now() + args.ms;
        do { await current(session).settle(Math.min(100, Math.max(0, deadline - Date.now()))); await finish(session, false); } while (Date.now() < deadline);
        return info(session);
      }
      case "browser_wait_for_selector": await waitFor(session, function visible() { return pageOperation(session, "visible", target(session, args.selector)); }, args.waitTimeoutMs); return info(session);
      case "browser_wait_for_text": await waitFor(session, function text() { return String(pageOperation(session, "text")).includes(args.text); }, args.waitTimeoutMs); return info(session);
      case "browser_wait_for_function": await waitFor(session, function expression() { return current(session).evaluate(args.expression); }, args.waitTimeoutMs); return info(session);
      case "browser_wait_for_load": {
        let idleSince = Date.now(), requests = session.tab?.network?.diagnostics().requests;
        await waitFor(session, function ready() {
          const state = String(current(session).evaluate("document.readyState"));
          if (args.state === "domcontentloaded") return state === "interactive" || state === "complete";
          if (args.state === "load") return state === "complete";
          const network = session.tab!.network!.diagnostics();
          if (network.pending || network.requests !== requests || state !== "complete") idleSince = Date.now();
          requests = network.requests;
          return !network.pending && Date.now() - idleSince >= 500;
        }, args.waitTimeoutMs);
        return info(session);
      }
      case "browser_get_text": return pageOperation(session, "text", target(session, args.selector));
      case "browser_get_url": return current(session).evaluate("location.href");
      case "browser_get_title": return current(session).evaluate("document.title");
      case "browser_status": return session.tab?.page ? { open: true, tab: session.tab.id, tabs: session.tabs.size, ...session.tab.page.status() } : { open: false };
      case "browser_tab_new": {
        const url = normalizeBrowserUrl(args.url || "about:blank");
        if (url !== "about:blank") checkBrowserDomain(browserUrl(url), session.policy.allowedDomains);
        newTab(session, args.label); await navigate(session, url); await finish(session, false); return listTabs(session);
      }
      case "browser_tab_list": return listTabs(session);
      case "browser_tab_switch": session.tab = resolveTab(session, args.tab); return listTabs(session);
      case "browser_tab_close": await closeTab(session, resolveTab(session, args.tab)); return listTabs(session);
      case "browser_eval": return evaluate(session, args.script);
      case "browser_close":
        if (args.all) { for (const item of sessions.values()) if (item.namespace === session.namespace) await closeSession(item); }
        else await closeSession(session);
        return { open: false };
    }
  }
  async function call(params: CallToolRequest["params"]): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let session: Session | undefined;
    try {
      if (!Object.hasOwn(browserSchemas, params.name)) throw new Error("Unknown browser tool: " + params.name);
      const name = params.name as ToolName;
      const args = browserSchemas[name].parse(params.arguments || {});
      const call = { name, args } as ToolCall;
      session = getSession(args.namespace, args.session);
      if (args.allowedDomains) session.policy.allowedDomains = args.allowedDomains;
      const controller = new AbortController();
      session.policy.signal = controller.signal;
      timer = setTimeout(function timeout() { controller.abort(new Error("Tool timed out after " + args.timeoutMs + "ms")); }, args.timeoutMs);
      session.tab?.page?.begin();
      const result = await execute(session, call);
      controller.signal.throwIfAborted();
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof WebAssembly.RuntimeError || /instruction budget|interrupted|out of memory|WASM runtime failed|Cloudflare could not finish/i.test(message)) await closeAll();
      else if (session?.policy.signal?.aborted && session.runningTab && session.tabs.has(session.runningTab.id)) await closeTab(session, session.runningTab);
      return { isError: true, content: [{ type: "text", text: message }] };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (session) { session.policy.signal = undefined; session.runningTab = undefined; }
    }
  }
  function callTool(params: CallToolRequest["params"]) {
    const result = pending.then(function run() { return call(params); });
    pending = result.catch(function recover() {});
    return result;
  }
  return {
    async listTools() { return { tools: browserToolDefinitions }; },
    callTool,
    async close() { await pending; await closeAll(); },
  };
}

import type { BrowserTab } from "../.wrangler/browser/kitesurf_browser.js";
import type { BrowserNetwork } from "./browser-network.ts";
import { browserUserAgent } from "./browser-stealth.ts";

export type BrowserPage = ReturnType<typeof createBrowserPage>;
export type PageResources = {
  Tab: typeof BrowserTab;
  memory: WebAssembly.Memory;
  network: BrowserNetwork;
  url: string;
  html: string;
  isFaulted?: () => boolean;
  onFault?: () => void;
};

/** The Worker supplies platform APIs and network I/O; the browser and guest callbacks stay in Rust. */
export function createBrowserPage(resources: PageResources) {
  const { network, url } = resources;
  let disposed = false;
  let nativeFault = false;
  let asynchronousError: unknown;
  const pending = new Set<Promise<void>>();
  const tab = invoke(function createTab() { return new resources.Tab(resources.html, url, platform); });

  function invoke<T>(operation: () => T): T {
    if (disposed) throw new Error("Page is closed");
    if (nativeFault || resources.isFaulted?.()) throw new Error("Browser WASM runtime failed; page closed");
    if (asynchronousError) throw asynchronousError;
    try { return operation(); }
    catch (error) {
      if (error instanceof WebAssembly.RuntimeError) { nativeFault = true; resources.onFault?.(); }
      throw error;
    }
  }
  function platform(name: string, serialized: string): string {
    const args = JSON.parse(serialized);
    let result: unknown;
    switch (name) {
      case "op_get_cookies": result = network.cookies(url); break;
      case "op_set_cookie": network.setCookie(args[0], url); break;
      case "op_random_bytes": result = Array.from(crypto.getRandomValues(new Uint8Array(Math.min(65536, Math.max(0, args[0]))))); break;
      case "op_encoding_for_label": result = new TextDecoder(args[0]).encoding; break;
      case "op_text_decode":
        try { result = JSON.stringify({ ok: true, v: new TextDecoder(args[0], { fatal: args[2], ignoreBOM: args[3] }).decode(Uint8Array.from(Object.values(args[1]) as number[])) }); }
        catch (error) { result = JSON.stringify({ ok: false, e: String(error) }); }
        break;
      case "op_url_resolve": try { result = new URL(args[0], args[1] || undefined).href; } catch { result = ""; } break;
      case "op_url_parse":
        try {
          const parsed = new URL(args[0], args[1] || undefined);
          result = JSON.stringify({ ok: true, href: parsed.href, protocol: parsed.protocol, host: parsed.host, hostname: parsed.hostname, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, port: parsed.port, origin: parsed.origin, username: parsed.username, password: parsed.password });
        } catch { result = '{"ok":false}'; }
        break;
      case "op_url_set": {
        if (!["href", "protocol", "host", "hostname", "pathname", "search", "hash", "port", "username", "password"].includes(args[1])) throw new Error("Invalid URL property");
        const parsed = new URL(args[0]);
        (parsed as unknown as Record<string, string>)[args[1]] = args[2];
        result = JSON.parse(platform("op_url_parse", JSON.stringify([parsed.href, ""])));
        break;
      }
      case "op_intl": {
        const [kind, constructorArgs, method, params] = args;
        if (!["PluralRules", "NumberFormat", "DateTimeFormat", "Collator", "RelativeTimeFormat", "ListFormat", "DisplayNames"].includes(kind) ||
            !["supportedLocalesOf", "select", "selectRange", "format", "formatToParts", "compare", "resolvedOptions", "formatRange", "formatRangeToParts", "of"].includes(method)) throw new Error("Unsupported Intl operation");
        const constructor = (Intl as unknown as Record<string, { new (...args: unknown[]): Record<string, (...args: unknown[]) => unknown>; supportedLocalesOf(...args: unknown[]): unknown }>)[kind];
        result = JSON.stringify(method === "supportedLocalesOf" ? constructor.supportedLocalesOf(...JSON.parse(params)) : new constructor(...JSON.parse(constructorArgs))[method](...JSON.parse(params)));
        break;
      }
      default: throw new Error("Unsupported platform operation: " + name);
    }
    return JSON.stringify(result ?? null);
  }
  function dispatchRequests() {
    const requests = JSON.parse(invoke(function requests() { return tab.requests(); })) as { id: number; url?: string; args?: unknown[] }[];
    for (const request of requests) {
      async function download() {
        let response: string;
        let failed = false;
        try {
          const args = request.args as [string, string, string, Record<string, number>, string, string, string] | undefined;
          const result = args ? await network.download(args[0], {
            method: args[1], headers: JSON.parse(args[2]), body: Uint8Array.from(Object.values(args[3] || {})), origin: args[4], mode: args[5], credentials: args[6],
          }) : await network.download(request.url!);
          response = JSON.stringify(result);
        } catch (error) { response = String(error); failed = true; }
        if (!disposed && !nativeFault && !resources.isFaulted?.()) invoke(function respond() { tab.respond(request.id, response, failed); });
      }
      const task = download().catch(function failed(error: unknown) { asynchronousError = error; }).finally(function completed() { pending.delete(task); });
      pending.add(task);
    }
  }
  async function settle(milliseconds = 1500) {
    const deadline = Date.now() + milliseconds;
    let quietSince = Date.now();
    do {
      const state = JSON.parse(invoke(function step() { return tab.step(); })) as { ran: boolean; pending: number; jobs: boolean; ready: boolean };
      dispatchRequests();
      if (state.ran || state.pending || state.jobs || !state.ready) quietSince = Date.now();
      if (!pending.size && !state.pending && !state.jobs && state.ready && Date.now() - quietSince >= 100) return;
      await new Promise<void>(function tick(resolve) { setTimeout(resolve, 10); });
    } while (Date.now() < deadline);
  }
  return {
    async start() { invoke(function start() { tab.start(browserUserAgent); }); await settle(15_000); },
    evaluate(expression: string): unknown { return JSON.parse(invoke(function evaluate() { return tab.evaluate(expression); })); },
    snapshot(): unknown { return JSON.parse(invoke(function snapshot() { return tab.snapshot(); })); },
    settle,
    begin() { invoke(function begin() { tab.begin(); }); },
    takeNavigation() { return JSON.parse(invoke(function navigation() { return tab.take_navigation(); })) as { url: string; method: string; body: string } | undefined; },
    status() {
      return { ...JSON.parse(invoke(function status() { return tab.status(); })), network: network.diagnostics(), wasmMemoryBytes: { browser: resources.memory.buffer.byteLength } };
    },
    async close() {
      if (disposed) return;
      disposed = true;
      network.close();
      await Promise.allSettled([...pending]);
      if (!nativeFault && !resources.isFaulted?.()) tab.close();
    },
  };
}

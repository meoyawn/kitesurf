import { createBindings } from "../.wrangler/browser/factory.js";
import { createBrowserPage } from "./browser-runtime.ts";
import type { BrowserNetwork } from "./browser-network.ts";

/** Tabs have separate DOM/QuickJS runtimes and share one bounded WASM heap per browser. */
export function createPageFactory(module: WebAssembly.Module) {
  type Pool = { bindings: ReturnType<typeof createBindings>; memory: WebAssembly.Memory; tabs: number; failed: boolean };
  const pools = new WeakMap<object, Pool>();
  return async function createPage(url: string, html: string, network: BrowserNetwork, browser: object = network) {
    let pool = pools.get(browser);
    if (!pool) {
      const bindings = createBindings();
      pool = { bindings, memory: bindings.initSync({ module }).memory, tabs: 0, failed: false };
      pools.set(browser, pool);
    }
    const owner = pool;
    let page;
    try {
      page = createBrowserPage({
        Tab: owner.bindings.BrowserTab, memory: owner.memory, network, url, html,
        isFaulted() { return owner.failed; },
        onFault() { owner.failed = true; },
      });
    } catch (error) { if (!owner.tabs) pools.delete(browser); throw error; }
    owner.tabs++;
    let closed = false;
    const dispose = page.close;
    page.close = async function close() {
      if (closed) return;
      closed = true;
      try { await dispose(); }
      finally { if (--owner.tabs === 0) pools.delete(browser); }
    };
    return page;
  };
}

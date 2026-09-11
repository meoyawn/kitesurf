import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createBrowserTools } from "../src/browser-tools.ts";
import { makePage } from "./browser-fixture.ts";

type Browser = ReturnType<typeof createBrowserTools>;
async function call(browser: Browser, name: string, args: Record<string, unknown> = {}) {
  const result = await browser.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent?.result;
}
async function failure(browser: Browser, name: string, args: Record<string, unknown>, pattern: RegExp) {
  const result = await browser.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), pattern);
}

describe("layout and JavaScript MCP surface", function suite() {
  test("catalog excludes unsupported engines and validates advertised schemas", async function catalog() {
    let pages = 0;
    const browser = createBrowserTools(async function page(...args) { pages++; return makePage(...args); });
    try {
      const tools = (await browser.listTools()).tools;
      assert.equal(tools.length, 26);
      assert.equal(pages, 0);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.ok(tool.inputSchema.properties?.timeoutMs);
        assert.doesNotMatch(tool.name, /screenshot|paint|pdf|record|chat|press|keyboard|type$|back$|forward$/);
      }
      assert.ok(tools.find(tool => tool.name === "browser_fill")?.inputSchema.required?.includes("selector"));
      await failure(browser, "browser_press", { key: "Enter" }, /Unknown/);
      await failure(browser, "browser_open", { url: "example.test", headed: true }, /Unrecognized/);
      await failure(browser, "browser_fill", { selector: "#name" }, /Required/);
      await call(browser, "browser_tools_profiles");
      await call(browser, "browser_tab_list");
      assert.equal(pages, 0);
    } finally { await browser.close(); }
  });

  test("opens blank and HTTP pages, reloads, and reads current SPA URL and title", async function open() {
    let requests = 0;
    const browser = createBrowserTools(makePage, async function fixture() { requests++; return new Response("<title>Form</title><h1>Page</h1>"); });
    try {
      assert.deepEqual(await call(browser, "browser_open"), { url: "about:blank", title: "" });
      assert.equal(requests, 0);
      assert.deepEqual(await call(browser, "browser_open", { url: "example.test" }), { url: "https://example.test/", title: "Form" });
      await call(browser, "browser_eval", { script: "history.pushState({}, '', '/updated'); document.title = 'Updated'" });
      assert.equal(await call(browser, "browser_get_url"), "https://example.test/updated");
      assert.equal(await call(browser, "browser_get_title"), "Updated");
      await call(browser, "browser_open");
      assert.equal(await call(browser, "browser_get_title"), "Updated");
      await call(browser, "browser_reload");
      assert.equal(requests, 2);
      assert.equal(await call(browser, "browser_get_text", { selector: "h1" }), "Page");
    } finally { await browser.close(); }
  });

  test("snapshots scope and filter accessible elements with stable, stale-safe refs", async function refs() {
    const browser = createBrowserTools(makePage, async function fixture() {
      return new Response("<title>Refs</title><h1>Title</h1><main><label for='name'>Name</label><input id='name'><button id='save'>Save</button><a href='/next'>Next</a><div style='display:none'><button>Hidden</button></div></main><aside><button>Outside</button></aside>");
    });
    try {
      await call(browser, "browser_open", { url: "https://example.test" });
      const snapshot = await call(browser, "browser_snapshot", { selector: "main", includeUrls: true }) as { snapshot: string; refs: Record<string, { name: string }> };
      assert.match(snapshot.snapshot, /textbox "Name"/);
      assert.match(snapshot.snapshot, /https:\/\/example.test\/next/);
      assert.doesNotMatch(snapshot.snapshot, /Hidden|Outside|heading/);
      const input = Object.entries(snapshot.refs).find(entry => entry[1].name === "Name")![0];
      assert.deepEqual(await call(browser, "browser_snapshot", { selector: "main", includeUrls: true }), snapshot);
      await call(browser, "browser_fill", { selector: "@" + input, text: "Alice" });
      assert.equal(await call(browser, "browser_eval", { script: "document.querySelector('input').value" }), "Alice");
      const full = await call(browser, "browser_snapshot", { interactive: false, compact: true, depth: 1 }) as { snapshot: string };
      assert.match(full.snapshot, /heading "Title"/);
      assert.doesNotMatch(full.snapshot, /button/);
      await call(browser, "browser_open", { url: "https://example.test/next" });
      await failure(browser, "browser_fill", { selector: "@" + input, text: "wrong" }, /stale reference/);
      await failure(browser, "browser_click", { selector: "button" }, /multiple/);
      await failure(browser, "browser_fill", { selector: "body", text: "wrong" }, /not editable/);
    } finally { await browser.close(); }
  });

  test("existing DOM activation supports fill, check, uncheck, select and link tabs", async function controls() {
    const browser = createBrowserTools(makePage, async function fixture() {
      return new Response("<input id='name'><input id='check' type='checkbox'><input id='disabled' disabled><select id='choice' multiple><option value='a'>Alpha</option><option value='b'>Beta</option></select><a href='/new'>New</a><script>const events=[];document.querySelector('#name').oninput=e=>events.push(e.target.value);document.querySelector('#check').onchange=e=>events.push(e.target.checked)</script>");
    });
    try {
      await call(browser, "browser_open", { url: "https://example.test" });
      await call(browser, "browser_fill", { selector: "#name", text: "test" });
      await call(browser, "browser_check", { selector: "#check" });
      await call(browser, "browser_check", { selector: "#check" });
      await call(browser, "browser_uncheck", { selector: "#check" });
      assert.deepEqual(await call(browser, "browser_eval", { script: "events" }), ["test", true, false]);
      assert.deepEqual(await call(browser, "browser_select", { selector: "#choice", values: ["Alpha", "b"] }), { values: ["a", "b"] });
      assert.deepEqual(await call(browser, "browser_eval", { script: "Array.from(document.querySelectorAll('option')).map(o=>o.selected)" }), [true, true]);
      await failure(browser, "browser_fill", { selector: "#disabled", text: "x" }, /disabled/);
      await failure(browser, "browser_select", { selector: "#choice", values: ["missing"] }, /missing/);
      await call(browser, "browser_click", { selector: "a", newTab: true });
      const tabs = await call(browser, "browser_tab_list") as { tabs: unknown[] };
      assert.equal(tabs.tabs.length, 2);
      assert.equal(await call(browser, "browser_get_url"), "https://example.test/new");
    } finally { await browser.close(); }
  });

  test("URL reads negotiate Markdown, llms ancestors and HTML without executing scripts", async function reads() {
    const requested: string[] = [];
    const browser = createBrowserTools(makePage, async function fixture(input) {
      const url = new URL(String(input)); requested.push(url.pathname);
      if (url.pathname.endsWith("llms.txt")) return new Response("# Docs\n- [Guide](guide.md)\n- [API](api.md)", { headers: { "content-type": "text/plain" } });
      if (url.pathname.endsWith("llms-full.txt")) return new Response("# Intro\nHello\n# API\nUse this API", { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/guide.md") return new Response("# Intro\nHello\n## Auth\nUse tokens", { headers: { "content-type": "text/markdown" } });
      if (url.pathname.endsWith(".md")) return new Response("", { status: 404 });
      return new Response("<title>HTML</title><main><h1>Intro</h1><p>A &amp; B</p><h2>Auth</h2><p>Tokens</p><script>fetch('/must-not-run');document.title='Executed'</script></main>", { headers: { "content-type": "text/html" } });
    });
    try {
      const guide = await call(browser, "browser_read", { url: "example.test/guide", outline: true }) as { content: string; source: string };
      assert.equal(guide.source, "markdown"); assert.equal(guide.content, "# Intro\n\n## Auth");
      const html = await call(browser, "browser_read", { url: "example.test/page", filter: "Intro" }) as { content: string; title: string };
      assert.equal(html.title, "HTML"); assert.match(html.content, /A & B/); assert.doesNotMatch(html.content, /must-not-run/);
      assert.ok(!requested.includes("/must-not-run"));
      assert.deepEqual(await call(browser, "browser_tab_list"), { tabs: [] });
      const index = await call(browser, "browser_read", { url: "example.test/docs/page", llms: "index", filter: "API" }) as { content: string };
      assert.match(index.content, /API/); assert.doesNotMatch(index.content, /Guide/);
      const full = await call(browser, "browser_read", { url: "example.test/docs/page", llms: "full", filter: "API" }) as { content: string };
      assert.match(full.content, /Use this API/); assert.doesNotMatch(full.content, /Hello/);
      await failure(browser, "browser_read", { url: "example.test/page", requireMd: true }, /requires Content-Type/);
      const raw = await call(browser, "browser_read", { url: "example.test/page", raw: true }) as { content: string };
      assert.match(raw.content, /<script>/);
    } finally { await browser.close(); }
  });

  test("waits and async evaluation process real guest tasks and recover after timeout", async function waits() {
    const browser = createBrowserTools(makePage, async function fixture() { return new Response("<p id='out'>initial</p><div style='height:3000px;width:3000px'></div>"); });
    try {
      await call(browser, "browser_open", { url: "https://example.test" });
      assert.equal(await call(browser, "browser_eval", { script: "new Promise(resolve=>setTimeout(()=>resolve(42),40))" }), 42);
      await failure(browser, "browser_eval", { script: "Promise.reject(new Error('failed'))" }, /failed/);
      await call(browser, "browser_eval", { script: "setTimeout(()=>document.querySelector('#out').textContent='ready',80)" });
      await call(browser, "browser_wait_for_text", { text: "ready", waitTimeoutMs: 1000 });
      await call(browser, "browser_wait_for_selector", { selector: "#out", waitTimeoutMs: 100 });
      await call(browser, "browser_wait_for_function", { expression: "document.querySelector('#out').textContent === 'ready'" });
      for (const state of ["load", "domcontentloaded", "networkidle"]) await call(browser, "browser_wait_for_load", { state });
      const start = Date.now(); await call(browser, "browser_wait_ms", { ms: 80 }); assert.ok(Date.now() - start >= 75);
      await call(browser, "browser_scroll", { direction: "down", amount: 200 });
      await call(browser, "browser_scroll", { direction: "right", amount: 150 });
      assert.deepEqual(await call(browser, "browser_eval", { script: "[scrollX,scrollY]" }), [150, 200]);
      await failure(browser, "browser_wait_for_selector", { selector: "#missing", waitTimeoutMs: 20 }, /Timed out/);
      assert.equal(await call(browser, "browser_get_text", { selector: "#out" }), "ready");
      await failure(browser, "browser_eval", { script: "new Promise(()=>{})", timeoutMs: 40 }, /timed out/);
      assert.deepEqual(await call(browser, "browser_status"), { open: false });
      await call(browser, "browser_open");
    } finally { await browser.close(); }
  });

  test("sessions isolate cookies and tabs while sharing a bounded heap", async function sessions() {
    const cookies: string[] = [];
    const browser = createBrowserTools(makePage, async function fixture(_input, init) { cookies.push(new Headers(init?.headers).get("cookie") || ""); return new Response("<p>tab</p>"); });
    try {
      await call(browser, "browser_open", { url: "example.test" });
      await call(browser, "browser_eval", { script: "document.cookie='a=one; Path=/'" });
      await call(browser, "browser_tab_new", { url: "example.test/two", label: "two" });
      assert.equal(cookies.at(-1), "a=one");
      const first = await call(browser, "browser_status") as { wasmMemoryBytes: unknown };
      await call(browser, "browser_open", { session: "other", url: "example.test/other" });
      assert.equal(cookies.at(-1), "");
      const other = await call(browser, "browser_status", { session: "other" }) as { wasmMemoryBytes: unknown };
      const shared = await call(browser, "browser_status") as typeof first;
      assert.deepEqual(other.wasmMemoryBytes, shared.wasmMemoryBytes);
      await call(browser, "browser_tab_switch", { tab: "two" });
      await failure(browser, "browser_tab_new", { label: "two" }, /unique/);
      await call(browser, "browser_tab_close");
      assert.equal(await call(browser, "browser_get_url"), "https://example.test/");
      await call(browser, "browser_close", { all: true });
      assert.deepEqual(await call(browser, "browser_status", { session: "other" }), { open: false });
    } finally { await browser.close(); }
  });

  test("a cancelled new tab leaves existing tabs usable and drains the action queue", async function cancellation() {
    const browser = createBrowserTools(makePage, async function fixture(input) {
      if (String(input).endsWith("/hang")) return new Response(new ReadableStream());
      return new Response("<title>Kept</title><p>content</p>");
    });
    try {
      await call(browser, "browser_open", { url: "example.test" });
      await failure(browser, "browser_tab_new", { url: "example.test/hang", timeoutMs: 30 }, /timed out/);
      assert.equal(await call(browser, "browser_get_title"), "Kept");
      assert.equal((await call(browser, "browser_tab_list") as { tabs: unknown[] }).tabs.length, 1);
      await failure(browser, "browser_read", { url: "example.test/hang", readTimeoutMs: 30 }, /timed out/);
      assert.equal(await call(browser, "browser_get_title"), "Kept");
      await failure(browser, "browser_eval", { script: "Promise.reject('')" }, /promise rejected/);
      assert.deepEqual(await call(browser, "browser_eval", { script: "Object.getOwnPropertyNames(globalThis).filter(name=>name.startsWith('__kitesurf_eval_'))" }), []);
    } finally { await browser.close(); }
  });
});

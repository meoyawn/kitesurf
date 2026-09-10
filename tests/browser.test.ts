import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createBrowserTools } from "../src/browser-tools.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makePage } from "./browser-fixture.ts";
import { mcpFetch } from "../src/mcp.ts";
import { browserUserAgent } from "../src/browser-stealth.ts";

function value(result: CallToolResult) {
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent?.result;
}

describe("Worker browser runtime", function suite() {
  test("native UTF-8 decoding preserves byte ranges, replacement, BOM and fallback encodings", async function decoding() {
    const browser = createBrowserTools(makePage, async function fixture() { return new Response("<title>Encoding</title>"); });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const decoded = value(await browser.callTool({ name: "browser_evaluate", arguments: { expression:
        "(()=>{const bytes=new Uint8Array([0xff,0xef,0xbb,0xbf,0xd0,0xaf,0xf0,0x9f,0x98,0x80,0xff]);const view=bytes.subarray(1,10);let fatal=false;try{new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch(e){fatal=e instanceof TypeError}return{unicode:new TextDecoder().decode(view),bom:new TextDecoder('utf-8',{ignoreBOM:true}).decode(view).charCodeAt(0),replacement:new TextDecoder().decode(new Uint8Array([0xff,65])),empty:new TextEncoder().encode().length,encoded:[...new TextEncoder().encode('Я😀')],unpaired:[...new TextEncoder().encode(String.fromCharCode(0xd800))],fatal,legacy:new TextDecoder('windows-1251').decode(new Uint8Array([0xdf])),large:new TextDecoder().decode(new Uint8Array(1024*1024).fill(65)).length}})()",
      } }));
      assert.deepEqual(decoded, { unicode: "Я😀", bom: 0xfeff, replacement: "�A", empty: 0, encoded: [208, 175, 240, 159, 152, 128], unpaired: [239, 191, 189], fatal: true, legacy: "Я", large: 1024 * 1024 });
    } finally { await browser.close(); }
  });

  test("tabs retain independent DOMs and release a shared browser heap on close", async function tabs() {
    const browser = createBrowserTools(makePage, async function fixture(input) {
      return new Response("<title>" + new URL(String(input)).pathname + "</title>");
    });
    async function call(name: string, args = {}) { return value(await browser.callTool({ name, arguments: args })); }
    try {
      await call("browser_navigate", { url: "https://example.test/first" });
      await call("browser_evaluate", { expression: "globalThis.counter=7" });
      const opened = await call("browser_tabs", { action: "new", url: "https://example.test/second" }) as { tabs: { id: number; selected: boolean }[] };
      assert.equal(opened.tabs.length, 2);
      assert.equal(opened.tabs[1].selected, true);
      assert.equal(await call("browser_evaluate", { expression: "typeof counter" }), "undefined");
      const second = await call("browser_status") as { wasmMemoryBytes: unknown };
      await call("browser_tabs", { action: "select", id: opened.tabs[0].id });
      assert.equal(await call("browser_evaluate", { expression: "counter" }), 7);
      const first = await call("browser_status") as { wasmMemoryBytes: unknown };
      assert.deepEqual(first.wasmMemoryBytes, second.wasmMemoryBytes);
      await call("browser_tabs", { action: "close", id: opened.tabs[0].id });
      assert.equal(await call("browser_evaluate", { expression: "document.title" }), "/second");
      await call("browser_close");
      assert.deepEqual(await call("browser_tabs", { action: "list" }), { tabs: [] });
      await call("browser_navigate", { url: "https://example.test/fresh" });
      assert.equal(await call("browser_evaluate", { expression: "document.title" }), "/fresh");
    } finally { await browser.close(); }
  });

  test("stealth enables upstream fingerprint settings and blocks tracker subdomains", async function stealth() {
    const requests: { url: string; ua: string | null }[] = [];
    const browser = createBrowserTools(makePage, async function fixture(input, init) {
      requests.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
      return new Response("<script>let tracker='pending';fetch('https://www.google-analytics.com/collect').then(()=>tracker='loaded',()=>tracker='blocked')</script>");
    });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const fingerprint = value(await browser.callTool({ name: "browser_evaluate", arguments: { expression:
        "({ua:navigator.userAgent,webdriver:navigator.webdriver,hw:navigator.hardwareConcurrency,memory:navigator.deviceMemory,tracker,masked:setTimeout.toString().includes('[native code]'),leaks:Object.keys(globalThis).filter(key=>key.startsWith('__obscura_'))})",
      } })) as { ua: string; webdriver: boolean; hw: number; memory: number; tracker: string; masked: boolean; leaks: string[] };
      assert.equal(fingerprint.ua, browserUserAgent);
      assert.equal(fingerprint.webdriver, false);
      assert.ok([4, 6, 8, 12, 16].includes(fingerprint.hw));
      assert.ok([4, 8].includes(fingerprint.memory));
      assert.equal(fingerprint.tracker, "blocked");
      assert.equal(fingerprint.masked, true);
      assert.deepEqual(fingerprint.leaks, []);
      assert.deepEqual(requests, [{ url: "https://example.test/", ua: browserUserAgent }]);
    } finally { await browser.close(); }
  });

  test("real script, event, fetch and DOM mutation survive MCP reconnect", async function scroll() {
    const html = "<title>Jobs</title><style>li{height:64px}</style><ol>" + Array.from({ length: 20 }, (_, i) => "<li class='vacancy'>Job " + (i + 1) + "</li>").join("") +
      "</ol><div id='sentinel'></div><footer style='height:2000px'></footer><script>let loaded=false;new IntersectionObserver(async entries=>{if(loaded||!entries.some(e=>e.isIntersecting))return;loaded=true;const jobs=await(await fetch('/next')).json();for(const job of jobs){const el=document.createElement('li');el.setAttribute('class','vacancy');el.textContent=job;document.querySelector('ol').appendChild(el);}}).observe(document.querySelector('#sentinel'))</script>";
    const requested: string[] = [];
    const browser = createBrowserTools(makePage, async function fixture(input) {
      const url = String(input);
      requested.push(url);
      return url.endsWith("/next") ? Response.json(["Job 21"]) : new Response(html);
    });
    async function rpc(name: string, args = {}) {
      const response = await mcpFetch(new Request("https://mcp.example/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }), browser);
      const body = await response.json() as { result: CallToolResult };
      return value(body.result);
    }
    try {
      assert.equal((await browser.listTools()).tools.length, 10);
      assert.equal(requested.length, 0);
      await rpc("browser_navigate", { url: "https://jobs.example/" });
      assert.equal(await rpc("browser_evaluate", { expression: "document.querySelectorAll('.vacancy').length" }), 20);
      assert.deepEqual(requested, ["https://jobs.example/"]);
      await rpc("browser_scroll", { bottom: true });
      await rpc("browser_wait_for", { expression: "document.querySelectorAll('.vacancy').length===21" });
      assert.equal(await rpc("browser_evaluate", { expression: "document.querySelectorAll('.vacancy').length" }), 21);
      assert.deepEqual(requested, ["https://jobs.example/", "https://jobs.example/next"]);
      assert.equal(await rpc("browser_evaluate", { expression: "typeof process + ':' + typeof require" }), "undefined:undefined");
    } finally { await browser.close(); }
  });

  test("DOM bridge preserves NUL separators, namespaces, fragments and script state", async function dom() {
    const browser = createBrowserTools(makePage, async function fixture() {
      return new Response("<div id='root'></div><script>globalThis.runs=0;setTimeout(()=>clearTimeout(cancelled),0);const cancelled=setTimeout(()=>runs++,0);</script>");
    });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const result = value(await browser.callTool({ name: "browser_evaluate", arguments: { expression:
        "(()=>{const root=document.querySelector('#root');root.innerHTML='<a href=\"/job\" class=\"vacancy\">Job</a><script>runs++<\\/script>';const link=root.firstChild;link.setAttribute('id','job');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href','#x');root.appendChild(svg);return{href:document.getElementById('job').href,cls:link.className,ns:svg.namespaceURI,attr:svg.getAttributeNS('http://www.w3.org/1999/xlink','href'),runs}})()",
      } }));
      assert.deepEqual(result, { href: "https://example.test/job", cls: "vacancy", ns: "http://www.w3.org/2000/svg", attr: "#x", runs: 0 });
    } finally { await browser.close(); }
  });

  test("CSS variable inheritance and updates survive releasing retained cascade maps", async function variables() {
    const browser = createBrowserTools(makePage, async function fixture() {
      return new Response("<style>:root{--width:180px;--height:30px}main{--width:240px}div{width:var(--width);height:var(--height)}</style><main><div id='box'></div></main>");
    });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const initial = value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "(()=>{const r=document.querySelector('#box').getBoundingClientRect();return [r.width,r.height]})()" } }));
      assert.deepEqual(initial, [240, 30]);
      const updated = value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "(()=>{document.querySelector('main').style.setProperty('--width','320px');document.documentElement.style.setProperty('--height','45px');const r=document.querySelector('#box').getBoundingClientRect();return [r.width,r.height]})()" } }));
      assert.deepEqual(updated, [320, 45]);
    } finally { await browser.close(); }
  });

  test("dynamic scripts, input events and cookies work across navigation", async function interaction() {
    const sentCookies: string[] = [];
    const browser = createBrowserTools(makePage, async function fixture(input, init) {
      const url = String(input);
      sentCookies.push(new Headers(init?.headers).get("cookie") || "");
      if (url.endsWith("/dynamic.js")) return new Response("document.querySelector('#out').textContent='loaded'");
      if (url.endsWith("/next")) return new Response("<title>Next</title>");
      return new Response("<title>Form</title><input id='name'><p id='out'></p><a href='/next'>Next</a><script>document.querySelector('input').addEventListener('input',e=>document.querySelector('#out').textContent=e.target.value);const s=document.createElement('script');s.src='/dynamic.js';document.head.appendChild(s);</script>", { headers: { "set-cookie": "session=secret; HttpOnly; Path=/" } });
    });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      assert.equal(value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "document.querySelector('#out').textContent" } })), "loaded");
      value(await browser.callTool({ name: "browser_fill", arguments: { selector: "#name", text: "Alice" } }));
      assert.equal(value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "document.querySelector('#out').textContent" } })), "Alice");
      assert.equal(value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "document.cookie" } })), "");
      value(await browser.callTool({ name: "browser_click", arguments: { selector: "a" } }));
      assert.equal(value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "document.title" } })), "Next");
      assert.equal(sentCookies.at(-1), "session=secret");
    } finally { await browser.close(); }
  });

  test("actions serialize, failures recover, and close permits a fresh page", async function lifetime() {
    const browser = createBrowserTools(makePage, async function fixture() { return new Response("<title>Test</title><script>let count=0;</script>"); });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const results = await Promise.all([1, 2].map(function increment() {
        return browser.callTool({ name: "browser_evaluate", arguments: { expression: "++count" } });
      }));
      assert.deepEqual(results.map(value), [1, 2]);
      assert.equal((await browser.callTool({ name: "browser_click", arguments: { selector: "#missing" } })).isError, true);
      value(await browser.callTool({ name: "browser_close" }));
      assert.deepEqual(value(await browser.callTool({ name: "browser_status" })), { open: false });
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      assert.equal(value(await browser.callTool({ name: "browser_evaluate", arguments: { expression: "count" } })), 0);
    } finally { await browser.close(); }
  });

  test("unbounded page JavaScript is interrupted and its page released", async function interrupt() {
    const browser = createBrowserTools(makePage, async function fixture() { return new Response("<p>Test</p>"); });
    try {
      value(await browser.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } }));
      const failed = await browser.callTool({ name: "browser_evaluate", arguments: { expression: "(()=>{for(;;){} })()" } });
      assert.equal(failed.isError, true);
      assert.match(JSON.stringify(failed), /interrupted|instruction budget/);
      assert.deepEqual(value(await browser.callTool({ name: "browser_status" })), { open: false });
    } finally { await browser.close(); }
  }, 20_000);
});

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createPageFactory } from "../src/browser-factory.ts";
import { createBrowserTools } from "../src/browser-tools.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserPage } from "../src/browser-runtime.ts";

const directory = new URL("../.wrangler/browser-benchmark/", import.meta.url);
const replay = process.argv.includes("--replay");
const record = process.argv.includes("--record");
const scroll = process.argv.includes("--scroll");
const url = "https://yandex.ru/jobs/vacancies/city_kazan?profession=backend-developer&profession=system-developer&skills=74&skills=378&skills=64&skills=160&pro_levels=senior";
const wasm = new WebAssembly.Module(await readFile(new URL("../.wrangler/browser/kitesurf_browser_bg.wasm", import.meta.url)));
const makePage = createPageFactory(wasm);
let page: BrowserPage | undefined;
await mkdir(directory, { recursive: true });

async function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const key = createHash("sha256").update(request.method + " " + request.url).update(Buffer.from(await request.arrayBuffer())).digest("hex");
  const file = new URL(key + ".json", directory);
  if (replay) {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return new Response(saved.status === 204 || saved.status === 304 ? null : Buffer.from(saved.body, "base64"), saved);
  }
  const response = await fetch(input, init);
  if (record) {
    const body = Buffer.from(await response.arrayBuffer());
    const saved = { status: response.status, headers: [...response.headers], body: body.toString("base64") };
    await writeFile(file, JSON.stringify(saved));
    return new Response(response.status === 204 || response.status === 304 ? null : body, saved);
  }
  return response;
}

function result(response: CallToolResult) {
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent!.result as {
    elements: { tag: string; text: string; href?: string }[];
    refs: Record<string, { role: string; name: string }>;
    errors: string[];
    network: { requests: number; pending: number; events: { url: string; status: number }[] };
    wasmMemoryBytes: unknown;
    runtime: unknown;
    waits: unknown;
    waitTimings: unknown;
    timings: unknown;
  };
}

const browser = createBrowserTools(async function create(url, html, network, scope) {
  page = await makePage(url, html, network, scope);
  return page;
}, fetcher);
try {
  const started = performance.now();
  result(await browser.callTool({ name: "browser_open", arguments: { url } }));
  const navigationMs = Math.round(performance.now() - started);
  async function inspect() {
    return result(await browser.callTool({ name: "browser_eval", arguments: { script: "({elements:Array.from(document.querySelectorAll('a[href]')).map(el=>({tag:'a',text:el.textContent,href:el.href}))})" } }));
  }
  const before = await inspect();
  const jobs = (page: typeof before) => page.elements.filter(element => /\/jobs\/vacancies\/[^/?]+-\d+/.test(element.href || ""));
  assert.equal(jobs(before).length, 20);
  const snapshot = result(await browser.callTool({ name: "browser_snapshot" }));
  const button = Object.entries(snapshot.refs).find(entry => entry[1].role === "button" && entry[1].name.includes("Показать ещё"));
  assert.ok(button, "Load more button missing");
  const clicked = performance.now();
  if (scroll) {
    const height = await browser.callTool({ name: "browser_eval", arguments: { script: "Math.max(0,document.documentElement.scrollHeight-innerHeight)" } });
    assert.ok(!height.isError, JSON.stringify(height));
    const destination = Number(height.structuredContent!.result);
    for (let position = 0; position < destination; position += 576) result(await browser.callTool({ name: "browser_scroll", arguments: { direction: "down", amount: Math.min(576, destination - position) } }));
  } else result(await browser.callTool({ name: "browser_click", arguments: { selector: "@" + button[0] } }));
  const actionMs = Math.round(performance.now() - clicked);
  const after = await inspect();
  const status = result(await browser.callTool({ name: "browser_status" }));
  const report = { mode: replay ? "replay" : record ? "record" : "live", action: scroll ? "scroll" : "click", navigationMs, actionMs, before: jobs(before).length, after: jobs(after).length, requests: status.network.requests, pending: status.network.pending, wasmMemoryBytes: status.wasmMemoryBytes, runtime: status.runtime, waits: status.waits, waitTimings: status.waitTimings, timings: status.timings, errors: status.errors };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(new URL("last-result.json", directory), JSON.stringify(report, null, 2) + "\n");
  const traceEvents = page?.trace() || [];
  if (traceEvents.length) {
    traceEvents.push({ name: "navigate", cat: "action", ph: "X", pid: 1, tid: 4, ts: started * 1000, dur: navigationMs * 1000 });
    traceEvents.push({ name: scroll ? "scroll" : "click", cat: "action", ph: "X", pid: 1, tid: 4, ts: clicked * 1000, dur: actionMs * 1000 });
    for (const [tid, name] of [[1, "Rust / QuickJS / DOM / layout"], [2, "Worker → WASM"], [3, "Downloads"]]) {
      traceEvents.push({ name: "thread_name", ph: "M", pid: 1, tid, args: { name } });
    }
    await writeFile(new URL("trace.json", directory), JSON.stringify({ traceEvents, displayTimeUnit: "ms" }));
    console.log("Trace: .wrangler/browser-benchmark/trace.json (" + traceEvents.length + " events)");
  }
  assert.equal(jobs(after).length, 21, "The interaction must finish loading 21 openings without another wait call");
  assert.equal(new Set(jobs(after).map(job => job.href)).size, 21);
  assert.ok(jobs(before).every(job => jobs(after).some(next => next.href === job.href)));
  assert.ok(status.network.events.some(event => event.url.includes("cursor=") && event.status === 200));
  assert.ok(!status.errors.some(error => /subrequests|instruction budget/i.test(error)));
} finally {
  await browser.close();
}

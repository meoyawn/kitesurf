import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { manageBrowserLimits } from "../src/browser-limits.ts";
import type { BrowserTools } from "../src/mcp.ts";

describe("Cloudflare browser response preservation", function suite() {
  afterEach(() => vi.useRealTimers());

  test.each(["esm/cloudflare/browser-error.js", "cjs/cloudflare/browser-error.cjs"])("the installed %s patch retains limit evidence and excludes unrelated header values", async function providerError(file) {
    const moduleUrl = new URL("../" + file, import.meta.resolve("@cloudflare/playwright"));
    const { createBrowserLaunchError } = await import(moduleUrl.href);
    const error = createBrowserLaunchError(new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "Retry-After": "45", "Ratelimit-Policy": '"browser-launch";q=3;w=60',
        "X-Ratelimit-Remaining": "0", "CF-Ray": "example-ray",
        "Set-Cookie": "private-cookie", "Authorization": "private-token", "X-Internal-Host": "private-host",
      },
    }), "Rate limit exceeded");
    assert.equal(error.message, "Unable to create new browser: code: 429: message: Rate limit exceeded");
    assert.partialDeepStrictEqual(error.cause, {
      source: "cloudflare_browser_run", status: 429,
      headers: {
        "retry-after": "45", "ratelimit-policy": '"browser-launch";q=3;w=60',
        "x-ratelimit-remaining": "0", "cf-ray": "example-ray",
      },
    });
    assert.equal(Object.keys(error.cause.headers).length, 4);
    assert.ok(error.cause.headerNames.includes("set-cookie"));
    assert.doesNotMatch(JSON.stringify(error.cause), /private-cookie|private-token|private-host/);
  });

  test.each([
    { header: "45", expected: 45_000 },
    { header: "Wed, 09 Sep 2026 12:01:00 GMT", expected: 60_000 },
    { header: "unavailable", expected: null },
    { header: "-1", expected: null },
    { header: "99999999999999999999", expected: null },
  ])("an unknown launch failure passes Retry-After=$header to the LLM without inventing a limit", async function reportHeaders({ header, expected }) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const { createBrowserLaunchError } = await import(new URL("./cloudflare/browser-error.js", import.meta.resolve("@cloudflare/playwright")).href);
    const browser = {
      listTools: vi.fn<BrowserTools["listTools"]>().mockResolvedValue({ tools: [] }),
      callTool: vi.fn<BrowserTools["callTool"]>().mockRejectedValueOnce(createBrowserLaunchError(
        new Response("Rate limit exceeded", { status: 429, headers: { "Retry-After": header } }), "Rate limit exceeded",
      )),
    };
    const managed = manageBrowserLimits(browser, {
      async limits() {
        return { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
      },
      async history() { return []; },
    });
    const result = CallToolResultSchema.parse(await managed.callTool({ name: "browser_navigate" }));
    assert.equal(result.isError, true);
    assert.partialDeepStrictEqual(result.structuredContent, {
      browserLimit: {
        diagnosis: "unknown", limitsHit: [],
        upstreamResponse: { headers: { "retry-after": header }, retryAfterMs: expected },
        retry: { attempted: false },
      },
    });
    const diagnostic = result.content[1];
    assert.equal(diagnostic.type, "text");
    if (diagnostic.type !== "text") throw new Error("Missing text diagnostic");
    assert.deepEqual(JSON.parse(diagnostic.text.slice(diagnostic.text.indexOf("\n") + 1)), result.structuredContent?.browserLimit);
    assert.equal(browser.callTool.mock.calls.length, 1);
  });

  test("a longer upstream Retry-After prevents retrying before Cloudflare permits it", async function respectCooldown() {
    const browser = {
      listTools: vi.fn<BrowserTools["listTools"]>().mockResolvedValue({ tools: [] }),
      callTool: vi.fn<BrowserTools["callTool"]>().mockResolvedValue({
        isError: true, content: [{ type: "text", text: "Error: Unable to create new browser: code: 429: message: Rate limit exceeded" }],
        structuredContent: { cloudflareBrowserResponse: {
          source: "cloudflare_browser_run", status: 429, headers: { "retry-after": "90" }, headerNames: ["retry-after"],
        } },
      }),
    };
    const managed = manageBrowserLimits(browser, {
      async limits() {
        return { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 2_000 };
      },
      async history() { return []; },
    });
    const result = CallToolResultSchema.parse(await managed.callTool({ name: "browser_navigate" }));
    assert.partialDeepStrictEqual(result.structuredContent, {
      browserLimit: {
        limitsHit: [{ limit: "browser_launch_rate", retryAfterMs: 90_000 }],
        upstreamResponse: { retryAfterMs: 90_000 }, retry: { attempted: false },
      },
    });
    assert.equal(browser.callTool.mock.calls.length, 1);
  });

  test.each([
    { time: "2026-09-09T17:39:29Z", retryAfter: "22831", retryAt: "2026-09-10T00:00:00.000Z", suspected: { limit: "daily_browser_time", confidence: "inferred", evidence: "retry_after_utc_reset" } },
    { time: "2026-09-09T23:59:30Z", retryAfter: "30", retryAt: "2026-09-10T00:00:00.000Z", suspected: null },
    { time: "2026-09-09T17:39:29Z", retryAfter: "22800", retryAt: "2026-09-09T23:59:29.000Z", suspected: null },
  ])("a retry ending at $retryAt reports qualified daily-reset evidence", async function dailyResetEvidence({ time, retryAfter, retryAt, suspected }) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    const browser = {
      listTools: vi.fn<BrowserTools["listTools"]>().mockResolvedValue({ tools: [] }),
      callTool: vi.fn<BrowserTools["callTool"]>().mockResolvedValue({
        isError: true, content: [{ type: "text", text: "Error: Unable to create new browser: code: 429: message: Rate limit exceeded" }],
        structuredContent: { cloudflareBrowserResponse: {
          source: "cloudflare_browser_run", status: 429, headers: { "retry-after": retryAfter }, headerNames: ["retry-after"],
        } },
      }),
    };
    const managed = manageBrowserLimits(browser, {
      async limits() {
        return { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
      },
      async history() { return []; },
    });
    const result = CallToolResultSchema.parse(await managed.callTool({ name: "browser_navigate" }));
    assert.partialDeepStrictEqual(result.structuredContent, {
      browserLimit: { diagnosis: "unknown", limitsHit: [], suspectedLimit: suspected, upstreamResponse: { retryAt }, retry: { attempted: false } },
    });
    const diagnostic = result.content[1];
    if (diagnostic.type !== "text") throw new Error("Missing text diagnostic");
    if (suspected) assert.match(diagnostic.text, /suggests the daily browser-time allowance, but Cloudflare did not explicitly name/);
    assert.equal(browser.callTool.mock.calls.length, 1);
  });
});

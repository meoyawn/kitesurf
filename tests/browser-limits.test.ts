import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { ActiveSession, ClosedSession, LimitsResponse } from "@cloudflare/playwright";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { manageBrowserLimits } from "../src/browser-limits.ts";
import type { BrowserTools } from "../src/mcp.ts";

function fixture() {
  const browser = {
    listTools: vi.fn<BrowserTools["listTools"]>().mockResolvedValue({ tools: [] }),
    callTool: vi.fn<BrowserTools["callTool"]>().mockResolvedValue({ content: [{ type: "text", text: "Page loaded" }] }),
  };
  const account = {
    limits: vi.fn<() => Promise<LimitsResponse>>().mockResolvedValue({
      activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 20_000,
    }),
    history: vi.fn<() => Promise<ClosedSession[]>>().mockResolvedValue([]),
  };
  return { browser, account, managed: manageBrowserLimits(browser, account) };
}

function rejectedLaunch(reason = "Rate limit exceeded"): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: Unable to create new browser: code: 429: message: ${reason}` }] };
}

const resultText = (result: Awaited<ReturnType<BrowserTools["callTool"]>>) => CallToolResultSchema.parse(result).content
  .filter(item => item.type === "text").map(item => item.text).join("\n");

describe("Browser Run limits", function suite() {
  afterEach(() => vi.useRealTimers());

  test("discovery and status inspect limits and history without browser actions or session IDs", async function diagnostics() {
    const { browser, account, managed } = fixture();
    account.history.mockResolvedValue([{
      sessionId: "private-session", startTime: 1_000, endTime: 301_000, closeReason: 2, closeReasonText: "BrowserIdle",
    }]);
    const listed = await managed.listTools();
    assert.ok(listed.tools.some(tool => tool.name === "browser_status"));
    const result = CallToolResultSchema.parse(await managed.callTool({ name: "browser_status" }));
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent?.limits, {
      activeBrowsers: 0, maxConcurrentBrowsers: 3, allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 20_000,
    });
    assert.deepEqual(result.structuredContent?.recentSessions, [{
      startedAt: 1_000, endedAt: 301_000, durationSeconds: 300, closeReason: "BrowserIdle",
    }]);
    assert.match(resultText(result), /not a complete daily usage meter/);
    assert.doesNotMatch(resultText(result), /private-session/);
    assert.equal(browser.callTool.mock.calls.length, 0);
  });

  test("normal browser actions do not query account diagnostics", async function activeBrowser() {
    const { account, managed } = fixture();
    assert.equal(resultText(await managed.callTool({ name: "browser_click" })), "Page loaded");
    assert.equal(account.limits.mock.calls.length, 0);
    assert.equal(account.history.mock.calls.length, 0);
  });

  test("missing simulator fields use the sessions API and report unavailable history", async function localDiagnostics() {
    const { browser, account } = fixture();
    account.limits.mockResolvedValue(JSON.parse('{"maxConcurrentSessions":6,"allowedBrowserAcquisitions":6,"timeUntilNextAllowedBrowserAcquisition":0}'));
    account.history.mockResolvedValue(JSON.parse("{}").history);
    const sessions = vi.fn<() => Promise<ActiveSession[]>>().mockResolvedValue([{ sessionId: "local-session", startTime: 1_000 }]);
    const managed = manageBrowserLimits(browser, { ...account, sessions });
    const result = CallToolResultSchema.parse(await managed.callTool({ name: "browser_status" }));
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent?.limits, {
      activeBrowsers: 1, maxConcurrentBrowsers: 6, allowedBrowserAcquisitions: 6,
      timeUntilNextAllowedBrowserAcquisition: 0,
    });
    assert.equal(result.structuredContent?.recentSessions, null);
    assert.deepEqual(result.structuredContent?.errors, ["Recent session history could not be read."]);
    assert.doesNotMatch(resultText(result), /local-session/);
    assert.equal(browser.callTool.mock.calls.length, 0);
  });

  test("a rejected launch waits and retries before the next queued action", async function retryInOrder() {
    vi.useFakeTimers();
    const { browser, managed } = fixture();
    browser.callTool.mockResolvedValueOnce(rejectedLaunch());
    const navigation = managed.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });
    const click = managed.callTool({ name: "browser_click", arguments: { ref: "link" } });
    await vi.advanceTimersByTimeAsync(20_999);
    assert.deepEqual(browser.callTool.mock.calls.map(([params]) => params.name), ["browser_navigate"]);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(resultText(await navigation), "Page loaded");
    assert.equal(resultText(await click), "Page loaded");
    assert.deepEqual(browser.callTool.mock.calls.map(([params]) => params.name), [
      "browser_navigate", "browser_navigate", "browser_click",
    ]);
    assert.deepEqual(browser.callTool.mock.calls[0], browser.callTool.mock.calls[1]);
  });

  test("explicit daily exhaustion is reported without another launch", async function dailyQuota() {
    const { browser, account, managed } = fixture();
    browser.callTool.mockResolvedValueOnce(rejectedLaunch("Browser time limit exceeded for today"));
    const result = await managed.callTool({ name: "browser_navigate" });
    assert.match(resultText(result), /resets at the next UTC day/);
    assert.equal(browser.callTool.mock.calls.length, 1);
    assert.equal(account.limits.mock.calls.length, 0);
  });

  test("full account concurrency is reported without retrying or closing other browsers", async function concurrency() {
    const { browser, account, managed } = fixture();
    browser.callTool.mockResolvedValueOnce(rejectedLaunch());
    account.limits.mockResolvedValue({
      activeSessions: [{ id: "a" }, { id: "b" }, { id: "c" }], maxConcurrentSessions: 3,
      allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0,
    });
    const result = await managed.callTool({ name: "browser_navigate" });
    assert.match(resultText(result), /3\/3 active browsers/);
    assert.equal(browser.callTool.mock.calls.length, 1);
  });

  test("a persistent generic 429 stops after one retry and leaves the daily cause unknown", async function boundedRetry() {
    vi.useFakeTimers();
    const { browser, managed } = fixture();
    browser.callTool.mockImplementation(async () => rejectedLaunch());
    const pending = managed.callTool({ name: "browser_navigate" });
    await vi.advanceTimersByTimeAsync(21_000);
    const result = await pending;
    assert.match(resultText(result), /does not establish that the daily/);
    assert.equal(browser.callTool.mock.calls.length, 2);
    assert.equal(vi.getTimerCount(), 0);
    browser.callTool.mockResolvedValue({ content: [{ type: "text", text: "Closed" }] });
    assert.equal(resultText(await managed.callTool({ name: "browser_close" })), "Closed");
  });

  test("page errors, including website 429s, are never replayed", async function pageFailure() {
    const { browser, account, managed } = fixture();
    const result: CallToolResult = { isError: true, content: [{ type: "text", text: "page.click: website returned 429 Too many requests" }] };
    browser.callTool.mockResolvedValueOnce(result);
    assert.equal(await managed.callTool({ name: "browser_click" }), result);
    assert.equal(browser.callTool.mock.calls.length, 1);
    assert.equal(account.limits.mock.calls.length, 0);
  });

  test("unavailable account diagnostics preserve the launch error without retrying", async function unavailableLimits() {
    const { browser, account, managed } = fixture();
    browser.callTool.mockResolvedValueOnce(rejectedLaunch());
    account.limits.mockRejectedValue(new Error("unavailable"));
    const result = await managed.callTool({ name: "browser_navigate" });
    assert.match(resultText(result), /Unable to create new browser: code: 429/);
    assert.match(resultText(result), /Account limits could not be read/);
    assert.equal(browser.callTool.mock.calls.length, 1);
    const status = CallToolResultSchema.parse(await managed.callTool({ name: "browser_status" }));
    assert.equal(status.isError, false);
    assert.deepEqual(status.structuredContent?.recentSessions, []);
    assert.equal(status.structuredContent?.limits, null);
  });

  test("a rejected MCP request does not block cleanup or later actions", async function requestFailure() {
    const { browser, managed } = fixture();
    browser.callTool.mockRejectedValueOnce(new Error("MCP connection failed"));
    await assert.rejects(managed.callTool({ name: "browser_navigate" }), /MCP connection failed/);
    assert.equal(resultText(await managed.callTool({ name: "browser_close" })), "Page loaded");
  });
});

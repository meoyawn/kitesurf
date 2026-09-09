import type { ActiveSession, ClosedSession, LimitsResponse } from "@cloudflare/playwright";
import { CallToolResultSchema, type CallToolRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserTools } from "./mcp.ts";

const maxLaunchRetryDelay = 21_000;
const limitsDocumentation = "https://developers.cloudflare.com/browser-run/limits/";
const dailyTimeLimit = /browser time limit exceeded for today/i;

function launchFailure(result: Awaited<ReturnType<BrowserTools["callTool"]>>) {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success || !parsed.data.isError) return;
  for (const item of parsed.data.content) {
    if (item.type !== "text") continue;
    const match = item.text.trim().match(/^(?:McpError: MCP error -?\d+: )?(?:Error: )?(?:Error processing the request: )?Unable to create new browser: code: 429: message: (.+)$/s);
    if (match) return { result: parsed.data, reason: match[1].trim() };
  }
}

function limitSummary(account: LimitsResponse) {
  return {
    activeBrowsers: account.activeSessions.length,
    maxConcurrentBrowsers: account.maxConcurrentSessions,
    allowedBrowserAcquisitions: account.allowedBrowserAcquisitions,
    timeUntilNextAllowedBrowserAcquisition: account.timeUntilNextAllowedBrowserAcquisition,
  };
}

function diagnoseFailure(reason: string, account?: LimitsResponse) {
  const limitsHit: {
    limit: "daily_browser_time" | "concurrent_browsers" | "browser_launch_rate";
    evidence: "cloudflare_error" | "account_limits";
    message: string;
    retryAfterMs: number | null;
    resetsAt?: string;
  }[] = [];
  if (dailyTimeLimit.test(reason)) {
    const now = Date.now();
    const reset = new Date(now);
    reset.setUTCHours(24, 0, 0, 0);
    limitsHit.push({
      limit: "daily_browser_time", evidence: "cloudflare_error",
      message: "Cloudflare reports that today's daily browser-time allowance is exhausted. It resets at the next UTC day. Idle browser time counts toward this allowance.",
      retryAfterMs: reset.getTime() - now, resetsAt: reset.toISOString(),
    });
  }
  if (account && account.activeSessions.length >= account.maxConcurrentSessions) {
    limitsHit.push({
      limit: "concurrent_browsers", evidence: "account_limits",
      message: `The concurrent browser limit is currently exhausted: ${account.activeSessions.length}/${account.maxConcurrentSessions} active browsers. Close an unused browser you own or wait for it to expire before starting another.`,
      retryAfterMs: null,
    });
  }
  if (account && (account.allowedBrowserAcquisitions === 0 || account.timeUntilNextAllowedBrowserAcquisition > 0)) {
    const retryAfterMs = account.timeUntilNextAllowedBrowserAcquisition;
    limitsHit.push({
      limit: "browser_launch_rate", evidence: "account_limits",
      message: `The new browser instance rate limit is currently exhausted: allowedBrowserAcquisitions=${account.allowedBrowserAcquisitions}; timeUntilNextAllowedBrowserAcquisition=${retryAfterMs} ms. ` +
        (retryAfterMs > 0 ? `Wait at least ${retryAfterMs} ms before another launch.` : "Cloudflare did not provide a positive retry delay; check browser_status before another launch."),
      retryAfterMs: retryAfterMs > 0 ? retryAfterMs : null,
    });
  }
  return {
    service: "cloudflare_browser_run", operation: "browser_launch", status: 429,
    upstreamMessage: reason,
    diagnosis: limitsHit.length ? "identified" : "unknown",
    limitsHit,
    accountLimits: account ? limitSummary(account) : null,
    note: [
      ...(limitsHit.length ? [] : ["The exact limit that rejected this launch is unknown."]),
      ...(account ? ["Account limits are a snapshot after the rejected launch and may differ from the state at failure."] :
        dailyTimeLimit.test(reason) ? [] : ["Account limits could not be read."]),
      ...(dailyTimeLimit.test(reason) ? [] : ["A generic 429 does not establish that the daily browser-time allowance is exhausted. Daily usage is not exposed by the limits API."]),
      "Use browser_status to inspect account limits without launching a browser.",
    ].join(" "),
    documentationUrl: limitsDocumentation,
  };
}

function annotateResult(result: Awaited<ReturnType<BrowserTools["callTool"]>>, diagnostic: ReturnType<typeof diagnoseFailure>, retry: {
  attempted: boolean; delayMs: number; recovered: boolean;
}) {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) return result;
  const browserLimit = { ...diagnostic, retry };
  parsed.data.structuredContent = { ...parsed.data.structuredContent, browserLimit };
  parsed.data.content.push({
    type: "text",
    text: `Cloudflare Browser Run limit diagnostic${retry.recovered ? " (recovered after retry)" : ""}:\n${JSON.stringify(browserLimit, null, 2)}`,
  });
  return parsed.data;
}

const explainFailure = (failure: { result: CallToolResult; reason: string }, account?: LimitsResponse) =>
  annotateResult(failure.result, diagnoseFailure(failure.reason, account), { attempted: false, delayMs: 0, recovered: false });

/** Inspect account usage without launching a browser, and retry only rejected launches. */
export function manageBrowserLimits(browser: BrowserTools, account: {
  limits(): Promise<LimitsResponse>;
  history(): Promise<ClosedSession[]>;
  sessions?(): Promise<ActiveSession[]>;
}): BrowserTools {
  let pending: Promise<unknown> = Promise.resolve();

  async function readLimits() {
    const current = await account.limits();
    if (!Array.isArray(current.activeSessions)) {
      if (!account.sessions) throw new Error("Active browser count is unavailable.");
      current.activeSessions = (await account.sessions()).map(session => ({ id: session.sessionId }));
    }
    if (![current.maxConcurrentSessions, current.allowedBrowserAcquisitions,
      current.timeUntilNextAllowedBrowserAcquisition].every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("Account limits are unavailable.");
    }
    return current;
  }

  async function readHistory() {
    const recent = await account.history();
    if (!Array.isArray(recent)) throw new Error("Recent session history is unavailable.");
    return recent;
  }

  async function status(): Promise<CallToolResult> {
    const [limits, history] = await Promise.allSettled([readLimits(), readHistory()]);
    const now = Date.now();
    const report = {
      limits: limits.status === "fulfilled" ? limitSummary(limits.value) : null,
      recentSessions: history.status === "fulfilled" ? history.value.map(session => ({
        startedAt: session.startTime,
        endedAt: session.endTime ?? null,
        durationSeconds: Math.max(0, (session.endTime ?? now) - session.startTime) / 1000,
        closeReason: session.closeReasonText ?? "Active",
      })) : null,
      note: "Account-wide recent session history is not a complete daily usage meter. Idle time consumes browser allowance. This diagnostic does not launch a browser.",
      errors: [
        ...(limits.status === "rejected" ? ["Account limits could not be read."] : []),
        ...(history.status === "rejected" ? ["Recent session history could not be read."] : []),
      ],
    };
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      structuredContent: report,
      isError: limits.status === "rejected" && history.status === "rejected",
    };
  }

  async function invoke(params: CallToolRequest["params"]) {
    try {
      return await browser.callTool(params);
    } catch (error) {
      const failure = launchFailure({ isError: true, content: [{ type: "text", text: String(error) }] });
      if (!failure) throw error;
      return failure.result;
    }
  }

  async function call(params: CallToolRequest["params"]) {
    const result = await invoke(params);
    const failure = launchFailure(result);
    if (!failure) return result;
    if (dailyTimeLimit.test(failure.reason)) return explainFailure(failure);
    const current = await readLimits().catch(() => undefined);
    const retryDelay = current?.timeUntilNextAllowedBrowserAcquisition ?
      Math.ceil(current.timeUntilNextAllowedBrowserAcquisition) + 1_000 : maxLaunchRetryDelay;
    if (!current || current.activeSessions.length >= current.maxConcurrentSessions ||
      (current.allowedBrowserAcquisitions > 0 && current.timeUntilNextAllowedBrowserAcquisition === 0) ||
      retryDelay > maxLaunchRetryDelay ||
      !/^(?:Rate limit exceeded|Too many requests)$/i.test(failure.reason.trim())) {
      return explainFailure(failure, current);
    }
    // Keep a single bounded retry in the action queue, allowing for rate-limit propagation.
    const diagnostic = diagnoseFailure(failure.reason, current);
    await new Promise(resolve => setTimeout(resolve, retryDelay));
    const retried = await invoke(params);
    const retryFailure = launchFailure(retried);
    if (!retryFailure) {
      return annotateResult(retried, diagnostic, {
        attempted: true, delayMs: retryDelay, recovered: retried.isError !== true,
      });
    }
    const updated = dailyTimeLimit.test(retryFailure.reason) ? undefined : await readLimits().catch(() => undefined);
    return annotateResult(retryFailure.result, diagnoseFailure(retryFailure.reason, updated), {
      attempted: true, delayMs: retryDelay, recovered: false,
    });
  }

  return {
    async listTools() {
      const listed = await browser.listTools();
      listed.tools.push({
        name: "browser_status",
        description: "Inspect Cloudflare browser limits and recent session durations and close reasons without starting a browser.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      });
      return listed;
    },
    callTool(params: CallToolRequest["params"]) {
      if (params.name === "browser_status") return status();
      const result = pending.then(() => call(params));
      pending = result.catch(function recover() {});
      return result;
    },
  };
}

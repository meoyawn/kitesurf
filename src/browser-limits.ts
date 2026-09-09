import type { ActiveSession, ClosedSession, LimitsResponse } from "@cloudflare/playwright";
import { CallToolResultSchema, type CallToolRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserTools } from "./mcp.ts";

const launchRetryDelay = 21_000;

function launchFailure(result: Awaited<ReturnType<BrowserTools["callTool"]>>) {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success || !parsed.data.isError) return;
  for (const item of parsed.data.content) {
    if (item.type !== "text") continue;
    const match = item.text.match(/^(?:Error: )?Unable to create new browser: code: 429: message: (.+)$/s);
    if (match) return { result: parsed.data, reason: match[1] };
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

function explainFailure(failure: { result: CallToolResult; reason: string }, account?: LimitsResponse) {
  let explanation: string;
  if (/browser time limit exceeded for today/i.test(failure.reason)) {
    explanation = "Cloudflare reports that today's browser-time allowance is exhausted. It resets at the next UTC day. Idle browser time counts toward this allowance.";
  } else if (account && account.activeSessions.length >= account.maxConcurrentSessions) {
    explanation = `Cloudflare reports ${account.activeSessions.length}/${account.maxConcurrentSessions} active browsers. Close an unused browser or wait for it to expire before starting another.`;
  } else {
    explanation = "Cloudflare rejected a browser launch. A generic 429 does not establish that the daily browser-time allowance is exhausted. Use browser_status to inspect account limits and recent session close reasons.";
  }
  if (account) explanation += "\nAccount limits: " + JSON.stringify(limitSummary(account));
  else if (!/browser time limit exceeded for today/i.test(failure.reason)) explanation += " Account limits could not be read.";
  failure.result.content.push({ type: "text", text: explanation });
  return failure.result;
}

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

  async function call(params: CallToolRequest["params"]) {
    const result = await browser.callTool(params);
    const failure = launchFailure(result);
    if (!failure) return result;
    if (/browser time limit exceeded for today/i.test(failure.reason)) return explainFailure(failure);
    const current = await readLimits().catch(() => undefined);
    if (!current || current.activeSessions.length >= current.maxConcurrentSessions ||
      !/^(?:Rate limit exceeded|Too many requests)$/i.test(failure.reason.trim())) {
      return explainFailure(failure, current);
    }
    // The Free plan permits one launch every 20 seconds. Keep the retry in the action queue.
    await new Promise(resolve => setTimeout(resolve, launchRetryDelay));
    const retried = await browser.callTool(params);
    const retryFailure = launchFailure(retried);
    if (!retryFailure) return retried;
    const updated = await readLimits().catch(() => undefined);
    return explainFailure(retryFailure, updated);
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

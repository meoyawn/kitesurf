import { CookieJar } from "tough-cookie";
import { browserUserAgent, isTracker } from "./browser-stealth.ts";

export type BrowserNetwork = ReturnType<typeof createBrowserNetwork>;

export function browserUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
  }
  return url;
}

/** Cookies and response bodies belong to one browser session, never the Worker environment. */
export function createBrowserNetwork(fetcher: typeof fetch = fetch, jar = new CookieJar()) {
  const controller = new AbortController();
  const events: { url: string; method: string; status: number; bytes: number; queueMs: number; transferMs: number }[] = [];
  let requests = 0;
  let downloadedBytes = 0;
  let blockedRequests = 0;
  let active = 0;
  const waiting: (() => void)[] = [];

  async function download(value: string, options: {
    method?: string;
    headers?: HeadersInit;
    body?: Uint8Array | string;
    origin?: string;
    credentials?: string;
    mode?: string;
  } = {}) {
    const queued = performance.now();
    requests++;
    let url = browserUrl(value);
    let method = (options.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new Error("Unsupported HTTP method");
    let body = options.body;
    const headers = new Headers(options.headers);
    headers.delete("host");
    headers.delete("cookie");
    headers.set("user-agent", browserUserAgent);
    if (options.origin && options.mode === "cors") headers.set("origin", options.origin);
    // Workers permits six simultaneous outgoing connections. Queue excess work without dropping it.
    if (active >= 6) await new Promise<void>(function queued(resolve) { waiting.push(resolve); });
    else active++;
    const queueMs = performance.now() - queued;
    const signal = controller.signal;
    try {
      for (let redirects = 0; redirects <= 20; redirects++) {
        signal.throwIfAborted();
        if (isTracker(url.hostname)) {
          blockedRequests++;
          return { url: url.href, status: 0, body: "", headers: {}, redirected: redirects > 0, blocked: true };
        }
        const withCookies = options.credentials !== "omit" && (options.credentials === "include" || !options.origin || options.origin === url.origin);
        const cookie = withCookies ? jar.getCookieStringSync(url.href, {
          sameSiteContext: !options.origin || options.origin === url.origin ? "strict" : "none",
        }) : "";
        if (cookie) headers.set("cookie", cookie);
        else headers.delete("cookie");
        const started = performance.now();
        const response = await fetcher(url, {
          method, headers, body: method === "GET" || method === "HEAD" ? undefined : body as BodyInit,
          redirect: "manual", signal,
        });
        if (withCookies) {
          for (const cookie of response.headers.getSetCookie()) {
            jar.setCookieSync(cookie, url.href, { ignoreError: true });
          }
        }
        const location = response.headers.get("location");
        if (location && [301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const next = browserUrl(location, url.href);
          if (next.origin !== url.origin) headers.delete("authorization");
          if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
            method = "GET"; body = undefined; headers.delete("content-type");
          }
          url = next;
          continue;
        }
        const chunks: string[] = [];
        const decoder = new TextDecoder();
        let length = 0;
        const reader = response.body?.getReader();
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            downloadedBytes += value.byteLength;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          await reader?.cancel();
        }
        chunks.push(decoder.decode());
        events.push({ url: url.href, method, status: response.status, bytes: length, queueMs, transferMs: performance.now() - started });
        if (events.length > 100) events.shift();
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete("set-cookie");
        const crossOrigin = options.origin && options.origin !== url.origin;
        const allowedOrigin = response.headers.get("access-control-allow-origin");
        const corsBlocked = crossOrigin && options.mode === "cors" &&
          (allowedOrigin !== options.origin && !(allowedOrigin === "*" && options.credentials !== "include") ||
            options.credentials === "include" && response.headers.get("access-control-allow-credentials") !== "true");
        return {
          url: url.href, status: response.status, headers: Object.fromEntries(responseHeaders),
          body: corsBlocked ? "" : chunks.join(""), redirected: redirects > 0,
          ...(corsBlocked ? { corsBlocked: true, corsError: "Origin not allowed by response" } : {}),
        };
      }
      throw new Error("Too many HTTP redirects");
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  return {
    download,
    cookies(url: string) { return jar.getCookieStringSync(url, { http: false }); },
    setCookie(value: string, url: string) {
      jar.setCookieSync(value, url, { http: false, ignoreError: true });
    },
    diagnostics() { return { requests, downloadedBytes, blockedRequests, pending: active + waiting.length, events: events.slice() }; },
    next() { controller.abort(); return createBrowserNetwork(fetcher, jar); },
    close() { controller.abort(); },
  };
}

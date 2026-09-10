import domains from "../.wrangler/browser/trackers.js";

/** Matches the pinned bootstrap's default Chrome profile and client-side UA. */
export const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const trackers = new Set(domains.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")));

/** Obscura blocks exact tracker domains and every subdomain. */
export function isTracker(hostname: string) {
  let host = hostname.toLowerCase().replace(/\.$/, "");
  for (;;) {
    if (trackers.has(host)) return true;
    const next = host.indexOf(".");
    if (next < 0) return false;
    host = host.slice(next + 1);
  }
}

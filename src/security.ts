import { timingSafeEqual } from "node:crypto";

export const SCOPE = "browser:use";

export function isChatGptRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch {
    return false;
  }
}

export function isChatGptClient(value: string): boolean {
  if (!value.startsWith("https://")) return true;
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "/oauth/client.json" || /^\/oauth\/[A-Za-z0-9_-]+\/client\.json$/.test(url.pathname));
  } catch {
    return false;
  }
}

export async function digest(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyOwnerKey(value: string, expectedHash: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = new TextEncoder().encode(await digest(value));
  return timingSafeEqual(actual, new TextEncoder().encode(expectedHash));
}

export function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get("Origin") === origin && request.headers.get("Content-Type")?.split(";")[0] === "application/json";
}

export const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function boundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

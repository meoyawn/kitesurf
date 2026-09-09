import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isChatGptClient, isChatGptRedirect, json, sameOrigin, SCOPE, verifyOwnerKey } from "./security.ts";
import { authPage } from "./page.ts";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

async function parseAuthorization(request: Request, env: AuthEnv): Promise<AuthRequest | Response> {
  const params = new URL(request.url).searchParams;
  if (!isChatGptClient(params.get("client_id") ?? "")) return json({ error: "Only ChatGPT clients are allowed." }, 400);
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return json({ error: error.code, description: error.description }, 400);
    throw error;
  }
  if (!isChatGptRedirect(authRequest.redirectUri) || authRequest.codeChallengeMethod !== "S256" || !authRequest.codeChallenge) {
    return json({ error: "ChatGPT callback and S256 PKCE are required." }, 400);
  }
  if (authRequest.scope.some(scope => scope !== SCOPE)) return json({ error: "Unsupported scope." }, 400);
  return authRequest;
}

export async function authFetch(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (url.pathname === "/authorize") {
      const authRequest = await parseAuthorization(request, env);
      return authRequest instanceof Response ? authRequest : authPage({ authorizing: true, origin: env.PUBLIC_ORIGIN });
    }
    if (url.pathname === "/") return authPage({ origin: env.PUBLIC_ORIGIN });
    if (url.pathname === "/health") return json({ status: "ok", authentication: "oauth2", browserStarted: false });
    if (url.pathname === "/auth.js" || url.pathname === "/style.css") return env.ASSETS.fetch(request);
  }
  if (request.method !== "POST" || !["/auth/consent", "/auth/revoke"].includes(url.pathname)) {
    return json({ error: "Not found" }, 404);
  }
  if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Same-origin JSON requests are required." }, 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("key" in body) ||
    typeof body.key !== "string" || !body.key.length || body.key.length > 200 || !await verifyOwnerKey(body.key, env.OWNER_KEY_HASH)) {
    return json({ error: "Invalid owner key." }, 401);
  }
  if (url.pathname === "/auth/consent") {
    if (!("query" in body) || typeof body.query !== "string" || !body.query.startsWith("?")) {
      return json({ error: "Start the connection again from ChatGPT." }, 400);
    }
    const authorizationUrl = new URL("/authorize", env.PUBLIC_ORIGIN);
    authorizationUrl.search = body.query;
    const authRequest = await parseAuthorization(new Request(authorizationUrl), env);
    if (authRequest instanceof Response) return authRequest;
    const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: authRequest, userId: "owner",
      metadata: { client: "ChatGPT" }, scope: [SCOPE], props: { userId: "owner", scope: [SCOPE] } });
    return json({ redirectTo: result.redirectTo });
  }
  if (url.pathname === "/auth/revoke") {
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants("owner", { cursor });
      for (const grant of page.items) await env.OAUTH_PROVIDER.revokeGrant(grant.id, "owner");
      cursor = page.cursor;
    } while (cursor);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

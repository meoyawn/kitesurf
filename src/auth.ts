import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { cookie, isChatGptClient, isChatGptRedirect, json, sameOrigin, SCOPE, sessionCookie, verifyOwnerKey } from "./security.ts";
import { consumeState, issueSession, ownerSession, readState, saveState } from "./storage.ts";
import { authPage } from "./page.ts";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
async function validSession(request: Request, env: Env): Promise<boolean> {
  const session = await ownerSession(request, env);
  return !!session && session.csrf === request.headers.get("X-CSRF-Token");
}

async function authorize(request: Request, env: AuthEnv): Promise<Response> {
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
  const session = await ownerSession(request, env);
  let flow: string | undefined;
  if (session) flow = await saveState(env, "consent", { authRequest, csrf: session.csrf });
  return authPage({ csrf: session?.csrf, flow, authorizing: true, origin: env.PUBLIC_ORIGIN });
}

export async function authFetch(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname === "/") {
      const session = await ownerSession(request, env);
      return authPage({ csrf: session?.csrf, origin: env.PUBLIC_ORIGIN });
    }
    if (url.pathname === "/health") return json({ status: "ok", authentication: "oauth2", browserStarted: false });
    if (url.pathname === "/auth.js" || url.pathname === "/style.css") return env.ASSETS.fetch(request);
  }
  if (request.method !== "POST" || !["/auth/key", "/auth/consent", "/auth/revoke", "/auth/logout"].includes(url.pathname)) {
    return json({ error: "Not found" }, 404);
  }
  if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Same-origin JSON requests are required." }, 403);
  if (url.pathname === "/auth/key") {
    const body = await request.json<{ key?: unknown }>();
    if (typeof body.key !== "string" || body.key.length > 200 || !await verifyOwnerKey(body.key, env.OWNER_KEY_HASH)) {
      return json({ error: "Invalid owner key." }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await issueSession(env) });
  }
  if (!await validSession(request, env)) return json({ error: "Sign in again." }, 401);
  if (url.pathname === "/auth/consent") {
    const body = await request.json<{ flow?: string }>();
    const session = await ownerSession(request, env);
    const pending = body.flow && await readState<{ authRequest: AuthRequest; csrf: string }>(env, body.flow, "consent");
    if (!pending || pending.csrf !== session?.csrf) return json({ error: "Authorization expired. Start again from ChatGPT." }, 400);
    const flow = await consumeState<{ authRequest: AuthRequest }>(env, body.flow!, "consent");
    if (!flow) return json({ error: "Authorization was already used." }, 400);
    const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: flow.authRequest, userId: "owner",
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
  if (url.pathname === "/auth/logout") {
    const token = cookie(request, "__Host-kitesurf-session");
    if (token) await consumeState(env, token, "owner-session");
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return json({ error: "Not found" }, 404);
}

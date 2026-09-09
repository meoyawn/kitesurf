import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { cookie, digest, isChatGptClient, isChatGptRedirect, json, now, sameOrigin, SCOPE, sessionCookie, verifyOwnerKey } from "./security.ts";
import { consumeState, issueSession, listPasskeys, ownerSession, readState, saveState } from "./storage.ts";
import { authPage } from "./page.ts";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
type Challenge = { challenge: string; sessionHash?: string };

const challengeCookie = (id: string) => `__Host-kitesurf-challenge=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;

async function validSession(request: Request, env: Env): Promise<boolean> {
  const session = await ownerSession(request, env);
  return !!session && session.csrf === request.headers.get("X-CSRF-Token");
}

async function authOptions(request: Request, env: Env, registering: boolean): Promise<Response> {
  if (registering && !await validSession(request, env)) return json({ error: "Sign in again before adding a passkey." }, 401);
  const passkeys = await listPasskeys(env);
  const credentials = passkeys.map(key => ({ id: key.id, transports: JSON.parse(key.transports) as string[] }));
  if (registering && credentials.length >= 5) return json({ error: "Five passkeys are already registered." }, 409);
  if (!registering && !credentials.length) return json({ error: "Use your owner key first, then register a passkey." }, 409);
  const rpID = new URL(env.PUBLIC_ORIGIN).hostname;
  const options = registering
    ? await generateRegistrationOptions({ rpName: "Kitesurf", rpID, userName: "owner", userID: new TextEncoder().encode("kitesurf-owner"),
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, excludeCredentials: credentials })
    : await generateAuthenticationOptions({ rpID, allowCredentials: credentials, userVerification: "required" });
  const sessionToken = cookie(request, "__Host-kitesurf-session");
  const id = await saveState(env, registering ? "registration" : "authentication", {
    challenge: options.challenge,
    sessionHash: registering && sessionToken ? await digest(sessionToken) : undefined,
  });
  return json(options, 200, { "Set-Cookie": challengeCookie(id) });
}

async function verifyPasskey(request: Request, env: Env, registering: boolean): Promise<Response> {
  if (registering && !await validSession(request, env)) return json({ error: "Sign in again before adding a passkey." }, 401);
  const id = cookie(request, "__Host-kitesurf-challenge");
  if (!id) return json({ error: "Challenge expired. Please try again." }, 400);
  const challenge = await consumeState<Challenge>(env, id, registering ? "registration" : "authentication");
  if (!challenge) return json({ error: "Challenge expired or already used. Please try again." }, 400);
  const expectedRPID = new URL(env.PUBLIC_ORIGIN).hostname;
  if (registering) {
    const sessionToken = cookie(request, "__Host-kitesurf-session");
    if (!sessionToken || challenge.sessionHash !== await digest(sessionToken)) return json({ error: "Session changed. Please try again." }, 403);
    const body = await request.json<{ response: RegistrationResponseJSON }>();
    const result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge,
      expectedOrigin: env.PUBLIC_ORIGIN, expectedRPID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo) return json({ error: "Passkey verification failed." }, 401);
    const key = result.registrationInfo.credential;
    await env.AUTH_DB.prepare("INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(key.id, isoBase64URL.fromBuffer(key.publicKey), key.counter, JSON.stringify(key.transports ?? []), now()).run();
    return json({ ok: true });
  }
  const body = await request.json<{ response: AuthenticationResponseJSON }>();
  const key = (await listPasskeys(env)).find(item => item.id === body.response?.id);
  if (!key) return json({ error: "Passkey verification failed." }, 401);
  const result = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: challenge.challenge,
    expectedOrigin: env.PUBLIC_ORIGIN, expectedRPID, requireUserVerification: true,
    credential: { id: key.id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) } });
  if (!result.verified) return json({ error: "Passkey verification failed." }, 401);
  await env.AUTH_DB.prepare("UPDATE passkeys SET counter = MAX(counter, ?) WHERE id IS ?")
    .bind(result.authenticationInfo.newCounter, key.id).run();
  return json({ ok: true }, 200, { "Set-Cookie": await issueSession(env) });
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
  if (request.method !== "POST" || !url.pathname.startsWith("/auth/")) return json({ error: "Not found" }, 404);
  if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Same-origin JSON requests are required." }, 403);
  if (url.pathname === "/auth/key") {
    const body = await request.json<{ key?: unknown }>();
    if (typeof body.key !== "string" || body.key.length > 200 || !await verifyOwnerKey(body.key, env.OWNER_KEY_HASH)) {
      return json({ error: "Invalid owner key." }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await issueSession(env) });
  }
  if (url.pathname === "/auth/passkey/options") return authOptions(request, env, false);
  if (url.pathname === "/auth/passkey/verify") return verifyPasskey(request, env, false);
  if (url.pathname === "/auth/register/options") return authOptions(request, env, true);
  if (url.pathname === "/auth/register/verify") return verifyPasskey(request, env, true);
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

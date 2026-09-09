import { cookie, digest, now, randomToken, sessionCookie } from "./security.ts";

export async function saveState(env: Env, purpose: string, payload: unknown, ttl = 300): Promise<string> {
  const id = randomToken();
  await env.AUTH_DB.prepare("INSERT INTO auth_state (id, purpose, payload, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await digest(id), purpose, JSON.stringify(payload), now() + ttl).run();
  return id;
}

export async function readState<T>(env: Env, id: string, purpose: string): Promise<T | null> {
  const row = await env.AUTH_DB.prepare("SELECT payload FROM auth_state WHERE id IS ? AND purpose IS ? AND expires_at > ?")
    .bind(await digest(id), purpose, now()).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) : null;
}

export async function consumeState<T>(env: Env, id: string, purpose: string): Promise<T | null> {
  const row = await env.AUTH_DB.prepare("DELETE FROM auth_state WHERE id IS ? AND purpose IS ? AND expires_at > ? RETURNING payload")
    .bind(await digest(id), purpose, now()).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) : null;
}

export async function ownerSession(request: Request, env: Env): Promise<{ csrf: string } | null> {
  const token = cookie(request, "__Host-kitesurf-session");
  return token ? readState(env, token, "owner-session") : null;
}

export async function issueSession(env: Env): Promise<string> {
  const id = await saveState(env, "owner-session", { csrf: randomToken() }, 600);
  return sessionCookie(id);
}

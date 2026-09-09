import { env } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authFetch, type AuthEnv } from "./auth.ts";
import { mcpFetch } from "./mcp.ts";
import { boundedBody, isChatGptRedirect, json, SCOPE } from "./security.ts";

export { PlaywrightMCP } from "./browser.ts";

const provider = new OAuthProvider<AuthEnv>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request, workerEnv, ctx) {
      const props = ctx.props;
      if (typeof props !== "object" || props === null || !("userId" in props) || !("scope" in props) ||
        props.userId !== "owner" || !Array.isArray(props.scope) || !props.scope.includes(SCOPE)) {
        return json({ error: "insufficient_scope" }, 403, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${SCOPE}"` });
      }
      if (!(await workerEnv.MCP_RATE_LIMIT.limit({ key: "owner" })).success) return json({ error: "Too many browser requests." }, 429, { "Retry-After": "60" });
      if (new URL(request.url).pathname !== "/mcp") return json({ error: "Not found" }, 404);
      const browser = workerEnv.MCP_OBJECT.get(workerEnv.MCP_OBJECT.idFromName(props.userId));
      return mcpFetch(request, browser);
    },
  },
  defaultHandler: { fetch: authFetch },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 24 * 3600,
  clientRegistrationTTL: 90 * 24 * 3600,
  scopesSupported: [SCOPE],
  resourceMetadata: {
    resource: env.PUBLIC_ORIGIN + "/mcp",
    authorization_servers: [env.PUBLIC_ORIGIN],
    scopes_supported: [SCOPE],
    resource_name: "Kitesurf private browser",
    bearer_methods_supported: ["header"],
  },
  clientRegistrationCallback({ clientMetadata }) {
    const redirects = clientMetadata.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 ||
      !redirects.every(uri => typeof uri === "string" && isChatGptRedirect(uri))) {
      return { description: "Only ChatGPT OAuth callbacks can register." };
    }
  },
  tokenExchangeCallback({ userId, requestedScope }) {
    return { accessTokenProps: { userId, scope: requestedScope } };
  },
  onError() {
    console.warn(JSON.stringify({ event: "oauth_request_rejected" }));
  },
});

function secureResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Frame-Options", "DENY");
  return secured;
}

export default {
  async fetch(request, workerEnv, ctx) {
    try {
      const url = new URL(request.url);
      if (url.origin !== workerEnv.PUBLIC_ORIGIN) return json({ error: "Use the configured Kitesurf HTTPS origin." }, 421);
      if (!workerEnv.OWNER_KEY_HASH) return json({ error: "Owner authentication has not been configured." }, 503);
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await workerEnv.PUBLIC_RATE_LIMIT.limit({ key: ip })).success) return json({ error: "Too many requests." }, 429, { "Retry-After": "60" });
      if (request.method === "POST" && !url.pathname.startsWith("/mcp")) {
        if (!(await workerEnv.AUTH_RATE_LIMIT.limit({ key: ip })).success) return json({ error: "Too many authentication attempts. Try again in one minute." }, 429, { "Retry-After": "60" });
      }
      let forwarded: Request = request;
      if (request.method === "POST") {
        const buffer = await boundedBody(request, 65536);
        if (!buffer) return json({ error: "Request body too large." }, 413);
        forwarded = new Request(request, { body: new Uint8Array(buffer).buffer });
      }
      return secureResponse(await provider.fetch(forwarded, workerEnv, ctx));
    } catch {
      console.error(JSON.stringify({ event: "request_failed" }));
      return json({ error: "The request could not be completed. Start again or try later." }, 400);
    }
  },
  async scheduled(_event, workerEnv) {
    await provider.purgeExpiredData(workerEnv, { batchSize: 100 });
  },
} satisfies ExportedHandler<AuthEnv>;

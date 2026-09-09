import { escapeHtml } from "./security.ts";

export function authPage(options: { csrf?: string; flow?: string; authorizing?: boolean; origin: string }): Response {
  const signedIn = !!options.csrf;
  const title = options.authorizing ? "Connect Kitesurf to ChatGPT" : "Your private browser, ready for ChatGPT.";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kitesurf · Private browser MCP</title><link rel="stylesheet" href="/style.css"><script type="module" src="/auth.js"></script></head>
<body><main data-csrf="${escapeHtml(options.csrf ?? "")}" data-flow="${escapeHtml(options.flow ?? "")}">
<p class="brand">〰 KITESURF</p><p class="eyebrow">PRIVATE BROWSER MCP</p><h1>${title}</h1>
<p class="intro">Sign in with your private owner key to connect ChatGPT.</p>
${!signedIn ? `<section>
<form id="key-form"><label for="owner-key">Owner key</label><input id="owner-key" type="password" autocomplete="current-password" required>
<p class="hint">Use the secret saved with your Kitesurf project.</p><button type="submit">Sign in</button></form></section>`
: options.authorizing ? `<section><p>Allow ChatGPT to navigate websites, inspect pages, interact with forms, and take screenshots using your Cloudflare browser quota.</p>
<button id="consent">Allow ChatGPT</button><a class="cancel" href="/">Cancel</a></section>`
: `<section><p class="status">● Signed in as owner</p><label for="endpoint">MCP server URL</label><input id="endpoint" readonly value="${escapeHtml(options.origin)}/mcp">
<p class="hint">In ChatGPT’s New Plugin dialog, paste this URL and choose <strong>OAuth</strong>. Client ID and client secret can stay blank.</p>
<div class="actions"><button id="revoke" class="secondary">Revoke ChatGPT access</button><button id="logout" class="secondary">Sign out</button></div></section>`}
<p id="message" role="status" aria-live="polite"></p><footer>OAuth protects every browser request. Browsers close after 60 seconds of inactivity; ask ChatGPT to close the browser when finished.</footer>
</main></body></html>`;
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
}

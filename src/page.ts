import { escapeHtml } from "./security.ts";

export function authPage(options: { authorizing?: boolean; origin: string }): Response {
  const title = options.authorizing ? "Connect Kitesurf to ChatGPT" : "Your private browser, ready for ChatGPT.";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kitesurf · Private browser MCP</title><link rel="stylesheet" href="/style.css"><script type="module" src="/auth.js"></script></head>
<body><main data-authorizing="${!!options.authorizing}">
<p class="brand">〰 KITESURF</p><p class="eyebrow">PRIVATE BROWSER MCP</p><h1>${title}</h1>
<p class="intro">${options.authorizing ? "Enter your private owner key to approve this connection." : "Connect ChatGPT to your private Cloudflare browser."}</p>
${options.authorizing ? `<section><p>Allow ChatGPT to navigate websites, read page content, and interact with links and forms using your private browser.</p>`
: `<section><label for="endpoint">MCP server URL</label><input id="endpoint" readonly value="${escapeHtml(options.origin)}/mcp">
<p class="hint">In ChatGPT’s New Plugin dialog, paste this URL and choose <strong>OAuth</strong>. Client ID and client secret can stay blank.</p>
<p>To revoke all ChatGPT connections, enter your owner key below.</p>`}
<form id="key-form" method="post" action="${options.authorizing ? "/auth/consent" : "/auth/revoke"}"><label for="owner-key">Owner key</label><input id="owner-key" type="password" autocomplete="current-password" maxlength="200" required>
<p class="hint">Use the secret saved with your Kitesurf project.</p>
${options.authorizing ? `<button id="consent" type="submit">Allow ChatGPT</button><a class="cancel" href="/">Cancel</a>` : `<button id="revoke" type="submit" class="secondary">Revoke ChatGPT access</button>`}
</form></section>
<p id="message" role="status" aria-live="polite"></p><footer>OAuth protects every browser request. Browsers close after 60 seconds of inactivity; ask ChatGPT to close the browser when finished.</footer>
</main></body></html>`;
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
}

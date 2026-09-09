# Kitesurf

Private Cloudflare Browser Run automation for ChatGPT, with OAuth and a secret
owner key for authorization. Deploy it to your own Cloudflare account and connect the HTTPS
`/mcp` endpoint to ChatGPT.

Kitesurf uses Cloudflare's Worker-compatible Playwright MCP package. Its 24 browser tools
cover navigation, snapshots, clicks, typing, tabs, screenshots, and inspection.
An additional `browser_status` tool reports account limits and recent sessions
without starting a browser.
It does not include the full Chrome DevTools MCP performance-audit toolset.

## Development

Install [nub](https://nubjs.com) and [Task](https://taskfile.dev/installation/).
The Node version is pinned in `.node-version`; dependencies use `nub.lock`.

```sh
task setup
task check
```

| Task | Behavior |
| --- | --- |
| `setup` | `nub i` |
| `lint` | Oxlint, with warnings treated as failures |
| `tsc` | Generate Worker types, then TypeScript 7 typechecking |
| `test` | Vitest |
| `check` | Run `lint`, `tsc`, and `test` |
| `build` | Bundle the owner authorization client with esbuild |
| `deploy` | Require deployment credentials, run `check` and `build`, deploy |

Prerequisite tasks run once per invocation. Deployment requires a successful
check and a built authorization client. Wrangler bundles the Worker during deployment.

For local HTTPS development, use `nub run dev` from fish. This generates an
ignored local certificate if needed. Put `OWNER_KEY_HASH` in `.dev.vars` for local
authentication. Local development does not start a remote browser.

## Deployment configuration

The committed Wrangler configuration contains no account identifiers or public
deployment URL. Copy `.env.example` to the gitignored `.env` and configure:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID |
| `OAUTH_KV_ID` | ID of a KV namespace for OAuth state |
| `PUBLIC_ORIGIN` | Exact public HTTPS origin, without a trailing slash |
| `OWNER_KEY_HASH` | SHA-256 hex digest of a random 32-byte owner recovery key |
| `CLOUDFLARE_API_TOKEN` | Scoped Cloudflare deployment token, supplied through the environment |

Create a KV namespace in your account, using the Cloudflare
dashboard or Wrangler, and use its ID above. Enable a Workers subdomain or
configure the intended hostname. The default Worker name is `kitesurf-mcp`.

The deployment token needs Workers Scripts and Workers KV Storage write
access, plus Account Settings read access, scoped to your account. Browser Run
write access permits Browser Run administration; the Worker itself uses its
browser binding. No deployment token is uploaded to the Worker.

Generate the owner key locally and save only its hash in `.env` and `.dev.vars`:

```sh
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; import {mkdirSync,writeFileSync} from "node:fs"; const key=randomBytes(32).toString("base64url"); mkdirSync(".secrets",{recursive:true,mode:0o700}); writeFileSync(".secrets/owner-access-key",key+"\n",{mode:0o600,flag:"wx"}); console.log(createHash("sha256").update(key).digest("hex"));'
```

Keep the owner key as your recovery credential. The token, owner key, `.env`,
`.dev.vars`, generated configuration, and generated types are gitignored.

For a local deployment from fish, using the saved token:

```fish
env CLOUDFLARE_API_TOKEN=(string trim < .cloudflare-api-token) task deploy
```

`task deploy` fails if the token or required configuration is missing. It never
falls back to cached Wrangler credentials. The deploy script creates temporary
private configuration, uploads the owner-key hash with the
Worker, and removes the temporary files afterward.

## GitHub Actions

Every pull request runs `task setup` followed by `task check`. PR checks receive
no deployment secrets. Every push to `master`, including PR merges, runs
`task setup` and `task deploy`. Deployments are serialized.

Configure all five variables from the table as **GitHub Actions repository
secrets**. Keeping account identifiers and the origin as secrets also masks them
in deployment logs. Actions are pinned to commit hashes, and deployment does not
restore dependency caches from PR checks.

Upload the deployment token without putting it in command arguments:

```sh
gh secret set CLOUDFLARE_API_TOKEN < .cloudflare-api-token
```

## Connect ChatGPT

1. In ChatGPT's **New Plugin** dialog, enter **Kitesurf** and your deployment's
   `https://YOUR-WORKER-HOST/mcp`. Read the hostname from your private `PUBLIC_ORIGIN` configuration.
2. Choose **OAuth**. Leave client ID and client secret blank; discovery and
   registration are automatic.
3. Enter the key from the gitignored `.secrets/owner-access-key` file and select
   **Allow ChatGPT** to authenticate and approve the connection in one step.
   Keep credentials out of MCP URLs and chat messages.

The secret owner key is required for every connection approval and revocation.
Only its SHA-256 hash is stored in the Worker. OAuth gives ChatGPT bearer tokens
after approval, so subsequent requests and token refreshes do not need the key;
a ChatGPT account or registered OAuth client cannot grant itself access. There
is no public signup.

Storage consists of the owner-key hash in a Worker secret, OAuth clients, grants,
and token records in KV, and browser/MCP sessions in Durable Objects. The
[OAuth provider requires KV](https://github.com/cloudflare/workers-oauth-provider#kv-storage-and-cleanup)
for refresh, revocation, and cleanup. There are no stored owner login sessions,
pending consent records, or D1 bindings.

For an existing deployment, keep the same `OWNER_KEY_HASH`, `OAUTH_KV_ID`, and
Durable Object binding when upgrading. Existing OAuth grants continue to work.
After deploying this version, the old D1 database and `AUTH_DB_ID` secret can be
removed; deployment does not delete the database automatically.

## Access controls and limits

- Every MCP request requires a valid OAuth token, the owner identity, and the
  `browser:use` scope. Unauthorized requests cannot start a browser.
- OAuth uses S256 PKCE, exact ChatGPT callbacks, resource audience binding,
  one-hour access tokens, rotating refresh tokens with a 30-day lifetime, and
  explicit consent. CIMD and dynamic client registration are supported.
- Approval and revocation require the owner key in a same-origin JSON POST.
  OAuth parameters are validated again when approval is submitted. No login
  cookies or session CSRF tokens are issued or accepted as owner authentication.
- Rate limits apply to public requests, authentication, and browser tools. These
  operate per Cloudflare location; they are not a global spending cap.
- The owner shares one browser across MCP connections. Reconnecting or ending
  an MCP transport does not clear its tabs; use separate tabs for separate pages.
  Browser actions run in order, including calls from overlapping connections.
- Browser sessions have a 60-second idle timeout. Ask ChatGPT to call
  `browser_close` when finished. Cloudflare's Free plan provides 10 browser
  minutes per day across the account, including idle time.
- The Free plan also permits three concurrent browsers and one new browser
  every 20 seconds. Browser launch `429`s include a `browserLimit` diagnostic in
  both MCP text and structured content. It names `daily_browser_time` when
  Cloudflare explicitly reports daily exhaustion, and `concurrent_browsers` and
  `browser_launch_rate` when account diagnostics show those limits are exhausted.
  Multiple exhausted limits are reported together, with account values, evidence,
  retry delays in milliseconds, and the UTC reset time for daily exhaustion.
  Account diagnostics are a snapshot after the failure. If they do not identify
  an exhausted limit, the diagnosis is `unknown`; a generic `429` never establishes
  daily exhaustion by itself.
- A rejected launch with a confirmed rate limit and a free browser slot is
  retried once after the reported delay plus one second, up to a 21-second wait
  (21 seconds if Cloudflare reports no positive delay). Longer waits are returned
  to the caller. Browser actions remain ordered during the wait. Daily-quota,
  concurrency, and unknown-limit failures are not retried. A successful retry
  retains the original limit diagnostic with `retry.recovered: true`.
- Use `browser_status` to inspect account limits and recent session durations
  and close reasons. `BrowserIdle` indicates a session expired without explicit
  closure. Recent history is not a complete daily usage meter; use the Cloudflare
  dashboard to confirm the account's total usage. Diagnostics omit session IDs.
- The home page can revoke all ChatGPT grants with the owner key. KV propagation
  can briefly delay revocation. Public metadata and authorization traffic can
  consume Worker requests.

The published Playwright dependency expects ArrayBuffer WebSocket messages.
`no_websocket_standard_binary_type` preserves that behavior on newer Workers.

The patch in `patches/` exposes the dependency's browser server separately from
its MCP transport and creates each server with its own browser context. A single
owner Durable Object owns that server; HTTP requests use fresh stateless MCP
transports. This preserves tabs and snapshot references across client reconnects.

## Live verification

```sh
node --env-file=.env scripts/verify.ts --browser
```

This checks public HTTPS, rejected credentials, OAuth discovery, combined key
entry and consent, same-origin protection, PKCE, token refresh and replay
rejection, MCP tool discovery, and a real
navigation/reconnect/snapshot/click/screenshot/close sequence. It verifies both
page content and a link reference captured before the reconnect. It revokes its
test grant, does not print tokens, and uses a small amount of Browser Run allowance.
Omit `--browser` to
check authentication and tool discovery without launching a browser.

## References

- [Cloudflare Playwright MCP](https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/)
- [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [Workers WebSocket binary messages](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/)
- [ChatGPT MCP authentication](https://developers.openai.com/plugins/build/auth)

## License

MIT; see [LICENSE](LICENSE).

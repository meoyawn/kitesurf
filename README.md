# Kitesurf

Private Cloudflare Browser Run automation for ChatGPT, with OAuth and owner-only
passkey sign-in. Deploy it to your own Cloudflare account and connect the HTTPS
`/mcp` endpoint to ChatGPT.

Kitesurf uses Cloudflare's Worker-compatible Playwright MCP package. Its 24 tools
cover navigation, snapshots, clicks, typing, tabs, screenshots, and inspection.
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
| `build` | Bundle the passkey sign-in client with esbuild |
| `deploy` | Require deployment credentials, run `check` and `build`, apply D1 migrations, deploy |

Prerequisite tasks run once per invocation. Deployment requires a successful
check and a built sign-in client. Wrangler bundles the Worker during deployment.

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
| `AUTH_DB_ID` | ID of a D1 database for owner sessions and passkeys |
| `PUBLIC_ORIGIN` | Exact public HTTPS origin, without a trailing slash |
| `OWNER_KEY_HASH` | SHA-256 hex digest of a random 32-byte owner recovery key |
| `CLOUDFLARE_API_TOKEN` | Scoped Cloudflare deployment token, supplied through the environment |

Create a KV namespace and D1 database in your account, using the Cloudflare
dashboard or Wrangler, and use their IDs above. Enable a Workers subdomain or
configure the intended hostname. The default Worker name is `kitesurf-mcp`.

The deployment token needs Workers Scripts, Workers KV Storage and D1 write
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
private configuration, applies migrations, uploads the owner-key hash with the
Worker, and removes the temporary files afterward.

## GitHub Actions

Every pull request runs `task setup` followed by `task check`. PR checks receive
no deployment secrets. Every push to `master`, including PR merges, runs
`task setup` and `task deploy`. Deployments are serialized.

Configure all six variables from the table as **GitHub Actions repository
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
3. Sign in with your owner key or an enrolled passkey, then select **Allow ChatGPT**.

To enroll a passkey, open the deployed home page, sign in with the owner key,
and select **Add a passkey**. Keep credentials out of the MCP URL and chat messages.

WebAuthn authenticates the human at sign-in. OAuth provides bearer tokens for
ChatGPT's subsequent MCP requests. Owner approval is required before any browser
tool can run.

## Access controls and limits

- Every MCP request requires a valid OAuth token, the owner identity, and the
  `browser:use` scope. Unauthorized requests cannot start a browser.
- OAuth uses S256 PKCE, exact ChatGPT callbacks, resource audience binding,
  one-hour access tokens, rotating refresh tokens with a 30-day lifetime, and
  explicit consent. CIMD and dynamic client registration are supported.
- Passkeys require user verification and the configured origin/RP ID. D1 consumes
  challenges and consent records atomically. Enrollment requires an owner session
  and CSRF token. Owner sessions expire after ten minutes.
- Rate limits apply to public requests, authentication, and browser tools. These
  operate per Cloudflare location; they are not a global spending cap.
- Browser sessions have a default 60-second idle timeout. Ask ChatGPT to call
  `browser_close` when finished. Cloudflare's Free plan provides 10 browser
  minutes per day across the account, including idle time.
- The home page can revoke all ChatGPT grants. KV propagation can briefly delay
  revocation. Public metadata and sign-in traffic can consume Worker requests.

The published Playwright dependency expects ArrayBuffer WebSocket messages.
`no_websocket_standard_binary_type` preserves that behavior on newer Workers.

## Live verification

```sh
node --env-file=.env scripts/verify.ts --browser
```

This checks public HTTPS, rejected credentials, OAuth discovery, owner login,
CSRF, PKCE, token refresh and replay rejection, MCP tool discovery, and a real
navigation/screenshot/close sequence. It revokes its test grant, does not print
tokens, and uses a small amount of Browser Run allowance. Omit `--browser` to
check authentication and tool discovery without launching a browser.

## References

- [Cloudflare Playwright MCP](https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/)
- [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [Workers WebSocket binary messages](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/)
- [ChatGPT MCP authentication](https://developers.openai.com/plugins/build/auth)

## License

MIT; see [LICENSE](LICENSE).

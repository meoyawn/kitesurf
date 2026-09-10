# Kitesurf

Kitesurf is a browser MCP that runs entirely inside Cloudflare Worker isolates.
It lets ChatGPT load pages, read content, follow links, fill forms, and run page
JavaScript through an OAuth-protected `/mcp` endpoint.

[Obscura](https://github.com/h4ckf0r0day/obscura) supplies the DOM, browser APIs,
and CSS layout. [rquickjs](https://github.com/mrchantey/rquickjs) embeds QuickJS-NG
in the same Rust WASM module. Rust owns the browser, DOM callbacks, script loading,
promises and timers; the Worker supplies networking and platform services.
A Durable Object keeps tabs alive across MCP reconnects and serializes actions.

The goal is a small browser with low memory use. Web API and CSS support are
incomplete, and there is no pixel rendering or screenshot tool. Site compatibility
and memory use are still being tested.

## Browser tools

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Load an HTTP(S) URL and execute its scripts |
| `browser_snapshot` | Read page text, links, and controls with numeric node references |
| `browser_click` | Click a node by reference or CSS selector |
| `browser_fill` | Set an input, textarea, or select value and dispatch input/change events |
| `browser_evaluate` | Evaluate a synchronous page JavaScript expression and return JSON |
| `browser_scroll` | Scroll to a vertical offset or the bottom and process page activity |
| `browser_wait_for` | Process pending tasks until an expression is truthy, for up to 10 seconds |
| `browser_status` | Inspect script errors, requests, stealth settings, and allocated WASM memory |
| `browser_tabs` | List, create, select or close tabs |
| `browser_close` | Release all tabs, cookies and the WASM instance |

Navigation replaces the selected page while retaining its cookies. Tabs have
independent page state and cookie sessions. Up to four tabs share one WASM heap;
closing the last tab releases it. An idle alarm closes all tabs after 60 seconds.
State lives in memory and can be lost when the isolate restarts.

## Stealth and memory

Obscura's [stealth mode](https://github.com/h4ckf0r0day/obscura#stealth-mode)
is enabled before page scripts run. The browser uses its JavaScript fingerprint
settings, masks browser functions, hides internal bootstrap globals, and blocks
tracker domains and their subdomains using Obscura's pinned list. HTTP requests
and `navigator.userAgent` use the same browser profile.

TLS is managed by Workers' `fetch`. Obscura's native TLS fingerprinting client
is not part of this build, so enabling stealth does not reproduce its native
network fingerprint.

Cloudflare allows **128 MB per isolate**, including the host JavaScript heap and
all WASM allocations. Concurrent requests in an isolate share that budget. [Cloudflare memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory)

The combined Obscura + QuickJS module passes the live Yandex 20→21 test in local
workerd with approximately **77 MiB of WASM memory**. The September 10, 2026 build
includes Binaryen size optimization and native UTF-8 buffer callbacks:

| Measurement | Initial Obscura checkpoint | Optimized build |
| --- | --- | --- |
| WASM binary | 3,976,636 bytes | 3,379,953 bytes (15.0% smaller) |
| WASM gzip | 1,343,945 bytes | 1,297,307 bytes (3.5% smaller) |
| Yandex WASM memory | 76.9 MiB | 76.9 MiB (80,609,280 bytes; unchanged) |

Tabs share a **96 MiB WASM maximum**, with a 48 MiB QuickJS limit per tab.
Ordinary DOM calls stay inside WASM and return guest JavaScript values directly.

The first combined build needed roughly 110 MiB. Removing an unused retained CSS
custom-property cache reduced that peak while keeping CSS inheritance and the
scrolling test passing. No page styles or scripts were removed for the test.
Stealth's overhead has not been measured separately. WASM file size, allocated
WASM memory and total isolate RAM are different measurements; the reported
memory excludes the Worker JavaScript heap. The live page still reports some
script errors, so this test demonstrates its required scrolling behavior,
not full Chromium compatibility. These are local results, not a deployment test.

## Run locally

Install [nub](https://nubjs.com), [Task](https://taskfile.dev/installation/),
fish, OpenSSL, and [Rust through rustup](https://rustup.rs/). Use the Node version
in `.node-version` and make Cargo available on `PATH`.

```fish
task setup
task check
```

`task setup` initializes pinned Git submodules, installs packages with nub, and
prepares the pinned Rust/WASM toolchain and matching wasm-bindgen CLI. Repository
setup, including the Binaryen optimizer, belongs in this task; CI calls it too.

Generate an owner key once. This command writes the key to an ignored file and
prints its SHA-256 hash:

```fish
node --input-type=module -e '
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const key = randomBytes(32).toString("base64url");
mkdirSync(".secrets", { recursive: true, mode: 0o700 });
writeFileSync(".secrets/owner-access-key", key + "\n", { mode: 0o600, flag: "wx" });
console.log(createHash("sha256").update(key).digest("hex"));
'
```

Save the printed hash as `OWNER_KEY_HASH` in the ignored `.dev.vars` file, then run:

```fish
nub run dev
```

The dev script builds the browser, creates an ignored local HTTPS certificate,
and starts Wrangler's local Worker runtime at `https://localhost:8787`.
Keep the owner key for connection approval and recovery.

## Deploy and connect

Copy `.env.example` to the ignored `.env`. Create a Cloudflare KV namespace for
OAuth records and configure these values privately:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account to deploy to |
| `OAUTH_KV_ID` | KV namespace for OAuth clients, grants, and tokens |
| `PUBLIC_ORIGIN` | Exact public HTTPS origin, without a trailing slash |
| `OWNER_KEY_HASH` | Hash of the owner key generated above |
| `CLOUDFLARE_API_TOKEN` | Scoped deployment token, supplied through the environment |

With the token saved in the ignored `.cloudflare-api-token` file, deploy from fish:

```fish
env CLOUDFLARE_API_TOKEN=(string trim < .cloudflare-api-token) task deploy
```

`task deploy` runs checks and builds, requires explicit deployment credentials,
and uploads the owner-key hash as a Worker secret. Account IDs, the deployment
origin, tokens, and the owner key stay out of tracked configuration.

Connect ChatGPT to `/mcp` at your configured `PUBLIC_ORIGIN`, select OAuth, and
approve the connection with the owner key. OAuth discovery and client registration
are provided by the Worker. The current authorization policy accepts ChatGPT
clients and callbacks.

Every MCP request requires the owner's OAuth token and `browser:use` scope.
Authorization uses S256 PKCE, and connection approval and revocation require the
owner key. Only its hash is stored in the Worker. The home page can revoke all
grants; KV propagation can briefly delay revocation. Keep the same owner-key hash,
KV namespace, and Durable Object binding when upgrading an existing deployment.

GitHub Actions runs `task setup` then `task check` on pull requests, and
`task setup` then `task deploy` on pushes to `master`. Configure the five variables
above as repository secrets for deployment. Pull request checks receive no
deployment secrets, and deployments are serialized.

## Verify

`task check` runs linting, typechecking, and deterministic tests for the browser,
MCP transport, and authorization. Browser tests cover DOM mutation, scrolling,
fetch, cookies, stealth, text encoding, tab lifetime, interruption, and reconnects.

For the live acceptance test, leave `nub run dev` running and use a second terminal:

```fish
task test:yandex
```

The test exercises OAuth, MCP reconnects, and creating and closing tabs, then loads the
[Yandex vacancies page](https://yandex.ru/jobs/vacancies/city_kazan?profession=backend-developer&profession=system-developer&skills=74&skills=378&skills=64&skills=160&pro_levels=senior).
It requires **20 openings before scrolling and 21 afterward**, with no pagination
request before scrolling. The page's own JavaScript must fetch the next cursor
and append one distinct opening while retaining the original 20.

The test is opt-in because the live site and its vacancy count can change. Successful runs write
`.wrangler/yandex-result.json`; cleanup closes the browser and revokes the test
grant. Leave a minute between full runs to respect the authentication rate limit.

`task test:sites` also checks live readable content and selectors on Hacker News,
Wikipedia and MDN, writing `.wrangler/sites-result.json`. These are limited smoke
tests; they passed on September 10, 2026 but do not verify every page feature or
broad browser compatibility. MDN still reports dynamic-module loading errors.

## Dependencies and builds

Cargo supplies Obscura's DOM and its Taffy fork at pinned Git revisions.
Other direct crate versions are exact, and `native/Cargo.lock` locks transitive
dependencies. Rust is pinned in `rust-toolchain.toml`; JavaScript dependencies
use `nub.lock`.

The pinned `vendor/obscura` submodule supplies upstream code and data that need
direct integration: browser API bootstrap, document-write parser, layout sources,
and tracker list. Local Rust and TypeScript adapters connect those pieces to WASM
and Workers. Upstream source stays in the dependency or submodule; generated
bindings, adapted build output, and WASM files stay in ignored build directories.

`task browser:build` builds the browser assets. `task build` also bundles the
authorization client. Build and test tasks declare their prerequisites in
`Taskfile.yaml`.

MIT; see [LICENSE](LICENSE). Upstream dependencies retain their own licenses.

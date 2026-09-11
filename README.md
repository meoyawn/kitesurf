# Kitesurf

Kitesurf is a browser MCP that runs entirely inside Cloudflare Worker isolates.
It lets ChatGPT load pages, read content, follow links, fill forms, and run page
JavaScript through an OAuth-protected `/mcp` endpoint.

[Obscura](https://github.com/h4ckf0r0day/obscura) supplies the DOM, browser APIs,
and CSS layout. [rquickjs](https://github.com/mrchantey/rquickjs) embeds QuickJS-NG
in the same Rust WASM module. Rust owns the browser, DOM callbacks, script loading,
promises and timers; the Worker supplies networking and platform services.
A Durable Object keeps tabs alive across MCP reconnects and serializes actions.

References to `Deno.core.ops` preserve Obscura's upstream browser bootstrap API,
which originally uses `deno_core`. In this build, a small `Deno` object inside
QuickJS exposes our Rust callbacks and Worker adapters inside private closures.
`Deno` is absent from page globals so frameworks select their browser runtime.
Keeping the internal callback names
minimizes patches to the pinned upstream source. Neither Deno nor V8 is compiled
into the browser WASM module; Obscura's original runtime remains in the submodule
but is excluded from this build.

The goal is a small browser with low memory use. Web API and CSS support are
incomplete, and there is no pixel rendering or screenshot tool. Site compatibility
and memory use are still being tested.

## Browser tools

| Tool | What it does |
| --- | --- |
| `browser_tools_profiles` | Discover the supported core tools and engine limitations |
| `browser_open` | Open `about:blank` or navigate to an HTTP(S) URL; bare hosts use HTTPS |
| `browser_reload` | Reload the selected page and execute its scripts |
| `browser_read` | Read the active DOM or fetch a URL as Markdown/readable text; filter sections, get an outline, or discover ancestor `llms.txt`/`llms-full.txt` |
| `browser_snapshot` | Read a DOM accessibility tree with `@e` references; scope by selector, limit depth, include URLs, or include noninteractive content |
| `browser_click` | Activate a node by reference or CSS selector; optionally open its link in a new tab |
| `browser_fill` | Fill an input, textarea or contenteditable element and dispatch input/change events |
| `browser_check`, `browser_uncheck` | Activate checkboxes, radio buttons and ARIA switches when their state needs changing |
| `browser_select` | Select one or more options by value or label |
| `browser_eval` | Run a JavaScript expression or script and await a returned promise |
| `browser_scroll` | Scroll a page or element up, down, left or right by a pixel amount |
| `browser_wait_ms` | Process page tasks for a fixed duration |
| `browser_wait_for_selector`, `browser_wait_for_text` | Wait for a CSS-visible element or page text |
| `browser_wait_for_load` | Wait for DOMContentLoaded, load, or 500 ms of network inactivity |
| `browser_wait_for_function` | Process pending tasks until a synchronous expression is truthy |
| `browser_get_text`, `browser_get_url`, `browser_get_title` | Read element text, the active URL or the title |
| `browser_status` | Inspect script errors, requests, stealth settings, and allocated WASM memory |
| `browser_tab_new`, `browser_tab_list`, `browser_tab_switch`, `browser_tab_close` | Manage tabs using stable IDs (`t1`) or labels |
| `browser_close` | Release the session, or all sessions in its namespace with `all: true` |

The surface follows the supported portion of
[agent-browser's core MCP profile](https://github.com/vercel-labs/agent-browser/blob/8c15ff9f71ae60c7e99e66afe1e2d4b9bf414fe2/cli/src/mcp.rs),
using `browser_` names. It exposes 26 tools: 24 supported core tools plus the
existing runtime diagnostics and expression-wait capability. Screenshots, painting,
PDF/video output, native keyboard input, back/forward navigation and AI chat are
excluded. Chromium launch flags, CLI arguments, filesystem paths, OS certificate
configuration and disk-based session restore are not accepted. Unsupported tools
and arguments fail validation rather than advertising unavailable behavior.

Snapshots default to interactive elements. Set `interactive: false` for page
structure and text. Pass a returned reference as `selector: "@e1"`; CSS selectors
must identify one element. References survive repeated snapshots of the same
elements and are scoped to the latest snapshot in the current tab. Navigation,
tab closure and removed elements invalidate them. The tree derives roles and
names from the DOM; visibility and geometry have Obscura's layout limitations.
Clicks use DOM activation and cannot produce trusted native input events.

All tools accept `session`, `namespace`, `allowedDomains` and `timeoutMs`.
Sessions isolate tabs and cookies; tabs within a session share cookies. Every
session and tab shares the same **96 MiB maximum WASM heap**, and closing the
last tab releases it. Navigation replaces the selected DOM and JavaScript VM;
it retains cookies but does not persist Web Storage or cross-document history.
There is no automatic idle closure. State lives in memory and can be lost when
the isolate restarts. Close unused tabs to release their DOM and QuickJS state.

An explicit `browser_read` URL uses a separate unauthenticated request context,
without changing the active tab. HTML extraction uses the existing native parser
without bootstrapping page scripts, loading linked resources or adding a parser
dependency. Omit the URL to read the rendered DOM and its current authenticated
content. `raw`, `requireMd`, `outline`, `filter` and `llms` control extraction.
`llms-full.txt` is fetched only when explicitly requested.

Navigation, clicks and scrolling process pending downloads, microtasks and
application tasks before returning a small result. They do not automatically
build snapshots; call `browser_snapshot` or `browser_read` when needed. Repeating intervals and rendering callbacks
run without keeping an otherwise idle action open. Delayed activity can be
awaited with the wait tools. Calls default to a 120-second timeout; conditional
waits default to 25 seconds and URL reads to 30 seconds, bounded by the call
timeout. Cancellation aborts networking and releases an interrupted page before
the next queued action. There are no application quotas on request
count, downloaded bytes, snapshot content or action input size. Downloads queue
behind the platform's six concurrent connections. Deployment uses Cloudflare's
platform defaults, including the account's subrequest allowance. The Free plan
allows 50 subrequests per invocation; redirects also count. A platform resource
failure is reported as a failed action, so a page can exceed the account's
allowance even when it works locally. [Subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

The entry Worker handles OAuth and MCP transport; browser execution, layout,
and page downloads run in `BrowserMCP`, a SQLite-backed Durable Object. Its
default CPU allowance is 30 seconds per invocation, excluding time waiting on
network I/O. The Free entry Worker's 10 ms CPU allowance is a separate budget.
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

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

Tabs share a **96 MiB WASM maximum**. QuickJS's allocation allowance follows
available shared heap capacity with headroom for native browser work. Ordinary
DOM calls stay inside WASM and return guest JavaScript values directly. Fetch
bodies cross separately from metadata, and geometry callbacks return native
objects without JSON encoding and decoding.

Compiled CSS, computed styles and guest geometry objects survive geometry reads.
Attribute mutations feed Obscura's retained-style invalidation planner; tree,
stylesheet and unsupported changes trigger a fresh cascade. Changes confined to
color, opacity or ordinary visibility can preserve geometry when compiled selector
dependencies allow it, including shadow styles. Inherited CSS variables use structurally shared maps
instead of copying every variable into every component. WASM file size, allocated
WASM memory and total isolate RAM are different measurements; reported WASM
memory excludes the Worker JavaScript heap.

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

The deployment contract supports Workers Free by leaving `limits` unset in
`wrangler.jsonc`. Both validation and deployment reject custom limits: CPU
overrides require Workers Paid, and its maximum subrequest allowance is not a
Free-plan entitlement. Raising these limits requires revisiting the deployment
contract and the account's Workers plan together. [Wrangler limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)

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

`task check` runs linting, typechecking, deterministic tests, and `task deploy:check`.
The deployment check validates the platform-defaults contract and dry-runs the
actual Wrangler bundle through the deployment script, without credentials or an
upload. Wrangler dry runs and local workerd do not enforce account entitlements;
the explicit configuration check catches unsupported overrides before deployment.
Browser tests cover DOM mutation, scrolling,
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
The page must contain all 21 openings when scrolling finishes, without another
wait call. Scrolling advances in 576-pixel steps so intersection observers can
see the pagination sentinel. To verify the button
instead, run `node scripts/verify.ts --yandex --click` with the local certificate
configured through `NODE_EXTRA_CA_CERTS`.

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

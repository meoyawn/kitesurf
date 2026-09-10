# Rust browser core

One WASM module contains Obscura's DOM and CSS layout, QuickJS-NG through
rquickjs, and the upstream browser bootstrap executed inside QuickJS.
`BrowserTab` owns its DOM, JavaScript runtime/context, timers, script loader,
pending fetch promises, snapshots and cleanup. DOM callbacks return guest
JavaScript values directly; ordinary DOM operations never call TypeScript.
The Worker supplies networking, clock/randomness, cookies, URL/Intl/encoding
platform services and timer wakeups.

The default Cargo features are `render,stealth`. Disabling `render` omits CSS
layout callbacks and uses the bootstrap's fallback geometry. The Worker builds
with both features. Pixel rendering, fonts and screenshots are excluded.

## Pinned dependencies

- `obscura-dom` and the Taffy fork: Cargo Git revision
  `727cc46d56290995245fbe790caed52fc699452a` of Obscura.
- `rquickjs`: Cargo Git revision `9d3206c80d3ff2e819abca783a6859e83a5d7b5f`
  of `mrchantey/rquickjs`, which adds `wasm32-unknown-unknown` support.
  Cargo fetches its pinned QuickJS-NG C submodule. No QuickJS source is copied.
- Other direct crates use exact versions; `native/Cargo.lock` pins transitives.
- `vendor/obscura`: Git submodule at the same Obscura revision, supplying code
  and data which are not independently usable Cargo libraries.

The rquickjs fork uses WASI SDK 24 libc headers/libraries to compile its C
dependency, with its own small platform shim. The resulting module needs no
WASI runtime. Its clock symbol is implemented by Rust using the Worker clock.
The fork's revision is intentional: the later QuickJS update at its current
head did not compile with its generated bindings in this experiment.

## Reviewed adapters

- `browser/build.rs` embeds the pinned bootstrap and replaces its DOM JSON
  parsing with native callback results. UTF-8 encoding and decoding use native
  typed-buffer callbacks instead of per-character JavaScript allocations;
  legacy encodings retain the Worker decoder. Mutation bookkeeping retains
  the bootstrap's string-boolean convention. Each substitution is asserted
  against the pinned source. The bootstrap and platform adapters capture `Deno`
  privately; page scripts cannot mistake it for a server runtime.
- `browser/src/bridge.rs` translates bootstrap operations to the DOM crate's
  public API. The pinned document-write parser is included by path from the
  submodule. No parser, selector engine or upstream JS runtime is copied.
- `layout/build.rs` compiles upstream layout modules by path. Its ignored
  generated DOM module substitutes the two unsupported profiling clocks with
  `web-time` and changes CSS variable maps to `im-rc` persistent maps. Geometry
  reads reuse compiled CSS and retained styles, moving style maps between
  layouts. Attribute mutations feed the upstream invalidation planner. Tree
  edits start a fresh cascade to avoid expanding sibling scopes repeatedly for
  intermediate framework mutations. Compiled CSS survives either path. Geometry
  objects are reused in QuickJS until layout or scrolling changes their generation.
- The bootstrap's computed-style dimension fallback only requests geometry for
  dimensional properties. Reading properties such as position or overflow does
  not force an unrelated layout.
- QuickJS's builtin `performance` is removed before the bootstrap initializes
  its browser implementation; its read-only `timeOrigin` otherwise conflicts.
- The local platform and snapshot scripts provide Worker adapters and the MCP
  snapshot contract. The native Obscura V8 runtime and networking stack are
  not compiled into this build.

Upstream source stays in Cargo or the submodule. Adapted source, generated
bindings and WASM stay in ignored build directories. Assertions on each source
adaptation make a changed upstream call site fail the build.

## Lifetime and memory

Tabs have independent DOMs, QuickJS runtimes and cookie sessions. Tabs in one
browser share a WASM instance and its 96 MiB linear-memory maximum, avoiding
multiplication of that maximum when opening tabs. Each guest's allocation
allowance follows available shared heap capacity, reserving native headroom.
The instruction watchdog resets for each JavaScript task instead of accumulating
across the page's lifetime. A native WASM trap closes the affected browser.
Closing the last tab releases the instance. There is no idle alarm or tab,
download, response-size or snapshot quota. State is in memory and is lost on eviction.

`browser_status` reports allocated WASM memory and QuickJS usage. WASM linear
memory cannot shrink; freed allocations remain reusable until all tabs close.
These figures are not total isolate RAM, which also includes the Worker heap.

Obscura's JavaScript stealth settings and pinned tracker list are enabled.
Workers `fetch` controls TLS; native Obscura TLS impersonation is unavailable.

## Setup

`task setup` initializes the submodule, installs JS packages with nub, ensures
the pinned Rust target and wasm-bindgen CLI, obtains LLVM and Binaryen 132
through pinned pkgx, verifies/downloads the pinned WASI sysroot and fetches
locked Cargo dependencies.
Toolchain paths live only in ignored configuration. CI calls `task setup`.
`task browser:build` compiles with `--locked`, runs `wasm-opt -O3`, then publishes
complete assets with atomic file renames so local reloads cannot read a partial
WASM binary. `task check` builds before tests.
The opt-in `task test:yandex` runs OAuth/MCP and live 20→21 scrolling in local
workerd, including the assertion that pagination starts only after scrolling.
`task test:sites` checks readable content and selectors on Hacker News,
Wikipedia and MDN; these smoke tests do not establish full site compatibility.

## Performance diagnosis

`node scripts/benchmark-browser.ts --record` records the live Yandex load and
one load-more click in ignored `.wrangler/browser-benchmark` fixtures.
`--replay` runs the same responses without network variability. Both modes
assert 20 initial openings and 21 distinct openings returned by the action,
without an extra wait tool call. `--scroll` exercises the scrolling path.
Replay requires fixtures for every request; live scripts may construct new URLs.
Missing fixtures appear as request errors, so use live runs for acceptance and
inspect replay errors before comparing performance.

Build with `env KITESURF_PROFILE=1 node scripts/build-browser.ts` to retain WASM
function names, then run the benchmark with Node's `--cpu-prof` option for
sampled stacks. Add `KITESURF_TRACE=1` to that build command for instrumented
Rust, QuickJS task, DOM, layout, Worker and download spans. The benchmark writes
Chrome Trace JSON to `.wrangler/browser-benchmark/trace.json`. These spans cover
runtime boundaries and layout stages; they do not record every compiled function
or every guest JavaScript invocation. Synchronous clock resolution in workerd
differs from Node, so CPU attribution uses the local Node host.

Tracing is compiled out of ordinary builds. Compare final timings with tracing
disabled; the collector and event export add work and memory. `browser_status`
reports aggregate runtime, layout and host-call measurements in all builds.

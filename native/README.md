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

- `browser/build.rs` embeds the pinned bootstrap and replaces one asserted
  `JSON.parse(_dom(...))` call with the native callback result. Mutation
  bookkeeping retains the bootstrap's string-boolean convention.
- `browser/src/bridge.rs` translates bootstrap operations to the DOM crate's
  public API. The pinned document-write parser is included by path from the
  submodule. No parser, selector engine or upstream JS runtime is copied.
- `layout/build.rs` compiles upstream layout modules by path. Its ignored
  generated DOM module substitutes the two unsupported profiling clocks with
  `web-time` and omits the retained CSS custom-property cache. Geometry calls
  rebuild styles, so they need inheritance during cascade but no retained
  maps for incremental updates. This wrapper is not an incremental renderer.
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
multiplication of that maximum when opening tabs. Each guest has a 48 MiB
QuickJS allocation limit. JavaScript interruption and request/response limits
bound page work. A native WASM trap closes the entire affected browser.
Closing the last tab releases the instance; an idle Durable Object alarm closes
all tabs after 60 seconds. State is in memory and is lost on eviction.

`browser_status` reports allocated WASM memory and QuickJS usage. WASM linear
memory cannot shrink; freed allocations remain reusable until all tabs close.
These figures are not total isolate RAM, which also includes the Worker heap.

Obscura's JavaScript stealth settings and pinned tracker list are enabled.
Workers `fetch` controls TLS; native Obscura TLS impersonation is unavailable.

## Setup

`task setup` initializes the submodule, installs JS packages with nub, ensures
the pinned Rust target and wasm-bindgen CLI, obtains LLVM through pinned pkgx,
verifies/downloads the pinned WASI sysroot and fetches locked Cargo dependencies.
Toolchain paths live only in ignored configuration. CI calls `task setup`.
`task browser:build` compiles with `--locked`; `task check` builds before tests.
The opt-in `task test:yandex` runs OAuth/MCP and live 20→21 scrolling in local
workerd, including the assertion that pagination starts only after scrolling.

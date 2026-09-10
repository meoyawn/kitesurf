import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const environment = JSON.parse(await readFile(".wrangler/browser/toolchain.json", "utf8")) as Record<string, string>;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...environment } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed`);
}

run("cargo", ["build", "--manifest-path", "native/Cargo.toml", "--locked", "--release", "--target", "wasm32-unknown-unknown", ...(process.env.KITESURF_TRACE === "1" ? ["--features", "trace"] : [])]);
await mkdir(".wrangler/browser", { recursive: true });
// Publish complete files only; Wrangler watches these imports during local rebuilds.
const staging = await mkdtemp(".wrangler/browser-build-");
try {
  const trackers = await readFile("vendor/obscura/crates/obscura-net/src/pgl_domains.txt", "utf8");
  await writeFile(join(staging, "trackers.js"), "export default " + JSON.stringify(trackers) + ";\n");
  await writeFile(join(staging, "trackers.d.ts"), "declare const domains: string;\nexport default domains;\n");
  run("wasm-bindgen", ["native/target/wasm32-unknown-unknown/release/kitesurf_browser.wasm", "--target", "web", "--out-dir", staging]);
  const wasm = join(staging, "kitesurf_browser_bg.wasm");
  run("wasm-opt", [wasm, "-O3", "--enable-bulk-memory", "--enable-reference-types", "--enable-multivalue", "--enable-sign-ext", "--enable-nontrapping-float-to-int", process.env.KITESURF_PROFILE === "1" ? "-g" : "--strip-debug", "-o", wasm]);
  const source = await readFile(join(staging, "kitesurf_browser.js"), "utf8");
  /* Each browser gets its own Wasm instance, heap, globals, and generated binding caches. */
  await writeFile(join(staging, "factory.js"), `export function createBindings() {\n${source.replace(/^export \{[^}]*\};?$/gm, "").replace(/^export default /gm, "").replace(/^export /gm, "")}\nreturn { BrowserTab, initSync };\n}\n`);
  await writeFile(join(staging, "factory.d.ts"), `export function createBindings(): { BrowserTab: typeof import("./kitesurf_browser.js").BrowserTab; initSync: typeof import("./kitesurf_browser.js").initSync };\n`);
  const binary = await readFile(wasm);
  for (const file of await readdir(staging)) await rename(join(staging, file), join(".wrangler/browser", file));
  console.log(`WASM: browser ${binary.length} bytes (${gzipSync(binary).length} gzip).`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const environment = JSON.parse(await readFile(".wrangler/browser/toolchain.json", "utf8")) as Record<string, string>;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...environment } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed`);
}

run("cargo", ["build", "--manifest-path", "native/Cargo.toml", "--locked", "--release", "--target", "wasm32-unknown-unknown"]);
await mkdir(".wrangler/browser", { recursive: true });
const trackers = await readFile("vendor/obscura/crates/obscura-net/src/pgl_domains.txt", "utf8");
await writeFile(".wrangler/browser/trackers.js", "export default " + JSON.stringify(trackers) + ";\n");
await writeFile(".wrangler/browser/trackers.d.ts", "declare const domains: string;\nexport default domains;\n");
run("wasm-bindgen", ["native/target/wasm32-unknown-unknown/release/kitesurf_browser.wasm", "--target", "web", "--out-dir", ".wrangler/browser"]);
const source = await readFile(".wrangler/browser/kitesurf_browser.js", "utf8");
/* Each browser gets its own Wasm instance, heap, globals, and generated binding caches. */
await writeFile(".wrangler/browser/factory.js", `export function createBindings() {\n${source.replace(/^export \{[^}]*\};?$/gm, "").replace(/^export default /gm, "").replace(/^export /gm, "")}\nreturn { BrowserTab, initSync };\n}\n`);
await writeFile(".wrangler/browser/factory.d.ts", `export function createBindings(): { BrowserTab: typeof import("./kitesurf_browser.js").BrowserTab; initSync: typeof import("./kitesurf_browser.js").initSync };\n`);
const dom = await readFile(".wrangler/browser/kitesurf_browser_bg.wasm");
console.log(`WASM: browser ${dom.length} bytes (${gzipSync(dom).length} gzip).`);

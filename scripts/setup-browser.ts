import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { delimiter, resolve } from "node:path";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw new Error(command + " is required by task setup", { cause: result.error });
  if (result.status !== 0) throw new Error(command + " failed");
}

/** rust-toolchain.toml pins the compiler; the binding generator must match its crate. */
run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
const installed = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
if (installed.status !== 0 || installed.stdout.trim() !== "wasm-bindgen 0.2.128") {
  run("cargo", ["install", "wasm-bindgen-cli", "--version", "0.2.128", "--locked", "--force"]);
}

let pkgx = "pkgx";
const pkgxVersion = spawnSync(pkgx, ["--version"], { encoding: "utf8" });
if (pkgxVersion.status !== 0 || pkgxVersion.stdout.trim() !== "pkgx 2.11.0") {
  const hashes: Record<string, string> = {
    "linux+x86-64": "71284469ab59e86a8f61b33c76cf1d70d1a8eae4450e402868c326546ad43e1a",
    "linux+aarch64": "dad557767349ac87f051e4aab032640b472a868a480f55e1b3dce2a01fccd28e",
    "darwin+x86-64": "bff567fc907cde0a68c20533e7e01d1a6b971f10f019be9a7622483df1d58641",
    "darwin+aarch64": "411c013e2a9a2ad45a4cd2487e8e61fe96bd03129405d647201c5bb991242ac4",
  };
  const target = platform() + "+" + (arch() === "x64" ? "x86-64" : arch() === "arm64" ? "aarch64" : arch());
  if (!hashes[target]) throw new Error("Unsupported pkgx platform: " + target);
  const response = await fetch("https://github.com/pkgxdev/pkgx/releases/download/v2.11.0/" + encodeURIComponent("pkgx-2.11.0+" + target + ".tar.gz"));
  if (!response.ok) throw new Error("pkgx download failed: " + response.status);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== hashes[target]) throw new Error("pkgx checksum mismatch");
  const directory = resolve(".wrangler/browser/tools");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "pkgx.tar.gz");
  await writeFile(path, archive);
  run("tar", ["-xzf", path, "-C", directory]);
  pkgx = resolve(directory, "pkgx");
  await chmod(pkgx, 0o755);
}
const compiler = spawnSync(pkgx, ["--json=v2", "+llvm.org@23.1.1"], { encoding: "utf8" });
if (compiler.error || compiler.status !== 0) throw new Error("pkgx is required to install the pinned LLVM compiler", { cause: compiler.error });
const compilerEnv = JSON.parse(compiler.stdout).env as Record<string, string[]>;
const environment: Record<string, string> = {};
for (const [key, paths] of Object.entries(compilerEnv)) environment[key] = [...paths, ...(process.env[key] ? [process.env[key]!] : [])].join(delimiter);
const sysroot = resolve(process.env.CARGO_HOME || resolve(homedir(), ".cargo"), "rquickjs-wasi-sysroot/wasi-sysroot-24.0");
try { await access(resolve(sysroot, "include/wasm32-wasi/wasi/api.h")); }
catch {
  const response = await fetch("https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sysroot-24.0.tar.gz");
  if (!response.ok) throw new Error("WASI sysroot download failed: " + response.status);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== "35172f7d2799485b15a46b1d87f50a585d915ec662080f005d99153a50888f08") throw new Error("WASI sysroot checksum mismatch");
  await mkdir(sysroot, { recursive: true });
  const path = resolve(sysroot, "../wasi-sysroot-24.0.tar.gz");
  await writeFile(path, archive);
  run("tar", ["-xzf", path, "--strip-components", "1", "-C", sysroot]);
}
environment.RQUICKJS_WASM_SYSROOT = sysroot;
await mkdir(".wrangler/browser", { recursive: true });
await writeFile(".wrangler/browser/toolchain.json", JSON.stringify(environment));
run("cargo", ["fetch", "--manifest-path", "native/Cargo.toml", "--locked"]);

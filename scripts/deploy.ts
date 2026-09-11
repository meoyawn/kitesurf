import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse, type ParseError } from "jsonc-parser";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Deployment requires ${name}.`);
  return value;
}

function runWrangler(args: string[]): void {
  const result = spawnSync("nubx", ["wrangler", ...args], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Wrangler failed; deployment stopped.");
}

async function deploy(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const errors: ParseError[] = [];
  const config = parse(await readFile("wrangler.jsonc", "utf8"), errors);
  if (errors.length) throw new Error("wrangler.jsonc contains invalid JSONC.");
  // Local workerd and Wrangler dry runs do not enforce account-plan entitlements.
  if (config.limits !== undefined) {
    throw new Error("Kitesurf uses Cloudflare platform defaults for Workers Free compatibility. Remove limits from wrangler.jsonc; custom CPU and subrequest allowances are not part of this deployment contract.");
  }
  config.main = resolve(config.main);
  config.assets.directory = resolve(config.assets.directory);

  let ownerKeyHash: string | undefined;
  if (!values["dry-run"]) {
    required("CLOUDFLARE_API_TOKEN");
    const accountId = required("CLOUDFLARE_ACCOUNT_ID");
    const kvId = required("OAUTH_KV_ID");
    const publicOrigin = required("PUBLIC_ORIGIN");
    ownerKeyHash = required("OWNER_KEY_HASH");
    const url = new URL(publicOrigin);
    if (url.protocol !== "https:" || url.origin !== publicOrigin || url.hostname === "localhost") {
      throw new Error("PUBLIC_ORIGIN must be the exact public HTTPS origin without a trailing slash.");
    }
    if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9]{32}$/.test(kvId) ||
      !/^[a-f0-9]{64}$/.test(ownerKeyHash)) {
      throw new Error("Deployment IDs or OWNER_KEY_HASH have an invalid format.");
    }
    config.account_id = accountId;
    config.vars.PUBLIC_ORIGIN = publicOrigin;
    config.kv_namespaces[0].id = kvId;
  }

  await mkdir(".wrangler", { recursive: true });
  const temporary = await mkdtemp(resolve(".wrangler/deploy-"));
  try {
    const configPath = join(temporary, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    if (values["dry-run"]) {
      runWrangler(["deploy", "--config", configPath, "--dry-run", "--outdir", join(temporary, "bundle")]);
    } else {
      const secretPath = join(temporary, "secrets.json");
      await writeFile(secretPath, JSON.stringify({ OWNER_KEY_HASH: ownerKeyHash }), { mode: 0o600 });
      runWrangler(["deploy", "--config", configPath, "--secrets-file", secretPath]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await deploy();

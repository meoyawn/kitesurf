import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, test } from "vitest";

const deployScript = fileURLToPath(new URL("../scripts/deploy.ts", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kitesurf-deploy-test-"));
  const config = parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  return { directory, config };
}

function runDeploy(directory: string, args: string[]) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: directory + delimiter + process.env.PATH,
  };
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "OAUTH_KV_ID", "PUBLIC_ORIGIN", "OWNER_KEY_HASH"]) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [deployScript, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: environment,
  });
}

describe("deployment contract", function suite() {
  test.each([
    { cpu_ms: 300000, subrequests: 10000000 },
    { cpu_ms: 10 },
    { subrequests: 10000000 },
  ])("rejects unsupported overrides %j before validation or upload", async function limits(limits) {
    const { directory, config } = await fixture();
    try {
      config.limits = limits;
      await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(config));
      for (const args of [[], ["--dry-run"]]) {
        const result = runDeploy(directory, args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /platform defaults for Workers Free compatibility/);
        assert.doesNotMatch(result.stderr, /Deployment requires/);
        assert.deepEqual(await readdir(directory), ["wrangler.jsonc"]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([0, 1])("dry run needs no credentials and cleans up after Wrangler exits %i", async function dryRun(exitCode) {
    const { directory, config } = await fixture();
    try {
      await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(config));
      await writeFile(join(directory, "nubx"), `#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ["wrangler", "deploy", "--config"]);
assert.equal(args[4], "--dry-run");
assert.equal(args[5], "--outdir");
assert.equal(args.length, 7);
const config = JSON.parse(readFileSync(args[3], "utf8"));
assert.equal(config.limits, undefined);
assert.equal(config.account_id, undefined);
assert.equal(config.kv_namespaces[0].id, undefined);
assert.equal(config.vars.OWNER_KEY_HASH, undefined);
assert.ok(isAbsolute(config.main));
assert.ok(isAbsolute(config.assets.directory));
assert.deepEqual(readdirSync(dirname(args[3])), ["wrangler.json"]);
writeFileSync("invoked.json", JSON.stringify(args));
process.exit(${exitCode});
`, { mode: 0o700 });
      const result = runDeploy(directory, ["--dry-run"]);
      assert.equal(result.status, exitCode, result.stdout + result.stderr);
      const args: string[] = JSON.parse(await readFile(join(directory, "invoked.json"), "utf8"));
      assert.ok(args.includes("--dry-run"));
      assert.deepEqual(await readdir(join(directory, ".wrangler")), []);
      if (exitCode) assert.match(result.stderr, /Wrangler failed; deployment stopped/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a misspelled dry-run flag cannot fall through to deployment", function flags() {
    const result = runDeploy(tmpdir(), ["--dryrun"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option/);
  });
});

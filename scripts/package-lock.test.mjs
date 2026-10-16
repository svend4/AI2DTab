import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./with-app-env.mjs";

/**
 * `npm ci` refuses a lock file that does not match package.json, and it says so before any download, so the check needs
 * neither network nor a warm cache: an empty cache directory and `--offline` are enough.
 */
function npmCiDryRun(dir) {
  const cache = join(dir, ".npm-cache");
  mkdirSync(cache, { recursive: true });
  return spawnSync(
    "npm",
    ["ci", "--dry-run", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, npm_config_cache: cache },
    },
  );
}

function workspaceCopy() {
  const dir = mkdtempSync(join(tmpdir(), "lock-sync-"));
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(projectRoot(), name), join(dir, name));
  }
  return dir;
}

test("package-lock.json matches package.json: npm ci accepts it", () => {
  // A stale lock (ajv 6 at the root against an optional peer that wants ajv 8) made `npm ci` fail on a clean checkout.
  const r = npmCiDryRun(workspaceCopy());
  assert.equal(r.status, 0, `npm ci --dry-run failed:\n${String(r.stderr).slice(0, 1500)}`);
});

test("the check notices a dependency that the lock does not know", () => {
  const dir = workspaceCopy();
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies["left-pad"] = "^1.3.0";
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const r = npmCiDryRun(dir);
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /left-pad/);
});

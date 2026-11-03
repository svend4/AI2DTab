import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./with-app-env.mjs";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

test("npm test runs every src/**/*.test.ts", () => {
  // The src tests are listed by hand in package.json; a file left off the list never runs and never fails.
  const root = projectRoot();
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test;
  const missing = [...walk(join(root, "src"))]
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => relative(root, path))
    .filter((path) => !script.includes(path));
  assert.deepEqual(missing, []);
});

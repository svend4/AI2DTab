import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Инвариант 2 (engine/cards/PLAN-LOOPS.md, решение владельца): клиенту нельзя импортировать файлы `*.server.ts` и модули,
 * которые напрямую используют `fs`, `child_process` или `path`. Обёртки `createServerFn` разрешены: сборщик заменяет их
 * сетевыми вызовами, поэтому обход графа от клиентского кода на них останавливается.
 *
 * Клиентский код — маршруты (кроме `routes/api`) и компоненты. Обход идёт по статическим и динамическим импортам внутри `src`.
 */
const SRC = resolve(import.meta.dirname, "../src");
const NODE_BUILTINS = /^(node:)?(fs|fs\/promises|child_process|path)$/;
const SERVER_FILE = /(\.server\.(ts|tsx|mjs)|\/server\.ts)$/;
const IMPORT =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* нет такого файла */
    }
  }
  return null;
}

function specsOf(text) {
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
}

/** Файлы, до которых доходит клиентский код, без захода внутрь обёрток `createServerFn`. */
function clientGraph() {
  const roots = walk(join(SRC, "routes"))
    .filter((f) => !relative(join(SRC, "routes"), f).startsWith(`api${sep}`))
    .concat(walk(join(SRC, "components")));
  const seen = new Map();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    const wrapper = text.includes("createServerFn(");
    seen.set(file, { wrapper, text });
    if (wrapper) continue;
    for (const spec of specsOf(text)) {
      const target = resolveSpec(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

describe("инвариант 2: клиентский код не тянет серверные модули", () => {
  const graph = clientGraph();

  it("ни один файл клиентского графа не является серверным (*.server.ts, server.ts)", () => {
    const hits = [...graph.keys()].filter((f) => SERVER_FILE.test(f)).map((f) => relative(SRC, f));
    assert.deepEqual(hits, []);
  });

  it("ни один не-серверный файл клиентского графа не импортирует fs, child_process или path", () => {
    const hits = [];
    for (const [file, { wrapper, text }] of graph) {
      if (wrapper) continue;
      for (const spec of specsOf(text)) {
        if (NODE_BUILTINS.test(spec)) hits.push(`${relative(SRC, file)} → ${spec}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("клиентский граф достаёт обёртки createServerFn, а не серверные файлы напрямую", () => {
    const wrappers = [...graph.entries()]
      .filter(([, v]) => v.wrapper)
      .map(([f]) => relative(SRC, f));
    assert.ok(wrappers.includes(join("lib", "pm-api.ts")), wrappers.join(", "));
  });
});

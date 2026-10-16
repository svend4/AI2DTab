import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSnapshot } from "./desk-snapshot.mjs";

/**
 * Генератор снимка проверяем на временной копии движка с пустым столом: настоящая база не открывается и не меняется.
 */
const ENGINE = resolve(import.meta.dirname, "../engine");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-snap-"));
  for (const f of ["pm.py", "schema.sql", "seed.sql"]) copyFileSync(join(ENGINE, f), join(dir, f));
  execFileSync("python3", ["-B", "pm.py", "init"], { cwd: dir });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("снимок стола для опубликованного сайта (AUD-03, вариант 3)", () => {
  it("книга с датой: taken и три списка плюс раздел instr", () => {
    const snap = buildSnapshot({ engine: dir, taken: "2026-10-16" });
    assert.equal(snap.taken, "2026-10-16");
    for (const key of ["raw", "canon", "wires"]) assert.ok(Array.isArray(snap[key]), key);
    assert.equal(typeof snap.instr, "object");
  });

  it("папка без pm.py — понятная ошибка, а не пустой снимок", () => {
    assert.throws(() => buildSnapshot({ engine: join(dir, "нет"), taken: "2026-10-16" }), /pm\.py/);
  });

  it("дата не в формате YYYY-MM-DD — отказ до запуска движка", () => {
    assert.throws(() => buildSnapshot({ engine: dir, taken: "16.10.2026" }), /YYYY-MM-DD/);
  });
});

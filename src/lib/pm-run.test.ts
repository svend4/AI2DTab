import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPm } from "./pm-run.server.ts";

const ENGINE = resolve(import.meta.dirname, "../../engine");
const made: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function tapeDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("pm-tape-"));
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe("runPm: настоящий pm.py во временной папке", () => {
  let desk = "";
  let opts = {};

  before(async () => {
    desk = mkdtempSync(join(tmpdir(), "pm-desk-")); // общий для всех проверок группы: убираем один раз в after
    for (const n of ["pm.py", "schema.sql", "seed.sql"])
      copyFileSync(join(ENGINE, n), join(desk, n));
    opts = { script: join(desk, "pm.py"), cwd: desk };
    const r = await runPm(["init"], undefined, opts);
    assert.equal(r.code, 0, r.stderr);
  });

  after(() => rmSync(desk, { recursive: true, force: true }));

  it("выполняет команду и возвращает вывод", async () => {
    const r = await runPm(["exec", "STATUS"], undefined, opts);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /кластер/);
  });

  it("лента PLANT ложится во временный файл, и после запроса его нет", async () => {
    const before = tapeDirs();
    const r = await runPm(["exec", "PLANT"], "id\ttitle\nZ1\tлента из теста\n", opts);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /plant Z1/);
    assert.deepEqual(tapeDirs(), before);
    const raw = await runPm(["exec", "RAW"], undefined, opts);
    assert.match(raw.stdout, /Z1\t/);
  });

  it("ошибка движка — это ответ с кодом, а не исключение", async () => {
    const r = await runPm(["exec", "RUN", "нет-такого"], undefined, opts);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /нет/);
  });
});

describe("runPm: путь и права файла ленты", () => {
  it("каждый запрос — своя папка, файл 0600, пути /tmp/desk-tape.txt нет", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "echo.py");
    writeFileSync(
      script,
      [
        "import json, os, sys",
        "f = sys.argv[sys.argv.index('--file') + 1]",
        "print(json.dumps({'argv': sys.argv[1:], 'file': f, 'content': open(f, encoding='utf-8').read(),",
        "                  'mode': oct(os.stat(f).st_mode & 0o777), 'dirmode': oct(os.stat(os.path.dirname(f)).st_mode & 0o777)}))",
      ].join("\n"),
    );
    const o = { script, cwd: dir };
    const a = JSON.parse((await runPm(["exec", "PLANT"], "первая", o)).stdout);
    const b = JSON.parse((await runPm(["exec", "PLANT"], "вторая", o)).stdout);
    for (const x of [a, b]) {
      assert.deepEqual(x.argv.slice(0, 2), ["exec", "PLANT"]);
      assert.equal(x.argv[2], "--file");
      assert.match(x.file, /pm-tape-[^/]+\/tape\.txt$/);
      assert.equal(x.mode, "0o600");
      assert.equal(x.dirmode, "0o700");
      assert.equal(existsSync(x.file), false);
    }
    assert.equal(a.content, "первая");
    assert.equal(b.content, "вторая");
    assert.notEqual(a.file, b.file);
    assert.notEqual(a.file, "/tmp/desk-tape.txt");
  });

  it("одновременные запросы с лентой не затирают друг друга", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "slow-read.py");
    writeFileSync(
      script,
      [
        "import sys, time",
        "f = sys.argv[sys.argv.index('--file') + 1]",
        "time.sleep(0.4)", // за это время остальные запросы успевают записать свои ленты
        "print(open(f, encoding='utf-8').read())",
      ].join("\n"),
    );
    const n = 6;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        runPm(["exec", "PLANT"], `лента-${i}`, { script, cwd: dir }),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.stdout.trim()),
      Array.from({ length: n }, (_, i) => `лента-${i}`),
    );
  });

  it("без ленты в команду ничего не добавляется", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "argv.py");
    writeFileSync(script, "import json, sys\nprint(json.dumps(sys.argv[1:]))\n");
    const r = await runPm(["exec", "STATUS"], undefined, { script, cwd: dir });
    assert.deepEqual(JSON.parse(r.stdout), ["exec", "STATUS"]);
  });
});

describe("runPm: сбои процесса не роняют сервер", () => {
  it("нет интерпретатора — ответ engine_unavailable с кодом 127", async () => {
    const before = tapeDirs();
    const r = await runPm(["exec", "STATUS"], undefined, { python: "/нет/такого/python3" });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /^engine_unavailable/);
    const t = await runPm(["exec", "PLANT"], "лента", { python: "/нет/такого/python3" });
    assert.equal(t.code, 127);
    assert.deepEqual(tapeDirs(), before); // временную папку убрали и после сбоя
  });

  it("нет папки движка — тоже ответ, а не исключение", async () => {
    const r = await runPm(["exec", "STATUS"], undefined, { cwd: "/нет/такой/папки" });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /engine_unavailable/);
  });

  it("зависший процесс снимается по таймауту", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "sleep.py");
    writeFileSync(script, "import time\ntime.sleep(8)\n");
    const t0 = Date.now();
    const r = await runPm(["x"], undefined, { script, cwd: dir, timeoutMs: 300 });
    assert.notEqual(r.code, 0);
    assert.ok(Date.now() - t0 < 5000, `ждали ${Date.now() - t0} мс`);
  });

  it("процесс не ждёт ввода: стандартный ввод закрыт", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "stdin.py");
    writeFileSync(script, "import sys\nprint(len(sys.stdin.read()))\n");
    const r = await runPm(["x"], undefined, { script, cwd: dir, timeoutMs: 3000 });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "0");
  });

  it("запуск отклонён до начала (нулевой байт в аргументе): временная папка всё равно убрана", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "never.py");
    writeFileSync(script, "print('не должен запуститься')\n");
    const before = tapeDirs();
    await assert.rejects(runPm(["exec", "PLANT\0"], "лента", { script, cwd: dir }));
    assert.deepEqual(tapeDirs(), before);
  });

  it("вывод не копится сверх предела", async () => {
    const dir = tempDir("pm-fake-");
    const script = join(dir, "flood.py");
    writeFileSync(
      script,
      "import sys\nfor _ in range(2000): sys.stdout.write('x' * 1000); sys.stderr.write('e' * 1000)\n",
    );
    const r = await runPm(["x"], undefined, { script, cwd: dir, maxOut: 5000, maxErr: 700 });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5000 && r.stdout.length > 0, String(r.stdout.length));
    assert.ok(r.stderr.length <= 700 && r.stderr.length > 0, String(r.stderr.length));
  });
});

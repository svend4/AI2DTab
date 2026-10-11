import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute } from "./pm-exec.server.ts";
import type { Engine } from "./pm-exec.server.ts";
import type { PmRun } from "./pm-run.server.ts";

const USER = { id: "user-1" };

/** Подставной движок: помнит вызовы и отвечает заданным кодом. */
function fake(ready: boolean, answer: Partial<PmRun> = {}) {
  const calls: { argv: string[]; tape?: string }[] = [];
  const engine: Engine = {
    ready: () => ready,
    run: async (argv, tape) => {
      calls.push({ argv, tape });
      return { code: 0, stdout: "ok\n", stderr: "", ...answer };
    },
  };
  return { engine, calls };
}

describe("execute", () => {
  it("отказ разбора не доходит до движка и возвращает код отказа", async () => {
    const { engine, calls } = fake(true);
    const r = await execute({ line: "PLANT --file /etc/passwd" }, USER, engine);
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_token");
    assert.match(r.stderr, /дефис/);
    assert.deepEqual(calls, []);
  });

  it("анонимная запись — login_required, движок не трогаем", async () => {
    const { engine, calls } = fake(true);
    for (const line of ["TAKE RAW", "PURGE", "BATCH TAKE RAW; PURGE; REPAIR", "PLANT текст"]) {
      const r = await execute({ line }, null, engine);
      assert.equal(r.ok, false, line);
      assert.equal(r.code, "login_required", line);
    }
    assert.deepEqual(calls, []);
  });

  it("анонимное чтение выполняется и передаёт вывод как есть", async () => {
    const { engine, calls } = fake(true, { stdout: "строка\n", stderr: "предупреждение" });
    const r = await execute({ line: "raw" }, null, engine);
    assert.deepEqual(r, { ok: true, stdout: "строка\n", stderr: "предупреждение" });
    assert.deepEqual(calls, [{ argv: ["exec", "RAW"], tape: undefined }]);
  });

  it("анонимный посетитель базу не создаёт: нет базы — engine_unavailable", async () => {
    const { engine, calls } = fake(false);
    const r = await execute({ line: "CANON" }, null, engine);
    assert.equal(r.ok, false);
    assert.equal(r.code, "engine_unavailable");
    assert.deepEqual(calls, []);
  });

  it("вошедшему первая команда создаёт базу, если её нет", async () => {
    const { engine, calls } = fake(false);
    const r = await execute({ line: "STATUS" }, USER, engine);
    assert.equal(r.ok, true);
    assert.deepEqual(
      calls.map((c) => c.argv),
      [["init"], ["exec", "STATUS"]],
    );
  });

  it("лента идёт в движок только у PLANT, и это текст, а не путь", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "PLANT", tape: "id\ttitle\nB1\tx" }, USER, engine);
    assert.deepEqual(calls, [{ argv: ["exec", "PLANT"], tape: "id\ttitle\nB1\tx" }]);
    const bad = await execute({ line: "RAW", tape: "x" }, USER, engine);
    assert.equal(bad.code, "tape");
    assert.equal(calls.length, 1);
  });

  it("пустая лента — это нет ленты: файла не создаём", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "PLANT текст", tape: "" }, USER, engine);
    assert.deepEqual(calls, [{ argv: ["exec", "PLANT", "текст"], tape: undefined }]);
  });

  it("ошибка движка — ok: false без кода, сбой запуска — engine_unavailable", async () => {
    const a = await execute(
      { line: "RUN F001" },
      USER,
      fake(true, { code: 1, stderr: "нет F001" }).engine,
    );
    assert.deepEqual(a, { ok: false, stdout: "ok\n", stderr: "нет F001" });
    const b = await execute(
      { line: "STATUS" },
      USER,
      fake(true, { code: 127, stdout: "", stderr: "engine_unavailable: x" }).engine,
    );
    assert.equal(b.ok, false);
    assert.equal(b.code, "engine_unavailable");
  });

  it("поле file в запросе ни на что не влияет", async () => {
    const { engine, calls } = fake(true);
    const input = { line: "STATUS", file: "/etc/passwd" } as unknown as Parameters<
      typeof execute
    >[0];
    await execute(input, USER, engine);
    assert.deepEqual(calls, [{ argv: ["exec", "STATUS"], tape: undefined }]);
  });
});

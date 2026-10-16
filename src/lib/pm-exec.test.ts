import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute } from "./pm-exec.server.ts";
import type { Engine } from "./pm-exec.server.ts";
import type { PmRun } from "./pm-run.server.ts";
import type { PmInput } from "./pm-request.ts";

const USER = { id: "user-1", writer: true };
const READER = { id: "user-2", writer: false }; // вошёл, но не допущен к записи

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
  it("обрезку ответа движка (O8) сайт передаёт дальше: пометка с числами не теряется", async () => {
    const cut = { dropped: 402848, total: 2500000 };
    const { engine } = fake(true, { code: 0, stdout: "{}", stderr: "", cut });
    const r = await execute({ line: "JSON" }, null, engine);
    assert.deepEqual(r.cut, cut);
    const plain = await execute({ line: "JSON" }, null, fake(true).engine);
    assert.equal("cut" in plain, false);
  });

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

  it("вошедший без допуска: запись — not_writer, движок не трогаем", async () => {
    const { engine, calls } = fake(true);
    for (const line of [
      "TAKE RAW",
      "PURGE",
      "BATCH TAKE RAW; PURGE; REPAIR",
      "PLANT текст",
      "SPEC",
    ]) {
      const r = await execute({ line }, READER, engine);
      assert.equal(r.ok, false, line);
      assert.equal(r.code, "not_writer", line);
    }
    const tape = await execute({ line: "PLANT", tape: "id\ttitle\nB1\tx" }, READER, engine);
    assert.equal(tape.code, "not_writer");
    assert.deepEqual(calls, []);
  });

  it("вошедший без допуска читает, а базу не создаёт", async () => {
    const present = fake(true, { stdout: "канон\n" });
    const r = await execute({ line: "CANON" }, READER, present.engine);
    assert.deepEqual(r, { ok: true, stdout: "канон\n", stderr: "" });
    assert.deepEqual(present.calls, [{ argv: ["exec", "CANON"], tape: undefined }]);
    const absent = fake(false);
    const none = await execute({ line: "CANON" }, READER, absent.engine);
    assert.equal(none.code, "engine_unavailable");
    assert.deepEqual(absent.calls, []);
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
    assert.deepEqual(calls, [
      { argv: ["exec", "--actor", "web:user-1", "PLANT"], tape: "id\ttitle\nB1\tx" },
    ]);
    const bad = await execute({ line: "RAW", tape: "x" }, USER, engine);
    assert.equal(bad.code, "tape");
    assert.equal(calls.length, 1);
  });

  it("пустая лента — это нет ленты: файла не создаём", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "PLANT текст", tape: "" }, USER, engine);
    assert.deepEqual(calls, [
      { argv: ["exec", "--actor", "web:user-1", "PLANT", "текст"], tape: undefined },
    ]);
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

describe("кто записал (AUD-15)", () => {
  it("запись вошедшего писателя несёт его номер сразу после exec; номер из тела запроса не берётся", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "ACCEPT F001" }, USER, engine);
    await execute({ line: "ACCEPT F002", actor: "evil" } as unknown as PmInput, USER, engine);
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        ["exec", "--actor", "web:user-1", "ACCEPT", "F001"],
        ["exec", "--actor", "web:user-1", "ACCEPT", "F002"],
      ],
    );
    assert.ok(!JSON.stringify(calls).includes("evil"));
  });

  it("BATCH и PLANT с лентой тоже несут флаг сразу после exec; путь к ленте добавит сервер в конце", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "BATCH TAKE RAW; PURGE" }, USER, engine);
    await execute({ line: "PLANT", tape: "id\ttitle\nB1\tx" }, USER, engine);
    assert.deepEqual(
      calls.map((c) => c.argv.slice(0, 4)),
      [
        ["exec", "--actor", "web:user-1", "BATCH"],
        ["exec", "--actor", "web:user-1", "PLANT"],
      ],
    );
    assert.equal(calls[1].tape, "id\ttitle\nB1\tx");
  });

  it("номер писателя с чужими знаками отказывает до движка, и на пустом столе база не создаётся", async () => {
    const { engine, calls } = fake(false);
    const r = await execute({ line: "ACCEPT F001" }, { id: "bad id;", writer: true }, engine);
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_actor");
    assert.deepEqual(calls, []);
  });

  it("чтение и гость идут без флага, как прежде", async () => {
    const { engine, calls } = fake(true);
    await execute({ line: "CANON" }, READER, engine);
    await execute({ line: "RAW" }, null, engine);
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        ["exec", "CANON"],
        ["exec", "RAW"],
      ],
    );
  });
});

describe("опубликованный снимок: только чтение (AUD-03, вариант 3)", () => {
  it("запись отказывает до проверки допуска и не зовёт снимок, даже для допущенного", async () => {
    const { engine, calls } = fake(true);
    const snap = { ...engine, writable: false };
    for (const line of ["TAKE RAW", "PLANT текст", "PURGE", "BATCH TAKE RAW; PURGE"]) {
      const r = await execute({ line }, USER, snap);
      assert.equal(r.ok, false, line);
      assert.equal(r.code, "read_only", line);
    }
    assert.deepEqual(calls, []);
  });

  it("гость и вошедший без допуска получают «только чтение», а не «войдите»", async () => {
    const snap = { ...fake(true).engine, writable: false };
    for (const user of [null, READER]) {
      const r = await execute({ line: "TAKE RAW" }, user, snap);
      assert.equal(r.code, "read_only");
    }
  });

  it("чтение идёт в снимок для всех; ошибка разбора важнее режима", async () => {
    const { engine, calls } = fake(true, { stdout: "{}\n" });
    const snap = { ...engine, writable: false };
    const r = await execute({ line: "JSON" }, null, snap);
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].argv, ["exec", "JSON"]);
    const bad = await execute({ line: "PLANT --file /etc/passwd" }, USER, snap);
    assert.equal(bad.code, "bad_token");
  });

  it("живой движок пишет как прежде: режим не задан", async () => {
    const { engine, calls } = fake(true);
    const r = await execute({ line: "TAKE RAW" }, USER, engine);
    assert.notEqual(r.code, "read_only");
    assert.ok(calls.length > 0);
  });
});

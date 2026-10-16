import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeOutcome } from "./desk-writes.ts";
import type { PmReply } from "./pm-request.ts";

const done = (stdout: string): PmReply => ({ ok: true, stdout, stderr: "" });
const failed = (stderr: string, code: PmReply["code"] = "bad_args"): PmReply => ({
  ok: false,
  stdout: "",
  stderr,
  code,
});

describe("исход записи: ошибка движка", () => {
  it("ненулевой код — отказ с первой строкой ошибки движка", () => {
    const r = writeOutcome(failed("нет F001\nподробности"));
    assert.deepEqual(r, { ok: false, message: "Запись не выполнена: нет F001." });
  });

  it("сбой связи или движка — понятная фраза, не сырой текст", () => {
    const r = writeOutcome(failed("", "engine_unavailable"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /движок недоступен/);
  });
});

describe("исход записи: отказ при коде 0 (AUD-13)", () => {
  it("REFUSE в выводе при выходе 0 — это отказ, и строка видна", () => {
    const r = writeOutcome(done("ACCEPT C1 → refuse\nREFUSE C1 canon\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /Стол отказал: REFUSE C1 canon\./);
  });

  it("сводка набора с отказами — отказ с числом объектов", () => {
    const r = writeOutcome(done("ACCEPT NEQ ∩ RAW → ok=9 refuse=2 skip=0"));
    assert.deepEqual(r, { ok: false, message: "Стол отказал в 2 объектах." });
  });

  it("число склоняется: «в 1 объекте», «в 11 объектах»", () => {
    const one = writeOutcome(done("ACCEPT X → ok=0 refuse=1 skip=0"));
    assert.match(one.ok ? "" : one.message, /в 1 объекте\./);
    const eleven = writeOutcome(done("ACCEPT X → ok=0 refuse=11 skip=0"));
    assert.match(eleven.ok ? "" : eleven.message, /в 11 объектах\./);
  });
});

describe("исход записи: успех", () => {
  it("пустой вывод и пропуски (skip) — успех", () => {
    assert.deepEqual(writeOutcome(done("")), { ok: true });
    assert.deepEqual(writeOutcome(done("skip F001 already canon/raw\n")), { ok: true });
    assert.deepEqual(writeOutcome(done("ACCEPT NEQ ∩ RAW → ok=11 refuse=0 skip=0")), { ok: true });
  });

  it("отказ, найденный в середине многострочного вывода, всё равно виден", () => {
    const r = writeOutcome(done("# ACCEPT A1\nok\nREFUSE A2 superseded\n# ACCEPT A3\nok\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /REFUSE A2 superseded/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchAdded, writeOutcome } from "./desk-writes.ts";
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
    assert.deepEqual(r, { ok: false, message: "Стол отказал в 2 объектах; принято 9." });
  });

  it("число склоняется: «в 1 объекте», «в 11 объектах»", () => {
    const one = writeOutcome(done("ACCEPT X → ok=0 refuse=1 skip=0"));
    assert.match(one.ok ? "" : one.message, /в 1 объекте\./);
    const eleven = writeOutcome(done("ACCEPT X → ok=0 refuse=11 skip=0"));
    assert.match(eleven.ok ? "" : eleven.message, /в 11 объектах\./);
  });
});

describe("исход записи: успех", () => {
  it("пустой вывод и набор без пропусков — успех без пометки", () => {
    assert.deepEqual(writeOutcome(done("")), { ok: true });
    assert.deepEqual(writeOutcome(done("plant B1\nplant B2\nn=2\n")), { ok: true });
    assert.deepEqual(writeOutcome(done("ACCEPT NEQ ∩ RAW → ok=11 refuse=0 skip=0")), { ok: true });
  });

  it("пропуски (skip) — успех, но пользователь видит, что уже было в столе", () => {
    assert.deepEqual(writeOutcome(done("skip F001 already canon/raw\n")), {
      ok: true,
      note: "Пропущено 1, уже были в столе: F001.",
    });
  });

  it("отказ, найденный в середине многострочного вывода, всё равно виден", () => {
    const r = writeOutcome(done("# ACCEPT A1\nok\nREFUSE A2 superseded\n# ACCEPT A3\nok\n"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /REFUSE A2 superseded/);
  });
});

describe("исход записи: разбор ответа PLANT (AUD-43)", () => {
  it("добавленные и пропущенные объекты называются оба", () => {
    const r = writeOutcome(done("plant B1\nskip B2 already observation/raw\nn=2\n"));
    assert.deepEqual(r, {
      ok: true,
      note: "Добавлено 1. Пропущено 1, уже были в столе: B2.",
    });
  });

  it("лента, которая целиком уже есть в столе, не молчит", () => {
    const r = writeOutcome(
      done("skip B1 already observation/raw\nskip B2 already observation/raw\nn=2\n"),
    );
    assert.deepEqual(r, {
      ok: true,
      note: "Пропущено 2, уже были в столе: B1, B2.",
    });
  });

  it("длинный список пропусков сокращается до десяти и говорит, сколько осталось", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `B${i + 1}`);
    const out = ids.map((id) => `skip ${id} already observation/raw`).join("\n");
    const r = writeOutcome(done(out));
    assert.deepEqual(r, {
      ok: true,
      note: `Пропущено 12, уже были в столе: ${ids.slice(0, 10).join(", ")} и ещё 2.`,
    });
  });

  it("ACCEPT одного уже принятого объекта тоже сообщает о пропуске", () => {
    assert.deepEqual(writeOutcome(done("skip C1 already canon\n")), {
      ok: true,
      note: "Пропущено 1, уже были в столе: C1.",
    });
  });
});

describe("исход записи по набору: частичный успех и счёт пропусков (AUD-11, AUD-43)", () => {
  it("если часть принята, а часть отказана, сообщение называет оба числа", () => {
    const r = writeOutcome(
      done("REFUSE O2 status=rejected\nACCEPT NEQ ∩ RAW → ok=1 refuse=1 skip=0"),
    );
    assert.deepEqual(r, { ok: false, message: "Стол отказал в 1 объекте; принято 1." });
  });

  it("число пропусков берётся из сводки: строки печатаются только первые восемьдесят", () => {
    const r = writeOutcome(done("ACCEPT X → ok=0 refuse=0 skip=100\nskip A1 already canon\n"));
    assert.deepEqual(r, { ok: true, note: "Пропущено 100, уже были в столе: A1 и ещё 99." });
  });
});

describe("FETCH: строка в ленту только когда движок её завёл (AUD-43)", () => {
  it("новый вопрос — строка добавляется; пропуск уже открытого — нет", () => {
    assert.equal(fetchAdded({ ok: true, stdout: "FETCH Q-FETCH-001\n", stderr: "" }), true);
    assert.equal(
      fetchAdded({
        ok: true,
        stdout: "skip FETCH Q-FETCH-001 уже стоит: второй такой же вопрос не заводим\n",
        stderr: "",
      }),
      false,
    );
    assert.equal(fetchAdded({ ok: false, stdout: "FETCH Q-FETCH-002\n", stderr: "сбой" }), false);
  });
});

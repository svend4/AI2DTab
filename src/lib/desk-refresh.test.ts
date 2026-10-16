import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BAD_ACTOR_MESSAGE,
  LOGIN_MESSAGE,
  NOT_WRITER_MESSAGE,
  READ_ONLY_MESSAGE,
} from "./pm-request.ts";
import type { PmReply } from "./pm-request.ts";
import { applyBookReply, createSequencer, describeReply, parseBook } from "./desk-refresh.ts";
import type { BookSink } from "./desk-refresh.ts";

const BOOK = {
  instr: { charge: 24, pkt: 15 },
  raw: [
    {
      id: "F001",
      cluster: "C",
      layer: "2",
      type: "observation",
      title: "наблюдение",
      body: "тело",
      pred: "тип",
    },
  ],
  canon: [{ id: "D001", title: "решение" }],
  wires: [{ from: "F001", rel: "constrains", to: "D101", note: "" }],
};

/** Ответ моста: успешный или нет. */
const reply = (stdout: string): PmReply => ({ ok: true, stdout, stderr: "" });
const failed = (stderr: string, code: PmReply["code"] = "bridge"): PmReply => ({
  ok: false,
  stdout: "",
  stderr,
  code,
});

/** Запоминает, какой срез и с каким значением тронули. */
function recorder() {
  const calls: { name: string; arg: unknown }[] = [];
  const sink: BookSink = {
    setPlane: (rows) => calls.push({ name: "plane", arg: rows }),
    setCanon: (rows) => calls.push({ name: "canon", arg: rows }),
    setInstr: (instr) => calls.push({ name: "instr", arg: instr }),
    setWires: (wires) => calls.push({ name: "wires", arg: wires }),
    setNotice: (notice) => calls.push({ name: "notice", arg: notice }),
    setCut: (cut) => calls.push({ name: "cut", arg: cut }),
    setSnapshot: (taken) => calls.push({ name: "snapshot", arg: taken }),
  };
  return { sink, calls, names: () => calls.map((c) => c.name) };
}

describe("ответ с книгой стола (AUD-14)", () => {
  it("ответ с ошибкой не даёт книги и срезов не трогает, даже если в тексте есть книга", () => {
    const r = recorder();
    const out: PmReply = { ...failed("стол закрыт", "bad_args"), stdout: JSON.stringify(BOOK) };
    applyBookReply(parseBook(out), r.sink);
    assert.deepEqual(r.names(), ["cut", "notice"]);
    assert.match(String(r.calls.find((c) => c.name === "notice")?.arg), /стол закрыт/);
  });

  it("ok:true без строки книги — ошибка, а не пустой стол", () => {
    for (const stdout of ["", "RAW\nF001\tтекст\n", "просто текст\n"]) {
      const p = parseBook(reply(stdout));
      assert.equal(p.ok, false, JSON.stringify(stdout));
      const r = recorder();
      applyBookReply(p, r.sink);
      assert.deepEqual(r.names(), ["cut", "notice"], JSON.stringify(stdout));
    }
  });

  it("обрезанный JSON — ошибка с объяснением, срезы не трогаются", () => {
    const p = parseBook(reply('{"instr":{},"raw":[{"id":"F0'));
    assert.equal(p.ok, false);
    assert.match(p.ok ? "" : p.reason, /не читается/);
  });

  it("срез пропал или не того типа — ошибка, а не пустой список", () => {
    for (const stdout of [
      '{"instr":{},"canon":[],"wires":[]}',
      '{"instr":{},"raw":null,"canon":[],"wires":[]}',
      '{"instr":5,"raw":[],"canon":[],"wires":[]}',
      '{"instr":{},"raw":[],"canon":{},"wires":[]}',
      '{"instr":{},"raw":[1],"canon":[],"wires":[]}',
      '{"instr":{},"raw":[{"title":"без id"}],"canon":[],"wires":[]}',
      "[1,2]",
    ]) {
      assert.equal(parseBook(reply(stdout)).ok, false, stdout);
    }
  });

  it("пустая, но корректная книга — это книга: срезы применяются и уведомление снимается", () => {
    const r = recorder();
    applyBookReply(parseBook(reply('{"instr":{},"raw":[],"canon":[],"wires":[]}')), r.sink);
    assert.deepEqual(r.names(), ["plane", "canon", "instr", "wires", "snapshot", "cut", "notice"]);
    assert.equal(r.calls[4].arg, null);
  });

  it("полная книга: строки получают статус своего среза и значения по умолчанию, как прежде", () => {
    const p = parseBook(reply(JSON.stringify(BOOK)));
    assert.equal(p.ok, true);
    if (!p.ok) return;
    const [raw] = p.raw;
    assert.equal(raw.id, "F001");
    assert.equal(raw.status, "raw");
    assert.equal(raw.source, "sqlite");
    assert.equal(raw.pred, "тип");
    assert.equal(p.canon[0].status, "accepted");
    assert.equal(p.canon[0].title, "решение");
    assert.equal(p.canon[0].cluster, "C");
    assert.equal(p.canon[0].layer, "2");
    assert.equal(p.canon[0].type, "observation");
    assert.equal(p.canon[0].body, "");
    assert.deepEqual(p.wires, BOOK.wires);
    assert.deepEqual(p.instr, BOOK.instr);
  });

  it("при успехе применяются все срезы и уведомление снимается", () => {
    const r = recorder();
    applyBookReply(parseBook(reply(JSON.stringify(BOOK))), r.sink);
    assert.deepEqual(r.names(), ["plane", "canon", "instr", "wires", "snapshot", "cut", "notice"]);
    assert.equal(r.calls[4].arg, null);
  });
});

describe("ответ длиннее предела: обрезка названа числами, без баннера (O8)", () => {
  const cut = { dropped: 402848, total: 2500000 };
  const TEXT = "Ответ стола обрезан: обрезано 402848 из 2500000 байт. Показано прежнее состояние.";

  it("обрезанный ответ не разбирается, а пометка называет N и M; уведомления-баннера нет", () => {
    const r = recorder();
    const out: PmReply = { ...reply(JSON.stringify(BOOK)), cut };
    applyBookReply(parseBook(out), r.sink);
    assert.deepEqual(r.calls, [
      { name: "notice", arg: null },
      { name: "cut", arg: TEXT },
    ]);
  });

  it("успешный ответ снимает пометку обрезки", () => {
    const r = recorder();
    applyBookReply(parseBook(reply(JSON.stringify(BOOK))), r.sink);
    assert.deepEqual(
      r.calls.find((c) => c.name === "cut"),
      { name: "cut", arg: null },
    );
  });

  it("обычный сбой тоже снимает старую пометку, иначе она останется навсегда", () => {
    const r = recorder();
    applyBookReply(parseBook(failed("стол закрыт", "bad_args")), r.sink);
    assert.deepEqual(
      r.calls.find((c) => c.name === "cut"),
      { name: "cut", arg: null },
    );
  });
});

describe("ответ отстающего запроса не применяется (AUD-23)", () => {
  it("из двух запросов актуален только последний", () => {
    const seq = createSequencer();
    const first = seq.next();
    const second = seq.next();
    assert.equal(seq.isLatest(first), false);
    assert.equal(seq.isLatest(second), true);
  });
});

describe("тексты для пользователя", () => {
  it("коды отказа дают готовые тексты; сбой связи — русский текст без слова «bridge»", () => {
    assert.equal(describeReply(failed("x", "login_required")), LOGIN_MESSAGE);
    assert.equal(describeReply(failed("x", "not_writer")), NOT_WRITER_MESSAGE);
    assert.equal(describeReply(failed("x", "bad_actor")), BAD_ACTOR_MESSAGE);
    assert.match(describeReply(failed("x", "engine_unavailable")), /движок/);
    const link = describeReply(failed("Failed to fetch", "bridge"));
    assert.equal(link, "сервер не ответил, попробуйте ещё раз");
    assert.ok(!link.includes("bridge"));
  });

  it("прочий отказ движка — первая строка его ошибки", () => {
    assert.equal(describeReply(failed("нет F001\nподробности", "bad_args")), "нет F001");
  });
});

describe("модуль грузится под node и не тянет клиентские или серверные зависимости", () => {
  it("импорты только относительные; значения берутся лишь из pm-request.ts", () => {
    const src = readFileSync(new URL("./desk-refresh.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import [\s\S]*?;$/gm)].map((m) => m[0]);
    assert.ok(imports.length >= 3);
    for (const stmt of imports) {
      assert.doesNotMatch(stmt, /zustand|@\//, stmt);
      assert.ok(stmt.startsWith("import type ") || stmt.includes('from "./pm-request.ts"'), stmt);
    }
  });
});

describe("обрезка и ошибка движка: причина из stderr (O8)", () => {
  it("если движок вернул ошибку и обрезанный вывод, причина — из stderr, а не «обрезан»", () => {
    const out: PmReply = {
      ok: false,
      stdout: "…",
      stderr: "стол закрыт",
      code: "bad_args",
      cut: { dropped: 1, total: 2 },
    };
    const r = recorder();
    applyBookReply(parseBook(out), r.sink);
    assert.match(String(r.calls.find((c) => c.name === "notice")?.arg), /стол закрыт/);
  });
});

describe("снимок: дата из книги и текст для записи в снимке (AUD-03, O9)", () => {
  it("книга из снимка несёт дату, и успешное обновление её передаёт", () => {
    const r = recorder();
    applyBookReply(parseBook(reply(JSON.stringify({ ...BOOK, taken: "2026-10-16" }))), r.sink);
    assert.deepEqual(
      r.calls.find((c) => c.name === "snapshot"),
      {
        name: "snapshot",
        arg: "2026-10-16",
      },
    );
  });

  it("книга без даты (живой движок) — снимка нет", () => {
    const r = recorder();
    applyBookReply(parseBook(reply(JSON.stringify(BOOK))), r.sink);
    assert.deepEqual(
      r.calls.find((c) => c.name === "snapshot"),
      { name: "snapshot", arg: null },
    );
  });

  it("отказ «только чтение» говорит по-русски, без сырого кода", () => {
    assert.equal(
      describeReply({ ok: false, stdout: "", stderr: "", code: "read_only" }),
      READ_ONLY_MESSAGE,
    );
  });
});

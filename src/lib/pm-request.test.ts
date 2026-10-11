import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  VERBS,
  buildPmArgs,
  isSetExpr,
  kindOf,
  parsePmLine,
  verbKind,
} from "./pm-request.ts";
import type { PmInput, PmUser } from "./pm-request.ts";

const USER: PmUser = { id: "user-1" };
const ANON: PmUser = null;

function allowed(line: string, user: PmUser = USER, tape?: string) {
  const r = buildPmArgs({ line, tape }, user);
  assert.ok(r.ok, `ждали разрешения для «${line}», получили ${JSON.stringify(r)}`);
  return r;
}

function refused(line: string, code: string, user: PmUser = USER, tape?: string) {
  const r = buildPmArgs({ line, tape }, user);
  assert.equal(r.ok, false, `ждали отказа для «${line}», получили ${JSON.stringify(r)}`);
  if (!r.ok) {
    assert.equal(r.code, code, `«${line}»: ${r.message}`);
    assert.ok(r.message.length > 0);
  }
  return r;
}

describe("дыры сайта из docs/AUDIT.md, раздел 4.1", () => {
  it("--file в строке не доходит до движка ни в каком виде и ни у кого", () => {
    const lines = [
      "PLANT --file /etc/passwd",
      "CUT --file=/etc/passwd",
      "PLANT --fi /etc/passwd",
      "plant   --file   /etc/passwd",
      "PLANT –file /etc/passwd", // короткое тире
      "PLANT —file /etc/passwd", // длинное тире
      "PLANT −file /etc/passwd", // знак минус
      "PLANT －file /etc/passwd", // полноширинный дефис
      "PLANT ﹣file /etc/passwd", // малый дефис
      "--file /etc/passwd",
      "-x",
      "STATUS -h",
      "LOOK --help",
      "RAW --file x",
      "SET RAW \\ --file",
    ];
    for (const user of [USER, ANON]) {
      for (const line of lines) refused(line, "bad_token", user);
    }
  });

  it("поле file больше не существует: даже если его прислали, пути в argv нет", () => {
    const withFile = { line: "PLANT", tape: "id\ttitle\nB1\tx", file: "/etc/passwd" } as PmInput;
    const r = buildPmArgs(withFile, USER);
    assert.ok(r.ok);
    assert.deepEqual(r.argv, ["exec", "PLANT"]);
    assert.equal(r.tape, true);
    const traversal = { line: "PLANT", file: "/workspace/engine/../../etc/passwd" } as PmInput;
    refused(traversal.line, "bad_args", USER);
    assert.ok(!JSON.stringify(buildPmArgs(traversal, USER)).includes("etc/passwd"));
  });

  it("разрушающие и массовые глаголы без входа не проходят", () => {
    const lines = [
      "TAKE RAW",
      "TAKE C",
      "ACCEPT OBS",
      "ACCEPT F001",
      "FILL",
      "SWEEP",
      "PURGE",
      "REPAIR",
      "GAP",
      "SETTLE",
      "WIRE F001 D101 constrains",
      "PLANT текст",
      "FETCH",
      "RUN F001",
      "PROBE C A",
      "SPEC",
      "BATCH STATUS",
    ];
    for (const line of lines) refused(line, "login_required", ANON);
    for (const line of lines) allowed(line, USER);
  });

  it("BATCH не обходит таблицу: подкоманды проверяются каждая", () => {
    refused("BATCH TAKE RAW; PURGE; REPAIR", "login_required", ANON);
    const r = allowed("BATCH TAKE RAW; PURGE; REPAIR", USER);
    assert.deepEqual(r.argv, ["exec", "BATCH", "TAKE", "RAW", ";", "PURGE", ";", "REPAIR"]);
    assert.equal(r.kind, "bulk");
    refused("BATCH STATUS; PLANT --file /etc/passwd", "bad_token");
    refused("BATCH STATUS; SUPERSEDE a b", "unknown_verb");
    refused("BATCH STATUS; MUL A B", "unknown_verb");
    assert.match(refused("BATCH STATUS; BATCH STATUS", "bad_args").message, /внутри BATCH/);
    refused("BATCH ;;;", "bad_args");
    refused("BATCH", "bad_args");
    refused("BATCH STATUS; FETCH extra", "bad_args");
  });

  it("в BATCH не больше десяти подкоманд", () => {
    const ten = Array.from({ length: 10 }, () => "DUMP").join("; ");
    assert.equal(allowed(`BATCH ${ten}`).argv.filter((t) => t === ";").length, 9);
    refused(`BATCH ${ten}; DUMP`, "too_many");
    refused(`BATCH ${Array.from({ length: 700 }, () => "RAW").join("; ")}`, "too_many"); // 700 подкоманд в строке короче 4000 знаков
    refused(`BATCH ${Array.from({ length: 700 }, () => "DUMP").join("; ")}`, "too_long");
  });

  it("подкоманды можно разделять переводом строки", () => {
    assert.deepEqual(allowed("BATCH STATUS\nRAW\r\nCANON").argv, [
      "exec",
      "BATCH",
      "STATUS",
      ";",
      "RAW",
      ";",
      "CANON",
    ]);
  });

  it("в BATCH нет оператора \\ и кавычек: их иначе разберёт shlex в pm.py", () => {
    refused("BATCH TAKE RAW \\ NEQ", "bad_args");
    refused("BATCH SET RAW \\ NEQ", "bad_args");
    allowed("BATCH SET RAW MINUS NEQ"); // SET понимает слово-оператор
    allowed("BATCH SET RAW & NEQ");
    allowed("BATCH TAKE RAW & NEQ");
    refused("BATCH TAKE RAW MINUS NEQ", "bad_args"); // для TAKE/ACCEPT движок знает только знаки ∩ ∪ \\ & |
    refused("BATCH LOOK don't", "bad_args");
    refused('BATCH LOOK "x"', "bad_args");
  });

  it("лента — только для PLANT и только при входе", () => {
    const r = allowed("PLANT", USER, "id\ttitle\nB1\tx");
    assert.deepEqual(r.argv, ["exec", "PLANT"]);
    assert.equal(r.tape, true);
    assert.equal(allowed("CUT", USER, "x").verb, "PLANT"); // CUT с лентой — тот же PLANT, как и раньше
    refused("PLANT", "login_required", ANON, "x");
    refused("PLANT текст", "bad_args", USER, "x");
    refused("STATUS", "tape", USER, "x");
    refused("BATCH PLANT текст", "tape", USER, "x");
    refused("PLANT", "bad_args", USER); // ни ленты, ни текста
    refused("PLANT", "too_long", USER, "x".repeat(LIMITS.tape + 1));
    assert.equal(allowed("PLANT", USER, "x".repeat(LIMITS.tape)).tape, true);
    refused("PLANT", "bad_args", USER, ""); // пустая лента — то же, что её нет
  });
});

describe("границы строки", () => {
  it("пустая, пробельная и слишком длинная", () => {
    refused("", "empty");
    refused("   \t\n ", "empty");
    refused("STATUS " + "x".repeat(LIMITS.line), "too_long");
    assert.equal(parsePmLine({ line: undefined as unknown as string }).ok, false);
  });

  it("слишком много слов, неизвестный глагол, регистр", () => {
    refused(
      `LOOK ${Array.from({ length: LIMITS.lookWords + 1 }, (_, i) => `w${i}`).join(" ")}`,
      "bad_args",
    );
    refused("SET " + Array.from({ length: 13 }, (_, i) => `W${i}`).join(" "), "bad_args");
    refused("DROP TABLE objects", "unknown_verb");
    refused("MUL A B", "unknown_verb");
    refused("TIMES A B", "unknown_verb");
    refused("SUPERSEDE F001 BY F002", "unknown_verb");
    refused("constructor", "unknown_verb");
    refused("__proto__", "unknown_verb");
    refused("toString", "unknown_verb");
    assert.deepEqual(allowed("status").argv, ["exec", "STATUS"]);
    assert.deepEqual(allowed("Accept f001").argv, ["exec", "ACCEPT", "f001"]);
  });

  it("глагол с похожими знаками — не глагол", () => {
    refused("ACCEРТ F001", "unknown_verb"); // русская Р
    refused("ſtatus", "unknown_verb"); // длинная s, которая в верхнем регистре даёт S
    refused("ВАТСН STATUS", "unknown_verb");
    refused("STATUS\u0000", "bad_token");
    refused("STA\u0000TUS", "bad_token");
  });

  it("слишком длинный токен и спецзнаки в словах", () => {
    refused("RUN " + "a".repeat(65), "bad_args");
    for (const bad of [
      "a;b",
      'a"b',
      "a'b",
      "a`b",
      "a$(id)",
      "a\\b",
      "a<b",
      "a{b}",
      "a(b)",
      "a[b]",
    ]) {
      refused(`LOOK ${bad}`, "bad_args");
    }
    assert.deepEqual(allowed("LOOK Павлодар ≠ вакансии 2026").argv, [
      "exec",
      "LOOK",
      "Павлодар",
      "≠",
      "вакансии",
      "2026",
    ]);
  });
});

describe("правила глаголов", () => {
  const cases: [string, string[] | string, string?][] = [
    // чтение
    ["STATUS", ["exec", "STATUS"], "read"],
    ["STATUS now", "bad_args"],
    ["RAW", ["exec", "RAW"], "read"],
    ["CANON", ["exec", "CANON"], "read"],
    ["DUMP", ["exec", "DUMP"], "read"],
    ["JSON", ["exec", "JSON"], "read"],
    ["INSTR", ["exec", "INSTR"], "read"],
    ["GAUGE", ["exec", "GAUGE"], "read"],
    ["PANEL", ["exec", "PANEL"], "read"],
    ["MATRIX", ["exec", "MATRIX"], "read"],
    ["MATRIX A × B", "bad_args"],
    ["SET RAW", ["exec", "SET", "RAW"], "read"],
    ["SET RAW \\ NEQ", ["exec", "SET", "RAW", "\\", "NEQ"], "read"],
    ["SET RAW\\NEQ", ["exec", "SET", "RAW", "\\", "NEQ"], "read"],
    ["SET NEQ∩RAW", ["exec", "SET", "NEQ", "∩", "RAW"], "read"],
    ["SET A AND B", ["exec", "SET", "A", "AND", "B"], "read"],
    ["SET A and B", "bad_args"],
    ["SET NEQ ∩ RAW ∩ A", "bad_args"],
    ["SET", "bad_args"],
    ["VOCAB A ∩ B", ["exec", "VOCAB", "A", "∩", "B"], "read"],
    ["PORT C A", ["exec", "PORT", "C", "A"], "read"],
    ["PORT C", "bad_args"],
    ["PACKET", ["exec", "PACKET"], "read"],
    ["PACKET F001", ["exec", "PACKET", "F001"], "read"],
    ["PACKET C A", ["exec", "PACKET", "C", "A"], "read"],
    ["PACKET C A B", "bad_args"],
    ["CONC", ["exec", "CONC"], "read"],
    ["CONCORD foo", ["exec", "CONCORD", "foo"], "read"],
    ["CAT", ["exec", "CAT"], "read"],
    ["CAT LANG-FROM-DB.md", ["exec", "CAT", "LANG-FROM-DB.md"], "read"],
    ["CAT ../../etc/passwd", "bad_args"],
    ["CAT /etc/passwd", "bad_args"],
    ["CAT a b", "bad_args"],
    // запись по одному объекту
    ["ACCEPT F001", ["exec", "ACCEPT", "F001"], "write"],
    ["ACCEPT ont-S17320", ["exec", "ACCEPT", "ont-S17320"], "write"],
    ["ACCEPT", "bad_args"],
    ["ACCEPT F001 F002", "bad_args"],
    ["TAKE LF-budget-v1", ["exec", "TAKE", "LF-budget-v1"], "write"],
    ["RUN F001", ["exec", "RUN", "F001"], "write"],
    ["RUN", "bad_args"],
    ["RUN F001 F002", "bad_args"],
    ["FETCH", ["exec", "FETCH"], "write"],
    ["FETCH now", "bad_args"],
    ["WIRE F001 D101", ["exec", "WIRE", "F001", "D101"], "write"],
    ["WIRE F001 D101 constrains", ["exec", "WIRE", "F001", "D101", "constrains"], "write"],
    ["WIRE F001 D101 supersedes", "bad_args"],
    ["WIRE F001 D101 SUPERSEDES", "bad_args"],
    ["WIRE F001", "bad_args"],
    ["WIRE F001 D101 a b", "bad_args"],
    ["PROBE C A", ["exec", "PROBE", "C", "A"], "write"],
    ["PLANT два слова", ["exec", "PLANT", "два", "слова"], "write"],
    ["CUT два слова", ["exec", "PLANT", "два", "слова"], "write"],
    // массовые
    ["ACCEPT RAW", ["exec", "ACCEPT", "RAW"], "bulk"],
    ["ACCEPT raw", ["exec", "ACCEPT", "raw"], "bulk"],
    ["ACCEPT OBS", ["exec", "ACCEPT", "OBS"], "bulk"],
    ["ACCEPT NEQ ∩ RAW", ["exec", "ACCEPT", "NEQ", "∩", "RAW"], "bulk"],
    ["ACCEPT RAW∩NEQ", ["exec", "ACCEPT", "RAW", "∩", "NEQ"], "bulk"],
    ["ACCEPT ≠", ["exec", "ACCEPT", "≠"], "bulk"],
    ["ACCEPT NEQ ∩ RAW ∩ A", "bad_args"],
    ["TAKE RAW \\ NEQ", ["exec", "TAKE", "RAW", "\\", "NEQ"], "bulk"],
    ["TAKE RAW MINUS NEQ", "bad_args"],
    ["TAKE C", ["exec", "TAKE", "C"], "bulk"],
    ["FILL", ["exec", "FILL"], "bulk"],
    ["FILL RAW", "bad_args"],
    ["SWEEP", ["exec", "SWEEP"], "bulk"],
    ["SWEEP SESSION", "bad_args"],
    ["PURGE", ["exec", "PURGE"], "bulk"],
    ["REPAIR", ["exec", "REPAIR"], "bulk"],
    ["GAP", ["exec", "GAP"], "bulk"],
    ["SETTLE", ["exec", "SETTLE"], "bulk"],
    ["SPEC", ["exec", "SPEC"], "bulk"],
    ["BATCH STATUS; RAW", ["exec", "BATCH", "STATUS", ";", "RAW"], "bulk"],
  ];

  for (const [line, want, kind] of cases) {
    it(`«${line}»`, () => {
      if (typeof want === "string") {
        refused(line, want);
      } else {
        const r = allowed(line);
        assert.deepEqual(r.argv, want);
        assert.equal(r.kind, kind);
        assert.equal(kindOf({ line }), kind);
        // анонимному доступно ровно то, что относится к чтению
        const anon = buildPmArgs({ line }, ANON);
        assert.equal(anon.ok, kind === "read", `«${line}» без входа`);
      }
    });
  }

  it("verbKind: класс по первому слову, регистр не важен, чужого слова нет", () => {
    assert.equal(verbKind("canon"), "read");
    assert.equal(verbKind(" Plant "), "write");
    assert.equal(verbKind("PURGE"), "bulk");
    for (const [name, v] of Object.entries(VERBS)) assert.equal(verbKind(name), v.kind, name);
    for (const w of ["", "SUPERSEDE", "constructor", "__proto__", "toString", "hasOwnProperty"])
      assert.equal(verbKind(w), null, w);
  });

  it("kindOf не пускает то, что не прошло разбор", () => {
    assert.equal(kindOf({ line: "PLANT --file x" }), null);
    assert.equal(kindOf({ line: "" }), null);
  });
});

describe("таблица глаголов", () => {
  it("глаголы записаны заглавными латинскими буквами, у каждого есть класс и правило", () => {
    for (const [name, v] of Object.entries(VERBS)) {
      assert.match(name, /^[A-Z]{2,12}$/);
      assert.ok(["read", "write", "bulk"].includes(v.kind), name);
      assert.ok(v.rule.length > 0, name);
    }
  });

  it("глаголов чтения ровно столько, сколько ждёт движок; движок читает ими и не пишет", () => {
    const reads = Object.entries(VERBS)
      .filter(([, v]) => v.kind === "read")
      .map(([n]) => n)
      .sort();
    assert.deepEqual(reads, [
      "CANON",
      "CAT",
      "CELL",
      "CONC",
      "CONCORD",
      "DIFF",
      "DUMP",
      "GAUGE",
      "GRID",
      "INSTR",
      "JSON",
      "LOOK",
      "MATRIX",
      "NEQ",
      "PACKET",
      "PANEL",
      "PORT",
      "RAW",
      "SET",
      "STATUS",
      "VOCAB",
    ]);
  });

  it("сайту не отданы SUPERSEDE, MUL, TIMES и RANGE", () => {
    for (const name of ["SUPERSEDE", "MUL", "TIMES", "RANGE"])
      assert.equal(Object.hasOwn(VERBS, name), false, name);
  });

  it("BATCH, PLANT, PURGE и им подобные требуют входа", () => {
    for (const name of [
      "BATCH",
      "PLANT",
      "CUT",
      "ACCEPT",
      "TAKE",
      "FILL",
      "SWEEP",
      "PURGE",
      "REPAIR",
      "GAP",
      "SETTLE",
      "SPEC",
      "WIRE",
      "FETCH",
      "RUN",
      "PROBE",
    ]) {
      assert.notEqual(VERBS[name].kind, "read", name);
    }
  });

  it("isSetExpr совпадает с pm.py: is_set_expr", () => {
    const yes = [
      "RAW",
      "raw",
      "NEQ",
      "≠",
      "ne",
      "A",
      "d",
      "CANON",
      "SUPERSEDED",
      "SESSION",
      "OBS",
      "observation",
      "JUNK",
      "RAW \\ NEQ",
      "A∩B",
      "x|y",
      "x&y",
      "a ∪ b",
    ];
    const no = ["F001", "ont-S17320", "LF-x-v1", "", "  ", "E", "RAWS", "Q-GAP-JUNK"];
    for (const s of yes) assert.equal(isSetExpr(s), true, s);
    for (const s of no) assert.equal(isSetExpr(s), false, s);
  });
});

describe("случайные строки: в движок попадает только проверенное", () => {
  // Небольшой детерминированный генератор (mulberry32): сбой воспроизводится по номеру зерна.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pieces = [
    "STATUS",
    "status",
    "PLANT",
    "CUT",
    "ACCEPT",
    "TAKE",
    "BATCH",
    "FILL",
    "RAW",
    "NEQ",
    "A",
    "C",
    "∩",
    "∪",
    "\\",
    "&",
    "|",
    "AND",
    "MINUS",
    ";",
    "\n",
    " ",
    "-",
    "--file",
    "--file=/etc/passwd",
    "--fi",
    "'",
    '"',
    "`",
    "$(id)",
    "F001",
    "ont-S17320",
    "–",
    "—",
    "−",
    "－",
    "﹣",
    "LOOK",
    "SET",
    "VOCAB",
    "WIRE",
    "supersedes",
    "PORT",
    "CAT",
    "x",
    "y z",
    "\t",
    "\u0000",
    "\u200b",
    "ВАТСН",
    "ſtatus",
    "../../x",
    "/etc/passwd",
    "SUPERSEDE",
    "RUN",
    "DUMP",
    "≠",
    "текст",
    "}",
    "{",
    "(",
    ")",
    "<",
    ">",
  ];
  const DASH = /^[\p{Pd}−﹣－]/u;
  // eslint-disable-next-line no-control-regex -- управляющие знаки здесь и ищем
  const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f;"'`<>$]/u;

  it("20 000 строк: каждый разрешённый argv чист", () => {
    let allowedCount = 0;
    for (let seed = 1; seed <= 20_000; seed++) {
      const next = rng(seed);
      const n = 1 + Math.floor(next() * 9);
      let line = "";
      for (let i = 0; i < n; i++)
        line += pieces[Math.floor(next() * pieces.length)] + (next() < 0.7 ? " " : "");
      for (const user of [USER, ANON]) {
        const r = buildPmArgs({ line }, user);
        if (!r.ok) continue;
        allowedCount++;
        const where = `зерно ${seed}, строка ${JSON.stringify(line)}`;
        assert.equal(r.argv[0], "exec", where);
        assert.ok(Object.hasOwn(VERBS, r.argv[1]), where);
        assert.equal(r.argv[1], r.argv[1].toUpperCase(), where);
        if (!user) assert.equal(r.kind, "read", where);
        const isBatch = r.argv[1] === "BATCH";
        for (const tok of r.argv.slice(2)) {
          if (tok === ";") {
            assert.ok(isBatch, `«;» вне BATCH: ${where}`);
            continue;
          }
          assert.ok(!DASH.test(tok), `токен с дефисом ${JSON.stringify(tok)}: ${where}`);
          assert.ok(!BAD_CHARS.test(tok), `недопустимый знак в ${JSON.stringify(tok)}: ${where}`);
          assert.ok(tok.length > 0 && !/\s/u.test(tok), where);
          if (tok.includes("\\"))
            assert.ok(
              tok === "\\" && !isBatch,
              `обратная косая черта ${JSON.stringify(tok)}: ${where}`,
            );
        }
      }
    }
    assert.ok(allowedCount > 500, `генератор почти ничего не пропускает: ${allowedCount}`);
  });
});

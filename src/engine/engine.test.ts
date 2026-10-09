import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bookFromSeed, Desk, formula } from "./engine.ts";
import { parseCell } from "./cells.ts";
import { chunk, classify, plantText, plantTsv } from "./plant.ts";
import { evalSet, tokenize } from "./sets.ts";
import { readout } from "./instruments.ts";

const seed = JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8"));
const fresh = () => new Desk(bookFromSeed(seed));

test("ячейка: ≠ и новые отношения, ASCII-формы, мусорные ярлыки", () => {
  assert.deepEqual(parseCell("слово ≠ смысл"), { pred: "слово", rel: "≠", obj: "смысл" });
  assert.deepEqual(parseCell("But composite definition != current system instance."), { pred: "composite definition", rel: "≠", obj: "current system instance" });
  assert.deepEqual(parseCell("observation -> decision"), { pred: "observation", rel: "→", obj: "decision" });
  assert.deepEqual(parseCell("task ⊂ work item"), { pred: "task", rel: "⊂", obj: "work item" });
  assert.equal(parseCell("Critical invariant:"), null);
  assert.equal(parseCell("x ≠ y"), null, "стороны короче 2 символов — не ячейка");
  assert.equal(parseCell("Пример без отношения"), null);
});

test("нарезка: пустые строки, заголовки, кодовые блоки", () => {
  const t = "# 17042. Главный переход\nтекст\n\n```text\na\n\nb\n```\n\n## второй\nещё";
  const c = chunk(t);
  assert.equal(c.length, 3);
  assert.ok(c[1].includes("a\n\nb"), "кодовый блок не рвётся по пустой строке");
});

test("классификатор: ссылка, ход сессии, вопрос, ячейка в теле", () => {
  assert.equal(classify("https://example.org/x y").type, "artifact");
  assert.equal(classify("Да").type, "session");
  assert.equal(classify("Продолжение, на русском").type, "session");
  assert.equal(classify("Как это проверить?").type, "question");
  const cellInBody = classify("Critical invariant:\n```text\nOntology ≠ Policy.\n```");
  assert.equal(cellInBody.type, "observation");
  assert.equal(cellInBody.title, "Ontology ≠ Policy.");
  assert.equal(classify("Решено: дату считать 01.01.2027").type, "decision");
});

test("посадка идемпотентна и не сталкивает разные абзацы (баг v1)", () => {
  const d = fresh();
  const a = d.exec("PLANT первый текст\n\nвторой абзац с вопросом?");
  assert.ok(a.ok);
  assert.equal((a.data as any).planted.length, 2, "два абзаца → две строки, перенос строки не теряется");
  const b = d.exec("PLANT совсем другой текст\n\nдругой вопрос?");
  assert.equal((b.data as any).planted.length, 2, "второй PLANT не пропускается");
  const c = d.exec("PLANT первый текст\n\nвторой абзац с вопросом?");
  assert.equal((c.data as any).planted.length, 0);
  assert.equal((c.data as any).skipped.length, 2, "тот же абзац → тот же id → skip");
});

test("TSV v1 сажается как есть, секции держат номер", () => {
  const tsv = readFileSync("engine/samples/ont-l2.tsv", "utf8");
  const s = plantTsv(tsv);
  assert.equal(s.length, 36);
  assert.equal(s[0].id, "ont-S17041");
  const md = plantText("# 17042. Потому что одинаковое слово не гарантирует одинаковый смысл\nтело");
  assert.equal(md[0].id, "S17042");
});

test("алгебра множеств: приоритет, скобки, фильтры", () => {
  const d = fresh();
  d.exec("PLANT " + readFileSync("engine/samples/ont-l2.tsv", "utf8"));
  assert.deepEqual(tokenize("NEQ ∩ (RAW ∪ CANON) \\ C").map((t) => t.v), ["NEQ", "∩", "(", "RAW", "∪", "CANON", ")", "\\", "C"]);
  const neqRaw = evalSet(d.book, "NEQ ∩ RAW").ids;
  assert.ok(neqRaw.size > 0);
  const viaParens = evalSet(d.book, "(NEQ ∩ RAW) ∪ (NEQ ∩ CANON)").ids;
  assert.equal(viaParens.size, evalSet(d.book, "NEQ").ids.size);
  assert.equal(evalSet(d.book, "type:question ∩ A").ids.size, 3);
  assert.equal(evalSet(d.book, "ALL \\ C \\ A \\ B \\ D").ids.size, 0);
  assert.throws(() => evalSet(d.book, "NEQ ∩ (RAW"));
});

test("FILL принимает только ячейки; session — REFUSE; канон не вычитается", () => {
  const d = fresh();
  d.exec("PLANT " + readFileSync("engine/samples/ont-l2.tsv", "utf8"));
  const before = d.readout();
  const r = d.exec("FILL");
  assert.ok(r.ok);
  const after = d.readout();
  assert.equal(after.canon - before.canon, before.neq);
  assert.ok(d.exec("ACCEPT S001").text.startsWith("REFUSE"));
  assert.ok(d.exec("TAKE F001").text.startsWith("REFUSE"));
});

test("UNDO откатывает ACCEPT, PLANT и WIRE", () => {
  const d = fresh();
  d.exec("PLANT новый абзац для отката");
  const id = d.book.objects.at(-1)!.id;
  d.exec(`ACCEPT ${id}`);
  assert.equal(d.get(id)!.status, "canon");
  d.exec("UNDO");
  assert.equal(d.get(id)!.status, "raw");
  d.exec("UNDO");
  assert.equal(d.get(id), undefined);
  const n = d.book.links.length;
  assert.ok(d.exec("WIRE F001 F002 refines").ok);
  assert.equal(d.book.links.length, n + 1);
  d.exec("UNDO");
  assert.equal(d.book.links.length, n);
  assert.ok(d.book.events.some((e) => e.action === "UNDO"), "откат виден в журнале");
});

test("приборы и GAP/SETTLE замкнуты на правила, NEXT без зашитых id", () => {
  const d = fresh();
  d.exec("PLANT " + readFileSync("engine/samples/ont-l2.tsv", "utf8"));
  const r = readout(d.book);
  assert.ok(r.warns.includes("C без пакетов"));
  const g = d.exec("GAP");
  assert.ok(g.text.includes("Q-GAP-C-HOP"));
  assert.ok(d.get("Q-GAP-C-HOP"));
  d.exec("WIRE ont-S17042 D102 constrains");
  d.exec("SETTLE");
  assert.equal(d.get("Q-GAP-C-HOP")!.status, "closed");
  const nx = d.exec("NEXT").data as string[];
  assert.ok(nx.some((l) => l.includes("C-OS")), "открытый ярлык C найден по форме, не по id");
  assert.ok(nx.some((l) => l.includes("SP001")), "dormant signpost найден по форме");
});

test("формулы, SPEC, JSON, BATCH, MUL", () => {
  assert.equal(formula("COUNTIF(≠)"), "NEQ");
  assert.equal(formula("NEQ ∩ RAW"), "SET NEQ ∩ RAW");
  const d = fresh();
  const b = d.exec("BATCH STATUS; WIRE D001 F003 cites; INSTR");
  assert.ok(b.ok && b.wrote);
  assert.ok(!d.exec("MUL A B").ok);
  assert.ok(!d.exec("MATRIX A × B").ok);
  const s = d.exec("SPEC");
  assert.ok(s.text.includes("WIRE\t1\twrite"));
  const j = JSON.parse(d.exec("JSON").text);
  assert.equal(j.canon.length, d.readout().canon);
  assert.ok(d.exec("WHY D001").text.includes("рёбра:"));
  assert.ok(d.exec("HELP").text.includes("UNDO"));
});

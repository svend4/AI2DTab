import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bookFromSeed, Desk, formula } from "./engine.ts";
import { plantText } from "./plant.ts";
import { evalSet, tokenize, isSetExpr } from "./sets.ts";
import { readout } from "./instruments.ts";
import { normalizeBook } from "./validate.ts";
import { diffBooks, mergeBooks } from "./merge.ts";

const seed = JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8"));
const fresh = () => new Desk(bookFromSeed(seed));
const KIT = readFileSync("engine/samples/ont-l2.tsv", "utf8");

test("семя v1: объекты, рёбра, происхождение и письма сохраняются", () => {
  const d = fresh();
  assert.equal(d.book.objects.length, 31);
  assert.equal(d.book.links.length, 15);
  assert.equal(d.book.origins.length, 19);
  assert.equal(d.book.packets?.length, 1);
  assert.ok(d.exec("WHY P001").text.includes("письмо S001 → S002"));
});

test("посадка идемпотентна, разные абзацы не сталкиваются (баг v1), PLANT текстом держит абзацы", () => {
  const d = fresh();
  const a = d.exec("PLANT первый текст\n\nвторой абзац с вопросом?");
  assert.equal((a.data as any).planted.length, 2);
  assert.ok(a.wrote);
  const b = d.exec("PLANT совсем другой текст\n\nдругой вопрос?");
  assert.equal((b.data as any).planted.length, 2);
  const c = d.exec("PLANT первый текст\n\nвторой абзац с вопросом?");
  assert.equal((c.data as any).planted.length, 0);
  assert.equal((c.data as any).skipped.length, 2);
  assert.ok(d.exec("CUT ещё абзац").wrote, "CUT — тоже запись");
});

test("NEQ как в v1: только observation raw|canon; вычтенное не воскресает; ACCEPT NEQ∪x отказывает не-ячейке", () => {
  const d = fresh();
  d.exec("PLANT id\tcluster\tlayer\ttype\ttitle\tstatus\tbody\nX4\tC\t2\tquestion\tPolicy ≠ Ontology?\traw\t\nX7\tC\t2\tobservation\tEvent ≠ Claim\traw\t\nX8\tA\t1\tfact\tCapability ≠ Resource\traw\t\nX1\tC\t2\tobservation\tКороткий ярлык без ячейки\traw\tтело");
  assert.deepEqual([...evalSet(d.book, "NEQ").ids], ["X7"]);
  d.exec("TAKE X7");
  assert.equal(evalSet(d.book, "NEQ").ids.size, 0);
  assert.equal(readout(d.book).neq, 0);
  const r = d.exec("ACCEPT NEQ ∪ X1");
  assert.ok(r.text.includes("REFUSE X1 not-a-cell"));
  assert.equal(d.get("X1")!.status, "raw");
  assert.equal(evalSet(d.book, "C").ids.has("X7"), false, "вычтенное не входит в кластер");
});

test("JUNK/PURGE только ярлыки; REPAIR id возвращает любой канон в raw", () => {
  const d = fresh();
  d.exec("PLANT id\tcluster\tlayer\ttype\ttitle\tstatus\tbody\nX1\tC\t2\tobservation\tКороткий ярлык\traw\t\nX2\tC\t2\tobservation\tExample:\traw\t");
  assert.deepEqual([...evalSet(d.book, "JUNK").ids], ["X2"]);
  d.exec("PURGE");
  assert.equal(d.get("X1")!.status, "raw");
  assert.equal(d.get("X2")!.status, "rejected");
  d.exec("ACCEPT X1");
  assert.ok(d.exec("TAKE X1").text.startsWith("REFUSE"));
  assert.ok(d.exec("REPAIR X1").ok);
  assert.equal(d.get("X1")!.status, "raw");
});

test("алгебра множеств: приоритет, скобки, фильтры, минус словами и дефисом", () => {
  const d = fresh();
  d.exec("PLANT " + KIT);
  assert.deepEqual(tokenize("NEQ ∩ (RAW ∪ CANON) \\ C").map((t) => t.v), ["NEQ", "∩", "(", "RAW", "∪", "CANON", ")", "\\", "C"]);
  assert.equal(evalSet(d.book, "(NEQ ∩ RAW) ∪ (NEQ ∩ CANON)").ids.size, evalSet(d.book, "NEQ").ids.size);
  assert.equal(evalSet(d.book, "type:question ∩ A").ids.size, 3);
  assert.equal(evalSet(d.book, "RAW - C").ids.size, evalSet(d.book, "RAW \\ C").ids.size);
  assert.ok(isSetExpr("RAW - C") && isSetExpr("raw and neq") && !isSetExpr("Q-GAP-C-HOP"));
  assert.throws(() => evalSet(d.book, "NEQ ∩ (RAW"));
  assert.ok(d.exec("VOCAB (NEQ ∩ RAW) ∪ A").ok, "VOCAB понимает скобки");
});

test("FILL принимает только ячейки; session — REFUSE; machine не ставит канон", () => {
  const d = fresh();
  d.exec("PLANT " + KIT);
  const before = d.readout();
  assert.ok(before.neq > 11, "TSV-ячейки из тела тоже найдены");
  d.exec("FILL");
  assert.equal(d.readout().canon - before.canon, before.neq);
  assert.ok(d.exec("ACCEPT S001").text.startsWith("REFUSE"));
  d.exec("ACTOR machine");
  const r = d.exec("ACCEPT Q001");
  assert.ok(!r.ok && r.text.includes("machine cannot canon"));
  assert.equal(d.book.events.at(-1)!.actor, "machine:exec");
  assert.ok(d.exec("TAKE Q001").ok, "машина может вычитать raw/open");
  d.exec("ACTOR human");
});

test("UNDO откатывает ход целиком и оставляет события в журнале", () => {
  const d = fresh();
  d.exec("PLANT " + KIT);
  const canon0 = d.readout().canon;
  d.exec("FILL");
  assert.ok(d.readout().canon > canon0);
  d.exec("UNDO");
  assert.equal(d.readout().canon, canon0, "весь FILL откачен одним UNDO");
  assert.ok(d.book.events.some((e) => e.action === "ACCEPT" && e.undone));
  d.exec("PLANT а1\n\nа2\n\nа3");
  const n = d.book.objects.length;
  d.exec("UNDO");
  assert.equal(d.book.objects.length, n - 3);
  d.exec("FETCH пакет ≠ сделка");
  const id = (d.book.objects.at(-1) as any).id as string;
  d.exec(`ACCEPT ${id}`);
  d.exec("UNDO");
  assert.equal(d.get(id)!.status, "raw");
  assert.equal(d.get(id)!.pred, undefined, "после отката ACCEPT штамп ячейки снят");
  assert.equal(evalSet(d.book, "CELL").ids.has(id), false);
  const links = d.book.links.length;
  d.exec("BATCH WIRE F001 F002 refines; WIRE F003 F004 cites");
  assert.equal(d.book.links.length, links + 2);
  d.exec("UNDO");
  assert.equal(d.book.links.length, links, "BATCH — один ход");
});

test("FETCH не сталкивает id в одну секунду; BATCH останавливается на ошибке", () => {
  const d = fresh();
  const r = d.exec("BATCH FETCH первый; FETCH второй");
  assert.ok(r.ok);
  const ids = d.book.objects.filter((o) => o.id.startsWith("Q-FETCH")).map((o) => o.id);
  assert.equal(new Set(ids).size, 2);
  const n = d.book.objects.length;
  const bad = d.exec("BATCH ACCEPT NOPE; FETCH третий");
  assert.ok(!bad.ok);
  assert.equal(d.book.objects.length, n, "шаг после ошибки не выполнен");
  assert.ok(d.exec("BATCH PLANT первый абзац\n\nвторой абзац; INSTR").ok, "многострочный PLANT внутри BATCH не рвётся");
});

test("GAP повторно открывает закрытый вопрос, когда правило снова живо; NEXT без зашитых id", () => {
  const d = fresh();
  d.exec("PLANT " + KIT);
  assert.ok(readout(d.book).warns.includes("C без пакетов"));
  d.exec("GAP");
  assert.ok(d.get("Q-GAP-C-HOP"));
  d.exec("WIRE ont-S17042 D102 constrains");
  d.exec("SETTLE");
  assert.equal(d.get("Q-GAP-C-HOP")!.status, "closed");
  d.exec("UNWIRE ont-S17042 D102 constrains");
  const g = d.exec("GAP");
  assert.ok(g.text.includes("снова открыт"));
  assert.equal(d.get("Q-GAP-C-HOP")!.status, "raw");
  const nx = d.exec("NEXT").data as string[];
  assert.ok(nx.some((l) => l.includes("C-OS")));
  assert.ok(nx.some((l) => l.includes("SP001")));
  d.exec("TAKE C");
  assert.ok(!readout(d.book).warns.includes("перекос C"), "вычтенный кластер не поднимает красную зону");
});

test("CHAIN, TURN, PORT по NEQ, GRID с прочими статусами, MATRIX exact не MUL", () => {
  const d = fresh();
  d.exec("PLANT # you asked\n\nДа\n\n# chatgpt response\n\nсобытие ≠ утверждение\n\nутверждение ≠ факт");
  const c = d.exec("CHAIN");
  assert.ok(c.text.includes("WIRE"), "obj первой = pred второй");
  assert.ok(d.exec("TURN").text.includes("ходов"));
  assert.equal((d.exec("TURN 2").data as string[]).length, 2);
  assert.ok(d.exec("PORT C A").text.includes("LEFT NEQ"));
  assert.ok(d.exec("GRID").text.includes("/3o") || d.exec("GRID").text.includes("o\t"));
  assert.ok(d.exec("MATRIX exact").ok);
  assert.ok(!d.exec("MATRIX A × B").ok);
});

test("normalizeBook: прототипное загрязнение, мусорные кластеры и id, отсутствующие массивы", () => {
  const { book, warnings } = normalizeBook({ version: 2, objects: [{ id: "RAW", cluster: "__proto__", title: "x" }, { id: "a b;PURGE", status: "weird" }, { id: "ok", cluster: "A" }], links: [{ from: "ok", to: "nope", rel: "cites" }], events: [{ action: "x" }] });
  assert.equal(book.objects[0].id, "RAW-id");
  assert.equal(book.objects[0].cluster, "C");
  assert.equal(book.objects[1].id, "a_b_PURGE");
  assert.equal(book.objects[1].status, "raw");
  assert.equal(book.links.length, 0);
  assert.ok(Array.isArray(book.origins));
  assert.ok(warnings.length >= 4);
  const r = readout(book);
  assert.equal(typeof Object.prototype.toString, "function", "прототип не тронут");
  assert.ok(r.objects === 3);
  assert.equal(normalizeBook("garbage").warnings[0].startsWith("не книга"), true);
  const re = normalizeBook({ version: 2, objects: [{ id: "a b" }, { id: "RAW" }, { id: "ok" }, { id: "X" }, { id: "X" }, { id: "X-2", title: "real X-2" }], links: [{ from: "a b", to: "ok", rel: "cites" }, { from: "RAW", to: "ok", rel: "cites" }, { from: "X-2", to: "ok", rel: "cites" }], origins: [{ objectId: "a b", sessionId: "S1" }], events: [] });
  assert.deepEqual(re.book.links.map((l) => l.from), ["a_b", "RAW-id", "X-2"], "рёбра переназначены на новые id");
  assert.ok(re.book.objects.some((o) => o.id === "X-2" && o.title === "real X-2"), "настоящий X-2 не вытеснен дубликатом X");
  assert.ok(re.book.objects.some((o) => o.id === "X-3"), "дубликат X получил свободный суффикс");
  assert.equal(re.book.origins[0].objectId, "a_b");
});

test("уплотнение не трогает текущий ход: UNDO большой посадки полный", () => {
  const d = new Desk();
  const big = Array.from({ length: 5300 }, (_, i) => `абзац номер ${i} со своим текстом`).join("\n\n");
  d.exec("PLANT " + big);
  assert.equal(d.book.objects.length, 5300);
  d.exec("UNDO");
  assert.equal(d.book.objects.length, 0, "все 5300 записей откачены");
  assert.equal(d.book.origins.length, 0);
});

test("MERGE: чужая история без номеров ходов; UNDO сразу после MERGE отказывает; машина не поднимает канон", () => {
  const a = fresh();
  const b = fresh();
  b.exec("ACCEPT Q003");
  a.exec("ACCEPT Q001");
  a.exec("MERGE " + JSON.stringify(b.book));
  assert.ok(a.book.events.filter((e) => e.detail?.includes("(merged)")).every((e) => e.move === undefined && e.before === undefined));
  assert.ok(a.exec("UNDO").text.startsWith("MERGE не откатывается"));
  assert.equal(a.get("Q001")!.status, "canon", "свой ход не задет");
  a.exec("WIRE D001 F003 cites");
  assert.ok(a.exec("UNDO").text.includes("WIRE"), "после нового хода UNDO откатывает только его");
  assert.equal(a.get("Q003")!.status, "canon");
  const c = fresh();
  c.exec("ACTOR machine");
  c.exec("MERGE " + JSON.stringify(b.book));
  assert.equal(c.get("Q003")!.status, "open", "под машиной статусы базы сохранены");
  const m = fresh();
  m.exec("ACCEPT Q001");
  m.exec("REPAIR Q001");
  m.exec("ACTOR machine");
  assert.ok(m.exec("UNDO").text.includes("REFUSE"));
  assert.equal(m.get("Q001")!.status, "raw");
});

test("посадка идемпотентна и после развода суффиксом; BATCH с английскими строками; read() не двигает ход", () => {
  const d = new Desk();
  const heads = Array.from({ length: 20 }, (_, i) => `# ${i + 1}. Секция ${i}\n\nтело ${i}\n`).join("\n");
  const other = Array.from({ length: 20 }, (_, i) => `# ${i + 1}. Секция ${i}\n\nдругое тело ${i}\n`).join("\n");
  d.exec("PLANT " + heads);
  d.exec("PLANT " + other);
  assert.equal(d.book.objects.length, 40);
  const r = d.exec("PLANT " + other);
  assert.equal((r.data as any).planted.length, 0, "повтор текста с суффиксными id пропущен");
  const b = d.exec("BATCH PLANT first paragraph here\n\nsecond paragraph there; INSTR");
  assert.ok(b.ok);
  assert.ok(d.book.objects.some((o) => o.title === "second paragraph there"), "английская строка не потеряна");
  const before = d.book.events.at(-1)!.move!;
  d.read("NEXT"); d.read("SPEC"); d.read("CHAIN");
  assert.ok(!d.read("ACCEPT S1").ok, "read не пишет");
  d.exec("WIRE S1 S2 cites");
  assert.equal(d.book.events.at(-1)!.move, before + 1, "номера ходов сплошные");
});

test("вычтенное липкое при слиянии; рёбра к вычтенному не спасают от сиротства; and-1 — это id; ACTOR переживает перезапуск", () => {
  const a = fresh();
  const older = JSON.parse(JSON.stringify(a.book));
  a.exec("TAKE Q001");
  a.exec("MERGE " + JSON.stringify(older));
  assert.equal(a.get("Q001")!.status, "rejected");
  const d = new Desk();
  d.exec("PLANT id\tcluster\tlayer\ttype\ttitle\tstatus\tbody\nX\tA\t1\tfact\tфакт икс\traw\t\nY\tB\t1\tfact\tфакт игрек\traw\t\nand-1\tC\t2\tobservation\tстранный id\traw\t");
  d.exec("ACCEPT X"); d.exec("WIRE X Y cites"); d.exec("TAKE Y");
  const r = readout(d.book);
  assert.equal(r.packets, 0); assert.equal(r.orphans, 1);
  assert.deepEqual(tokenize("and-1").map((t) => t.k), ["name"]);
  assert.ok(d.exec("WHY and-1").ok);
  d.exec("ACTOR machine");
  const d2 = new Desk(JSON.parse(JSON.stringify(d.book)));
  assert.equal(d2.actor, "machine");
});

test("MERGE/DIFFBOOK: канон побеждает, рёбра объединяются, события дописываются", () => {
  const a = fresh();
  const b = fresh();
  b.exec("PLANT новый абзац во второй книге");
  b.exec("ACCEPT Q001");
  b.exec("WIRE Q001 F002 cites");
  const diff = diffBooks(a.book, b.book);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.changed[0].id, "Q001");
  assert.equal(diff.linksAdded.length, 1);
  const r = a.exec("MERGE " + JSON.stringify(b.book));
  assert.ok(r.ok && r.wrote);
  assert.equal(a.get("Q001")!.status, "canon");
  assert.equal(a.book.objects.length, 32);
  assert.ok(a.book.links.some((l) => l.from === "Q001" && l.to === "F002"));
  assert.ok(a.book.events.some((e) => e.detail?.includes("(merged)")));
  const m2 = mergeBooks(a.book, b.book);
  assert.equal(m2.report.added, 0, "повторное слияние ничего не добавляет");
  assert.equal(m2.book.events.length, a.book.events.length, "и не удваивает журнал");
  assert.ok(a.exec("DIFFBOOK " + JSON.stringify(b.book)).text.startsWith("DIFFBOOK added=0"));
});

test("формулы, SPEC, JSON, HELP, журнал уплотняется", () => {
  assert.equal(formula("COUNTIF(≠)"), "NEQ");
  assert.equal(formula("NEQ ∩ RAW"), "SET NEQ ∩ RAW");
  const d = fresh();
  d.exec("WIRE D001 F003 cites");
  d.exec("UNDO");
  const s = d.exec("SPEC");
  assert.ok(s.text.includes("WIRE\t0\twrite\t1"), "откаченный WIRE виден как undone");
  const j = JSON.parse(d.exec("JSON").text);
  assert.equal(j.actor, "human");
  assert.ok(d.exec("HELP").text.includes("MERGE"));
  for (let i = 0; i < 5200; i++) {
    d.exec("WIRE D001 F003 cites");
    d.exec("UNWIRE D001 F003 cites");
  }
  d.exec("STATUS"); // уплотнение — в начале следующего хода
  assert.ok(d.book.events.length <= 5001, `events=${d.book.events.length}`);
  assert.ok((d.book.compacted?.WIRE ?? 0) > 0);
  assert.equal(d.book.events[0].action, "seed");
});

test("плоскость корпуса: posting 400 КБ корпуса не оставляет гигантов и даёт секции", () => {
  const md = readFileSync("attachments/ChatGPT_2026_09_18__1900.md", "utf8").slice(0, 400_000);
  const s = plantText(md);
  assert.ok(s.some((x) => x.kind === "section"));
  assert.ok(s.length > 1000);
});

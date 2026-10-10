import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { chunk, chunkDetailed, classify, plantText, plantTsv } from "./plant.ts";
import { parseCell, flattenCellBlock, isLabel } from "./cells.ts";
import { fnv1a, normalizeForHash } from "./hash.ts";

test("цитаты снимаются, линии и маркеры ходов не становятся записями, ход считается", () => {
  const t = "# you asked\n\nДа\n\n# chatgpt response\n\n> Первый абзац.\n>\n> ---\n>\n> Второй абзац.\n";
  const c = chunkDetailed(t);
  assert.deepEqual(c.map((x) => x.text), ["Да", "Первый абзац.", "Второй абзац."]);
  assert.deepEqual(c.map((x) => x.turn), [1, 2, 2]);
});

test("однострочный ``` … ``` не открывает кодовый блок навсегда (баг v2.0)", () => {
  const s = plantText("Critical invariant:\n```Ontology ≠ Policy```\n\nвторой абзац\n\nтретий абзац");
  assert.equal(s.length, 3);
  assert.equal(s[0].title, "Ontology ≠ Policy");
});

test("ярлык + кодовый блок → один блок; блок с ячейкой столбиком → ячейка", () => {
  const s = plantText("Например:\n\n```text\nProject\n```\n\nДалее.\n\n```text\nimplements\n≠\nconforms\n```");
  assert.equal(s.length, 3);
  assert.ok(s[0].body.includes("Project"), "ярлык не оторван от блока");
  assert.equal(s[2].why, "ячейка найдена в теле");
  assert.deepEqual(parseCell(s[2].title), { pred: "implements", rel: "≠", obj: "conforms" });
  assert.equal(flattenCellBlock("```text\nWorld State t1\nvs\nWorld State t2\n```"), "World State t1 vs World State t2");
});

test("классы code / label; вопрос внутри блока; решение по маркеру", () => {
  assert.equal(classify("```text\nSelect tactile sensing architecture\n```").type, "code");
  assert.equal(classify("```text\nSelect tactile sensing architecture\n```").title, "Select tactile sensing architecture");
  assert.equal(classify("Всё это относится к кластеру:").type, "label");
  assert.equal(classify("```text\nПочему эти шаги?\n```").type, "question");
  assert.equal(classify("Kafka не нужен на старте.").type, "decision");
  assert.equal(classify("Use Pydantic Settings.").type, "decision");
  assert.ok(isLabel("Expected:"));
  assert.ok(!isLabel("Ontology ≠ Policy:"));
});

test("режим секций: # N. открывает секцию до следующего заголовка, номер уходит из заголовка", () => {
  const heads = Array.from({ length: 25 }, (_, i) => `# ${100 + i}. Секция ${i}\n\nтело ${i}\n\n---\n`).join("\n");
  const s = plantText(heads);
  assert.equal(s.length, 25);
  assert.equal(s[0].id, "S100");
  assert.equal(s[0].title, "Секция 0");
  assert.ok(s[0].body.includes("тело 0"));
  assert.equal(s[0].kind, "section");
  // та же секция с другим телом → развод суффиксом, не пропуск
  const dup = plantText(heads + "\n# 100. Секция 0\n\nсовсем другое тело\n");
  assert.equal(dup.length, 26);
  assert.equal(dup[25].id, "S100-2");
});

test("хеш: 10 символов, маркеры только на границах, дефис внутри слова различает", () => {
  assert.equal(fnv1a("x").length, 10);
  assert.notEqual(normalizeForHash("re-use ≠ copy"), normalizeForHash("reuse ≠ copy"));
  assert.equal(normalizeForHash("- **Ontology** ≠ Policy"), normalizeForHash("ontology ≠ policy"));
  const a = plantText("re-use ≠ copy\n\nreuse ≠ copy");
  assert.equal(a.length, 2);
});

test("ячейка: =, склеенная →, маркеры списка, ReDoS-устойчивость", () => {
  assert.deepEqual(parseCell("task = work item"), { pred: "task", rel: "=", obj: "work item" });
  assert.equal(parseCell("a == b"), null);
  assert.deepEqual(parseCell("слово→смысл"), { pred: "слово", rel: "→", obj: "смысл" });
  assert.equal(parseCell("observation->decision"), null, "ASCII-стрелка требует пробелов");
  assert.deepEqual(parseCell("- **Ontology** ≠ Policy"), { pred: "Ontology", rel: "≠", obj: "Policy" });
  assert.deepEqual(parseCell("the system ≠ a model"), { pred: "system", rel: "≠", obj: "a model" }, "артикль снимается только у pred (как в v1)");
  const t0 = performance.now();
  parseCell("a" + " ".repeat(200_000) + "b");
  parseCell("a b" + " ".repeat(200_000) + "c ≠ d");
  assert.ok(performance.now() - t0 < 200, "длинные пробелы не квадратичны");
});

test("TSV: ячейка из тела для ярлыков-обёрток, небезопасные id чинятся", () => {
  const tsv = readFileSync("engine/samples/ont-l2.tsv", "utf8");
  const s = plantTsv(tsv);
  assert.equal(s.length, 36);
  const inv = s.find((x) => x.id === "ont-S17142")!;
  assert.equal(inv.title, "Ontology ≠ Policy.");
  assert.equal(inv.why, "tsv: ячейка из тела");
  const bad = plantTsv("id\ttitle\nX; PURGE\tsafe\nRAW\tx");
  assert.equal(bad[0].id, "X_PURGE");
  assert.equal(bad[1].id, "RAW-id", "имя множества как id получает суффикс");
});

test("явные маркеры раньше неявных решений; use of — не решение; ~~~ и тройной ``` закрыты сами", () => {
  assert.equal(classify("Факт: Kafka не нужен на старте.").type, "fact");
  assert.equal(classify("TODO: не нужно трогать конфиг").type, "task");
  assert.equal(classify("Use of the term ontology varies between teams.").type, "observation");
  assert.equal(classify("Use Pydantic Settings.").type, "decision");
  assert.equal(chunk("```a``` ```\ncode line\n```\n\nпервый абзац\n\nвторой абзац").length, 3);
  assert.equal(chunk("~~~ x ~~~\n\nабзац 1\n\nабзац 2").length, 3);
});

test("код с != в блоке — не ячейка", () => {
  const s = plantText("Пример кода:\n\n```js\nif (a != b) return;\n```");
  assert.equal(s.length, 1);
  assert.notEqual(s[0].why, "ячейка найдена в теле");
});

test("chunk() на корпусе-образце не оставляет гигантов", () => {
  const md = readFileSync("attachments/ChatGPT_2026_09_18__1900.md", "utf8").slice(0, 400_000);
  const c = chunk(md);
  assert.ok(c.length > 1000);
  assert.ok(Math.max(...c.map((x) => x.length)) < 6000);
});

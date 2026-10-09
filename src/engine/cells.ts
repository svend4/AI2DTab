/**
 * Грамматика ячейки: заголовок вида `pred REL obj`.
 *
 * v1 понимала только `≠`. v2 добавляет `→` (ведёт к / влечёт), `⊂` (часть / вид),
 * `=` (тождество, редко и подозрительно) и `vs` (противопоставление без отрицания).
 * Операторы распознаются как в юникоде, так и в ASCII-записи.
 * Разбор без регулярных выражений с ведущим `\s*` — на длинных пробельных
 * последовательностях такие шаблоны квадратичны; здесь поиск литерала и обрезка.
 */
import type { Rel } from "./types.ts";

export type Cell = { pred: string; rel: Rel; obj: string };

/** Самое длинное, что считаем заголовком-ячейкой. */
export const MAX_CELL_TITLE = 300;

type Op = { rel: Rel; lit: string; spaced: boolean; ci?: boolean };

const OPS: Op[] = [
  { rel: "≠", lit: "≠", spaced: false },
  { rel: "≠", lit: "!=", spaced: false },
  { rel: "≠", lit: "<>", spaced: false },
  { rel: "→", lit: "→", spaced: false },
  { rel: "→", lit: "->", spaced: true },
  { rel: "→", lit: "=>", spaced: true },
  { rel: "⊂", lit: "⊂", spaced: false },
  { rel: "⊂", lit: "is-a", spaced: true, ci: true },
  { rel: "⊂", lit: "является", spaced: true, ci: true },
  { rel: "=", lit: "≡", spaced: false },
  { rel: "=", lit: "===", spaced: true },
  { rel: "=", lit: "=", spaced: true },
  { rel: "vs", lit: "vs.", spaced: true, ci: true },
  { rel: "vs", lit: "vs", spaced: true, ci: true },
  { rel: "vs", lit: "против", spaced: true, ci: true },
];

/** Заголовки-обёртки из размеченных лент: не ячейка, а ярлык перед блоком. */
export const JUNK_TITLE =
  /^(example|examples|again|critical invariant|critical distinctions|negative boundary|architecture invariants|note|важно|например|expected|shows|или|и|а|need|possible)\s*:?\s*$/i;

/** Ярлык: короткая строка, заканчивающаяся двоеточием, без глагола-содержания. */
export function isLabel(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 40 && /:$/.test(t) && !/[≠→⊂]|!=|->/.test(t);
}

const LEAD = /^(but|again|the|a|an|и|но|а)\s+/i;
const EDGE = /^[`"'«\s\-*>_#]+|[`"'».:;\s*_]+$/g;

function clean(s: string, lead: boolean): string {
  const t = s.replace(EDGE, "").trim();
  return (lead ? t.replace(LEAD, "") : t).trim();
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === " ";
}

function findOp(t: string, op: Op): number {
  const hay = op.ci ? t.toLowerCase() : t;
  const needle = op.ci ? op.lit.toLowerCase() : op.lit;
  let from = 1;
  while (from < hay.length) {
    const i = hay.indexOf(needle, from);
    if (i < 1) return -1;
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if (!op.spaced || (isWs(before) && (after === undefined || isWs(after)))) {
      // `=` не должен быть частью `==`, `!=`, `=>`, `<=`, `>=`
      if (op.lit === "=" && (before === "=" || before === "!" || before === "<" || before === ">" || after === "=" || after === ">")) {
        from = i + 1;
        continue;
      }
      return i;
    }
    from = i + 1;
  }
  return -1;
}

export function parseCell(title: string | undefined | null): Cell | null {
  const t = (title || "").trim().slice(0, MAX_CELL_TITLE);
  if (!t || JUNK_TITLE.test(t)) return null;
  for (const op of OPS) {
    const i = findOp(t, op);
    if (i < 1) continue;
    const pred = clean(t.slice(0, i), true);
    const obj = clean(t.slice(i + op.lit.length), false);
    if (pred.length >= 2 && obj.length >= 2 && !/[\n]/.test(pred + obj)) return { pred, rel: op.rel, obj };
  }
  return null;
}

export function isCellTitle(title: string): boolean {
  return parseCell(title) !== null;
}

export function formatCell(c: Cell): string {
  return `${c.pred} ${c.rel} ${c.obj}`;
}

/** Ячейка, записанная столбиком внутри кодового блока: `A\n≠\nB` → одна строка. */
export function flattenCellBlock(text: string): string | null {
  const lines = text
    .replace(/```[^\n]*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2 || lines.length > 3) return null;
  const joined = lines.length === 3 ? `${lines[0]} ${lines[1]} ${lines[2]}` : lines.join(" ");
  if (joined.length > MAX_CELL_TITLE) return null;
  return parseCell(joined) ? joined : null;
}

const STOP = new Set(
  "и в на не что как для это the a an of to for and or but from with без при this that is are быть".split(" "),
);

/** Словарь заголовка: токены длиной ≥ 4 без стоп-слов. */
export function tokens(text: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const w of (text || "").toLowerCase().slice(0, 2000).match(/[a-zа-яё0-9]{4,}/gi) || []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

export function normToken(s: string): string {
  return s.toLowerCase().replace(LEAD, "").trim();
}

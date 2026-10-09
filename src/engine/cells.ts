/**
 * Грамматика ячейки: заголовок вида `pred REL obj`.
 *
 * v1 понимала только `≠`. v2 добавляет `→` (ведёт к / влечёт), `⊂` (часть / вид),
 * `=` (тождество, редко и подозрительно) и `vs` (противопоставление без отрицания).
 * Операторы распознаются как в юникоде, так и в ASCII-записи.
 */
import type { Rel } from "./types.ts";

export type Cell = { pred: string; rel: Rel; obj: string };

const OPS: { rel: Rel; forms: RegExp }[] = [
  { rel: "≠", forms: /\s*(≠|!=|<>)\s*/ },
  { rel: "→", forms: /\s+(→|->|=>)\s+/ },
  { rel: "⊂", forms: /\s+(⊂|is-a|является)\s+/ },
  { rel: "=", forms: /\s+(≡|===)\s+/ },
  { rel: "vs", forms: /\s+(vs\.?|против)\s+/i },
];

/** Заголовки-обёртки из размеченных лент: не ячейка, а ярлык перед блоком. */
export const JUNK_TITLE =
  /^(example|again|critical invariant|critical distinctions|negative boundary|architecture invariants|note|важно)\s*:?\s*$/i;

const LEAD = /^(but|again|the|a|an|и|но|а)\s+/i;

function clean(s: string): string {
  return s
    .replace(/^[`"'«\s]+|[`"'».:;\s]+$/g, "")
    .replace(LEAD, "")
    .trim();
}

export function parseCell(title: string | undefined | null): Cell | null {
  const t = (title || "").trim();
  if (!t || JUNK_TITLE.test(t)) return null;
  for (const op of OPS) {
    const m = op.forms.exec(t);
    if (!m || m.index < 1) continue;
    const pred = clean(t.slice(0, m.index));
    const obj = clean(t.slice(m.index + m[0].length));
    if (pred.length >= 2 && obj.length >= 2) return { pred, rel: op.rel, obj };
  }
  return null;
}

export function isCellTitle(title: string): boolean {
  return parseCell(title) !== null;
}

export function formatCell(c: Cell): string {
  return `${c.pred} ${c.rel} ${c.obj}`;
}

const STOP = new Set(
  "и в на не что как для это the a an of to for and or but from with без при this that is are быть".split(" "),
);

/** Словарь заголовка: токены длиной ≥ 4 без стоп-слов. */
export function tokens(text: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const w of (text || "").toLowerCase().match(/[a-zа-яё0-9]{4,}/gi) || []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

export function normToken(s: string): string {
  return s.toLowerCase().replace(LEAD, "").trim();
}

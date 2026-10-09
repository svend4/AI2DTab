/**
 * Алгебра множеств над id.
 *
 * v1 понимала ровно один оператор на строку. v2 — полноценное выражение:
 *   NEQ ∩ (RAW ∪ CANON) \ C
 * Имена: NEQ CELL RAW CANON SESSION OPEN JUNK OBS A B C D,
 * фильтры `type:question` `status:raw` `cluster:C` `rel:→` `has:body`,
 * произвольный id. Приоритет: ∩ выше ∪ и \; скобки.
 */
import { isCellTitle, JUNK_TITLE } from "./cells.ts";
import type { Book, Obj } from "./types.ts";
import { NO_CANON } from "./types.ts";

type Tok = { k: "name" | "op" | "(" | ")"; v: string };

const OP_MAP: Record<string, "∩" | "∪" | "\\"> = {
  "∩": "∩", "&": "∩", AND: "∩",
  "∪": "∪", "|": "∪", OR: "∪",
  "\\": "\\", MINUS: "\\", "-": "\\",
};

export function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(\(|\)|∩|∪|\\|&|\||\bAND\b|\bOR\b|\bMINUS\b|(?<=\s)-(?=\s)|[^\s()∩∪\\&|]+)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    m = re.exec(expr);
    if (!m) break;
    pos = re.lastIndex;
    const v = m[1];
    if (v === "(" || v === ")") out.push({ k: v, v });
    else if (OP_MAP[v.toUpperCase()] ?? OP_MAP[v]) out.push({ k: "op", v: OP_MAP[v.toUpperCase()] ?? OP_MAP[v] });
    else out.push({ k: "name", v });
  }
  return out;
}

export const SET_NAMES = ["NEQ", "CELL", "RAW", "CANON", "SESSION", "OPEN", "JUNK", "OBS", "A", "B", "C", "D", "ALL"];

export function isJunk(o: Obj): boolean {
  const t = (o.title || "").trim();
  if (JUNK_TITLE.test(t)) return true;
  if (isCellTitle(t)) return false;
  return o.type === "observation" && t.length < 24 && !o.body?.trim();
}

export function resolveName(book: Book, name: string): Set<string> {
  const up = name.toUpperCase().replace("≠", "NEQ");
  const pick = (f: (o: Obj) => boolean) => new Set(book.objects.filter(f).map((o) => o.id));
  if (up === "ALL" || up === "*") return pick(() => true);
  if (up === "NEQ" || up === "NE") return pick((o) => o.rel === "≠" && !!o.pred);
  if (up === "CELL" || up === "CELLS") return pick((o) => !!o.pred && !!o.rel);
  if (up === "RAW") return pick((o) => o.status === "raw");
  if (up === "CANON") return pick((o) => o.status === "canon");
  if (up === "SESSION") return pick((o) => NO_CANON.has(o.type));
  if (up === "OPEN") return pick((o) => ["open", "raw", "candidate", "dormant"].includes(o.status));
  if (up === "JUNK") return pick((o) => o.status === "raw" && isJunk(o));
  if (up === "OBS" || up === "OBSERVATION") return pick((o) => o.type === "observation");
  if (["A", "B", "C", "D"].includes(up)) return pick((o) => o.cluster === up);
  const f = name.match(/^(type|status|cluster|rel|owner|layer):(.+)$/i);
  if (f) {
    const key = f[1].toLowerCase() as keyof Obj;
    const val = f[2];
    return pick((o) => String(o[key] ?? "").toLowerCase() === val.toLowerCase());
  }
  const h = name.match(/^has:(pred|body|link)$/i);
  if (h) {
    const what = h[1].toLowerCase();
    if (what === "link") {
      const linked = new Set(book.links.flatMap((l) => [l.from, l.to]));
      return pick((o) => linked.has(o.id));
    }
    return pick((o) => !!(what === "pred" ? o.pred : o.body?.trim()));
  }
  const byId = book.objects.find((o) => o.id === name || o.id.toLowerCase() === name.toLowerCase());
  return byId ? new Set([byId.id]) : new Set();
}

export function isSetExpr(arg: string): boolean {
  const s = (arg || "").trim();
  if (!s) return false;
  if (/[∩∪\\|&()]/.test(s) || /\b(AND|OR|MINUS)\b/.test(s)) return true;
  const up = s.toUpperCase().replace("≠", "NEQ");
  return SET_NAMES.includes(up) || /^(type|status|cluster|rel|owner|layer|has):/i.test(s);
}

/** Рекурсивный спуск: expr := term (('∪'|'\') term)* ; term := atom ('∩' atom)* ; atom := name | '(' expr ')' */
export function evalSet(book: Book, expr: string): { ids: Set<string>; name: string } {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const atom = (): Set<string> => {
    const t = toks[i];
    if (!t) throw new Error("пустое выражение");
    if (t.k === "(") {
      i++;
      const r = orExpr();
      if (peek()?.k !== ")") throw new Error("нет закрывающей скобки");
      i++;
      return r;
    }
    if (t.k === "name") {
      i++;
      return resolveName(book, t.v);
    }
    throw new Error(`неожиданный ${t.v}`);
  };
  const andExpr = (): Set<string> => {
    let acc = atom();
    while (peek()?.k === "op" && peek().v === "∩") {
      i++;
      const r = atom();
      acc = new Set([...acc].filter((x) => r.has(x)));
    }
    return acc;
  };
  const orExpr = (): Set<string> => {
    let acc = andExpr();
    while (peek()?.k === "op" && (peek().v === "∪" || peek().v === "\\")) {
      const op = peek().v;
      i++;
      const r = andExpr();
      acc = op === "∪" ? new Set([...acc, ...r]) : new Set([...acc].filter((x) => !r.has(x)));
    }
    return acc;
  };
  const ids = orExpr();
  if (i < toks.length) throw new Error(`лишнее: ${toks[i].v}`);
  const name = toks.map((t) => t.v).join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
  return { ids, name };
}

export function rowsOf(book: Book, ids: Set<string>): Obj[] {
  return book.objects.filter((o) => ids.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
}

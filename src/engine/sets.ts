/**
 * Алгебра множеств над id.
 *
 * Полное выражение со скобками: NEQ ∩ (RAW ∪ CANON) \ C.
 * Имена: NEQ CELL RAW CANON SESSION OPEN JUNK OBS A B C D ALL,
 * фильтры `type:question` `status:raw` `cluster:C` `rel:→` `has:body` `turn:3`,
 * произвольный id. Приоритет: ∩ выше ∪ и \; скобки.
 *
 * Паритет с v1: NEQ — только observation со статусом raw|canon (вычтенные не
 * воскресают через ACCEPT NEQ); JUNK — только ярлыки-обёртки (JUNK_TITLE) и
 * строки типа label/noise. Вычтенные (rejected) не входят ни в одно имя,
 * кроме ALL и status:rejected.
 */
import { JUNK_TITLE } from "./cells.ts";
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
  const re = /\s*(\(|\)|∩|∪|\\|&|\||\bAND\b|\bOR\b|\bMINUS\b|\band\b|\bor\b|\bminus\b|(?<=\s)-(?=\s)|[^\s()∩∪\\&|]+)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    m = re.exec(expr);
    if (!m) break;
    pos = re.lastIndex;
    const v = m[1];
    const op = OP_MAP[v] ?? OP_MAP[v.toUpperCase()];
    if (v === "(" || v === ")") out.push({ k: v, v });
    else if (op) out.push({ k: "op", v: op });
    else out.push({ k: "name", v });
  }
  return out;
}

export const SET_NAMES = ["NEQ", "NE", "CELL", "CELLS", "RAW", "CANON", "SESSION", "OPEN", "JUNK", "OBS", "OBSERVATION", "A", "B", "C", "D", "ALL"];

/** Мусор посадки: ярлык-обёртка или строка без содержания. Не трогает короткие заметки с телом. */
export function isJunk(o: Obj): boolean {
  if (o.type === "label" || o.type === "noise") return true;
  const t = (o.title || "").trim();
  if (JUNK_TITLE.test(t)) return true;
  return false;
}

/** Канон, который REPAIR возвращает в raw: ярлык/мусор или короткая строка без тела и без ячейки. */
export function isJunkCanon(o: Obj): boolean {
  if (isJunk(o)) return true;
  if (o.pred) return false;
  return o.type === "observation" && (o.title || "").trim().length < 24 && !(o.body || "").trim();
}

const LIVE = new Set(["raw", "canon"]);

export function resolveName(book: Book, name: string): Set<string> {
  const up = name.toUpperCase().replace("≠", "NEQ");
  const pick = (f: (o: Obj) => boolean) => new Set(book.objects.filter(f).map((o) => o.id));
  if (up === "ALL" || up === "*") return pick(() => true);
  if (up === "NEQ" || up === "NE") return pick((o) => o.rel === "≠" && !!o.pred && o.type === "observation" && LIVE.has(o.status));
  if (up === "CELL" || up === "CELLS") return pick((o) => !!o.pred && !!o.rel && LIVE.has(o.status));
  if (up === "RAW") return pick((o) => o.status === "raw");
  if (up === "CANON") return pick((o) => o.status === "canon");
  if (up === "SESSION") return pick((o) => NO_CANON.has(o.type) && o.status !== "rejected");
  if (up === "OPEN") return pick((o) => ["open", "raw", "candidate", "dormant"].includes(o.status));
  if (up === "JUNK") return pick((o) => o.status === "raw" && isJunk(o));
  if (up === "OBS" || up === "OBSERVATION") return pick((o) => o.type === "observation" && o.status !== "rejected");
  if (["A", "B", "C", "D"].includes(up)) return pick((o) => o.cluster === up && o.status !== "rejected");
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
  const tn = name.match(/^turn:(\d+)$/i);
  if (tn) {
    const span = `turn ${tn[1]}`;
    const ids = new Set(book.origins.filter((g) => g.span === span).map((g) => g.objectId));
    return pick((o) => ids.has(o.id));
  }
  const byId = book.objects.find((o) => o.id === name) ?? book.objects.find((o) => o.id.toLowerCase() === name.toLowerCase());
  return byId ? new Set([byId.id]) : new Set();
}

/** Выражение, а не одиночный id: есть оператор/скобки, или единственное имя — имя множества/фильтр. */
export function isSetExpr(arg: string): boolean {
  const s = (arg || "").trim();
  if (!s) return false;
  const toks = tokenize(s);
  if (toks.some((t) => t.k !== "name")) return true;
  if (toks.length !== 1) return false;
  const up = toks[0].v.toUpperCase().replace("≠", "NEQ");
  return SET_NAMES.includes(up) || /^(type|status|cluster|rel|owner|layer|has|turn):/i.test(toks[0].v);
}

/** Обобщённый рекурсивный спуск над любыми множествами (id, токены словаря):
 *  expr := term (('∪'|'\\') term)* ; term := atom ('∩' atom)* ; atom := name | '(' expr ')' */
export function evalGeneric<T>(expr: string, leaf: (name: string) => Set<T>): { ids: Set<T>; name: string } {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const atom = (): Set<T> => {
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
      return leaf(t.v);
    }
    throw new Error(`неожиданный ${t.v}`);
  };
  const andExpr = (): Set<T> => {
    let acc = atom();
    while (peek()?.k === "op" && peek().v === "∩") {
      i++;
      const r = atom();
      acc = new Set([...acc].filter((x) => r.has(x)));
    }
    return acc;
  };
  const orExpr = (): Set<T> => {
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

export function evalSet(book: Book, expr: string): { ids: Set<string>; name: string } {
  return evalGeneric<string>(expr, (name) => resolveName(book, name));
}

export function rowsOf(book: Book, ids: Set<string>): Obj[] {
  return book.objects.filter((o) => ids.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
}

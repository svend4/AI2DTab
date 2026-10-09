/**
 * Посадка (PLANT): лента → строки плоскости.
 *
 * Отличия от v1:
 *  - id = префикс типа + хеш нормализованного абзаца. Один абзац → один id,
 *    посадка идемпотентна; разные абзацы никогда не сталкиваются по индексу.
 *  - Нарезка понимает markdown: заголовок начинает новый блок, кодовый блок
 *    не рвётся по пустой строке.
 *  - Секции вида `# 17042. Заголовок` сохраняют свой стабильный номер (S17042).
 *  - Один и тот же классификатор для ленты и для TSV — вторая реализация в UI
 *    больше не нужна.
 */
import { parseCell } from "./cells.ts";
import { fnv1a, normalizeForHash } from "./hash.ts";
import type { Cluster, Obj, ObjType } from "./types.ts";

export type Seedling = {
  id: string;
  cluster: Cluster;
  layer: 1 | 2;
  type: ObjType;
  title: string;
  body: string;
  hash: string;
  /** Почему классификатор так решил — видно в предпросмотре посадки. */
  why: string;
};

export function chunk(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let inCode = false;
  const flush = () => {
    const t = cur.join("\n").trim();
    if (t.length > 1) out.push(t);
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (!inCode) {
      if (/^\s*$/.test(line)) {
        flush();
        continue;
      }
      if (/^#{1,3}\s/.test(line) && cur.length) flush();
    }
    cur.push(line);
  }
  flush();
  return out;
}

export function classify(text: string): Omit<Seedling, "id" | "hash"> {
  const t = text.trim();
  const low = t.toLowerCase();
  const firstLine = t.split("\n")[0].replace(/^#{1,3}\s+/, "").trim();
  const title = firstLine.slice(0, 140);
  const base = { cluster: "C" as Cluster, layer: 2 as const, body: t.slice(0, 1200) };

  if (/^https?:\/\//i.test(t)) {
    return { ...base, cluster: "A", type: "artifact", title: t.split(/\s/)[0].slice(0, 120), why: "ссылка" };
  }
  if (/^(да|yes|ok|ок)[.!]?$/.test(low) || /^(да[, ]+)?продолжен/.test(low) || low === "continue") {
    return { ...base, type: "session", title: /продолжен|continue/.test(low) ? "Продолжение" : "Да", body: t.slice(0, 400), why: "ход сессии, не факт" };
  }
  if (parseCell(firstLine)) {
    return { ...base, type: "observation", title, why: "ячейка pred rel obj" };
  }
  const neqInBody = t.match(/^[^\n]{2,80}\s*(≠|!=)\s*[^\n]{2,80}$/m);
  if (neqInBody && !parseCell(firstLine)) {
    return { ...base, type: "observation", title: neqInBody[0].replace(/[`]/g, "").trim().slice(0, 140), why: "ячейка найдена в теле" };
  }
  if (/\?\s*$/m.test(firstLine) || /^(как|что|зачем|почему|какой|какая|где|когда|how|what|why)(?=[\s,:?]|$)/i.test(firstLine)) {
    return { ...base, type: "question", title, body: t.slice(0, 800), why: "вопрос" };
  }
  if (/^(решено|решение|decision|decided)(?=[\s:.]|$)/i.test(firstLine)) {
    return { ...base, type: "decision", title: title.replace(/^(решено|решение|decision|decided)\s*:?\s*/i, ""), why: "маркер решения" };
  }
  if (/^(факт|fact)(?=[\s:.]|$)/i.test(firstLine)) {
    return { ...base, type: "fact", title: title.replace(/^(факт|fact)\s*:?\s*/i, ""), why: "маркер факта" };
  }
  if (/^(todo|задача|task)(?=[\s:.]|$)/i.test(firstLine) || /^[-*]\s*\[ \]/.test(firstLine)) {
    return { ...base, type: "task", title: title.replace(/^(todo|задача|task)\s*:?\s*|^[-*]\s*\[ \]\s*/i, ""), why: "маркер задачи" };
  }
  if (/инвариант|invariant|negative boundary/i.test(t)) {
    return { ...base, type: "observation", title, why: "инвариант без ячейки — проверить заголовок" };
  }
  return { ...base, type: "observation", title, body: t.slice(0, 800), why: "абзац" };
}

const PREFIX: Record<string, string> = {
  question: "Q",
  session: "U",
  artifact: "A",
  decision: "D",
  fact: "F",
  task: "T",
  observation: "B",
};

export function seedlingId(kind: Omit<Seedling, "id" | "hash">, raw: string): { id: string; hash: string } {
  const hash = fnv1a(normalizeForHash(raw));
  const m = raw.match(/^#{1,3}\s+(\d+)\.\s+/);
  if (m) return { id: `S${m[1]}`, hash };
  const p = kind.type === "observation" && parseCell(kind.title) ? "C" : PREFIX[kind.type] || "B";
  return { id: `${p}-${hash}`, hash };
}

export function plantText(text: string): Seedling[] {
  const seen = new Set<string>();
  const out: Seedling[] = [];
  for (const c of chunk(text)) {
    const k = classify(c);
    const { id, hash } = seedlingId(k, c);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...k, id, hash });
  }
  return out;
}

/** TSV с заголовком `id\tcluster\tlayer\ttype\ttitle\tstatus\tbody` (формат DUMP v1). */
export function plantTsv(text: string): Seedling[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split("\t").map((h) => h.trim());
  const out: Seedling[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const rec: Record<string, string> = {};
    head.forEach((h, i) => (rec[h] = (cells[i] ?? "").trim()));
    if (!rec.id) continue;
    const cl = (rec.cluster || "C").toUpperCase();
    out.push({
      id: rec.id,
      cluster: (["A", "B", "C", "D"].includes(cl) ? cl : "C") as Cluster,
      layer: rec.layer === "1" ? 1 : 2,
      type: rec.type || "observation",
      title: rec.title || rec.id,
      body: (rec.body || "").slice(0, 1200),
      hash: fnv1a(normalizeForHash(rec.title + rec.body)),
      why: "tsv",
    });
  }
  return out;
}

export function isTsv(text: string): boolean {
  return /^id\t/.test(text.trimStart());
}

export function toObj(s: Seedling, ts: string, owner = "machine:plant"): Obj {
  const cell = parseCell(s.title);
  return {
    id: s.id,
    cluster: s.cluster,
    layer: s.layer,
    type: s.type,
    title: s.title,
    status: "raw",
    body: s.body,
    createdAt: ts,
    updatedAt: ts,
    owner,
    hash: s.hash,
    ...(cell ? { pred: cell.pred, rel: cell.rel, obj: cell.obj } : {}),
  };
}

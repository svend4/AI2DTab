/**
 * Посадка (PLANT): лента → строки плоскости.
 *
 * v2.1 понимает реальные экспорты диалогов:
 *  - блок-цитаты `> …` снимаются до нарезки (95% исходного корпуса в них);
 *  - горизонтальные линии и маркеры ходов `# you asked` / `# chatgpt response`
 *    не становятся записями, но маркеры считают ход (turn) для происхождения;
 *  - режим секций: `# N. Заголовок` открывает секцию до следующего заголовка,
 *    id = S{N}; в режиме абзацев ярлык «Например:» + кодовый блок — один блок;
 *  - кодовый блок не рвётся по пустой строке; однострочный ``` … ``` закрыт сам;
 *  - id = префикс типа + 48-битный хеш нормализованного текста (идемпотентно).
 */
import { flattenCellBlock, isLabel, JUNK_TITLE, parseCell } from "./cells.ts";
import { fnv1a, normalizeForHash } from "./hash.ts";
import type { Cluster, Obj, ObjType } from "./types.ts";
import { RESERVED_IDS } from "./types.ts";

export type ChunkMode = "paragraph" | "section" | "auto";

export type Chunk = { text: string; turn: number; kind: "section" | "paragraph" };

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
  turn?: number;
  kind?: "section" | "paragraph" | "tsv";
};

const TURN_MARK = /^#{1,6}\s+(you asked|chatgpt response|user|assistant)\s*$/i;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const NUMBERED = /^#{1,3}\s+(\d+)\.\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export function unquote(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/^(\s*>\s?)+/, ""));
}

function selfClosedFence(line: string): boolean {
  const tok = /^\s*~~~/.test(line) ? "~~~" : "```";
  const n = line.split(tok).length - 1;
  return n >= 2 && n % 2 === 0;
}

export function countNumbered(lines: string[]): number {
  let n = 0;
  for (const l of lines) if (NUMBERED.test(l)) n++;
  return n;
}

/** Нарезка с учётом цитат, линий, маркеров ходов, кодовых блоков и ярлыков. */
export function chunkDetailed(text: string, opts: { mode?: ChunkMode } = {}): Chunk[] {
  const lines = unquote(text);
  const mode: ChunkMode = opts.mode && opts.mode !== "auto" ? opts.mode : countNumbered(lines) >= 20 ? "section" : "paragraph";
  const out: Chunk[] = [];
  let cur: string[] = [];
  let inCode = false;
  let turn = 0;
  let kind: Chunk["kind"] = "paragraph";
  const flush = () => {
    const t = cur.join("\n").trim();
    if (t.length > 1 && !HR.test(t)) out.push({ text: t, turn, kind });
    cur = [];
    kind = "paragraph";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line) && !selfClosedFence(line)) inCode = !inCode;
    if (inCode) {
      cur.push(line);
      continue;
    }
    if (TURN_MARK.test(line)) {
      flush();
      turn++;
      continue;
    }
    if (HR.test(line)) {
      if (mode === "paragraph") flush();
      continue;
    }
    if (mode === "section") {
      if (NUMBERED.test(line)) {
        flush();
        kind = "section";
        cur.push(line);
        continue;
      }
      if (cur.length && kind === "section") {
        cur.push(line);
        continue;
      }
    }
    if (/^\s*$/.test(line)) {
      // ярлык «Например:» + кодовый блок дальше → не рвать
      const next = nextNonBlank(lines, i + 1);
      const last = cur.length ? cur[cur.length - 1].trim() : "";
      if (next && FENCE.test(next) && cur.length && (isLabel(last) || /:\s*$/.test(last))) continue;
      flush();
      continue;
    }
    if (/^#{1,3}\s/.test(line) && cur.length) flush();
    cur.push(line);
  }
  flush();
  return out;
}

function nextNonBlank(lines: string[], from: number): string | null {
  for (let j = from; j < Math.min(lines.length, from + 3); j++) if (!/^\s*$/.test(lines[j])) return lines[j];
  return null;
}

export function chunk(text: string, opts?: { mode?: ChunkMode }): string[] {
  return chunkDetailed(text, opts).map((c) => c.text);
}

function stripFences(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !FENCE.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

function oneLine(s: string, max = 140): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

const QUESTION = /^(как|что|зачем|почему|какой|какая|какие|где|когда|how|what|why|which|when|where)(?=[\s,:?]|$)/i;
const DECISION = /^(решено|решение|decision|decided)(?=[\s:.]|$)/i;
const FACT = /^(факт|fact)(?=[\s:.]|$)/i;
const TASK = /^(todo|задача|task|добавить|сделать)(?=[\s:.]|$)|^[-*]\s*\[ \]/i;

export function classify(text: string): Omit<Seedling, "id" | "hash"> {
  const t = text.trim();
  const low = t.toLowerCase();
  const rawFirst = t.split("\n")[0].replace(/^#{1,3}\s+/, "").trim();
  const numbered = rawFirst.match(/^(\d+)\.\s+(.*)$/);
  const firstLine = numbered ? numbered[2].trim() : rawFirst;
  const fenceOnly = FENCE.test(t.split("\n")[0]);
  const contentLines = stripFences(t);
  const title = oneLine(fenceOnly ? contentLines[0] || "" : firstLine) || "(пусто)";
  const base = { cluster: "C" as Cluster, layer: 2 as const, body: t.slice(0, 1200) };

  if (/^https?:\/\//i.test(t)) {
    return { ...base, cluster: "A", type: "artifact", title: t.split(/\s/)[0].slice(0, 120), why: "ссылка" };
  }
  if (/^(да|yes|ok|ок)[.!]?$/.test(low) || /^(да[, ]+)?продолжен/.test(low) || low === "continue" || /^(да|продолжение)[,.]?\s+(и\s+)?на\s+рус/.test(low)) {
    return { ...base, type: "session", title: /продолжен|continue/.test(low) ? "Продолжение" : "Да", body: t.slice(0, 400), why: "ход сессии, не факт" };
  }
  if (parseCell(firstLine)) {
    return { ...base, type: "observation", title: oneLine(firstLine), why: "ячейка pred rel obj" };
  }
  const block = fenceOnly ? flattenCellBlock(t) : null;
  if (block) {
    return { ...base, type: "observation", title: oneLine(block), why: "ячейка найдена в теле" };
  }
  const bodyCell = t
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l.length <= 200 && /≠/.test(l) && !/[;{}()=<>]/.test(l.replace(/≠/g, "")) && parseCell(l));
  if (bodyCell && (JUNK_TITLE.test(firstLine) || isLabel(firstLine))) {
    return { ...base, type: "observation", title: oneLine(bodyCell.replace(/[`]/g, "")), why: "ячейка найдена в теле" };
  }
  if (fenceOnly) {
    const q = contentLines.find((l) => /\?\s*$/.test(l));
    if (q && contentLines.length <= 3) return { ...base, type: "question", title: oneLine(q), body: t.slice(0, 800), why: "вопрос в блоке" };
    return { ...base, type: "code", title, why: "кодовый блок" };
  }
  if (isLabel(firstLine) && contentLines.length === 1) {
    return { ...base, type: "label", title, why: "ярлык без содержания" };
  }
  if (/\?\s*$/.test(firstLine) || QUESTION.test(firstLine)) {
    return { ...base, type: "question", title, body: t.slice(0, 800), why: "вопрос" };
  }
  if (FACT.test(firstLine)) {
    return { ...base, type: "fact", title: title.replace(/^(факт|fact)\s*:?\s*/i, ""), why: "маркер факта" };
  }
  if (TASK.test(firstLine)) {
    return { ...base, type: "task", title: title.replace(/^(todo|задача|task)\s*:?\s*|^[-*]\s*\[ \]\s*/i, ""), why: "маркер задачи" };
  }
  if (DECISION.test(firstLine) || (/(^|[\s(])(не нужен|не нужна|не нужно|необходим[ао]?|обязателен|обязательно)(?=[\s.,;:!?)]|$)/i.test(firstLine) && firstLine.length < 120) || /^(используем|выбираем|will use|do not|don't|never|always)(?=[\s.,:]|$)/i.test(firstLine) || /^use\s+(?!of\b)\S/i.test(firstLine)) {
    return { ...base, type: "decision", title: title.replace(/^(решено|решение|decision|decided)\s*:?\s*/i, ""), why: "маркер решения" };
  }
  if (/инвариант|invariant|negative boundary/i.test(t)) {
    return { ...base, type: "observation", title, why: "инвариант без ячейки — проверить заголовок" };
  }
  return { ...base, type: "observation", title, body: t.slice(0, 800), why: numbered ? "секция" : "абзац" };
}

const PREFIX: Record<string, string> = {
  question: "Q",
  session: "U",
  artifact: "A",
  decision: "D",
  fact: "F",
  task: "T",
  observation: "B",
  code: "K",
  label: "L",
};

export function seedlingId(kind: Omit<Seedling, "id" | "hash">, raw: string): { id: string; hash: string } {
  const hash = fnv1a(normalizeForHash(raw));
  const m = raw.match(/^#{1,3}\s+(\d+)\.\s+/);
  if (m) return { id: `S${m[1]}`, hash };
  const p = kind.type === "observation" && parseCell(kind.title) ? "C" : PREFIX[kind.type] || "B";
  return { id: `${p}-${hash}`, hash };
}

export function plantText(text: string, opts: { mode?: ChunkMode } = {}): Seedling[] {
  const seen = new Map<string, string>();
  const out: Seedling[] = [];
  for (const c of chunkDetailed(text, opts)) {
    if (TURN_MARK.test(c.text)) continue;
    const k = classify(c.text);
    let { id } = seedlingId(k, c.text);
    const { hash } = seedlingId(k, c.text);
    const prev = seen.get(id);
    if (prev === hash) continue; // тот же абзац повторно — один id
    if (prev && prev !== hash) {
      // одинаковый номер секции с другим содержанием → развести
      let n = 2;
      while (seen.has(`${id}-${n}`) && seen.get(`${id}-${n}`) !== hash) n++;
      id = `${id}-${n}`;
      if (seen.get(id) === hash) continue;
    }
    seen.set(id, hash);
    out.push({ ...k, id, hash, turn: c.turn, kind: c.kind });
  }
  return out;
}

/** TSV с заголовком `id\tcluster\tlayer\ttype\ttitle\tstatus\tbody[\tpred\trel\tobj]` (формат DUMP). */
export function plantTsv(text: string): Seedling[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split("\t").map((h) => h.trim());
  const out: Seedling[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const rec: Record<string, string> = {};
    head.forEach((h, i) => (rec[h] = (cells[i] ?? "").trim()));
    let id = rec.id.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
    if (!id) continue;
    if (RESERVED_IDS.has(id.toUpperCase())) id = `${id}-id`;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    seen.add(id);
    const cl = (rec.cluster || "C").toUpperCase();
    let title = (rec.title || id).slice(0, 400);
    let why = "tsv";
    const body = (rec.body || "").replace(/ \/ /g, "\n").slice(0, 1200);
    if ((JUNK_TITLE.test(title) || isLabel(title)) && body) {
      const k = classify(`${title}\n${body}`);
      if (k.why.startsWith("ячейка")) {
        title = k.title;
        why = "tsv: ячейка из тела";
      }
    }
    out.push({
      id,
      cluster: (["A", "B", "C", "D"].includes(cl) ? cl : "C") as Cluster,
      layer: rec.layer === "1" ? 1 : 2,
      type: (rec.type || "observation").slice(0, 40),
      title,
      body,
      hash: fnv1a(normalizeForHash(title + body)),
      why,
      kind: "tsv",
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

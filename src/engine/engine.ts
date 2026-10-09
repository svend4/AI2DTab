/**
 * Стол v2: исполнитель алфавита над книгой.
 *
 * Тот же язык, что в v1 (PLANT LOOK SET NEQ FILL SWEEP ... SPEC), плюс:
 *   UNDO   — откат последней записи по журналу (before/after в событии)
 *   NEXT   — ход из правил, а не из зашитых id
 *   WHY    — объяснить, почему строка такая (классификатор, ячейка, рёбра)
 *   UNWIRE — снять ребро
 *   HELP   — алфавит с одной строкой на глагол
 * Нет субпроцессов и путей: чистая функция над JSON, работает в браузере.
 */
import { formatCell, normToken, parseCell, tokens } from "./cells.ts";
import { liveRules, readout, RULES } from "./instruments.ts";
import { isTsv, plantText, plantTsv, toObj, type Seedling } from "./plant.ts";
import { evalSet, isJunk, isSetExpr, rowsOf } from "./sets.ts";
import type { Book, Cluster, Event, ExecResult, Link, Obj, Readout, Status } from "./types.ts";
import { CLUSTERS, emptyBook, NO_CANON, nowIso } from "./types.ts";

export const VERBS: { verb: string; doc: string; write: boolean }[] = [
  { verb: "STATUS", doc: "сводка по кластер × тип × статус", write: false },
  { verb: "LOOK q", doc: "поиск по id/заголовку/телу — сразу по всем кластерам", write: false },
  { verb: "PLANT text|tsv", doc: "посадить ленту: абзацы → строки raw (идемпотентно)", write: true },
  { verb: "PREVIEW text", doc: "сухая посадка: что получится, без записи", write: false },
  { verb: "ACCEPT id|set", doc: "в канон (session/tape — REFUSE)", write: true },
  { verb: "FILL", doc: "= ACCEPT NEQ ∩ RAW", write: true },
  { verb: "TAKE id|set", doc: "вычесть (канон не вычитается)", write: true },
  { verb: "SWEEP", doc: "= TAKE SESSION", write: true },
  { verb: "PURGE", doc: "= TAKE JUNK", write: true },
  { verb: "REPAIR", doc: "канон-мусор → снова raw", write: true },
  { verb: "SET expr", doc: "множество: NEQ ∩ (RAW ∪ CANON) \\ C, type:question, has:link", write: false },
  { verb: "NEQ | CELL", doc: "ячейки pred rel obj", write: false },
  { verb: "CONC [q]", doc: "конкорданс токенов ячеек", write: false },
  { verb: "VOCAB expr", doc: "словарь заголовков множества (∩ ∪ \\)", write: false },
  { verb: "GRID | MATRIX", doc: "кластер × тип: raw/canon", write: false },
  { verb: "DIFF", doc: "что ещё raw; какие ≠ ждут ACCEPT", write: false },
  { verb: "PACKET [id|A B]", doc: "рёбра: все, по id или кластер→кластер", write: false },
  { verb: "WIRE a b [rel]", doc: "одно ребро (не MUL)", write: true },
  { verb: "UNWIRE a b [rel]", doc: "снять ребро", write: true },
  { verb: "PROBE A B", doc: "кандидаты рёбер по общим токенам", write: false },
  { verb: "PORT A B", doc: "декартово ячейки×канон — показать, не паять", write: false },
  { verb: "INSTR", doc: "приборы: заряд, перекос, рёбра, красная зона", write: false },
  { verb: "GAP", doc: "красная зона → вопросы-GAP (raw)", write: true },
  { verb: "SETTLE", doc: "закрыть GAP, чьё предупреждение погасло", write: true },
  { verb: "RUN id", doc: "исполнить канон-id → NEXT", write: true },
  { verb: "NEXT", doc: "ход из правил книги, не из ленты", write: false },
  { verb: "FETCH", doc: "новый вопрос на L1: чего нет в каноне", write: true },
  { verb: "WHY id", doc: "почему строка такая: ячейка, рёбра, журнал", write: false },
  { verb: "UNDO", doc: "откат последней записи", write: true },
  { verb: "SPEC", doc: "журнал → спецификация языка (какие глаголы живут)", write: false },
  { verb: "JSON", doc: "снимок книги для следующего агента", write: false },
  { verb: "DUMP | CANON | RAW", doc: "TSV", write: false },
  { verb: "BATCH a; b; c", doc: "пачка ходов без пересказа", write: true },
  { verb: "HELP", doc: "этот список", write: false },
];

const WRITE_VERBS = new Set(VERBS.filter((v) => v.write).map((v) => v.verb.split(" ")[0]));

const TAB = "\t";

function tsvLine(cols: (string | number | undefined)[]): string {
  return cols.map((c) => String(c ?? "").replace(/\t/g, " ").replace(/\n/g, " / ")).join(TAB);
}

export class Desk {
  book: Book;
  private seq = 0;

  constructor(book?: Book) {
    this.book = book ?? emptyBook();
    this.seq = this.book.events.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  // ---------- низкоуровневые записи ----------

  private log(action: string, objectId?: string, detail?: string, extra: Partial<Event> = {}): Event {
    const ev: Event = { seq: ++this.seq, ts: nowIso(), actor: "machine:exec", action, objectId, detail, ...extra };
    this.book.events.push(ev);
    return ev;
  }

  get(id: string): Obj | undefined {
    return this.book.objects.find((o) => o.id === id);
  }

  private setStatus(o: Obj, status: Status, action: string, detail?: string): void {
    const before = { status: o.status, updatedAt: o.updatedAt };
    o.status = status;
    o.updatedAt = nowIso();
    this.log(action, o.id, detail ?? o.title, { before, after: { status, updatedAt: o.updatedAt } });
  }

  private insert(o: Obj, action: string, detail?: string): void {
    this.book.objects.push(o);
    this.log(action, o.id, detail ?? o.title, { before: null, after: { ...o } });
  }

  // ---------- ходы ----------

  plant(seedlings: Seedling[], source?: string): { planted: string[]; skipped: string[]; lines: string[] } {
    const planted: string[] = [];
    const skipped: string[] = [];
    const lines: string[] = [];
    const ts = nowIso();
    for (const s of seedlings) {
      const ex = this.get(s.id);
      if (ex) {
        skipped.push(s.id);
        lines.push(`skip ${s.id} already ${ex.type}/${ex.status}`);
        continue;
      }
      const o = toObj(s, ts);
      this.insert(o, "PLANT", `${s.why}: ${s.title}`.slice(0, 160));
      if (source) this.book.origins.push({ objectId: o.id, sessionId: source, span: s.why });
      planted.push(o.id);
      lines.push(`plant ${o.id}\t${o.type}\t${o.title.slice(0, 80)}`);
    }
    return { planted, skipped, lines };
  }

  accept(o: Obj): string {
    if (NO_CANON.has(o.type)) {
      this.log("REFUSE", o.id, `type=${o.type}`);
      return `REFUSE ${o.id} type=${o.type}`;
    }
    if (o.status === "canon") return `skip ${o.id} already canon`;
    const cell = parseCell(o.title);
    if (cell) Object.assign(o, cell);
    this.setStatus(o, "canon", "ACCEPT");
    return `ACCEPT ${o.id}`;
  }

  take(o: Obj): string {
    if (o.status === "canon" && !NO_CANON.has(o.type)) return `REFUSE ${o.id} canon`;
    if (o.status === "rejected") return `skip ${o.id} already taken`;
    this.setStatus(o, "rejected", "TAKE");
    return `TAKE ${o.id}`;
  }

  wire(from: string, to: string, rel = "candidate", note = "WIRE"): string {
    if (!this.get(from)) return `нет ${from}`;
    if (!this.get(to)) return `нет ${to}`;
    if (this.book.links.some((l) => l.from === from && l.to === to && l.rel === rel)) return `skip ${from} -${rel}-> ${to}`;
    const link: Link = { from, to, rel, note };
    this.book.links.push(link);
    this.log("WIRE", from, `${rel}->${to}`, { link });
    return `WIRE ${from} -${rel}-> ${to}`;
  }

  unwire(from: string, to: string, rel?: string): string {
    const i = this.book.links.findIndex((l) => l.from === from && l.to === to && (!rel || l.rel === rel));
    if (i < 0) return `нет ребра ${from} -> ${to}`;
    const [link] = this.book.links.splice(i, 1);
    this.log("UNWIRE", from, `${link.rel}->${to}`, { link });
    return `UNWIRE ${from} -${link.rel}-> ${to}`;
  }

  undo(): string {
    const ev = [...this.book.events].reverse().find((e) => e.action !== "UNDO" && (e.before !== undefined || e.link));
    if (!ev) return "нечего откатывать";
    if (ev.action === "WIRE" && ev.link) {
      const l = ev.link;
      this.book.links = this.book.links.filter((x) => !(x.from === l.from && x.to === l.to && x.rel === l.rel));
    } else if (ev.action === "UNWIRE" && ev.link) {
      this.book.links.push(ev.link);
    } else if (ev.before === null && ev.objectId) {
      this.book.objects = this.book.objects.filter((o) => o.id !== ev.objectId);
      this.book.origins = this.book.origins.filter((o) => o.objectId !== ev.objectId);
    } else if (ev.before && ev.objectId) {
      const o = this.get(ev.objectId);
      if (o) Object.assign(o, ev.before);
    }
    // событие остаётся в журнале: откат — тоже ход, спецификация его видит
    this.book.events = this.book.events.filter((e) => e.seq !== ev.seq);
    this.log("UNDO", ev.objectId, `${ev.action} ${ev.detail ?? ""}`.trim());
    return `UNDO ${ev.action} ${ev.objectId ?? ""}`.trim();
  }

  readout(): Readout {
    return readout(this.book);
  }

  gap(): string[] {
    const r = this.readout();
    const notes: string[] = [];
    for (const rule of liveRules(r)) {
      if (this.get(rule.gapId)) {
        notes.push(`skip ${rule.gapId}`);
        continue;
      }
      const ts = nowIso();
      this.insert(
        { id: rule.gapId, cluster: rule.gapCluster, layer: 2, type: "question", title: rule.gapTitle, status: "raw", body: `GAP из приборов: ${rule.warn}`, createdAt: ts, updatedAt: ts, owner: "machine:gap" },
        "GAP",
        rule.gapTitle,
      );
      notes.push(`GAP ${rule.gapId} ${rule.gapTitle}`);
    }
    return notes;
  }

  settle(): string[] {
    const r = this.readout();
    const notes: string[] = [];
    for (const rule of RULES) {
      const row = this.get(rule.gapId);
      if (!row) continue;
      if (r.warns.includes(rule.warn)) {
        notes.push(`open ${rule.gapId} (${rule.warn})`);
        continue;
      }
      if (["closed", "rejected"].includes(row.status)) {
        notes.push(`skip ${rule.gapId}`);
        continue;
      }
      this.setStatus(row, "closed", "SETTLE", rule.warn);
      notes.push(`SETTLE ${rule.gapId}`);
    }
    return notes;
  }

  /** Ход из правил. Ничего не знает о конкретных id — только о формах. */
  next(): string[] {
    const b = this.book;
    const out: string[] = [];
    const r = this.readout();
    const openC = b.objects.filter((o) => o.cluster === "C" && o.status === "open");
    for (const o of openC) out.push(`кластер C держит открытый ярлык ${o.id}: выжимка или rejected — «${o.title}»`);
    const dormant = b.objects.filter((o) => o.type === "signpost" && o.status === "dormant");
    for (const s of dormant) {
      const trig = b.links.filter((l) => l.from === s.id && l.rel === "triggers").map((l) => l.to);
      out.push(`сигнальный столб ${s.id} не сработал${trig.length ? `, держит ${trig.join(", ")}` : ""}: новая сессия слоя 2 — только с новой внешней ссылкой`);
    }
    const blocked = b.links.filter((l) => ["blocks", "contradicts"].includes(l.rel));
    for (const l of blocked) out.push(`${l.from} ${l.rel} ${l.to}: не закрывать догадкой`);
    const openQ = b.objects.filter((o) => o.type === "question" && o.status === "open" && o.cluster !== "C").slice(0, 5);
    if (openQ.length) {
      out.push("открытые вопросы, которые не закрывать догадкой:");
      for (const q of openQ) out.push(`  - ${q.id} ${q.title}`);
    }
    const neqRaw = b.objects.filter((o) => o.status === "raw" && o.rel === "≠").length;
    if (neqRaw) out.push(`${neqRaw} ячеек ≠ ждут FILL`);
    for (const rule of liveRules(r)) out.push(`красная зона: ${rule.warn} → GAP ${rule.gapId}`);
    if (!out.length) out.push("правила молчат: сажайте новое сырьё (FETCH)");
    out.push("запрет: не умножать A×B в одну ОС (MUL); морфизм только PACKET/WIRE");
    return out;
  }

  why(id: string): string[] {
    const o = this.get(id);
    if (!o) return [`нет ${id}`];
    const out = [`${o.id} · ${o.cluster}/${o.type}/${o.status} · слой ${o.layer} · владелец ${o.owner}`];
    const cell = o.pred ? { pred: o.pred, rel: o.rel!, obj: o.obj! } : parseCell(o.title);
    out.push(cell ? `ячейка: ${formatCell(cell)}` : "не ячейка: в заголовке нет pred REL obj");
    if (isJunk(o)) out.push("похоже на мусор: короткий заголовок без тела и без ячейки");
    const links = this.book.links.filter((l) => l.from === id || l.to === id);
    out.push(links.length ? `рёбра: ${links.map((l) => `${l.from} -${l.rel}-> ${l.to}`).join("; ")}` : "рёбер нет");
    const or = this.book.origins.filter((x) => x.objectId === id);
    if (or.length) out.push(`происхождение: ${or.map((x) => `${x.sessionId}${x.span ? ` (${x.span})` : ""}`).join(", ")}`);
    const ev = this.book.events.filter((e) => e.objectId === id);
    out.push(ev.length ? `журнал: ${ev.map((e) => `${e.ts.slice(5, 16)} ${e.action}`).join(" → ")}` : "журнал пуст");
    return out;
  }

  // ---------- исполнитель строки ----------

  exec(line: string): ExecResult {
    const raw = (line || "").trim();
    // формульный синтаксис из строки команд
    const norm = raw.startsWith("=") ? formula(raw.slice(1).trim()) : raw;
    const m = norm.match(/^(\S+)([\s\S]*)$/);
    const verb = (m?.[1] || "").toUpperCase();
    const arg = (m?.[2] || "").trim();
    const res = (ok: boolean, text: string, data?: unknown): ExecResult => ({ ok, verb, text, data, wrote: WRITE_VERBS.has(verb) });
    const b = this.book;
    try {
      switch (verb) {
        case "": return res(false, "пустой ход");
        case "HELP": return res(true, VERBS.map((v) => `${v.verb.padEnd(18)} ${v.doc}`).join("\n"), VERBS);
        case "STATUS": {
          const grid = new Map<string, number>();
          for (const o of b.objects) grid.set(`${o.cluster}\t${o.type}\t${o.status}`, (grid.get(`${o.cluster}\t${o.type}\t${o.status}`) ?? 0) + 1);
          const lines = [...grid.entries()].sort().map(([k, n]) => `${k}\t${n}`);
          const openQ = b.objects.filter((o) => o.type === "question" && o.status === "open").length;
          return res(true, ["кластер\tтип\tстатус\tn", ...lines, `открытых вопросов: ${openQ}`].join("\n"));
        }
        case "LOOK": {
          const q = arg.toLowerCase();
          const rows = b.objects.filter((o) => !q || `${o.id} ${o.title} ${o.body}`.toLowerCase().includes(q));
          return res(true, [`LOOK ${arg} → ${rows.length}`, ...rows.slice(0, 60).map((o) => tsvLine([o.id, o.type, o.status, o.title]))].join("\n"), rows.map((o) => o.id));
        }
        case "PREVIEW": {
          const s = isTsv(arg) ? plantTsv(arg) : plantText(arg);
          return res(true, [`PREVIEW → ${s.length}`, ...s.map((x) => tsvLine([x.id, x.cluster, x.type, x.why, x.title]))].join("\n"), s);
        }
        case "PLANT":
        case "CUT": {
          if (!arg) return res(false, "PLANT: нужен текст или TSV");
          const s = isTsv(arg) ? plantTsv(arg) : plantText(arg);
          const r = this.plant(s);
          return res(true, [...r.lines, `n=${s.length} planted=${r.planted.length} skipped=${r.skipped.length}`].join("\n"), r);
        }
        case "ACCEPT":
        case "FILL": {
          const expr = arg || (verb === "FILL" ? "NEQ ∩ RAW" : "");
          if (!expr) return res(false, "ACCEPT id|множество");
          if (isSetExpr(expr)) {
            const { ids, name } = evalSet(b, expr);
            const notes = rowsOf(b, ids).map((o) => this.accept(o));
            const ok = notes.filter((n) => n.startsWith("ACCEPT")).length;
            const no = notes.filter((n) => n.startsWith("REFUSE")).length;
            const sk = notes.length - ok - no;
            return res(true, [`ACCEPT ${name} → ok=${ok} refuse=${no} skip=${sk}`, ...notes.slice(0, 80)].join("\n"), { ok, no, sk });
          }
          const o = this.get(expr);
          if (!o) return res(false, `нет ${expr}`);
          return res(true, this.accept(o));
        }
        case "TAKE":
        case "SWEEP":
        case "PURGE": {
          const expr = arg || (verb === "SWEEP" ? "SESSION" : verb === "PURGE" ? "JUNK" : "");
          if (!expr) return res(false, "TAKE id|множество");
          if (isSetExpr(expr)) {
            const { ids, name } = evalSet(b, expr);
            const notes = rowsOf(b, ids).map((o) => this.take(o));
            return res(true, [`TAKE ${name} → ${notes.filter((n) => n.startsWith("TAKE")).length}`, ...notes.slice(0, 80)].join("\n"));
          }
          const o = this.get(expr);
          if (!o) return res(false, `нет ${expr}`);
          return res(true, this.take(o));
        }
        case "REPAIR": {
          const junk = b.objects.filter((o) => o.status === "canon" && isJunk(o));
          for (const o of junk) this.setStatus(o, "raw", "REPAIR");
          return res(true, [`REPAIR → ${junk.length}`, ...junk.map((o) => `REPAIR ${o.id} ${o.title.slice(0, 60)}`)].join("\n"));
        }
        case "SET": {
          if (!arg) return res(false, "SET expr");
          const { ids, name } = evalSet(b, arg);
          const rows = rowsOf(b, ids);
          return res(true, [`SET ${name} → ${rows.length}`, ...rows.slice(0, 80).map((o) => tsvLine([o.id, o.cluster, o.type, o.status, o.title]))].join("\n"), rows.map((o) => o.id));
        }
        case "NEQ":
        case "CELL":
        case "RANGE": {
          const rows = rowsOf(b, evalSet(b, verb === "NEQ" ? "NEQ" : "CELL").ids);
          return res(true, [`${verb} → ${rows.length}`, "id\tstatus\tpred\trel\tobj", ...rows.map((o) => tsvLine([o.id, o.status, o.pred, o.rel, o.obj]))].join("\n"), rows.map((o) => o.id));
        }
        case "CONC":
        case "CONCORD": {
          const rows = rowsOf(b, evalSet(b, "CELL").ids);
          const q = arg.toLowerCase();
          const bag = new Map<string, { pred: string[]; obj: string[] }>();
          const hits: string[] = [];
          for (const o of rows) {
            const p = normToken(o.pred!), x = normToken(o.obj!);
            (bag.get(p) ?? bag.set(p, { pred: [], obj: [] }).get(p)!).pred.push(o.id);
            (bag.get(x) ?? bag.set(x, { pred: [], obj: [] }).get(x)!).obj.push(o.id);
            if (q && (p.includes(q) || x.includes(q) || o.id.toLowerCase().includes(q))) hits.push(tsvLine([o.id, p.includes(q) ? "pred" : "obj", o.pred, o.rel, o.obj, o.status]));
          }
          if (q) return res(true, [`CONC ${arg} → ${hits.length}`, ...hits].join("\n"));
          const items = [...bag.entries()].flatMap(([tok, r]) => (["pred", "obj"] as const).filter((k) => r[k].length).map((k) => ({ tok, role: k, n: r[k].length, ids: r[k] })));
          items.sort((a, c) => c.n - a.n);
          return res(true, [`CONC → ${items.length} tokens in ${rows.length} cells`, "token\trole\tn\tids", ...items.slice(0, 40).map((i) => tsvLine([i.tok, i.role, i.n, i.ids.slice(0, 8).join(",")]))].join("\n"), items);
        }
        case "VOCAB": {
          if (!arg) return res(false, "VOCAB expr");
          const parts = arg.split(/\s*(∩|∪|\\)\s*/);
          const bag = (name: string) => {
            const acc = new Set<string>();
            for (const o of rowsOf(b, evalSet(b, name).ids)) for (const t of tokens(`${o.title} ${o.pred ?? ""} ${o.obj ?? ""}`)) acc.add(t);
            return acc;
          };
          let acc = bag(parts[0]);
          for (let i = 1; i < parts.length; i += 2) {
            const r = bag(parts[i + 1]);
            acc = parts[i] === "∩" ? new Set([...acc].filter((x) => r.has(x))) : parts[i] === "∪" ? new Set([...acc, ...r]) : new Set([...acc].filter((x) => !r.has(x)));
          }
          return res(true, [`VOCAB ${arg} → ${acc.size}`, [...acc].sort().slice(0, 80).join(" ")].join("\n"), [...acc]);
        }
        case "GRID":
        case "MATRIX": {
          if (verb === "MATRIX" && /\S+\s*[×x*]\s*\S+/.test(arg)) return res(false, "MUL запрещён: A×B склеивает кластеры. Морфизм только PACKET.");
          const types = [...new Set(b.objects.map((o) => o.type))].sort();
          const lines = ["тип \\ кластер\t" + CLUSTERS.join("\t")];
          for (const t of types) lines.push(tsvLine([t, ...CLUSTERS.map((c) => `${b.objects.filter((o) => o.type === t && o.cluster === c && o.status === "raw").length}r/${b.objects.filter((o) => o.type === t && o.cluster === c && o.status === "canon").length}c`)]));
          return res(true, lines.join("\n"));
        }
        case "DIFF": {
          const rawRows = b.objects.filter((o) => o.status === "raw");
          const neq = rawRows.filter((o) => o.rel === "≠");
          const sess = rawRows.filter((o) => NO_CANON.has(o.type));
          return res(true, [`raw=${rawRows.length}  ≠still=${neq.length}  session/tape=${sess.length}`, "# ещё не канон, но уже плоскость", ...rawRows.slice(0, 30).map((o) => tsvLine([o.id, o.type, o.title])), "# ≠ ждут ACCEPT (пачкой, не чатом)", ...neq.map((o) => `ACCEPT ${o.id}`)].join("\n"));
        }
        case "PACKET": {
          let rows = b.links;
          const bits = arg.split(/\s+/).filter(Boolean);
          if (bits.length === 2 && CLUSTERS.includes(bits[0].toUpperCase() as Cluster) && CLUSTERS.includes(bits[1].toUpperCase() as Cluster)) {
            const [x, y] = bits.map((s) => s.toUpperCase());
            rows = b.links.filter((l) => this.get(l.from)?.cluster === x && this.get(l.to)?.cluster === y);
          } else if (arg) rows = b.links.filter((l) => l.from === arg || l.to === arg);
          return res(true, [`PACKET ${arg || "*"} → ${rows.length}`, ...rows.map((l) => `${l.from} -${l.rel}-> ${l.to}\t${l.note ?? ""}`)].join("\n"), rows);
        }
        case "WIRE": {
          const [f, t, rel] = arg.split(/\s+/);
          if (!f || !t) return res(false, "WIRE from to [rel]");
          const out = this.wire(f, t, rel);
          return res(out.startsWith("WIRE"), out);
        }
        case "UNWIRE": {
          const [f, t, rel] = arg.split(/\s+/);
          if (!f || !t) return res(false, "UNWIRE from to [rel]");
          const out = this.unwire(f, t, rel);
          return res(out.startsWith("UNWIRE"), out);
        }
        case "PROBE": {
          const [x, y] = arg.toUpperCase().split(/\s+/);
          if (!x || !y) return res(false, "PROBE from to   например PROBE C A");
          const src = rowsOf(b, evalSet(b, x).ids), dst = rowsOf(b, evalSet(b, y).ids).map((o) => [o, tokens(o.title)] as const);
          const out: string[] = [];
          for (const s of src) {
            const st = tokens(s.title);
            if (!st.size) continue;
            for (const [d, dt] of dst) {
              if (s.id === d.id) continue;
              const hit = [...st].filter((w) => dt.has(w));
              if (hit.length) out.push(`${s.id} -?-> ${d.id}\t${hit.slice(0, 6).join(",")}`);
            }
          }
          return res(true, [`PROBE ${x}→${y}`, ...out.slice(0, 40), `candidates=${out.length}`].join("\n"), out);
        }
        case "PORT": {
          const [x, y] = arg.toUpperCase().split(/\s+/);
          if (!x || !y) return res(false, "PORT from to   например PORT C A");
          const left = rowsOf(b, evalSet(b, `CELL ∩ ${x}`).ids);
          const right = rowsOf(b, evalSet(b, `${y} ∩ CANON`).ids).filter((o) => ["fact", "decision"].includes(o.type));
          return res(true, [`PORT ${x}→${y}  left=${left.length} right=${right.length} cartesian=${left.length * right.length}`, "MUL запрещён: не паять все пары. Одна связь: WIRE id id constrains", "LEFT cells", ...left.slice(0, 20).map((o) => tsvLine([o.id, formatCell({ pred: o.pred!, rel: o.rel!, obj: o.obj! })])), "RIGHT canon fact|decision", ...right.slice(0, 20).map((o) => tsvLine([o.id, o.type, o.title]))].join("\n"));
        }
        case "INSTR":
        case "GAUGE":
        case "PANEL": {
          const r = this.readout();
          return res(true, `INSTR charge=${Math.round(r.charge * 100)}% raw=${r.raw} canon=${r.canon} cells=${r.cells} neq=${r.neq} pkt=${r.packets} junk=${r.junk} orphans=${r.orphans} warn=${r.warns.length}${r.warns.length ? ` [${r.warns.join(", ")}]` : ""}`, r);
        }
        case "GAP": {
          const notes = this.gap();
          return res(true, [`GAP planted=${notes.filter((n) => n.startsWith("GAP")).length}`, ...notes].join("\n") || "нет красной зоны");
        }
        case "SETTLE": {
          const notes = this.settle();
          return res(true, [`SETTLE`, ...notes].join("\n"));
        }
        case "RUN": {
          const o = this.get(arg);
          if (!o) return res(false, `нет ${arg}`);
          if (o.status !== "canon") return res(false, `RUN только canon, сейчас ${o.status}`);
          this.log("RUN", o.id, o.title);
          return res(true, [`RUN ${o.id} ${o.title}`, "# next (из записей, не из ленты)", ...this.next()].join("\n"));
        }
        case "NEXT": return res(true, ["# next (из правил, не из ленты)", ...this.next()].join("\n"), this.next());
        case "FETCH": {
          const id = `Q-FETCH-${nowIso().slice(11, 19).replace(/:/g, "")}`;
          const ts = nowIso();
          this.insert({ id, cluster: "C", layer: 2, type: "question", title: arg || "чего нет в каноне?", status: "raw", body: "FETCH с L4 на L1", createdAt: ts, updatedAt: ts, owner: "machine:exec" }, "FETCH", "new L1");
          return res(true, `FETCH ${id}`, id);
        }
        case "WHY": {
          if (!arg) return res(false, "WHY id");
          return res(true, this.why(arg).join("\n"));
        }
        case "UNDO": return res(true, this.undo());
        case "SPEC": {
          const counts = new Map<string, number>();
          for (const e of b.events) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
          const r = this.readout();
          const lines = ["action\tn\tkind", ...[...counts.entries()].sort((p, q) => q[1] - p[1]).map(([a, n]) => tsvLine([a, n, WRITE_VERBS.has(a) || ["seed", "REFUSE"].includes(a) ? "write" : "read"]))];
          lines.push("DEBT");
          for (const rule of RULES) {
            const row = this.get(rule.gapId);
            if (row) lines.push(tsvLine([rule.gapId, row.status, rule.warn, r.warns.includes(rule.warn) ? "LIVE" : "settled"]));
          }
          lines.push("RULE verb only if same LIVE GAP >= 3 and PORT cartesian not MUL");
          lines.push(`cells=${r.cells} neq=${r.neq} charge=${r.charge} warn=${r.warns.length}`);
          return res(true, lines.join("\n"), { counts: Object.fromEntries(counts), readout: r });
        }
        case "JSON": return res(true, JSON.stringify(this.snapshot()), this.snapshot());
        case "DUMP":
        case "CANON":
        case "RAW": {
          const rows = b.objects.filter((o) => verb === "DUMP" || o.status === (verb === "CANON" ? "canon" : "raw")).sort((p, q) => p.cluster.localeCompare(q.cluster) || p.id.localeCompare(q.id));
          return res(true, ["id\tcluster\tlayer\ttype\ttitle\tstatus\tbody\tpred\trel\tobj", ...rows.map((o) => tsvLine([o.id, o.cluster, o.layer, o.type, o.title, o.status, o.body.slice(0, 800), o.pred, o.rel, o.obj]))].join("\n"));
        }
        case "BATCH": {
          const bits = arg.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
          const out: string[] = [];
          let wrote = false;
          for (const bit of bits) {
            if (/^BATCH\b/i.test(bit)) { out.push("skip nested BATCH"); continue; }
            const r = this.exec(bit);
            wrote ||= r.wrote;
            out.push(`# ${bit}`, r.text);
          }
          return { ok: true, verb, text: out.join("\n"), wrote };
        }
        case "MUL":
        case "TIMES": return res(false, "MUL запрещён: A×B склеивает кластеры. Морфизм только PACKET.");
        default: return res(false, `unknown ${verb}. алфавит: ${VERBS.map((v) => v.verb.split(" ")[0]).join(" ")}`);
      }
    } catch (e) {
      return res(false, e instanceof Error ? e.message : String(e));
    }
  }

  snapshot() {
    const r = this.readout();
    const row = (o: Obj) => ({ id: o.id, cluster: o.cluster, layer: o.layer, type: o.type, title: o.title, status: o.status, body: o.body.slice(0, 800), pred: o.pred ?? "", rel: o.rel ?? "", obj: o.obj ?? "" });
    return {
      instr: r,
      raw: this.book.objects.filter((o) => o.status === "raw").map(row),
      canon: this.book.objects.filter((o) => o.status === "canon").map(row),
      wires: this.book.links.map((l) => ({ from: l.from, rel: l.rel, to: l.to, note: l.note ?? "" })),
      cells: rowsOf(this.book, evalSet(this.book, "CELL").ids).map(row),
    };
  }
}

/** Формулы строки команд: =COUNTIF(≠) → NEQ, =PIVOT → GRID, =A ∩ B → SET A ∩ B. */
export function formula(t: string): string {
  let s = t
    .replace(/^COUNTIF\s*\(?\s*≠\s*\)?/i, "NEQ")
    .replace(/^PIVOT$/i, "GRID")
    .replace(/^COUNT\s*\(?\s*RAW\s*\)?/i, "RAW")
    .replace(/^COUNT\s*\(?\s*CANON\s*\)?/i, "CANON");
  if (/[∩∪\\]/.test(s) && !/^(SET|ACCEPT|FILL|TAKE|BATCH|VOCAB)\b/i.test(s)) s = "SET " + s;
  return s;
}

/** Книга из семени v1 (объекты/рёбра/происхождение из sqlite-seed). */
export function bookFromSeed(seed: { objects: any[]; links: any[]; origins?: any[]; packets?: any[] }): Book {
  const book = emptyBook();
  const ts = nowIso();
  for (const r of seed.objects) {
    const o: Obj = {
      id: r.id, cluster: r.cluster, layer: Number(r.layer) === 1 ? 1 : 2, type: r.type, title: r.title, status: r.status,
      body: r.body ?? "", createdAt: r.created_at ?? r.createdAt ?? ts, updatedAt: r.updated_at ?? r.updatedAt ?? ts, owner: r.owner ?? "seed",
    };
    const cell = parseCell(o.title);
    if (cell) Object.assign(o, cell);
    book.objects.push(o);
  }
  for (const l of seed.links) book.links.push({ from: l.from_id ?? l.from, to: l.to_id ?? l.to, rel: l.rel, note: l.note ?? undefined });
  for (const g of seed.origins ?? []) book.origins.push({ objectId: g.object_id ?? g.objectId, sessionId: g.session_id ?? g.sessionId, span: g.span ?? undefined });
  book.events.push({ seq: 1, ts, actor: "agent:registrar", action: "seed", detail: `первичная загрузка канона: ${book.objects.length} объектов, ${book.links.length} рёбер` });
  return book;
}

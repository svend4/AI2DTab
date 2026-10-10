/**
 * Стол v2.1: исполнитель алфавита над книгой.
 *
 * Тот же язык, что в v1 (PLANT LOOK SET NEQ FILL SWEEP … SPEC), плюс:
 *   UNDO    — откат последнего хода целиком (ход = один вызов exec, BATCH — один ход)
 *   NEXT    — ход из правил, не из зашитых id
 *   WHY     — объяснить строку: ячейка, рёбра, происхождение, журнал
 *   ACTOR   — кто ходит: human | machine; машина не ставит канон
 *   MERGE / DIFFBOOK — вторая книга: слить / показать разницу
 *   CHAIN   — подсказки рёбер по цепочкам ячеек (obj одной = pred другой)
 *   TURN    — записи по ходам исходного диалога
 *   REPAIR id — вернуть канон-строку в raw явно
 * Нет субпроцессов и путей: чистая функция над JSON, работает в браузере.
 */
import { formatCell, normToken, parseCell, tokens } from "./cells.ts";
import { liveRules, readout, RULES } from "./instruments.ts";
import { diffBooks, mergeBooks } from "./merge.ts";
import { isTsv, plantText, plantTsv, toObj, type ChunkMode, type Seedling } from "./plant.ts";
import { evalGeneric, evalSet, isJunkCanon, isSetExpr, rowsOf } from "./sets.ts";
import type { Actor, Book, Cluster, Event, ExecResult, Link, Obj, Readout, Status } from "./types.ts";
import { CLUSTERS, emptyBook, NO_CANON, nowIso } from "./types.ts";
import { normalizeBook } from "./validate.ts";

export const VERBS: { verb: string; doc: string; write: boolean }[] = [
  { verb: "STATUS", doc: "сводка по кластер × тип × статус", write: false },
  { verb: "LOOK q", doc: "поиск по id/заголовку/телу — сразу по всем кластерам", write: false },
  { verb: "PLANT text|tsv", doc: "посадить ленту: абзацы/секции → строки raw (идемпотентно); CUT — то же", write: true },
  { verb: "PREVIEW text", doc: "сухая посадка: что получится, без записи", write: false },
  { verb: "ACCEPT id|set", doc: "в канон (session/tape — REFUSE; машина — REFUSE)", write: true },
  { verb: "FILL", doc: "= ACCEPT NEQ ∩ RAW", write: true },
  { verb: "TAKE id|set", doc: "вычесть (канон не вычитается)", write: true },
  { verb: "SWEEP", doc: "= TAKE SESSION", write: true },
  { verb: "PURGE", doc: "= TAKE JUNK", write: true },
  { verb: "REPAIR [id]", doc: "канон-мусор → raw; с id — вернуть любую канон-строку в raw", write: true },
  { verb: "SET expr", doc: "множество: NEQ ∩ (RAW ∪ CANON) \\ C, type:question, has:link, turn:3", write: false },
  { verb: "NEQ | CELL", doc: "ячейки pred rel obj (живые: raw|canon)", write: false },
  { verb: "CONC [q]", doc: "конкорданс токенов ячеек", write: false },
  { verb: "VOCAB expr", doc: "словарь заголовков множества (полное выражение)", write: false },
  { verb: "GRID | MATRIX", doc: "тип × кластер: raw/canon/прочее", write: false },
  { verb: "DIFF", doc: "что ещё raw; какие ≠ ждут ACCEPT", write: false },
  { verb: "PACKET [id|A B]", doc: "рёбра: все, по id или кластер→кластер", write: false },
  { verb: "WIRE a b [rel]", doc: "одно ребро (не MUL)", write: true },
  { verb: "UNWIRE a b [rel]", doc: "снять ребро", write: true },
  { verb: "PROBE A B", doc: "кандидаты рёбер по общим токенам", write: false },
  { verb: "CHAIN", doc: "кандидаты рёбер по цепочкам ячеек: obj одной = pred другой", write: false },
  { verb: "PORT A B", doc: "декартово ячейки≠ × канон — показать, не паять", write: false },
  { verb: "INSTR", doc: "приборы: заряд, перекос, рёбра, красная зона", write: false },
  { verb: "GAP", doc: "красная зона → вопросы-GAP (raw)", write: true },
  { verb: "SETTLE", doc: "закрыть GAP, чьё предупреждение погасло", write: true },
  { verb: "RUN id", doc: "исполнить канон-id → NEXT", write: true },
  { verb: "NEXT", doc: "ход из правил книги, не из ленты", write: false },
  { verb: "FETCH [q]", doc: "новый вопрос: raw на плоскость и строка на ленту", write: true },
  { verb: "WHY id", doc: "почему строка такая: ячейка, рёбра, происхождение, журнал", write: false },
  { verb: "TURN [n]", doc: "записи по ходам исходного диалога", write: false },
  { verb: "UNDO", doc: "откат последнего хода целиком", write: true },
  { verb: "ACTOR human|machine", doc: "кто ходит; machine не ставит канон", write: true },
  { verb: "MERGE json", doc: "слить вторую книгу (канон побеждает при конфликте)", write: true },
  { verb: "DIFFBOOK json", doc: "разница со второй книгой, без записи", write: false },
  { verb: "SPEC", doc: "журнал → спецификация языка (какие глаголы живут)", write: false },
  { verb: "JSON", doc: "снимок книги для следующего агента", write: false },
  { verb: "DUMP | CANON | RAW", doc: "TSV", write: false },
  { verb: "BATCH a; b; c", doc: "пачка ходов; останавливается на первой ошибке", write: true },
  { verb: "HELP", doc: "этот список", write: false },
];

const TAB = "\t";
const MAX_EVENTS = 5000;
const WRITE_VERBS = new Set([...VERBS.filter((v) => v.write).map((v) => v.verb.split(" ")[0]), "CUT"]);

function tsvLine(cols: (string | number | undefined)[]): string {
  return cols.map((c) => String(c ?? "").replace(/\t/g, " ").replace(/\n/g, " / ")).join(TAB);
}

export class Desk {
  book: Book;
  actor: Actor = "human";
  private seq = 0;
  private move = 0;
  private writes = 0;
  private depth = 0;

  constructor(book?: Book) {
    this.book = book ?? emptyBook();
    this.seq = this.book.events.reduce((m, e) => Math.max(m, e.seq), 0);
    this.move = this.book.events.reduce((m, e) => Math.max(m, e.move ?? 0), 0);
    const lastActor = [...this.book.events].reverse().find((e) => e.action === "ACTOR" && !e.undone);
    if (lastActor?.detail === "machine") this.actor = "machine";
  }

  // ---------- низкоуровневые записи ----------

  private log(action: string, objectId?: string, detail?: string, extra: Partial<Event> = {}): Event {
    const ev: Event = { seq: ++this.seq, ts: nowIso(), actor: `${this.actor}:exec`, action, objectId, detail, move: this.move, ...extra };
    this.book.events.push(ev);
    this.writes++;
    return ev;
  }

  /**
   * Журнал не растёт бесконечно: старые события сворачиваются в счётчики глаголов.
   * Вызывается один раз в начале хода. Не трогаются: seed и события последнего
   * откатываемого хода — иначе UNDO большой посадки был бы частичным.
   */
  private compact(): void {
    let over = this.book.events.length - MAX_EVENTS;
    if (over <= 0) return;
    const ev = this.book.events;
    const lastUndoable = ev.reduce((m, e) => (!e.undone && e.action !== "UNDO" && e.move !== undefined && e.move !== this.move && (e.before !== undefined || e.link) ? Math.max(m, e.move) : m), -1);
    const keep: Event[] = [ev[0]];
    this.book.compacted = this.book.compacted ?? {};
    for (let i = 1; i < ev.length; i++) {
      const e = ev[i];
      if (over > 0 && e.move !== this.move && e.move !== lastUndoable) {
        this.book.compacted[e.action] = (this.book.compacted[e.action] ?? 0) + 1;
        over--;
        continue;
      }
      keep.push(e);
    }
    this.book.events = keep;
  }

  get(id: string): Obj | undefined {
    return this.book.objects.find((o) => o.id === id);
  }

  /** Снимок полей до/после. Отсутствующее поле пишется как null, чтобы пережить JSON и сняться при откате. */
  private snap(o: Obj): Partial<Obj> {
    return { status: o.status, updatedAt: o.updatedAt, pred: o.pred ?? (null as unknown as string), rel: o.rel ?? (null as unknown as Obj["rel"]), obj: o.obj ?? (null as unknown as string) };
  }

  private setStatus(o: Obj, status: Status, action: string, detail?: string, before?: Partial<Obj>): void {
    const b = before ?? this.snap(o);
    o.status = status;
    o.updatedAt = nowIso();
    this.log(action, o.id, detail ?? o.title, { before: b, after: this.snap(o) });
  }

  private insert(o: Obj, action: string, detail?: string): boolean {
    if (this.get(o.id)) return false;
    this.book.objects.push(o);
    this.log(action, o.id, detail ?? o.title, { before: null });
    return true;
  }

  private uniqueId(base: string): string {
    if (!this.get(base)) return base;
    let n = 2;
    while (this.get(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  // ---------- ходы ----------

  plant(seedlings: Seedling[], source?: string): { planted: string[]; skipped: string[]; collisions: string[]; lines: string[] } {
    const planted: string[] = [];
    const skipped: string[] = [];
    const collisions: string[] = [];
    const lines: string[] = [];
    const ts = nowIso();
    // индексы на время посадки: 32 тыс. записей не должны стоить 32 тыс. линейных поисков каждая
    const byId = new Map(this.book.objects.map((o) => [o.id, o]));
    const byHash = new Map<string, Obj[]>();
    for (const o of this.book.objects) if (o.hash) byHash.set(o.hash, [...(byHash.get(o.hash) ?? []), o]);
    for (const s of seedlings) {
      const ex = byId.get(s.id);
      let id = s.id;
      if (ex) {
        // тот же текст мог уже сесть под суффиксом: ищем по хешу во всей семье id
        const same = ex.hash === s.hash || !ex.hash ? ex : (byHash.get(s.hash) ?? []).find((o) => o.id.startsWith(`${s.id}-`));
        if (same) {
          skipped.push(same.id);
          lines.push(`skip ${same.id} already ${same.type}/${same.status}`);
          continue;
        }
        let n = 2;
        while (byId.has(`${s.id}-${n}`)) n++;
        id = `${s.id}-${n}`;
        collisions.push(id);
      }
      const o = toObj({ ...s, id }, ts, `${this.actor}:plant`);
      byId.set(o.id, o);
      byHash.set(o.hash!, [...(byHash.get(o.hash!) ?? []), o]);
      this.book.objects.push(o);
      this.log("PLANT", o.id, `${s.why}: ${s.title}`.slice(0, 160), { before: null });
      if (s.turn !== undefined || source) {
        this.book.origins.push({ objectId: o.id, sessionId: source ?? "tape", span: s.turn !== undefined ? `turn ${s.turn}` : s.why });
      }
      planted.push(o.id);
      lines.push(`plant ${o.id}${collisions.includes(id) ? " (collision)" : ""}\t${o.type}\t${o.title.slice(0, 80)}`);
    }
    return { planted, skipped, collisions, lines };
  }

  accept(o: Obj): string {
    if (NO_CANON.has(o.type)) {
      this.log("REFUSE", o.id, `type=${o.type}`);
      return `REFUSE ${o.id} type=${o.type}`;
    }
    if (this.actor === "machine") {
      this.log("REFUSE", o.id, "machine→canon");
      return `REFUSE ${o.id} machine cannot canon`;
    }
    if (o.status === "canon") return `skip ${o.id} already canon`;
    const before = this.snap(o);
    if (!o.pred) {
      const cell = parseCell(o.title);
      if (cell) Object.assign(o, cell);
    }
    this.setStatus(o, "canon", "ACCEPT", undefined, before);
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

  /** Откат последнего хода: все его события в обратном порядке. События остаются, помеченные undone. */
  undo(): string {
    const last = [...this.book.events].reverse().find((e) => !e.undone && e.action !== "UNDO" && e.move !== undefined && (e.before !== undefined || e.link));
    if (!last) return "нечего откатывать";
    const latestWrite = [...this.book.events].reverse().find((e) => !e.undone && e.action !== "UNDO" && e.move !== undefined);
    if (latestWrite && latestWrite.action === "MERGE" && latestWrite.move !== last.move) return "MERGE не откатывается: слейте обратно экспорт, снятый до слияния (DIFFBOOK покажет разницу)";
    const group = this.book.events.filter((e) => e.move === last.move && !e.undone && e.action !== "UNDO").reverse();
    const done: string[] = [];
    for (const ev of group) {
      if (ev.action === "WIRE" && ev.link) {
        const l = ev.link;
        this.book.links = this.book.links.filter((x) => !(x.from === l.from && x.to === l.to && x.rel === l.rel));
      } else if (ev.action === "UNWIRE" && ev.link) {
        this.book.links.push(ev.link);
      } else if (ev.before === null && ev.objectId) {
        this.book.origins = this.book.origins.filter((o) => o.objectId !== ev.objectId);
        this.book.objects = this.book.objects.filter((o) => o.id !== ev.objectId);
      } else if (ev.before && ev.objectId) {
        const o = this.get(ev.objectId);
        if (!o) continue;
        if (this.actor === "machine" && ev.before.status === "canon") {
          done.push(`REFUSE ${ev.objectId} machine cannot canon`);
          continue;
        }
        for (const [k, v] of Object.entries(ev.before)) {
          if (v === null || v === undefined) delete (o as unknown as Record<string, unknown>)[k];
          else (o as unknown as Record<string, unknown>)[k] = v;
        }
      } else {
        continue;
      }
      ev.undone = true;
      done.push(`${ev.action} ${ev.objectId ?? ""}`.trim());
    }
    this.log("UNDO", last.objectId, `ход ${last.move}: ${done.join(", ")}`.slice(0, 400));
    return `UNDO ход ${last.move}: ${done.length} — ${done.slice(0, 6).join(", ")}${done.length > 6 ? "…" : ""}`;
  }

  readout(): Readout {
    return readout(this.book);
  }

  gap(): string[] {
    const r = this.readout();
    const notes: string[] = [];
    for (const rule of liveRules(r)) {
      const row = this.get(rule.gapId);
      if (row) {
        if (["closed", "rejected"].includes(row.status)) {
          this.setStatus(row, "raw", "GAP", `снова: ${rule.warn}`);
          notes.push(`GAP ${rule.gapId} снова открыт (${rule.warn})`);
        } else notes.push(`skip ${rule.gapId}`);
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
    const neqRaw = b.objects.filter((o) => o.status === "raw" && o.type === "observation" && o.rel === "≠").length;
    if (neqRaw) out.push(`${neqRaw} ячеек ≠ ждут FILL`);
    const chains = this.chain().length;
    if (chains) out.push(`${chains} цепочек ячеек без ребра: CHAIN`);
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
    if (isJunkCanon(o) && o.status === "canon") out.push("похоже на мусор в каноне: REPAIR вернёт в raw");
    const links = this.book.links.filter((l) => l.from === id || l.to === id);
    out.push(links.length ? `рёбра: ${links.map((l) => `${l.from} -${l.rel}-> ${l.to}`).join("; ")}` : "рёбер нет");
    const or = this.book.origins.filter((x) => x.objectId === id);
    if (or.length) out.push(`происхождение: ${or.map((x) => `${x.sessionId}${x.span ? ` (${x.span})` : ""}`).join(", ")}`);
    const pk = (this.book.packets ?? []).find((p) => p.id === id);
    if (pk) out.push(`письмо ${pk.fromSession} → ${pk.toSession}: ${pk.subject}\n${pk.body}`);
    const ev = this.book.events.filter((e) => e.objectId === id);
    out.push(ev.length ? `журнал: ${ev.map((e) => `${e.ts.slice(5, 16)} ${e.action}${e.undone ? "↩" : ""}`).join(" → ")}` : "журнал пуст");
    return out;
  }

  /** Цепочки: obj одной ячейки = pred другой, ребра нет. */
  chain(): { from: string; to: string; via: string }[] {
    const cells = rowsOf(this.book, evalSet(this.book, "CELL").ids);
    const byPred = new Map<string, Obj[]>();
    for (const c of cells) {
      const k = normToken(c.pred!);
      byPred.set(k, [...(byPred.get(k) ?? []), c]);
    }
    const have = new Set(this.book.links.map((l) => `${l.from}\t${l.to}`));
    const out: { from: string; to: string; via: string }[] = [];
    for (const a of cells) {
      for (const b of byPred.get(normToken(a.obj!)) ?? []) {
        if (a.id === b.id || have.has(`${a.id}\t${b.id}`)) continue;
        out.push({ from: a.id, to: b.id, via: normToken(a.obj!) });
      }
    }
    return out;
  }

  // ---------- исполнитель строки ----------

  /** Чтение для рендера: без нового хода и без записи. Пишущие глаголы здесь отвергаются. */
  read(line: string): ExecResult {
    const verb = (line || "").trim().replace(/^=/, "").split(/\s+/)[0]?.toUpperCase() ?? "";
    if (WRITE_VERBS.has(verb)) return { ok: false, verb, text: `${verb}: только через exec`, wrote: false };
    this.depth++;
    try {
      return this.run(line);
    } finally {
      this.depth--;
    }
  }

  exec(line: string): ExecResult {
    const top = this.depth === 0;
    if (top) {
      // уплотнение — один раз на ход, до него: события самого хода никогда не режутся
      this.compact();
      this.move++;
    }
    const writesBefore = this.writes;
    this.depth++;
    try {
      const r = this.run(line);
      return { ...r, wrote: r.wrote || this.writes !== writesBefore };
    } finally {
      this.depth--;
    }
  }

  private run(line: string): ExecResult {
    const raw = (line || "").trim();
    const norm = raw.startsWith("=") ? formula(raw.slice(1).trim()) : raw;
    const m = norm.match(/^(\S+)([\s\S]*)$/);
    const verb = (m?.[1] || "").toUpperCase();
    const arg = (m?.[2] || "").trim();
    const res = (ok: boolean, text: string, data?: unknown): ExecResult => ({ ok, verb, text, data, wrote: false });
    const b = this.book;
    try {
      switch (verb) {
        case "": return res(false, "пустой ход");
        case "HELP": return res(true, VERBS.map((v) => `${v.verb.padEnd(20)} ${v.doc}`).join("\n"), VERBS);
        case "STATUS": {
          const grid = new Map<string, number>();
          for (const o of b.objects) grid.set(`${o.cluster}\t${o.type}\t${o.status}`, (grid.get(`${o.cluster}\t${o.type}\t${o.status}`) ?? 0) + 1);
          const lines = [...grid.entries()].sort().map(([k, n]) => `${k}\t${n}`);
          const openQ = b.objects.filter((o) => o.type === "question" && o.status === "open").length;
          return res(true, ["кластер\tтип\tстатус\tn", ...lines, `открытых вопросов: ${openQ}`, `actor: ${this.actor}`].join("\n"));
        }
        case "LOOK": {
          const q = arg.toLowerCase();
          const rows = b.objects.filter((o) => !q || `${o.id} ${o.title} ${o.body}`.toLowerCase().includes(q));
          return res(true, [`LOOK ${arg} → ${rows.length}`, ...rows.slice(0, 60).map((o) => tsvLine([o.id, o.type, o.status, o.title]))].join("\n"), rows.map((o) => o.id));
        }
        case "PREVIEW": {
          const s = isTsv(arg) ? plantTsv(arg) : plantText(arg);
          return res(true, [`PREVIEW → ${s.length}`, ...s.slice(0, 200).map((x) => tsvLine([x.id, x.cluster, x.type, x.why, x.title]))].join("\n"), s);
        }
        case "PLANT":
        case "CUT": {
          if (!arg) return res(false, "PLANT: нужен текст или TSV");
          const s = isTsv(arg) ? plantTsv(arg) : plantText(arg);
          const r = this.plant(s);
          return res(true, [...r.lines.slice(0, 200), `n=${s.length} planted=${r.planted.length} skipped=${r.skipped.length}${r.collisions.length ? ` collisions=${r.collisions.length}` : ""}`].join("\n"), r);
        }
        case "ACCEPT":
        case "FILL": {
          const expr = arg || (verb === "FILL" ? "NEQ ∩ RAW" : "");
          if (!expr) return res(false, "ACCEPT id|множество");
          if (isSetExpr(expr)) {
            const { ids, name } = evalSet(b, expr);
            const rows = rowsOf(b, ids);
            const neqSet = /NEQ|≠|CELL/i.test(name);
            const notes = rows.map((o) => (neqSet && !o.pred && !parseCell(o.title) ? (this.log("REFUSE", o.id, "not-a-cell"), `REFUSE ${o.id} not-a-cell ${o.title.slice(0, 60)}`) : this.accept(o)));
            const ok = notes.filter((n) => n.startsWith("ACCEPT")).length;
            const no = notes.filter((n) => n.startsWith("REFUSE")).length;
            const sk = notes.length - ok - no;
            return res(true, [`ACCEPT ${name} → ok=${ok} refuse=${no} skip=${sk}`, ...notes.slice(0, 80)].join("\n"), { ok, no, sk });
          }
          const o = this.get(expr);
          if (!o) return res(false, `нет ${expr}`);
          const out = this.accept(o);
          return res(!out.startsWith("REFUSE"), out);
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
          const out = this.take(o);
          return res(!out.startsWith("REFUSE"), out);
        }
        case "REPAIR": {
          if (arg) {
            const o = this.get(arg);
            if (!o) return res(false, `нет ${arg}`);
            if (o.status !== "canon") return res(false, `REPAIR только canon, сейчас ${o.status}`);
            this.setStatus(o, "raw", "REPAIR", "явно");
            return res(true, `REPAIR ${o.id} → raw`);
          }
          const junk = b.objects.filter((o) => o.status === "canon" && isJunkCanon(o));
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
          return res(true, [`${verb} → ${rows.length}`, "id\tstatus\tpred\trel\tobj", ...rows.slice(0, 200).map((o) => tsvLine([o.id, o.status, o.pred, o.rel, o.obj]))].join("\n"), rows.map((o) => o.id));
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
          if (q) return res(true, [`CONC ${arg} → ${hits.length}`, ...hits.slice(0, 200)].join("\n"));
          const items = [...bag.entries()].flatMap(([tok, r]) => (["pred", "obj"] as const).filter((k) => r[k].length).map((k) => ({ tok, role: k, n: r[k].length, ids: r[k] })));
          items.sort((a, c) => c.n - a.n);
          return res(true, [`CONC → ${items.length} tokens in ${rows.length} cells`, "token\trole\tn\tids", ...items.slice(0, 40).map((i) => tsvLine([i.tok, i.role, i.n, i.ids.slice(0, 8).join(",")]))].join("\n"), items);
        }
        case "VOCAB": {
          if (!arg) return res(false, "VOCAB expr");
          const { ids: acc, name } = evalGeneric<string>(arg, (nm) => {
            const out = new Set<string>();
            for (const o of rowsOf(b, evalSet(b, nm).ids)) for (const t of tokens(`${o.title} ${o.pred ?? ""} ${o.obj ?? ""}`)) out.add(t);
            return out;
          });
          return res(true, [`VOCAB ${name} → ${acc.size}`, [...acc].sort().slice(0, 80).join(" ")].join("\n"), [...acc]);
        }
        case "GRID":
        case "MATRIX": {
          if (verb === "MATRIX" && /^\S+\s*(×|\*|\bx\b)\s*\S+$/i.test(arg)) return res(false, "MUL запрещён: A×B склеивает кластеры. Морфизм только PACKET.");
          const types = [...new Set(b.objects.map((o) => o.type))].sort();
          const lines = ["тип \\ кластер\t" + CLUSTERS.join("\t") + "\t(raw/canon/прочее)"];
          for (const t of types) lines.push(tsvLine([t, ...CLUSTERS.map((c) => {
            const rows = b.objects.filter((o) => o.type === t && o.cluster === c && o.status !== "rejected");
            const r = rows.filter((o) => o.status === "raw").length, cn = rows.filter((o) => o.status === "canon").length;
            return `${r}r/${cn}c/${rows.length - r - cn}o`;
          })]));
          return res(true, lines.join("\n"));
        }
        case "DIFF": {
          const rawRows = b.objects.filter((o) => o.status === "raw");
          const neq = rawRows.filter((o) => o.rel === "≠" && o.type === "observation");
          const sess = rawRows.filter((o) => NO_CANON.has(o.type));
          return res(true, [`raw=${rawRows.length}  ≠still=${neq.length}  session/tape=${sess.length}`, "# ещё не канон, но уже плоскость", ...rawRows.slice(0, 30).map((o) => tsvLine([o.id, o.type, o.title])), "# ≠ ждут ACCEPT (пачкой, не чатом)", ...neq.slice(0, 200).map((o) => `ACCEPT ${o.id}`)].join("\n"));
        }
        case "PACKET": {
          let rows = b.links;
          const bits = arg.split(/\s+/).filter(Boolean);
          if (bits.length === 2 && CLUSTERS.includes(bits[0].toUpperCase() as Cluster) && CLUSTERS.includes(bits[1].toUpperCase() as Cluster)) {
            const [x, y] = bits.map((s) => s.toUpperCase());
            rows = b.links.filter((l) => this.get(l.from)?.cluster === x && this.get(l.to)?.cluster === y);
          } else if (arg) rows = b.links.filter((l) => l.from === arg || l.to === arg);
          return res(true, [`PACKET ${arg || "*"} → ${rows.length}`, ...rows.slice(0, 400).map((l) => `${l.from} -${l.rel}-> ${l.to}\t${l.note ?? ""}`)].join("\n"), rows);
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
              if (out.length >= 400) break;
            }
            if (out.length >= 400) break;
          }
          return res(true, [`PROBE ${x}→${y}`, ...out.slice(0, 40), `candidates=${out.length}${out.length >= 400 ? "+" : ""}`].join("\n"), out);
        }
        case "CHAIN": {
          const c = this.chain();
          return res(true, [`CHAIN → ${c.length}`, ...c.slice(0, 40).map((x) => `WIRE ${x.from} ${x.to} chains\t${x.via}`)].join("\n"), c);
        }
        case "PORT": {
          const [x, y] = arg.toUpperCase().split(/\s+/);
          if (!x || !y) return res(false, "PORT from to   например PORT C A");
          const left = rowsOf(b, evalSet(b, `NEQ ∩ ${x}`).ids);
          const right = rowsOf(b, evalSet(b, `${y} ∩ CANON`).ids).filter((o) => ["fact", "decision"].includes(o.type));
          return res(true, [`PORT ${x}→${y}  left=${left.length} right=${right.length} cartesian=${left.length * right.length}`, "MUL запрещён: не паять все пары. Одна связь: WIRE id id constrains", "LEFT NEQ", ...left.slice(0, 20).map((o) => tsvLine([o.id, formatCell({ pred: o.pred!, rel: o.rel!, obj: o.obj! })])), "RIGHT canon fact|decision", ...right.slice(0, 20).map((o) => tsvLine([o.id, o.type, o.title]))].join("\n"));
        }
        case "INSTR":
        case "GAUGE":
        case "PANEL": {
          const r = this.readout();
          return res(true, `INSTR charge=${Math.round(r.charge * 100)}% raw=${r.raw} canon=${r.canon} rejected=${r.rejected} cells=${r.cells} neq=${r.neq} pkt=${r.packets} junk=${r.junk} orphans=${r.orphans} warn=${r.warns.length}${r.warns.length ? ` [${r.warns.join(", ")}]` : ""}`, r);
        }
        case "GAP": {
          const notes = this.gap();
          return res(true, [`GAP planted=${notes.filter((n) => n.startsWith("GAP")).length}`, ...notes].join("\n") || "нет красной зоны");
        }
        case "SETTLE": return res(true, ["SETTLE", ...this.settle()].join("\n"));
        case "RUN": {
          const o = this.get(arg);
          if (!o) return res(false, `нет ${arg}`);
          if (o.status !== "canon") return res(false, `RUN только canon, сейчас ${o.status}`);
          this.log("RUN", o.id, o.title);
          return res(true, [`RUN ${o.id} ${o.title}`, "# next (из записей, не из ленты)", ...this.next()].join("\n"));
        }
        case "NEXT": {
          const n = this.next();
          return res(true, ["# next (из правил, не из ленты)", ...n].join("\n"), n);
        }
        case "FETCH": {
          const title = (arg || "чего нет в каноне?").slice(0, 200);
          const ts = nowIso();
          const id = this.uniqueId(`Q-FETCH-${ts.slice(5, 10).replace("-", "")}-${ts.slice(11, 19).replace(/:/g, "")}`);
          this.insert({ id, cluster: "C", layer: 2, type: "question", title, status: "raw", body: "FETCH с L4: вопрос на ленту и на плоскость", createdAt: ts, updatedAt: ts, owner: `${this.actor}:exec` }, "FETCH", title);
          return res(true, `FETCH ${id} ${title}`, { id, title });
        }
        case "WHY": {
          if (!arg) return res(false, "WHY id");
          return res(true, this.why(arg).join("\n"));
        }
        case "TURN": {
          const spans = new Map<number, string[]>();
          for (const g of b.origins) {
            const mm = g.span?.match(/^turn (\d+)$/);
            if (mm) spans.set(Number(mm[1]), [...(spans.get(Number(mm[1])) ?? []), g.objectId]);
          }
          if (arg) {
            const ids = spans.get(Number(arg)) ?? [];
            const rows = b.objects.filter((o) => ids.includes(o.id));
            return res(true, [`TURN ${arg} → ${rows.length}`, ...rows.slice(0, 200).map((o) => tsvLine([o.id, o.type, o.status, o.title]))].join("\n"), rows.map((o) => o.id));
          }
          const lines = [...spans.entries()].sort((p, q) => p[0] - q[0]).map(([t, ids]) => `${t}\t${ids.length}`);
          return res(true, [`TURN → ${spans.size} ходов`, "turn\tn", ...lines.slice(0, 400)].join("\n"), Object.fromEntries([...spans.entries()].map(([t, ids]) => [t, ids.length])));
        }
        case "UNDO": return res(true, this.undo());
        case "ACTOR": {
          const a = arg.toLowerCase();
          if (a !== "human" && a !== "machine") return res(false, "ACTOR human|machine");
          this.actor = a;
          this.log("ACTOR", undefined, a);
          return res(true, `ACTOR ${a}`);
        }
        case "MERGE":
        case "DIFFBOOK": {
          if (!arg) return res(false, `${verb} json`);
          let parsed: unknown;
          try {
            parsed = JSON.parse(arg);
          } catch {
            return res(false, `${verb}: не JSON`);
          }
          const { book: other, warnings } = normalizeBook(parsed);
          if (verb === "DIFFBOOK") {
            const d = diffBooks(b, other);
            return res(true, [`DIFFBOOK added=${d.added.length} removed=${d.removed.length} changed=${d.changed.length} links+${d.linksAdded.length} links-${d.linksRemoved.length}`, ...d.added.slice(0, 20).map((o) => `+ ${o.id} ${o.title.slice(0, 60)}`), ...d.removed.slice(0, 20).map((o) => `- ${o.id} ${o.title.slice(0, 60)}`), ...d.changed.slice(0, 20).map((c) => `~ ${c.id} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`), ...warnings.slice(0, 10).map((w) => `! ${w}`)].join("\n"), d);
          }
          const { book: merged, report } = mergeBooks(b, other, { prefer: this.actor === "machine" ? "base" : "canon" });
          this.book = merged;
          this.seq = this.book.events.reduce((mx, e) => Math.max(mx, e.seq), 0);
          this.log("MERGE", undefined, `+${report.added} объектов, +${report.linksAdded} рёбер, конфликтов ${report.conflicts.length}${this.actor === "machine" ? " (machine: статусы базы сохранены)" : ""}`);
          return res(true, [`MERGE added=${report.added} links=${report.linksAdded} origins=${report.originsAdded} conflicts=${report.conflicts.length}`, ...report.conflicts.slice(0, 20).map((c) => `~ ${c.id} ${c.base} vs ${c.incoming} → ${c.chosen}`), ...warnings.slice(0, 10).map((w) => `! ${w}`)].join("\n"), report);
        }
        case "SPEC": {
          const counts = new Map<string, number>();
          const undone = new Map<string, number>();
          for (const e of b.events) (e.undone ? undone : counts).set(e.action, ((e.undone ? undone : counts).get(e.action) ?? 0) + 1);
          for (const [k, n] of Object.entries(b.compacted ?? {})) counts.set(k, (counts.get(k) ?? 0) + n);
          const writeSet = new Set(VERBS.filter((v) => v.write).map((v) => v.verb.split(" ")[0]));
          const r = this.readout();
          const actions = [...new Set([...counts.keys(), ...undone.keys()])].sort((p, q) => (counts.get(q) ?? 0) - (counts.get(p) ?? 0));
          const lines = ["action\tn\tkind\tundone", ...actions.map((a) => tsvLine([a, counts.get(a) ?? 0, writeSet.has(a) || ["seed", "REFUSE", "CUT"].includes(a) ? "write" : "read", undone.get(a) ?? 0]))];
          lines.push("DEBT");
          for (const rule of RULES) {
            const row = this.get(rule.gapId);
            if (row) lines.push(tsvLine([rule.gapId, row.status, rule.warn, r.warns.includes(rule.warn) ? "LIVE" : "settled"]));
          }
          lines.push("RULE verb only if same LIVE GAP >= 3 and PORT cartesian not MUL");
          lines.push(`cells=${r.cells} neq=${r.neq} charge=${r.charge} warn=${r.warns.length} actor=${this.actor}`);
          return res(true, lines.join("\n"), { counts: Object.fromEntries(counts), undone: Object.fromEntries(undone), readout: r });
        }
        case "JSON": return res(true, JSON.stringify(this.snapshot()), this.snapshot());
        case "DUMP":
        case "CANON":
        case "RAW": {
          const rows = b.objects.filter((o) => verb === "DUMP" || o.status === (verb === "CANON" ? "canon" : "raw")).sort((p, q) => p.cluster.localeCompare(q.cluster) || p.id.localeCompare(q.id));
          return res(true, ["id\tcluster\tlayer\ttype\ttitle\tstatus\tbody\tpred\trel\tobj", ...rows.map((o) => tsvLine([o.id, o.cluster, o.layer, o.type, o.title, o.status, (o.body ?? "").slice(0, 800), o.pred, o.rel, o.obj]))].join("\n"));
        }
        case "BATCH": {
          const verbs = new Set(VERBS.map((v) => v.verb.split(" ")[0]).concat(["CUT", "CONCORD", "RANGE", "GAUGE", "PANEL", "MUL", "TIMES"]));
          // ';' делит ходы; перевод строки делит только если следующая строка начинается с глагола,
          // иначе это продолжение аргумента (многострочный PLANT), пустые строки сохраняются
          const bits: string[] = [];
          for (const piece of arg.split(";")) {
            const lines = piece.split("\n");
            lines.forEach((line, i) => {
              const head = line.trim().replace(/^=/, "").split(/\s+/)[0]?.toUpperCase() ?? "";
              const isCmd = verbs.has(head) || /^\s*=/.test(line);
              if (i === 0 || isCmd || !bits.length) {
                if (line.trim()) bits.push(line.trim());
              } else bits[bits.length - 1] += `\n${line}`;
            });
          }
          const out: string[] = [];
          let ran = 0;
          for (const bit of bits) {
            if (/^BATCH\b/i.test(bit)) { out.push("skip nested BATCH"); continue; }
            const r = this.exec(bit);
            ran++;
            out.push(`# ${bit.slice(0, 80)}`, r.text);
            if (!r.ok) {
              out.push(`BATCH остановлен на шаге ${ran} из ${bits.length}`);
              return { ok: false, verb, text: out.join("\n"), wrote: false, data: { ran, total: bits.length } };
            }
          }
          return { ok: true, verb, text: out.join("\n"), wrote: false, data: { ran, total: bits.length } };
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
    const row = (o: Obj) => ({ id: o.id, cluster: o.cluster, layer: o.layer, type: o.type, title: o.title, status: o.status, body: (o.body ?? "").slice(0, 800), pred: o.pred ?? "", rel: o.rel ?? "", obj: o.obj ?? "" });
    const turns = new Set(this.book.origins.map((g) => g.span).filter((s) => s?.startsWith("turn "))).size;
    return {
      instr: r,
      actor: this.actor,
      turns,
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

/** Книга из семени v1 (объекты/рёбра/происхождение/письма из sqlite-seed) или из любой книги. */
export function bookFromSeed(seed: unknown): Book {
  return normalizeBook(seed).book;
}

export type { ChunkMode };

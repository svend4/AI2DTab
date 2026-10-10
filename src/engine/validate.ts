/**
 * Нормализация книги из любого источника (localStorage, импорт JSON, семя v1).
 * Никогда не бросает: всё, что не книга, становится пустой книгой с предупреждением;
 * всё, что похоже на книгу, приводится к типам, а отклонения перечисляются.
 */
import { parseCell } from "./cells.ts";
import type { Book, Cluster, Event, Link, Obj, Origin, Packet, Status } from "./types.ts";
import { CLUSTERS, emptyBook, ID_RE, nowIso, RESERVED_IDS, STATUSES } from "./types.ts";

export type Normalized = { book: Book; warnings: string[] };

const OWN = Object.prototype.hasOwnProperty;

function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : v == null ? def : String(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype");
}

function isoOr(v: unknown, def: string): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : def;
}

/** Безопасный id: только [A-Za-z0-9_.:-], не имя множества, не длиннее 80. */
export function safeId(raw: unknown, warnings: string[], seen: Set<string>, reservedLater: Set<string> = new Set()): string | null {
  let id = str(raw).trim();
  if (!id) return null;
  const orig = id;
  if (!ID_RE.test(id)) {
    id = id.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
    if (!id) return null;
    warnings.push(`id «${orig.slice(0, 40)}» → ${id}`);
  }
  if (RESERVED_IDS.has(id.toUpperCase())) {
    id = `${id}-id`;
    warnings.push(`id ${orig} совпадает с именем множества → ${id}`);
  }
  if (seen.has(id) || (id !== orig && reservedLater.has(id))) {
    let n = 2;
    while (seen.has(`${id}-${n}`) || reservedLater.has(`${id}-${n}`)) n++;
    warnings.push(`дубликат id ${id} → ${id}-${n}`);
    id = `${id}-${n}`;
  }
  seen.add(id);
  return id;
}

function normObj(raw: unknown, warnings: string[], seen: Set<string>, ts: string, later: Set<string>, idMap: Map<string, string>): Obj | null {
  if (!isObj(raw)) return null;
  const id = safeId(raw.id, warnings, seen, later);
  if (!id) return null;
  const orig = str(raw.id).trim();
  if (!idMap.has(orig)) idMap.set(orig, id);
  const clusterRaw = str(raw.cluster, "C").toUpperCase();
  const cluster = (CLUSTERS as string[]).includes(clusterRaw) ? (clusterRaw as Cluster) : "C";
  if (cluster !== clusterRaw) warnings.push(`${id}: кластер «${str(raw.cluster).slice(0, 20)}» → C`);
  const statusRaw = str(raw.status, "raw");
  const status = (STATUSES as string[]).includes(statusRaw) ? (statusRaw as Status) : statusRaw === "accepted" ? "canon" : "raw";
  if (status !== statusRaw) warnings.push(`${id}: статус «${statusRaw.slice(0, 20)}» → ${status}`);
  const title = str(raw.title, id).slice(0, 400);
  const o: Obj = {
    id,
    cluster,
    layer: Number(raw.layer) === 1 ? 1 : 2,
    type: str(raw.type, "observation").slice(0, 40) || "observation",
    title,
    status,
    body: str(raw.body).slice(0, 20_000),
    createdAt: isoOr(raw.createdAt ?? raw.created_at, ts),
    updatedAt: isoOr(raw.updatedAt ?? raw.updated_at, ts),
    owner: str(raw.owner, "seed").slice(0, 40) || "seed",
  };
  if (typeof raw.hash === "string") o.hash = raw.hash.slice(0, 20);
  const cell = parseCell(title);
  if (cell) Object.assign(o, cell);
  else if (typeof raw.pred === "string" && typeof raw.obj === "string" && raw.pred && raw.obj) {
    o.pred = raw.pred.slice(0, 200);
    o.obj = raw.obj.slice(0, 200);
    o.rel = (["≠", "→", "⊂", "=", "vs"] as const).includes(raw.rel as never) ? (raw.rel as Obj["rel"]) : "≠";
  }
  return o;
}

export function normalizeBook(input: unknown): Normalized {
  const warnings: string[] = [];
  const ts = nowIso();
  const book = emptyBook();
  if (!isObj(input) || !Array.isArray(input.objects)) {
    return { book, warnings: ["не книга: ожидаю {version:2, objects, links, events}"] };
  }
  if (input.version !== 2 && !(Array.isArray(input.links) || Array.isArray(input.origins))) {
    warnings.push("версия книги не указана: читаю как семя v1");
  }
  const seen = new Set<string>();
  // все исходные id заранее: суффикс дубликата не должен совпасть с настоящим id дальше по списку
  const later = new Set<string>(input.objects.filter(isObj).map((r) => str(r.id).trim()).filter(Boolean));
  const idMap = new Map<string, string>();
  for (const r of input.objects) {
    const o = normObj(r, warnings, seen, ts, later, idMap);
    if (o) book.objects.push(o);
    else warnings.push("пропущена запись без id");
  }
  const ids = new Set(book.objects.map((o) => o.id));
  const remap = (v: unknown) => {
    const k = str(v).trim();
    return idMap.get(k) ?? k;
  };
  const linkKeys = new Set<string>();
  for (const l of Array.isArray(input.links) ? input.links : []) {
    if (!isObj(l)) continue;
    const from = remap(l.from ?? l.from_id);
    const to = remap(l.to ?? l.to_id);
    const rel = str(l.rel, "candidate").slice(0, 40) || "candidate";
    if (!ids.has(from) || !ids.has(to)) {
      warnings.push(`ребро ${from || "?"} → ${to || "?"} указывает на отсутствующую запись`);
      continue;
    }
    const key = `${from}\t${to}\t${rel}`;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    const link: Link = { from, to, rel };
    if (l.note != null) link.note = str(l.note).slice(0, 400);
    book.links.push(link);
  }
  for (const g of Array.isArray(input.origins) ? input.origins : []) {
    if (!isObj(g)) continue;
    const objectId = remap(g.objectId ?? g.object_id);
    const sessionId = str(g.sessionId ?? g.session_id).trim();
    if (!ids.has(objectId) || !sessionId) continue;
    const origin: Origin = { objectId, sessionId: sessionId.slice(0, 80) };
    if (g.span != null) origin.span = str(g.span).slice(0, 200);
    book.origins.push(origin);
  }
  for (const p of Array.isArray(input.packets) ? input.packets : []) {
    if (!isObj(p)) continue;
    const id = str(p.id).trim();
    if (!id) continue;
    const packet: Packet = {
      id: id.slice(0, 80),
      fromSession: str(p.fromSession ?? p.from_session).slice(0, 80),
      toSession: str(p.toSession ?? p.to_session).slice(0, 80),
      subject: str(p.subject).slice(0, 400),
      body: str(p.body).slice(0, 4000),
      createdAt: isoOr(p.createdAt ?? p.created_at, ts),
      readAt: p.readAt != null ? str(p.readAt) : p.read_at != null ? str(p.read_at) : null,
    };
    book.packets = book.packets ?? [];
    book.packets.push(packet);
  }
  let seq = 0;
  for (const e of Array.isArray(input.events) ? input.events : []) {
    if (!isObj(e)) continue;
    const action = str(e.action).slice(0, 40);
    if (!action) continue;
    seq = Math.max(seq + 1, Number(e.seq) || 0);
    const ev: Event = { seq, ts: isoOr(e.ts, ts), actor: str(e.actor, "seed").slice(0, 40), action };
    if (e.objectId != null) ev.objectId = remap(e.objectId).slice(0, 80);
    if (e.detail != null) ev.detail = str(e.detail).slice(0, 400);
    if (typeof e.move === "number") ev.move = e.move;
    if (e.undone === true) ev.undone = true;
    if (e.before === null) ev.before = null;
    else if (isObj(e.before)) ev.before = pick(e.before);
    if (isObj(e.after)) ev.after = pick(e.after);
    if (isObj(e.link)) ev.link = { from: str(e.link.from), to: str(e.link.to), rel: str(e.link.rel, "candidate") };
    book.events.push(ev);
  }
  if (isObj(input.compacted)) {
    book.compacted = {};
    for (const k of safeKeys(input.compacted)) book.compacted[k] = Number(input.compacted[k]) || 0;
  }
  if (!book.events.length) {
    book.events.push({ seq: 1, ts, actor: "agent:registrar", action: "seed", detail: `загрузка: ${book.objects.length} объектов, ${book.links.length} рёбер` });
  }
  return { book, warnings };
}

/** Снимок полей события: только известные поля Obj, без прототипных ключей. */
function pick(src: Record<string, unknown>): Partial<Obj> {
  const out: Partial<Obj> = {};
  for (const k of ["status", "updatedAt", "pred", "rel", "obj", "title", "body", "cluster", "type", "layer", "owner", "id", "createdAt", "hash"] as const) {
    if (OWN.call(src, k) && src[k] !== undefined) (out as Record<string, unknown>)[k] = src[k];
  }
  return out;
}

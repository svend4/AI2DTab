/**
 * Две книги: разница и слияние. Основа для передачи стола между агентами
 * и для ревью канона вторым человеком.
 */
import type { Book, Link, Obj, Status } from "./types.ts";
import { nowIso } from "./types.ts";

export type BookDiff = {
  added: Obj[];
  removed: Obj[];
  changed: { id: string; before: Partial<Obj>; after: Partial<Obj> }[];
  linksAdded: Link[];
  linksRemoved: Link[];
};

const FIELDS = ["status", "title", "body", "cluster", "type", "pred", "rel", "obj"] as const;

function linkKey(l: Link): string {
  return `${l.from}\t${l.to}\t${l.rel}`;
}

/** Что изменилось в b относительно a. */
export function diffBooks(a: Book, b: Book): BookDiff {
  const am = new Map(a.objects.map((o) => [o.id, o]));
  const bm = new Map(b.objects.map((o) => [o.id, o]));
  const added = b.objects.filter((o) => !am.has(o.id));
  const removed = a.objects.filter((o) => !bm.has(o.id));
  const changed: BookDiff["changed"] = [];
  for (const o of b.objects) {
    const p = am.get(o.id);
    if (!p) continue;
    const before: Partial<Obj> = {};
    const after: Partial<Obj> = {};
    for (const f of FIELDS) {
      if ((p[f] ?? "") !== (o[f] ?? "")) {
        (before as Record<string, unknown>)[f] = p[f];
        (after as Record<string, unknown>)[f] = o[f];
      }
    }
    if (Object.keys(after).length) changed.push({ id: o.id, before, after });
  }
  const al = new Set(a.links.map(linkKey));
  const bl = new Set(b.links.map(linkKey));
  return {
    added,
    removed,
    changed,
    linksAdded: b.links.filter((l) => !al.has(linkKey(l))),
    linksRemoved: a.links.filter((l) => !bl.has(linkKey(l))),
  };
}

export type MergePolicy = { prefer?: "base" | "incoming" | "canon" };

export type MergeReport = {
  added: number;
  linksAdded: number;
  originsAdded: number;
  conflicts: { id: string; base: Status; incoming: Status; chosen: Status }[];
};

const RANK: Record<string, number> = { canon: 3, closed: 2, open: 2, candidate: 2, dormant: 2, draft: 1, raw: 1, rejected: 0 };

/** Слияние: новые записи и рёбра добавляются; при конфликте статуса по умолчанию побеждает канон. */
export function mergeBooks(base: Book, incoming: Book, policy: MergePolicy = {}): { book: Book; report: MergeReport } {
  const prefer = policy.prefer ?? "canon";
  const book: Book = {
    version: 2,
    objects: base.objects.map((o) => ({ ...o })),
    links: base.links.map((l) => ({ ...l })),
    origins: base.origins.map((g) => ({ ...g })),
    events: base.events.map((e) => ({ ...e })),
    ...(base.packets ? { packets: base.packets.map((p) => ({ ...p })) } : {}),
    ...(base.compacted ? { compacted: { ...base.compacted } } : {}),
  };
  const report: MergeReport = { added: 0, linksAdded: 0, originsAdded: 0, conflicts: [] };
  const byId = new Map(book.objects.map((o) => [o.id, o]));
  for (const inc of incoming.objects) {
    const cur = byId.get(inc.id);
    if (!cur) {
      const copy = { ...inc };
      book.objects.push(copy);
      byId.set(copy.id, copy);
      report.added++;
      continue;
    }
    if (cur.status !== inc.status) {
      let chosen: Status = cur.status;
      if (prefer === "incoming") chosen = inc.status;
      else if (prefer === "canon") chosen = (RANK[inc.status] ?? 1) > (RANK[cur.status] ?? 1) ? inc.status : cur.status;
      report.conflicts.push({ id: inc.id, base: cur.status, incoming: inc.status, chosen });
      if (chosen !== cur.status) {
        cur.status = chosen;
        cur.updatedAt = nowIso();
        if (chosen === "canon" && inc.pred) Object.assign(cur, { pred: inc.pred, rel: inc.rel, obj: inc.obj });
      }
    }
  }
  const ids = new Set(book.objects.map((o) => o.id));
  const have = new Set(book.links.map(linkKey));
  for (const l of incoming.links) {
    if (!ids.has(l.from) || !ids.has(l.to) || have.has(linkKey(l))) continue;
    have.add(linkKey(l));
    book.links.push({ ...l });
    report.linksAdded++;
  }
  const og = new Set(book.origins.map((g) => `${g.objectId}\t${g.sessionId}`));
  for (const g of incoming.origins) {
    const k = `${g.objectId}\t${g.sessionId}`;
    if (!ids.has(g.objectId) || og.has(k)) continue;
    og.add(k);
    book.origins.push({ ...g });
    report.originsAdded++;
  }
  if (incoming.packets?.length) {
    book.packets = book.packets ?? [];
    const pk = new Set(book.packets.map((p) => p.id));
    for (const p of incoming.packets) if (!pk.has(p.id)) book.packets.push({ ...p });
  }
  let seq = book.events.reduce((m, e) => Math.max(m, e.seq), 0);
  for (const e of incoming.events) {
    if (e.action === "seed") continue;
    book.events.push({ ...e, seq: ++seq, detail: `${e.detail ?? ""} (merged)`.trim() });
  }
  return { book, report };
}

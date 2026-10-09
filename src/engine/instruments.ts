/**
 * Приборы: съём состояния книги и красная зона.
 *
 * Правила — данные: каждое знает предупреждение и вопрос-GAP, который сажает.
 * Вычтенные (rejected) строки не участвуют ни в массе кластера, ни в рёбрах:
 * кластер, который целиком вычли, не должен поднимать красную зону.
 */
import { isJunk, resolveName } from "./sets.ts";
import type { Book, Cluster, Hops, Readout } from "./types.ts";
import { CLUSTERS } from "./types.ts";

export type Rule = {
  id: string;
  warn: string;
  gapId: string;
  gapTitle: string;
  gapCluster: Cluster;
  when: (r: Readout) => boolean;
};

export const RULES: Rule[] = [
  {
    id: "charge",
    warn: "заряд <20%",
    gapId: "Q-GAP-CHARGE",
    gapTitle: "чего не хватает канону?",
    gapCluster: "C",
    when: (r) => r.raw + r.canon > 0 && r.charge < 0.2,
  },
  {
    id: "c-mass",
    warn: "перекос C",
    gapId: "Q-GAP-C-MASS",
    gapTitle: "почему масса C без PACKET наружу?",
    gapCluster: "C",
    when: (r) => r.cshare > 0.45 && !r.notes.includes("масса C = ячейки, не перекос"),
  },
  {
    id: "c-hop",
    warn: "C без пакетов",
    gapId: "Q-GAP-C-HOP",
    gapTitle: "какой морфизм C→A или C→B допустим?",
    gapCluster: "C",
    when: (r) => r.hops.C.A + r.hops.C.B + r.hops.C.D === 0 && (r.cluster.C ?? 0) > 8,
  },
  {
    id: "junk",
    warn: "посадка грязная",
    gapId: "Q-GAP-JUNK",
    gapTitle: "TAKE не-ячейки или починить заголовок pred≠obj?",
    gapCluster: "C",
    when: (r) => r.raw > 0 && r.junk / r.raw > 0.4,
  },
  {
    id: "orphans",
    warn: "канон без рёбер",
    gapId: "Q-GAP-ORPHAN",
    gapTitle: "какие канон-записи ничем не связаны и почему?",
    gapCluster: "C",
    when: (r) => r.canon >= 10 && r.orphans / r.canon > 0.7,
  },
  {
    id: "questions",
    warn: "вопросы копятся",
    gapId: "Q-GAP-OPENQ",
    gapTitle: "какие открытые вопросы закрыть решением, а какие вычесть?",
    gapCluster: "B",
    when: (r) => r.openQuestions >= 8,
  },
];

export function emptyHops(): Hops {
  const h = Object.create(null) as Hops;
  for (const a of CLUSTERS) {
    h[a] = Object.create(null) as Record<Cluster, number>;
    for (const b of CLUSTERS) h[a][b] = 0;
  }
  return h;
}

export function readout(book: Book): Readout {
  const live = book.objects.filter((o) => o.status !== "rejected");
  const byId = new Map(book.objects.map((o) => [o.id, o]));
  const raw = live.filter((o) => o.status === "raw").length;
  const canon = live.filter((o) => o.status === "canon").length;
  const rejected = book.objects.length - live.length;
  const total = live.length;
  const packets = book.links.length;
  const cluster: Record<string, number> = Object.create(null);
  for (const o of live) cluster[o.cluster] = (cluster[o.cluster] ?? 0) + 1;
  const neqIds = resolveName(book, "NEQ");
  const cellIds = resolveName(book, "CELL");
  const junk = live.filter((o) => o.status === "raw" && isJunk(o)).length;
  const den = Math.max(1, raw + canon);
  const charge = Math.round((canon / den) * 10000) / 10000;
  const cshare = Math.round(((cluster.C ?? 0) / Math.max(1, total)) * 10000) / 10000;
  const sparse = Math.round((packets / Math.max(1, total * Math.max(total - 1, 1))) * 1e6) / 1e6;
  const hops = emptyHops();
  for (const l of book.links) {
    const f = byId.get(l.from);
    const t = byId.get(l.to);
    if (!f || !t || f.status === "rejected" || t.status === "rejected") continue;
    if ((CLUSTERS as string[]).includes(f.cluster) && (CLUSTERS as string[]).includes(t.cluster)) hops[f.cluster][t.cluster] += 1;
  }
  const linked = new Set(book.links.flatMap((l) => [l.from, l.to]));
  const orphans = live.filter((o) => o.status === "canon" && !linked.has(o.id)).length;
  const openQuestions = live.filter((o) => o.type === "question" && ["open", "raw"].includes(o.status)).length;

  const notes: string[] = [];
  const neqC = [...neqIds].filter((id) => byId.get(id)?.cluster === "C").length;
  if (cshare > 0.45 && neqIds.size && neqC / neqIds.size >= 0.8) notes.push("масса C = ячейки, не перекос");

  const partial: Readout = {
    charge, rejected, raw, canon, neq: neqIds.size, cells: cellIds.size, packets, objects: total,
    cshare, junk, sparse, orphans, openQuestions, cluster, hops, warns: [], notes,
  };
  partial.warns = RULES.filter((r) => r.when(partial)).map((r) => r.warn);
  return partial;
}

export function liveRules(r: Readout): Rule[] {
  return RULES.filter((x) => r.warns.includes(x.warn));
}

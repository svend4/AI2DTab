import { useMemo, useState } from "react";
import type { Link, Obj } from "@/engine/types";
import { CLUSTERS } from "@/engine/types";

/**
 * Граф рёбер: кластеры — колонки, записи — строки внутри колонки.
 * Без физики и библиотек: расположение детерминировано, читается как таблица.
 */
export function LinkGraph({ objects, links, onPick }: { objects: Obj[]; links: Link[]; onPick?: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const linked = useMemo(() => new Set(links.flatMap((l) => [l.from, l.to])), [links]);
  const nodes = useMemo(() => objects.filter((o) => linked.has(o.id)), [objects, linked]);
  const W = 800, colW = W / 4, rowH = 26, pad = 36;
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    CLUSTERS.forEach((c, ci) => {
      nodes.filter((o) => o.cluster === c).forEach((o, i) => m.set(o.id, { x: ci * colW + colW / 2, y: pad + i * rowH }));
    });
    return m;
  }, [nodes, colW]);
  const H = Math.max(160, pad + Math.max(1, ...CLUSTERS.map((c) => nodes.filter((o) => o.cluster === c).length)) * rowH + 10);
  if (!nodes.length) return <p className="text-sm text-muted">Рёбер нет. WIRE a b rel — одна связь, не декартово произведение.</p>;
  const lit = (id: string) => !hover || hover === id || links.some((l) => (l.from === hover && l.to === id) || (l.to === hover && l.from === id));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-lg border border-border bg-surface" role="img" aria-label="граф рёбер по кластерам">
      {CLUSTERS.map((c, i) => (
        <g key={c}>
          <text x={i * colW + colW / 2} y={18} textAnchor="middle" className="fill-subtle" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{c}</text>
          {i ? <line x1={i * colW} y1={28} x2={i * colW} y2={H} className="stroke-border" strokeDasharray="2 4" /> : null}
        </g>
      ))}
      {links.map((l, i) => {
        const a = pos.get(l.from), b = pos.get(l.to);
        if (!a || !b) return null;
        const on = !hover || hover === l.from || hover === l.to;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - (a.x === b.x ? 0 : 14);
        return (
          <g key={`${l.from}-${l.rel}-${l.to}-${i}`} opacity={on ? 1 : 0.15}>
            <path d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`} fill="none" className={["contradicts", "blocks"].includes(l.rel) ? "stroke-warn" : "stroke-border-strong"} strokeWidth={1.2} />
            <text x={mx} y={my + 4} textAnchor="middle" className="fill-muted" style={{ fontSize: 8, fontFamily: "var(--font-mono)" }}>{l.rel}</text>
          </g>
        );
      })}
      {nodes.map((o) => {
        const p = pos.get(o.id)!;
        return (
          <g key={o.id} transform={`translate(${p.x} ${p.y})`} opacity={lit(o.id) ? 1 : 0.25} className="cursor-pointer" onMouseEnter={() => setHover(o.id)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(o.id)}>
            <rect x={-54} y={-9} width={108} height={18} rx={4} className={o.status === "canon" ? "fill-elevated stroke-fg" : "fill-bg stroke-border"} strokeWidth={0.8} />
            <text textAnchor="middle" y={3.5} className="fill-fg" style={{ fontSize: 9, fontFamily: "var(--font-mono)" }}>
              {o.id.length > 14 ? `${o.id.slice(0, 13)}…` : o.id}
            </text>
            <title>{`${o.id} · ${o.type}/${o.status}\n${o.title}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

import type { Readout } from "@/engine/types";
import { CLUSTERS } from "@/engine/types";

function Dial({ label, value, max, unit, warn = false, hint }: { label: string; value: number; max: number; unit: string; warn?: boolean; hint: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  const ink = warn ? "var(--color-warn)" : "var(--color-accent)";
  return (
    <div
      title={hint}
      className={`flex items-center gap-3 rounded-md border bg-surface px-3 py-2 ${warn ? "border-[color:var(--color-warn)]" : "border-border"}`}
    >
      <div className="relative size-12 shrink-0" aria-hidden>
        <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(${ink} ${pct}%, var(--color-border) 0)` }} />
        <div className="absolute inset-[4px] rounded-full bg-surface" />
        <span className="absolute inset-0 grid place-items-center font-mono text-[10px] text-muted">{pct}</span>
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest text-subtle">{label}</p>
        <p className="truncate font-mono text-lg leading-tight">
          {Math.round(value)}
          <span className="ml-1 text-[10px] text-muted">{unit}</span>
        </p>
      </div>
    </div>
  );
}

function HopMatrix({ hops }: { hops: Readout["hops"] }) {
  return (
    <table className="w-full text-center font-mono text-[10px]">
      <caption className="sr-only">рёбра кластер → кластер</caption>
      <thead>
        <tr>
          <th className="px-1 py-0.5 text-subtle">→</th>
          {CLUSTERS.map((b) => (
            <th key={b} className="px-1 py-0.5 text-subtle">{b}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CLUSTERS.map((a) => (
          <tr key={a}>
            <th className="px-1 py-0.5 text-subtle">{a}</th>
            {CLUSTERS.map((b) => {
              const n = hops[a]?.[b] ?? 0;
              const emptyC = a === "C" && b !== "C" && n === 0;
              return (
                <td key={b} className={`px-1 py-0.5 ${emptyC ? "text-[color:var(--color-warn)]" : n ? "text-fg" : "text-subtle"}`}>{n}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InstrumentPanel({ instr }: { instr: Readout | null }) {
  if (!instr) return <p className="font-mono text-xs text-subtle">приборы · нет съёма</p>;
  const i = instr;
  const warns = i.warns ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[11px] leading-relaxed tracking-wide text-subtle">
        INSTR {Math.round(i.charge * 100)}% · {i.raw}r/{i.canon}c · ячеек {i.cells} (≠ {i.neq}) · рёбер {i.packets} · C {Math.round(i.cshare * 100)}% · мусор {i.junk} · сироты {i.orphans}
        {warns.length ? ` · WARN ${warns.length}` : ""}
      </p>
      <section aria-label="приборы" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <Dial label="заряд" value={i.charge * 100} max={100} unit="%" warn={warns.includes("заряд <20%")} hint="canon / (raw + canon): сколько сырья уже стало каноном" />
        <Dial label="сырьё" value={i.raw} max={Math.max(i.raw + i.canon, 1)} unit="raw" hint="посажено, но не принято" />
        <Dial label="канон" value={i.canon} max={Math.max(i.raw + i.canon, 1)} unit="c" hint="принято человеком" />
        <Dial label="ячейки" value={i.cells} max={Math.max(i.cells, 12)} unit={`≠${i.neq}`} hint="строки с разобранным pred REL obj" />
        <Dial label="рёбра" value={i.packets} max={Math.max(i.packets, 15)} unit={`ρ=${i.sparse}`} warn={warns.includes("C без пакетов")} hint="связи между записями; ρ — плотность графа" />
        <Dial label="перекос C" value={i.cshare * 100} max={100} unit="%" warn={warns.includes("перекос C")} hint="доля кластера C во всей книге" />
        <div className="col-span-2 rounded-md border border-border bg-surface px-2 py-1 sm:col-span-3 lg:col-span-1" title="рёбра кластер → кластер; жёлтый ноль — C никуда не ходит">
          <HopMatrix hops={i.hops} />
        </div>
      </section>
      <p className={`font-mono text-[11px] ${warns.length ? "text-[color:var(--color-warn)]" : "text-subtle"}`}>
        красная зона · {warns.length ? warns.join(" · ") : "нет"}
        {(i.notes ?? []).length ? ` · ${i.notes.join(" · ")}` : ""}
      </p>
    </div>
  );
}

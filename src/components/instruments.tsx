export type Instr = {
  charge: number;
  raw: number;
  canon: number;
  neq: number;
  packets: number;
  objects: number;
  cshare: number;
  junk: number;
  sparse: number;
  hops?: Record<string, Record<string, number>>;
  warns?: string[];
  notes?: string[];
};

function Dial({
  label,
  value,
  max,
  unit,
  warn = false,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  warn?: boolean;
}) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  const ink = warn ? "var(--color-warn)" : "var(--color-accent)";
  return (
    <div
      className={`flex items-center gap-3 rounded-md border bg-surface px-3 py-2 ${
        warn ? "border-[color:var(--color-warn)]" : "border-border"
      }`}
    >
      <div className="relative size-14 shrink-0" aria-hidden>
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: `conic-gradient(${ink} ${pct}%, var(--color-border) 0)` }}
        />
        <div className="absolute inset-[5px] rounded-full bg-surface" />
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

function HopMatrix({ hops }: { hops: Record<string, Record<string, number>> }) {
  const axes = ["A", "B", "C", "D"];
  return (
    <table className="w-full text-center font-mono text-[10px]">
      <caption className="sr-only">пакеты кластер → кластер</caption>
      <thead>
        <tr>
          <th className="px-1 py-1 text-subtle">→</th>
          {axes.map((b) => (
            <th key={b} className="px-1 py-1 text-subtle">
              {b}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {axes.map((a) => (
          <tr key={a}>
            <th className="px-1 py-1 text-subtle">{a}</th>
            {axes.map((b) => {
              const n = hops[a]?.[b] ?? 0;
              const emptyC = a === "C" && n === 0;
              return (
                <td
                  key={b}
                  className={`px-1 py-1 ${emptyC ? "text-[color:var(--color-warn)]" : n ? "text-fg" : "text-subtle"}`}
                >
                  {n}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InstrumentPanel({ instr }: { instr: Instr | null }) {
  const i = instr ?? {
    charge: 0,
    raw: 0,
    canon: 0,
    neq: 0,
    packets: 0,
    objects: 0,
    cshare: 0,
    junk: 0,
    sparse: 0,
    hops: {},
    warns: [],
  };
  const warns = i.warns ?? [];
  return (
    <div className="flex flex-col gap-2">
      <section aria-label="приборы" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Dial label="заряд" value={i.charge * 100} max={100} unit="%" warn={i.charge < 0.2} />
        <Dial label="сырьё" value={i.raw} max={Math.max(i.raw + i.canon, 1)} unit="raw" />
        <Dial label="канон" value={i.canon} max={Math.max(i.raw + i.canon, 1)} unit="c" />
        <Dial label="ячейки ≠" value={i.neq} max={Math.max(i.neq, 12)} unit="neq" />
        <Dial label="пакеты" value={i.packets} max={Math.max(i.packets, 15)} unit={`ρ=${i.sparse}`} />
        <Dial label="перекос C" value={i.cshare * 100} max={100} unit="%" warn={(i.warns ?? []).includes("перекос C")} />
      </section>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
        {warns.length ? (
          <p className="font-mono text-[11px] text-[color:var(--color-warn)]">
            красная зона · {warns.join(" · ")}
            {(i.notes ?? []).length ? ` · ${i.notes?.join(" · ")}` : ""}
          </p>
        ) : (
          <p className="font-mono text-[11px] text-subtle">
            красная зона · нет
            {(i.notes ?? []).length ? ` · ${i.notes?.join(" · ")}` : ""}
          </p>
        )}
        <div className="rounded-md border border-border bg-surface px-2 py-1">
          <HopMatrix hops={i.hops ?? {}} />
        </div>
      </div>
    </div>
  );
}

export function InstrumentStrip({ instr }: { instr: Instr | null }) {
  if (!instr) {
    return <p className="font-mono text-xs text-subtle">приборы · нет съёма</p>;
  }
  const pct = Math.round(instr.charge * 100);
  const w = instr.warns?.length ?? 0;
  return (
    <p className="font-mono text-[11px] leading-relaxed tracking-wide text-subtle">
      INSTR {pct}% · {instr.raw}r/{instr.canon}c · ≠{instr.neq} · pkt {instr.packets} · C {Math.round(instr.cshare * 100)}% · не-ячейка {instr.junk}
      {w ? ` · WARN ${w}` : ""}
    </p>
  );
}

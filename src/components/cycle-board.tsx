import { HOPS, STAGES, type Stage } from "@/lib/cycle-data";
import { useCycle, type ViewMode } from "@/lib/cycle-store";

const POS: Record<ViewMode, Record<Stage, { x: number; y: number }>> = {
  rhombus: {
    L1: { x: 140, y: 250 },
    L2: { x: 400, y: 70 },
    L3: { x: 660, y: 250 },
    L4: { x: 400, y: 430 },
  },
  eight: {
    L1: { x: 180, y: 360 },
    L2: { x: 180, y: 140 },
    L3: { x: 620, y: 140 },
    L4: { x: 620, y: 360 },
  },
  iso: {
    L1: { x: 220, y: 380 },
    L2: { x: 400, y: 250 },
    L3: { x: 580, y: 120 },
    L4: { x: 640, y: 400 },
  },
};

function pathFor(view: ViewMode) {
  const p = POS[view];
  if (view === "rhombus") {
    return `M ${p.L1.x} ${p.L1.y} L ${p.L2.x} ${p.L2.y} L ${p.L3.x} ${p.L3.y} L ${p.L4.x} ${p.L4.y} Z`;
  }
  if (view === "eight") {
    return `M ${p.L1.x} ${p.L1.y}
      C 180 250, 320 250, 400 250
      C 480 250, 620 250, ${p.L3.x} ${p.L3.y}
      C 700 80, 700 200, ${p.L4.x} ${p.L4.y}
      C 620 250, 480 250, 400 250
      C 320 250, 180 250, ${p.L2.x} ${p.L2.y}
      C 100 80, 100 200, ${p.L1.x} ${p.L1.y}`;
  }
  return `M ${p.L1.x} ${p.L1.y} L ${p.L2.x} ${p.L2.y} L ${p.L3.x} ${p.L3.y}
          M ${p.L3.x} ${p.L3.y} L ${p.L4.x} ${p.L4.y} L ${p.L1.x} ${p.L1.y}`;
}

export function CycleBoard() {
  const view = useCycle((s) => s.view);
  const tokens = useCycle((s) => s.tokens);
  const brake = useCycle((s) => s.brake);
  const selected = useCycle((s) => s.selected);
  const deadlock = useCycle((s) => s.deadlock);
  const toggleBrake = useCycle((s) => s.toggleBrake);
  const select = useCycle((s) => s.select);
  const pos = POS[view];

  return (
    <svg viewBox="0 0 800 500" className="h-auto w-full" aria-label="Цикл четырёх ступеней">
      <rect x="0" y="0" width="800" height="500" className="fill-bg" />
      {view === "iso" && (
        <g opacity="0.35">
          {[0, 1, 2].map((i) => (
            <polygon
              key={i}
              points="280,340 520,220 640,280 400,400"
              transform={`translate(${i * 18} ${-i * 52})`}
              className="fill-surface stroke-border"
            />
          ))}
        </g>
      )}
      <path
        d={pathFor(view)}
        fill="none"
        className={deadlock ? "stroke-warn" : "stroke-border-strong"}
        strokeWidth="1.5"
      />
      {HOPS.map((h) => {
        const a = pos[h.from];
        const b = pos[h.to];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <text
            key={h.cmd}
            x={mx}
            y={my - 10}
            textAnchor="middle"
            className="fill-muted"
            style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
          >
            {deadlock && (h.from === "L2" || h.from === "L3") ? "—" : h.cmd}
          </text>
        );
      })}
      {STAGES.map((st) => {
        const { x, y } = pos[st.id];
        const stopped = brake[st.id];
        const here = tokens.filter((t) => t.at === st.id).length;
        return (
          <g
            key={st.id}
            transform={`translate(${x} ${y})`}
            className="cursor-pointer"
            onClick={() => toggleBrake(st.id)}
          >
            <circle r="46" className={stopped ? "fill-surface stroke-warn" : "fill-elevated stroke-border-strong"} strokeWidth="1.5" />
            <text y="-8" textAnchor="middle" className="fill-fg" style={{ fontSize: 13, fontWeight: 600 }}>
              {st.id}
            </text>
            <text y="8" textAnchor="middle" className="fill-muted" style={{ fontSize: 10 }}>
              {st.name}
            </text>
            <text y="22" textAnchor="middle" className="fill-subtle" style={{ fontSize: 9 }}>
              {stopped ? "тормоз" : `${here} шт`}
            </text>
          </g>
        );
      })}
      {tokens.map((t, i) => {
        const { x, y } = pos[t.at];
        const angle = (i / Math.max(tokens.length, 1)) * Math.PI * 2;
        const dx = Math.cos(angle) * 18;
        const dy = Math.sin(angle) * 18;
        const on = selected === t.packetId;
        return (
          <circle
            key={t.packetId}
            cx={x + dx}
            cy={y + dy}
            r={on ? 6 : 4}
            className={on ? "fill-accent" : "fill-fg"}
            onClick={(e) => {
              e.stopPropagation();
              select(t.packetId);
            }}
            style={{ cursor: "pointer" }}
          />
        );
      })}
    </svg>
  );
}

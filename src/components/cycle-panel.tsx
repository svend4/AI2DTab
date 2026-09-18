import { Pause, Play, RotateCcw, Split } from "lucide-react";
import { PACKETS, STAGES } from "@/lib/cycle-data";
import { useCycle, type ViewMode } from "@/lib/cycle-store";
import { cn } from "@/lib/utils";

const VIEWS: { id: ViewMode; label: string; dim: string }[] = [
  { id: "rhombus", label: "Ромб", dim: "2D" },
  { id: "eight", label: "Восьмёрка", dim: "2D" },
  { id: "iso", label: "Слои", dim: "2.5D" },
];

export function CyclePanel() {
  const view = useCycle((s) => s.view);
  const running = useCycle((s) => s.running);
  const deadlock = useCycle((s) => s.deadlock);
  const selected = useCycle((s) => s.selected);
  const canon = useCycle((s) => s.canon);
  const tokens = useCycle((s) => s.tokens);
  const log = useCycle((s) => s.log);
  const setView = useCycle((s) => s.setView);
  const toggleRun = useCycle((s) => s.toggleRun);
  const toggleDeadlock = useCycle((s) => s.toggleDeadlock);
  const reset = useCycle((s) => s.reset);
  const select = useCycle((s) => s.select);

  const pkt = PACKETS.find((p) => p.id === selected);
  const tok = tokens.find((t) => t.packetId === selected);

  return (
    <aside className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={cn(
              "h-11 rounded-md border px-3 text-sm font-medium",
              view === v.id
                ? "border-fg bg-fg text-accent-fg"
                : "border-border bg-elevated text-fg",
            )}
          >
            {v.label}
            <span className="ml-2 text-xs text-subtle">{v.dim}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggleRun}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-elevated px-3 text-sm"
        >
          {running ? <Pause className="size-4" /> : <Play className="size-4" />}
          {running ? "Пауза такта" : "Такт"}
        </button>
        <button
          type="button"
          onClick={toggleDeadlock}
          className={cn(
            "inline-flex h-11 items-center gap-2 rounded-md border px-3 text-sm",
            deadlock ? "border-warn text-warn" : "border-border bg-elevated",
          )}
        >
          <Split className="size-4" />
          {deadlock ? "Тупик 2-такт" : "Ромб 4-такт"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-elevated px-3 text-sm"
        >
          <RotateCcw className="size-4" />
          Сброс
        </button>
      </div>

      <section className="rounded-lg border border-border bg-elevated p-4">
        <p className="text-xs tracking-wide text-subtle">пакет</p>
        {pkt ? (
          <>
            <h2 className="mt-1 font-display text-lg leading-snug">{pkt.title}</h2>
            <p className="mt-1 font-mono text-xs text-muted">
              {pkt.id} · {pkt.cluster}.{pkt.kind} · {pkt.source}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted">{pkt.body}</p>
            <p className="mt-3 text-sm">
              сейчас: <span className="font-mono">{tok?.at}</span>
              {tok?.waiting ? " · ждёт тормоз" : ""}
            </p>
            <p className="mt-1 text-xs text-subtle">
              {pkt.canCanon ? "может в канон после ACCEPT" : `не в канон: ${pkt.refuse}`}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">Выберите точку на доске.</p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-elevated p-4">
        <p className="text-xs tracking-wide text-subtle">L3 канон ({canon.length})</p>
        {canon.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Пусто, пока очередь не приняла строку.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {canon.map((id) => {
              const p = PACKETS.find((x) => x.id === id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="text-left font-mono text-xs text-fg"
                    onClick={() => select(id)}
                  >
                    {id} {p?.title}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-elevated p-4">
        <p className="text-xs tracking-wide text-subtle">журнал тактов</p>
        <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
          {log.map((line, i) => (
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ul>
      </section>

      <p className="text-xs leading-relaxed text-subtle">
        Нажмите вершину — тормоз. {STAGES.map((s) => s.id).join(" → ")} → L1′. 3D не нужен:
        третья ось — память канона, не колонка листа.
      </p>
    </aside>
  );
}

import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { STAGES, type Stage } from "@/lib/cycle-data";
import { formatBytes, useDesk, WHERE_LABEL, type Actor } from "@/lib/desk";
import { CommandBar } from "@/components/command-bar";
import { InstrumentPanel } from "@/components/instruments";
import { cn } from "@/lib/utils";

const HREF: Record<Stage, string> = { L1: "/", L2: "/l2", L3: "/l3", L4: "/l4" };

const ACTORS: { id: Actor; label: string; hint: string }[] = [
  { id: "human", label: "человек", hint: "ходит человек: ACCEPT ставит канон" },
  { id: "machine", label: "машина", hint: "ходит машина: ACCEPT отвечает REFUSE, канон ставит только человек" },
];

/** Строка состояния книги: где лежит, сколько весит, упало ли сохранение. */
export function SavedLine({ className }: { className?: string }) {
  const saved = useDesk((s) => s.saved);
  const ready = useDesk((s) => s.ready);
  if (!ready) return <span className={cn("font-mono text-xs text-subtle", className)}>книга: читаем…</span>;
  if (!saved) return <span className={cn("font-mono text-xs text-subtle", className)}>книга: в этой сессии ещё не записывали</span>;
  if (saved.error) {
    return (
      <span className={cn("font-mono text-xs text-[color:var(--color-warn)]", className)} role="status">
        книга не сохранена ({WHERE_LABEL[saved.where]}): {saved.error}
      </span>
    );
  }
  return (
    <span className={cn("font-mono text-xs text-subtle", className)} role="status">
      книга: {formatBytes(saved.bytes)} · {WHERE_LABEL[saved.where]}
    </span>
  );
}

function ActorSwitch() {
  const actor = useDesk((s) => s.actor);
  const ready = useDesk((s) => s.ready);
  const exec = useDesk((s) => s.exec);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-subtle">ходит:</span>
      <div role="group" aria-label="кто ходит" className="inline-flex overflow-hidden rounded-md border border-border">
        {ACTORS.map((a) => (
          <button
            key={a.id}
            type="button"
            title={a.hint}
            aria-pressed={actor === a.id}
            disabled={!ready}
            onClick={() => {
              if (actor !== a.id) exec(`ACTOR ${a.id}`);
            }}
            className={cn("h-9 px-3 font-mono text-xs disabled:opacity-40", actor === a.id ? "bg-fg text-accent-fg" : "bg-elevated text-muted hover:text-fg")}
          >
            {a.label}
          </button>
        ))}
      </div>
      {actor === "machine" ? (
        <span className="font-mono text-xs text-[color:var(--color-warn)]" role="status">
          машина не ставит канон: ACCEPT / FILL → REFUSE
        </span>
      ) : null}
    </div>
  );
}

export function DeskNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const objects = useDesk((s) => s.objects);
  const instr = useDesk((s) => s.instr);
  const events = useDesk((s) => s.events);
  const counts: Record<Stage, number> = {
    L1: objects.filter((o) => o.owner.endsWith(":plant")).length,
    L2: objects.filter((o) => o.status === "raw").length,
    L3: objects.filter((o) => o.status === "canon").length,
    L4: events.length,
  };
  return (
    <header className="border-b border-border bg-bg">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-mono text-xs text-subtle">стол v2.1 · лента → плоскость → канон → действие</p>
          <Link to="/cycle" className={cn("font-mono text-xs underline-offset-2 hover:underline", pathname === "/cycle" ? "text-fg" : "text-subtle")}>
            закон такта
          </Link>
        </div>
        <InstrumentPanel instr={instr} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ActorSwitch />
          <SavedLine className="min-w-0 break-words" />
        </div>
        <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAGES.map((st) => {
            const href = HREF[st.id];
            const on = pathname === href;
            return (
              <Link key={st.id} to={href} className={cn("flex min-h-11 min-w-0 flex-col rounded-md border px-3 py-2", on ? "border-fg bg-fg text-accent-fg" : "border-border bg-elevated text-fg")}>
                <span className="font-mono text-xs">{st.id}</span>
                <span className="truncate text-sm font-medium">{st.name}</span>
                <span className={cn("truncate text-xs", on ? "text-accent-fg/70" : "text-subtle")}>{counts[st.id]} · {st.role}</span>
              </Link>
            );
          })}
        </nav>
        <CommandBar />
      </div>
    </header>
  );
}

export function DeskShell({ children }: { children: ReactNode }) {
  const ready = useDesk((s) => s.ready);
  const boot = useDesk((s) => s.boot);
  useEffect(() => {
    void boot();
  }, [boot]);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <DeskNav />
      <div className="mx-auto min-w-0 max-w-6xl px-4 py-6 sm:px-6">
        {ready ? children : <p className="text-sm text-muted">читаем книгу…</p>}
      </div>
    </div>
  );
}

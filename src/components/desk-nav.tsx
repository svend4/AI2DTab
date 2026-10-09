import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { STAGES, type Stage } from "@/lib/cycle-data";
import { useDesk } from "@/lib/desk";
import { CommandBar } from "@/components/command-bar";
import { InstrumentPanel } from "@/components/instruments";
import { cn } from "@/lib/utils";

const HREF: Record<Stage, string> = { L1: "/", L2: "/l2", L3: "/l3", L4: "/l4" };

export function DeskNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const objects = useDesk((s) => s.objects);
  const instr = useDesk((s) => s.instr);
  const events = useDesk((s) => s.events);
  const counts: Record<Stage, number> = {
    L1: objects.filter((o) => o.owner === "machine:plant").length,
    L2: objects.filter((o) => o.status === "raw").length,
    L3: objects.filter((o) => o.status === "canon").length,
    L4: events.length,
  };
  return (
    <header className="border-b border-border bg-bg">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-xs text-subtle">стол v2 · лента → плоскость → канон → действие</p>
          <Link to="/cycle" className={cn("font-mono text-xs underline-offset-2 hover:underline", pathname === "/cycle" ? "text-fg" : "text-subtle")}>
            закон такта
          </Link>
        </div>
        <InstrumentPanel instr={instr} />
        <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAGES.map((st) => {
            const href = HREF[st.id];
            const on = pathname === href;
            return (
              <Link key={st.id} to={href} className={cn("flex min-h-11 flex-col rounded-md border px-3 py-2", on ? "border-fg bg-fg text-accent-fg" : "border-border bg-elevated text-fg")}>
                <span className="font-mono text-xs">{st.id}</span>
                <span className="text-sm font-medium">{st.name}</span>
                <span className={cn("text-xs", on ? "text-accent-fg/70" : "text-subtle")}>{counts[st.id]} · {st.role}</span>
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
    boot();
  }, [boot]);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <DeskNav />
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {ready ? children : <p className="text-sm text-muted">читаем книгу…</p>}
      </div>
    </div>
  );
}

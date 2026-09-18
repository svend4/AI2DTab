import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { STAGES, type Stage } from "@/lib/cycle-data";
import { useDesk } from "@/lib/desk-store";
import { CommandBar } from "@/components/command-bar";
import { refreshBook } from "@/lib/desk-bridge";
import { InstrumentPanel, InstrumentStrip } from "@/components/instruments";
import { cn } from "@/lib/utils";

const HREF: Record<Stage, string> = { L1: "/", L2: "/l2", L3: "/l3", L4: "/l4" };

export function DeskNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const rows = useDesk((s) => s.rows);
  const canon = useDesk((s) => s.canon);
  const plane = useDesk((s) => s.plane);
  const instr = useDesk((s) => s.instr);
  const rawN = plane.length || rows.filter((r) => r.status === "raw").length;
  const counts: Record<Stage, number> = {
    L1: rows.filter((r) => r.source === "лента").length,
    L2: rawN,
    L3: canon.length,
    L4: canon.length,
  };

  return (
    <header className="border-b border-border bg-bg">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
        <InstrumentStrip instr={instr} />
        <InstrumentPanel instr={instr} />
        <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAGES.map((st) => {
            const href = HREF[st.id];
            const on = pathname === href;
            return (
              <Link
                key={st.id}
                to={href}
                className={cn(
                  "flex min-h-11 flex-col rounded-md border px-3 py-2",
                  on ? "border-fg bg-fg text-accent-fg" : "border-border bg-elevated text-fg",
                )}
              >
                <span className="font-mono text-xs">{st.id}</span>
                <span className="text-sm font-medium">{st.name}</span>
                <span className={cn("text-xs", on ? "text-accent-fg/70" : "text-subtle")}>
                  {counts[st.id]} · {st.role}
                </span>
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
  useEffect(() => {
    void refreshBook();
  }, []);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <DeskNav />
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

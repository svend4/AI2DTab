import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CycleBoard } from "@/components/cycle-board";
import { CyclePanel } from "@/components/cycle-panel";
import { useCycle } from "@/lib/cycle-store";

export const Route = createFileRoute("/cycle")({ component: Cycle });

/** Закон такта: модель, из которой вырос стол. Витрина, не данные. */
function Cycle() {
  const tick = useCycle((s) => s.tick);
  useEffect(() => {
    const t = setInterval(tick, 1600);
    return () => clearInterval(t);
  }, [tick]);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <p className="font-mono text-xs text-subtle">
          <Link to="/" className="underline-offset-2 hover:underline">← стол</Link> · закон хранения
        </p>
        <h1 className="mt-2 font-display text-3xl font-medium tracking-tight">Четыре такта</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Лента → плоскость → канон → действие → новое сырьё. Не чат, который отвечает сам себе. Нажмите вершину, чтобы поставить тормоз. Тупик 2-такт показывает, почему без плоскости цикл схлопывается.
        </p>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="rounded-lg border border-border bg-surface p-3"><CycleBoard /></div>
          <CyclePanel />
        </div>
      </div>
    </div>
  );
}

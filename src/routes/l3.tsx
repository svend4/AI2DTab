import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { refreshBook, runBoth } from "@/lib/desk-bridge";
import { useDesk } from "@/lib/desk-store";

export const Route = createFileRoute("/l3")({ component: L3 });

function L3() {
  const rows = useDesk((s) => s.canon);
  const wires = useDesk((s) => s.wires);
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const cells = rows.filter((r) => r.pred && r.obj);
  const rest = rows.filter((r) => !(r.pred && r.obj));

  useEffect(() => {
    void refreshBook().finally(() => setReady(true));
  }, []);

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L3 · память</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Канон = sqlite. Ячейки — тройки. Остальное — факты и решения без ≠.
      </p>

      <h2 className="mt-6 text-xs tracking-wide text-subtle">ячейки ≠ · {cells.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["id", "pred", "≠", "obj"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.pred}</td>
                <td className="px-3 py-2 text-subtle">≠</td>
                <td className="px-3 py-2 font-mono text-xs">{r.obj}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">рёбра PACKET · {wires.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["from", "rel", "to"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {wires.map((w) => (
              <tr key={`${w.from}-${w.rel}-${w.to}`} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{w.from}</td>
                <td className="px-3 py-2 text-subtle">{w.rel}</td>
                <td className="px-3 py-2 font-mono text-xs">{w.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">прочий канон · {rest.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["id", "cluster", "type", "title", ""].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rest.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2">{r.type}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => {
                      void runBoth(r.id).then(() => nav({ to: "/l4" }));
                    }}
                  >
                    RUN
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          {ready ? "Канон пуст. ACCEPT ещё не писал в sqlite." : "читаем sqlite…"}
        </p>
      ) : null}
    </DeskShell>
  );
}

import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { bridge, refreshBook } from "@/lib/desk-bridge";
import { useDesk } from "@/lib/desk-store";

export const Route = createFileRoute("/")({ component: L1 });

function L1() {
  const tape = useDesk((s) => s.tape);
  const setTape = useDesk((s) => s.setTape);
  const resetDesk = useDesk((s) => s.resetDesk);
  const plane = useDesk((s) => s.plane);
  const nav = useNavigate();

  useEffect(() => {
    void refreshBook();
  }, []);

  function onFile(file: File | undefined) {
    if (!file) return;
    void file.text().then(setTape);
  }

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L1 · лента</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Сверху — одномерный ввод. Снизу — уже посаженное сырьё из sqlite (те же 7 полей).
      </p>
      <textarea
        id="tape"
        value={tape}
        onChange={(e) => setTape(e.target.value)}
        placeholder="Вставьте сырой текст…"
        className="mt-6 min-h-48 w-full rounded-lg border border-border bg-elevated p-4 font-mono text-sm leading-relaxed text-fg outline-none focus:border-border-strong"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border bg-elevated px-4 text-sm">
          Файл
          <input
            type="file"
            accept=".txt,.md,.json,.tsv,text/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </label>
        <button
          type="button"
          className="h-11 rounded-md bg-fg px-4 text-sm font-medium text-accent-fg"
          onClick={() => {
            const text = useDesk.getState().tape.trim();
            if (!text) return;
            void (async () => {
              await bridge("PLANT", { tape: text });
              await refreshBook();
              nav({ to: "/l2" });
            })();
          }}
        >
          Посадить на L2
        </button>
        <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={resetDesk}>
          Сброс стола
        </button>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">уже в sqlite · raw {plane.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["id", "cluster", "type", "title"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plane.slice(0, 40).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2">{r.type}</td>
                <td className="px-3 py-2">{r.title}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DeskShell>
  );
}

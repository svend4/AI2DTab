import { Fragment, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import ontSeed from "@/data/ont-l2.json";
import { DeskShell } from "@/components/desk-nav";
import { acceptBoth, bridge, plantToDb, refreshBook, takeBoth } from "@/lib/desk-bridge";
import { useDesk, type Row } from "@/lib/desk-store";

function parseNeq(row: { title: string; pred?: string; obj?: string }) {
  if (row.pred && row.obj) return { pred: row.pred, obj: row.obj };
  const title = row.title;
  const i = title.indexOf("≠");
  if (i < 1) return null;
  const pred = title.slice(0, i).replace(/^(but|again)\s+/i, "").trim();
  const obj = title.slice(i + 1).trim().replace(/[.]+$/, "");
  if (pred.length < 2 || obj.length < 2) return null;
  return { pred, obj };
}

export const Route = createFileRoute("/l2")({ component: L2 });

function L2() {
  const rows = useDesk((s) => s.rows);
  const book = useDesk((s) => s.plane);
  const canon = useDesk((s) => s.canon);
  const mergeRows = useDesk((s) => s.mergeRows);
  const [open, setOpen] = useState<string | null>(null);
  const look = useDesk((s) => s.look);
  const cluster = useDesk((s) => s.cluster);
  const setLook = useDesk((s) => s.setLook);
  const setCluster = useDesk((s) => s.setCluster);
  const source = book.length ? book : rows.filter((r) => r.status === "raw");
  const plane = source.filter((r) => {
    if (cluster && r.cluster !== cluster) return false;
    if (!look) return true;
    const q = look.toLowerCase();
    return (r.title + r.body + r.id).toLowerCase().includes(q);
  });
  const types = Array.from(new Set([...source, ...canon].map((r) => r.type))).sort();
  const cols = ["A", "B", "C", "D"] as const;
  const cells = [...source, ...canon].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  const concMap = new Map<string, { pred: number; obj: number }>();
  for (const r of cells) {
    const p = parseNeq(r);
    if (!p) continue;
    for (const [tok, role] of [[p.pred, "pred"], [p.obj, "obj"]] as const) {
      const k = tok.toLowerCase();
      const cur = concMap.get(k) || { pred: 0, obj: 0 };
      cur[role] += 1;
      concMap.set(k, cur);
    }
  }
  const conc = [...concMap.entries()].sort((a, b) => b[1].pred + b[1].obj - (a[1].pred + a[1].obj)).slice(0, 12);
  const cellBook = [...source, ...canon].filter((r, i, a) => r.pred && a.findIndex((x) => x.id === r.id) === i);
  const neq = plane.filter((r) => r.title.includes("≠") && r.type === "observation");

  function fromKit() {
    const mapped: Omit<Row, "status">[] = ontSeed.map((r) => ({
      id: r.id,
      cluster: r.cluster || "C",
      layer: r.layer || "2",
      type: r.type || "observation",
      title: r.title || r.id,
      body: (r.body || "").slice(0, 800),
      source: "kit ont",
    }));
    const have = new Set(useDesk.getState().rows.map((r) => r.id));
    mergeRows(mapped);
    const added = useDesk.getState().rows.filter((r) => !have.has(r.id));
    void plantToDb(added);
  }

  return (
    <DeskShell>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-medium tracking-tight">L2 · плоскость</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Книга sqlite: ячейка = raw/canon. Формула =GRID или =COUNTIF(≠). Макрос — пачка ACCEPT.
          </p>
        </div>
        <button
          type="button"
          onClick={fromKit}
          className="h-11 rounded-md border border-border bg-elevated px-4 text-sm"
        >
          Подгрузить таблицы комплекта
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {["", "A", "B", "C", "D"].map((c) => (
          <button
            key={c || "all"}
            type="button"
            onClick={() => setCluster(c)}
            className={`h-10 rounded-md border px-3 text-xs ${
              cluster === c ? "border-fg bg-fg text-accent-fg" : "border-border"
            }`}
          >
            {c || "все"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setLook("≠")}
          className={`h-10 rounded-md border px-3 text-xs ${
            look === "≠" ? "border-fg bg-fg text-accent-fg" : "border-border"
          }`}
        >
          ≠ множество
        </button>
        <input
          value={look}
          onChange={(e) => setLook(e.target.value)}
          placeholder="LOOK"
          className="h-10 min-w-40 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm"
        />
        <button
          type="button"
          className="h-10 rounded-md border border-border px-3 text-xs"
          onClick={() => {
            void (async () => {
              await bridge("FILL");
              await refreshBook();
            })();
          }}
        >
          FILL NEQ∩RAW
        </button>
        <button
          type="button"
          className="h-10 rounded-md border border-border px-3 text-xs"
          onClick={() => {
            void (async () => {
              await bridge("SWEEP");
              await refreshBook();
            })();
          }}
        >
          SWEEP SESSION
        </button>
        <button
          type="button"
          className="h-10 rounded-md border border-border px-3 text-xs"
          onClick={() => {
            void (async () => {
              await bridge("GAP");
              await refreshBook();
            })();
          }}
        >
          GAP из приборов
        </button>
        <button
          type="button"
          className="h-10 rounded-md border border-border px-3 text-xs"
          onClick={() => {
            void (async () => {
              await bridge("PURGE");
              await refreshBook();
            })();
          }}
        >
          PURGE JUNK
        </button>
        <button
          type="button"
          className="h-10 rounded-md border border-border px-3 text-xs"
          onClick={() => {
            void (async () => {
              await bridge("PROBE C A");
              await refreshBook();
            })();
          }}
        >
          PROBE C→A
        </button>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              <th className="px-3 py-2">тип \ кластер</th>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 font-mono">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.map((tp) => (
              <tr key={tp} className="border-t border-border">
                <td className="px-3 py-2 text-xs">{tp}</td>
                {cols.map((c) => {
                  const raw = source.filter((r) => r.cluster === c && r.type === tp).length;
                  const cap = canon.filter((r) => r.cluster === c && r.type === tp).length;
                  return (
                    <td key={c} className="px-3 py-2 font-mono text-xs">
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          setCluster(c);
                          setLook("");
                        }}
                      >
                        {raw}r/{cap}c
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              <th className="px-3 py-2">конкорданс</th>
              <th className="px-3 py-2">pred</th>
              <th className="px-3 py-2">obj</th>
            </tr>
          </thead>
          <tbody>
            {conc.map(([tok, n]) => (
              <tr key={tok} className="border-t border-border">
                <td className="px-3 py-2">
                  <button type="button" className="underline" onClick={() => setLook(tok)}>
                    {tok}
                  </button>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{n.pred}</td>
                <td className="px-3 py-2 font-mono text-xs">{n.obj}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["id", "pred", "≠", "obj", "статус"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cellBook.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.pred}</td>
                <td className="px-3 py-2 text-subtle">≠</td>
                <td className="px-3 py-2 font-mono text-xs">{r.obj}</td>
                <td className="px-3 py-2 text-subtle">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              {["id", "cluster", "type", "pred", "≠", "obj", ""].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plane.map((r) => (
              <Fragment key={r.id}>
                <tr
                  className="cursor-pointer border-t border-border hover:bg-elevated"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-2">{r.cluster}</td>
                  <td className="px-3 py-2">{r.type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.pred || ""}</td>
                  <td className="px-3 py-2 text-subtle">{r.pred ? r.rel || "≠" : ""}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.obj || r.title}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-3 whitespace-nowrap">
                      <button type="button" className="text-xs underline" onClick={() => void acceptBoth(r.id)}>
                        принять
                      </button>
                      <button
                        type="button"
                        className="text-xs text-subtle underline"
                        onClick={() => void takeBoth(r.id)}
                      >
                        вычесть
                      </button>
                    </div>
                  </td>
                </tr>
                {open === r.id ? (
                  <tr className="border-t border-border bg-surface">
                    <td colSpan={7} className="px-3 py-3 font-mono text-xs leading-relaxed text-muted">
                      {r.title}
                      {r.body ? `\n${r.body}` : ""}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {plane.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Очередь пуста. Вернитесь на L1 или подгрузите комплект.</p>
      ) : null}
    </DeskShell>
  );
}

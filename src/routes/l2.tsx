import { Fragment, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { CLUSTERS, type Obj } from "@/engine/types";
import { cellOf, useDesk } from "@/lib/desk";

export const Route = createFileRoute("/l2")({ component: L2 });

const STATUSES = ["raw", "canon", "open", "closed", "rejected", "draft", "candidate", "dormant"];
const PAGE = 200;

function L2() {
  const objects = useDesk((s) => s.objects);
  const links = useDesk((s) => s.links);
  const instr = useDesk((s) => s.instr);
  const actor = useDesk((s) => s.actor);
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const look = useDesk((s) => s.look);
  const cluster = useDesk((s) => s.cluster);
  const setLook = useDesk((s) => s.setLook);
  const setCluster = useDesk((s) => s.setCluster);
  const [status, setStatus] = useState<string>("raw");
  const [onlyCells, setOnlyCells] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  /** Ответ движка на последнее действие по строке — виден прямо под строкой (REFUSE машины и т.п.). */
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const rows = useMemo(() => {
    const q = look.toLowerCase();
    return objects.filter((o) => {
      if (cluster && o.cluster !== cluster) return false;
      if (status && o.status !== status) return false;
      if (onlyCells && !o.pred) return false;
      if (q && !`${o.id} ${o.title} ${o.body} ${o.pred ?? ""} ${o.obj ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [objects, cluster, status, onlyCells, look]);

  // срез сменился — показываем снова первые 200
  useEffect(() => {
    setLimit(PAGE);
  }, [cluster, status, onlyCells, look]);

  /** Отметки, которых уже нет в срезе (сменился фильтр, строка ушла в канон), не считаются. */
  const selected = useMemo(() => {
    const visible = new Set(rows.map((r) => r.id));
    return [...picked].filter((id) => visible.has(id));
  }, [picked, rows]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const matrix = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of objects) m.set(`${o.status}|${o.cluster}`, (m.get(`${o.status}|${o.cluster}`) ?? 0) + 1);
    return m;
  }, [objects]);
  const liveStatuses = STATUSES.filter((s) => CLUSTERS.some((c) => matrix.get(`${s}|${c}`)));

  const chains = useMemo(() => {
    const d = query("CHAIN").data;
    return Array.isArray(d) ? d.length : 0;
    // CHAIN зависит от ячеек и рёбер; оба — в состоянии стола
  }, [query, objects, links]); // eslint-disable-line react-hooks/exhaustive-deps

  function act(verb: "ACCEPT" | "TAKE", id: string) {
    const out = exec(`${verb} ${id}`);
    setRowMsg({ id, text: out.text.split("\n")[0], ok: out.ok });
    setPicked((p) => {
      if (!p.has(id)) return p;
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  }
  function bulk(verb: "ACCEPT" | "TAKE") {
    if (!selected.length) return;
    // один ход на id: каждый отдельно попадает в журнал и в UNDO, без склейки в BATCH-строку
    let ok = 0;
    let refused = 0;
    let lastText = "";
    for (const id of selected) {
      const out = exec(`${verb} ${id}`);
      if (out.ok) ok++;
      else refused++;
      lastText = out.text.split("\n")[0];
    }
    setRowMsg({ id: "", text: `${verb} по отмеченным: ok=${ok}${refused ? ` refuse=${refused} · ${lastText}` : ""}`, ok: refused === 0 });
    setPicked(new Set());
  }
  function toggle(id: string) {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  }
  const chip = (on: boolean) => `h-9 rounded-md border px-3 text-xs ${on ? "border-fg bg-fg text-accent-fg" : "border-border"}`;
  const shown = rows.slice(0, limit);
  const machine = actor === "machine";

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L2 · плоскость</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Матрица статус × кластер — это и есть стол: клик по ячейке режет книгу. Принятие и вычитание — пачкой, по отмеченным строкам, без пересказа.
      </p>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              <th className="px-3 py-2">статус \ кластер</th>
              {CLUSTERS.map((c) => (
                <th key={c} className="px-3 py-2 font-mono">
                  <button type="button" className={cluster === c ? "underline" : ""} onClick={() => setCluster(cluster === c ? "" : c)}>{c}</button>
                </th>
              ))}
              <th className="px-3 py-2 font-mono text-subtle">Σ</th>
            </tr>
          </thead>
          <tbody>
            {liveStatuses.map((st) => (
              <tr key={st} className="border-t border-border">
                <td className="px-3 py-2 text-xs">
                  <button type="button" className={status === st ? "underline" : ""} onClick={() => setStatus(status === st ? "" : st)}>{st}</button>
                </td>
                {CLUSTERS.map((c) => {
                  const n = matrix.get(`${st}|${c}`) ?? 0;
                  const on = status === st && cluster === c;
                  return (
                    <td key={c} className="px-3 py-2 font-mono text-xs">
                      <button type="button" disabled={!n} className={`rounded px-1 ${on ? "bg-fg text-accent-fg" : n ? "underline" : "text-subtle"}`} onClick={() => { setStatus(st); setCluster(c); }}>
                        {n}
                      </button>
                    </td>
                  );
                })}
                <td className="px-3 py-2 font-mono text-xs text-subtle">{CLUSTERS.reduce((a, c) => a + (matrix.get(`${st}|${c}`) ?? 0), 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={look} onChange={(e) => setLook(e.target.value)} placeholder="LOOK — по id, заголовку, телу, ячейке" className="h-9 min-w-0 flex-1 basis-48 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
        <button type="button" className={chip(onlyCells)} onClick={() => setOnlyCells((v) => !v)}>только ячейки</button>
        <button type="button" className={chip(status === "rejected")} title="вычтенные строки: не в массе кластера, не в рёбрах" onClick={() => setStatus(status === "rejected" ? "raw" : "rejected")}>
          вычтено {instr?.rejected ?? 0}
        </button>
        <button type="button" className={chip(false)} onClick={() => { setCluster(""); setStatus("raw"); setLook(""); setOnlyCells(false); }}>сброс среза</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle">макросы:</span>
        {[["FILL", "принять все ячейки ≠ из raw"], ["SWEEP", "вычесть ходы сессии"], ["PURGE", "вычесть мусор"], ["GAP", "красная зона → вопросы"], ["UNDO", "откат последнего хода"]].map(([v, hint]) => (
          <button key={v} type="button" title={hint} className="h-9 rounded-md border border-border px-3 font-mono text-xs" onClick={() => exec(v)}>{v}</button>
        ))}
        {chains ? (
          <Link to="/l3" className="h-9 rounded-md border border-border px-3 font-mono text-xs leading-9 text-muted underline-offset-2 hover:underline" title="цепочки ячеек без ребра: obj одной = pred другой">
            CHAIN {chains} → L3
          </Link>
        ) : null}
        <span className="ml-auto text-xs text-subtle">отмечено {selected.length}{picked.size !== selected.length ? ` (вне среза ${picked.size - selected.length})` : ""}</span>
        <button
          type="button"
          disabled={!selected.length}
          title={machine ? "машина не ставит канон: каждая строка получит REFUSE" : "ACCEPT по каждой отмеченной строке"}
          className={`h-9 rounded-md px-3 text-xs disabled:opacity-40 ${machine ? "border border-[color:var(--color-warn)] text-[color:var(--color-warn)] line-through" : "bg-fg text-accent-fg"}`}
          onClick={() => bulk("ACCEPT")}
        >
          принять отмеченные
        </button>
        <button type="button" disabled={!selected.length} className="h-9 rounded-md border border-border px-3 text-xs disabled:opacity-40" onClick={() => bulk("TAKE")}>вычесть отмеченные</button>
      </div>
      {machine ? (
        <p className="mt-2 font-mono text-xs text-[color:var(--color-warn)]" role="status">
          ходит машина: «принять» вернёт REFUSE, канон ставит только человек (переключатель в шапке)
        </p>
      ) : null}
      {rowMsg && !rowMsg.id ? (
        <p className={`mt-2 font-mono text-xs ${rowMsg.ok ? "text-muted" : "text-[color:var(--color-warn)]"}`} role="status">{rowMsg.text}</p>
      ) : null}

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="отметить все в срезе"
                  checked={rows.length > 0 && selected.length === rows.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              {["id", "кл", "тип", "pred", "rel", "obj / заголовок", "статус", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r: Obj) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer border-t border-border hover:bg-elevated" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`отметить ${r.id}`} checked={selectedSet.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-2">{r.cluster}</td>
                  <td className="px-3 py-2 text-xs">{r.type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.pred ?? ""}</td>
                  <td className="px-3 py-2 text-subtle">{r.rel ?? ""}</td>
                  <td className="max-w-[24rem] truncate px-3 py-2 font-mono text-xs">{r.obj ?? r.title}</td>
                  <td className="px-3 py-2 text-xs text-subtle">{r.status}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-3 whitespace-nowrap">
                      {r.status !== "canon" ? (
                        <button
                          type="button"
                          className={`text-xs underline ${machine ? "text-[color:var(--color-warn)] line-through decoration-dotted" : ""}`}
                          title={machine ? "машина не ставит канон → REFUSE" : `ACCEPT ${r.id}`}
                          onClick={() => act("ACCEPT", r.id)}
                        >
                          принять
                        </button>
                      ) : null}
                      {r.status !== "rejected" ? <button type="button" className="text-xs text-subtle underline" onClick={() => act("TAKE", r.id)}>вычесть</button> : null}
                    </div>
                  </td>
                </tr>
                {rowMsg && rowMsg.id === r.id ? (
                  <tr className="border-t border-border bg-surface">
                    <td colSpan={9} className={`px-3 py-1.5 font-mono text-xs ${rowMsg.ok ? "text-muted" : "text-[color:var(--color-warn)]"}`} role="status">
                      {rowMsg.text}
                    </td>
                  </tr>
                ) : null}
                {open === r.id ? (
                  <tr className="border-t border-border bg-surface">
                    <td colSpan={9} className="px-3 py-3 font-mono text-xs leading-relaxed text-muted">
                      <p className="text-fg">{r.title}</p>
                      {r.body ? <p className="mt-1 whitespace-pre-wrap break-words">{r.body}</p> : null}
                      <pre className="mt-2 whitespace-pre-wrap break-words text-subtle">{query(`WHY ${r.id}`).text}</pre>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="h-9 rounded-md border border-border px-3 text-xs" onClick={() => setLimit((l) => l + PAGE)}>
            показать ещё {Math.min(PAGE, rows.length - shown.length)}
          </button>
          <span className="text-xs text-subtle">показано {shown.length} из {rows.length}</span>
        </div>
      ) : null}
      {rows.length === 0 ? <p className="mt-6 text-sm text-muted">Срез пуст. Снимите фильтр, вернитесь на L1 или посадите комплект.</p> : null}
      <p className="mt-3 text-xs text-subtle">
        строк в срезе: {rows.length} · ячеек: {rows.filter((r) => cellOf(r)).length} · всего в книге: {objects.length} · вычтено: {instr?.rejected ?? 0}
      </p>
    </DeskShell>
  );
}

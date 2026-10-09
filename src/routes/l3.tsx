import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { LinkGraph } from "@/components/link-graph";
import type { Obj } from "@/engine/types";
import { useDesk } from "@/lib/desk";

export const Route = createFileRoute("/l3")({ component: L3 });

const RELS = ["cites", "refines", "contradicts", "replaces", "derived_from", "feeds", "relevant_to", "raises", "triggers", "blocks", "constrains", "candidate", "chains"];
const PAGE = 200;

type ChainHint = { from: string; to: string; via: string };

/** Кнопка «показать ещё N» под таблицей, когда срез длиннее страницы. */
function More({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" className="h-9 rounded-md border border-border px-3 text-xs" onClick={onMore}>
        показать ещё {Math.min(PAGE, total - shown)}
      </button>
      <span className="text-xs text-subtle">показано {shown} из {total}</span>
    </div>
  );
}

function L3() {
  const objects = useDesk((s) => s.objects);
  const links = useDesk((s) => s.links);
  const ready = useDesk((s) => s.ready);
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const nav = useNavigate();
  const canon = useMemo(() => objects.filter((o) => o.status === "canon"), [objects]);
  const cells = useMemo(() => canon.filter((o) => o.pred), [canon]);
  const rest = useMemo(() => canon.filter((o) => !o.pred), [canon]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rel, setRel] = useState("constrains");
  /** Храним id, а не текст: WHY пересчитывается в рендере и не устаревает после WIRE/ACCEPT. */
  const [whyId, setWhyId] = useState<string | null>(null);
  const [probe, setProbe] = useState<string[]>([]);
  const [turn, setTurn] = useState<string>("");
  const [cellsLimit, setCellsLimit] = useState(PAGE);
  const [restLimit, setRestLimit] = useState(PAGE);
  const [turnLimit, setTurnLimit] = useState(PAGE);
  const [chainLimit, setChainLimit] = useState(40);

  const ids = useMemo(() => objects.map((o) => o.id), [objects]);
  const why = whyId ? query(`WHY ${whyId}`).text : null;

  // CHAIN и TURN — чтение без записи; зависят от объектов/рёбер/происхождения, которые меняются только через exec → refresh
  const chains = useMemo<ChainHint[]>(() => {
    const d = query("CHAIN").data;
    return Array.isArray(d) ? (d as ChainHint[]) : [];
  }, [query, objects, links]); // eslint-disable-line react-hooks/exhaustive-deps
  const turns = useMemo<[string, number][]>(() => {
    const d = query("TURN").data;
    return d && typeof d === "object" ? Object.entries(d as Record<string, number>).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
  }, [query, objects]); // eslint-disable-line react-hooks/exhaustive-deps
  const turnRows = useMemo<Obj[]>(() => {
    if (!turn) return [];
    const d = query(`TURN ${turn}`).data;
    const set = new Set(Array.isArray(d) ? (d as string[]) : []);
    return objects.filter((o) => set.has(o.id));
  }, [query, turn, objects]);

  function wire() {
    if (!from || !to) return;
    const out = exec(`WIRE ${from} ${to} ${rel}`);
    if (out.ok) {
      setFrom("");
      setTo("");
    }
  }
  function runProbe(a: string, b: string) {
    const out = query(`PROBE ${a} ${b}`);
    setProbe(out.text.split("\n").filter((l) => l.includes("-?->")));
  }
  const titleOf = (id: string) => objects.find((o) => o.id === id)?.title ?? "";

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L3 · память</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Канон = то, что принял человек. Ячейки — тройки pred REL obj. Рёбра — единственный допустимый морфизм между кластерами: по одному, не декартово.
      </p>

      <h2 className="mt-6 text-xs tracking-wide text-subtle">граф рёбер · {links.length}</h2>
      <div className="mt-2 min-w-0">
        <LinkGraph objects={objects} links={links} onPick={(id) => setWhyId(id)} />
      </div>
      {why ? (
        <div className="mt-2 rounded-lg border border-border bg-elevated p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-mono text-xs text-subtle">WHY {whyId}</p>
            <button type="button" className="text-xs text-subtle underline" onClick={() => setWhyId(null)}>закрыть</button>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted">{why}</pre>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <form className="min-w-0 rounded-lg border border-border bg-surface p-3" onSubmit={(e) => { e.preventDefault(); if (ready) wire(); }}>
          <p className="text-xs tracking-wide text-subtle">WIRE · одно ребро</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input list="desk-ids" value={from} disabled={!ready} onChange={(e) => setFrom(e.target.value)} placeholder="from id" aria-label="from id" className="h-10 min-w-0 flex-1 basis-32 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
            <select value={rel} disabled={!ready} onChange={(e) => setRel(e.target.value)} aria-label="отношение" className="h-10 rounded-md border border-border bg-elevated px-2 font-mono text-sm">
              {RELS.map((r) => <option key={r}>{r}</option>)}
            </select>
            <input list="desk-ids" value={to} disabled={!ready} onChange={(e) => setTo(e.target.value)} placeholder="to id" aria-label="to id" className="h-10 min-w-0 flex-1 basis-32 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
            <button type="submit" disabled={!ready} className="h-10 rounded-md bg-fg px-4 text-sm text-accent-fg disabled:opacity-40">WIRE</button>
          </div>
          <datalist id="desk-ids">{ids.map((id) => <option key={id} value={id} />)}</datalist>
        </form>
        <div className="min-w-0 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs tracking-wide text-subtle">PROBE · кандидаты рёбер по общим словам</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {[["C", "A"], ["C", "B"], ["D", "A"], ["A", "B"]].map(([a, b]) => (
              <button key={a + b} type="button" className="h-10 rounded-md border border-border px-3 font-mono text-xs" onClick={() => runProbe(a, b)}>{a}→{b}</button>
            ))}
          </div>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-xs text-muted">
            {probe.length ? probe.map((l) => {
              const m = l.match(/^(\S+) -\?-> (\S+)\t(.*)$/);
              return m ? (
                <li key={l} className="flex min-w-0 flex-wrap gap-2">
                  <button type="button" className="underline" onClick={() => exec(`WIRE ${m[1]} ${m[2]} candidate`)}>WIRE</button>
                  <span className="break-all">{m[1]} → {m[2]}</span>
                  <span className="text-subtle">{m[3]}</span>
                </li>
              ) : null;
            }) : <li className="text-subtle">нажмите пару кластеров</li>}
          </ul>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="min-w-0 rounded-lg border border-border bg-surface p-3" aria-labelledby="chain-h">
          <p id="chain-h" className="text-xs tracking-wide text-subtle">CHAIN · цепочки ячеек без ребра · {chains.length}</p>
          <p className="mt-1 text-xs text-muted">obj одной ячейки = pred другой — ребро «chains» в один клик.</p>
          <ul className="mt-2 max-h-60 space-y-1 overflow-auto font-mono text-xs text-muted">
            {chains.length ? chains.slice(0, chainLimit).map((c) => (
              <li key={`${c.from}-${c.to}`} className="flex min-w-0 flex-wrap items-baseline gap-2">
                <button type="button" className="underline" title={`WIRE ${c.from} ${c.to} chains`} onClick={() => exec(`WIRE ${c.from} ${c.to} chains`)}>WIRE</button>
                <button type="button" className="break-all text-fg underline-offset-2 hover:underline" onClick={() => setWhyId(c.from)}>{c.from}</button>
                <span className="text-subtle">→</span>
                <button type="button" className="break-all text-fg underline-offset-2 hover:underline" onClick={() => setWhyId(c.to)}>{c.to}</button>
                <span className="text-subtle">via {c.via}</span>
              </li>
            )) : <li className="text-subtle">цепочек нет: все совпадения obj/pred уже связаны</li>}
          </ul>
          {chains.length > chainLimit ? (
            <button type="button" className="mt-2 h-9 rounded-md border border-border px-3 text-xs" onClick={() => setChainLimit((l) => l + 40)}>показать ещё {Math.min(40, chains.length - chainLimit)}</button>
          ) : null}
        </section>
        <section className="min-w-0 rounded-lg border border-border bg-surface p-3" aria-labelledby="turn-h">
          <p id="turn-h" className="text-xs tracking-wide text-subtle">TURN · записи по ходам диалога · {turns.length}</p>
          {turns.length ? (
            <>
              <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                ход
                <select value={turn} onChange={(e) => { setTurn(e.target.value); setTurnLimit(PAGE); }} className="h-9 rounded-md border border-border bg-elevated px-2 font-mono text-xs">
                  <option value="">— все ходы —</option>
                  {turns.map(([t, n]) => <option key={t} value={t}>ход {t} · {n}</option>)}
                </select>
              </label>
              {turn ? (
                <>
                  <ul className="mt-2 max-h-60 space-y-1 overflow-auto font-mono text-xs text-muted">
                    {turnRows.slice(0, turnLimit).map((o) => (
                      <li key={o.id} className="flex min-w-0 flex-wrap gap-2">
                        <button type="button" className="break-all text-fg underline-offset-2 hover:underline" onClick={() => setWhyId(o.id)}>{o.id}</button>
                        <span className="text-subtle">{o.type}/{o.status}</span>
                        <span className="min-w-0 flex-1 truncate">{o.title}</span>
                      </li>
                    ))}
                  </ul>
                  <More total={turnRows.length} shown={Math.min(turnLimit, turnRows.length)} onMore={() => setTurnLimit((l) => l + PAGE)} />
                </>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-1 font-mono text-xs">
                  {turns.map(([t, n]) => (
                    <li key={t}>
                      <button type="button" className="rounded border border-border px-2 py-0.5 text-muted hover:text-fg" onClick={() => setTurn(t)}>{t}·{n}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="mt-2 text-xs text-subtle">происхождение по ходам пусто: посадите экспорт диалога с маркерами «# you asked» / «# chatgpt response»</p>
          )}
        </section>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">ячейки канона · {cells.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>{["id", "кл", "pred", "rel", "obj", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {cells.slice(0, cellsLimit).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.pred}</td>
                <td className="px-3 py-2 text-subtle">{r.rel}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.obj}</td>
                <td className="px-3 py-2"><button type="button" className="text-xs underline" onClick={() => setWhyId(r.id)}>WHY</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More total={cells.length} shown={Math.min(cellsLimit, cells.length)} onMore={() => setCellsLimit((l) => l + PAGE)} />

      <h2 className="mt-8 text-xs tracking-wide text-subtle">факты и решения · {rest.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>{["id", "кл", "тип", "заголовок", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rest.slice(0, restLimit).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2 text-xs">{r.type}</td>
                <td className="max-w-[28rem] truncate px-3 py-2" title={titleOf(r.id)}>{r.title}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-3 whitespace-nowrap">
                    <button type="button" className="text-xs underline" onClick={() => setWhyId(r.id)}>WHY</button>
                    <button type="button" className="text-xs underline" onClick={() => { exec(`RUN ${r.id}`); void nav({ to: "/l4" }); }}>RUN</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More total={rest.length} shown={Math.min(restLimit, rest.length)} onMore={() => setRestLimit((l) => l + PAGE)} />
      {canon.length === 0 ? <p className="mt-6 text-sm text-muted">Канон пуст: ACCEPT ещё ничего не принял.</p> : null}
    </DeskShell>
  );
}

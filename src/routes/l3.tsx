import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { LinkGraph } from "@/components/link-graph";
import { useDesk } from "@/lib/desk";

export const Route = createFileRoute("/l3")({ component: L3 });

const RELS = ["cites", "refines", "contradicts", "replaces", "derived_from", "feeds", "relevant_to", "raises", "triggers", "blocks", "constrains", "candidate"];

function L3() {
  const objects = useDesk((s) => s.objects);
  const links = useDesk((s) => s.links);
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const nav = useNavigate();
  const canon = objects.filter((o) => o.status === "canon");
  const cells = canon.filter((o) => o.pred);
  const rest = canon.filter((o) => !o.pred);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rel, setRel] = useState("constrains");
  const [why, setWhy] = useState<string | null>(null);
  const [probe, setProbe] = useState<string[]>([]);

  const ids = useMemo(() => objects.map((o) => o.id), [objects]);

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

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L3 · память</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Канон = то, что принял человек. Ячейки — тройки pred REL obj. Рёбра — единственный допустимый морфизм между кластерами: по одному, не декартово.
      </p>

      <h2 className="mt-6 text-xs tracking-wide text-subtle">граф рёбер · {links.length}</h2>
      <div className="mt-2">
        <LinkGraph objects={objects} links={links} onPick={(id) => setWhy(query(`WHY ${id}`).text)} />
      </div>
      {why ? <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-elevated p-3 font-mono text-xs text-muted">{why}</pre> : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <form className="rounded-lg border border-border bg-surface p-3" onSubmit={(e) => { e.preventDefault(); wire(); }}>
          <p className="text-xs tracking-wide text-subtle">WIRE · одно ребро</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input list="desk-ids" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from id" className="h-10 min-w-32 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
            <select value={rel} onChange={(e) => setRel(e.target.value)} className="h-10 rounded-md border border-border bg-elevated px-2 font-mono text-sm">
              {RELS.map((r) => <option key={r}>{r}</option>)}
            </select>
            <input list="desk-ids" value={to} onChange={(e) => setTo(e.target.value)} placeholder="to id" className="h-10 min-w-32 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
            <button type="submit" className="h-10 rounded-md bg-fg px-4 text-sm text-accent-fg">WIRE</button>
          </div>
          <datalist id="desk-ids">{ids.map((id) => <option key={id} value={id} />)}</datalist>
        </form>
        <div className="rounded-lg border border-border bg-surface p-3">
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
                <li key={l} className="flex gap-2">
                  <button type="button" className="underline" onClick={() => exec(`WIRE ${m[1]} ${m[2]} candidate`)}>WIRE</button>
                  <span>{m[1]} → {m[2]}</span>
                  <span className="text-subtle">{m[3]}</span>
                </li>
              ) : null;
            }) : <li className="text-subtle">нажмите пару кластеров</li>}
          </ul>
        </div>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">ячейки канона · {cells.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>{["id", "кл", "pred", "rel", "obj", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {cells.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.pred}</td>
                <td className="px-3 py-2 text-subtle">{r.rel}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.obj}</td>
                <td className="px-3 py-2"><button type="button" className="text-xs underline" onClick={() => setWhy(query(`WHY ${r.id}`).text)}>WHY</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-xs tracking-wide text-subtle">факты и решения · {rest.length}</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-elevated text-xs text-subtle">
            <tr>{["id", "кл", "тип", "заголовок", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rest.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                <td className="px-3 py-2">{r.cluster}</td>
                <td className="px-3 py-2 text-xs">{r.type}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2">
                  <button type="button" className="text-xs underline" onClick={() => { exec(`RUN ${r.id}`); nav({ to: "/l4" }); }}>RUN</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canon.length === 0 ? <p className="mt-6 text-sm text-muted">Канон пуст: ACCEPT ещё ничего не принял.</p> : null}
    </DeskShell>
  );
}

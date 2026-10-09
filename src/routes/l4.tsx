import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-nav";
import { downloadText, useDesk } from "@/lib/desk";

export const Route = createFileRoute("/l4")({ component: L4 });

const PROTOCOL = `# протокол для агента (любая модель)
1. Получил сырьё → PLANT <текст>   (не саммари)
2. INSTR → где красная зона; GRID → где сырьё, где канон
3. SET NEQ ∩ RAW → список; FILL принимает ячейки пачкой
4. Спорное — WHY id; лишнее — TAKE id; ошибся — UNDO
5. Связь между кластерами — WIRE a b rel (одно ребро), не MUL
6. Снимок для следующего агента — JSON, не проза
7. Новый вопрос в ленту — FETCH <вопрос>`;

function L4() {
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const events = useDesk((s) => s.events);
  const objects = useDesk((s) => s.objects);
  const links = useDesk((s) => s.links);
  const exportBook = useDesk((s) => s.exportBook);
  const importBook = useDesk((s) => s.importBook);
  const reset = useDesk((s) => s.reset);
  const nav = useNavigate();
  const [tick, setTick] = useState(0);
  const [importMsg, setImportMsg] = useState("");
  const [fetchQ, setFetchQ] = useState("");
  const next = useMemo(() => query("NEXT").text, [query, tick, objects, links]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = useMemo(() => query("SPEC").text, [query, tick, events]); // eslint-disable-line react-hooks/exhaustive-deps
  const journal = [...events].reverse().slice(0, 40);

  function onImport(file: File | undefined) {
    if (!file) return;
    void file.text().then((t) => setImportMsg(importBook(t)));
  }

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-medium tracking-tight">L4 · действие</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Ход берётся из правил над книгой, не из ленты. Журнал записей — живая спецификация языка: глагол существует, пока им ходят.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={() => { exec("GAP"); setTick((t) => t + 1); }}>GAP</button>
          <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={() => { exec("SETTLE"); setTick((t) => t + 1); }}>SETTLE</button>
          <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={() => { exec("UNDO"); setTick((t) => t + 1); }}>UNDO</button>
        </div>
      </div>

      <section className="mt-6 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">NEXT · ход из правил</p>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">{next}</pre>
        </div>
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">SPEC · журнал → язык</p>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">{spec}</pre>
        </div>
      </section>

      <form className="mt-6 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); exec(`FETCH ${fetchQ.trim()}`); setFetchQ(""); nav({ to: "/l2" }); }}>
        <input value={fetchQ} onChange={(e) => setFetchQ(e.target.value)} placeholder="FETCH — новый вопрос на ленту (пусто: «чего нет в каноне?»)" className="h-11 min-w-0 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm" />
        <button type="submit" className="h-11 rounded-md bg-fg px-4 text-sm text-accent-fg">FETCH → L2</button>
      </form>

      <section className="mt-6 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">журнал · {events.length}</p>
          <ul className="mt-2 max-h-72 overflow-auto rounded-lg border border-border font-mono text-xs">
            {journal.map((e) => (
              <li key={e.seq} className="flex gap-2 border-b border-border px-3 py-1.5">
                <span className="text-subtle">{e.ts.slice(5, 16)}</span>
                <span className={e.before !== undefined || e.link ? "text-fg" : "text-muted"}>{e.action}</span>
                <span className="text-subtle">{e.objectId ?? ""}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{e.detail ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">протокол агента</p>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">{PROTOCOL}</pre>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-3">
        <p className="text-xs tracking-wide text-subtle">перенос книги</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="h-10 rounded-md border border-border px-3 text-sm" onClick={() => downloadText("book.json", exportBook(), "application/json")}>экспорт JSON</button>
          <button type="button" className="h-10 rounded-md border border-border px-3 text-sm" onClick={() => downloadText("book.tsv", query("DUMP").text, "text/tab-separated-values")}>экспорт TSV</button>
          <button type="button" className="h-10 rounded-md border border-border px-3 text-sm" onClick={() => downloadText("snapshot.json", query("JSON").text, "application/json")}>снимок для агента</button>
          <label className="inline-flex h-10 cursor-pointer items-center rounded-md border border-border px-3 text-sm">
            импорт JSON
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => onImport(e.target.files?.[0])} />
          </label>
          <span className="ml-auto" />
          <button type="button" className="h-10 rounded-md border border-border px-3 text-sm text-subtle" onClick={() => { if (confirm("Пересобрать книгу из семени v1? Текущие записи будут потеряны.")) reset(true); }}>к семени v1</button>
          <button type="button" className="h-10 rounded-md border border-border px-3 text-sm text-subtle" onClick={() => { if (confirm("Пустая книга? Текущие записи будут потеряны.")) reset(false); }}>пустая книга</button>
        </div>
        {importMsg ? <p className="mt-2 font-mono text-xs text-muted">{importMsg}</p> : null}
      </section>
    </DeskShell>
  );
}

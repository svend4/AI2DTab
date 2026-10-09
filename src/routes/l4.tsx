import { useMemo, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeskShell, SavedLine } from "@/components/desk-nav";
import type { BookDiff } from "@/engine/merge";
import { isTsv, plantTsv, toObj } from "@/engine/plant";
import { nowIso, STATUSES, type Book, type Status } from "@/engine/types";
import { downloadText, useDesk, type ImportMode } from "@/lib/desk";

export const Route = createFileRoute("/l4")({ component: L4 });

const PROTOCOL = `# протокол для агента (любая модель)
1. Получил сырьё → PLANT <текст>   (не саммари)
2. INSTR → где красная зона; GRID → где сырьё, где канон
3. SET NEQ ∩ RAW → список; FILL принимает ячейки пачкой
4. Спорное — WHY id; лишнее — TAKE id; ошибся — UNDO
5. Связь между кластерами — WIRE a b rel (одно ребро), не MUL
6. Снимок для следующего агента — JSON, не проза
7. Новый вопрос в ленту — FETCH <вопрос>
8. Вторая книга — DIFFBOOK json (посмотреть), MERGE json (слить)`;

const JOURNAL_ROWS = 60;

/** Файл прочитан, но ещё не применён: показываем разницу и ждём выбора «заменить / слить». */
type Pending = {
  name: string;
  kind: "json" | "tsv";
  /** JSON книги, который уйдёт в importBook. */
  json: string;
  objects: number;
  links: number;
  diff: BookDiff | null;
  diffText: string;
  error?: string;
};

function sanitizeId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
}

/**
 * TSV формата DUMP → книга. plantTsv даёт строки raw; колонку status (если она есть)
 * читаем сами из тех же строк: plantTsv пропускает только строки без id, так что
 * индексы совпадают.
 */
function tsvToBook(text: string): Book {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const head = (lines[0] ?? "").split("\t").map((h) => h.trim());
  const idCol = head.indexOf("id");
  const statusCol = head.indexOf("status");
  const dataRows = lines.slice(1).filter((line) => sanitizeId(line.split("\t")[idCol] ?? ""));
  const seedlings = plantTsv(text);
  const ts = nowIso();
  const known = new Set<string>(STATUSES);
  const objects = seedlings.map((s, i) => {
    const o = toObj(s, ts, "human:import");
    const st = statusCol >= 0 ? (dataRows[i]?.split("\t")[statusCol] ?? "").trim() : "";
    if (known.has(st)) o.status = st as Status;
    return o;
  });
  return { version: 2, objects, links: [], origins: [], events: [] };
}

function L4() {
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const ready = useDesk((s) => s.ready);
  const events = useDesk((s) => s.events);
  const objects = useDesk((s) => s.objects);
  const links = useDesk((s) => s.links);
  const importWarnings = useDesk((s) => s.importWarnings);
  const exportBook = useDesk((s) => s.exportBook);
  const importBook = useDesk((s) => s.importBook);
  const reset = useDesk((s) => s.reset);
  const nav = useNavigate();
  const [importMsg, setImportMsg] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [importing, setImporting] = useState(false);
  const [fetchQ, setFetchQ] = useState("");
  const [journalLimit, setJournalLimit] = useState(JOURNAL_ROWS);
  // NEXT/SPEC — чтение; книга меняется только через exec → refresh, поэтому зависимости — объекты/рёбра/журнал
  const next = useMemo(() => query("NEXT").text, [query, objects, links]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = useMemo(() => query("SPEC").text, [query, events]); // eslint-disable-line react-hooks/exhaustive-deps
  const journal = useMemo(() => [...events].reverse(), [events]);
  const undoneCount = useMemo(() => events.filter((e) => e.undone).length, [events]);

  function onImport(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    setImportMsg("");
    void file.text().then((text) => {
      input.value = "";
      const tsv = /\.tsv$/i.test(file.name) || isTsv(text);
      let json = text;
      let kind: Pending["kind"] = "json";
      let error: string | undefined;
      if (tsv) {
        kind = "tsv";
        const book = tsvToBook(text);
        if (!book.objects.length) error = "в TSV нет ни одной строки с id (ожидается заголовок id\\tcluster\\tlayer\\ttype\\ttitle\\tstatus\\tbody)";
        json = JSON.stringify(book);
      } else {
        try {
          JSON.parse(text);
        } catch (e) {
          error = `не JSON: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (error) {
        setPending({ name: file.name, kind, json: "", objects: 0, links: 0, diff: null, diffText: "", error });
        return;
      }
      const out = query(`DIFFBOOK ${json}`);
      const diff = out.ok && out.data && typeof out.data === "object" ? (out.data as BookDiff) : null;
      let counts = { objects: 0, links: 0 };
      try {
        const parsed = JSON.parse(json) as { objects?: unknown[]; links?: unknown[] };
        counts = { objects: parsed.objects?.length ?? 0, links: parsed.links?.length ?? 0 };
      } catch {
        /* уже проверено выше */
      }
      setPending({ name: file.name, kind, json, objects: counts.objects, links: counts.links, diff, diffText: out.text, error: out.ok ? undefined : out.text.split("\n")[0] });
    });
  }

  function apply(mode: ImportMode) {
    if (!pending || pending.error || importing) return;
    setImporting(true);
    const label = pending.kind === "tsv" ? `TSV ${pending.name}` : pending.name;
    importBook(pending.json, mode)
      .then((msg) => setImportMsg(`${mode === "merge" ? "слияние" : "замена"} · ${label} · ${msg}`))
      .catch((e: unknown) => setImportMsg(`импорт не удался: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        setImporting(false);
        setPending(null);
      });
  }

  function fetch(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const out = exec(`FETCH ${fetchQ.trim()}`);
    setFetchQ("");
    if (out.ok) void nav({ to: "/l2" });
  }

  const warn = "text-[color:var(--color-warn)]";

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-medium tracking-tight">L4 · действие</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Ход берётся из правил над книгой, не из ленты. Журнал записей — живая спецификация языка: глагол существует, пока им ходят.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!ready} className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-40" onClick={() => exec("GAP")}>GAP</button>
          <button type="button" disabled={!ready} className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-40" onClick={() => exec("SETTLE")}>SETTLE</button>
          <button type="button" disabled={!ready} className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-40" onClick={() => exec("UNDO")}>UNDO</button>
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

      <form className="mt-6 flex flex-wrap gap-2" onSubmit={fetch}>
        <label className="sr-only" htmlFor="fetch-q">новый вопрос</label>
        <input
          id="fetch-q"
          value={fetchQ}
          disabled={!ready}
          onChange={(e) => setFetchQ(e.target.value)}
          placeholder="FETCH — новый вопрос (пусто: «чего нет в каноне?»)"
          className="h-11 min-w-0 flex-1 basis-64 rounded-md border border-border bg-elevated px-3 font-mono text-sm disabled:opacity-50"
        />
        <button type="submit" disabled={!ready} className="h-11 rounded-md bg-fg px-4 text-sm text-accent-fg disabled:opacity-40">FETCH → L2</button>
        <p className="basis-full text-xs text-subtle">вопрос ляжет строкой raw на плоскость L2 и дописывается в ленту L1 — петля замыкается</p>
      </form>

      <section className="mt-6 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">
            журнал · {events.length}{undoneCount ? ` · откачено ↩ ${undoneCount}` : ""}
          </p>
          <ul className="mt-2 max-h-72 overflow-auto rounded-lg border border-border font-mono text-xs">
            {journal.slice(0, journalLimit).map((e) => (
              <li key={e.seq} className={`flex min-w-0 gap-2 border-b border-border px-3 py-1.5 ${e.undone ? "text-subtle line-through decoration-dotted" : ""}`} title={e.undone ? "откачено UNDO" : undefined}>
                <span className="shrink-0 text-subtle">{e.ts.slice(5, 16)}</span>
                <span className={e.undone ? "" : e.before !== undefined || e.link ? "text-fg" : "text-muted"}>
                  {e.action}{e.undone ? " ↩" : ""}
                </span>
                <span className="shrink-0 text-subtle">{e.objectId ?? ""}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{e.detail ?? ""}</span>
              </li>
            ))}
          </ul>
          {journal.length > journalLimit ? (
            <button type="button" className="mt-2 h-9 rounded-md border border-border px-3 text-xs" onClick={() => setJournalLimit((l) => l + JOURNAL_ROWS)}>
              показать ещё {Math.min(JOURNAL_ROWS, journal.length - journalLimit)} · показано {journalLimit} из {journal.length}
            </button>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-subtle">протокол агента</p>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">{PROTOCOL}</pre>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs tracking-wide text-subtle">перенос книги</p>
          <SavedLine />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={!ready} className="h-10 rounded-md border border-border px-3 text-sm disabled:opacity-40" onClick={() => downloadText("book.json", exportBook(), "application/json")}>экспорт JSON</button>
          <button type="button" disabled={!ready} className="h-10 rounded-md border border-border px-3 text-sm disabled:opacity-40" onClick={() => downloadText("book.tsv", query("DUMP").text, "text/tab-separated-values")}>экспорт TSV</button>
          <button type="button" disabled={!ready} className="h-10 rounded-md border border-border px-3 text-sm disabled:opacity-40" onClick={() => downloadText("snapshot.json", query("JSON").text, "application/json")}>снимок для агента</button>
          <label className="inline-flex h-10 cursor-pointer items-center rounded-md border border-border px-3 text-sm focus-within:border-border-strong">
            импорт JSON / TSV
            <input type="file" accept=".json,.tsv,application/json,text/tab-separated-values" className="sr-only" disabled={!ready || importing} onChange={(e) => onImport(e.currentTarget)} />
          </label>
          <span className="ml-auto" />
          <button type="button" disabled={!ready} className="h-10 rounded-md border border-border px-3 text-sm text-subtle disabled:opacity-40" onClick={() => { if (confirm("Пересобрать книгу из семени v1? Текущие записи будут потеряны.")) reset(true); }}>к семени v1</button>
          <button type="button" disabled={!ready} className="h-10 rounded-md border border-border px-3 text-sm text-subtle disabled:opacity-40" onClick={() => { if (confirm("Пустая книга? Текущие записи будут потеряны.")) reset(false); }}>пустая книга</button>
        </div>
        <p className="mt-2 text-xs text-subtle">
          перетащите экспорт диалога на L1 — секции получат свои номера; сюда — книгу JSON другого стола или TSV формата DUMP (колонка status учитывается; рёбра из TSV не переносятся)
        </p>

        {pending ? (
          <div className="mt-3 rounded-md border border-border bg-elevated p-3 font-mono text-xs" role="dialog" aria-label="импорт книги">
            <p className="text-fg">
              {pending.kind === "tsv" ? "TSV" : "JSON"} · {pending.name}
              {!pending.error ? ` · ${pending.objects} объектов, ${pending.links} рёбер` : ""}
            </p>
            {pending.error ? (
              <p className={`mt-1 ${warn}`}>{pending.error}</p>
            ) : pending.diff ? (
              <>
                <p className="mt-1 text-muted">
                  DIFFBOOK: новых <span className="text-fg">+{pending.diff.added.length}</span> · нет в файле <span className="text-fg">−{pending.diff.removed.length}</span> · изменённых <span className="text-fg">~{pending.diff.changed.length}</span> · рёбер +{pending.diff.linksAdded.length} / −{pending.diff.linksRemoved.length}
                </p>
                <p className="mt-1 text-subtle">
                  «заменить» — книга станет файлом (текущие записи уйдут, журнал начнётся с файла); «слить» — файл добавится к книге, при конфликте статуса побеждает канон, «нет в файле» остаётся
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-subtle">подробности разницы</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-muted">{pending.diffText}</pre>
                </details>
              </>
            ) : (
              <p className={`mt-1 ${warn}`}>разницу посчитать не удалось: {pending.diffText.split("\n")[0]}</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {!pending.error ? (
                <>
                  <button type="button" disabled={importing} className="h-9 rounded-md border border-border px-3 text-xs disabled:opacity-40" onClick={() => apply("replace")}>заменить</button>
                  <button type="button" disabled={importing} className="h-9 rounded-md bg-fg px-3 text-xs text-accent-fg disabled:opacity-40" onClick={() => apply("merge")}>слить</button>
                </>
              ) : null}
              <button type="button" disabled={importing} className="h-9 rounded-md border border-border px-3 text-xs text-subtle disabled:opacity-40" onClick={() => setPending(null)}>отмена</button>
              {importing ? <span className="self-center text-muted" role="status">применяем и сохраняем…</span> : null}
            </div>
          </div>
        ) : null}
        {importMsg ? <p className="mt-2 break-words font-mono text-xs text-muted" role="status">{importMsg}</p> : null}
        {importWarnings.length ? (
          <details className="mt-2 font-mono text-xs" open={importWarnings.length <= 5}>
            <summary className={`cursor-pointer ${warn}`}>предупреждений при чтении книги: {importWarnings.length}</summary>
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-muted">
              {importWarnings.slice(0, 100).map((w, i) => <li key={i} className="break-words">· {w}</li>)}
              {importWarnings.length > 100 ? <li className="text-subtle">… и ещё {importWarnings.length - 100}</li> : null}
            </ul>
          </details>
        ) : null}
      </section>
    </DeskShell>
  );
}

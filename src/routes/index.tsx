import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import ontSeed from "@/data/ont-l2.json";
import { DeskShell } from "@/components/desk-nav";
import { countNumbered, isTsv, plantText, plantTsv, unquote, type Seedling } from "@/engine/plant";
import { useDesk } from "@/lib/desk";

export const Route = createFileRoute("/")({ component: L1 });

/** Сухая посадка не пересчитывается на каждое нажатие: лента в 4 МБ режется ~1 с. */
const PREVIEW_DEBOUNCE_MS = 250;
const PREVIEW_ROWS = 200;

type PlantReport = { planted: number; skipped: number; collisions: number; total: number; text: string; ok: boolean };

function kitTsv(): string {
  const head = ["id", "cluster", "layer", "type", "title", "status", "body"];
  const esc = (s: unknown) => String(s ?? "").replace(/\t/g, " ").replace(/\n/g, " / ");
  return [head.join("\t"), ...ontSeed.map((r) => head.map((h) => esc((r as Record<string, unknown>)[h])).join("\t"))].join("\n");
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function reportOf(out: { ok: boolean; text: string; data?: unknown }): PlantReport {
  const d = (out.data ?? {}) as { planted?: string[]; skipped?: string[]; collisions?: string[] };
  const planted = d.planted?.length ?? 0;
  const skipped = d.skipped?.length ?? 0;
  const collisions = d.collisions?.length ?? 0;
  return { planted, skipped, collisions, total: planted + skipped, text: out.text.split("\n").slice(-1)[0] ?? "", ok: out.ok };
}

function L1() {
  const tape = useDesk((s) => s.tape);
  const setTape = useDesk((s) => s.setTape);
  const exec = useDesk((s) => s.exec);
  const ready = useDesk((s) => s.ready);
  const objects = useDesk((s) => s.objects);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PlantReport | null>(null);

  // два слоя задержки: таймер 250 мс + useDeferredValue, чтобы ввод не ждал нарезки
  const debounced = useDebounced(tape, PREVIEW_DEBOUNCE_MS);
  const deferred = useDeferredValue(debounced);
  const preview = useMemo<Seedling[]>(() => (deferred.trim() ? (isTsv(deferred) ? plantTsv(deferred) : plantText(deferred)) : []), [deferred]);
  const stale = deferred !== tape;
  const have = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);
  const fresh = useMemo(() => preview.filter((p) => !have.has(p.id)).length, [preview, have]);
  const sectionMode = useMemo(() => preview.some((p) => p.kind === "section"), [preview]);
  const numbered = useMemo(() => (sectionMode ? countNumbered(unquote(deferred)) : 0), [sectionMode, deferred]);
  const turns = useMemo(() => {
    const s = new Set<number>();
    for (const p of preview) if (p.turn !== undefined) s.add(p.turn);
    const max = s.size ? Math.max(...s) : 0;
    return max > 0 ? s.size : 0;
  }, [preview]);
  const recent = useMemo(() => objects.filter((o) => o.owner.endsWith(":plant")).slice(-12).reverse(), [objects]);

  function onFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((t) => {
      setTape(t);
      // тот же файл второй раз должен снова сработать
      input.value = "";
    });
  }

  function plant(text: string) {
    if (busy || !text.trim()) return;
    setBusy(true);
    setReport(null);
    // даём браузеру нарисовать «сажаем…» до синхронной посадки
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          const out = exec(`PLANT ${text}`);
          setReport(reportOf(out));
        } finally {
          setBusy(false);
        }
      }, 0);
    });
  }

  const shown = preview.slice(0, PREVIEW_ROWS);

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L1 · лента</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Одномерный ввод. Ниже — сухая посадка: что именно станет строками, с каким id и почему. Один и тот же абзац всегда даёт один и тот же id, так что ленту можно сажать повторно без дублей.
        Экспорт диалога (цитаты «&gt;», «# you asked», нумерованные заголовки) понимается как есть: секции получат свои номера.
      </p>
      <textarea
        id="tape"
        value={tape}
        disabled={!ready}
        onChange={(e) => setTape(e.target.value)}
        placeholder={"Вставьте сырой текст. Абзацы — через пустую строку.\n\nЗаголовок вида «A ≠ B» станет ячейкой; «Как …?» — вопросом; «Решено: …» — решением."}
        className="mt-6 min-h-44 w-full rounded-lg border border-border bg-elevated p-4 font-mono text-sm leading-relaxed text-fg outline-none focus:border-border-strong disabled:opacity-50"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border bg-elevated px-4 text-sm focus-within:border-border-strong">
          Файл
          <input
            type="file"
            accept=".txt,.md,.json,.tsv,text/*"
            className="sr-only"
            disabled={!ready}
            onChange={(e) => onFile(e.currentTarget)}
          />
        </label>
        <button
          type="button"
          disabled={!ready || busy || !fresh}
          aria-busy={busy}
          className="h-11 rounded-md bg-fg px-4 text-sm font-medium text-accent-fg disabled:opacity-40"
          onClick={() => plant(tape.trim())}
        >
          {busy ? "сажаем…" : `Посадить на L2 ${preview.length ? `(${fresh} новых из ${preview.length})` : ""}`}
        </button>
        <button type="button" disabled={!ready || busy} className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-40" onClick={() => plant(kitTsv())}>
          Посадить комплект ({ontSeed.length} строк)
        </button>
        <button type="button" disabled={!ready || busy} className="h-11 rounded-md border border-border px-4 text-sm disabled:opacity-40" onClick={() => setTape("")}>
          Очистить ленту
        </button>
      </div>

      {busy ? (
        <p className="mt-3 font-mono text-xs text-muted" role="status" aria-live="polite">
          PLANT идёт: режем, классифицируем, считаем id… большая лента сажается около секунды
        </p>
      ) : null}
      {report ? (
        <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 font-mono text-xs ${report.ok ? "border-border bg-surface text-muted" : "border-[color:var(--color-warn)] text-[color:var(--color-warn)]"}`} role="status">
          <span className="text-fg">PLANT → посажено {report.planted}</span>
          <span>пропущено (уже есть) {report.skipped}</span>
          {report.collisions ? <span className="text-[color:var(--color-warn)]">коллизий id {report.collisions}</span> : null}
          <span className="text-subtle">{report.text}</span>
          <Link to="/l2" className="ml-auto underline underline-offset-2">открыть L2 →</Link>
        </div>
      ) : null}

      {preview.length ? (
        <>
          <div className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs tracking-wide text-subtle">
            <h2>сухая посадка · {preview.length}</h2>
            {preview.length > PREVIEW_ROWS ? <span>показано {PREVIEW_ROWS} из {preview.length}</span> : null}
            <span>новых {fresh} · уже есть {preview.length - fresh}</span>
            {sectionMode ? <span className="text-fg">режим: секции ({numbered} нумерованных заголовков)</span> : <span>режим: {preview[0]?.kind === "tsv" ? "TSV" : "абзацы"}</span>}
            {turns ? <span>ходов диалога: {turns}</span> : null}
            {stale ? <span className="text-muted">пересчитываем…</span> : null}
          </div>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="bg-elevated text-xs text-subtle">
                <tr>{["id", "кластер", "тип", "ход", "почему", "заголовок"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className={`border-t border-border ${have.has(p.id) ? "text-subtle" : ""}`}>
                    <td className="px-3 py-2 font-mono text-xs">{p.id}{have.has(p.id) ? " ·есть" : ""}</td>
                    <td className="px-3 py-2">{p.cluster}</td>
                    <td className="px-3 py-2">{p.type}</td>
                    <td className="px-3 py-2 font-mono text-xs text-subtle">{turns && p.turn !== undefined ? p.turn : ""}</td>
                    <td className="px-3 py-2 text-xs text-muted">{p.why}</td>
                    <td className="max-w-[28rem] truncate px-3 py-2">{p.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.length > PREVIEW_ROWS ? (
            <p className="mt-2 text-xs text-subtle">показано {PREVIEW_ROWS} из {preview.length} — посадка возьмёт все {preview.length}</p>
          ) : null}
        </>
      ) : null}

      <h2 className="mt-8 text-xs tracking-wide text-subtle">последние посадки · {recent.length}</h2>
      {recent.length ? (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
          {recent.map((o) => (
            <li key={o.id} className="flex min-w-0 flex-wrap gap-x-3 px-3 py-2">
              <span className="font-mono text-xs">{o.id}</span>
              <span className="text-subtle">{o.cluster}/{o.type}/{o.status}</span>
              <span className="min-w-0 flex-1 truncate">{o.title}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Ничего ещё не посажено. Книга стартует с семенем v1: 31 запись и 15 рёбер.</p>
      )}
    </DeskShell>
  );
}

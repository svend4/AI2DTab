import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import ontSeed from "@/data/ont-l2.json";
import { DeskShell } from "@/components/desk-nav";
import { isTsv, plantText, plantTsv } from "@/engine/plant";
import { useDesk } from "@/lib/desk";

export const Route = createFileRoute("/")({ component: L1 });

function kitTsv(): string {
  const head = ["id", "cluster", "layer", "type", "title", "status", "body"];
  const esc = (s: unknown) => String(s ?? "").replace(/\t/g, " ").replace(/\n/g, " / ");
  return [head.join("\t"), ...ontSeed.map((r) => head.map((h) => esc((r as Record<string, unknown>)[h])).join("\t"))].join("\n");
}

function L1() {
  const tape = useDesk((s) => s.tape);
  const setTape = useDesk((s) => s.setTape);
  const exec = useDesk((s) => s.exec);
  const objects = useDesk((s) => s.objects);
  const nav = useNavigate();
  const preview = useMemo(() => (tape.trim() ? (isTsv(tape) ? plantTsv(tape) : plantText(tape)) : []), [tape]);
  const have = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);
  const fresh = preview.filter((p) => !have.has(p.id)).length;
  const recent = objects.filter((o) => o.owner === "machine:plant").slice(-12).reverse();

  function onFile(file: File | undefined) {
    if (!file) return;
    void file.text().then(setTape);
  }

  function plant(text: string) {
    const out = exec(`PLANT ${text}`);
    if (out.ok) nav({ to: "/l2" });
  }

  return (
    <DeskShell>
      <h1 className="font-display text-3xl font-medium tracking-tight">L1 · лента</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Одномерный ввод. Ниже — сухая посадка: что именно станет строками, с каким id и почему. Один и тот же абзац всегда даёт один и тот же id, так что ленту можно сажать повторно без дублей.
      </p>
      <textarea
        id="tape"
        value={tape}
        onChange={(e) => setTape(e.target.value)}
        placeholder={"Вставьте сырой текст. Абзацы — через пустую строку.\n\nЗаголовок вида «A ≠ B» станет ячейкой; «Как …?» — вопросом; «Решено: …» — решением."}
        className="mt-6 min-h-44 w-full rounded-lg border border-border bg-elevated p-4 font-mono text-sm leading-relaxed text-fg outline-none focus:border-border-strong"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border bg-elevated px-4 text-sm">
          Файл
          <input type="file" accept=".txt,.md,.json,.tsv,text/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <button type="button" disabled={!fresh} className="h-11 rounded-md bg-fg px-4 text-sm font-medium text-accent-fg disabled:opacity-40" onClick={() => plant(tape.trim())}>
          Посадить на L2 {preview.length ? `(${fresh} новых из ${preview.length})` : ""}
        </button>
        <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={() => plant(kitTsv())}>
          Посадить комплект (36 строк)
        </button>
        <button type="button" className="h-11 rounded-md border border-border px-4 text-sm" onClick={() => setTape("")}>
          Очистить ленту
        </button>
      </div>

      {preview.length ? (
        <>
          <h2 className="mt-8 text-xs tracking-wide text-subtle">сухая посадка · {preview.length}</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="bg-elevated text-xs text-subtle">
                <tr>{["id", "кластер", "тип", "почему", "заголовок"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.slice(0, 60).map((p) => (
                  <tr key={p.id} className={`border-t border-border ${have.has(p.id) ? "text-subtle" : ""}`}>
                    <td className="px-3 py-2 font-mono text-xs">{p.id}{have.has(p.id) ? " ·есть" : ""}</td>
                    <td className="px-3 py-2">{p.cluster}</td>
                    <td className="px-3 py-2">{p.type}</td>
                    <td className="px-3 py-2 text-xs text-muted">{p.why}</td>
                    <td className="px-3 py-2">{p.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 className="mt-8 text-xs tracking-wide text-subtle">последние посадки · {recent.length}</h2>
      {recent.length ? (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
          {recent.map((o) => (
            <li key={o.id} className="flex flex-wrap gap-x-3 px-3 py-2">
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

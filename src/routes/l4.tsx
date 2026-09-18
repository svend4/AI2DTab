import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import archive from "@/data/archive.json";
import { DeskShell } from "@/components/desk-nav";
import { readKitFile } from "@/lib/kit-api";
import { bridge, fetchBoth, refreshBook } from "@/lib/desk-bridge";

export const Route = createFileRoute("/l4")({ component: L4 });

function L4() {
  const nav = useNavigate();
  const [spec, setSpec] = useState("снимаю SPEC…");
  const [port, setPort] = useState("");
  const [preview, setPreview] = useState<{ path: string; preview: string; bytes: number } | null>(
    null,
  );
  const [kind, setKind] = useState("все");
  const kinds = ["все", "съём", ...Array.from(new Set(archive.map((f) => f.kind)))];
  const files = [{ path: "LANG-FROM-DB.md", bytes: 0, kind: "съём" as const }, ...archive];
  const shown = kind === "все" ? files : files.filter((f) => f.kind === kind);

  async function loadSpec() {
    const [a, b] = await Promise.all([bridge("SPEC"), bridge("PORT C A")]);
    setSpec((a.stdout || a.stderr || "пусто").trim());
    setPort((b.stdout || b.stderr || "").trim());
    const c = await bridge("CAT LANG-FROM-DB.md");
    if (c.ok && c.stdout.trim()) {
      setPreview({ path: "LANG-FROM-DB.md", bytes: c.stdout.length, preview: c.stdout });
    }
  }

  useEffect(() => {
    void loadSpec();
  }, []);

  async function openFile(p: string) {
    if (p.endsWith("LANG-FROM-DB.md") || p.endsWith("LANG.md")) {
      const c = await bridge(`CAT ${p.split("/").pop()}`);
      setPreview({ path: p, bytes: (c.stdout || "").length, preview: c.stdout || c.stderr || "пусто" });
      return;
    }
    try {
      const data = await readKitFile({ data: { path: p } });
      setPreview(data);
    } catch {
      setPreview({ path: p, bytes: 0, preview: "не удалось прочитать файл" });
    }
  }

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-medium tracking-tight">L4 · действие</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Журнал записей = спецификация языка. LIVE GAP не становится новым глаголом, пока PORT —
            декартово произведение.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="h-11 rounded-md border border-border px-4 text-sm"
            onClick={() => void loadSpec()}
          >
            SPEC
          </button>
          <button
            type="button"
            className="h-11 rounded-md border border-border px-4 text-sm"
            onClick={() => {
              void (async () => {
                await bridge("SETTLE");
                await refreshBook();
                await loadSpec();
              })();
            }}
          >
            SETTLE
          </button>
          <button
            type="button"
            className="h-11 rounded-md bg-fg px-4 text-sm text-accent-fg"
            onClick={() => {
              void fetchBoth().then(() => nav({ to: "/" }));
            }}
          >
            FETCH → L1
          </button>
        </div>
      </div>

      <section className="mt-6 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="text-xs tracking-wide text-subtle">SPEC · sqlite events</p>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">
            {spec}
          </pre>
        </div>
        <div>
          <p className="text-xs tracking-wide text-subtle">PORT C→A · не MUL</p>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-elevated p-3 font-mono text-xs leading-relaxed text-muted">
            {port || "…"}
          </pre>
        </div>
      </section>

      <div className="mt-6 flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`h-10 rounded-md border px-3 text-xs ${
              kind === k ? "border-fg bg-fg text-accent-fg" : "border-border"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ul className="max-h-[28rem] overflow-auto rounded-lg border border-border">
          {shown.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm hover:bg-elevated"
                onClick={() => void openFile(f.path)}
              >
                <span className="font-mono text-xs">{f.path}</span>
                <span className="shrink-0 text-xs text-subtle">
                  {f.kind} · {f.bytes}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-elevated p-4 font-mono text-xs leading-relaxed text-muted">
          {preview ? `${preview.path} (${preview.bytes} байт)\n\n${preview.preview}` : "Выберите файл."}
        </pre>
      </div>
    </DeskShell>
  );
}

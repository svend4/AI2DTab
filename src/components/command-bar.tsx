import { useState, type FormEvent, type KeyboardEvent } from "react";
import { VERBS } from "@/engine/engine";
import { downloadText, useDesk } from "@/lib/desk";

function tail(text: string): string {
  return text.trim().split("\n").slice(0, 2).join(" · ").slice(0, 160);
}

export function CommandBar() {
  const [line, setLine] = useState("");
  const [hist, setHist] = useState(-1);
  const [help, setHelp] = useState(false);
  const exec = useDesk((s) => s.exec);
  const query = useDesk((s) => s.query);
  const echo = useDesk((s) => s.echo);
  const setLook = useDesk((s) => s.setLook);
  const last = echo[0];

  function run(e: FormEvent) {
    e.preventDefault();
    const t = line.trim();
    if (!t) return;
    setLine("");
    setHist(-1);
    const [cmd, ...rest] = t.replace(/^=/, "").split(/\s+/);
    const C = cmd.toUpperCase();
    if (C === "LOOK") setLook(rest.join(" "));
    if (C === "HELP") {
      setHelp(true);
      return;
    }
    if (C === "DUMP") {
      const out = query("DUMP");
      downloadText("book.tsv", out.text, "text/tab-separated-values");
      return;
    }
    exec(t);
  }

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = e.key === "ArrowUp" ? Math.min(hist + 1, echo.length - 1) : Math.max(hist - 1, -1);
      setHist(n);
      setLine(n < 0 ? "" : echo[n].line);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={run} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor="cmd">команда</label>
        <input
          id="cmd"
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={key}
          placeholder="=FILL  SET NEQ ∩ (RAW ∪ CANON) \ C  WHY id  UNDO  HELP"
          className="h-11 min-w-0 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm outline-none focus:border-border-strong"
          autoComplete="off"
        />
        <div className="flex gap-2">
          <button type="submit" className="h-11 rounded-md bg-fg px-4 text-sm font-medium text-accent-fg">Выполнить</button>
          <button type="button" onClick={() => setHelp((h) => !h)} className="h-11 rounded-md border border-border px-3 text-sm" aria-expanded={help}>
            {help ? "скрыть" : "алфавит"}
          </button>
        </div>
      </form>
      {last ? (
        <p className={`font-mono text-xs ${last.out.ok ? "text-muted" : "text-[color:var(--color-warn)]"}`} aria-live="polite">
          <span className="text-subtle">{last.at} › {last.line.slice(0, 40)}</span> · {tail(last.out.text)}
        </p>
      ) : null}
      {help ? (
        <dl className="grid gap-x-4 gap-y-1 rounded-md border border-border bg-surface p-3 font-mono text-[11px] sm:grid-cols-2">
          {VERBS.map((v) => (
            <div key={v.verb} className="flex gap-2">
              <dt className={`shrink-0 ${v.write ? "text-fg" : "text-muted"}`}>{v.verb}</dt>
              <dd className="text-subtle">{v.doc}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

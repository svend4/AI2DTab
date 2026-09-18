import { useState, type FormEvent } from "react";
import { acceptBoth, bridge, fetchBoth, refreshBook, runBoth, takeBoth } from "@/lib/desk-bridge";
import { downloadText } from "@/lib/machine";
import { useDesk } from "@/lib/desk-store";

function tail(out: { ok: boolean; stdout: string; stderr: string }) {
  const t = (out.stdout || out.stderr).trim().split("\n").slice(0, 2).join(" · ");
  return t || (out.ok ? "db ok" : "db fail");
}

const WRITE =
  /^(PLANT|CUT|ACCEPT|FILL|TAKE|SWEEP|PURGE|SETTLE|GAP|WIRE|REPAIR|FETCH|RUN)\b/i;

export function CommandBar() {
  const [line, setLine] = useState("");
  const [echo, setEcho] = useState("");

  async function run(e: FormEvent) {
    e.preventDefault();
    let t = line.trim();
    if (!t) return;
    if (t.startsWith("=")) {
      t = t
        .slice(1)
        .trim()
        .replace(/^COUNTIF\s*\(?\s*≠\s*\)?/i, "NEQ")
        .replace(/^PIVOT$/i, "MATRIX")
        .replace(/^COUNT\s*\(?\s*RAW\s*\)?/i, "RAW")
        .replace(/^COUNT\s*\(?\s*CANON\s*\)?/i, "CANON");
      if (/[∩∪\\]/.test(t) && !/^(SET|ACCEPT|FILL|TAKE|BATCH)\b/i.test(t)) t = "SET " + t;
    }
    const [cmd, ...rest] = t.split(/\s+/);
    const C = (cmd || "").toUpperCase();
    const arg = rest.join(" ");
    setLine("");

    if (C === "LOOK") {
      useDesk.getState().setLook(arg);
    }
    if (C === "DUMP") {
      const out = await bridge("DUMP");
      downloadText("book.tsv", out.stdout, "text/tab-separated-values");
      setEcho(tail(out));
      return;
    }
    if (C === "ACCEPT" && arg && !/[∩∪\\|&]/.test(arg) && !/^(NEQ|RAW|CANON|SESSION|A|B|C|D|OBS|JUNK)$/i.test(arg)) {
      setEcho(tail(await acceptBoth(arg)));
      await refreshBook();
      return;
    }
    if (C === "TAKE" && arg && !/[∩∪\\|&]/.test(arg) && !/^(NEQ|RAW|CANON|SESSION|A|B|C|D|OBS|JUNK)$/i.test(arg)) {
      setEcho(tail(await takeBoth(arg)));
      await refreshBook();
      return;
    }
    if (C === "RUN") {
      setEcho(tail(await runBoth(arg)));
      await refreshBook();
      return;
    }
    if (C === "FETCH") {
      setEcho(tail(await fetchBoth()));
      await refreshBook();
      return;
    }
    if (C === "PLANT" || C === "CUT") {
      const tape = arg || useDesk.getState().tape;
      setEcho(tail(await bridge("PLANT", tape ? { tape } : undefined)));
      await refreshBook();
      return;
    }
    const out = await bridge(t);
    setEcho(tail(out));
    if (WRITE.test(C)) await refreshBook();
  }

  return (
    <form onSubmit={run} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label className="sr-only" htmlFor="cmd">
        команда
      </label>
      <input
        id="cmd"
        value={line}
        onChange={(e) => setLine(e.target.value)}
        placeholder="=FILL  =DUMP  =NEQ  =SPEC"
        className="h-11 min-w-0 flex-1 rounded-md border border-border bg-elevated px-3 font-mono text-sm outline-none focus:border-border-strong"
        autoComplete="off"
      />
      <button type="submit" className="h-11 rounded-md bg-fg px-4 text-sm font-medium text-accent-fg">
        Выполнить
      </button>
      {echo ? <span className="font-mono text-xs text-muted">{echo}</span> : null}
    </form>
  );
}

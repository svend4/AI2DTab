import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { STAGES, type Stage } from "@/lib/cycle-data";
import { useDesk, type BulkAsk } from "@/lib/desk-store";
import { AccessBar } from "@/components/access-bar";
import { CommandBar } from "@/components/command-bar";
import { refreshBook } from "@/lib/desk-bridge";
import { InstrumentPanel, InstrumentStrip } from "@/components/instruments";
import { cn } from "@/lib/utils";
import { snapshotLabel } from "@/lib/desk-snapshot";

const HREF: Record<Stage, string> = { L1: "/", L2: "/l2", L3: "/l3", L4: "/l4" };

export function DeskNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const canon = useDesk((s) => s.canon);
  const plane = useDesk((s) => s.plane);
  const instr = useDesk((s) => s.instr);
  const notice = useDesk((s) => s.notice);
  const bookCut = useDesk((s) => s.bookCut);
  const snapshot = useDesk((s) => s.snapshot);
  const bulk = useDesk((s) => s.bulk);
  const writeNotice = useDesk((s) => s.writeNotice);
  /** L1 — лента: у неё нет счётчика, книга не хранит строк ленты (AUD-26). */
  const counts: Partial<Record<Stage, number>> = {
    L2: plane.length,
    L3: canon.length,
    L4: canon.length,
  };

  return (
    <header className="border-b border-border bg-bg">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
        <AccessBar />
        {writeNotice ? (
          <DeskAlert text={writeNotice} onHide={() => useDesk.getState().setWriteNotice(null)} />
        ) : null}
        {notice ? (
          <DeskAlert text={notice} onHide={() => useDesk.getState().setNotice(null)} />
        ) : null}
        {bookCut ? <p className="text-xs text-subtle">{bookCut}</p> : null}
        {snapshot ? <p className="text-xs text-subtle">{snapshotLabel(snapshot)}</p> : null}
        {bulk ? <BulkConfirm bulk={bulk} /> : null}
        <InstrumentStrip instr={instr} />
        <InstrumentPanel instr={instr} />
        <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAGES.map((st) => {
            const href = HREF[st.id];
            const on = pathname === href;
            return (
              <Link
                key={st.id}
                to={href}
                className={cn(
                  "flex min-h-11 flex-col rounded-md border px-3 py-2",
                  on ? "border-fg bg-fg text-accent-fg" : "border-border bg-elevated text-fg",
                )}
              >
                <span className="font-mono text-xs">{st.id}</span>
                <span className="text-sm font-medium">{st.name}</span>
                <span className={cn("text-xs", on ? "text-accent-fg/70" : "text-subtle")}>
                  {counts[st.id] === undefined ? st.role : `${counts[st.id]} · ${st.role}`}
                </span>
              </Link>
            );
          })}
        </nav>
        <CommandBar />
      </div>
    </header>
  );
}

/** Уведомление стола: текст причины и кнопка «Скрыть». Для записи и для обновления — два отдельных слота. */
/** Панель подтверждения массовой записи: список id виден до нажатия, ответ уходит в ожидание моста (AUD-15). */
function BulkConfirm({ bulk }: { bulk: BulkAsk }) {
  const answer = (ok: boolean) => {
    useDesk.getState().setBulk(null);
    bulk.done(ok);
  };
  return (
    <section
      aria-labelledby="bulk-title"
      className="flex flex-col gap-2 rounded-md border border-border bg-elevated px-3 py-2"
    >
      <p id="bulk-title" className="text-sm text-fg">
        Записать {bulk.ids.length} объектов? <span className="font-mono text-xs">{bulk.line}</span>
      </p>
      <ul className="max-h-40 overflow-y-auto font-mono text-xs text-muted">
        {bulk.ids.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => answer(true)}
          className="inline-flex min-h-11 items-center rounded-md border border-border bg-fg px-3 text-sm text-accent-fg"
        >
          Подтвердить
        </button>
        <button
          type="button"
          onClick={() => answer(false)}
          className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm text-muted"
        >
          Отмена
        </button>
      </div>
    </section>
  );
}

function DeskAlert({ text, onHide }: { text: string; onHide: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-elevated px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-fg">{text}</p>
      <button
        type="button"
        onClick={onHide}
        className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm text-muted"
      >
        Скрыть
      </button>
    </div>
  );
}

export function DeskShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    void refreshBook();
  }, []);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <DeskNav />
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

import { Link } from "@tanstack/react-router";
import { UserChip } from "@/components/user-chip";
import { useDeskAccess } from "@/lib/use-desk-access";

/**
 * Верхняя полоса: гость видит «режим просмотра» и вход; вошедший без допуска — что он только читает; допущенный — себя и выход.
 * Пока сессия или допуск определяются, место занято заглушкой.
 */
export function AccessBar() {
  const access = useDeskAccess();
  const mode = access.pending
    ? "pending"
    : access.snapshot
      ? "snapshot"
      : access.canWrite
        ? "write"
        : access.signedIn
          ? "denied"
          : "read";
  return (
    <div
      data-access={mode}
      className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      {mode === "pending" ? (
        <span className="h-8 w-56 animate-pulse rounded-md bg-elevated" aria-hidden="true" />
      ) : mode === "write" ? (
        <>
          <span className="text-xs text-subtle">Запись открыта</span>
          <UserChip />
        </>
      ) : mode === "snapshot" ? (
        <>
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted">
            <span className="font-medium text-fg">Только чтение.</span> Стол опубликован как снимок:
            записи здесь нет ни для кого.
          </p>
          {access.signedIn ? <UserChip /> : null}
        </>
      ) : mode === "denied" ? (
        <>
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted">
            <span className="font-medium text-fg">Режим просмотра.</span> Вы вошли, но менять стол
            могут только допущенные аккаунты.
          </p>
          <UserChip />
        </>
      ) : (
        <>
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted">
            <span className="font-medium text-fg">Режим просмотра.</span> Читать стол можно без
            входа, менять — после входа и только допущенным аккаунтам.
          </p>
          <Link
            to="/login"
            className="inline-flex h-11 items-center rounded-md bg-fg px-4 text-sm font-medium text-accent-fg"
          >
            Войти
          </Link>
        </>
      )}
    </div>
  );
}

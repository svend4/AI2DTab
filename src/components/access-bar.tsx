import { Link } from "@tanstack/react-router";
import { UserChip } from "@/components/user-chip";
import { useDeskAccess } from "@/lib/use-desk-access";

/** Верхняя полоса: гость видит «режим просмотра» и вход, вошедший — себя и выход. Пока сессия определяется, место занято заглушкой. */
export function AccessBar() {
  const access = useDeskAccess();
  const mode = access.pending ? "pending" : access.canWrite ? "write" : "read";
  return (
    <div
      data-access={mode}
      className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      {access.pending ? (
        <span className="h-8 w-56 animate-pulse rounded-md bg-elevated" aria-hidden="true" />
      ) : access.canWrite ? (
        <>
          <span className="text-xs text-subtle">Запись открыта</span>
          <UserChip />
        </>
      ) : (
        <>
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted">
            <span className="font-medium text-fg">Режим просмотра.</span> Читать стол можно без
            входа, менять — после входа.
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

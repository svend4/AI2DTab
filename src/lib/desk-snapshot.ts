/**
 * Опубликованный сайт читает снимок стола, а не базу (AUD-03, вариант 3): там нет ни `pm.py`, ни базы. Снимок — книга из
 * `pm.py exec JSON` с датой; его делает `scripts/desk-snapshot.mjs` и кладёт в `src/data/desk-snapshot.json`. Модуль чистый:
 * без серверных зависимостей и без `@/`, поэтому его проверяет `node --test`. Подключает его `pm-exec.server.ts`.
 */

/** Ответ на команду: код выхода и два текста, как у `pm-run.server.ts`. */
type Run = { code: number; stdout: string; stderr: string };

export type Snapshot = Record<string, unknown>;

/** Текст отказа на любую команду, кроме книги. */
export const SNAPSHOT_ONLY_BOOK =
  "в опубликованной версии доступна только книга: остальное требует движка стола";

/** Команда снимка: `exec JSON` отдаёт книгу целиком, всё прочее — отказ. Запись сюда не доходит: `execute` отказывает раньше. */
export function snapshotRun(book: Snapshot, argv: string[]): Run {
  if (argv.length === 2 && argv[0] === "exec" && argv[1] === "JSON") {
    return { code: 0, stdout: `${JSON.stringify(book)}\n`, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: SNAPSHOT_ONLY_BOOK };
}

/** Метка шапки: «Только чтение, снимок от 16.10.2026». Без правильной даты — без неё, а не падение. */
export function snapshotLabel(taken: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(taken);
  return m ? `Только чтение, снимок от ${m[3]}.${m[2]}.${m[1]}` : "Только чтение, снимок";
}

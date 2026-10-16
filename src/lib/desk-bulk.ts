/**
 * Массовые записи (AUD-15): набор, в котором есть сырые объекты или наблюдения, пишется только со списком id, который подтвердил
 * человек. Правило повторяет `pm.py` (`bulk_rows`): признак — строки набора, а не его имя. Здесь: какая строка — запись над набором,
 * разбор ответа `IDS` (id, тип, статус по табуляции) и проверка, затрагивает ли набор сырое или наблюдение. Чистый модуль: без стора
 * и без `@/`, его проверяет `node --test`.
 */
import { isSetExpr } from "./pm-request.ts";

/** Больше этого за один раз не принимаем (как `BULK_MAX` в движке). */
export const BULK_MAX = 500;

export type BulkRow = { id: string; type: string; status: string };

/** Выражение набора, если строка — запись над набором (ACCEPT, TAKE, FILL, PURGE, SWEEP); иначе `null`. */
export function setExprOf(line: string): string | null {
  if (alwaysList(line)) return "REPAIR";
  const m = /^\s*(ACCEPT|TAKE|FILL|PURGE|SWEEP)\b\s*(.*)$/i.exec(line);
  if (!m) return null;
  const verb = m[1].toUpperCase();
  const arg = m[2].trim();
  const expr =
    verb === "FILL"
      ? arg || "NEQ ∩ RAW"
      : verb === "PURGE"
        ? "JUNK"
        : verb === "SWEEP"
          ? arg || "SESSION"
          : arg;
  return expr && isSetExpr(expr) ? expr : null;
}

/** REPAIR возвращает канон в сырые: массовая запись всегда со списком, даже если объект один (решение владельца). */
export function alwaysList(line: string): boolean {
  return /^\s*REPAIR\b/i.test(line);
}

/** Ответ `IDS`: строка на объект — id, тип, статус. */
export function parseRows(stdout: string): BulkRow[] {
  return stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((c) => c[0]?.trim())
    .map(([id, type = "", status = ""]) => ({
      id: id.trim(),
      type: type.trim(),
      status: status.trim(),
    }));
}

/** Затрагивает ли набор сырое или наблюдение: тогда движок требует список id. */
export function touchesBulk(rows: BulkRow[]): boolean {
  return rows.some((r) => r.status === "raw" || r.type === "observation");
}

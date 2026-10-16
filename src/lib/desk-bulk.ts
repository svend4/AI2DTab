/**
 * Массовые записи RAW и OBS (AUD-15): принимать или снимать можно только список id, который подтвердил человек. Здесь правило
 * «какая строка массовая» и разбор ответа `IDS`; оно повторяет `touches_bulk` в engine/pm.py. Чистый модуль: без стора и без `@/`.
 */

/** Имена наборов, которые считаются массовыми (как `BULK_SETS` в движке). */
const BULK_SETS = ["RAW", "OBS", "OBSERVATION"];

/** Больше этого за один раз не принимаем (как `BULK_MAX` в движке). */
export const BULK_MAX = 500;

/** Выражение набора, если строка — массовая запись (ACCEPT, TAKE или FILL над RAW или OBS); иначе `null`. */
export function bulkExpr(line: string): string | null {
  const m = /^\s*(ACCEPT|TAKE|FILL)\b\s*(.*)$/i.exec(line);
  if (!m) return null;
  const expr = m[2].trim() || (m[1].toUpperCase() === "FILL" ? "NEQ ∩ RAW" : "");
  if (!expr) return null;
  const names = expr.split(/[∩∪\\|&\s]+/).map((w) => w.toUpperCase().replace("≠", "NEQ"));
  return names.some((w) => BULK_SETS.includes(w)) ? expr : null;
}

/** Ответ `IDS`: по одному идентификатору в строке. */
export function parseIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

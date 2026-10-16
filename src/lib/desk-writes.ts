/**
 * Исход записи в стол: что сказал `pm.py` и что показать пользователю. Чистый модуль без стора и без `@/`, как `desk-refresh.ts`,
 * поэтому его проверяет `node --test`.
 *
 * Отказ движка не всегда даёт ненулевой код: `REFUSE ...` печатается при выходе 0, а `ACCEPT` над набором печатает в сводке
 * `refuse=N`. Оба случая — отказ, и пользователь должен это увидеть (AUD-11, AUD-13).
 */
import { describeReply } from "./desk-refresh.ts";
import type { PmReply } from "./pm-request.ts";

export type WriteOutcome = { ok: true } | { ok: false; message: string };

/** «объекте» для 1, 21, 31…; «объектах» для остальных (кроме 11, 111…). */
function objects(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "объекте" : "объектах";
}

export function writeOutcome(out: PmReply): WriteOutcome {
  if (!out.ok) return { ok: false, message: `Запись не выполнена: ${describeReply(out)}.` };
  const lines = out.stdout.split("\n").map((l) => l.trim());
  const refused = lines.find((l) => l.startsWith("REFUSE "));
  if (refused) return { ok: false, message: `Стол отказал: ${refused}.` };
  let count = 0;
  for (const line of lines) {
    const m = /\brefuse=(\d+)/.exec(line);
    if (m) count += Number(m[1]);
  }
  if (count > 0) return { ok: false, message: `Стол отказал в ${count} ${objects(count)}.` };
  return { ok: true };
}

/**
 * Исход записи в стол: что сказал `pm.py` и что показать пользователю. Чистый модуль без стора и без `@/`, как `desk-refresh.ts`,
 * поэтому его проверяет `node --test`.
 *
 * Отказ движка не всегда даёт ненулевой код: `REFUSE ...` печатается при выходе 0, а `ACCEPT` над набором печатает в сводке
 * `refuse=N`. Оба случая — отказ, и пользователь должен это увидеть (AUD-11, AUD-13). Пропуски (`skip ... already ...`) —
 * не отказ, но их тоже надо назвать: иначе лента, которая уже в столе, выглядит как удачная посадка (AUD-43).
 */
import { describeReply } from "./desk-refresh.ts";
import type { PmReply } from "./pm-request.ts";

/** Сколько id пропуска называть по имени; остальные — числом. */
const NAMED = 10;

/** Успех несёт пометку, если часть объектов уже была в столе (AUD-43). */
export type WriteOutcome = { ok: true; note?: string } | { ok: false; message: string };

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
  const added = lines.filter((l) => /^plant \S+$/.test(l)).length;
  const skipped = lines.filter((l) => /^skip \S+ already /.test(l)).map((l) => l.split(" ")[1]);
  if (skipped.length === 0) return { ok: true };
  const head = added > 0 ? `Добавлено ${added}. ` : "";
  const more = skipped.length > NAMED ? ` и ещё ${skipped.length - NAMED}` : "";
  const named = skipped.slice(0, NAMED).join(", ");
  return {
    ok: true,
    note: `${head}Пропущено ${skipped.length}, уже были в столе: ${named}${more}.`,
  };
}

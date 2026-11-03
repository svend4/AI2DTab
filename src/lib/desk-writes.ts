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

/** Сводка набора `ACCEPT <набор> → ok=N refuse=N skip=N`: считает весь набор, а строки печатаются только первые восемьдесят. */
const SUMMARY = /\bok=(\d+)\s+refuse=(\d+)\s+skip=(\d+)/;

export function writeOutcome(out: PmReply): WriteOutcome {
  if (!out.ok) return { ok: false, message: `Запись не выполнена: ${describeReply(out)}.` };
  const lines = out.stdout.split("\n").map((l) => l.trim());
  const summary = lines.map((l) => SUMMARY.exec(l)).find(Boolean);
  if (summary && Number(summary[2]) > 0) {
    const refusedCount = Number(summary[2]);
    const accepted = Number(summary[1]);
    const tail = accepted > 0 ? `; принято ${accepted}` : "";
    return {
      ok: false,
      message: `Стол отказал в ${refusedCount} ${objects(refusedCount)}${tail}.`,
    };
  }
  const refused = lines.find((l) => l.startsWith("REFUSE "));
  if (refused) return { ok: false, message: `Стол отказал: ${refused}.` };
  const added = lines.filter((l) => /^plant \S+$/.test(l)).length;
  const skipped = lines.filter((l) => /^skip \S+ already /.test(l)).map((l) => l.split(" ")[1]);
  const total = summary ? Number(summary[3]) : skipped.length;
  if (total === 0) return { ok: true };
  const named = skipped.slice(0, NAMED);
  const rest = total - named.length;
  const head = added > 0 ? `Добавлено ${added}. ` : "";
  const more = rest > 0 ? ` и ещё ${rest}` : "";
  return {
    ok: true,
    note: `${head}Пропущено ${total}, уже были в столе: ${named.join(", ")}${more}.`,
  };
}

/** `FETCH` добавил строку в ленту: движок напечатал `FETCH <id>`. Пропуск уже открытого вопроса печатает `skip FETCH …` (AUD-43). */
export function fetchAdded(out: PmReply): boolean {
  return out.ok && /^FETCH /m.test(out.stdout);
}

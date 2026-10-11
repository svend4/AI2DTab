/**
 * Что видит посетитель в режиме A: читать стол можно всем, менять — вошедшим и допущенным к записи (`desk-writers.ts`).
 *
 * Это подсказка интерфейсу (серые кнопки, надпись); запись всё равно проверяет сервер: `buildPmArgs` в `pm-request.ts` и
 * `authMiddleware` с проверкой допуска у `pmWrite`. Модуль чистый, без React и без входа, чтобы его проверял `node --test`.
 */
import { LOGIN_MESSAGE, NOT_WRITER_MESSAGE } from "./pm-request.ts";
import type { VerbKind } from "./pm-request.ts";

/** `writer`: `true` — допущен, `false` — нет, `null` — сервер ещё не ответил. */
export type SessionView = { user: unknown; isPending: boolean; writer: boolean | null };

export type DeskAccess = {
  /** Вошёл и допущен: кнопки записи доступны. */
  canWrite: boolean;
  /** Вошёл (допущен или нет). */
  signedIn: boolean;
  /** Сессия или допуск ещё определяются: не показываем ни «войти», ни «нет допуска», чтобы не мигало. */
  pending: boolean;
  /** Точно известно, что писать нельзя: гость или вошедший без допуска. */
  readOnly: boolean;
};

export const WRITE_HINT = "Запись — после входа";
export const NOT_WRITER_HINT = "Запись разрешена только допущенным аккаунтам";

export function deskAccess(session: SessionView): DeskAccess {
  const signedIn = session.user !== null && session.user !== undefined;
  const canWrite = signedIn && session.writer === true;
  const pending = signedIn ? session.writer === null : session.isPending;
  return { canWrite, signedIn, pending, readOnly: !pending && !canWrite };
}

/**
 * Что ответит сервер на эту команду, если писать нельзя: отказ гостю или отказ вошедшему без допуска. `null` — отвечать не за что:
 * чтение, допущенный, или ответ ещё не известен (тогда решает сервер, иначе только что вошедшему первая команда отвечала бы отказом);
 * глагола нет в таблице — ответит сервер.
 */
export function deniedMessage(kind: VerbKind | null, access: DeskAccess): string | null {
  if (kind === null || kind === "read" || !access.readOnly) return null;
  return access.signedIn ? NOT_WRITER_MESSAGE : LOGIN_MESSAGE;
}

/** Атрибуты кнопки записи: серая и с подсказкой, пока писать нельзя. */
export function writeProps(access: DeskAccess): { disabled: boolean; title: string | undefined } {
  if (access.canWrite) return { disabled: false, title: undefined };
  if (access.pending) return { disabled: true, title: undefined };
  return { disabled: true, title: access.signedIn ? NOT_WRITER_HINT : WRITE_HINT };
}

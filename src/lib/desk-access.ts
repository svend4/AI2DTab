/**
 * Что видит посетитель в режиме A: читать стол можно всем, менять — после входа.
 *
 * Это подсказка интерфейсу (серые кнопки, надпись «режим просмотра»); запись всё равно проверяет сервер:
 * `buildPmArgs` в `pm-request.ts` и `authMiddleware` у `pmWrite`. Модуль чистый, без React и без входа, чтобы его проверял `node --test`.
 */
import type { VerbKind } from "./pm-request.ts";

export type SessionView = { user: unknown; isPending: boolean };

export type DeskAccess = {
  /** Вход выполнен: кнопки записи доступны. */
  canWrite: boolean;
  /** Сессия ещё определяется: не показываем ни «войти», ни «режим просмотра», чтобы не мигало. */
  pending: boolean;
  /** Точно известно, что посетитель не вошёл. */
  readOnly: boolean;
};

export const WRITE_HINT = "Запись — после входа";

export function deskAccess(session: SessionView): DeskAccess {
  const canWrite = session.user !== null && session.user !== undefined;
  return {
    canWrite,
    pending: session.isPending && !canWrite,
    readOnly: !session.isPending && !canWrite,
  };
}

/**
 * Эта команда гостю не пройдёт: она пишет, а входа нет. Пока сессия определяется, решает сервер (`false`),
 * иначе только что вошедшему первая команда отвечала бы отказом. `null` — глагола нет в таблице, ответит сервер.
 */
export function needsLogin(kind: VerbKind | null, access: DeskAccess): boolean {
  return kind !== null && kind !== "read" && access.readOnly;
}

/** Атрибуты кнопки записи: серая и с подсказкой, пока входа нет. */
export function writeProps(canWrite: boolean): { disabled: boolean; title: string | undefined } {
  return { disabled: !canWrite, title: canWrite ? undefined : WRITE_HINT };
}

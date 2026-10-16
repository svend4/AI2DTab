/**
 * Допущен ли вошедший пользователь к записи (только сервер). Номер пользователя приходит из `authMiddleware` проверенным;
 * адрес и его подтверждённость берутся из его записи в базе входа, а не из запроса. Правила — в `desk-writers.ts`.
 */
import { WRITERS_ENV, isWriter, parseWriters } from "./desk-writers.ts";
import type { WriterIdentity } from "./desk-writers.ts";

export type WriterLookup = (userId: string) => Promise<WriterIdentity | null>;

export type WriterDeps = {
  env?: Record<string, string | undefined>;
  lookup?: WriterLookup;
  warn?: (message: string) => void;
};

/** Запись пользователя в базе входа (Better Auth): та же база, что у сессий, в песочнице PGLite, на деплое Postgres. */
export const lookupInAuthDb: WriterLookup = async (userId) => {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const rows = await sql<{ email: string | null; emailVerified: boolean | null }>`
    select "email", "emailVerified" from "user" where "id" = ${userId}`;
  const row = rows[0];
  return row ? { email: row.email, emailVerified: row.emailVerified === true } : null;
};

let warnedEmpty = false;
let warnedIgnored = false;

/** Для проверок: предупреждения снова считаются первыми. */
export function resetWriterWarnings(): void {
  warnedEmpty = false;
  warnedIgnored = false;
}

export async function isDeskWriter(userId: string, deps: WriterDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const { writers, ignored } = parseWriters(env[WRITERS_ENV]);
  if (ignored && !warnedIgnored) {
    warnedIgnored = true;
    warn(`[desk] ${WRITERS_ENV}: ${ignored} записей не похожи на адрес e-mail и отброшены`);
  }
  if (writers.size === 0) {
    if (!warnedEmpty) {
      warnedEmpty = true;
      warn(`[desk] ${WRITERS_ENV} пуста или не задана: писать не может никто`);
    }
    return false; // база входа не нужна: ответ известен
  }
  const identity = await (deps.lookup ?? lookupInAuthDb)(userId);
  return isWriter(identity, writers);
}

/**
 * Кто может писать в стол. Чистый модуль без процессов, базы и входа: его проверяет `node --test`.
 *
 * Список допущенных лежит в переменной окружения `DESK_WRITERS`: адреса e-mail через запятую, точку с запятой, пробел или
 * перевод строки; регистр не важен. Пишет только тот, у кого в записи пользователя адрес из списка И он подтверждён
 * провайдером входа (`emailVerified`): у X адреса синтетические и не подтверждены, неподтверждённый адрес любого провайдера
 * не годится, иначе чужой адрес можно было бы просто указать при регистрации.
 *
 * Закрыто по умолчанию: пустая или не заданная переменная значит, что писать не может никто. Адреса сравниваются как строки
 * после обрезки пробелов и приведения к нижнему регистру: ни псевдонимов Gmail (точки, `+метка`), ни юникодной нормализации.
 */

export const WRITERS_ENV = "DESK_WRITERS";

export type WriterIdentity = { email: string | null; emailVerified: boolean };

export type ParsedWriters = {
  /** Допущенные адреса в нижнем регистре. */
  writers: Set<string>;
  /** Сколько записей в переменной не похожи на адрес e-mail и отброшены (сами записи не возвращаются, чтобы не попасть в журнал). */
  ignored: number;
};

// eslint-disable-next-line no-control-regex -- управляющие знаки в адресе как раз и отсекаем
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Похоже ли на адрес: одна `@`, что-то до неё и точка где-то после. Полную проверку по RFC делает провайдер входа, не мы. */
function looksLikeEmail(token: string): boolean {
  if (CONTROL.test(token)) return false;
  const at = token.indexOf("@");
  if (at < 1 || at !== token.lastIndexOf("@")) return false;
  const domain = token.slice(at + 1);
  return (
    domain.length >= 3 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".")
  );
}

export function parseWriters(raw: string | null | undefined): ParsedWriters {
  const writers = new Set<string>();
  let ignored = 0;
  for (const part of String(raw ?? "").split(/[\s,;]+/u)) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (looksLikeEmail(token)) writers.add(token);
    else ignored += 1;
  }
  return { writers, ignored };
}

/** Допущен ли пользователь: подтверждённый адрес из списка. Нет записи, нет адреса, адрес не подтверждён — нет. */
export function isWriter(
  identity: WriterIdentity | null | undefined,
  writers: ReadonlySet<string>,
): boolean {
  if (!identity || identity.emailVerified !== true) return false;
  if (typeof identity.email !== "string") return false;
  return writers.has(identity.email.trim().toLowerCase());
}

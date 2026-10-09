/**
 * Хранилище книги в браузере: IndexedDB с откатом на localStorage.
 *
 * Книга — одна JSON-строка. IndexedDB: база "desk-v2", таблица "books",
 * ключ "current". Если IndexedDB недоступна (SSR, приватный режим, ошибка
 * открытия) — localStorage под ключом "desk-v2-book". Если и он недоступен —
 * копия остаётся только в памяти процесса до перезагрузки.
 *
 * Правила модуля:
 *   - ни одна функция не бросает: результат говорит, где сохранено и что сломалось;
 *   - ничего не трогает window/indexedDB на верхнем уровне (безопасно для SSR);
 *   - миграция: при первой загрузке, если в IDB пусто, а в localStorage есть
 *     книга, она читается и переносится в IDB;
 *   - если книга есть в обоих местах, берётся та, где журнал длиннее
 *     (сохранения могли откатываться на localStorage, когда IDB отказывала).
 *
 * Форму книги модуль не проверяет — это делает normalizeBook в desk.ts.
 */
import type { Book } from "@/engine/types";

export const DB_NAME = "desk-v2";
export const STORE_NAME = "books";
export const RECORD_KEY = "current";
export const LOCAL_KEY = "desk-v2-book";

export type StorageWhere = "idb" | "local" | "memory";

export type SaveResult = {
  ok: boolean;
  bytes: number;
  where: StorageWhere;
  error?: string;
  /** navigator.storage.estimate().quota, если браузер умеет. */
  quota?: number;
};

/** Последняя сериализованная книга: страховка, когда ни IDB, ни localStorage не пишутся. */
let memory: string | null = null;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (e && typeof e === "object" && "target" in e) {
    const t = (e as { target?: { error?: { message?: string; name?: string } } }).target;
    return t?.error?.message || t?.error?.name || "ошибка IndexedDB";
  }
  return String(e);
}

// ---------- localStorage ----------

function localStore(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    // доступ к localStorage сам может бросить (запрещённые куки, sandbox-iframe)
    return null;
  }
}

function localGet(): string | null {
  try {
    return localStore()?.getItem(LOCAL_KEY) ?? null;
  } catch {
    return null;
  }
}

function localRemove(): void {
  try {
    localStore()?.removeItem(LOCAL_KEY);
  } catch {
    /* ничего: удаление — только уборка */
  }
}

// ---------- IndexedDB ----------

function idbFactory(): IDBFactory | null {
  try {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return f ?? null;
  } catch {
    return null;
  }
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      const db = req.result;
      // другая вкладка подняла версию — отпускаем базу, следующая операция откроет заново
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("не открылась IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB занята другой вкладкой"));
  });
}

/** Одна операция над таблицей: открыть → транзакция → запрос → закрыть. */
async function idbOp<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const factory = idbFactory();
  if (!factory) throw new Error("IndexedDB недоступна");
  const db = await openDb(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = run(tx.objectStore(STORE_NAME));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => reject(req.error ?? new Error("запрос IndexedDB не выполнился"));
      // ждём завершения транзакции, а не только запроса: запись считается
      // сохранённой лишь после commit
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("транзакция IndexedDB прервана"));
      tx.onabort = () => reject(tx.error ?? new Error("транзакция IndexedDB отменена"));
    });
  } finally {
    db.close();
  }
}

function idbGet(): Promise<string | null> {
  return idbOp<unknown>("readonly", (s) => s.get(RECORD_KEY)).then((v) => (typeof v === "string" ? v : null));
}

function idbPut(json: string): Promise<void> {
  return idbOp("readwrite", (s) => s.put(json, RECORD_KEY)).then(() => undefined);
}

function idbDelete(): Promise<void> {
  return idbOp("readwrite", (s) => s.delete(RECORD_KEY)).then(() => undefined);
}

// ---------- общее ----------

function parseBook(json: string | null): Book | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    // только «это объект»; форму правит normalizeBook у вызывающего
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Book) : null;
  } catch {
    return null;
  }
}

/** Длина журнала — грубая мера «свежести» снимка. */
function journalLength(b: Book | null): number {
  if (!b || !Array.isArray(b.events)) return 0;
  let max = 0;
  for (const e of b.events) if (e && typeof e.seq === "number" && e.seq > max) max = e.seq;
  return max || b.events.length;
}

function byteLength(s: string): number {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  } catch {
    /* падаем на грубую оценку */
  }
  return s.length;
}

async function estimateQuota(): Promise<number | undefined> {
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const est = await nav?.storage?.estimate?.();
    return typeof est?.quota === "number" ? est.quota : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Прочитать книгу. Порядок: IndexedDB → localStorage (с переносом в IDB) → память.
 * Возвращает разобранный JSON без проверки формы, либо null.
 */
export async function loadBook(): Promise<Book | null> {
  let fromIdb: Book | null = null;
  let idbWorks = false;
  if (idbFactory()) {
    try {
      fromIdb = parseBook(await idbGet());
      idbWorks = true;
    } catch {
      /* IDB отказала — живём на localStorage */
    }
  }
  const legacyJson = localGet();
  const fromLocal = parseBook(legacyJson);

  if (fromIdb && (!fromLocal || journalLength(fromIdb) >= journalLength(fromLocal))) return fromIdb;

  if (fromLocal) {
    if (idbWorks && legacyJson) {
      // миграция: переносим в IDB и освобождаем localStorage, чтобы копии не расходились
      try {
        await idbPut(legacyJson);
        localRemove();
      } catch {
        /* останется в localStorage до следующей попытки */
      }
    }
    return fromLocal;
  }

  return parseBook(memory);
}

/**
 * Сохранить книгу. Пробует IndexedDB, затем localStorage; копию всегда
 * оставляет в памяти. Никогда не бросает.
 */
export async function saveBook(book: Book): Promise<SaveResult> {
  let json: string;
  try {
    json = JSON.stringify(book);
  } catch (e) {
    return { ok: false, bytes: 0, where: "memory", error: `книга не сериализуется: ${errText(e)}` };
  }
  memory = json;
  const bytes = byteLength(json);
  const quota = await estimateQuota();
  const errors: string[] = [];

  if (idbFactory()) {
    try {
      await idbPut(json);
      return { ok: true, bytes, where: "idb", quota };
    } catch (e) {
      errors.push(`IndexedDB: ${errText(e)}`);
    }
  } else errors.push("IndexedDB недоступна");

  const ls = localStore();
  if (ls) {
    try {
      ls.setItem(LOCAL_KEY, json);
      return { ok: true, bytes, where: "local", quota };
    } catch (e) {
      errors.push(`localStorage: ${errText(e)}`);
    }
  } else errors.push("localStorage недоступен");

  return { ok: false, bytes, where: "memory", quota, error: `не сохранено (${errors.join("; ")}) — книга живёт до перезагрузки` };
}

/** Стереть сохранённую книгу везде. Никогда не бросает. */
export async function clearBook(): Promise<void> {
  memory = null;
  localRemove();
  if (idbFactory()) {
    try {
      await idbDelete();
    } catch {
      /* нечего стирать или IDB недоступна */
    }
  }
}

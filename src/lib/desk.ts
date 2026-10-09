/**
 * Стол в браузере: один экземпляр движка + zustand-снимок для React.
 *
 * Книга живёт в IndexedDB с откатом на localStorage (см. storage.ts); auth/db
 * OFF по §0.5 AGENTS.md: одиночный стол, без аккаунтов. Экспорт/импорт JSON —
 * переносимость между столами и агентами.
 *
 * Порядок на любой записи: движок → normalizeBook (при загрузке/импорте) →
 * refresh() → saveBook. Книга, которую refresh() не смог отрисовать, в
 * хранилище не попадает. Сбой сохранения не валит стол: текст ошибки лежит в
 * `saved.error`, UI показывает предупреждение.
 */
import { create } from "zustand";
import seed from "@/data/seed.json";
import { bookFromSeed, Desk } from "@/engine/engine";
import type { Book, Event, ExecResult, Link, Obj, Readout } from "@/engine/types";
import { normalizeBook } from "@/engine/validate";
import { loadBook, saveBook, type SaveResult, type StorageWhere } from "@/lib/storage";

/** Лента (L1) хранится отдельно от книги: это черновик, не запись. */
const TAPE_KEY = "desk-v2-book-tape";
const TAPE_DEBOUNCE_MS = 300;

export type EchoLine = { at: string; line: string; out: ExecResult };

export type Actor = "human" | "machine";

export type SavedInfo = { where: StorageWhere; bytes: number; error?: string };

export type ImportMode = "replace" | "merge";

type DeskState = {
  /** Книга прочитана из хранилища; до этого UI данных не рисует. */
  ready: boolean;
  tape: string;
  look: string;
  cluster: string;
  objects: Obj[];
  links: Link[];
  events: Event[];
  instr: Readout | null;
  echo: EchoLine[];
  /** Результат последнего сохранения книги; null — в этой сессии ещё не писали. */
  saved: SavedInfo | null;
  /** Кто ходит: зеркало `Desk.actor` после каждого хода. */
  actor: Actor;
  /** Предупреждения normalizeBook после загрузки или импорта. */
  importWarnings: string[];
  setTape: (t: string) => void;
  setLook: (q: string) => void;
  setCluster: (c: string) => void;
  /** Ход с записью в эхо; при записи книга сохраняется в фоне (см. `saved`). */
  exec: (line: string) => ExecResult;
  /** Чтение без записи и без эха: для вычислений в рендере (NEXT, SPEC, WHY). */
  query: (line: string) => ExecResult;
  refresh: () => void;
  boot: () => Promise<void>;
  reset: (withSeed: boolean) => void;
  importBook: (json: string, mode?: ImportMode) => Promise<string>;
  exportBook: () => string;
};

let desk: Desk | null = null;
let booting: Promise<void> | null = null;

function seedBook(): Book {
  return bookFromSeed(seed as any);
}

/**
 * Экземпляр движка. До boot() — стол из семени (чтение не ломается); boot()
 * заменяет его прочитанной книгой.
 */
export function getDesk(): Desk {
  if (!desk) desk = new Desk(seedBook());
  return desk;
}

/** Движок получает поле `actor`; пока его нет в типах — читаем мягко. */
function actorOf(d: Desk): Actor {
  const a = (d as unknown as { actor?: unknown }).actor;
  return a === "machine" ? "machine" : "human";
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

export const WHERE_LABEL: Record<StorageWhere, string> = {
  idb: "IndexedDB",
  local: "localStorage",
  memory: "только память",
};

// ---------- сохранение книги ----------

/** Сохранения идут строго по очереди: позднее никогда не обгоняет раннее. */
let saveChain: Promise<unknown> = Promise.resolve();

/**
 * Сохранить книгу в фоне и отразить результат в `saved`. Вызывать только
 * после refresh(): то, что не отрисовалось, не должно и сохраниться.
 */
function persist(book: Book): Promise<SaveResult> {
  const run = saveChain.then(
    () => saveBook(book),
    () => saveBook(book),
  );
  const done = run.then(
    (r) => {
      const saved: SavedInfo = { where: r.where, bytes: r.bytes };
      if (r.error) saved.error = r.error;
      useDesk.setState({ saved });
      return r;
    },
    (e): SaveResult => {
      // saveBook не бросает, но страхуемся: сбой сохранения — не сбой стола
      const error = e instanceof Error ? e.message : String(e);
      useDesk.setState({ saved: { where: "memory", bytes: 0, error } });
      return { ok: false, bytes: 0, where: "memory", error };
    },
  );
  saveChain = done;
  return done;
}

function readTape(): string {
  try {
    return globalThis.localStorage?.getItem(TAPE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Заголовок вопроса, который FETCH только что посадил (чтобы дописать его в ленту). */
function fetchedTitle(d: Desk, out: ExecResult): string | null {
  const id = typeof out.data === "string" ? out.data : out.text.match(/^FETCH\s+(\S+)/)?.[1];
  const title = id ? d.get(id)?.title : undefined;
  return title ? title : null;
}

export const useDesk = create<DeskState>()((set, get) => ({
  ready: false,
  tape: "",
  look: "",
  cluster: "",
  objects: [],
  links: [],
  events: [],
  instr: null,
  echo: [],
  saved: null,
  actor: "human",
  importWarnings: [],
  setTape: (tape) => set({ tape }),
  setLook: (look) => set({ look }),
  setCluster: (cluster) => set({ cluster }),
  refresh: () => {
    const d = getDesk();
    set({ objects: [...d.book.objects], links: [...d.book.links], events: [...d.book.events], instr: d.readout(), actor: actorOf(d) });
  },
  boot: () => {
    if (get().ready) return Promise.resolve();
    if (booting) return booting;
    booting = (async () => {
      const tape = readTape();
      const warnings: string[] = [];
      let book: Book | null = null;
      try {
        const loaded = await loadBook();
        if (loaded) {
          const n = normalizeBook(loaded);
          warnings.push(...n.warnings);
          // снимок оказался не книгой (мусор в хранилище) — начинаем с семени
          book = n.book.objects.length === 0 && n.warnings.length ? null : n.book;
          if (!book) warnings.push("сохранённая книга не прочиталась — стол начат с семени");
        }
      } catch (e) {
        warnings.push(`книга не загрузилась: ${e instanceof Error ? e.message : String(e)}`);
      }
      desk = new Desk(book ?? seedBook());
      set({ ready: true, tape, importWarnings: warnings });
      get().refresh();
    })().finally(() => {
      booting = null;
    });
    return booting;
  },
  query: (line) => getDesk().exec(line),
  exec: (line) => {
    const d = getDesk();
    const out = d.exec(line);
    const patch: Partial<DeskState> = { echo: [{ at: stamp(), line, out }, ...get().echo].slice(0, 40) };
    if (out.ok && out.verb === "FETCH") {
      // петля L4 → L1: посаженный вопрос попадает и в ленту
      const title = fetchedTitle(d, out);
      if (title) {
        const tape = get().tape;
        patch.tape = tape ? `${tape}\n\nFETCH: ${title}` : `FETCH: ${title}`;
      }
    }
    set(patch);
    get().refresh();
    if (out.wrote) void persist(d.book);
    return out;
  },
  reset: (withSeed) => {
    desk = new Desk(withSeed ? seedBook() : undefined);
    set({ echo: [], look: "", cluster: "", importWarnings: [] });
    get().refresh();
    void persist(desk.book);
  },
  importBook: async (json, mode = "replace") => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return `не JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
    const n = normalizeBook(parsed);
    if (n.book.objects.length === 0 && n.warnings.length) {
      set({ importWarnings: n.warnings });
      return `импорт отклонён: ${n.warnings[0]}`;
    }

    let msg: string;
    let echoLine: string;
    if (mode === "merge") {
      const d = getDesk();
      const before = { objects: d.book.objects.length, links: d.book.links.length };
      const out = d.exec(`MERGE ${JSON.stringify(n.book)}`);
      echoLine = `MERGE <импорт: ${n.book.objects.length} объектов, ${n.book.links.length} рёбер>`;
      if (!out.ok) {
        set({ importWarnings: n.warnings, echo: [{ at: stamp(), line: echoLine, out }, ...get().echo].slice(0, 40) });
        if (/^unknown\s+MERGE/i.test(out.text)) return `слияние недоступно: движок ещё не знает глагол MERGE (${out.text.split("\n")[0]})`;
        return `слияние не удалось: ${out.text.split("\n")[0]}`;
      }
      const added = d.book.objects.length - before.objects;
      const linksAdded = d.book.links.length - before.links;
      msg = `слияние: +${added} объектов, +${linksAdded} рёбер → всего ${d.book.objects.length} объектов, ${d.book.links.length} рёбер`;
      const first = out.text.split("\n")[0];
      if (first && !msg.includes(first)) msg += ` · ${first}`;
      set({ echo: [{ at: stamp(), line: echoLine, out }, ...get().echo].slice(0, 40) });
    } else {
      desk = new Desk(n.book);
      msg = `импорт: ${n.book.objects.length} объектов, ${n.book.links.length} рёбер, ${n.book.events.length} событий`;
      set({ echo: [], look: "", cluster: "" });
    }
    set({ importWarnings: n.warnings });
    get().refresh();

    const r = await persist(getDesk().book);
    msg += r.ok ? ` · сохранено: ${formatBytes(r.bytes)} · ${WHERE_LABEL[r.where]}` : ` · не сохранено: ${r.error ?? "неизвестная ошибка"}`;
    if (n.warnings.length) msg += ` · предупреждений: ${n.warnings.length}`;
    return msg;
  },
  exportBook: () => JSON.stringify(getDesk().book, null, 1),
}));

// ---------- лента: localStorage с задержкой, не на каждое нажатие ----------

let tapeTimer: ReturnType<typeof setTimeout> | null = null;

function flushTape(): void {
  if (tapeTimer) {
    clearTimeout(tapeTimer);
    tapeTimer = null;
  }
  try {
    globalThis.localStorage?.setItem(TAPE_KEY, useDesk.getState().tape);
  } catch {
    /* квота или приватный режим: лента живёт до перезагрузки */
  }
}

useDesk.subscribe((s, prev) => {
  if (s.tape === prev.tape) return;
  if (tapeTimer) clearTimeout(tapeTimer);
  tapeTimer = setTimeout(flushTape, TAPE_DEBOUNCE_MS);
});

if (typeof window !== "undefined") {
  // уход со страницы раньше таймера — дописываем ленту сразу
  window.addEventListener("pagehide", flushTape);
}

// ---------- утилиты для UI ----------

export function downloadText(name: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function cellOf(o: Obj): string {
  return o.pred && o.rel ? `${o.pred} ${o.rel} ${o.obj}` : "";
}

/**
 * Стол в браузере: один экземпляр движка + zustand-снимок для React.
 *
 * Книга живёт в localStorage (auth/db OFF по §0.5 AGENTS.md: одиночный стол,
 * без аккаунтов). Экспорт/импорт JSON — переносимость между столами и агентами.
 */
import { create } from "zustand";
import seed from "@/data/seed.json";
import { bookFromSeed, Desk } from "@/engine/engine";
import type { Book, Event, ExecResult, Link, Obj, Readout } from "@/engine/types";

const KEY = "desk-v2-book";

export type EchoLine = { at: string; line: string; out: ExecResult };

type DeskState = {
  ready: boolean;
  tape: string;
  look: string;
  cluster: string;
  objects: Obj[];
  links: Link[];
  events: Event[];
  instr: Readout | null;
  echo: EchoLine[];
  setTape: (t: string) => void;
  setLook: (q: string) => void;
  setCluster: (c: string) => void;
  exec: (line: string) => ExecResult;
  /** Чтение без записи и без эха: для вычислений в рендере (NEXT, SPEC, WHY). */
  query: (line: string) => ExecResult;
  refresh: () => void;
  boot: () => void;
  reset: (withSeed: boolean) => void;
  importBook: (json: string) => string;
  exportBook: () => string;
};

let desk: Desk | null = null;

function load(): Book | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Book;
    if (b && b.version === 2 && Array.isArray(b.objects)) return b;
  } catch {
    /* повреждённый снимок — начнём с семени */
  }
  return null;
}

function save(book: Book): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(book));
  } catch {
    /* квота или приватный режим: стол живёт до перезагрузки */
  }
}

export function getDesk(): Desk {
  if (!desk) desk = new Desk(load() ?? bookFromSeed(seed as any));
  return desk;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
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
  setTape: (tape) => set({ tape }),
  setLook: (look) => set({ look }),
  setCluster: (cluster) => set({ cluster }),
  refresh: () => {
    const d = getDesk();
    set({ objects: [...d.book.objects], links: [...d.book.links], events: [...d.book.events], instr: d.readout() });
  },
  boot: () => {
    if (get().ready) return;
    let tape = "";
    try {
      tape = globalThis.localStorage?.getItem(`${KEY}-tape`) ?? "";
    } catch {
      /* ignore */
    }
    set({ ready: true, tape });
    get().refresh();
  },
  query: (line) => getDesk().exec(line),
  exec: (line) => {
    const d = getDesk();
    const out = d.exec(line);
    if (out.wrote) save(d.book);
    set({ echo: [{ at: stamp(), line, out }, ...get().echo].slice(0, 40) });
    get().refresh();
    return out;
  },
  reset: (withSeed) => {
    desk = new Desk(withSeed ? bookFromSeed(seed as any) : undefined);
    save(desk.book);
    set({ echo: [], look: "", cluster: "" });
    get().refresh();
  },
  importBook: (json) => {
    try {
      const b = JSON.parse(json);
      if (b?.version === 2 && Array.isArray(b.objects)) {
        desk = new Desk(b as Book);
      } else if (Array.isArray(b?.objects) && Array.isArray(b?.links)) {
        desk = new Desk(bookFromSeed(b));
      } else {
        return "не книга: ожидаю {version:2, objects, links, events}";
      }
      save(desk.book);
      get().refresh();
      return `импорт: ${desk.book.objects.length} объектов, ${desk.book.links.length} рёбер`;
    } catch (e) {
      return e instanceof Error ? e.message : "bad json";
    }
  },
  exportBook: () => JSON.stringify(getDesk().book, null, 1),
}));

useDesk.subscribe((s, prev) => {
  if (s.tape !== prev.tape) {
    try {
      globalThis.localStorage?.setItem(`${KEY}-tape`, s.tape);
    } catch {
      /* ignore */
    }
  }
});

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

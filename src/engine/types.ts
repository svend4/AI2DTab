/**
 * Стол v2 — типы книги.
 *
 * Книга (Book) = объекты + рёбра + происхождение + журнал. Всё — простые
 * JSON-структуры: движок одинаково работает в браузере, в Node и в тестах.
 */

export type Cluster = "A" | "B" | "C" | "D";

export type Status =
  | "raw" // посажено, ещё не канон
  | "canon" // принято человеком
  | "rejected" // вычтено
  | "open"
  | "closed"
  | "draft"
  | "candidate"
  | "dormant";

export type ObjType =
  | "observation"
  | "question"
  | "fact"
  | "decision"
  | "task"
  | "artifact"
  | "session"
  | "tape"
  | "signal"
  | "signpost"
  | "packet"
  | string;

/** Отношение в заголовке ячейки. `≠` — исходная грамматика v1; остальные — v2. */
export type Rel = "≠" | "→" | "⊂" | "=" | "vs";

export type Obj = {
  id: string;
  cluster: Cluster;
  layer: 1 | 2;
  type: ObjType;
  title: string;
  status: Status;
  body: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
  /** Разобранная ячейка: pred rel obj. Пусто, если заголовок — не ячейка. */
  pred?: string;
  rel?: Rel;
  obj?: string;
  /** Хеш содержимого при посадке: один и тот же абзац → один и тот же id. */
  hash?: string;
};

export type Link = { from: string; to: string; rel: string; note?: string };

export type Origin = { objectId: string; sessionId: string; span?: string };

export type Event = {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  objectId?: string;
  detail?: string;
  /** Снимок полей до/после — ради UNDO и аудита. */
  before?: Partial<Obj> | null;
  after?: Partial<Obj> | null;
  link?: Link;
};

export type Book = {
  version: 2;
  objects: Obj[];
  links: Link[];
  origins: Origin[];
  events: Event[];
};

export type Hops = Record<Cluster, Record<Cluster, number>>;

export type Readout = {
  charge: number;
  raw: number;
  canon: number;
  neq: number;
  cells: number;
  packets: number;
  objects: number;
  cshare: number;
  junk: number;
  sparse: number;
  orphans: number;
  openQuestions: number;
  cluster: Record<string, number>;
  hops: Hops;
  warns: string[];
  notes: string[];
};

export type ExecResult = {
  ok: boolean;
  verb: string;
  text: string;
  data?: unknown;
  /** Изменил ли ход книгу (для UI: перечитать). */
  wrote: boolean;
};

export const CLUSTERS: Cluster[] = ["A", "B", "C", "D"];

export const NO_CANON: ReadonlySet<string> = new Set(["session", "tape"]);

export function emptyBook(): Book {
  return { version: 2, objects: [], links: [], origins: [], events: [] };
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

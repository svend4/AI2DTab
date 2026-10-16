/**
 * Что делать с ответом на книгу стола (`JSON`) и с сообщением для пользователя. Чистый модуль: без zustand, без `@/` и без
 * серверных модулей, поэтому его проверяет `node --test`. `desk-bridge.ts` подставляет настоящий стор через `BookSink`.
 *
 * Правила (AUD-14, AUD-23): ответ с ошибкой, без книги, с обрезанным JSON или с испорченным срезом не трогает стол: показанное
 * остаётся, а пользователь видит, почему обновления не было. Пустая, но правильная книга — это книга, а не сбой. Ответ
 * отстающего запроса не применяется: важен только последний.
 */
import { BAD_ACTOR_MESSAGE, LOGIN_MESSAGE, NOT_WRITER_MESSAGE } from "./pm-request.ts";
import type { PmReply } from "./pm-request.ts";
import type { Row, Wire } from "./desk-store.ts";

/** Куда попадает разобранная книга. `desk-bridge.ts` передаёт сеттеры стора; тесты — запоминающие функции. */
export type BookSink = {
  setPlane: (rows: Row[]) => void;
  setCanon: (rows: Row[]) => void;
  setInstr: (instr: unknown) => void;
  setWires: (wires: Wire[]) => void;
  setNotice: (notice: string | null) => void;
  /** Пометка «ответ обрезан»: тихая строка в шапке, не уведомление (O8). */
  setCut: (cut: string | null) => void;
};

export type Book = { ok: true; raw: Row[]; canon: Row[]; wires: Wire[]; instr: unknown };
/** Обрезка — отдельный случай: книгу не разобрать, поэтому называем размер, а не причину (O8). */
export type BookFailure = { ok: false; reason: string; cut?: { dropped: number; total: number } };
export type BookReply = Book | BookFailure;

const CODE_TEXT: Partial<Record<NonNullable<PmReply["code"]>, string>> = {
  login_required: LOGIN_MESSAGE,
  not_writer: NOT_WRITER_MESSAGE,
  bad_actor: BAD_ACTOR_MESSAGE,
  engine_unavailable: "движок недоступен",
  bridge: "сервер не ответил, попробуйте ещё раз",
};

/**
 * Текст для пользователя по ответу моста. Известные коды дают готовые русские фразы; прочий отказ движка — первая строка
 * его ошибки. Сырой текст сетевой ошибки сюда не попадает: для неё есть код `bridge` и своя фраза.
 */
export function describeReply(out: PmReply): string {
  const known = out.code ? CODE_TEXT[out.code] : undefined;
  if (known) return known;
  const first = out.stderr
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return first ?? "стол не ответил";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Строка стола из записи `pm.py`: те же значения по умолчанию, что были у прежнего разбора. */
function toRow(r: Record<string, string>, status: Row["status"]): Row {
  return {
    id: r.id,
    cluster: r.cluster || "C",
    layer: String(r.layer || "2"),
    type: r.type || "observation",
    title: r.title || r.id,
    body: r.body || "",
    source: "sqlite",
    status,
    pred: r.pred || undefined,
    rel: r.rel || undefined,
    obj: r.obj || undefined,
  };
}

/** Разбор ответа `JSON`. Ошибка — если ответ не успешный, в нём нет строки книги, JSON не читается или срез испорчен. */
export function parseBook(out: PmReply): BookReply {
  if (out.cut) return { ok: false, reason: "ответ обрезан", cut: out.cut };
  if (!out.ok) return { ok: false, reason: describeReply(out) };
  const line = out.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return { ok: false, reason: "ответ стола без книги" };
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, reason: "книга не читается, ответ, вероятно, обрезан" };
  }
  if (!isRecord(data)) return { ok: false, reason: "в ответе нет объекта книги" };
  for (const key of ["raw", "canon", "wires"] as const) {
    if (!Array.isArray(data[key])) return { ok: false, reason: `в книге нет списка «${key}»` };
  }
  if (!isRecord(data.instr)) return { ok: false, reason: "в книге нет раздела instr" };
  const rowsOk = (list: unknown[]) => list.every((r) => isRecord(r) && typeof r.id === "string");
  if (!rowsOk(data.raw as unknown[]) || !rowsOk(data.canon as unknown[])) {
    return { ok: false, reason: "в книге испорчена строка" };
  }
  return {
    ok: true,
    raw: (data.raw as Record<string, string>[]).map((r) => toRow(r, "raw")),
    canon: (data.canon as Record<string, string>[]).map((r) => toRow(r, "accepted")),
    wires: data.wires as Wire[],
    instr: data.instr,
  };
}

/** Применяет разобранный ответ: при сбое срезы не трогаются, пользователю пишется причина; при успехе уведомление снимается. */
export function applyBookReply(parsed: BookReply, sink: BookSink): boolean {
  if (!parsed.ok && parsed.cut) {
    const { dropped, total } = parsed.cut;
    sink.setNotice(null);
    sink.setCut(
      `Ответ стола обрезан: обрезано ${dropped} из ${total} байт. Показано прежнее состояние.`,
    );
    return false;
  }
  if (!parsed.ok) {
    sink.setCut(null);
    sink.setNotice(`Стол не обновился: ${parsed.reason}. Показано прежнее состояние.`);
    return false;
  }
  sink.setPlane(parsed.raw);
  sink.setCanon(parsed.canon);
  sink.setInstr(parsed.instr);
  sink.setWires(parsed.wires);
  sink.setCut(null);
  sink.setNotice(null);
  return true;
}

/** Номера запросов: отвечает на вопрос, актуален ли ответ, — только последний запрос актуален (AUD-23). */
export function createSequencer() {
  let latest = 0;
  return {
    next: (): number => (latest += 1),
    isLatest: (token: number): boolean => token === latest,
  };
}

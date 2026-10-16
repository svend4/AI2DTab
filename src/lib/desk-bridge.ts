import type { Instr } from "@/components/instruments";
import { dumpTsv } from "@/lib/machine";
import { pmRead, pmWrite } from "@/lib/pm-api";
import { LOGIN_MESSAGE, parsePmLine, type PmReply } from "@/lib/pm-request";
import { useDesk, type Row } from "@/lib/desk-store";
import { applyBookReply, createSequencer, parseBook, type BookSink } from "@/lib/desk-refresh";
import { writeOutcome } from "@/lib/desk-writes";

export type BridgeOut = PmReply;

/** Серверная ошибка в виде ответа моста. «Unauthorized» — вход не выполнен: пишущий вызов не дошёл до стола. */
function failure(e: unknown): BridgeOut {
  const message = e instanceof Error ? e.message : "сервер не ответил";
  if (message === "Unauthorized") {
    return { ok: false, stdout: "", stderr: LOGIN_MESSAGE, code: "login_required" };
  }
  return { ok: false, stdout: "", stderr: message, code: "bridge" };
}

/**
 * Команда столу. Чтение идёт открытым вызовом, остальное — вызовом с входом; сервер проверяет строку ещё раз и сам,
 * поэтому выбор вызова здесь ничего не открывает. Ленту PLANT передаёт `extra.tape`; пути к файлу у моста нет.
 */
export async function bridge(line: string, extra?: { tape?: string }): Promise<BridgeOut> {
  const parsed = parsePmLine({ line, tape: extra?.tape });
  if (!parsed.ok) return { ok: false, stdout: "", stderr: parsed.message, code: parsed.code };
  const call = parsed.kind === "read" ? pmRead : pmWrite;
  try {
    return await call({ data: { line, tape: extra?.tape } });
  } catch (e) {
    return failure(e);
  }
}

/** Номера запросов книги: ответ отстающего запроса не применяется (AUD-23). */
const bookSequence = createSequencer();

function bookSink(): BookSink {
  const s = useDesk.getState();
  return {
    setPlane: s.setPlane,
    setCanon: s.setCanon,
    setInstr: (instr) => s.setInstr(instr as Instr | null),
    setWires: s.setWires,
    setNotice: s.setNotice,
    setCut: s.setBookCut,
    setSnapshot: s.setSnapshot,
  };
}

/**
 * Обновляет книгу стола одним вызовом `JSON`. Сбой или испорченный ответ не трогает стол: пользователь видит причину в
 * уведомлении (AUD-14, AUD-11). Запасного пути из четырёх вызовов нет: при сбое он повторил бы тот же отказ четыре раза.
 */
export async function refreshBook(): Promise<void> {
  const token = bookSequence.next();
  const out = await bridge("JSON");
  if (!bookSequence.isLatest(token)) return;
  applyBookReply(parseBook(out), bookSink());
}

/**
 * Запись в стол: одна точка для кнопок и строки команд. Исход записи, в том числе отказ при коде 0, попадает в уведомление
 * записи и не стирается обновлением книги (AUD-11, AUD-13). Книга обновляется после каждой записи.
 */
export async function writeDesk(line: string, extra?: { tape?: string }): Promise<BridgeOut> {
  const out = await bridge(line, extra);
  const outcome = writeOutcome(out);
  useDesk.getState().setWriteNotice(outcome.ok ? (outcome.note ?? null) : outcome.message);
  await refreshBook();
  return out;
}

export async function plantToDb(rows: Row[]): Promise<BridgeOut> {
  if (!rows.length) return { ok: true, stdout: "", stderr: "" };
  return writeDesk("PLANT", { tape: dumpTsv(rows) });
}

/** Оптимистичных изменений нет: строка меняется, когда стол ответил (AUD-13). */
export async function acceptBoth(id: string): Promise<BridgeOut> {
  return writeDesk(`ACCEPT ${id}`);
}

export async function takeBoth(id: string): Promise<BridgeOut> {
  return writeDesk(`TAKE ${id}`);
}

export async function runBoth(id: string): Promise<BridgeOut> {
  return writeDesk(`RUN ${id}`);
}

/** Строку вопроса в ленту добавляем только после ответа стола, что FETCH записал вопрос (AUD-31). */
export async function fetchBoth(): Promise<BridgeOut> {
  const out = await writeDesk("FETCH");
  if (writeOutcome(out).ok) useDesk.getState().fetchNew();
  return out;
}

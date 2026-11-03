/**
 * Что делает сервер с командой стола: проверить (`pm-request.ts`), убедиться, что движок на месте, выполнить (`pm-run.server.ts`).
 * Вынесено из `pm-api.ts` без фреймворка, чтобы это проверял `node --test` с подставным движком. Там, где `pm.py` нет (опубликованный
 * сайт), стол читается снимком, а запись закрыта (AUD-03, вариант 3).
 */
import { snapshotRun } from "./desk-snapshot.ts";
import { actorArgs, buildPmArgs, READ_ONLY_MESSAGE } from "./pm-request.ts";
import type { PmInput, PmReply, PmUser } from "./pm-request.ts";
import { engineInstalled, engineReady, runPm } from "./pm-run.server.ts";
import type { PmRun } from "./pm-run.server.ts";

export type Engine = {
  ready: () => boolean;
  run: (argv: string[], tape?: string) => Promise<PmRun>;
  /** `false` — только чтение (снимок). Не задано — запись разрешена. */
  writable?: boolean;
};

export const realEngine: Engine = { ready: engineReady, run: (argv, tape) => runPm(argv, tape) };

/** Опубликованный сайт: книга из снимка `src/data/desk-snapshot.json`, записи нет (AUD-03, вариант 3). */
export const snapshotEngine: Engine = {
  ready: () => true,
  writable: false,
  run: async (argv) => {
    const { default: book } = await import("@/data/desk-snapshot.json");
    return snapshotRun(book, argv);
  },
};

/** Где стол: при наличии `pm.py` — живой движок, иначе — снимок. */
export function currentEngine(): Engine {
  return engineInstalled() ? realEngine : snapshotEngine;
}

/** Класс команды не зависит от пользователя, поэтому его берём у допущенного: отказ разбора у всех одинаков. */
const WRITER_PROBE = { id: "probe", writer: true };

/**
 * `user === null` — гость, `user.writer === false` — вошедший без допуска: им доступно только чтение, и базу они не создают.
 * Допущенному первая команда создаёт базу, если её нет (как делал прежний `pmExec`).
 */
export async function execute(
  input: PmInput,
  user: PmUser,
  engine: Engine = currentEngine(),
): Promise<PmReply> {
  // Снимок только читается: запись отказывает раньше проверки допуска и не будит движок (AUD-03, вариант 3).
  const probe = buildPmArgs(input, WRITER_PROBE);
  if (probe.ok && probe.kind !== "read" && engine.writable === false) {
    return { ok: false, stdout: "", stderr: READ_ONLY_MESSAGE, code: "read_only" };
  }
  const decision = buildPmArgs(input, user);
  if (!decision.ok) {
    return { ok: false, stdout: "", stderr: decision.message, code: decision.code };
  }
  // Запись идёт от имени вошедшего (AUD-15): флаг сразу после `exec`, а номер берётся только из проверенного `user`.
  // Проверка номера — до движка, чтобы испорченный номер не создал базу на пустом столе.
  const actor = decision.kind !== "read" && user?.writer === true ? actorArgs(user.id) : [];
  if (!Array.isArray(actor)) {
    return { ok: false, stdout: "", stderr: actor.message, code: actor.code };
  }
  // Список подтверждения массовой записи (AUD-15) — флагом перед глаголом, как актор; для чтения не нужен.
  const confirm = decision.kind !== "read" && input.ids ? ["--ids", input.ids.join(",")] : [];
  const argv = [decision.argv[0], ...actor, ...confirm, ...decision.argv.slice(1)];
  if (!engine.ready()) {
    if (!user?.writer) {
      return {
        ok: false,
        stdout: "",
        stderr: "стол ещё не создан: его создаёт первая команда допущенного к записи",
        code: "engine_unavailable",
      };
    }
    await engine.run(["init"]);
  }
  const res = await engine.run(argv, decision.tape ? input.tape : undefined);
  const reply: PmReply = { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
  if (res.code === 127) reply.code = "engine_unavailable";
  if (res.cut) reply.cut = res.cut;
  return reply;
}

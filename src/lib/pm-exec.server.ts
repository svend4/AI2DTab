/**
 * Что делает сервер с командой стола: проверить (`pm-request.ts`), убедиться, что движок на месте, выполнить (`pm-run.server.ts`).
 * Вынесено из `pm-api.ts` без фреймворка, чтобы это проверял `node --test` с подставным движком.
 */
import { buildPmArgs } from "./pm-request.ts";
import type { PmInput, PmReply, PmUser } from "./pm-request.ts";
import { engineReady, runPm } from "./pm-run.server.ts";
import type { PmRun } from "./pm-run.server.ts";

export type Engine = {
  ready: () => boolean;
  run: (argv: string[], tape?: string) => Promise<PmRun>;
};

export const realEngine: Engine = { ready: engineReady, run: (argv, tape) => runPm(argv, tape) };

/**
 * `user === null` — гость, `user.writer === false` — вошедший без допуска: им доступно только чтение, и базу они не создают.
 * Допущенному первая команда создаёт базу, если её нет (как делал прежний `pmExec`).
 */
export async function execute(
  input: PmInput,
  user: PmUser,
  engine: Engine = realEngine,
): Promise<PmReply> {
  const decision = buildPmArgs(input, user);
  if (!decision.ok) {
    return { ok: false, stdout: "", stderr: decision.message, code: decision.code };
  }
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
  const res = await engine.run(decision.argv, decision.tape ? input.tape : undefined);
  const reply: PmReply = { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
  if (res.code === 127) reply.code = "engine_unavailable";
  return reply;
}

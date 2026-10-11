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
 * `user === null` — анонимный посетитель: ему доступно только чтение, и базу он не создаёт.
 * Вошедшему первая команда создаёт базу, если её нет (как делал прежний `pmExec`).
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
    if (!user) {
      return {
        ok: false,
        stdout: "",
        stderr: "стол ещё не создан: его создаёт первая команда после входа",
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

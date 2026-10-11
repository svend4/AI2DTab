/**
 * Запуск `pm.py` для сайта (только сервер). Проверку «что можно» делает `pm-request.ts`; здесь только процесс.
 *
 * - ленту PLANT пишем во временную папку на каждый запрос (`mkdtemp`, права 0600) и удаляем в `finally`: общего предсказуемого
 *   файла `/tmp/desk-tape.txt` больше нет, а путь к файлу выбирает сервер, не клиент;
 * - у процесса есть обработчик `error`: нет `python3` или нет папки движка — это ответ `engine_unavailable`, а не падение сервера;
 * - вывод не копится сверх предела, процесс снимается по таймауту.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ENGINE_DIR = "/workspace/engine";
export const PM = `${ENGINE_DIR}/pm.py`;
export const DB = `${ENGINE_DIR}/project-store.sqlite`;

export type PmRun = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  python?: string;
  script?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOut?: number;
  maxErr?: number;
};

/** База стола на месте. */
export function engineReady(): boolean {
  return existsSync(DB);
}

function spawnPython(o: Required<RunOptions>, args: string[]): Promise<PmRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(o.python, [o.script, ...args], { cwd: o.cwd });
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs);
    const finish = (r: PmRun) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (e) => {
      finish({ code: 127, stdout: "", stderr: `engine_unavailable: ${e.message}`.slice(0, 300) });
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (b: Buffer) => {
      if (stdout.length < o.maxOut) stdout += String(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length < o.maxErr) stderr += String(b);
    });
    child.stdin?.end();
    child.on("close", (code) => {
      finish({
        code: code ?? 1,
        stdout: stdout.slice(0, o.maxOut),
        stderr: stderr.slice(0, o.maxErr),
      });
    });
  });
}

/** Выполняет `pm.py <argv>`; если есть лента, добавляет `--file <свой временный файл>`. */
export async function runPm(argv: string[], tape?: string, opts: RunOptions = {}): Promise<PmRun> {
  const o: Required<RunOptions> = {
    python: "python3",
    script: PM,
    cwd: ENGINE_DIR,
    timeoutMs: 12_000,
    maxOut: 80_000,
    maxErr: 4_000,
    ...opts,
  };
  let dir: string | undefined;
  try {
    const args = [...argv];
    if (tape !== undefined) {
      dir = await mkdtemp(join(tmpdir(), "pm-tape-"));
      const file = join(dir, "tape.txt");
      await writeFile(file, tape, { encoding: "utf8", mode: 0o600 });
      args.push("--file", file);
    }
    return await spawnPython(o, args);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

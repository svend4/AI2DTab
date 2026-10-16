/**
 * Запуск `pm.py` для сайта (только сервер). Проверку «что можно» делает `pm-request.ts`; здесь только процесс.
 *
 * - ленту PLANT пишем во временную папку на каждый запрос (`mkdtemp`, права 0600) и удаляем в `finally`: общего предсказуемого
 *   файла `/tmp/desk-tape.txt` больше нет, а путь к файлу выбирает сервер, не клиент;
 * - у процесса есть обработчик `error`: нет `python3` или нет папки движка — это ответ `engine_unavailable`, а не падение сервера;
 * - вывод не копится сверх предела в байтах (2 МБ), но его полный размер считается: обрезка называется числами, а не молчит (O8);
   выводит всё один раз в конце, поэтому многобайтный символ на стыке кусков не портится (AUD-44);
 * - процесс снимается по таймауту.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ENGINE_DIR = "/workspace/engine";
export const PM = `${ENGINE_DIR}/pm.py`;
export const DB = `${ENGINE_DIR}/project-store.sqlite`;

/** Предел ответа движка в байтах (O8): книга стола и JSON-ответы помещаются с запасом. */
export const MAX_OUT_BYTES = 2 * 1024 * 1024;

/** Сколько байт отброшено из полного ответа и каков полный размер. */
export type Cut = { dropped: number; total: number };
export type PmRun = { code: number; stdout: string; stderr: string; cut?: Cut };
export type RunOptions = {
  python?: string;
  script?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Предел ответа в байтах. */
  maxOut?: number;
  /** Предел ошибок в байтах. */
  maxErr?: number;
};

/** База стола на месте. */
export function engineReady(): boolean {
  return existsSync(DB);
}

/**
 * Копит вывод не больше `max` байт, но считает весь размер. Текст собирается один раз, в конце: декодировать каждый кусок
 * по отдельности портит кириллицу и €, если символ разрезан границей куска (AUD-44).
 */
function collect(max: number) {
  const parts: Buffer[] = [];
  let kept = 0;
  let total = 0;
  return {
    push(b: Buffer) {
      total += b.length;
      if (kept < max) {
        const part = b.subarray(0, max - kept);
        parts.push(part);
        kept += part.length;
      }
    },
    done(): { text: string; cut?: Cut } {
      const text = Buffer.concat(parts).toString("utf8");
      return total > kept ? { text, cut: { dropped: total - kept, total } } : { text };
    },
  };
}

function spawnPython(o: Required<RunOptions>, args: string[]): Promise<PmRun> {
  return new Promise((resolve) => {
    const out = collect(o.maxOut);
    const err = collect(o.maxErr);
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
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.stdin?.end();
    child.on("close", (code) => {
      const shown = out.done();
      finish({
        code: code ?? 1,
        stdout: shown.text,
        stderr: err.done().text,
        ...(shown.cut ? { cut: shown.cut } : {}),
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
    maxOut: MAX_OUT_BYTES,
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

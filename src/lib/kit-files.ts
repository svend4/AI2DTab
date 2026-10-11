/**
 * Какие файлы комплекта сайт показывает на L4 и где их искать (чистая часть: без чтения диска, его делает `kit-read.server.ts`).
 *
 * Показываем только то, что есть в списке `src/data/archive.json`, и только текст: `.md`, `.txt`, `.tsv`, `.sql`, `.py`.
 * База стола (`engine/project-store.sqlite`) в этом списке есть, но расширение `.sqlite` не текстовое, так что её содержимое
 * наружу не уходит; то же для `.xlsx`, `.log`, `.pgn`. Имя приходит от клиента и ни во что не подставляется, пока не совпадёт
 * со строкой списка дословно.
 */
import { join } from "node:path";

export const PREVIEW_BYTES = 12_000;
export const TEXT_EXTENSIONS = [".md", ".txt", ".tsv", ".sql", ".py"] as const;

export type KitRefusal = "bad_path" | "not_listed" | "not_text" | "not_found";

export const KIT_MESSAGES: Record<KitRefusal, string> = {
  bad_path: "недопустимое имя файла",
  not_listed: "такого файла нет в списке комплекта",
  not_text: "показываются только текстовые файлы (.md, .txt, .tsv, .sql, .py)",
  not_found: "файла нет в этой сборке: комплект с ним здесь не подключён",
};

// eslint-disable-next-line no-control-regex -- управляющие знаки в имени как раз и отсекаем
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/u;

/** Относительный путь с «/» без пустых частей, `.` и `..`; всё остальное (абсолютные пути, диски, обратная косая) — `null`. */
export function normalizeKitPath(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 240) return null;
  if (BAD_CHARS.test(input) || input.startsWith("/") || /^[A-Za-z]:/u.test(input)) return null;
  const parts = input.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

export function extensionOf(rel: string): string {
  const dot = rel.lastIndexOf(".");
  return dot > rel.lastIndexOf("/") ? rel.slice(dot).toLowerCase() : "";
}

/** Можно ли показывать этот путь: он в списке дословно и текстовый. Диск здесь не трогаем. */
export function planKitRead(
  requested: unknown,
  listed: ReadonlySet<string>,
): { ok: true; rel: string } | { ok: false; reason: "bad_path" | "not_listed" | "not_text" } {
  const rel = normalizeKitPath(requested);
  if (!rel) return { ok: false, reason: "bad_path" };
  if (!listed.has(rel)) return { ok: false, reason: "not_listed" };
  if (!(TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(rel))) {
    return { ok: false, reason: "not_text" };
  }
  return { ok: true, rel };
}

export type KitRoots = { repo: string; kit: string };

/**
 * Где искать `rel`, по порядку: сначала живой `engine/` этого репозитория (для `engine/…` и для имён без папки, как делал прежний код),
 * потом замороженный комплект. У каждого места есть корень, за который найденный файл (после `realpath`) выходить не вправе.
 */
export function kitCandidates(rel: string, roots: KitRoots): { root: string; file: string }[] {
  const out: { root: string; file: string }[] = [];
  const engine = join(roots.repo, "engine");
  if (rel.startsWith("engine/")) out.push({ root: engine, file: join(roots.repo, rel) });
  else if (!rel.includes("/")) out.push({ root: engine, file: join(engine, rel) });
  out.push({ root: roots.kit, file: join(roots.kit, rel) });
  return out;
}

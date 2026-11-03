/**
 * Чтение начала файла комплекта для L4 (только сервер). Что можно показывать и где искать — `kit-files.ts`; здесь только диск:
 * найденный файл должен после `realpath` лежать внутри своего корня (ссылка наружу не годится), быть обычным файлом и текстом
 * (в начале нет нулевого байта); читается не больше `PREVIEW_BYTES`, а не весь файл.
 */
import { open, realpath } from "node:fs/promises";
import { sep } from "node:path";
import { PREVIEW_BYTES, kitCandidates } from "./kit-files.ts";
import type { KitRoots } from "./kit-files.ts";

export type KitRead =
  | { ok: true; path: string; bytes: number; preview: string }
  | { ok: false; reason: "not_found" | "not_text" };

export const REAL_ROOTS: KitRoots = { repo: "/workspace", kit: "/workspace/artifacts/ai-pm-kit" };

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

export async function readKitPreview(rel: string, roots: KitRoots = REAL_ROOTS): Promise<KitRead> {
  for (const c of kitCandidates(rel, roots)) {
    let real: string;
    let rootReal: string;
    try {
      real = await realpath(c.file);
      rootReal = await realpath(c.root);
    } catch {
      continue; // нет файла или корня
    }
    if (!inside(real, rootReal)) continue; // ссылка вывела наружу
    let handle;
    try {
      handle = await open(real, "r");
    } catch {
      continue;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) continue;
      const buf = Buffer.alloc(Math.min(PREVIEW_BYTES, st.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead);
      if (head.includes(0)) return { ok: false, reason: "not_text" };
      return { ok: true, path: rel, bytes: st.size, preview: head.toString("utf8") };
    } finally {
      await handle.close();
    }
  }
  return { ok: false, reason: "not_found" };
}

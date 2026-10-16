#!/usr/bin/env node
/**
 * Снимок стола для опубликованного сайта (AUD-03, вариант 3). Запускает `pm.py exec JSON` в папке движка и пишет книгу с датой
 * в `src/data/desk-snapshot.json`. Сайт на сервере без движка читает этот файл и только показывает его.
 *
 * Запускайте там, где стоит движок, после правок стола. Команда `exec` дописывает миграцию ячеек в базу, если она нужна
 * (`migrate_cells` в engine/pm.py), поэтому при сомнении сначала снимите копию базы в отдельную папку и укажите её через `--engine`.
 *
 *   npm run desk:snapshot -- [--engine engine] [--out src/data/desk-snapshot.json] [--taken YYYY-MM-DD]
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Списки книги, без которых сайт не разбирает ответ (`parseBook` в `src/lib/desk-refresh.ts`). */
const LISTS = ["raw", "canon", "wires"];

/** Книга из вывода `pm.py exec JSON`: та же строка с объектом, которую читает сайт. */
export function buildSnapshot({ engine, taken, python = "python3" }) {
  const pm = join(engine, "pm.py");
  if (!existsSync(pm)) throw new Error(`нет ${pm}: укажите папку движка через --engine`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taken)) throw new Error(`дата снимка не YYYY-MM-DD: ${taken}`);
  const stdout = execFileSync(python, ["-B", pm, "exec", "JSON"], {
    cwd: engine,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("движок не вернул книгу");
  const book = JSON.parse(line);
  for (const key of LISTS) {
    if (!Array.isArray(book[key])) throw new Error(`в книге нет списка «${key}»`);
  }
  if (typeof book.instr !== "object" || book.instr === null) {
    throw new Error("в книге нет раздела instr");
  }
  return { taken, ...book };
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const engine = resolve(flag(args, "--engine", "engine"));
  const out = resolve(flag(args, "--out", "src/data/desk-snapshot.json"));
  const taken = flag(args, "--taken", new Date().toISOString().slice(0, 10));
  const snapshot = buildSnapshot({ engine, taken });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `снимок ${out}: дата ${taken}, raw ${snapshot.raw.length}, canon ${snapshot.canon.length}`,
  );
}

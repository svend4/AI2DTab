import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KIT_MESSAGES,
  PREVIEW_BYTES,
  TEXT_EXTENSIONS,
  extensionOf,
  kitCandidates,
  normalizeKitPath,
  planKitRead,
} from "./kit-files.ts";

const ROOTS = { repo: "/srv/app", kit: "/srv/kit" };
const LISTED = new Set([
  "engine/pm.py",
  "engine/README.md",
  "engine/project-store.sqlite",
  "engine/drivers/board_diff.py",
  "enbek-s001/DECISIONS.md",
  "schema.sql",
  "notes.TXT",
  "table.tsv",
  "sheet.xlsx",
  "run.log",
  "noext",
  ".env",
]);

describe("normalizeKitPath: имя от клиента", () => {
  it("обычные относительные пути проходят без изменений", () => {
    for (const p of [
      "README.md",
      "engine/pm.py",
      "enbek-s001/DECISIONS.md",
      "a/b/c.tsv",
      "имя с пробелом.md",
    ]) {
      assert.equal(normalizeKitPath(p), p);
    }
  });

  it("выход из папки и абсолютные пути не проходят", () => {
    for (const p of [
      "../pm.py",
      "engine/../../etc/passwd",
      "a/../b.md",
      "..",
      "/etc/passwd",
      "//etc/passwd",
      "C:/Windows/win.ini",
      "c:\\windows\\win.ini",
      "..\\pm.py",
      "engine\\pm.py",
      "./pm.py",
      "a/./b.md",
      "a//b.md",
      "a/",
      "/",
      ".",
    ]) {
      assert.equal(normalizeKitPath(p), null, p);
    }
  });

  it("пустое, слишком длинное, с управляющими знаками и не строка", () => {
    assert.equal(normalizeKitPath(""), null);
    assert.equal(normalizeKitPath("a".repeat(241)), null);
    assert.equal(normalizeKitPath("a".repeat(240)), "a".repeat(240));
    for (const p of ["a\u0000b.md", "a\nb.md", "a\tb.md", "a\u007fb.md"])
      assert.equal(normalizeKitPath(p), null);
    for (const p of [null, undefined, 1, {}, [], ["a.md"]]) assert.equal(normalizeKitPath(p), null);
  });

  it("закодированные и юникодные «слеши» не раскрываются: это просто буквы имени, а в списке их нет", () => {
    for (const p of ["%2e%2e/pm.py", "..%2fpm.py", "engine∕pm.py", "engine／pm.py", "．．/pm.py"]) {
      const n = normalizeKitPath(p);
      assert.equal(n, p);
      assert.equal(planKitRead(p, LISTED).ok, false, p);
    }
  });
});

describe("planKitRead: только список и только текст", () => {
  it("текстовые файлы из списка проходят, регистр расширения не важен", () => {
    for (const p of [
      "engine/pm.py",
      "engine/README.md",
      "enbek-s001/DECISIONS.md",
      "schema.sql",
      "notes.TXT",
      "table.tsv",
    ]) {
      assert.deepEqual(planKitRead(p, LISTED), { ok: true, rel: p }, p);
    }
  });

  it("база стола, таблицы Excel, журналы и файлы без расширения — не текст, хотя они в списке", () => {
    for (const p of ["engine/project-store.sqlite", "sheet.xlsx", "run.log", "noext", ".env"]) {
      assert.deepEqual(planKitRead(p, LISTED), { ok: false, reason: "not_text" }, p);
    }
  });

  it("чего нет в списке, не читается, даже если это обычный текст рядом", () => {
    for (const p of [
      "engine/LANG.md",
      "engine/CHAT-CRUTCH.md",
      "package.json",
      "src/lib/db.ts",
      "engine/PM.PY",
    ]) {
      assert.deepEqual(planKitRead(p, LISTED), { ok: false, reason: "not_listed" }, p);
    }
  });

  it("порядок отказов: сначала имя, потом список, потом тип", () => {
    assert.deepEqual(planKitRead("../project-store.sqlite", LISTED), {
      ok: false,
      reason: "bad_path",
    });
    assert.deepEqual(planKitRead("project-store.sqlite", LISTED), {
      ok: false,
      reason: "not_listed",
    });
    assert.deepEqual(planKitRead("engine/project-store.sqlite", LISTED), {
      ok: false,
      reason: "not_text",
    });
    assert.deepEqual(planKitRead(42, LISTED), { ok: false, reason: "bad_path" });
  });

  it("расширение берётся из последней части пути, а не из папки", () => {
    assert.equal(extensionOf("dir.md/file"), "");
    assert.equal(extensionOf("dir.md/file.sqlite"), ".sqlite");
    assert.equal(extensionOf("a.b.MD"), ".md");
    assert.deepEqual(planKitRead("dir.md/file", new Set(["dir.md/file"])), {
      ok: false,
      reason: "not_text",
    });
  });

  it("у каждой причины отказа есть сообщение для экрана", () => {
    for (const reason of ["bad_path", "not_listed", "not_text", "not_found"] as const) {
      assert.ok(KIT_MESSAGES[reason].length > 10, reason);
    }
    assert.equal(PREVIEW_BYTES, 12_000);
    assert.deepEqual([...TEXT_EXTENSIONS], [".md", ".txt", ".tsv", ".sql", ".py"]);
  });
});

describe("настоящий список src/data/archive.json", () => {
  const archive = JSON.parse(
    readFileSync(new URL("../data/archive.json", import.meta.url), "utf8"),
  ) as {
    path: string;
    bytes: number;
    kind: string;
  }[];
  const listed = new Set(archive.map((f) => f.path));

  it("каждая запись списка — допустимый относительный путь", () => {
    assert.ok(archive.length > 100);
    for (const f of archive) assert.equal(normalizeKitPath(f.path), f.path, f.path);
  });

  it("текстовые записи читаются, остальные нет; база стола среди отказов", () => {
    const text = new Set<string>(TEXT_EXTENSIONS);
    for (const f of archive) {
      const plan = planKitRead(f.path, listed);
      const isText = text.has(extensionOf(f.path));
      assert.equal(plan.ok, isText, f.path);
      if (!plan.ok) assert.equal(plan.reason, "not_text", f.path);
    }
    assert.ok(
      listed.has("engine/project-store.sqlite"),
      "база стола должна быть в списке: этим и опасна починка без разбора",
    );
    assert.deepEqual(planKitRead("engine/project-store.sqlite", listed), {
      ok: false,
      reason: "not_text",
    });
  });
});

describe("kitCandidates: где искать", () => {
  it("engine/… — живой engine репозитория, потом замороженный комплект", () => {
    assert.deepEqual(kitCandidates("engine/pm.py", ROOTS), [
      { root: "/srv/app/engine", file: "/srv/app/engine/pm.py" },
      { root: "/srv/kit", file: "/srv/kit/engine/pm.py" },
    ]);
  });

  it("имя без папки — engine репозитория, потом комплект", () => {
    assert.deepEqual(kitCandidates("schema.sql", ROOTS), [
      { root: "/srv/app/engine", file: "/srv/app/engine/schema.sql" },
      { root: "/srv/kit", file: "/srv/kit/schema.sql" },
    ]);
  });

  it("файл из чужой папки комплекта не подменяется одноимённым из engine (прежний код брал basename)", () => {
    assert.deepEqual(kitCandidates("enbek-s001/DECISIONS.md", ROOTS), [
      { root: "/srv/kit", file: "/srv/kit/enbek-s001/DECISIONS.md" },
    ]);
    assert.deepEqual(kitCandidates("engine/drivers/board_diff.py", ROOTS)[0], {
      root: "/srv/app/engine",
      file: "/srv/app/engine/drivers/board_diff.py",
    });
  });
});

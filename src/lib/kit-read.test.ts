import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_BYTES } from "./kit-files.ts";
import { readKitPreview } from "./kit-read.server.ts";

describe("readKitPreview: диск", () => {
  let top = "";
  let roots = { repo: "", kit: "" };

  before(() => {
    top = mkdtempSync(join(tmpdir(), "kit-read-"));
    const repo = join(top, "repo");
    const kit = join(top, "kit");
    const outside = join(top, "outside");
    for (const d of [join(repo, "engine"), join(kit, "enbek-s001"), outside])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(repo, "engine", "README.md"), "# Живой движок\nвторая строка\n");
    writeFileSync(join(repo, "engine", "pm.py"), "print('pm')\n");
    // база стола: заголовок SQLite содержит нулевой байт
    writeFileSync(
      join(repo, "engine", "project-store.sqlite"),
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(200, 7)]),
    );
    writeFileSync(join(repo, "engine", "bin.md"), Buffer.from([0x23, 0x20, 0x00, 0x41]));
    writeFileSync(join(repo, "engine", "big.md"), "я".repeat(3_000_000)); // 6 МБ в UTF-8
    writeFileSync(join(repo, "engine", "empty.md"), "");
    mkdirSync(join(repo, "engine", "dir.md"));
    writeFileSync(join(repo, "engine", "inner.md"), "внутри корня");
    symlinkSync(join(repo, "engine", "inner.md"), join(repo, "engine", "alias.md")); // ссылка внутри корня
    writeFileSync(join(outside, "secret.txt"), "СЕКРЕТ: не для показа");
    symlinkSync(join(outside, "secret.txt"), join(repo, "engine", "leak.md")); // ссылка наружу
    symlinkSync(outside, join(repo, "engine", "outdir")); // папка-ссылка наружу
    mkdirSync(join(repo, "engine-evil")); // сосед, имя которого начинается так же, как имя корня
    writeFileSync(join(repo, "engine-evil", "a.md"), "СЕКРЕТ из соседней папки");
    symlinkSync(join(repo, "engine-evil", "a.md"), join(repo, "engine", "sibling.md"));
    writeFileSync(join(outside, "inside-outdir.md"), "СЕКРЕТ через папку");
    writeFileSync(join(kit, "enbek-s001", "DECISIONS.md"), "# Решения комплекта\n");
    writeFileSync(join(kit, "CYCLE-4.md"), "из комплекта");
    writeFileSync(join(repo, "engine", "CYCLE-4.md"), "из движка");
    symlinkSync(join(outside, "secret.txt"), join(kit, "escape.md"));
    roots = { repo, kit };
  });

  after(() => rmSync(top, { recursive: true, force: true }));

  it("читает файл движка: путь, размер и начало", async () => {
    const r = await readKitPreview("engine/README.md", roots);
    assert.ok(r.ok);
    assert.equal(r.path, "engine/README.md");
    assert.equal(r.bytes, Buffer.byteLength("# Живой движок\nвторая строка\n"));
    assert.equal(r.preview, "# Живой движок\nвторая строка\n");
  });

  it("имя без папки ищется сначала в engine, потом в комплекте; живой файл главнее замороженного", async () => {
    const both = await readKitPreview("CYCLE-4.md", roots);
    assert.ok(both.ok);
    assert.equal(both.preview, "из движка");
    const kitOnly = await readKitPreview("enbek-s001/DECISIONS.md", roots);
    assert.ok(kitOnly.ok);
    assert.equal(kitOnly.preview, "# Решения комплекта\n");
  });

  it("большой файл: читается не больше PREVIEW_BYTES, размер настоящий", async () => {
    const r = await readKitPreview("engine/big.md", roots);
    assert.ok(r.ok);
    assert.equal(r.bytes, 6_000_000);
    assert.ok(Buffer.byteLength(r.preview) <= PREVIEW_BYTES, String(Buffer.byteLength(r.preview)));
    assert.ok(r.preview.length >= PREVIEW_BYTES / 2 - 2, String(r.preview.length));
  });

  it("пустой файл — пустое начало", async () => {
    const r = await readKitPreview("engine/empty.md", roots);
    assert.deepEqual(r, { ok: true, path: "engine/empty.md", bytes: 0, preview: "" });
  });

  it("нулевой байт в начале — не текст, даже при текстовом расширении; заголовок базы стола тоже", async () => {
    assert.deepEqual(await readKitPreview("engine/bin.md", roots), {
      ok: false,
      reason: "not_text",
    });
    assert.deepEqual(await readKitPreview("engine/project-store.sqlite", roots), {
      ok: false,
      reason: "not_text",
    });
  });

  it("ссылка наружу корня не читается и ничего не отдаёт; ссылка внутри корня читается", async () => {
    for (const rel of [
      "engine/leak.md",
      "engine/outdir/inside-outdir.md",
      "engine/sibling.md",
      "escape.md",
    ]) {
      const r = await readKitPreview(rel, roots);
      assert.deepEqual(r, { ok: false, reason: "not_found" }, rel);
      assert.ok(!JSON.stringify(r).includes("СЕКРЕТ"));
    }
    const ok = await readKitPreview("engine/alias.md", roots);
    assert.ok(ok.ok);
    assert.equal(ok.preview, "внутри корня");
  });

  it("папка, несуществующий файл и отсутствующий комплект — не найдено", async () => {
    for (const rel of [
      "engine/dir.md",
      "engine/нет-такого.md",
      "engine/drivers/x.py",
      "nowhere/x.md",
    ]) {
      assert.deepEqual(await readKitPreview(rel, roots), { ok: false, reason: "not_found" }, rel);
    }
    const noKit = { repo: roots.repo, kit: join(top, "нет-комплекта") };
    assert.deepEqual(await readKitPreview("enbek-s001/DECISIONS.md", noKit), {
      ok: false,
      reason: "not_found",
    });
    assert.deepEqual(
      await readKitPreview("engine/README.md", {
        repo: join(top, "нет-репозитория"),
        kit: noKit.kit,
      }),
      { ok: false, reason: "not_found" },
    );
  });
});

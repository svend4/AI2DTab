import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Сам серверный вызов запускает фреймворк; здесь проверено по тексту, что он идёт через список и проверенное чтение. */
const src = readFileSync(new URL("./kit-api.ts", import.meta.url), "utf8");

describe("kit-api.ts: readKitFile", () => {
  it("наружу выходит один вызов с одним полем path", () => {
    assert.deepEqual(
      [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]),
      ["readKitFile"],
    );
    assert.equal([...src.matchAll(/createServerFn\(/g)].length, 1);
    assert.match(src, /z\.object\(\{ path: z\.string\(\)\.min\(1\)\.max\(240\) \}\)/);
  });

  it("сначала решает список и тип, потом читает; чтение идёт только через readKitPreview", () => {
    const plan = src.indexOf("planKitRead(data.path");
    const read = src.indexOf("readKitPreview(plan.rel");
    assert.ok(plan > 0 && read > plan, "чтение должно идти после проверки списка");
    assert.match(src, /new Set\(archive\.map\(\(f\) => f\.path\)\)/);
    assert.doesNotMatch(src, /readFile|readFileSync|createReadStream|node:fs|existsSync/);
  });

  it("отказ — ответ с причиной и сообщением, а не исключение", () => {
    assert.doesNotMatch(src, /\bthrow\b/);
    assert.equal(
      [
        ...src.matchAll(
          /ok: false as const, reason: \w+\.reason, message: KIT_MESSAGES\[\w+\.reason\]/g,
        ),
      ].length,
      2,
    );
  });

  it("серверные модули и список подключаются только внутри обработчика", () => {
    assert.doesNotMatch(src, /^import .*(\.server|archive\.json|kit-files)/m);
    assert.match(src, /await import\("@\/lib\/kit-read\.server"\)/);
    assert.match(src, /await import\("@\/data\/archive\.json"\)/);
  });
});

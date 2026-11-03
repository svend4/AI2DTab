import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Инвариант 7 (engine/cards/PLAN-LOOPS.md): в файлах репозитория нет названий моделей. Проверяются отслеживаемые файлы
 * (`git ls-files`); сообщения коммитов этим тестом не проверяются: старые не переписываем, а новые пишутся с трейлером
 * без названия модели (решение владельца). Без git тест пропускается, а не проходит молча.
 */
const ROOT = resolve(import.meta.dirname, "..");
const MODEL = /\b(Opus|Sonnet|Haiku|Fable)[ -]?\d|claude-(opus|sonnet|haiku|fable)/i;

describe("инвариант 7: в отслеживаемых файлах нет названий моделей", () => {
  it("ни один файл не называет модель с версией", (t) => {
    let listed;
    try {
      listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      t.skip("нет git: список отслеживаемых файлов не получить");
      return;
    }
    const hits = [];
    for (const file of listed.split("\0").filter(Boolean)) {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      if (text.includes("\0")) continue;
      text.split("\n").forEach((line, i) => {
        if (MODEL.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, []);
  });
});

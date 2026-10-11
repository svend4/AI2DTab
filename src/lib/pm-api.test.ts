import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Сами серверные вызовы запускает фреймворк, и в `node --test` его нет. Поэтому здесь проверено то, что можно проверить по тексту:
 * какой вызов открыт всем, какой за входом, откуда берётся допуск к записи и что в запросе нет поля «файл». Поведение целиком
 * (гость, вошедший без допуска, допущенный) смотрит проверка с включённым входом, см. docs/AUDIT.md.
 */
const src = readFileSync(new URL("./pm-api.ts", import.meta.url), "utf8");

/** Текст объявления `export const <name> = …` до следующего `export const` или конца файла. */
function declaration(name: string): string {
  const start = src.search(new RegExp(`export const ${name}\\s*=`));
  assert.ok(start >= 0, `в pm-api.ts нет ${name}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport const /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe("pm-api.ts: кто что может вызвать", () => {
  it("наружу выходят ровно три вызова: чтение, запись и «допущен ли я»", () => {
    const names = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(names.sort(), ["deskWho", "pmRead", "pmWrite"]);
    assert.equal([...src.matchAll(/createServerFn\(/g)].length, 3);
  });

  it("чтение открыто: без входа, и в движок идёт пользователь null", () => {
    const d = declaration("pmRead");
    assert.doesNotMatch(d, /middleware/);
    assert.doesNotMatch(d, /\bcontext\b/);
    assert.match(d, /execute\(\s*data\s*,\s*null\s*\)/);
  });

  it("запись за входом, и в движок идёт проверенный номер пользователя и допуск с сервера, а не что-то из запроса", () => {
    const d = declaration("pmWrite");
    assert.match(d, /\.middleware\(\s*\[\s*authMiddleware\s*\]\s*\)/);
    assert.match(d, /const writer = await isDeskWriter\(\s*context\.userId\s*\)/);
    assert.match(d, /execute\(\s*data\s*,\s*\{\s*id:\s*context\.userId\s*,\s*writer\s*\}\s*\)/);
    assert.doesNotMatch(d, /\bnull\b/);
    assert.doesNotMatch(d, /data\.\w*(writer|user|email)/i);
    assert.match(src, /import \{ authMiddleware \} from "@\/lib\/auth\/middleware";/);
  });

  it("«допущен ли я» за входом, считает по номеру из сессии и отдаёт только ответ, не список", () => {
    const d = declaration("deskWho");
    assert.match(d, /\.middleware\(\s*\[\s*authMiddleware\s*\]\s*\)/);
    assert.match(d, /isDeskWriter\(\s*context\.userId\s*\)/);
    assert.match(d, /return \{ writer: await isDeskWriter\(/);
    assert.doesNotMatch(d, /\.validator\(/);
    assert.doesNotMatch(src, /WRITERS_ENV|parseWriters|process\.env/);
  });

  it("чтение не знает про допуск и про базу входа", () => {
    const d = declaration("pmRead");
    assert.doesNotMatch(d, /isDeskWriter|desk-writers/);
  });

  it("в запросе только строка команды и лента; поля «файл» нет", () => {
    const m = src.match(/const Input = z\.object\(\{([\s\S]*?)\}\);/);
    assert.ok(m, "не нашёл схему Input");
    const keys = [...m[1].matchAll(/^\s*(\w+):/gm)].map((k) => k[1]);
    assert.deepEqual(keys, ["line", "tape"]);
    assert.doesNotMatch(src, /\bfile\s*:\s*z\./);
    assert.equal([...src.matchAll(/\.validator\(Input\)/g)].length, 2);
  });

  it("серверный код подключается только внутри обработчика, чтобы не попасть в клиентскую сборку", () => {
    assert.doesNotMatch(src, /^import .*\.server/m);
    assert.doesNotMatch(src, /from "node:/);
    assert.equal([...src.matchAll(/await import\("@\/lib\/pm-exec\.server"\)/g)].length, 2);
    assert.equal([...src.matchAll(/await import\("@\/lib\/desk-writers\.server"\)/g)].length, 2);
  });
});

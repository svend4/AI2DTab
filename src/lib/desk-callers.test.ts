import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Мост и баннер нельзя загрузить под `node --test`: они тянут `@/`-алиасы и серверные функции. Поэтому здесь проверено по тексту,
 * что мост больше не имеет запасного пути, который стирал стол при сбое (AUD-14), что обновление идёт через разбор с проверкой
 * (`desk-refresh.ts`), и что баннер с причиной стоит в шапке стола. Поведение целиком смотрит `desk-refresh.test.ts`.
 */
const bridge = readFileSync(new URL("./desk-bridge.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("./desk-store.ts", import.meta.url), "utf8");
const nav = readFileSync(new URL("../components/desk-nav.tsx", import.meta.url), "utf8");

describe("мост: обновление стола не стирает его при сбое (AUD-14, AUD-23)", () => {
  it("запасного пути из четырёх вызовов больше нет", () => {
    for (const name of [
      "refreshPlane",
      "refreshCanon",
      "refreshInstr",
      "refreshWires",
      "parseSheet",
    ]) {
      assert.doesNotMatch(bridge, new RegExp(`\\b${name}\\b`), name);
    }
    for (const verb of ["CANON", "RAW", "INSTR", "PACKET"]) {
      assert.doesNotMatch(bridge, new RegExp(`bridge\\(\\s*"${verb}"`), verb);
    }
    const start = bridge.indexOf("export async function refreshBook(");
    const body = bridge.slice(start, bridge.indexOf("\n}\n", start));
    assert.equal([...body.matchAll(/bridge\(/g)].length, 1, "в refreshBook один вызов моста");
  });

  it("книга разбирается и применяется через desk-refresh, и ответ отстающего запроса отбрасывается", () => {
    assert.match(bridge, /from "@\/lib\/desk-refresh"/);
    assert.match(bridge, /applyBookReply\(parseBook\(out\), /);
    assert.match(bridge, /createSequencer\(\)/);
    assert.match(bridge, /if \(!bookSequence\.isLatest\(token\)\) return;/);
  });

  it("пишущие функции по-прежнему обновляют стол после записи", () => {
    for (const fn of ["acceptBoth", "takeBoth", "runBoth", "fetchBoth", "plantToDb"]) {
      const start = bridge.indexOf(`export async function ${fn}(`);
      assert.ok(start >= 0, fn);
      const body = bridge.slice(start, bridge.indexOf("\n}\n", start));
      assert.match(body, /await refreshBook\(\)/, fn);
    }
  });
});

describe("стор и шапка: причина сбоя видна пользователю", () => {
  it("стор держит уведомление, и оно не сохраняется между сессиями", () => {
    assert.match(store, /notice: string \| null;/);
    assert.match(store, /setNotice: \(notice: string \| null\) => void;/);
    assert.match(store, /partialize: \(s\) => \(\{ tape: s\.tape \}\)/);
  });

  it("шапка показывает уведомление с role=alert и кнопкой закрыть", () => {
    assert.match(nav, /useDesk\(\(s\) => s\.notice\)/);
    assert.match(nav, /role="alert"/);
    assert.match(nav, /setNotice\(null\)/);
  });
});

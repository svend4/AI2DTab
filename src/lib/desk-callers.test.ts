import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Мост, строка команд, маршруты и шапка нельзя загрузить под `node --test`: они тянут `@/`-алиасы и серверные функции. Поэтому
 * здесь проверено по тексту: книга обновляется без запасного пути (AUD-14); каждая запись идёт через `writeDesk`, а исход записи
 * виден пользователю (AUD-11, AUD-13); переход после записи делается только при успехе (AUD-31, AUD-43). Поведение целиком
 * смотрят `desk-refresh.test.ts` и `desk-writes.test.ts`.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const bridge = read("./desk-bridge.ts");
const store = read("./desk-store.ts");
const nav = read("../components/desk-nav.tsx");
const commandBar = read("../components/command-bar.tsx");
const l2 = read("../routes/l2.tsx");
const l3 = read("../routes/l3.tsx");
const l4 = read("../routes/l4.tsx");
const index = read("../routes/index.tsx");
const machine = read("./machine.ts");
const access = read("./use-desk-access.ts");
const accessBar = read("../components/access-bar.tsx");
const l4Route = read("../routes/l4.tsx");
const commandBarSrc = read("../components/command-bar.tsx");

/** Текст одной экспортируемой функции моста: от заголовка до закрывающей скобки на начале строки. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `нет ${name}`);
  return source.slice(start, source.indexOf("\n}\n", start));
}

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
    assert.equal(
      [...fn(bridge, "refreshBook").matchAll(/bridge\(/g)].length,
      1,
      "в refreshBook один вызов",
    );
  });

  it("книга разбирается и применяется через desk-refresh, и ответ отстающего запроса отбрасывается", () => {
    assert.match(bridge, /from "@\/lib\/desk-refresh"/);
    assert.match(bridge, /applyBookReply\(parseBook\(out\), /);
    assert.match(bridge, /createSequencer\(\)/);
    assert.match(bridge, /if \(!bookSequence\.isLatest\(token\)\) return;/);
  });
});

describe("мост: все записи идут через одну точку и показывают исход (AUD-11, AUD-13)", () => {
  it("writeDesk: команда, затем исход в уведомление записи, затем книга", () => {
    const body = fn(bridge, "writeDesk");
    const order = ["bridge(line", "writeOutcome(out)", "setWriteNotice(", "refreshBook()"].map(
      (p) => body.indexOf(p),
    );
    assert.ok(
      order.every((i) => i >= 0),
      JSON.stringify(order),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  it("обрезка книги (O8) уходит в отдельную пометку, а не в уведомление", () => {
    assert.match(bridge, /setCut: s\.setBookCut/);
  });

  it("пометка о пропусках (AUD-43) попадает в уведомление записи, а не теряется", () => {
    assert.match(
      fn(bridge, "writeDesk"),
      /setWriteNotice\(outcome\.ok \? \(outcome\.note \?\? null\) : outcome\.message\)/,
    );
  });

  it("каждая пишущая функция идёт через writeDesk и не трогает стор до ответа стола", () => {
    for (const name of ["plantToDb", "acceptBoth", "takeBoth", "runBoth", "fetchBoth"]) {
      assert.match(fn(bridge, name), /writeDesk\(/, name);
    }
    assert.doesNotMatch(bridge, /useDesk\.getState\(\)\.(accept|reject|run|mergeRows|plant)\(/);
  });

  it("FETCH добавляет строку в ленту только после успешного ответа стола", () => {
    const body = fn(bridge, "fetchBoth");
    assert.match(body, /if \(fetchAdded\(out\)\) useDesk\.getState\(\)\.fetchNew\(\);/);
  });

  it("стор: оптимистичных записей и мёртвого разбора строки команд больше нет", () => {
    for (const name of ["accept", "reject", "run", "mergeRows", "plant", "execLine"]) {
      assert.doesNotMatch(store, new RegExp(`\\n {6}${name}: \\(`), name);
    }
  });

  it("стор держит уведомление записи отдельно от уведомления обновления", () => {
    assert.match(store, /writeNotice: string \| null;/);
    assert.match(store, /setWriteNotice: \(notice: string \| null\) => void;/);
    assert.match(store, /notice: string \| null;/);
    assert.match(store, /partialize: \(s\) => \(\{ tape: s\.tape \}\)/);
  });
});

describe("остаток rows убран: стор и маршруты читают только книгу (AUD-26)", () => {
  it("в сторе нет поля rows и его начального значения", () => {
    assert.doesNotMatch(store, /^ {2}rows: Row\[\];$/m);
    assert.doesNotMatch(store, /seedRows/);
    assert.doesNotMatch(store, /\brows: seedRows\(\)/);
  });

  it("маршруты и шапка не читают s.rows, а счётчик L1 не выводит фиктивный ноль", () => {
    assert.doesNotMatch(l2, /useDesk\(\(s\) => s\.rows\)/);
    assert.doesNotMatch(nav, /useDesk\(\(s\) => s\.rows\)/);
    assert.doesNotMatch(nav, /rows\.filter/);
    assert.doesNotMatch(l2, /rows\.filter/);
  });

  it("мёртвая machineStatus с параметром rows удалена", () => {
    assert.doesNotMatch(machine, /machineStatus/);
  });
});

describe("шапка: оба уведомления видны, каждое закрывается отдельно", () => {
  it("шапка показывает уведомление записи и уведомление обновления через один компонент с role=alert", () => {
    assert.match(nav, /useDesk\(\(s\) => s\.writeNotice\)/);
    assert.match(nav, /useDesk\(\(s\) => s\.notice\)/);
    assert.match(nav, /<DeskAlert text=\{writeNotice\}/);
    assert.match(nav, /<DeskAlert text=\{notice\}/);
    assert.match(nav, /role="alert"/);
    assert.match(nav, /setWriteNotice\(null\)/);
    assert.match(nav, /setNotice\(null\)/);
  });
});

describe("строка команд: исход записи виден, обновление не дублируется", () => {
  it("класс команды берётся из таблицы глаголов, регулярного выражения WRITE нет", () => {
    assert.match(commandBar, /const kind = verbKind\(C\);/);
    assert.match(
      commandBar,
      /kind === "write" \|\| kind === "bulk" \? await writeBulk\(t\) : await bridge\(t\)/,
    );
    assert.doesNotMatch(commandBar, /const WRITE =/);
  });

  it("DUMP сохраняет файл только при успешном ответе", () => {
    assert.match(commandBar, /if \(out\.ok\) downloadText\("book\.tsv"/);
  });

  it("записи строки команд не вызывают refreshBook сами: это делает writeDesk", () => {
    assert.doesNotMatch(commandBar, /refreshBook/);
  });
});

describe("кнопки и переходы: при сбое пользователь остаётся на месте", () => {
  it("L2: FILL, SWEEP, GAP, PURGE и PROBE идут через мост записи, мимо стора не пишут", () => {
    for (const verb of ["FILL", "SWEEP", "PURGE"]) {
      assert.match(l2, new RegExp(`writeBulk\\("${verb}"\\)`), verb);
    }
    for (const verb of ["GAP", "PROBE C A"]) {
      assert.match(l2, new RegExp(`writeDesk\\("${verb}"\\)`), verb);
    }
    assert.doesNotMatch(l2, /bridge\("(FILL|SWEEP|GAP|PURGE|PROBE)/);
    assert.doesNotMatch(l2, /mergeRows/);
  });

  it("L2: загрузка комплекта отправляет строки в PLANT, а не добавляет их в стор до ответа", () => {
    assert.match(l2, /void plantToDb\(rows\);/);
  });

  it("PLANT (L1), RUN (L3) и FETCH (L4) переходят на другую страницу только при успехе", () => {
    assert.match(index, /if \(writeOutcome\(out\)\.ok\) nav\(\{ to: "\/l2" \}\);/);
    assert.match(l3, /if \(writeOutcome\(out\)\.ok\) nav\(\{ to: "\/l4" \}\);/);
    assert.match(l4, /if \(writeOutcome\(out\)\.ok\) nav\(\{ to: "\/" \}\);/);
  });

  it("SETTLE (L4) идёт через writeDesk и затем перечитывает спецификацию", () => {
    assert.match(l4, /await writeDesk\("SETTLE"\);/);
  });
});

describe("снимок стола: дата в шапке, запись в снимке закрыта на интерфейсе", () => {
  it("стор держит дату снимка, мост её передаёт, шапка показывает метку", () => {
    assert.match(store, /snapshot: string \| null;/);
    assert.match(bridge, /setSnapshot: s\.setSnapshot/);
    assert.match(nav, /snapshotLabel\(snapshot\)/);
  });

  it("доступ к записи учитывает снимок", () => {
    assert.match(access, /const snapshot = useDesk\(\(s\) => s\.snapshot !== null\)/);
    assert.match(access, /deskAccess\(\{ user, isPending, writer, snapshot \}\)/);
  });
});

describe("массовые записи RAW и OBS: список и подтверждение до записи (AUD-15)", () => {
  it("мост берёт список через IDS и ждёт подтверждения до записи со списком", () => {
    const body = fn(bridge, "writeBulk");
    const order = [
      "setExprOf(line)",
      "bridge(`IDS ${expr}`)",
      "askBulk(line, ids)",
      "writeDesk(line, { ids })",
    ].map((p) => body.indexOf(p));
    assert.ok(
      order.every((i) => i >= 0),
      JSON.stringify(order),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  it("команды строки и кнопка FILL идут через writeBulk, а не мимо подтверждения", () => {
    assert.match(
      commandBar,
      /kind === "write" \|\| kind === "bulk" \? await writeBulk\(t\) : await bridge\(t\)/,
    );
    assert.match(l2, /writeBulk\("FILL"\)/);
    assert.doesNotMatch(l2, /writeDesk\("FILL"\)/);
  });

  it("панель подтверждения показывает список id и закрывает ожидание ответом", () => {
    assert.match(nav, /function BulkConfirm/);
    assert.match(nav, /bulk\.ids\.map/);
    assert.match(nav, /answer\(true\)/);
    assert.match(nav, /setBulk\(null\)/);
    assert.match(store, /bulk: BulkAsk \| null;/);
  });
});

describe("исход и снимок: что видно пользователю (AUD-43, AUD-03)", () => {
  it("полоса доступа показывает снимок отдельным режимом, а L4 не просит спецификацию на снимке", () => {
    assert.match(accessBar, /mode === "snapshot"/);
    assert.match(accessBar, /Только чтение\./);
    assert.match(l4Route, /if \(access\.snapshot\) \{/);
  });

  it("FETCH добавляет строку в ленту только когда движок её завёл, и прежний запрос подтверждения не висит", () => {
    assert.match(bridge, /if \(fetchAdded\(out\)\) useDesk\.getState\(\)\.fetchNew\(\);/);
    assert.match(bridge, /useDesk\.getState\(\)\.bulk\?\.done\(false\);/);
  });

  it("DUMP с обрезкой файл не сохраняет", () => {
    assert.match(commandBarSrc, /if \(out\.cut\) \{/);
  });
});

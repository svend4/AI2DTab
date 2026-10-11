/**
 * Что сайт передаёт столу (`pm.py exec`) и от чьего имени.
 *
 * Чистый модуль: без процессов, диска и импортов. Его вызывает сервер перед запуском `pm.py`, а клиент — чтобы выбрать
 * вызов «чтение» или «запись»; `pm-request.test.ts` проверяет его таблицей безопасности из `docs/AUDIT.md`, раздел 4.
 *
 * Правила (режим A):
 *  - анонимному посетителю доступны только глаголы чтения (`kind: "read"`); запись (`write`) и массовые глаголы (`bulk`) — после входа;
 *  - глагол берётся из таблицы `VERBS`, а не из регулярного выражения по первому слову;
 *  - аргументы разбираются по правилам глагола: идентификатор объекта, выражение над множествами, слова. Токен с ведущим дефисом
 *    любого вида (- – — − ﹣ －) не проходит нигде, поэтому `--file`, `--file=…`, `--fi` до argparse не доходят;
 *  - в `pm.py` уходят токены, собранные заново из проверенных частей, а не строка клиента;
 *  - BATCH разбирается здесь: подкоманды по `;` и переводу строки, не больше 10, каждая проходит ту же таблицу;
 *  - параметра «файл» нет. Ленту для PLANT клиент присылает текстом (`tape`), путь к её временному файлу выбирает сервер.
 *
 * Таблица — по одной строке на глагол и в одном виде: `engine/test_pm.py` читает её и сверяет с `pm.py` (глагол существует,
 * глаголы чтения не меняют базу).
 */

export type VerbKind = "read" | "write" | "bulk";
export type PmUser = { id: string } | null;
export type PmInput = { line: string; tape?: string };
export type Refusal =
  | "empty"
  | "too_long"
  | "unknown_verb"
  | "bad_token"
  | "bad_args"
  | "too_many"
  | "tape"
  | "login_required";
export type PmRefused = { ok: false; code: Refusal; message: string };
/** Ответ сайта на команду; `code` — причина отказа или сбоя, если она есть. */
export type PmReply = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: Refusal | "engine_unavailable" | "bridge";
};
export const LOGIN_MESSAGE = "запись в стол требует входа";
/** `argv` — то, что идёт в `pm.py` (начиная с `exec`). Если `tape` истинно, сервер добавляет `--file <свой временный файл>`. */
export type PmParsed = { ok: true; verb: string; kind: VerbKind; argv: string[]; tape: boolean };

type Rule =
  | "none" //   аргументов нет
  | "id" //     один идентификатор объекта
  | "target" // идентификатор объекта либо выражение над множествами (тогда массовая операция)
  | "set" //    выражение над множествами и идентификаторами
  | "pair" //   два операнда (кластеры, множества, идентификаторы)
  | "wire" //   откуда, куда и необязательная связь
  | "packet" // ничего, идентификатор или два кластера
  | "name" //   необязательное имя файла
  | "words" //  несколько слов поиска
  | "text" //   текст для посадки или лента
  | "batch"; // подкоманды через `;`

type Verb = { kind: VerbKind; rule: Rule };

/** Один глагол — одна строка в одном виде (её читает `engine/test_pm.py`). SUPERSEDE, MUL и TIMES сайту не отданы: замену принятого ставит человек в CLI. */
export const VERBS: Readonly<Record<string, Verb>> = {
  STATUS: { kind: "read", rule: "none" },
  LOOK: { kind: "read", rule: "words" },
  DUMP: { kind: "read", rule: "none" },
  GRID: { kind: "read", rule: "none" },
  MATRIX: { kind: "read", rule: "none" },
  DIFF: { kind: "read", rule: "none" },
  JSON: { kind: "read", rule: "none" },
  CANON: { kind: "read", rule: "none" },
  RAW: { kind: "read", rule: "none" },
  NEQ: { kind: "read", rule: "none" },
  CELL: { kind: "read", rule: "none" },
  SET: { kind: "read", rule: "set" },
  VOCAB: { kind: "read", rule: "set" },
  PACKET: { kind: "read", rule: "packet" },
  CONC: { kind: "read", rule: "words" },
  CONCORD: { kind: "read", rule: "words" },
  INSTR: { kind: "read", rule: "none" },
  GAUGE: { kind: "read", rule: "none" },
  PANEL: { kind: "read", rule: "none" },
  PORT: { kind: "read", rule: "pair" },
  CAT: { kind: "read", rule: "name" },
  PLANT: { kind: "write", rule: "text" },
  CUT: { kind: "write", rule: "text" },
  ACCEPT: { kind: "write", rule: "target" },
  TAKE: { kind: "write", rule: "target" },
  RUN: { kind: "write", rule: "id" },
  FETCH: { kind: "write", rule: "none" },
  WIRE: { kind: "write", rule: "wire" },
  PROBE: { kind: "write", rule: "pair" },
  FILL: { kind: "bulk", rule: "none" },
  SWEEP: { kind: "bulk", rule: "none" },
  PURGE: { kind: "bulk", rule: "none" },
  REPAIR: { kind: "bulk", rule: "none" },
  GAP: { kind: "bulk", rule: "none" },
  SETTLE: { kind: "bulk", rule: "none" },
  SPEC: { kind: "bulk", rule: "none" },
  BATCH: { kind: "bulk", rule: "batch" },
};

export const LIMITS = {
  line: 4000,
  tape: 200_000,
  tokens: 12,
  words: 400,
  lookWords: 8,
  concWords: 4,
  batch: 10,
} as const;

/** Имена множеств движка (`pm.py: SET_NAMES`): по ним `ACCEPT`/`TAKE` узнают массовую операцию. */
const SET_NAMES = new Set([
  "NEQ",
  "NE",
  "RAW",
  "CANON",
  "SUPERSEDED",
  "SESSION",
  "A",
  "B",
  "C",
  "D",
  "OBS",
  "OBSERVATION",
  "JUNK",
]);
const SET_OPS = ["∩", "∪", "\\", "&", "|"];
const WORD_OPS = new Set(["AND", "OR", "MINUS"]);

const VERB_NAME = /^[A-Za-z]{2,12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OPERAND = /^(?:≠|[A-Za-z0-9≠][A-Za-z0-9_.≠-]{0,63})$/u;
const REL = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Слово свободного текста: без пробелов, управляющих знаков, `;`, кавычек, обратной косой черты и скобок. */
// eslint-disable-next-line no-control-regex -- управляющие знаки здесь и ищем
const WORD = /^[^\s;"'`\\<>$(){}[\]\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,80}$/u;
const DASH_START = /^[\p{Pd}\u2212\uFE63\uFF0D]/u;
// eslint-disable-next-line no-control-regex -- управляющие знаки здесь и ищем
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function refuse(code: Refusal, message: string): PmRefused {
  return { ok: false, code, message };
}

function shown(s: string): string {
  // eslint-disable-next-line no-control-regex -- управляющие знаки здесь и убираем
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 40);
}

/** Зеркало `pm.py: is_set_expr`: это выражение над множествами, а не идентификатор одного объекта. */
export function isSetExpr(arg: string): boolean {
  const s = arg.trim();
  if (!s) return false;
  if (SET_OPS.some((op) => s.includes(op))) return true;
  return SET_NAMES.has(s.toUpperCase().replace(/≠/g, "NEQ"));
}

/** `A`, `A ∩ B`, `A AND B`: ровно одна операция (больше `pm.py` не понимает). Возвращает канонические токены или null. */
function setExpr(tokens: string[]): string[] | null {
  const joined = tokens.join(" ");
  const parts = joined.split(/\s*(∩|∪|\\|&|\|)\s*/u);
  if (parts.length === 1) {
    const t = joined.trim().split(/\s+/u);
    if (t.length === 1) return OPERAND.test(t[0]) ? t : null;
    if (t.length === 3 && WORD_OPS.has(t[1]) && OPERAND.test(t[0]) && OPERAND.test(t[2])) return t;
    return null;
  }
  if (parts.length !== 3) return null;
  const [left, op, right] = parts.map((p) => p.trim());
  return OPERAND.test(left) && OPERAND.test(right) ? [left, op, right] : null;
}

type Cmd = { verb: string; kind: VerbKind; args: string[] };

/** Разбор одной команды (не BATCH). `inBatch`: её потом разберёт `shlex`, поэтому обратная косая черта как оператор недопустима. */
function parseCommand(text: string, inBatch: boolean): Cmd | PmRefused {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return refuse("empty", "пустая команда");
  for (const t of tokens) {
    if (CONTROL.test(t)) return refuse("bad_token", "в команде управляющий знак");
    if (DASH_START.test(t))
      return refuse(
        "bad_token",
        `токен «${shown(t)}» начинается с дефиса: опции движка отсюда не передаются`,
      );
  }
  if (!VERB_NAME.test(tokens[0]))
    return refuse("unknown_verb", `неизвестный глагол «${shown(tokens[0])}»`);
  const verb = tokens[0].toUpperCase();
  if (!Object.hasOwn(VERBS, verb))
    return refuse("unknown_verb", `неизвестный глагол «${shown(tokens[0])}»`);
  const limit = verb === "PLANT" || verb === "CUT" ? LIMITS.words : LIMITS.tokens;
  if (tokens.length > limit)
    return refuse("bad_args", `${verb}: слишком много слов, не больше ${limit}`);
  const spec = VERBS[verb];
  const args = tokens.slice(1);
  const bad = (what: string) => refuse("bad_args", `${verb}: ${what}`);
  const cmd = (a: string[], kind: VerbKind = spec.kind): Cmd => ({ verb, kind, args: a });

  switch (spec.rule) {
    case "none":
      return args.length ? bad("аргументы не принимаются") : cmd([]);
    case "id":
      return args.length === 1 && ID.test(args[0]) ? cmd(args) : bad("нужен идентификатор объекта");
    case "target": {
      if (!args.length) return bad("нужен идентификатор объекта или множество");
      if (isSetExpr(args.join(" "))) {
        const expr = setExpr(args);
        if (!expr)
          return bad(
            "выражение над множествами: одно множество или два через ∩ ∪ \\ & | AND OR MINUS",
          );
        if (inBatch && expr.includes("\\"))
          return bad("в BATCH оператор \\ не поддерживается: его съедает shlex движка");
        return cmd(expr, "bulk");
      }
      return args.length === 1 && ID.test(args[0]) ? cmd(args) : bad("нужен идентификатор объекта");
    }
    case "set": {
      const expr = setExpr(args);
      if (!expr)
        return bad(
          "выражение над множествами: одно множество или два через ∩ ∪ \\ & | AND OR MINUS",
        );
      if (inBatch && expr.includes("\\"))
        return bad("в BATCH оператор \\ не поддерживается: его съедает shlex движка");
      return cmd(expr);
    }
    case "pair":
      return args.length === 2 && args.every((a) => OPERAND.test(a))
        ? cmd(args)
        : bad("нужны два операнда, например C A");
    case "wire": {
      const [from, to, rel] = args;
      if (args.length < 2 || args.length > 3 || !ID.test(from) || !ID.test(to))
        return bad("нужно: откуда куда [связь]");
      if (rel !== undefined && (!REL.test(rel) || rel.toLowerCase() === "supersedes")) {
        return bad("связь — одно слово; supersedes ставит только SUPERSEDE в CLI");
      }
      return cmd(args);
    }
    case "packet":
      if (!args.length) return cmd([]);
      if (args.length === 1 && ID.test(args[0])) return cmd(args);
      return args.length === 2 && args.every((a) => /^[A-D]$/.test(a))
        ? cmd(args)
        : bad("ничего, идентификатор или два кластера A–D");
    case "name":
      return args.length <= 1 && args.every((a) => FILE_NAME.test(a))
        ? cmd(args)
        : bad("нужно имя файла без пути");
    case "words": {
      const limit = verb === "LOOK" ? LIMITS.lookWords : LIMITS.concWords;
      return args.length <= limit && args.every((a) => WORD.test(a))
        ? cmd(args)
        : bad(`не больше ${limit} слов без кавычек и знака ;`);
    }
    case "text":
      return args.every((a) => WORD.test(a))
        ? cmd(args)
        : bad(
            "в тексте нельзя ; кавычки, обратную косую черту и скобки: для длинного текста пришлите ленту",
          );
    default:
      return bad("не разобрано");
  }
}

/** Разбор строки и ленты без прав: что это за команда и какого она класса. */
export function parsePmLine(input: PmInput): PmParsed | PmRefused {
  const line = typeof input.line === "string" ? input.line.trim() : "";
  const tape = typeof input.tape === "string" && input.tape !== "" ? input.tape : undefined;
  if (!line) return refuse("empty", "пустая команда");
  if (line.length > LIMITS.line) return refuse("too_long", `команда длиннее ${LIMITS.line} знаков`);
  if (tape !== undefined && tape.length > LIMITS.tape)
    return refuse("too_long", `лента длиннее ${LIMITS.tape} знаков`);

  const first = line.split(/\s+/u, 1)[0];
  if (first.toUpperCase() === "BATCH") {
    if (tape !== undefined) return refuse("tape", "лента допустима только для PLANT");
    return parseBatch(line.slice(first.length));
  }
  const c = parseCommand(line, false);
  if ("ok" in c) return c;
  const plants = c.verb === "PLANT" || c.verb === "CUT";
  if (tape !== undefined && !plants) return refuse("tape", "лента допустима только для PLANT");
  if (plants) {
    if (tape !== undefined) {
      if (c.args.length) return refuse("bad_args", "PLANT с лентой пишется без текста");
      return { ok: true, verb: "PLANT", kind: c.kind, argv: ["exec", "PLANT"], tape: true };
    }
    if (!c.args.length) return refuse("bad_args", "PLANT: нужна лента или текст");
    return {
      ok: true,
      verb: "PLANT",
      kind: c.kind,
      argv: ["exec", "PLANT", ...c.args],
      tape: false,
    };
  }
  return { ok: true, verb: c.verb, kind: c.kind, argv: ["exec", c.verb, ...c.args], tape: false };
}

function parseBatch(rest: string): PmParsed | PmRefused {
  const subs = rest
    .split(/[;\n\r]/u)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!subs.length) return refuse("bad_args", "BATCH: нужна хотя бы одна команда");
  if (subs.length > LIMITS.batch)
    return refuse("too_many", `в BATCH не больше ${LIMITS.batch} команд`);
  const argv = ["exec", "BATCH"];
  for (const [i, text] of subs.entries()) {
    if (text.split(/\s+/u, 1)[0].toUpperCase() === "BATCH")
      return refuse("bad_args", "BATCH внутри BATCH не разрешён");
    const c = parseCommand(text, true);
    if ("ok" in c) return refuse(c.code, `BATCH: ${c.message}`);
    if ((c.verb === "PLANT" || c.verb === "CUT") && !c.args.length)
      return refuse("bad_args", "BATCH: PLANT без текста");
    if (i) argv.push(";");
    argv.push(c.verb === "CUT" ? "PLANT" : c.verb, ...c.args);
  }
  return { ok: true, verb: "BATCH", kind: "bulk", argv, tape: false };
}

/** Разбор строки и проверка прав: анонимному — только чтение, вошедшему — всё из таблицы. */
export function buildPmArgs(input: PmInput, user: PmUser): PmParsed | PmRefused {
  const parsed = parsePmLine(input);
  if (!parsed.ok) return parsed;
  if (parsed.kind !== "read" && !user) return refuse("login_required", LOGIN_MESSAGE);
  return parsed;
}

/** Класс команды для клиента (какой серверный вызов выбрать); null — команда не пройдёт разбор. */
export function kindOf(input: PmInput): VerbKind | null {
  const parsed = parsePmLine(input);
  return parsed.ok ? parsed.kind : null;
}

/** Класс глагола по первому слову (без разбора аргументов); null — глагола нет в таблице. Нужен интерфейсу, чтобы не звать сервер зря. */
export function verbKind(word: string): VerbKind | null {
  const name = word.trim().toUpperCase();
  return Object.hasOwn(VERBS, name) ? VERBS[name].kind : null;
}

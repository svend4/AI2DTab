#!/usr/bin/env node
/**
 * Статистика корпуса: прогоняет нарезку (chunkDetailed) и классификатор
 * (classify / plantText) движка по файлу диалога и печатает JSON-отчёт.
 *
 * Запуск (TypeScript движка подключается через strip-types):
 *   node --experimental-strip-types scripts/corpus-stats.mjs [путь] \
 *        [--mode paragraph|section|auto] [--gold docs/corpus/gold.json] \
 *        [--sample docs/corpus/sample.json] [--baseline docs/corpus/baseline.json] \
 *        [--worst 10] [--no-gold]
 *
 * Путь по умолчанию — attachments/ChatGPT_2026_09_18__1900.md. Если путь
 * указывает на JSON-массив объектов с полем `text` (как sample.json), корпусом
 * считается склейка этих текстов через пустую строку.
 *
 * Отчёт: байты, строки, блоки, секции, различные номера секций, распределение
 * типов и причин (why), ячейки по отношению, блоки короче 24 символов,
 * дубликаты id, p50/p90/p99/max длины, время работы. При наличии gold+sample —
 * точность/полнота классификатора по типам, точность/полнота ячеек, матрица
 * ошибок, доля склеенных блоков merge_with_prev и список худших ошибок.
 * Поле `before` — цифры v2.0 из baseline.json (колонка «до» в docs/CORPUS.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { chunkDetailed, classify, countNumbered, plantText, unquote } from "../src/engine/plant.ts";
import { parseCell } from "../src/engine/cells.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHORT = 24;
const NUMBERED = /^#{1,3}\s+(\d+)\.\s/;
const FENCE = /^\s*(```|~~~)/;

// ---------- аргументы ----------
function parseArgs(argv) {
  const a = { path: null, mode: "auto", gold: null, sample: null, baseline: null, worst: 10, noGold: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--mode") a.mode = argv[++i];
    else if (x === "--gold") a.gold = argv[++i];
    else if (x === "--sample") a.sample = argv[++i];
    else if (x === "--baseline") a.baseline = argv[++i];
    else if (x === "--worst") a.worst = Number(argv[++i]) || 0;
    else if (x === "--no-gold") a.noGold = true;
    else if (x === "--help" || x === "-h") {
      console.log("node --experimental-strip-types scripts/corpus-stats.mjs [path] [--mode paragraph|section|auto] [--gold g.json --sample s.json] [--baseline b.json] [--worst N] [--no-gold]");
      process.exit(0);
    } else if (!a.path) a.path = x;
  }
  if (!["paragraph", "section", "auto"].includes(a.mode)) throw new Error(`--mode: ожидается paragraph|section|auto, получено ${a.mode}`);
  const def = (p) => (existsSync(resolve(ROOT, p)) ? resolve(ROOT, p) : null);
  a.path = resolve(ROOT, a.path || "attachments/ChatGPT_2026_09_18__1900.md");
  a.gold = a.gold ? resolve(ROOT, a.gold) : def("docs/corpus/gold.json");
  a.sample = a.sample ? resolve(ROOT, a.sample) : def("docs/corpus/sample.json");
  a.baseline = a.baseline ? resolve(ROOT, a.baseline) : def("docs/corpus/baseline.json");
  return a;
}

// ---------- корпус ----------
function loadCorpus(path) {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length && typeof arr[0]?.text === "string") {
      return { text: arr.map((x) => x.text).join("\n\n"), note: `JSON-массив из ${arr.length} текстов, склеен через пустую строку` };
    }
  }
  return { text: raw, note: null };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function inc(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function sortedObj(obj) {
  return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
}

function round(x, d = 3) {
  return x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
}

function corpusStats(text, mode) {
  const lines = unquote(text);
  const numberedHeadings = countNumbered(lines);
  const resolvedMode = mode !== "auto" ? mode : numberedHeadings >= 20 ? "section" : "paragraph";

  const t0 = performance.now();
  const chunks = chunkDetailed(text, { mode });
  const t1 = performance.now();

  const types = {};
  const whys = {};
  const rels = {};
  let cells = 0;
  const lens = [];
  let short = 0;
  const shortFreq = {};
  let sections = 0;
  const sectionNumbers = new Set();
  let fenceOnly = 0;
  let turns = 0;
  for (const c of chunks) {
    const k = classify(c.text);
    inc(types, k.type);
    inc(whys, k.why);
    const cell = parseCell(k.title);
    if (cell) {
      cells++;
      inc(rels, cell.rel);
    }
    lens.push(c.text.length);
    if (c.text.length < SHORT) {
      short++;
      inc(shortFreq, c.text);
    }
    if (c.kind === "section") sections++;
    const m = c.text.match(NUMBERED);
    if (m) sectionNumbers.add(m[1]);
    if (FENCE.test(c.text)) fenceOnly++;
    if (c.turn > turns) turns = c.turn;
  }
  const t2 = performance.now();

  const seedlings = plantText(text, { mode });
  const t3 = performance.now();

  const ids = new Set();
  let suffixed = 0;
  for (const s of seedlings) {
    ids.add(s.id);
    if (/^(S\d+|[A-Z]-[0-9a-z]{10})-\d+$/.test(s.id)) suffixed++;
  }
  lens.sort((a, b) => a - b);

  return {
    mode: { requested: mode, resolved: resolvedMode, numbered_headings: numberedHeadings },
    bytes: Buffer.byteLength(text, "utf8"),
    lines: lines.length,
    turns,
    chunks: chunks.length,
    sections,
    distinct_section_numbers: sectionNumbers.size,
    repeated_section_numbers: sections - sectionNumbers.size,
    fence_only_chunks: fenceOnly,
    types: sortedObj(types),
    why: sortedObj(whys),
    cells,
    cells_by_rel: sortedObj(rels),
    short_lt24: short,
    top_short: Object.entries(shortFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([text, n]) => ({ text, n })),
    duplicates: {
      seedlings: seedlings.length,
      unique_ids: ids.size,
      same_text_dropped: chunks.length - seedlings.length,
      id_collisions_suffixed: suffixed,
    },
    length: { p50: percentile(lens, 0.5), p90: percentile(lens, 0.9), p99: percentile(lens, 0.99), max: lens.at(-1) ?? 0 },
    timing_ms: { chunk: round(t1 - t0, 1), classify: round(t2 - t1, 1), plantText: round(t3 - t2, 1), total: round(t3 - t0, 1) },
    _chunks: chunks,
  };
}

// ---------- золото ----------
function prf(tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  return { precision: round(precision), recall: round(recall), f1: round(f1) };
}

function goldStats(goldPath, samplePath, chunks, worstN) {
  const gold = JSON.parse(readFileSync(goldPath, "utf8"));
  const sample = JSON.parse(readFileSync(samplePath, "utf8"));
  const byIdx = new Map(sample.map((s) => [s.idx, s]));
  const items = gold.gold.filter((g) => byIdx.has(g.idx));

  const typesSeen = new Set();
  const confusion = {};
  let correct = 0;
  const cell = { tp: 0, fp: 0, fn: 0 };
  const perType = {};
  const errors = [];
  let unanimousCorrect = 0;
  let unanimous = 0;
  for (const g of items) {
    const s = byIdx.get(g.idx);
    const k = classify(s.text);
    const pred = k.type;
    typesSeen.add(g.type);
    typesSeen.add(pred);
    confusion[g.type] ??= {};
    inc(confusion[g.type], pred);
    perType[g.type] ??= { gold: 0, machine: 0, tp: 0 };
    perType[pred] ??= { gold: 0, machine: 0, tp: 0 };
    perType[g.type].gold++;
    perType[pred].machine++;
    if (pred === g.type) {
      correct++;
      perType[pred].tp++;
    } else {
      errors.push({ idx: g.idx, gold: g.type, machine: pred, why: k.why, type_agree: g.type_agree, text: s.text.replace(/\s+/g, " ").slice(0, 110) });
    }
    if (g.type_agree === gold.labelers) {
      unanimous++;
      if (pred === g.type) unanimousCorrect++;
    }
    const predCell = parseCell(k.title) !== null;
    if (predCell && g.is_cell) cell.tp++;
    else if (predCell && !g.is_cell) cell.fp++;
    else if (!predCell && g.is_cell) cell.fn++;
  }
  const per_type = {};
  for (const t of [...typesSeen].sort()) {
    const p = perType[t];
    per_type[t] = { gold: p.gold, machine: p.machine, ...prf(p.tp, p.machine - p.tp, p.gold - p.tp) };
  }
  // noise: классификатор его не выдаёт — все gold-noise считаются промахом
  if (!per_type.noise) per_type.noise = { gold: 0, machine: 0, precision: null, recall: null, f1: null, note: "classify() не выдаёт noise" };

  // merge_with_prev: склеил ли новый нарезчик блок с соседом
  const chunkSet = new Set(chunks.map((c) => c.text));
  const joined = "\u0000" + chunks.map((c) => c.text).join("\u0000") + "\u0000";
  const merge = { gold: 0, merged: 0, standalone: 0, not_found: 0 };
  for (const g of items) {
    if (!g.merge_with_prev) continue;
    merge.gold++;
    const text = byIdx.get(g.idx).text;
    if (chunkSet.has(text)) {
      merge.standalone++;
      continue;
    }
    const i = joined.indexOf(text);
    if (i < 0) merge.not_found++;
    else if (joined[i - 1] === "\u0000" && (joined[i + text.length] === "\u0000" || text.length >= 1500)) merge.standalone++;
    else merge.merged++;
  }

  // худшие ошибки: сперва единогласные у судей, затем длинные тексты
  errors.sort((a, b) => b.type_agree - a.type_agree || b.text.length - a.text.length);

  return {
    labelers: gold.labelers,
    sample: items.length,
    type_accuracy: round(correct / items.length),
    unanimous: { n: unanimous, accuracy: round(unanimous ? unanimousCorrect / unanimous : null) },
    per_type,
    cell: { gold: cell.tp + cell.fn, machine: cell.tp + cell.fp, ...prf(cell.tp, cell.fp, cell.fn) },
    confusion,
    merge_with_prev: { ...merge, merged_share: round(merge.gold ? merge.merged / merge.gold : null) },
    errors: errors.length,
    worst: errors.slice(0, worstN),
  };
}

// ---------- запуск ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const { text, note } = loadCorpus(args.path);
  const stats = corpusStats(text, args.mode);
  const { _chunks, ...corpus } = stats;
  const report = { source: { path: args.path.replace(ROOT + "/", ""), note }, corpus };
  if (!args.noGold && args.gold && args.sample) {
    report.gold = {
      gold: args.gold.replace(ROOT + "/", ""),
      sample: args.sample.replace(ROOT + "/", ""),
      ...goldStats(args.gold, args.sample, _chunks, args.worst),
    };
  }
  if (args.baseline) {
    const b = JSON.parse(readFileSync(args.baseline, "utf8"));
    report.before = {
      baseline: args.baseline.replace(ROOT + "/", ""),
      version: b.version,
      type_accuracy: b.type_accuracy,
      per_type: b.per_type,
      cell: b.cell,
      corpus_naive: b.corpus_naive,
      corpus_unquoted_prototype: b.corpus_unquoted_prototype,
      gold_summary: b.gold_summary,
    };
  }
  process.stdout.write(JSON.stringify(report, null, 1) + "\n");
}

main();

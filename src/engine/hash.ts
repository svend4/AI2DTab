/**
 * Хеш абзаца → часть id. Два прохода FNV-1a (прямой и по развёрнутой строке)
 * дают 48 бит: при 30 тыс. абзацев ожидаемое число коллизий ~2e-6
 * (у 32-битного варианта v2.0 было ~19%). Коллизию с другим текстом движок
 * всё равно проверяет по hash и разводит суффиксом.
 */
function fnv32(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 48-битный хеш как base36 (10 символов). */
export function fnv1a(text: string): string {
  const a = fnv32(text);
  const rev = text.split("").reverse().join("");
  const b = fnv32(rev, 0x050c5d1f) & 0xffff; // 16 бит
  // 32 + 16 = 48 бит: ≤ 10 символов base36, умещается в double без потерь
  const n = a * 0x10000 + b;
  return n.toString(36).padStart(10, "0");
}

/** Нормализация перед хешем: регистр, пробелы, markdown-маркеры только на границах токенов. */
export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|\s)[`*_>#-]+/g, "$1")
    .replace(/[`*_]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

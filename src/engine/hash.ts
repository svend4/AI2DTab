/** FNV-1a 32 бит → base36. Детерминированный id для абзаца: посадка идемпотентна. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(-6);
}

export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`*_>#-]+/g, "")
    .trim();
}

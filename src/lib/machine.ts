import type { Event, Row } from "./desk-store";

export function dumpTsv(rows: Row[]): string {
  const head = ["id", "cluster", "layer", "type", "title", "status", "body"];
  const esc = (s: string) => s.replace(/\t/g, " ").replace(/\n/g, " / ");
  const lines = [head.join("\t")];
  for (const r of rows) {
    lines.push(head.map((h) => esc(String(r[h as keyof Row] ?? ""))).join("\t"));
  }
  return lines.join("\n");
}

export function machineStatus(rows: Row[], events: Event[]) {
  return {
    L1: rows.filter((r) => r.source === "лента").length,
    L2_raw: rows.filter((r) => r.status === "raw").length,
    L3_canon: rows.filter((r) => r.status === "accepted").length,
    L2_rejected: rows.filter((r) => r.status === "rejected").length,
    last: events.slice(0, 5).map((e) => `${e.cmd} ${e.id}`),
  };
}

export function downloadText(name: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

import type { Instr } from "@/components/instruments";
import { dumpTsv } from "@/lib/machine";
import { pmExec } from "@/lib/pm-api";
import { useDesk, type Row } from "@/lib/desk-store";

export type BridgeOut = { ok: boolean; stdout: string; stderr: string };

export async function bridge(line: string, extra?: { tape?: string; file?: string }): Promise<BridgeOut> {
  try {
    return await pmExec({ data: { line, tape: extra?.tape, file: extra?.file } });
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : "bridge" };
  }
}

function asRow(r: Record<string, string>, status: Row["status"]): Row {
  return {
    id: r.id,
    cluster: r.cluster || "C",
    layer: String(r.layer || "2"),
    type: r.type || "observation",
    title: r.title || r.id,
    body: r.body || "",
    source: "sqlite",
    status,
    pred: r.pred || undefined,
    rel: r.rel || undefined,
    obj: r.obj || undefined,
  };
}

function parseSheet(text: string, status: Row["status"]): Row[] {
  const lines = text.trim().split(/\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0].split("\t");
  const out: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const rec: Record<string, string> = {};
    head.forEach((h, i) => {
      rec[h] = cells[i] ?? "";
    });
    if (!rec.id) continue;
    out.push(asRow(rec, status));
  }
  return out;
}

export async function refreshCanon(): Promise<Row[]> {
  const out = await bridge("CANON");
  const rows = parseSheet(out.stdout, "accepted");
  useDesk.getState().setCanon(rows);
  return rows;
}

export async function refreshPlane(): Promise<Row[]> {
  const out = await bridge("RAW");
  const rows = parseSheet(out.stdout, "raw");
  useDesk.getState().setPlane(rows);
  return rows;
}

export async function refreshInstr(): Promise<void> {
  const out = await bridge("INSTR");
  const line = out.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return;
  try {
    useDesk.getState().setInstr(JSON.parse(line) as Instr);
  } catch {
    /* keep last */
  }
}

export async function refreshWires(): Promise<void> {
  const out = await bridge("PACKET");
  const wires = [];
  for (const line of out.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+-([^-]+)->\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    wires.push({ from: m[1], rel: m[2].trim(), to: m[3], note: (m[4] || "").trim() });
  }
  useDesk.getState().setWires(wires);
}

export async function refreshBook(): Promise<void> {
  const out = await bridge("JSON");
  const line = (out.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  if (line) {
    try {
      const d = JSON.parse(line) as {
        instr: Instr;
        raw: Record<string, string>[];
        canon: Record<string, string>[];
        wires: { from: string; rel: string; to: string; note: string }[];
      };
      const s = useDesk.getState();
      s.setPlane((d.raw || []).map((r) => asRow(r, "raw")));
      s.setCanon((d.canon || []).map((r) => asRow(r, "accepted")));
      s.setInstr(d.instr);
      s.setWires(d.wires || []);
      return;
    } catch {
      /* four calls */
    }
  }
  await refreshPlane();
  await refreshCanon();
  await refreshInstr();
  await refreshWires();
}

export async function plantToDb(rows: Row[]): Promise<BridgeOut> {
  if (!rows.length) return { ok: true, stdout: "", stderr: "" };
  const r = await bridge("PLANT", { tape: dumpTsv(rows) });
  await refreshBook();
  return r;
}

export async function acceptBoth(id: string): Promise<BridgeOut> {
  useDesk.getState().accept(id);
  const out = await bridge(`ACCEPT ${id}`);
  await refreshBook();
  return out;
}

export async function takeBoth(id: string): Promise<BridgeOut> {
  useDesk.getState().reject(id);
  const out = await bridge(`TAKE ${id}`);
  await refreshBook();
  return out;
}

export async function runBoth(id: string): Promise<BridgeOut> {
  useDesk.getState().run(id);
  const out = await bridge(`RUN ${id}`);
  await refreshBook();
  return out;
}

export async function fetchBoth(): Promise<BridgeOut> {
  useDesk.getState().fetchNew();
  const out = await bridge("FETCH");
  await refreshBook();
  return out;
}

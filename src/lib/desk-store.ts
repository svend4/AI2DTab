import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseTape, type Planted } from "./parse-l1";
import type { Instr } from "@/components/instruments";

export type RowStatus = "raw" | "accepted" | "rejected";

export type Row = Planted & { status: RowStatus };

export type Event = { at: string; cmd: string; id: string; note: string };

export type Wire = { from: string; rel: string; to: string; note: string };

function seedRows(): Row[] {
  return [];
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

type Desk = {
  tape: string;
  rows: Row[];
  events: Event[];
  setTape: (t: string) => void;
  plant: () => number;
  mergeRows: (incoming: Planted[]) => number;
  accept: (id: string) => void;
  reject: (id: string) => void;
  run: (id: string) => void;
  fetchNew: () => void;
  resetDesk: () => void;
  look: string;
  cluster: string;
  canon: Row[];
  plane: Row[];
  instr: Instr | null;
  wires: Wire[];
  setLook: (q: string) => void;
  setCluster: (c: string) => void;
  setCanon: (rows: Row[]) => void;
  setPlane: (rows: Row[]) => void;
  setInstr: (i: Instr | null) => void;
  setWires: (w: Wire[]) => void;
  execLine: (line: string) => string;
};

export const useDesk = create<Desk>()(
  persist(
    (set, get) => ({
      tape: "",
      look: "",
      cluster: "",
      canon: [],
      plane: [],
      instr: null,
      wires: [],
      rows: seedRows(),
      events: [{ at: "seed", cmd: "SEED", id: "-", note: "seed raw packets on L2" }],
      setTape: (tape) => set({ tape }),
      setLook: (look) => set({ look }),
      setCluster: (cluster) => set({ cluster }),
      setCanon: (canon) => set({ canon }),
      setPlane: (plane) => set({ plane }),
      setInstr: (instr) => set({ instr }),
      setWires: (wires) => set({ wires }),

      execLine: (line) => {
        const raw = line.trim();
        const [cmd, ...rest] = raw.split(/\s+/);
        const arg = rest.join(" ").trim();
        const C = (cmd || "").toUpperCase();
        if (!C) return "empty";
        if (C === "STATUS") {
          const rows = get().rows;
          const msg = `raw=${rows.filter((r) => r.status === "raw").length} canon=${rows.filter((r) => r.status === "accepted").length}`;
          set({
            events: [{ at: stamp(), cmd: "STATUS", id: "-", note: msg }, ...get().events].slice(0, 80),
          });
          return msg;
        }
        if (C === "LOOK") {
          get().setLook(arg);
          const n = get().rows.filter((r) =>
            (r.title + r.body + r.id).toLowerCase().includes(arg.toLowerCase()),
          ).length;
          return `LOOK ${arg} → ${n}`;
        }
        if (C === "PLANT" || C === "CUT") {
          if (arg) set({ tape: `${get().tape}\n\n${arg}`.trim() });
          return `PLANT ${get().plant()}`;
        }
        if (C === "ACCEPT") {
          get().accept(arg);
          return `ACCEPT ${arg}`;
        }
        if (C === "TAKE") {
          get().reject(arg);
          return `TAKE ${arg}`;
        }
        if (C === "RUN") {
          get().run(arg);
          return `RUN ${arg}`;
        }
        if (C === "FETCH") {
          get().fetchNew();
          return "FETCH";
        }
        if (C === "RESET") {
          get().resetDesk();
          return "RESET";
        }
        if (C === "DUMP") return "DUMP";
        return `unknown ${C}`;
      },
      plant: () => {
        const { tape, rows } = get();
        const incoming = parseTape(tape, rows.length + 1);
        return get().mergeRows(incoming);
      },
      mergeRows: (incoming) => {
        const { rows, events } = get();
        const have = new Set(rows.map((r) => r.id));
        const add: Row[] = [];
        for (const r of incoming) {
          let id = r.id;
          if (have.has(id)) id = `${r.id}-${add.length + 1}`;
          have.add(id);
          add.push({ ...r, id, status: "raw" });
        }
        set({
          rows: [...rows, ...add],
          events: [
            { at: stamp(), cmd: "PLANT", id: String(add.length), note: `L2 +${add.length}` },
            ...events,
          ].slice(0, 80),
        });
        return add.length;
      },
      accept: (id) => {
        const row = get().rows.find((r) => r.id === id);
        if (!row || row.type === "session" || row.type === "tape") {
          set({
            events: [
              { at: stamp(), cmd: "REFUSE", id, note: "session/tape not canon" },
              ...get().events,
            ].slice(0, 80),
          });
          return;
        }
        set({
          rows: get().rows.map((r) => (r.id === id ? { ...r, status: "accepted" } : r)),
          events: [{ at: stamp(), cmd: "ACCEPT", id, note: row.title }, ...get().events].slice(0, 80),
        });
      },
      reject: (id) =>
        set({
          rows: get().rows.map((r) => (r.id === id ? { ...r, status: "rejected" } : r)),
          events: [{ at: stamp(), cmd: "TAKE", id, note: "subtract" }, ...get().events].slice(0, 80),
        }),
      run: (id) => {
        const row = get().rows.find((r) => r.id === id);
        if (!row || row.status !== "accepted") return;
        set({
          events: [
            { at: stamp(), cmd: "RUN", id, note: `L4 ran ${row.title}` },
            ...get().events,
          ].slice(0, 80),
        });
      },
      fetchNew: () =>
        set({
          tape: `${get().tape}\n\nFETCH ${stamp()}: what is missing in canon for sense?`.trim(),
          events: [
            { at: stamp(), cmd: "FETCH", id: "L1", note: "new tape" },
            ...get().events,
          ].slice(0, 80),
        }),
      resetDesk: () =>
        set({
          tape: "",
          rows: seedRows(),
          canon: [],
          plane: [],
          events: [{ at: "seed", cmd: "RESET", id: "-", note: "desk reset" }],
        }),
    }),
    { name: "desk-l1-l4", partialize: (s) => ({ tape: s.tape }) },
  ),
);

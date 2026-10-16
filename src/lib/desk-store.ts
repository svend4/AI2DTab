import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Planted } from "./parse-l1";
import type { Instr } from "@/components/instruments";

export type RowStatus = "raw" | "accepted" | "rejected";

export type Row = Planted & { status: RowStatus };

export type Event = { at: string; cmd: string; id: string; note: string };

export type Wire = { from: string; rel: string; to: string; note: string };

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

type Desk = {
  tape: string;
  events: Event[];
  setTape: (t: string) => void;
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
  /** Причина, почему стол не обновился (чтение); пусто, когда всё в порядке. В сохранённое состояние не входит. */
  notice: string | null;
  setNotice: (notice: string | null) => void;
  /** Пометка «ответ обрезан» (O8): тихая строка, не уведомление. В сохранённое состояние не входит. */
  bookCut: string | null;
  setBookCut: (cut: string | null) => void;
  /** Исход последней записи: отказ, сбой или пометка о пропусках. Не стирается обновлением книги, только следующей записью или «Скрыть». */
  writeNotice: string | null;
  setWriteNotice: (notice: string | null) => void;
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
      events: [{ at: "seed", cmd: "SEED", id: "-", note: "seed raw packets on L2" }],
      setTape: (tape) => set({ tape }),
      setLook: (look) => set({ look }),
      setCluster: (cluster) => set({ cluster }),
      setCanon: (canon) => set({ canon }),
      setPlane: (plane) => set({ plane }),
      setInstr: (instr) => set({ instr }),
      setWires: (wires) => set({ wires }),
      notice: null,
      setNotice: (notice) => set({ notice }),
      bookCut: null,
      setBookCut: (bookCut) => set({ bookCut }),
      writeNotice: null,
      setWriteNotice: (writeNotice) => set({ writeNotice }),

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
          canon: [],
          plane: [],
          events: [{ at: "seed", cmd: "RESET", id: "-", note: "desk reset" }],
        }),
    }),
    { name: "desk-l1-l4", partialize: (s) => ({ tape: s.tape }) },
  ),
);

import { create } from "zustand";
import { NEXT, PACKETS, type Packet, type Stage } from "./cycle-data";

export type ViewMode = "rhombus" | "eight" | "iso";

export type Token = {
  packetId: string;
  at: Stage;
  waiting: boolean;
  log: string;
};

type State = {
  view: ViewMode;
  running: boolean;
  deadlock: boolean;
  brake: Record<Stage, boolean>;
  tokens: Token[];
  canon: string[];
  log: string[];
  selected: string | null;
  setView: (v: ViewMode) => void;
  toggleRun: () => void;
  toggleDeadlock: () => void;
  toggleBrake: (s: Stage) => void;
  select: (id: string | null) => void;
  tick: () => void;
  reset: () => void;
};

function seedTokens(): Token[] {
  return PACKETS.map((p, i) => ({
    packetId: p.id,
    at: "L1",
    waiting: false,
    log: i === 0 ? "на ленте" : "на ленте",
  }));
}

function packet(id: string): Packet {
  return PACKETS.find((p) => p.id === id)!;
}

export const useCycle = create<State>((set, get) => ({
  view: "rhombus",
  running: true,
  deadlock: false,
  brake: { L1: false, L2: false, L3: false, L4: false },
  tokens: seedTokens(),
  canon: [],
  log: ["четыре такта. не маятник."],
  selected: "S17042",
  setView: (view) => set({ view }),
  toggleRun: () => set({ running: !get().running }),
  toggleDeadlock: () =>
    set({
      deadlock: !get().deadlock,
      log: [
        get().deadlock
          ? "ромб восстановлен: L1→L2→L3→L4"
          : "тупик: лента кормит действие, плоскость выключена",
        ...get().log,
      ].slice(0, 12),
    }),
  toggleBrake: (s) =>
    set({
      brake: { ...get().brake, [s]: !get().brake[s] },
    }),
  select: (selected) => set({ selected }),
  reset: () =>
    set({
      tokens: seedTokens(),
      canon: [],
      log: ["сброс. все пакеты снова на ленте."],
      deadlock: false,
      brake: { L1: false, L2: false, L3: false, L4: false },
    }),
  tick: () => {
    const { running, deadlock, brake, tokens, canon, log } = get();
    if (!running) return;
    const notes: string[] = [];
    const nextCanon = [...canon];
    const nextTokens = tokens.map((t) => {
      if (brake[t.at]) {
        return { ...t, waiting: true, log: `тормоз ${t.at}` };
      }
      const p = packet(t.packetId);
      let dest: Stage = deadlock
        ? t.at === "L1"
          ? "L4"
          : t.at === "L4"
            ? "L1"
            : t.at
        : NEXT[t.at];

      if (deadlock && (t.at === "L2" || t.at === "L3")) {
        dest = "L1";
        notes.push(`${p.id}: тупик сбросил с ${t.at}`);
      }

      if (!deadlock && t.at === "L2" && dest === "L3") {
        if (!p.canCanon) {
          notes.push(`${p.id}: отказ — ${p.refuse}`);
          dest = "L1";
          return { ...t, at: dest, waiting: false, log: "вычтено, снова лента" };
        }
        if (!nextCanon.includes(p.id)) {
          nextCanon.push(p.id);
          notes.push(`${p.id} → канон`);
        }
      }

      if (!deadlock && t.at === "L4" && dest === "L1") {
        notes.push(`${p.id}: FETCH нового L1`);
      }

      return { ...t, at: dest, waiting: false, log: `→ ${dest}` };
    });
    set({
      tokens: nextTokens,
      canon: nextCanon,
      log: [...notes, ...log].slice(0, 14),
    });
  },
}));

export type Stage = "L1" | "L2" | "L3" | "L4";

export type PacketKind = "observation" | "artifact" | "session" | "tape" | "decision";

export type Packet = {
  id: string;
  title: string;
  kind: PacketKind;
  cluster: "A" | "B" | "C" | "D";
  source: string;
  body: string;
  canCanon: boolean;
  refuse?: string;
};

export const STAGES: { id: Stage; name: string; role: string; shell: string }[] = [
  { id: "L1", name: "Лента", role: "сырьё во времени", shell: "раковина" },
  { id: "L2", name: "Плоскость", role: "семь полей, +/−", shell: "улитка" },
  { id: "L3", name: "Память", role: "канон человека", shell: "раковина" },
  { id: "L4", name: "Действие", role: "драйвер по id", shell: "улитка" },
];

export const HOPS: { from: Stage; to: Stage; cmd: string; law: string }[] = [
  { from: "L1", to: "L2", cmd: "CUT · PLANT", law: "нарезка и посадка, не понимание" },
  { from: "L2", to: "L3", cmd: "ACCEPT", law: "очередь +/−, человек ставит канон" },
  { from: "L3", to: "L4", cmd: "NEXT · RUN", law: "исполнить id, не смысл" },
  { from: "L4", to: "L1", cmd: "FETCH · PACKET", law: "новое сырьё, не тот же абзац" },
];

export const PACKETS: Packet[] = [
  {
    id: "S17042",
    title: "слово ≠ смысл",
    kind: "observation",
    cluster: "C",
    source: "этаж 17041",
    body: "Одинаковое слово не гарантирует одинаковый смысл. id стабилен, title может смениться.",
    canCanon: true,
  },
  {
    id: "S17326",
    title: "Discussion ≠ Decision",
    kind: "observation",
    cluster: "C",
    source: "этаж 17041",
    body: "Разговор на плоскости не есть решение. observation ≠ decision.",
    canCanon: true,
  },
  {
    id: "S17451",
    title: "Contract ≠ implementation",
    kind: "observation",
    cluster: "C",
    source: "этаж 17041",
    body: "Семь полей — договор. Текст в body — не новая колонка.",
    canCanon: true,
  },
  {
    id: "U001",
    title: "Статья Enbek, 17 сен 2026",
    kind: "artifact",
    cluster: "A",
    source: "ход U001",
    body: "Цифровой профиль и маршрутизация занятости. Пакет в кластер A, не в OS.",
    canCanon: true,
  },
  {
    id: "D110",
    title: "Теория ступеней v0.2",
    kind: "decision",
    cluster: "B",
    source: "THEORY.md",
    body: "Ступень = закон. Лента с номерами ≠ плоскость. Канон ставит человек.",
    canCanon: true,
  },
  {
    id: "U-DA",
    title: "75 ходов «Да»",
    kind: "session",
    cluster: "C",
    source: "turns-l2",
    body: "Садятся как session/raw. Не факты проекта.",
    canCanon: false,
    refuse: "сессия ≠ факт",
  },
  {
    id: "OS-30K",
    title: "30155 секций Innovation OS",
    kind: "tape",
    cluster: "C",
    source: "корпус C",
    body: "Размеченный L1. Этажи — артефакты. Не свалка канона.",
    canCanon: false,
    refuse: "не всё сырьё — объект",
  },
];

export const NEXT: Record<Stage, Stage> = {
  L1: "L2",
  L2: "L3",
  L3: "L4",
  L4: "L1",
};

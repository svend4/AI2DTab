export type Planted = {
  id: string;
  cluster: string;
  layer: string;
  type: string;
  title: string;
  body: string;
  source: string;
  pred?: string;
  rel?: string;
  obj?: string;
};

function plantBlock(text: string, n: number): Planted {
  const t = text.trim();
  const low = t.toLowerCase();
  const first = t.split(/\n/)[0]?.slice(0, 140) || `блок ${n}`;
  if (/^https?:\/\//i.test(t)) {
    return {
      id: `A${n}`,
      cluster: "A",
      layer: "2",
      type: "artifact",
      title: t.split(/\s/)[0].slice(0, 120),
      body: t.slice(0, 800),
      source: "лента",
    };
  }
  if (low.includes("продолжен") || low === "да" || low.startsWith("да.")) {
    return {
      id: `U${String(n).padStart(3, "0")}`,
      cluster: "C",
      layer: "2",
      type: "session",
      title: low.includes("продолжен") ? "Продолжение" : "Да",
      body: t.slice(0, 400),
      source: "лента",
    };
  }
  if (/≠|инвариант|invariant|negative boundary/i.test(t)) {
    return {
      id: `C${n}`,
      cluster: "C",
      layer: "2",
      type: "observation",
      title: first,
      body: t.slice(0, 1200),
      source: "лента",
    };
  }
  if (t.includes("?") || /^как |^что |^зачем /i.test(t)) {
    return {
      id: `Q${n}`,
      cluster: "C",
      layer: "2",
      type: "question",
      title: first,
      body: t.slice(0, 800),
      source: "лента",
    };
  }
  const heading = t.match(/^#{1,3}\s+(\d+)\.\s+(.+)/);
  if (heading) {
    return {
      id: `S${heading[1]}`,
      cluster: "C",
      layer: "2",
      type: "observation",
      title: heading[2].slice(0, 160),
      body: t.slice(0, 1200),
      source: `секция ${heading[1]}`,
    };
  }
  return {
    id: `B${n}`,
    cluster: "C",
    layer: "2",
    type: "observation",
    title: first,
    body: t.slice(0, 800),
    source: "лента",
  };
}

export function parseTape(raw: string, start = 1): Planted[] {
  const chunks = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  return chunks.map((c, i) => plantBlock(c, start + i));
}

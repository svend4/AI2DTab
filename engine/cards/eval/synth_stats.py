"""Статистика по набору synth: точность вариантов с доверительными интервалами и парное сравнение с базой по вопросам.

    python3 synth_stats.py OUT [--base tools] [--include-invalid]

Вопросов мало (17 проверенных), прогонов 2–3: поэтому помимо долей — 95% интервал Уилсона (по ответам) и парная бутстрап-оценка разницы по вопросам
с базовым вариантом (для каждого вопроса берётся доля верных ответов среди прогонов; вопросы пересэмплируются). Если интервал разницы содержит 0,
различие нельзя отличить от шума.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import random
import re
from pathlib import Path

from score import DATA, check, load


def wilson(k, n, z=1.96):
    if not n:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (c - w) / d), min(1.0, (c + w) / d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--base", default="tools")
    ap.add_argument("--include-invalid", action="store_true")
    ns = ap.parse_args()
    qs = {q["id"]: q for q in json.loads((DATA / "questions_synth.json").read_text(encoding="utf-8"))}
    use = {i for i, q in qs.items() if ns.include_invalid or not q.get("invalid")}
    runs = load(Path(ns.out))
    per = collections.defaultdict(lambda: collections.defaultdict(list))        # arm -> вопрос -> [0/1 по прогонам]
    cost = collections.defaultdict(list)
    for (s, arm), docs in runs.items():
        if s != "synth":
            continue
        for d in docs:
            usd = 0.0
            for t in d["turns"]:
                if t["id"] not in use:
                    continue
                per[arm][t["id"]].append(int(check(qs[t["id"]], t.get("ans") or "")))
                usd += (t["i"] * 2.0 + t["w"] * 4.0 + t["cr"] * 0.10 + t["o"] * 10.0) / 1e6
            cost[arm].append(usd)
    rnd = random.Random(1)
    base = per.get(ns.base, {})
    ids = sorted(use)
    print(f"{'вариант':<12} {'прогонов':>8} {'верно':>9} {'доля':>6} {'95% ДИ':>11}   разница с {ns.base} (по вопросам, 95% бутстрап)   $ за вопрос")
    for arm in ("none", "tools", "wiki-files", "notes-l1", "cards-grep", "cards-l1", "wiki-only", "wiki-only2"):
        if arm not in per:
            continue
        k = sum(sum(v) for v in per[arm].values())
        n = sum(len(v) for v in per[arm].values())
        lo, hi = wilson(k, n)
        diff = ""
        if arm != ns.base and base:
            m = [i for i in ids if i in per[arm] and i in base]
            a = [sum(per[arm][i]) / len(per[arm][i]) for i in m]
            b = [sum(base[i]) / len(base[i]) for i in m]
            d0 = sum(x - y for x, y in zip(a, b)) / len(m)
            boots = sorted(sum((a[j] - b[j]) for j in (rnd.randrange(len(m)) for _ in m)) / len(m) for _ in range(5000))
            diff = f"{100 * d0:+5.1f} п.п. [{100 * boots[125]:+.1f}; {100 * boots[4875]:+.1f}]"
        per_q = sum(cost[arm]) / max(1, n)
        print(f"{arm:<12} {len(next(iter(per[arm].values()))):>8} {k:>4}/{n:<4} {100 * k / n:5.0f}% {100 * lo:4.0f}–{100 * hi:<4.0f}%   {diff:<44} {per_q:.4f}")


if __name__ == "__main__":
    main()

"""Сводка по журналу фактов: python3 ledger_report.py OUT [--md]

По вариантам: верные ответы на проверочные вопросы по видам, размер промпта на проверках, токены и цена, число записей в журнал.
Цена: малая модель по справочнику цен — вход $0.10, запись в кэш на 1 час $0.20, чтение $0.01, вывод $0.50 за миллион токенов для промптов до 100K;
для более длинных промптов все ставки в 5 раз выше. С этой надбавкой пересчёт совпадает с ценой, которую сообщает CLI (проверено на 5 прогонах).
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import statistics
from pathlib import Path

ORDER = ["plain", "compact", "ledger-user", "ledger"]
RATES = dict(i=0.10, w=0.20, cr=0.01, o=0.50)


def usd_of(d) -> float:
    """Цена прогона по токенам; ход с промптом длиннее 100K токенов — по ставкам ×5."""
    return sum((t["i"] * RATES["i"] + t["w"] * RATES["w"] + t["cr"] * RATES["cr"] + t["o"] * RATES["o"]) * (5 if t["size"] > 100_000 else 1) / 1e6
               for t in d["turns"] if "i" in t and t.get("kind") != "ledger")
NAMES = {"plain": "лента без сжатия", "compact": "лента + /compact", "ledger-user": "журнал (только факты пользователя)", "ledger": "журнал (и свои выдумки)"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--md", action="store_true")
    ns = ap.parse_args()
    runs = collections.defaultdict(list)
    for p in sorted(glob.glob(str(Path(ns.out) / "ledger__*.json"))):
        d = json.loads(Path(p).read_text(encoding="utf-8"))
        runs[(d.get("noise", 70), d["arm"])].append(d)
    for noise in sorted({k[0] for k in runs}):
        print(f"\n### шум: {noise} вставок кода")
        hdr = ["вариант", "прогонов", "верно всего", "текущие", "изначальные", "сколько раз менялось", "свои названия", "промпт на проверках", "токенов на входе за прогон", "$ за прогон", "записей в журнал", "сек за прогон"]
        rows = []
        for arm in ORDER:
            ds = runs.get((noise, arm))
            if not ds:
                continue
            kinds = collections.defaultdict(lambda: [0, 0])
            for d in ds:
                for k, (a, b) in d["kinds"].items():
                    kinds[k][0] += a
                    kinds[k][1] += b
            tot = [sum(d["total"][0] for d in ds), sum(d["total"][1] for d in ds)]
            fs = [sum(t.get("fact_sets") or 0 for t in d["turns"]) for d in ds]
            f = lambda k: f"{kinds[k][0]}/{kinds[k][1]}" if k in kinds else "-"   # noqa: E731
            rows.append([NAMES[arm], str(len(ds)), f"{tot[0]}/{tot[1]}", f("current"), f("history"), f("count"), f("selfref"),
                         f"{statistics.mean(d['prompt_probe_avg'] for d in ds):,.0f}", f"{statistics.mean(d['tokens_in'] for d in ds):,.0f}",
                         f"{statistics.mean(usd_of(d) for d in ds):.3f}", f"{statistics.mean(fs):.0f}" if any(fs) else "-",
                         f"{statistics.mean(sum(t.get('secs', 0) for t in d['turns']) for d in ds):.0f}"])
        if ns.md:
            print("| " + " | ".join(hdr) + " |\n|" + "---|" * len(hdr))
            for r in rows:
                print("| " + " | ".join(r) + " |")
        else:
            w = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(hdr)]
            print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
            for r in rows:
                print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))
    # какие проверки проваливались
    for (noise, arm), ds in sorted(runs.items()):
        bad = collections.Counter()
        for d in ds:
            for t in d["turns"]:
                if t.get("ok") is False:
                    bad[t["id"]] += 1
        if bad:
            print(f"  -- {arm} (шум {noise}): " + ", ".join(f"{k}×{v}" for k, v in bad.most_common(12)))


if __name__ == "__main__":
    main()

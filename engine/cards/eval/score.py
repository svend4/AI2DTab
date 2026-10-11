"""Сводит результаты прогонов (OUT/*.json) в таблицу.

    python3 score.py OUT [--md] [--fails]

Деньги пересчитаны по токенам: вход $2, запись кэша (1 ч) $4, чтение $0.10, вывод $10 за миллион (основная модель);
отчётная цена CLI хранится рядом (usd_reported) и может отличаться.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import re
import statistics
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
QFILES = {"repo_lookup": "questions_repo_lookup.json", "repo_semantic": "questions_repo_semantic.json", "chat": "questions_chat.json", "chat_pos": "questions_chat_pos.json"}


def check(q: dict, ans: str) -> bool:
    a = (ans or "").replace("\u00a0", " ").replace("\u202f", " ")
    ok = all(re.search(rx, a, re.I) for rx in q.get("check", []))
    if q.get("forbid") and re.search(q["forbid"], a, re.I):
        ok = False
    return ok


def rescore(docs_by_key) -> int:
    """Проверки лежат в data/questions_*.json и могут уточняться; ответы сохранены, поэтому пересчитываем ok для всех прогонов разом."""
    changed = 0
    for (s, _arm), docs in docs_by_key.items():
        if s not in QFILES:
            continue
        qs = {q["id"]: q for q in json.loads((DATA / QFILES[s]).read_text(encoding="utf-8"))}
        for d in docs:
            for t in d["turns"]:
                q = qs.get(t["id"])
                if q is not None:
                    t["skip"] = bool(q.get("invalid"))
                    new = check(q, t.get("ans") or "")
                    changed += (new != t["ok"])
                    t["ok"] = new
    return changed


def load(out: Path):
    runs = collections.defaultdict(list)
    for p in sorted(glob.glob(str(out / "*.json"))):
        d = json.loads(Path(p).read_text(encoding="utf-8"))
        if "turns" not in d:
            continue
        runs[(d["set"], d["arm"])].append(d)
    return runs


def agg(docs):
    ok = n = 0
    by_type = collections.defaultdict(lambda: [0, 0])
    calls = tin = usd = out = 0
    secs, firsts, rests = [], [], []
    docs = [dict(d, turns=[x for x in d["turns"] if not x.get("skip")]) for d in docs]      # вопросы, помеченные invalid, не считаем
    for d in docs:
        t = d["turns"]
        ok += sum(x["ok"] for x in t)
        n += len(t)
        for x in t:
            by_type[x.get("type") or "-"][0] += x["ok"]
            by_type[x.get("type") or "-"][1] += 1
            secs.append(x["secs"])
        calls += sum(x["calls"] for x in t)
        tin += sum(x["i"] + x["w"] + x["cr"] for x in t)
        usd += sum(x["usd"] for x in t)
        out += sum(x["o"] for x in t)
        firsts.append(t[0]["usd"])
        rests.append(sum(x["usd"] for x in t[1:]) / max(1, len(t) - 1))
    k = len(docs)
    return dict(runs=k, ok=ok, n=n, by_type=dict(by_type), calls=calls / max(1, n), tin=tin / k, usd=usd / k,
                usd_q=usd / max(1, n), med=statistics.median(secs), first=statistics.mean(firsts), rest=statistics.mean(rests),
                usds=[sum(x["usd"] for x in d["turns"]) for d in docs], oks=[sum(x["ok"] for x in d["turns"]) for d in docs],
                ns=[len(d["turns"]) for d in docs])


ORDER = ["flat", "tools", "tools+cat", "tools+cat-llm", "cards-l1", "cards", "cards-llm"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--md", action="store_true")
    ap.add_argument("--fails", action="store_true")
    ap.add_argument("--read-rate", type=float, default=0.10, help="$ за МТок чтения кэша (в источниках расходится: 0.10 или 0.20); пересчитывает цену по токенам")
    ns = ap.parse_args()
    runs = load(Path(ns.out))
    for docs in runs.values():
        for d in docs:
            for t in d["turns"]:
                t["usd"] = (t["i"] * 2.0 + t["w"] * 4.0 + t["cr"] * ns.read_rate + t["o"] * 10.0) / 1e6
    n_changed = rescore(runs)
    if n_changed:
        print(f"(пересчитано по текущим проверкам: изменился вердикт у {n_changed} ответов)")
    sets = sorted({s for s, _ in runs})
    for s in sets:
        print(f"\n### {s}")
        hdr = ["вариант", "прогонов", "верно", "по типам", "вызовов/вопрос", "токенов на входе за прогон", "$ за прогон", "$ за вопрос", "мед. с/вопрос"]
        rows = []
        for arm in ORDER:
            if (s, arm) not in runs:
                continue
            a = agg(runs[(s, arm)])
            types = ", ".join(f"{t} {v[0]}/{v[1]}" for t, v in sorted(a["by_type"].items())) if len(a["by_type"]) > 1 else ""
            per_run = "+".join(f"{o}" for o in a["oks"])
            rows.append([arm, str(a["runs"]), f"{a['ok']}/{a['n']} ({per_run} из {a['ns'][0]})", types, f"{a['calls']:.1f}",
                         f"{a['tin']:,.0f}", f"{a['usd']:.3f}" + (f" ({min(a['usds']):.3f}–{max(a['usds']):.3f})" if a["runs"] > 1 else ""),
                         f"{a['usd_q']:.4f}", f"{a['med']:.1f}"])
        if ns.md:
            print("| " + " | ".join(hdr) + " |\n|" + "---|" * len(hdr))
            for r in rows:
                print("| " + " | ".join(r) + " |")
        else:
            if not rows:
                continue
            w = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(hdr)]
            print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
            for r in rows:
                print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))
        if ns.fails:
            for arm in ORDER:
                if (s, arm) not in runs:
                    continue
                bad = collections.defaultdict(list)
                for d in runs[(s, arm)]:
                    for x in d["turns"]:
                        if not x["ok"]:
                            bad[x["id"]].append((d["run"], (x["ans"] or "")[:90].replace("\n", " ")))
                if bad:
                    print(f"  -- неверные ответы, {arm}:")
                    for qid, lst in sorted(bad.items()):
                        print(f"     {qid}: " + " | ".join(f"r{r}: {a!r}" for r, a in lst))


if __name__ == "__main__":
    main()

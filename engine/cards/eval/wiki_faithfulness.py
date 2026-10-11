"""Насколько верны заметки, написанные малой моделью? lint проверяет, что цитата есть в тексте, но не что утверждение по ней пересказано верно.

    python3 wiki_faithfulness.py --db chat_notes.sqlite --claims compile_out/claims.json --out faith.json [--n-claims 90] [--n-pages 24]

Выборка (seed фиксирован): утверждения из шага map и обзоры страниц понятий. Судья — основная модель (EVAL_MODEL) без инструментов.
 - утверждение сверяется со строками источника (8 строк до цитаты и 70 после: цитата часто стоит на заголовке, а пересказан перечень под ним):
   supported / partial / unsupported;
 - обзор страницы сверяется с утверждениями, из которых он написан: all_supported / some_unsupported.
Это оценка по одной модели-судье, не человеческая разметка: примеры спорных случаев сохраняются в файл для просмотра.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import re
import sys
from pathlib import Path

from common import MODEL, cards, need_model

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

CLAIM_PROMPT = """You check a wiki claim against its source. SOURCE LINES come from a long chat between a user and an AI assistant (Russian with English terms).

CLAIM (written by a model): {text}

SOURCE LINES
{lines}

Decide:
- "supported": everything the claim says is stated in the source lines or follows directly from them;
- "partial": the claim is mostly right but adds, drops or changes some detail (a number, a name, an item of a list, a qualifier);
- "unsupported": the source lines do not say this, or say something different.
Return JSON only: {{"verdict": "supported|partial|unsupported", "reason": "<one short sentence>"}}"""
OVERVIEW_PROMPT = """You check a short overview written by a model from a list of claims. Use ONLY the claims as the reference.

CLAIMS (exchange id, time: claim)
{claims}

OVERVIEW
{overview}

Does the overview say anything that the claims do not support (a fact, number, name, relation or change over time that is not in the claims)?
Return JSON only: {{"verdict": "all_supported|some_unsupported", "unsupported": ["<short quote of each unsupported statement>"]}}"""


async def ask(prompt: str, sem: asyncio.Semaphore):
    async with sem:
        o = ClaudeAgentOptions(model=need_model(MODEL, "EVAL_MODEL"), tools=[], setting_sources=[], max_turns=2, max_budget_usd=1,
                               extra_args={"no-session-persistence": None}, thinking={"type": "disabled"})
        res = None
        try:
            async for m in query(prompt=prompt, options=o):
                if isinstance(m, ResultMessage):
                    res = m
        except Exception as e:  # noqa: BLE001
            print("ошибка запроса:", e, file=sys.stderr)
            return None
    if not res or not res.result:
        return None
    m = re.search(r"\{.*\}", res.result, re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        return None


def wilson(k: int, n: int, z: float = 1.96):
    if not n:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (c - w) / d), min(1.0, (c + w) / d)


async def main_async(ns):
    st = cards.Store(ns.db)
    per_turn = json.loads(Path(ns.claims).read_text(encoding="utf-8"))
    rnd = random.Random(3)
    pool = [(cid, c["name"], cl) for cid, d in sorted(per_turn.items()) for c in d["concepts"] for cl in c["claims"]]
    pick = rnd.sample(pool, min(ns.n_claims, len(pool)))
    sem = asyncio.Semaphore(6)
    cache = {}

    def lines_of(cid, l1, l2):
        if cid not in cache:
            cache[cid] = [cards.unquote(x) for x in cards.split_lines(st._card(cid)["body"])]
        ls = cache[cid]
        a, b = max(1, l1 - 8), min(len(ls), l2 + 70)       # утверждение нередко пересказывает перечень, который идёт ниже строки-заголовка с цитатой
        return "\n".join(f"{i}| {ls[i - 1]}" for i in range(a, b + 1))

    claim_prompts = [CLAIM_PROMPT.format(text=cl["text"], lines=lines_of(cid, cl["l1"], cl["l2"])) for cid, _, cl in pick]
    notes = st.con.execute("SELECT id, title, body FROM cards WHERE kind='note' AND status='active' AND summary LIKE '[concept]%' ORDER BY id").fetchall()
    pages = rnd.sample(notes, min(ns.n_pages, len(notes)))
    page_prompts = []
    for n in pages:
        body = n["body"]
        m = re.search(r"## Overview\n\n(.*?)\n\n## Timeline\n\n(.*?)(\n\nSee also:|\Z)", body, re.S)
        if not m:
            page_prompts.append(None)
            continue
        claims = "\n".join(re.sub(r"\s*\[\[n\d+\]\]\s*$", "", ln[2:]) for ln in m.group(2).split("\n") if ln.startswith("- "))
        page_prompts.append(OVERVIEW_PROMPT.format(claims=claims, overview=m.group(1)))
    res_c = await asyncio.gather(*[ask(p, sem) for p in claim_prompts])
    res_p = await asyncio.gather(*[ask(p, sem) if p else asyncio.sleep(0) for p in page_prompts])

    out = dict(claims=[], pages=[])
    cnt = {"supported": 0, "partial": 0, "unsupported": 0, "none": 0}
    for (cid, name, cl), r in zip(pick, res_c):
        v = (r or {}).get("verdict", "none")
        v = v if v in cnt else "none"
        cnt[v] += 1
        out["claims"].append(dict(turn=cid, concept=name, text=cl["text"], quote=cl["quote"], l1=cl["l1"], l2=cl["l2"], verdict=v, reason=(r or {}).get("reason", "")))
    n = len(pick)
    ok = cnt["supported"]
    lo, hi = wilson(ok, n - cnt["none"])
    print(f"утверждения: выборка {n}: supported {cnt['supported']}, partial {cnt['partial']}, unsupported {cnt['unsupported']}, без ответа судьи {cnt['none']}; "
          f"доля supported {100 * ok / max(1, n - cnt['none']):.0f}% (95% ДИ {100 * lo:.0f}–{100 * hi:.0f}%)")
    pc = {"all_supported": 0, "some_unsupported": 0, "none": 0}
    for n_, r in zip(pages, res_p):
        v = (r or {}).get("verdict", "none") if isinstance(r, dict) else "none"
        v = v if v in pc else "none"
        pc[v] += 1
        out["pages"].append(dict(note=n_["id"], title=n_["title"], verdict=v, unsupported=(r or {}).get("unsupported", []) if isinstance(r, dict) else []))
    tot = len(pages) - pc["none"]
    lo2, hi2 = wilson(pc["all_supported"], tot)
    print(f"обзоры страниц: выборка {len(pages)}: all_supported {pc['all_supported']}, some_unsupported {pc['some_unsupported']}, без ответа {pc['none']}; "
          f"доля без неподтверждённого {100 * pc['all_supported'] / max(1, tot):.0f}% (95% ДИ {100 * lo2:.0f}–{100 * hi2:.0f}%)")
    out["summary"] = dict(claims=cnt, claims_n=n, pages=pc, pages_n=len(pages))
    Path(ns.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--claims", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n-claims", type=int, default=90)
    ap.add_argument("--n-pages", type=int, default=24)
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

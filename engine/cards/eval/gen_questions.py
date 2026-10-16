"""Черновики вопросов для измерений: модель (не я) пишет вопросы по случайным кускам, скрипт проверяет ответы по тексту.

    python3 gen_questions.py repo --db repo.sqlite --n 24 --out cand_repo.json
    python3 gen_questions.py chat --db chat.sqlite --chat attachments/ChatGPT_….md --n 48 --out cand_chat.json

Дальше кандидатов смотрит человек и оставляет годные (см. questions_*.json). Вопросы пишет основная модель (EVAL_MODEL); ответы —
дословные отрезки текста, их уникальность проверяется подсчётом вхождений во всём тексте.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import sys
from pathlib import Path

from common import MODEL, cards, need_model

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

REPO_PROMPT = """You write evaluation questions for a retrieval test over a software repository.

Below is the CATALOG of the whole repository (id | path | lines | summary), then the full text of ONE target file.

Write ONE question whose correct answer is exactly the target file's path, following these rules:
- Describe what the file DOES or is FOR in plain words (its purpose or behaviour), as a person who has not read the code would.
- Do NOT use the file name, identifiers, function/class/variable names, or distinctive string literals from the file.
- It must be unambiguous: no other file in the catalog is a plausible answer.
- One sentence, English, starting with "Which file".

Return JSON only, no prose: {{"question": "...", "why_unique": "<one sentence>"}}

CATALOG
{catalog}

TARGET FILE: {path}
-----
{text}
"""

CHAT_PROMPT = """You write evaluation questions for a retrieval test over a very long chat transcript (Russian with English terms).
You get one PASSAGE from the assistant's reply and the heading it sits under.

Pick ONE concrete fact stated in the passage whose answer is a short exact span copied from the passage (a number, a name, a term or a
short phrase, at most 6 words) and that is unlikely to occur elsewhere in the transcript. Then write two questions in Russian that have
this span as the answer:
- q_lexical: reuses distinctive words from the passage near the fact (easy to find by keyword search).
- q_semantic: asks by meaning WITHOUT reusing the passage's distinctive words or the answer: describe the situation or purpose in other words,
  as someone who remembers the gist of the conversation but not the wording.
Both questions must be answerable without seeing the passage and must not mention "passage", "text" or "reply".

Return JSON only, no prose: {{"answer": "<exact span from the passage>", "q_lexical": "...", "q_semantic": "..."}}

HEADING: {heading}
PASSAGE
-----
{text}
"""


async def ask(prompt: str, sem: asyncio.Semaphore) -> dict | None:
    async with sem:
        opts = ClaudeAgentOptions(model=need_model(MODEL, "EVAL_MODEL"), tools=[], setting_sources=[], max_turns=2, max_budget_usd=0.5,
                                  extra_args={"no-session-persistence": None})
        res = None
        try:
            async for m in query(prompt=prompt, options=opts):
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


def normspace(s: str) -> str:
    return " ".join(s.lower().replace("ё", "е").split())


async def gen_repo(st: cards.Store, n: int, seed: int, out: Path):
    rnd = random.Random(seed)
    rows = st.con.execute("SELECT id, title, nlines, body FROM cards WHERE kind='file' AND status='active' AND nlines>=20 "
                          "AND title NOT LIKE '%gen.ts' AND title NOT LIKE 'AGENTS%' AND title NOT LIKE '%.test.%' ORDER BY id").fetchall()
    pick = rnd.sample(rows, min(n, len(rows)))
    catalog = "\n".join(l for l in st.catalog().split("\n") if re.match(r"^f\d+ \|", l))
    sem = asyncio.Semaphore(6)
    prompts = [REPO_PROMPT.format(catalog=catalog, path=r["title"], text=r["body"][:6000]) for r in pick]
    results = await asyncio.gather(*[ask(p, sem) for p in prompts])
    cand = []
    for r, res in zip(pick, results):
        if not res or "question" not in res:
            continue
        base = r["title"].split("/")[-1]
        cand.append(dict(id=f"s_{r['id']}", type="semantic", text=res["question"], path=r["title"], why=res.get("why_unique", ""),
                         check=[re.escape(r["title"]) if "/" in r["title"] else re.escape(base)]))
    out.write_text(json.dumps(cand, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(cand), "кандидатов ->", out)


async def gen_chat(st: cards.Store, chat: Path, n: int, seed: int, out: Path):
    rnd = random.Random(seed)
    full = normspace(chat.read_text(encoding="utf-8", errors="replace"))
    groups = [r["id"] for r in st.con.execute("SELECT id FROM groups WHERE kind='thread' ORDER BY ord")]
    per = max(1, round(n / len(groups)))
    picks = []
    for g in groups:
        turns = [r["id"] for r in st.con.execute("SELECT id FROM cards WHERE group_id=? ORDER BY id", (g,))]
        for cid in rnd.sample(turns, min(per, len(turns))):
            c = st.con.execute("SELECT body, meta, outline FROM cards WHERE id=?", (cid,)).fetchone()
            lines = [cards.unquote(x) for x in cards.split_lines(c["body"])]
            r0 = next((i for i, x in enumerate(lines) if x == "# chatgpt response"), 0)
            lo = r0 + 1
            if len(lines) - lo < 8:
                continue
            start = rnd.randint(lo, max(lo, len(lines) - 6))
            end, size = start, 0
            while end < len(lines) and size < 2600:
                size += len(lines[end]) + 1
                end += 1
            text = "\n".join(lines[start:end]).strip()
            if len(text) < 700:
                continue
            heads = json.loads(c["meta"]).get("heads") or json.loads(c["outline"])
            enc = cards.Store._enclosing(heads, start + 1)
            picks.append(dict(card=cid, group=g, start=start + 1, end=end, heading=(enc[1] if enc else "(intro)"), text=text))
    sem = asyncio.Semaphore(6)
    results = await asyncio.gather(*[ask(CHAT_PROMPT.format(heading=p["heading"], text=p["text"]), sem) for p in picks])
    cand = []
    for p, res in zip(picks, results):
        if not res or not res.get("answer"):
            continue
        ans = res["answer"].strip().strip("*`\"«»")
        norm_p, norm_a = normspace(p["text"]), normspace(ans)
        if not norm_a or norm_a not in norm_p:
            continue
        occ = full.count(norm_a)
        # в скольких репликах встречается ответ
        turns_with = [r["id"] for r in st.con.execute("SELECT id, body FROM cards WHERE kind='turn'") if norm_a in normspace(r["body"])]
        for kind in ("lexical", "semantic"):
            q = res.get("q_" + kind)
            if q:
                cand.append(dict(id=f"c_{p['card']}_{p['start']}_{kind[:3]}", type=kind, text=q, answer=ans, card=p["card"], group=p["group"],
                                 heading=p["heading"], occurrences=occ, turns_with_answer=turns_with,
                                 check=[re.escape(norm_a)]))
    out.write_text(json.dumps(cand, ensure_ascii=False, indent=1), encoding="utf-8")
    uniq = sum(1 for c in cand if c["occurrences"] <= 3 and len(c["turns_with_answer"]) == 1)
    print(len(cand), "кандидатов (", uniq, "с уникальным ответом ) ->", out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("repo", "chat"))
    ap.add_argument("--db", required=True)
    ap.add_argument("--chat")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    ns = ap.parse_args()
    st = cards.Store(ns.db)
    if ns.mode == "repo":
        asyncio.run(gen_repo(st, ns.n, ns.seed, Path(ns.out)))
    else:
        asyncio.run(gen_chat(st, Path(ns.chat), ns.n, ns.seed, Path(ns.out)))


if __name__ == "__main__":
    main()

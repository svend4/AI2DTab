"""«Библиотекарь»: дешёвая модель переписывает строки обзора (по карточке) и названия веток в базе чата.

    python3 label_catalog.py --db chat.sqlite [--model ID]  (по умолчанию EVAL_MODEL_SMALL) [--limit N]

Читает каждую реплику целиком (до ~60K токенов), пишет одну информативную строку на русском (о чём реплика, ключевые понятия, имена, числа),
затем по строкам реплик каждой ветки пишет её название. Тексты карточек не меняются — только подписи в каталоге.
Малая модель стоит порядка $0.10 за миллион токенов на входе, то есть весь чат в 4.7 МБ — порядка 15–40 центов.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path

from common import SMALL_MODEL, cards, need_model

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

TURN_PROMPT = """Below is one exchange from a very long chat (a user message, then the assistant's long reply, Russian with English terms).
Write ONE line (max 260 characters, in Russian) for a library catalog so that someone can decide whether this exchange contains what they look for.
Mention the main topic, the key concepts, names, numbers and examples that appear, and the range of numbered sections if there is one.
No preamble, no quotes: only the line.

EXCHANGE
{text}
"""
GROUP_PROMPT = """Below are catalog lines of consecutive exchanges of one thread of a long chat. Write a title for the thread (max 80 characters, Russian,
concrete: what is being designed or discussed) and a one-sentence summary (max 220 characters). Return JSON only: {{"title": "...", "summary": "..."}}

{lines}
"""


async def ask(prompt: str, model: str, sem: asyncio.Semaphore) -> str:
    async with sem:
        o = ClaudeAgentOptions(model=model, tools=[], setting_sources=[], max_turns=2, max_budget_usd=1, extra_args={"no-session-persistence": None})
        res = None
        async for m in query(prompt=prompt, options=o):
            if isinstance(m, ResultMessage):
                res = m
        return (res.result or "").strip() if res else ""


async def main_async(ns):
    need_model(ns.model, "EVAL_MODEL_SMALL")
    st = cards.Store(ns.db)
    sem = asyncio.Semaphore(6)
    rows = st.con.execute("SELECT id, body FROM cards WHERE kind='turn' ORDER BY id").fetchall()
    if ns.limit:
        rows = rows[:ns.limit]
    lines = await asyncio.gather(*[ask(TURN_PROMPT.format(text="\n".join(cards.unquote(x) for x in r["body"].split("\n"))[:240_000]), ns.model, sem) for r in rows])
    for r, line in zip(rows, lines):
        line = " ".join(line.split())
        if line:
            st.set_summary(r["id"], line)
    groups = st.con.execute("SELECT id FROM groups WHERE kind='thread' ORDER BY ord").fetchall()
    outs = await asyncio.gather(*[ask(GROUP_PROMPT.format(lines="\n".join(f"{c['id']}: {c['summary']}" for c in st.con.execute(
        "SELECT id, summary FROM cards WHERE group_id=? ORDER BY id", (g["id"],)))), ns.model, sem) for g in groups])
    for g, out in zip(groups, outs):
        m = re.search(r"\{.*\}", out, re.S)
        try:
            d = json.loads(m.group(0)) if m else {}
        except json.JSONDecodeError:
            d = {}
        if d.get("title"):
            st.set_group(g["id"], d.get("title"), d.get("summary"))
    if ns.raw_catalog:                                  # тот же каталог с диапазонами строк файла — для варианта «сырой файл + обзор»
        import prepare
        Path(ns.raw_catalog).write_text(prepare.raw_catalog_chat(st), encoding="utf-8")
    print("подписи обновлены:", len(rows), "реплик,", len(groups), "веток")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--model", default=SMALL_MODEL)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--raw-catalog", help="куда записать каталог с диапазонами строк (для tools+cat-llm)")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

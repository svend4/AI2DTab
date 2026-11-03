"""Черновики вопросов на синтез: ответ собирается из НЕСКОЛЬКИХ реплик чата. Вопросы пишет основная модель, проверяет скрипт.

    python3 gen_synth.py --db chat.sqlite --out data/cand_synth.json [--terms-only]

Как устроено. Берём понятие, которое повторяется в разных репликах чата (термин из заголовков, 5–30 реплик, ≥12 упоминаний). Из трёх реплик —
ранней, средней и поздней — вырезаем по отрывку вокруг самого плотного места с термином. Модель видит три отрывка и пишет ОДИН вопрос
одного из двух видов:
  evolution    чем отличается сказанное о понятии в ранней и поздней репликах (что добавили, уточнили, изменили);
  aggregation  собрать перечень (составляющие, свойства, шаги), части которого лежат в разных отрывках.
Для каждого отрывка, из которого нужен ответ, модель называет «якорь» — короткий дословный отрезок (≤ 8 слов). Скрипт проверяет, что якорь
действительно есть в своём отрывке и нет в соседних, и считает, в скольких репликах чата он встречается. Дальше кандидатов смотрит человек
(make_sets.py): годные остаются, регулярные выражения проверки уточняются.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

from common import cards

from gen_questions import ask, normspace

PROMPT = """You write evaluation questions for a retrieval test over a very long chat transcript between a user and an AI assistant
(Russian with English terms). Below are THREE PASSAGES from three different exchanges of the same conversation (earlier, middle, later),
all mentioning the term «{term}».

Write ONE question in Russian of the kind "{kind}":
{kind_rule}

Rules:
- The correct answer must need facts from at least TWO different passages; one passage alone must not be enough.
- For every passage the answer draws on, give an ANCHOR: an exact short span (at most 8 words) copied character for character from that passage
  that a correct answer has to contain: a specific name, number, term or short phrase (not a generic word), and not present in the other passages.
- Prefer lists of NAMED items (roles, classes, states, layers, steps, fields) and numbers: the answer then consists of specific names that can be checked.
- Make the question definite: say which aspect of «{term}» is asked about, so that the intended answer is the facts in the passages and not some other
  part of a long conversation. Two sentences at most.
- The question must be answerable without seeing the passages and must not mention "passage", "text", exchange numbers or times.
- Do not ask about things a person could guess without the transcript.
- "reference": the correct answer in Russian, 1-3 sentences, built ONLY from the passages (include the anchors).

Return JSON only, no prose: {{"question": "...", "reference": "...", "parts": [{{"passage": 1, "span": "..."}}, {{"passage": 3, "span": "..."}}]}}

{passages}
"""
KINDS = {
    "evolution": ("evolution", "Ask how what the conversation says about «{term}» differs between an earlier and a later exchange: what was added, made precise or changed."),
    "aggregation": ("aggregation", "Ask for a list (components, properties, steps, types, roles) of «{term}» that the conversation gives, so that the complete list can only be put together from at least two passages (each contributes an item the others lack)."),
}

# понятия, а не слова общего вида; порядок значения не имеет
TERMS = ["Capability Capital", "Foresight", "Signpost", "Acceptance Test", "Technopedia", "Procedural Graph", "Handoff", "Capability Package",
         "Promotion", "Team Builder", "Capability Contract", "Research Observatory", "Architecture Freeze", "Strategy Engine", "Package Manager",
         "Open Knowledge", "Team Hypothesis", "Resource Resolver", "Entity Resolution", "Funding Resolver", "Causal Engine", "Project Compiler",
         "Idempotency", "Artificial Technological Awareness", "Worker Commands", "Portfolio Intelligence", "Adaptive Strategy", "Kill Criteria",
         "Query Planner", "Ecosystem Learning", "Commitment", "Scheduler", "Discussion", "Forum"]


def card_lines(st: cards.Store, cid: str) -> list:
    return [cards.unquote(x) for x in cards.split_lines(st._card(cid)["body"])]


def best_window(lines: list, term: str, chars: int = 2600):
    """Отрывок вокруг самого плотного места с термином -> (первая строка 1-based, последняя, текст, число упоминаний в отрывке)."""
    low = term.lower()
    hits = [i for i, ln in enumerate(lines) if low in ln.lower()]
    best = None
    for h in hits:
        a = max(0, h - 3)
        end, size = a, 0
        while end < len(lines) and size < chars:
            size += len(lines[end]) + 1
            end += 1
        n = sum(lines[i].lower().count(low) for i in range(a, end))
        if best is None or n > best[3]:
            best = (a + 1, end, "\n".join(lines[a:end]), n)
    return best


def pick_turns(st: cards.Store, term: str, variant: int = 0):
    low = term.lower()
    cands = []
    for r in st.con.execute("SELECT id, meta FROM cards WHERE kind='turn' ORDER BY id"):
        lines = card_lines(st, r["id"])
        if not any(low in ln.lower() for ln in lines):
            continue
        w = best_window(lines, term)
        if w and w[3] >= 2 and len(w[2]) >= 600:
            cands.append((r["id"], json.loads(r["meta"]).get("ts", ""), w))
    if len(cands) < 3:
        return []
    if variant == 0:
        return [cands[0], cands[len(cands) // 2], cands[-1]]
    if len(cands) < 5:
        return []
    return [cands[1], cands[(len(cands) * 5) // 8], cands[-2]]


def anchor_regex(span: str) -> str:
    return r"\s+".join(re.escape(w) for w in span.split())


async def gen(st: cards.Store, out: Path, only: list | None, variants: int):
    full = {r["id"]: normspace("\n".join(card_lines(st, r["id"]))) for r in st.con.execute("SELECT id FROM cards WHERE kind='turn'")}
    jobs = []
    for term in (only or TERMS):
        for variant in range(variants):
            picked = pick_turns(st, term, variant)
            if not picked:
                print("пропуск (мало реплик):", term, variant, file=sys.stderr)
                continue
            passages = "\n\n".join(f"PASSAGE {i} ({ts})\n-----\n{w[2]}" for i, (cid, ts, w) in enumerate(picked, 1))
            for kind, (name, rule) in KINDS.items():
                jobs.append((term, kind, variant, picked, PROMPT.format(term=term, kind=name, kind_rule=rule.format(term=term), passages=passages)))
    sem = asyncio.Semaphore(6)
    results = await asyncio.gather(*[ask(j[4], sem) for j in jobs])
    cand = []
    for (term, kind, variant, picked, _), res in zip(jobs, results):
        if not res or not res.get("question") or not res.get("parts"):
            continue
        parts, seen_p = [], set()
        for p in res["parts"]:
            try:
                i = int(p["passage"]) - 1
                span = " ".join(str(p["span"]).split()).strip("*`\"«» ")
            except (KeyError, ValueError, TypeError):
                continue
            if not 0 <= i < 3 or i in seen_p or not span:
                continue
            cid, ts, (a, b, text, _) = picked[i]
            ns = normspace(span)
            if ns not in normspace(text):
                continue                                                # якорь должен дословно лежать в своём отрывке
            if sum(1 for body in full.values() if ns in body) > 8:
                continue                                                # слишком частый отрезок якорем быть не может
            others = [normspace(picked[j][2][2]) for j in range(3) if j != i]
            if any(ns in o for o in others):
                continue                                                # и не повторяться в соседних: иначе не видно, откуда он
            lines = card_lines(st, cid)
            line_no = next((k for k, ln in enumerate(lines, 1) if ns in normspace(ln)), None)
            parts.append(dict(turn=cid, ts=ts, span=span, line=line_no, window=[a, b],
                              turns_with_span=[t for t, body in full.items() if ns in body], check=anchor_regex(span)))
            seen_p.add(i)
        if len(parts) < 2:
            continue
        slug = re.sub(r"[^a-z0-9]+", "_", term.lower()).strip("_")
        cand.append(dict(id=f"s_{slug}_{kind[:3]}{variant}", type=kind, term=term, text=res["question"].strip(), reference=(res.get("reference") or "").strip(),
                         parts=parts, check=[p["check"] for p in parts], turns=[p[0] for p in picked]))
    out.write_text(json.dumps(cand, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(cand), "кандидатов из", len(jobs), "->", out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--terms", default="", help="только эти термины через ';' (для проверки)")
    ap.add_argument("--variants", type=int, default=2, help="сколько разных троек реплик на термин")
    ns = ap.parse_args()
    st = cards.Store(ns.db)
    asyncio.run(gen(st, Path(ns.out), [t.strip() for t in ns.terms.split(";") if t.strip()] or None, ns.variants))


if __name__ == "__main__":
    main()

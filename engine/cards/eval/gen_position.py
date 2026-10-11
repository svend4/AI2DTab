"""Вопросы «где впервые» для чата: по времени сообщения найти реплику, в которой термин встречается впервые.

    python3 gen_position.py --db chat.sqlite --out data/questions_chat_pos.json

Без модели: термины — заголовки разделов из Title Case (2–3 слова), которые встречаются в 3–15 репликах; берём по одному на реплику первого
появления, разнесённые по времени. Ответ — метка «message time» этой реплики. Такие вопросы про ориентацию («где мы это обсуждали»):
обзор-каталог отвечает на них сразу, а поиску по тексту нужно найти первое вхождение и отдельно прочитать метку времени.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cards  # noqa: E402

GENERIC = {"another", "but", "after", "across", "combined", "again", "can", "avoid", "before", "this", "that", "these", "example", "the", "and", "or"}


def nsp(s: str) -> str:
    return " ".join(s.lower().replace("ё", "е").split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--seed", type=int, default=5)
    ns = ap.parse_args()
    st = cards.Store(ns.db)
    rows = st.con.execute("SELECT id, body, meta, outline FROM cards WHERE kind='turn' ORDER BY id").fetchall()
    # ищем по физическим строкам: фраза, разорванная переводом строки, поиском по тексту не находится
    bodies = [(r["id"], "\n".join(nsp(cards.unquote(x)) for x in r["body"].split("\n")), json.loads(r["meta"])) for r in rows]
    cand = {}
    for r in rows:
        m = json.loads(r["meta"])
        for lbl, _a, _b in (m.get("heads") or json.loads(r["outline"])):
            t = re.sub(r"^#+\s*", "", lbl)
            t = re.sub(r"^\d+[.)]?\s*", "", t).strip(" :.*`")
            words = t.split()
            if 2 <= len(words) <= 3 and all(re.match(r"[A-Z][A-Za-z]+$", w) for w in words) and not (GENERIC & {w.lower() for w in words}):
                cand[nsp(t)] = t
    found = []
    for nt, t in cand.items():
        turns = [i for i, (_cid, body, _m) in enumerate(bodies) if nt in body]
        if 3 <= len(turns) <= 15 and 3 <= turns[0] <= 78:
            found.append((turns[0], t, len(turns)))
    rnd = random.Random(ns.seed)
    rnd.shuffle(found)
    found.sort(key=lambda x: x[0])
    picked, last = [], -99
    # разнесём по времени: берём термины с шагом
    pool = sorted(found, key=lambda x: x[0])
    step = max(1, len(pool) // (ns.n * 2))
    for first, t, n in pool[::step]:
        if first - last >= 5 and len(picked) < ns.n:
            picked.append((first, t, n))
            last = first
    qs = []
    for k, (first, t, n) in enumerate(picked):
        cid, _b, meta = bodies[first]
        ts = meta["ts"]
        qs.append(dict(id=f"pos_{cid}", type="position", session=k % 2, term=t, card=cid, ts=ts, turns_with_term=n,
                       text=f"В какое время (метка «message time» реплики пользователя) впервые в этом чате встречается словосочетание «{t}»? "
                            f"Регистр не важен, учитывай и реплики пользователя, и ответы ассистента. Ответь в формате ГГГГ-ММ-ДД ЧЧ:ММ.",
                       check=[re.escape(ts[11:16])]))
    Path(ns.out).write_text(json.dumps(qs, ensure_ascii=False, indent=1), encoding="utf-8")
    for q in qs:
        print(q["id"], q["ts"], "|", q["term"], f"({q['turns_with_term']} реплик)")


if __name__ == "__main__":
    main()

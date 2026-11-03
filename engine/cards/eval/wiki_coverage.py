"""Что из нужного для вопросов набора synth вообще попало в заметки? Диагностика сжатия, не зависящая от поведения агента.

    python3 wiki_coverage.py --db chat_notes.sqlite [--questions data/questions_synth.json]

Для каждого якоря (регулярное выражение проверки) смотрим: есть ли он в тексте заметок (дайджесты и страницы понятий) — и есть ли заметка,
которая ссылается на нужную реплику. Вопрос «покрыт», если в заметках нашлись все его якоря. Так отделяется «сжатие потеряло факт» от
«агент не нашёл или не использовал заметку».
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from common import cards

DATA = Path(__file__).resolve().parent / "data"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--questions", default=str(DATA / "questions_synth.json"))
    ap.add_argument("--json", default="", help="сохранить результат в файл")
    ns = ap.parse_args()
    st = cards.Store(ns.db)
    notes = st.con.execute("SELECT id, title, body, summary FROM cards WHERE kind='note' AND status='active'").fetchall()
    text_of = {n["id"]: (n["title"] + "\n" + n["body"]).replace(" ", " ") for n in notes}
    digest = {}                       # реплика -> id её дайджеста
    concept_ids = set()
    for n in notes:
        m = re.match(r"Exchange (t\d{3}) \(", n["title"])
        if m:
            digest[m.group(1)] = n["id"]
        else:
            concept_ids.add(n["id"])
    raw = {r["id"]: "\n".join(cards.unquote(x) for x in r["body"].split("\n")).replace(" ", " ")
           for r in st.con.execute("SELECT id, body FROM cards WHERE kind='turn'")}
    qs = json.loads(Path(ns.questions).read_text(encoding="utf-8"))
    rows, full = [], 0
    for q in qs:
        an = []
        for rx in q["check"]:
            in_raw = sorted(t for t, b in raw.items() if re.search(rx, b, re.I))
            in_digest = sorted(t for t, d in digest.items() if re.search(rx, text_of[d], re.I))
            in_concept = sorted(i for i in concept_ids if re.search(rx, text_of[i], re.I))
            an.append(dict(rx=rx, raw_turns=in_raw, digest_turns=in_digest, concept_pages=len(in_concept),
                           captured=bool(in_digest or in_concept)))
        ok = all(a["captured"] for a in an)
        full += ok
        rows.append(dict(id=q["id"], type=q["type"], covered=ok, anchors=an))
    print(f"вопросов, у которых в заметках есть ВСЕ якоря: {full}/{len(qs)}; якорей в заметках: "
          f"{sum(a['captured'] for r in rows for a in r['anchors'])}/{sum(len(r['anchors']) for r in rows)}")
    print(f"{'вопрос':<30} {'вид':<4} покрыт  якоря: в заметках (дайджест/страницы понятий) · в сыром тексте")
    for r in rows:
        cells = [f"{'+' if a['captured'] else '-'}({len(a['digest_turns'])}/{a['concept_pages']}·{len(a['raw_turns'])})" for a in r["anchors"]]
        print(f"{r['id']:<30} {r['type'][:3]:<4} {'да' if r['covered'] else 'нет':<7} " + " ".join(cells))
    if ns.json:
        Path(ns.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()

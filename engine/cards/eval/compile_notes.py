"""Проход «compile» в духе LLM Wiki: чат -> заметки с проверяемыми источниками. Пишет малая модель (EVAL_MODEL_SMALL), проверяет скрипт.

    python3 compile_notes.py --db chat_notes.sqlite --out-dir compile_out --wiki-dir wiki_chat/wiki [--reuse] [--limit N]

Три шага.
 1. map. По каждой реплике модель отдаёт понятия и утверждения; к каждому утверждению — дословная цитата (до 25 слов из одной строки).
    Скрипт ищет цитату в тексте реплики (с точностью до регистра, кавычек и разметки), находит номера строк и выбрасывает утверждения,
    цитату которых найти не удалось. Доля выброшенных — показатель того, как часто модель выдумывает «источник».
 2. сведение имён. Одной просьбой модель объединяет написания одного понятия («Capability Capital» / «Capability Capital module»).
    Разные вещи объединять нельзя, при сомнении — раздельно.
 3. страницы. На каждую реплику — «дайджест» (резюме + утверждения по понятиям, как «страница-источник» у Карпати); на каждое понятие, о котором
    говорится минимум в двух репликах, — страница: обзор от модели (только по этим утверждениям) и хронология утверждений от скрипта
    (реплика, строки, формулировка, цитата). Ссылки между страницами — [[nNNN]]. Идентификаторы заметок вычисляются заранее:
    дайджесты n001…, затем страницы понятий.
Вопросов набора synth скрипт не видит: сжатие общее, под тест не настраивалось.
Вариант v2 (--lists) добавлен ПОСЛЕ первых измерений, когда выяснилось, что первое сжатие теряет перечни; он тоже не видит вопросов, но придуман
с оглядкой на результат: в отчёте так и подписан.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

from common import SMALL_MODEL, cards, need_model

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

MAP_PROMPT = """Below is one exchange from a very long design conversation (a user message, then the assistant's long reply; Russian with English terms).
You are building a wiki: your notes will later be used to answer questions about the conversation without re-reading it.

Extract what a future reader needs: definitions of named concepts, modules and objects; enumerations of named elements (put ALL the elements into the
claim); numbers and thresholds; rules and decisions; and any place where this exchange changes or refines something said earlier.

Return JSON only, no prose:
{{"summary": "2-3 sentences in Russian: what the exchange is about and what it decides",
 "concepts": [
   {{"name": "the concept's name exactly as written in the text (the English term if the text uses one)",
    "claims": [
      {{"text": "one sentence in Russian; keep names, identifiers and numbers exactly as in the text",
       "quote": "a short fragment (at most 25 words) copied character for character from ONE line of the text, containing the key names of the claim"}}
    ]}}
 ]}}
Rules: 6 to 14 concepts, 1 to 5 claims each, the most important first. Quotes are checked automatically: a claim whose quote is not found verbatim is
discarded. Do not invent anything that is not in the text.

EXCHANGE {cid}
{text}
"""
LISTS_PROMPT = """Below is one exchange from a very long design conversation (a user message, then the assistant's long reply; Russian with English terms).
List EVERY enumeration of named elements in it: lists of fields, states, types, roles, steps, pipeline stages, thresholds, named examples with numbers,
and the rows of tables. Prose is not needed. Copy the items exactly as written (identifiers and English terms unchanged).

Return JSON only, no prose:
{{"lists": [{{"title": "what is enumerated, in Russian, at most 12 words",
            "lead": "the exact line under which the enumeration starts (a heading or a lead-in sentence), copied character for character",
            "items": ["exact item", "exact item"]}}]}}
Rules: every item is short (at most 8 words) and copied character for character; skip enumerations of fewer than 3 items; up to 60 lists; do not invent.
Items that are not found verbatim in the text are discarded automatically.

EXCHANGE {cid}
{text}
"""
ALIAS_PROMPT = """Below are concept names taken from different exchanges of one long conversation, as "name | number of exchanges".
Group the names that denote the SAME concept: spelling, case, plural, hyphenation, an added word like "module" or "layer" that does not change the meaning,
or the same term written in Russian and in English. Do NOT merge different things (a part and its whole, neighbours such as "Task Graph" and
"Procedural Graph", a concept and its sub-concept). When unsure, keep them separate.

Return JSON only: {{"groups": [{{"canonical": "...", "aliases": ["...", "..."]}}]}} listing only groups of two or more names; "canonical" must be one of the names.

{names}
"""
OVERVIEW_PROMPT = """Concept: {name}.
Below are claims about it taken from different exchanges of one long conversation, in chronological order ("exchange id, time: claim").
Write a short overview in Russian (3-5 sentences): what the concept is, its main elements and, if later exchanges change, refine or extend earlier ones,
how it evolves (cite exchange ids in parentheses, e.g. (t023)). Use ONLY these claims; keep names, identifiers and numbers exactly as written; add no facts.
Plain text, no preamble.

{claims}
"""

COST = Counter()


def est_usd() -> float:
    """Цена по токенам и ставкам малой модели (вход 0.10, запись кэша 0.20, чтение 0.01, вывод 0.50 за млн, пока запрос не длиннее 100 тыс. токенов)."""
    return (COST["input_tokens"] * 0.10 + COST["cache_creation_input_tokens"] * 0.20 + COST["cache_read_input_tokens"] * 0.01 + COST["output_tokens"] * 0.50) / 1e6


async def ask(prompt: str, model: str, sem: asyncio.Semaphore, want_json: bool = True, tries: int = 2):
    for attempt in range(tries):
        async with sem:
            # размышление выключено: для выписок из текста оно только раздувает вывод (в пробном вызове 11 тыс. из 14 тыс. выходных токенов)
            o = ClaudeAgentOptions(model=model, tools=[], setting_sources=[], max_turns=2, max_budget_usd=2, extra_args={"no-session-persistence": None},
                                   thinking={"type": "disabled"})
            res = None
            try:
                async for m in query(prompt=prompt + ("\n\nReturn valid JSON only." if attempt else ""), options=o):
                    if isinstance(m, ResultMessage):
                        res = m
            except Exception as e:  # noqa: BLE001
                print("ошибка запроса:", type(e).__name__, e, file=sys.stderr)
                continue
        if not res or not res.result:
            continue
        u = res.usage or {}
        COST["usd"] += res.total_cost_usd or 0                      # отчёт CLI: идентификатор малой модели ему неизвестен, ставка запасная (завышена)
        COST["calls"] += 1
        for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"):
            COST[k] += u.get(k, 0) or 0
        if not want_json:
            return res.result.strip()
        m = re.search(r"\{.*\}", res.result, re.S)
        try:
            return json.loads(m.group(0)) if m else None
        except json.JSONDecodeError:
            continue
    return None


def turn_lines(st: cards.Store, cid: str) -> list:
    return [cards.unquote(x) for x in cards.split_lines(st._card(cid)["body"])]


def locate(quote: str, lines: list):
    """Номера строк (1-based) первой строки с цитатой; цитата может занимать до трёх подряд идущих строк. Не нашли — None."""
    nq = cards.norm_quote(quote)
    if len(nq) < 6:
        return None
    norm = [cards.norm_quote(x) for x in lines]
    for i, ln in enumerate(norm):
        if nq in ln:
            return i + 1, i + 1
    for i in range(len(norm) - 1):
        joined = " ".join(x for x in norm[i:i + 3] if x)
        if nq in joined:
            return i + 1, min(len(lines), i + 3)
    return None


async def map_turns(st: cards.Store, model: str, limit: int, workers: int) -> dict:
    sem = asyncio.Semaphore(workers)
    rows = st.con.execute("SELECT id, meta FROM cards WHERE kind='turn' ORDER BY id").fetchall()
    if limit:
        rows = rows[:limit]
    texts = {r["id"]: "\n".join(turn_lines(st, r["id"])) for r in rows}
    results = await asyncio.gather(*[ask(MAP_PROMPT.format(cid=r["id"], text=texts[r["id"]][:260_000]), model, sem) for r in rows])
    out = {}
    for r, res in zip(rows, results):
        lines = turn_lines(st, r["id"])
        ts = json.loads(r["meta"]).get("ts", "")
        proposed = grounded = 0
        concepts = []
        for c in (res or {}).get("concepts", []) or []:
            name = " ".join(str(c.get("name", "")).split())
            claims = []
            for cl in c.get("claims", []) or []:
                proposed += 1
                text, quote = " ".join(str(cl.get("text", "")).split()), " ".join(str(cl.get("quote", "")).split())
                pos = locate(quote, lines) if quote and text else None
                if pos:
                    grounded += 1
                    claims.append(dict(text=text, quote=quote, l1=pos[0], l2=pos[1]))
            if name and claims:
                concepts.append(dict(name=name, claims=claims))
        out[r["id"]] = dict(ts=ts, summary=" ".join(str((res or {}).get("summary", "")).split()), concepts=concepts, proposed=proposed, grounded=grounded, failed=res is None)
    return out


async def map_lists(st: cards.Store, model: str, limit: int, workers: int) -> dict:
    """Дословные перечни по каждой реплике. Заголовок-«зацепка» ищем в тексте, каждый элемент проверяем в 150 строках после него; ненайденные элементы
    выбрасываем, а перечень, где не нашлась половина, — целиком."""
    sem = asyncio.Semaphore(workers)
    rows = st.con.execute("SELECT id FROM cards WHERE kind='turn' ORDER BY id").fetchall()
    if limit:
        rows = rows[:limit]
    texts = {r["id"]: turn_lines(st, r["id"]) for r in rows}
    results = await asyncio.gather(*[ask(LISTS_PROMPT.format(cid=r["id"], text="\n".join(texts[r["id"]])[:260_000]), model, sem) for r in rows])
    out, proposed, kept = {}, 0, 0
    for r, res in zip(rows, results):
        lines = texts[r["id"]]
        norm = [cards.norm_quote(x) for x in lines]
        lists = []
        for ls in (res or {}).get("lists", []) or []:
            items = [" ".join(str(i).split()) for i in ls.get("items", []) or [] if str(i).strip()]
            proposed += len(items)
            pos = locate(" ".join(str(ls.get("lead", "")).split()), lines)
            if not pos or len(items) < 3:
                continue
            region = " ".join(norm[pos[0] - 1:pos[0] + 150])
            good, last = [], pos[0]
            for it in items:
                ni = cards.norm_quote(it)
                if ni and ni in region:
                    good.append(it)
                    for k in range(pos[0] - 1, min(len(norm), pos[0] + 150)):
                        if ni in norm[k]:
                            last = max(last, k + 1)
                            break
            if len(good) < 3 or len(good) * 2 < len(items):
                continue
            kept += len(good)
            lists.append(dict(title=" ".join(str(ls.get("title", "")).split()), lead=" ".join(str(ls.get("lead", "")).split()), items=good, l1=pos[0], l2=last))
        out[r["id"]] = lists
    print(f"перечни: элементов предложено {proposed}, найдено дословно {kept} ({100 * kept / max(1, proposed):.1f}%); "
          f"перечней {sum(len(v) for v in out.values())} в {len(out)} репликах; ≈${est_usd():.3f}")
    return out


def name_key(n: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s/+-]", " ", n.lower().replace("ё", "е"), flags=re.UNICODE)).strip()


async def merge_names(per_turn: dict, model: str, workers: int) -> dict:
    """Имя в реплике -> каноническое имя понятия. Сначала совпадения по написанию, затем одна просьба к модели."""
    by_key: dict = defaultdict(Counter)
    turns_of: dict = defaultdict(set)
    for cid, d in per_turn.items():
        for c in d["concepts"]:
            by_key[name_key(c["name"])][c["name"]] += 1
            turns_of[name_key(c["name"])].add(cid)
    canon_of_key = {k: v.most_common(1)[0][0] for k, v in by_key.items()}
    names = sorted(canon_of_key.values(), key=str.lower)
    listing = "\n".join(f"{n} | {len(turns_of[name_key(n)])}" for n in names)
    sem = asyncio.Semaphore(workers)
    res = await ask(ALIAS_PROMPT.format(names=listing), model, sem) or {}
    alias_to_canon = {}
    for g in res.get("groups", []) or []:
        canon = g.get("canonical")
        if canon not in names:
            continue
        for a in g.get("aliases", []) or []:
            if a in names and a != canon:
                alias_to_canon[name_key(a)] = canon
    mapping = {k: alias_to_canon.get(k, v) for k, v in canon_of_key.items()}
    return dict(mapping=mapping, distinct_names=len(names), merged=len(alias_to_canon))


def clip_s(s: str, n: int) -> str:
    return cards.clip(s, n)


async def build_pages(st: cards.Store, per_turn: dict, merge: dict, model: str, workers: int, min_turns: int = 2, lists: dict | None = None) -> dict:
    mapping = merge["mapping"]
    lists = lists or {}
    concept_claims: dict = defaultdict(list)           # каноническое имя -> [(реплика, ts, утверждение)]
    for cid in sorted(per_turn):
        for c in per_turn[cid]["concepts"]:
            canon = mapping.get(name_key(c["name"]), c["name"])
            for cl in c["claims"]:
                concept_claims[canon].append((cid, per_turn[cid]["ts"], cl))
    pages = {name: cl for name, cl in concept_claims.items() if len({x[0] for x in cl}) >= min_turns}
    order = sorted(pages, key=lambda n: (-len({x[0] for x in pages[n]}), n.lower()))
    turn_ids = sorted(per_turn)
    digest_id = {cid: f"n{i + 1:03d}" for i, cid in enumerate(turn_ids)}
    base = len(turn_ids)
    concept_id = {name: f"n{base + i + 1:03d}" for i, name in enumerate(order)}
    # связанные понятия: чаще всего встречаются в одних и тех же репликах
    turns_of = {n: {x[0] for x in pages[n]} for n in order}
    related = {}
    for n in order:
        score = [(len(turns_of[n] & turns_of[m]), m) for m in order if m != n]
        related[n] = [m for s, m in sorted(score, key=lambda t: (-t[0], t[1].lower())) if s >= 2][:5]

    sem = asyncio.Semaphore(workers)
    ov_prompts = [OVERVIEW_PROMPT.format(name=n, claims="\n".join(f"{cid}, {ts[:16]}: {cl['text']}" for cid, ts, cl in pages[n])) for n in order]
    overviews = await asyncio.gather(*[ask(p, model, sem, want_json=False) for p in ov_prompts])
    overview = {n: (o or "").strip() for n, o in zip(order, overviews)}

    group_d = ("Wiki: exchange digests", 91, f"{len(turn_ids)} digests, one per exchange: summary and claims by concept, each with its source lines")
    group_c = ("Wiki: concepts", 90, f"{len(order)} pages, one per concept discussed in 2+ exchanges: overview and a timeline of claims with sources")
    made = Counter()
    for cid in turn_ids:                                 # дайджесты
        d = per_turn[cid]
        by_concept = [(mapping.get(name_key(c["name"]), c["name"]), c["claims"]) for c in d["concepts"]]
        body = [f"# Exchange {cid} ({d['ts']})", "", d["summary"] or "(no summary)", "", "## Claims"]
        srcs = []
        for canon, claims in by_concept:
            link = f" [[{concept_id[canon]}]]" if canon in concept_id else ""
            body.append(f"### {canon}{link}")
            for cl in claims:
                rng = f"L{cl['l1']}" if cl["l1"] == cl["l2"] else f"L{cl['l1']}-{cl['l2']}"
                body.append(f"- {cl['text']} ({cid} {rng})")
                srcs.append(dict(card=cid, lines=f"{cl['l1']}-{cl['l2']}", quote=cl["quote"]))
        if lists.get(cid):
            body += ["", "## Enumerations"]
            for ls in lists[cid]:
                rng = f"L{ls['l1']}" if ls["l1"] == ls["l2"] else f"L{ls['l1']}-{ls['l2']}"
                body.append(f"- {ls['title']} ({cid} {rng}): " + " | ".join(ls["items"]))
                srcs.append(dict(card=cid, lines=f"{ls['l1']}-{ls['l2']}", quote=ls["lead"]))
        names = ", ".join(c for c, _ in by_concept[:8])
        title = f"Exchange {cid} ({d['ts']})"
        summ = f"[digest {cid} {d['ts'][5:16]}] {clip_s(d['summary'], 150)} | concepts: {clip_s(names, 110)}"
        r = st.add_note(title, "\n".join(body), group=group_d[0], sources=srcs, summary=summ, author="compile", group_kind="wiki", group_ord=group_d[1],
                        group_summary=group_d[2], op="ingest")
        if not r.startswith("OK " + digest_id[cid]):
            raise SystemExit(f"дайджест {cid}: ожидали {digest_id[cid]}, получили {r}")
        made["digest"] += 1
        made["sources"] += len(srcs)
    for name in order:                                   # страницы понятий
        cl = pages[name]
        ts_ids = sorted({x[0] for x in cl})
        body = [f"# {name}", "", f"Discussed in {len(ts_ids)} exchanges: {', '.join(ts_ids)}.", ""]
        if overview[name]:
            body += ["## Overview", "", overview[name], ""]
        body += ["## Timeline", ""]
        srcs = []
        for cid, ts, c in cl:
            rng = f"L{c['l1']}" if c["l1"] == c["l2"] else f"L{c['l1']}-{c['l2']}"
            body.append(f"- {cid} ({ts[5:16]}) {rng}: {c['text']} [[{digest_id[cid]}]]")
            srcs.append(dict(card=cid, lines=f"{c['l1']}-{c['l2']}", quote=c["quote"]))
        if related[name]:
            body += ["", "See also: " + ", ".join(f"{m} [[{concept_id[m]}]]" for m in related[name])]
        summ = f"[concept] {name} | {len(ts_ids)} exchanges {ts_ids[0]}..{ts_ids[-1]} | {clip_s(overview[name] or cl[0][2]['text'], 170)}"
        r = st.add_note(name, "\n".join(body), group=group_c[0], sources=srcs, summary=summ, author="compile", group_kind="wiki", group_ord=group_c[1],
                        group_summary=group_c[2], op="ingest")
        if not r.startswith("OK " + concept_id[name]):
            raise SystemExit(f"страница {name}: ожидали {concept_id[name]}, получили {r}")
        made["concept"] += 1
        made["sources"] += len(srcs)
    return dict(made), len(order)


async def main_async(ns):
    model = need_model(ns.model, "EVAL_MODEL_SMALL")
    out = Path(ns.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    src = Path(ns.db)
    st = cards.Store(src)
    if st.con.execute("SELECT COUNT(*) c FROM cards WHERE kind='note'").fetchone()["c"]:
        raise SystemExit("в базе уже есть заметки: возьмите свежую копию базы чата")
    claims_path = out / "claims.json"
    if ns.reuse and claims_path.exists():
        per_turn = json.loads(claims_path.read_text(encoding="utf-8"))
    else:
        per_turn = await map_turns(st, model, ns.limit, ns.workers)
        claims_path.write_text(json.dumps(per_turn, ensure_ascii=False), encoding="utf-8")
    prop = sum(d["proposed"] for d in per_turn.values())
    gr = sum(d["grounded"] for d in per_turn.values())
    failed = [c for c, d in per_turn.items() if d["failed"]]
    print(f"map: реплик {len(per_turn)}, утверждений предложено {prop}, подтверждено цитатой {gr} ({100 * gr / max(1, prop):.1f}%), "
          f"реплик без ответа модели: {failed or '-'}; ≈${est_usd():.3f} по ставкам малой модели (отчёт CLI: ${COST['usd']:.2f})")
    lists = None
    if ns.lists:
        lists_path = out / "lists.json"
        if ns.reuse and lists_path.exists():
            lists = json.loads(lists_path.read_text(encoding="utf-8"))
        else:
            lists = await map_lists(st, model, ns.limit, ns.workers)
            lists_path.write_text(json.dumps(lists, ensure_ascii=False), encoding="utf-8")
    merge = await merge_names(per_turn, model, ns.workers)
    (out / "merge.json").write_text(json.dumps(merge, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"имена: различных {merge['distinct_names']}, объединено в других {merge['merged']}")
    made, n_concepts = await build_pages(st, per_turn, merge, model, ns.workers, lists=lists)
    print("страницы:", made, "понятий со страницами:", n_concepts)
    findings = st.lint()
    print(st.lint_text(findings, limit=12))
    print(st.stats())
    stats = dict(turns=len(per_turn), proposed=prop, grounded=gr, grounded_pct=round(100 * gr / max(1, prop), 1), failed_turns=failed,
                 distinct_names=merge["distinct_names"], merged_aliases=merge["merged"], pages=made, concept_pages=n_concepts,
                 lint=dict(Counter(f["level"] for f in findings)), usd_est=round(est_usd(), 3), usd_cli_reported=round(COST["usd"], 2), calls=COST["calls"],
                 tokens={k: COST[k] for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")})
    (out / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    if ns.wiki_dir:
        res = st.export_wiki(ns.wiki_dir, chat_name="chat.md")
        print("wiki:", res, "->", ns.wiki_dir)
    print(f"итого ≈${est_usd():.3f} (отчёт CLI ${COST['usd']:.2f}) на {COST['calls']} вызовов малой модели; токены: {dict(COST)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="СВЕЖАЯ копия базы чата: заметки добавляются в неё")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--wiki-dir", default="")
    ap.add_argument("--model", default=SMALL_MODEL)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="только первые N реплик (проверка)")
    ap.add_argument("--lists", action="store_true", help="второй проход: дословные перечни (поля, состояния, этапы) по каждой реплике, в дайджесты")
    ap.add_argument("--reuse", action="store_true", help="взять утверждения из out-dir/claims.json, не вызывая модель на шаге map")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

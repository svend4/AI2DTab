#!/usr/bin/env python3
"""Смысловой lint: ищет в памяти утверждения, которые не сходятся между собой. Модель предлагает, скрипт проверяет.

Механический `lint` (cards.py) смысла не понимает: он смотрит даты, источники, цитаты. Здесь вопрос другой: «о понятии X в разных местах сказано разное —
что именно и где?». Три шага:
 1. отрывки (без модели): строки о понятии и их окрестность (раздел, если он короткий, иначе несколько строк вокруг) по порядку беседы;
 2. суждение модели: расхождения трёх видов — conflict (оба верными быть не могут), divergent (два описания одного и того же с разным содержимым,
    какое действует — не сказано), revision (позднее прямо меняет раннее) — и по две дословные цитаты на каждое;
 3. проверка (без модели): каждая цитата ищется в тексте карточки (с точностью до регистра, кавычек и разметки), находятся номера строк; находка,
    у которой цитата не нашлась, выбрасывается и считается в итоге.
Ничего не пишет ни в картотеку, ни в стол: решает человек, находка лишь называет место и (для стола) подсказывает команду.
Нужен пакет claude-agent-sdk и идентификатор модели в SEMLINT_MODEL (или EVAL_MODEL); без них работает только --dry-run.

    python3 semlint.py "Capability Contract" "Foresight"        # понятия из чатов картотеки
    python3 semlint.py --pattern "signpost|сигнпост" Signpost    # свой шаблон поиска вместо самого названия
    python3 semlint.py --canon                                   # канон стола + действующие факты журнала: пары, что не сходятся
    python3 semlint.py --dry-run Foresight                       # что отправилось бы модели, без вызова
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cards  # noqa: E402

KINDS = ("conflict", "divergent", "revision")
MIN_QUOTE = 12                        # короче нормализованная цитата не считается подтверждением: «OAuth» найдётся где угодно

CHAT_PROMPT = """Below are passages of one long design conversation (Russian with English terms) that mention "{term}", in conversation order. Each passage starts with a header "### card · date · lines". Your job is to find places where the conversation says things about "{term}" that do not fit together, so that a reader who relies on one place is not misled by another.

Report three kinds of finding:
- conflict: two statements that cannot both be true of the same thing (a different value or number, a rule and its opposite, "X is part of Y" against "X is not part of Y").
- divergent: two descriptions of the same thing that differ in content (different sets of fields, stages, steps, roles or members) and the text does not say which of them is current. Report it only when the difference is substantive: a reader who builds on one description would get a materially different picture than from the other.
- revision: a later statement that explicitly changes, replaces or narrows an earlier one, and the text itself signals the change (a correction, "instead", "now", "replace", a new version). This is normal evolution, but the reader must use the later statement.

Do NOT report: the same thing said twice or reworded; a later passage that only adds detail, elements or examples without contradicting the earlier one; a concept compared with its own sub-parts or with a neighbouring concept; differences of style or of level of detail.

For every finding copy two quotes, "earlier" and "later" (in conversation order; inside one passage, in line order). Each quote must be copied character for character from ONE line of the passages, at most 25 words, together with the card id of the passage it comes from. Quotes are checked automatically and a finding whose quote is not found verbatim is discarded.

Return JSON only, no prose:
{{"findings": [{{"kind": "conflict|divergent|revision", "summary": "one sentence in Russian: what differs", "earlier": {{"card": "t025", "quote": "..."}}, "later": {{"card": "t043", "quote": "..."}}}}]}}
At most 6 findings, the most important first. If the passages are consistent, return {{"findings": []}}. Do not invent anything.

{passages}
"""

CANON_PROMPT = """Below are statements a team keeps as current: objects its desk has accepted as canon ("[id] title - note") and facts of its working ledger ("[ledger:key] key = value"). The date in parentheses is when the statement was accepted or recorded. Find pairs of statements that do not fit together.

Report three kinds of finding:
- conflict: two statements that cannot both be true (a different value, date or number for the same thing; a rule and its opposite).
- divergent: two statements about the same thing that differ in content, where neither says which one is current.
- revision: one statement looks like an older version of the other (the same thing with a newer value or wording). "earlier" is the older one: go by the dates; when the dates do not tell, say conflict instead.

Do NOT report: unrelated statements, statements that merely share a word, or a statement and a more detailed statement that agrees with it.

For every finding give the ids of both statements and one quote from each, copied character for character from that statement, at most 25 words. Quotes are checked automatically and a finding whose quote is not found verbatim is discarded.

Return JSON only, no prose:
{{"findings": [{{"kind": "conflict|divergent|revision", "summary": "one sentence in Russian: what differs", "earlier": {{"id": "D001", "quote": "..."}}, "later": {{"id": "ledger:budget", "quote": "..."}}}}]}}
If everything is consistent, return {{"findings": []}}. Do not invent anything.

{statements}
"""


# ---------------------------------------------------------------- отрывки (без модели)
@dataclass
class Passage:
    card: str
    l1: int
    l2: int
    ts: str
    lines: list = field(default_factory=list)

    def text(self) -> str:
        return "\n".join(self.lines)

    def render(self) -> str:
        return f"### {self.card} · {self.ts or 'no date'} · L{self.l1}-{self.l2}\n{self.text()}"


def _merge(ranges: list, gap: int = 1) -> list:
    out: list = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def card_lines(store, cid: str):
    """Строки карточки так, как их видит читатель (у реплик чата снята цитата «> »); нет карточки — None."""
    c = store._card(cid)
    if c is None or c["status"] != "active":
        return None
    ro = json.loads(c["meta"]).get("ro")
    return [cards.unquote(x) if ro else x for x in cards.split_lines(c["body"])]


def gather(store, pattern: str, window: int = 30, section_max: int = 120, max_chars: int = 120_000, kinds=("turn", "file")):
    """Отрывки о понятии: вокруг каждой строки с совпадением берём раздел карточки, если он не длиннее section_max строк, иначе ±window строк;
    пересекающиеся куски склеиваются. В репликах чата много пустых и коротких строк (в среднем ~13 знаков), поэтому окна нужны широкие: определение
    понятия обычно идёт строками ниже заголовка. Не помещаемся в max_chars — сужаем вдвое (раздел и окно), и так до одних строк с совпадением; а если и
    они не лезут, берём куски равномерно и говорим об этом в info["truncated"]. Возвращает (отрывки по порядку карточек, info)."""
    rx = re.compile(pattern, re.I)
    q = "SELECT id, body, meta, outline FROM cards WHERE status='active' AND kind IN (%s) ORDER BY id" % ",".join("?" * len(kinds))
    per_card = []
    for c in store.con.execute(q, list(kinds)).fetchall():
        ro = json.loads(c["meta"]).get("ro")
        lines = [cards.unquote(x) if ro else x for x in cards.split_lines(c["body"])]
        hits = [i for i, ln in enumerate(lines, 1) if rx.search(ln)]
        if hits:
            per_card.append((c["id"], lines, hits, [s for s in json.loads(c["outline"]) if len(s) == 3], json.loads(c["meta"]).get("ts", "")))
    info = dict(cards=len(per_card), hit_lines=sum(len(p[2]) for p in per_card), truncated=0, mode="sections")

    def build(win: int, sec: int) -> list:
        out = []
        for cid, lines, hits, outline, ts in per_card:
            n, rngs = len(lines), []
            for h in hits:
                best = None
                if sec:
                    for _, a, b in outline:
                        if 1 <= a <= h <= b <= n and b - a + 1 <= sec and (best is None or b - a < best[1] - best[0]):
                            best = (a, b)
                if best:                                   # раздел целиком, но не меньше двух строк по обе стороны от совпадения
                    lo, hi = min(best[0], h - 2), max(best[1], h + 2)
                else:
                    lo, hi = h - win, h + win
                rngs.append((max(1, lo), min(n, hi)))
            for a, b in _merge(rngs):
                out.append(Passage(cid, a, b, ts, lines[a - 1:b]))
        return out

    for step in range(6):
        win, sec = window >> step, section_max >> step
        passages = build(win, sec)
        info["mode"] = f"sections≤{sec} / window ±{win}"
        if sum(len(p.text()) for p in passages) <= max_chars:
            break
    total = sum(len(p.text()) for p in passages)
    if total > max_chars and passages:                     # даже одни строки не лезут: берём равномерно, но не молча
        keep = max(2, int(len(passages) * max_chars / total))
        step = len(passages) / keep
        picked = [passages[int(i * step)] for i in range(keep)]
        info["truncated"] = len(passages) - len(picked)
        passages = picked
    info["passages"] = len(passages)
    info["chars"] = sum(len(p.text()) for p in passages)
    return passages, info


# ---------------------------------------------------------------- проверка цитат (без модели)
def locate_all(quote: str, lines: list) -> list:
    """Все места цитаты как (l1, l2): сначала ищем в одной строке, не нашли — в двух подряд идущих, потом в трёх (берётся самый тесный охват).
    Слишком короткая цитата (меньше MIN_QUOTE знаков после нормализации) не ищется вовсе."""
    nq = cards.norm_quote(quote)
    if len(nq) < MIN_QUOTE:
        return []
    norm = [cards.norm_quote(x) for x in lines]
    for span in (1, 2, 3):
        hits = [(i + 1, i + span) for i in range(len(norm) - span + 1) if nq in " ".join(x for x in norm[i:i + span] if x)]
        if hits:
            return hits
    return []


def locate(quote: str, lines: list):
    """(l1, l2) первого места цитаты или None."""
    hits = locate_all(quote, lines)
    return hits[0] if hits else None


def parse_findings(res) -> list:
    """Ответ модели -> список находок нужного вида; всё, что не по форме, отбрасывается тихо (счёт отбракованного ведёт verify_chat)."""
    out = []
    fs = res.get("findings") if isinstance(res, dict) else None
    for f in fs if isinstance(fs, list) else []:
        if not isinstance(f, dict) or not isinstance(f.get("earlier"), dict) or not isinstance(f.get("later"), dict):
            out.append(None)
            continue
        out.append(f)
    return out


def verify_chat(store, findings: list, scope: list) -> tuple:
    """Находки из ответа модели -> (подтверждённые, счётчик отбракованного по причинам). Цитата ищется в названной карточке, а если там нет —
    в остальных карточках с отрывками (модель могла перепутать номер): нашли ровно так — исправляем и помечаем relabeled."""
    ok, bad = [], Counter()
    cache: dict = {}

    def lines_of(cid):
        if cid not in cache:
            cache[cid] = card_lines(store, cid)
        return cache[cid]

    def ground(side: dict):
        cid, quote = str(side.get("card", "")).strip().lower(), str(side.get("quote", "")).strip()
        if not quote:
            return None
        order = ([cid] if cid else []) + [c for c in scope if c != cid]
        for c in order:
            ls = lines_of(c)
            hits = locate_all(quote, ls) if ls else []
            if hits:
                # цитата подтверждает, что текст есть в карточке, но не что утверждение именно здесь: если таких мест несколько, это видно в отчёте
                return dict(card=c, l1=hits[0][0], l2=hits[0][1], quote=" ".join(quote.split()), relabeled=(c != cid), occurs=len(hits))
        return None

    seen = set()
    for f in findings:
        if f is None:
            bad["malformed"] += 1
            continue
        kind = str(f.get("kind", "")).strip().lower()
        if kind not in KINDS:
            bad["bad kind"] += 1
            continue
        a, b = ground(f["earlier"]), ground(f["later"])
        if not a or not b:
            bad["quote not found"] += 1
            continue
        a, b = sorted((a, b), key=lambda s: (s["card"], s["l1"]))
        if a["card"] == b["card"] and a["l1"] <= b["l2"] and b["l1"] <= a["l2"]:
            bad["same place"] += 1
            continue
        key = (a["card"], a["l1"], b["card"], b["l1"])
        if key in seen:
            bad["duplicate"] += 1
            continue
        seen.add(key)
        ok.append(dict(kind=kind, summary=" ".join(str(f.get("summary", "")).split()), a=a, b=b))
    return ok, bad


# ---------------------------------------------------------------- модель
COST: Counter = Counter()


class Judge:
    """Запросы к модели через Claude Agent SDK (подключается лениво: без него работают отрывки, проверка и --dry-run)."""

    def __init__(self, model: str, workers: int = 4, timeout: int = 600):
        self.model, self.timeout, self.sem = model, timeout, asyncio.Semaphore(workers)

    async def __call__(self, prompt: str):
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        async def once(p):
            res = None
            o = ClaudeAgentOptions(model=self.model, tools=[], setting_sources=[], max_turns=2, max_budget_usd=2,
                                   extra_args={"no-session-persistence": None}, thinking={"type": "disabled"})
            async for m in query(prompt=p, options=o):
                if isinstance(m, ResultMessage):
                    res = m
            return res

        for attempt in range(2):
            async with self.sem:
                try:
                    res = await asyncio.wait_for(once(prompt + ("\n\nReturn valid JSON only." if attempt else "")), self.timeout)
                except asyncio.TimeoutError:
                    print(f"semlint: тайм-аут {self.timeout} с", file=sys.stderr)
                    continue
                except Exception as e:  # noqa: BLE001
                    print("semlint: ошибка запроса:", type(e).__name__, str(e)[:120], file=sys.stderr)
                    continue
            if not res or not res.result:
                continue
            u = res.usage or {}
            COST["calls"] += 1
            COST["usd_reported"] += res.total_cost_usd or 0
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"):
                COST[k] += u.get(k, 0) or 0
            m = re.search(r"\{.*\}", res.result, re.S)
            try:
                return json.loads(m.group(0)) if m else None
            except json.JSONDecodeError:
                continue
        return None


# ---------------------------------------------------------------- понятие в чате
async def lint_concept(store, term: str, judge, pattern: str | None = None, **gather_kw) -> dict:
    """Один проход по понятию. judge(prompt) -> dict | None (async). Возвращает dict с находками, счётчиками и отрывками (для --json и отчёта)."""
    pat = pattern or re.escape(term).replace(r"\ ", r"\s+")
    passages, info = gather(store, pat, **gather_kw)
    out = dict(mode="chat", term=term, pattern=pat, info=info, findings=[], rejected={}, proposed=0, asked=False, failed=False)
    if info["hit_lines"] < 2:
        out["note"] = f"{info['hit_lines']} matching line(s): nothing to compare"
        return out
    prompt = CHAT_PROMPT.format(term=term, passages="\n\n".join(p.render() for p in passages))
    out["asked"], out["prompt_chars"] = True, len(prompt)
    if judge is None:                                   # --dry-run: показываем, что ушло бы
        out["dry"], out["prompt_head"] = True, prompt[:700]
        return out
    res = await judge(prompt)
    if res is None:
        out["failed"] = True
        return out
    raw = parse_findings(res)
    out["proposed"] = len(raw)
    out["findings"], rej = verify_chat(store, raw, sorted({p.card for p in passages}))
    out["rejected"] = dict(rej)
    return out


# ---------------------------------------------------------------- канон стола и журнал
def gather_canon(store) -> list:
    """Утверждения для сверки друг с другом: объекты стола со статусом canon (нужных типов) и действующие факты журнала."""
    out = []
    con = store._desk_con()
    if con is not None:
        try:
            types = list(store.project.get("canon_types") or ["fact", "decision"])
            for r in con.execute("SELECT id, type, title, body, updated_at FROM objects WHERE status='canon' AND type IN (%s) ORDER BY id" % ",".join("?" * len(types)), types):
                note = (r["body"] or "").strip().split("\n")[0]
                out.append(dict(id=r["id"], where="desk", text=r["title"] + (f" - {note}" if note else ""), ts=(r["updated_at"] or "")[:10]))
        finally:
            con.close()
    for r in store.con.execute("SELECT key, value, source, ts FROM facts WHERE status='active' ORDER BY key_norm"):
        out.append(dict(id="ledger:" + r["key"], where="ledger", text=f"{r['key']} = {r['value']}" + (f" (source: {r['source']})" if r["source"] else ""), ts=(r["ts"] or "")[:10]))
    return out


def suggest(f: dict, by_id: dict) -> str:
    """Команда для человека (ничего не выполняется). Стол: связать противоречие, а пересмотр оформить заменой; журнал: поправить значение."""
    a, b = f["a"]["id"], f["b"]["id"]
    both_desk = by_id[a]["where"] == by_id[b]["where"] == "desk"
    if both_desk and f["kind"] == "revision":
        return f"python3 pm.py exec SUPERSEDE {a} BY {b} <reason>   # if {b} is indeed the current one"
    if both_desk:
        return f"python3 pm.py exec WIRE {a} {b} contradicts   # then decide which one stays (SUPERSEDE)"
    return "decide which one holds; then bring the other in line (fact_set in the ledger, or SUPERSEDE in the desk)"


async def lint_canon(store, judge) -> dict:
    items = gather_canon(store)
    out = dict(mode="canon", term="canon + ledger", info=dict(statements=len(items)), findings=[], rejected={}, proposed=0, asked=False, failed=False)
    if len(items) < 2:
        out["note"] = f"{len(items)} statement(s): nothing to compare"
        return out
    by_id = {x["id"].lower(): x for x in items}
    prompt = CANON_PROMPT.format(statements="\n".join(f"[{x['id']}] {x['text']}" + (f" ({x['ts']})" if x.get("ts") else "") for x in items))
    out["asked"], out["prompt_chars"] = True, len(prompt)
    if judge is None:
        out["dry"], out["prompt_head"] = True, prompt[:700]
        return out
    res = await judge(prompt)
    if res is None:
        out["failed"] = True
        return out
    raw = parse_findings(res)
    out["proposed"] = len(raw)
    rej: Counter = Counter()
    seen = set()
    for f in raw:
        if f is None:
            rej["malformed"] += 1
            continue
        kind = str(f.get("kind", "")).strip().lower()
        if kind not in KINDS:
            rej["bad kind"] += 1
            continue
        sides = []
        for key in ("earlier", "later"):
            s = f[key]
            item = by_id.get(str(s.get("id", "")).strip().lower())
            quote = " ".join(str(s.get("quote", "")).split())
            if item is None:
                rej["unknown id"] += 1
                break
            nq = cards.norm_quote(quote)
            if len(nq) < MIN_QUOTE or nq not in cards.norm_quote(item["text"]):
                rej["quote not found"] += 1
                break
            sides.append(dict(id=item["id"], quote=quote))
        else:
            if sides[0]["id"] == sides[1]["id"]:
                rej["same place"] += 1
                continue
            key = frozenset((sides[0]["id"], sides[1]["id"]))
            if key in seen:
                rej["duplicate"] += 1
                continue
            seen.add(key)
            fnd = dict(kind=kind, summary=" ".join(str(f.get("summary", "")).split()), a=sides[0], b=sides[1])
            fnd["suggest"] = suggest(fnd, {x["id"]: x for x in items})
            out["findings"].append(fnd)
    out["rejected"] = dict(rej)
    return out


# ---------------------------------------------------------------- отчёт
def report(r: dict) -> str:
    info = r["info"]
    head = f"SEMLINT «{r['term']}»"
    if r["mode"] == "chat":
        head += f": {info['hit_lines']} lines in {info['cards']} cards"
        if r["asked"]:
            head += f" → {info['passages']} passages, {info['chars'] // 1000}K chars ({info['mode']})" + (f", {info['truncated']} left out to fit" if info["truncated"] else "")
    else:
        head += f": {info['statements']} statements"
    if r.get("note"):
        return head + f" — {r['note']}"
    if r.get("dry"):
        return head + f" — dry run, the request would be {r['prompt_chars']} chars; it starts:\n{r['prompt_head']}…"
    if r["failed"]:
        return head + " — the model gave no usable answer"
    cnt = Counter(f["kind"] for f in r["findings"])
    rej = sum(r["rejected"].values())
    line = head + f" → {len(r['findings'])} findings" + (" (" + ", ".join(f"{cnt[k]} {k}" for k in KINDS if cnt[k]) + ")" if r["findings"] else "")
    if rej:
        line += f"; {rej} dropped: " + ", ".join(f"{n} {why}" for why, n in r["rejected"].items())
    lines = [line]
    for i, f in enumerate(r["findings"], 1):
        lines.append(f"  {i}. {f['kind']}")
        for tag, s in (("earlier", f["a"]), ("later  ", f["b"])):
            if r["mode"] == "chat":
                at = (f"{s['card']} L{s['l1']}" + (f"-{s['l2']}" if s["l2"] != s["l1"] else "") + (" (card id corrected)" if s.get("relabeled") else "")
                      + (f" (the quote occurs {s['occurs']} times in this card, the first is shown)" if s.get("occurs", 1) > 1 else ""))
            else:
                at = s["id"]
            lines.append(f"       {tag} {at}: «{s['quote']}»")
        lines.append(f"       {f['summary']}")
        if f.get("suggest"):
            lines.append(f"       → {f['suggest']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- командная строка
def pick_model(arg: str | None) -> str:
    m = arg or os.environ.get("SEMLINT_MODEL") or os.environ.get("EVAL_MODEL") or ""
    if not m:
        raise SystemExit("задайте идентификатор модели: --model ... или переменную SEMLINT_MODEL (или EVAL_MODEL); без модели работает только --dry-run")
    return m


async def run(ns, store) -> list:
    judge = None if ns.dry_run else Judge(pick_model(ns.model), workers=ns.workers)      # None — модель не зовём
    kw = dict(window=ns.window, section_max=ns.section_max, max_chars=ns.max_chars)
    if ns.canon:
        return [await lint_canon(store, judge)]
    if ns.pattern and len(ns.concepts) != 1:
        raise SystemExit("--pattern годится для одного понятия")
    return await asyncio.gather(*[lint_concept(store, t, judge, pattern=ns.pattern, **kw) for t in ns.concepts])


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Смысловой lint: расхождения между утверждениями (модель предлагает, скрипт проверяет цитаты)")
    ap.add_argument("concepts", nargs="*", help="названия понятий (ищутся в чатах и файлах картотеки без учёта регистра)")
    ap.add_argument("--db", default=os.environ.get("CARDS_DB", str(HERE / "cards.sqlite")))
    ap.add_argument("--config", default=None, help="настройки проекта (по умолчанию engine/cards/project.json)")
    ap.add_argument("--canon", action="store_true", help="сверить канон стола и действующие факты журнала")
    ap.add_argument("--pattern", default=None, help="регулярное выражение вместо самого названия (одно понятие)")
    ap.add_argument("--window", type=int, default=30, help="строк вокруг совпадения, если раздела нет или он длинный (по умолчанию 30)")
    ap.add_argument("--section-max", type=int, default=120, help="раздел карточки берём целиком, если он не длиннее стольких строк (по умолчанию 120)")
    ap.add_argument("--max-chars", type=int, default=120_000, help="предел отрывков на один запрос (по умолчанию 120000 знаков)")
    ap.add_argument("--model", default=None)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true", help="показать, что отправилось бы, и не звать модель")
    ap.add_argument("--json", action="store_true", help="выдать результат как JSON")
    ap.add_argument("--out", default=None, help="записать JSON в файл")
    ns = ap.parse_args(argv)
    if not ns.canon and not ns.concepts:
        ap.error("назовите понятие или задайте --canon")
    store = cards.Store(Path(ns.db), project=cards.load_project(ns.config))
    try:
        results = asyncio.run(run(ns, store))
    finally:
        store.con.close()
    if ns.out:
        Path(ns.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    if ns.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    else:
        print("\n\n".join(report(r) for r in results))
        if COST["calls"]:
            tin = COST["input_tokens"] + COST["cache_creation_input_tokens"] + COST["cache_read_input_tokens"]
            print(f"\n[{COST['calls']} calls, {tin} tokens in, {COST['output_tokens']} out, reported by the CLI ${COST['usd_reported']:.3f}]", file=sys.stderr)


if __name__ == "__main__":
    main()

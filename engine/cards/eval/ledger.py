"""Журнал фактов против ленты и сжатия: длинный шумный чат с поправками, в конце — проверочные вопросы.

    python3 ledger.py --arm plain|compact|ledger|ledger-user --run 1 --out OUT [--seed 1] [--model ID]  (по умолчанию EVAL_MODEL_SMALL)

  plain        одна живая сессия, всё в ленте (как обычный чат)
  compact      то же, но перед проверочными вопросами команда /compact (сжатие ленты)
  ledger       каждый ход — НОВАЯ сессия без истории; в промпте только срез «действующих фактов»; факты пишет сам агент
               (fact_set), в том числе то, что он придумал сам (например, названия модулей)
  ledger-user  то же, но агент записывает только факты пользователя (свои выдумки не записывает) — чтобы показать, что теряется

Сценарий «Север-XL» строится из зерна (seed): 14 фактов о проекте, 11 поправок (часть фактов меняется дважды), 3 просьбы придумать названия
(это слова ассистента, не пользователя), ~70 вставок кода как шум, в конце 25 проверочных вопросов.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

from common import SMALL_MODEL, card_server, cards, need_model

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, ToolUseBlock, query)

ROOT = Path(__file__).resolve().parents[3]
# малая модель, $ за миллион токенов для промптов до 100K (по справочнику цен); дальше ставки выше, поэтому ниже сравниваем ещё и токены
RATES = dict(i=0.10, w=0.20, cr=0.01, o=0.50)

# --- факты: (ключ, подпись, начальное значение, поправки, как спросить, проверка текущего, проверка начального)
FACTS = [
    ("budget", "бюджет", "120 000 евро", ["96 000 евро", "88 500 евро"], "Какой сейчас бюджет проекта в евро? Ответь только числом.", r"88[\s .,]?500", r"120[\s .,]?000"),
    ("deadline", "дедлайн", "15 марта", ["22 марта", "5 апреля"], "Какой сейчас дедлайн проекта? Ответь только датой.", r"5\s*апрел|05\.04|5\.04", r"15\s*март|15\.0?3"),
    ("lead", "руководитель", "Анна Ковач", ["Борис Ланг"], "Кто сейчас руководитель проекта? Ответь только именем и фамилией.", r"ланг", r"ковач"),
    ("deputy", "заместитель", "Игорь Фролов", ["Мария Вега"], "Кто сейчас заместитель руководителя? Ответь только именем и фамилией.", r"вега", r"фролов"),
    ("server", "сервер", "Нюрнберг", ["Хельсинки"], "В каком городе сейчас стоит сервер? Ответь одним словом.", r"хельсинк", r"нюрнберг"),
    ("stack", "стек", "Python и SQLite", ["Python и PostgreSQL"], "Какая сейчас база данных в стеке проекта? Ответь одним словом.", r"postgres", r"sqlite"),
    ("team", "размер команды", "7 человек", ["9 человек", "6 человек"], "Сколько человек сейчас в команде? Ответь только числом.", r"\b6\b|шест", r"\b7\b|сем"),
    ("pilot", "пилотный заказчик", "«Альфа-Транс»", ["«Бета-Логистик»"], "Кто сейчас пилотный заказчик? Ответь только названием.", r"бета", r"альфа"),
    ("risk", "уровень риска", "средний", ["высокий"], "Какой сейчас уровень риска проекта? Ответь одним словом.", r"высок", r"средн"),
    ("email", "контактная почта", "north@example.org", ["team-north@example.org"], "Какая сейчас контактная почта проекта? Ответь только адресом.", r"team-north@example\.org", r"^north@example\.org"),
    ("codename", "кодовое имя релиза", "«Шторм»", [], "Как называется релиз? Ответь только кодовым именем.", r"шторм", None),
    ("phone", "телефон поддержки", "+49 911 555 0142", [], "Какой телефон поддержки? Ответь только номером.", r"555[\s-]?0142", None),
    ("license", "лицензия", "MIT", [], "Какая лицензия у проекта? Ответь одним словом.", r"\bmit\b", None),
    ("start", "дата начала", "1 февраля", [], "Какая дата начала проекта? Ответь только датой.", r"1\s*феврал|01\.02|1\.02", None),
]
MODULES = [("reports", "модуля отчётов"), ("billing", "модуля биллинга"), ("alerts", "модуля уведомлений")]


def pick_noise(rnd: random.Random, n: int) -> list:
    """Вставки кода из репозитория (шум): окна по 60–110 строк."""
    files = [f for f in subprocess.run(["git", "-C", str(ROOT), "ls-files", "src", "scripts", "engine/pm.py"], capture_output=True, text=True).stdout.split("\n")
             if f.endswith((".ts", ".tsx", ".mjs", ".py")) and "cards" not in f]
    out = []
    for _ in range(n):
        f = rnd.choice(files)
        lines = (ROOT / f).read_text(encoding="utf-8", errors="replace").split("\n")
        k = min(len(lines), rnd.randint(60, 110))
        a = rnd.randint(0, max(0, len(lines) - k))
        out.append("Справочный фрагмент кода, читать не нужно. Ответь одним словом: принято.\n```\n" + "\n".join(lines[a:a + k]) + "\n```")
    return out


def build_scenario(seed: int, n_noise: int = 70) -> dict:
    rnd = random.Random(seed)
    setup = [
        "Начинаем проект «Север». Бюджет {budget}, дедлайн {deadline}, руководитель {lead}, заместитель {deputy}. Ответь одним словом: принято.",
        "Добавь к проекту: стек {stack}, сервер в городе {server}, команда {team}. Ответь одним словом: принято.",
        "Ещё данные: пилотный заказчик {pilot}, уровень риска {risk}, контактная почта {email}. Ответь одним словом: принято.",
        "И последнее: кодовое имя релиза {codename}, телефон поддержки {phone}, лицензия {license}, дата начала {start}. Ответь одним словом: принято.",
    ]
    init = {k: v for k, _, v, *_ in FACTS}
    setup = [s.format(**init) for s in setup]
    corr = []                                               # (ключ, индекс поправки) в порядке применения
    for k, lab, v0, ch, *_ in FACTS:
        for i, new in enumerate(ch):
            corr.append((k, i, f"Поправка: {lab} теперь {new}. Ответь одним словом: исправлено."))
    names = [(k, f"Придумай ровно три коротких названия для {m}, каждое одним словом, через запятую. Ничего больше.") for k, m in MODULES]
    noise = pick_noise(rnd, n_noise)
    # порядок: сначала setup, потом всё остальное вперемешку (поправки одного факта — в исходном порядке)
    rest = [("noise", t) for t in noise] + [("name", t) for t in names]
    rnd.shuffle(rest)
    slots = [("corr", c) for c in corr]
    seq = rest[:]
    positions = sorted(rnd.sample(range(len(seq) + len(slots)), len(slots)))
    merged, ci, ri = [], 0, 0
    for idx in range(len(seq) + len(slots)):
        if ci < len(slots) and idx == positions[ci]:
            merged.append(slots[ci]); ci += 1
        else:
            merged.append(seq[ri]); ri += 1
    turns = [dict(id=f"s{i + 1}", kind="setup", text=t) for i, t in enumerate(setup)]
    nn = 0
    for kind, val in merged:
        nn += 1
        if kind == "corr":
            turns.append(dict(id=f"c{nn}", kind="correction", text=val[2], fact=val[0]))
        elif kind == "name":
            turns.append(dict(id=f"n{nn}", kind="name", text=val[1], module=val[0]))
        else:
            turns.append(dict(id=f"p{nn}", kind="noise", text=val))
    probes = []
    for k, lab, v0, ch, ask, cur, hist in FACTS:
        probes.append(dict(id=f"cur_{k}", kind="current", text=ask, must=[cur], forbid=(hist if ch else None)))
    for k, lab, v0, ch, ask, cur, hist in FACTS:
        if ch:
            probes.append(dict(id=f"hist_{k}", kind="history", text=f"Каким {lab} было ИЗНАЧАЛЬНО, в самом начале проекта (до всех поправок)? Ответь только значением.", must=[hist]))
    for k, lab, v0, ch, *_ in FACTS:
        if len(ch) == 2:
            probes.append(dict(id=f"cnt_{k}", kind="count", text=f"Сколько раз за этот чат менялся {lab}? Ответь только числом.", must=[r"\b2\b|дв[аа]|дважды"]))
    for key, m in MODULES:
        probes.append(dict(id=f"self_{key}", kind="selfref", text=f"Какие три названия для {m} ты предлагал? Только названия через запятую.", module=key))
    return dict(seed=seed, turns=turns, probes=probes)


def norm(s: str) -> str:
    return (s or "").lower().replace("ё", "е").replace(" ", " ").replace(" ", " ")


def score_probe(p: dict, ans: str, name_answers: dict) -> bool:
    a = norm(ans)
    if p["kind"] == "selfref":
        given = name_answers.get(p["module"], "")
        t = norm(given).split(":", 1)[-1]
        toks = [re.sub(r"[\"'«».:\s]+", " ", x).strip() for x in re.split(r"[,\n;]+", t)]
        toks = [x for x in toks if x][:3]
        return len(toks) == 3 and all(x in a for x in toks)
    ok = all(re.search(rx, a) for rx in p["must"])
    if ok and p.get("forbid") and re.search(p["forbid"], a):
        ok = False
    return ok


def cost(i, w, cr, o) -> float:
    return (i * RATES["i"] + w * RATES["w"] + cr * RATES["cr"] + o * RATES["o"]) / 1e6


LEDGER_RULES = (
    "You are an assistant in a long conversation, but you do NOT see earlier messages: your only memory is a fact ledger (tools fact_set, facts, fact_history). "
    "The current ledger is shown at the top of each message.\n"
    "Rules:\n"
    "1. When the user states or corrects project data, record EACH datum with fact_set using a short stable key (budget, deadline, lead, deputy, stack, server, "
    "team, pilot, risk, email, codename, phone, license, start). A correction overwrites the same key. Do this before answering.\n"
    "{own}"
    "3. Answer questions about the project from the ledger (use fact_history for earlier values or how many times something changed; version v2 means one change).\n"
    "4. Follow the user's answer-format instructions exactly (for example 'one word'). Code fragments are noise: just answer as asked, record nothing.\n")
OWN_RULE = ("2. If you yourself produce content that may be asked about later (for example names you invent), record it too with a key like 'proposal.reports' "
            "and the exact text you answered.\n")


async def run_live(turns, probes, compact: bool, model: str):
    recs, names = [], {}
    o = ClaudeAgentOptions(model=model, cwd=tempfile.mkdtemp(), tools=[], setting_sources=[], max_turns=3, max_budget_usd=3,
                           extra_args={"no-session-persistence": None})
    c = ClaudeSDKClient(options=o)
    await c.connect()
    try:
        seq = list(turns) + ([dict(id="compact", kind="cmd", text="/compact")] if compact else []) + list(probes)
        for t in seq:
            t0 = time.perf_counter()
            calls, res = {}, None
            await c.query(t["text"])
            async for m in c.receive_response():
                if isinstance(m, AssistantMessage):
                    u = m.usage or {}
                    calls[m.message_id or id(m)] = (u.get("input_tokens", 0) or 0, u.get("cache_creation_input_tokens", 0) or 0, u.get("cache_read_input_tokens", 0) or 0)
                elif isinstance(m, ResultMessage):
                    res = m
            i, w, cr = (sum(x[k] for x in calls.values()) for k in range(3))
            ans = res.result if res else ""
            if t["kind"] == "name":
                names[t["module"]] = ans
            recs.append(dict(id=t["id"], kind=t["kind"], ans=ans, i=i, w=w, cr=cr, o=(res.usage or {}).get("output_tokens", 0) if res else 0,
                             size=max([sum(x) for x in calls.values()] or [0]), secs=round(time.perf_counter() - t0, 1), reported=res.total_cost_usd if res else None))
    finally:
        await c.disconnect()
    return recs, names


async def run_ledger(turns, probes, own: bool, model: str):
    recs, names = [], {}
    db = Path(tempfile.mkdtemp()) / "ledger.sqlite"
    st = cards.Store(db)
    srv = card_server(st, names={"fact_set", "facts", "fact_history"})
    allowed = ["mcp__cards__fact_set", "mcp__cards__facts", "mcp__cards__fact_history"]
    system = LEDGER_RULES.format(own=OWN_RULE if own else "")
    for t in turns + probes:
        t0 = time.perf_counter()
        o = ClaudeAgentOptions(model=model, cwd=tempfile.mkdtemp(), tools=[], mcp_servers={"cards": srv}, allowed_tools=allowed, system_prompt=system,
                               setting_sources=[], max_turns=8, max_budget_usd=1, extra_args={"no-session-persistence": None})
        prompt = "LEDGER (current facts):\n" + st.facts() + "\n\nUSER: " + t["text"]
        calls, res, writes = {}, None, 0
        async for m in query(prompt=prompt, options=o):
            if isinstance(m, AssistantMessage):
                u = m.usage or {}
                calls[m.message_id or id(m)] = (u.get("input_tokens", 0) or 0, u.get("cache_creation_input_tokens", 0) or 0, u.get("cache_read_input_tokens", 0) or 0)
                writes += sum(1 for b in m.content if isinstance(b, ToolUseBlock) and b.name.endswith("fact_set"))
            elif isinstance(m, ResultMessage):
                res = m
        i, w, cr = (sum(x[k] for x in calls.values()) for k in range(3))
        ans = res.result if res else ""
        if t["kind"] == "name":
            names[t["module"]] = ans
        recs.append(dict(id=t["id"], kind=t["kind"], ans=ans, i=i, w=w, cr=cr, o=(res.usage or {}).get("output_tokens", 0) if res else 0, fact_sets=writes,
                         size=max([sum(x) for x in calls.values()] or [0]), secs=round(time.perf_counter() - t0, 1), reported=res.total_cost_usd if res else None))
    recs.append(dict(id="ledger_final", kind="ledger", ans=st.facts()))
    return recs, names


async def main_async(ns):
    need_model(ns.model, "EVAL_MODEL_SMALL")
    sc = build_scenario(ns.seed, ns.noise)
    turns, probes = sc["turns"], sc["probes"]
    if ns.arm in ("plain", "compact"):
        recs, names = await run_live(turns, probes, ns.arm == "compact", ns.model)
    else:
        recs, names = await run_ledger(turns, probes, ns.arm == "ledger", ns.model)
    by = {p["id"]: p for p in probes}
    kinds = {}
    for r in recs:
        if r["id"] in by:
            r["ok"] = bool(score_probe(by[r["id"]], r["ans"] or "", names))
            kinds.setdefault(r["kind"], []).append(r["ok"])
    work = [r for r in recs if "i" in r and r["kind"] != "ledger"]
    tot_in = sum(r["i"] + r["w"] + r["cr"] for r in work)
    first = [r["size"] for r in work[:10]]
    doc = dict(arm=ns.arm, run=ns.run, seed=ns.seed, noise=ns.noise, turns=recs, kinds={k: [sum(v), len(v)] for k, v in kinds.items()},
               total=[sum(sum(v) for v in kinds.values()), sum(len(v) for v in kinds.values())], tokens_in=tot_in,
               usd=sum(cost(r["i"], r["w"], r["cr"], r["o"]) for r in work), reported=sum(r["reported"] or 0 for r in work[-1:]) if ns.arm in ("plain", "compact") else sum(r["reported"] or 0 for r in work),
               prompt_first10_avg=statistics.mean(first), prompt_probe_avg=statistics.mean(r["size"] for r in recs if r["id"] in by))
    out = Path(ns.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"ledger__{ns.arm}__n{ns.noise}__r{ns.run}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    ks = "  ".join(f"{k} {v[0]}/{v[1]}" for k, v in doc["kinds"].items())
    print(f"{ns.arm} n{ns.noise} r{ns.run}: {doc['total'][0]}/{doc['total'][1]} | {ks} | токенов на входе {tot_in:,} | ~${doc['usd']:.3f} | промпт на пробах ~{doc['prompt_probe_avg']:,.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=("plain", "compact", "ledger", "ledger-user"))
    ap.add_argument("--run", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--noise", type=int, default=70, help="сколько вставок кода (шум) между фактами")
    ap.add_argument("--model", default=SMALL_MODEL)
    ap.add_argument("--out", required=True)
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

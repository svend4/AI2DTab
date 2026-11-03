"""Общее для стенда измерений: живая сессия Agent SDK, учёт токенов и денег, инструменты картотеки как SDK-инструменты.

Нужен пакет claude-agent-sdk (pip install claude-agent-sdk) и доступ к Claude (ключ ANTHROPIC_API_KEY или вход в Claude Code).
Модели задаются переменными окружения: EVAL_MODEL — основная (её и меряем), EVAL_MODEL_SMALL — малая (журнал фактов, подписи каталога).
Ставки ниже, $ за миллион токенов, — для основной модели: вход 2, запись в кэш на 1 час 4, чтение кэша 0.10, вывод 10. Для другой модели поправьте RATES.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import cards  # noqa: E402

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage,  # noqa: E402
                              ToolUseBlock, create_sdk_mcp_server, tool)

RATES = dict(i=2.0, w=4.0, cr=0.10, o=10.0)
MODEL = os.environ.get("EVAL_MODEL", "")
SMALL_MODEL = os.environ.get("EVAL_MODEL_SMALL", "")


def need_model(model: str, env: str) -> str:
    if not model:
        raise SystemExit(f"задайте переменную окружения {env}: идентификатор модели для этого скрипта")
    return model


def dollars(i=0, w=0, cr=0, o=0, rates=RATES) -> float:
    return (i * rates["i"] + w * rates["w"] + cr * rates["cr"] + o * rates["o"]) / 1e6


def card_server(store: cards.Store, names=None, spy=None):
    """Инструменты картотеки (cards.TOOL_SPECS) как SDK-инструменты. spy(name, args, text) вызывается после каждого вызова."""
    tools = []
    for spec in cards.TOOL_SPECS:
        if names and spec["name"] not in names:
            continue

        def make(spec):
            schema = {"type": "object", "properties": spec["props"], "required": spec["required"]}

            @tool(spec["name"], spec["description"], schema)
            async def handler(args, _n=spec["name"]):
                text = cards.call_tool(store, _n, args)
                if spy:
                    spy(_n, args, text)
                return {"content": [{"type": "text", "text": text}]}
            return handler
        tools.append(make(spec))
    return create_sdk_mcp_server("cards", "0.1", tools)


def norm(s: str) -> str:
    return (s or "").replace(" ", " ").replace(" ", " ")


def check_answer(q: dict, ans: str) -> bool:
    a = norm(ans)
    ok = all(re.search(rx, a, re.I) for rx in q.get("check", []))
    if q.get("forbid") and re.search(q["forbid"], a, re.I):
        ok = False
    return ok


async def run_session(options: ClaudeAgentOptions, prompts: list, timeout: int = 600, verify=None) -> dict:
    """Живая сессия: prompts идут подряд. На каждый вызов записываем токены (вход / запись / чтение), цену, время и использованные инструменты.

    verify(prompt, answer) -> bool | None: проверка после хода (для правок: смотрим файлы). Если None, используется check_answer.
    """
    recs, prev_cost, err = [], 0.0, None
    client = ClaudeSDKClient(options=options)
    await client.connect()
    try:
        for p in prompts:
            t0 = time.perf_counter()
            calls, used, res = {}, [], None
            try:
                async with asyncio.timeout(timeout):
                    await client.query(p["text"])
                    async for m in client.receive_response():
                        if isinstance(m, AssistantMessage):
                            u = m.usage or {}
                            calls[m.message_id or id(m)] = dict(
                                i=u.get("input_tokens", 0) or 0, w=u.get("cache_creation_input_tokens", 0) or 0,
                                cr=u.get("cache_read_input_tokens", 0) or 0)
                            for b in m.content:
                                if isinstance(b, ToolUseBlock):
                                    used.append([b.name, json.dumps(b.input, ensure_ascii=False)[:160]])
                        elif isinstance(m, ResultMessage):
                            res = m
            except TimeoutError:
                err = f"timeout on {p['id']}"
            ans = res.result if res else None
            u = (res.usage or {}) if res else {}
            i, w, cr = (sum(c[k] for c in calls.values()) for k in ("i", "w", "cr"))
            o = u.get("output_tokens") or 0
            cost = res.total_cost_usd if res else None
            ok = verify(p, ans) if verify else check_answer(p, ans or "")
            recs.append(dict(id=p["id"], type=p.get("type"), ans=ans, ok=bool(ok), calls=len(calls), tools=used,
                             sizes=[c["i"] + c["w"] + c["cr"] for c in calls.values()], i=i, w=w, cr=cr, o=o,
                             usd=dollars(i, w, cr, o), usd_reported=(cost - prev_cost) if cost is not None else None,
                             secs=round(time.perf_counter() - t0, 1), is_error=bool(res.is_error) if res else True))
            prev_cost = cost or prev_cost
            if err:
                break
    finally:
        await client.disconnect()
    return dict(error=err, turns=recs)


def summarize(turns: list) -> dict:
    """Итоги прогона: верных ответов, вызовов на вопрос, токенов на входе, цена, медианное время."""
    import statistics
    n = len(turns)
    if not n:
        return {}
    return dict(n=n, ok=sum(t["ok"] for t in turns), calls=sum(t["calls"] for t in turns) / n,
                tokens_in=sum(t["i"] + t["w"] + t["cr"] for t in turns), usd=sum(t["usd"] for t in turns),
                median_s=statistics.median(t["secs"] for t in turns), out=sum(t["o"] for t in turns),
                first_usd=turns[0]["usd"], rest_usd=(sum(t["usd"] for t in turns[1:]) / max(1, n - 1)))

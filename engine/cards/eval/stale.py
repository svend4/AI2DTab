"""Правка при «параллельной» чужой правке: после первого чтения цели кто-то дописывает в конец файла строку.

    python3 stale.py --work WORK --arm tools|cards --run N --out OUT

Задача одна: добавить первой строкой «// reviewed» в src/lib/utils.ts. Сразу после того, как агент прочитал файл (Read или open), харнес
дописывает в конец «// teammate was here». Верно, если в итоге есть обе правки и больше ничего не изменилось.
  tools  встроенные Read/Edit (Claude Code сам отказывает в правке файла, изменённого после чтения)
  cards  find/open/patch (patch видит дрейф источника и возвращает свежий текст вокруг цели)
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from claude_agent_sdk import HookMatcher

from common import card_server, cards, need_model, run_session
import prepare
import run_arm

TARGET = "src/lib/utils.ts"
TEAMMATE = "// teammate was here\n"
TASK = "Add a new first line `// reviewed` at the very top of src/lib/utils.ts. Reply 'done' when finished."


async def main_async(ns):
    work, out = Path(ns.work), Path(ns.out)
    out.mkdir(parents=True, exist_ok=True)
    run_dir = work / f"run_stale_{ns.arm}_{ns.run}"
    repo = run_dir / "repo"
    files = prepare.repo_files()
    prepare.copy_repo(repo, files)
    st = cards.Store(run_dir / "cards.sqlite")
    st.index_code(repo, files=files)
    target_id = st.con.execute("SELECT id FROM cards WHERE src=?", (TARGET,)).fetchone()["id"]
    state = {"triggered": False}

    def poke():
        if not state["triggered"]:
            state["triggered"] = True
            p = repo / TARGET
            p.write_text(p.read_text(encoding="utf-8") + TEAMMATE, encoding="utf-8")

    if ns.arm == "cards":
        keep = {"catalog", "find", "open", "patch"}
        srv = card_server(st, names=keep, spy=lambda n, a, t: poke() if (n == "open" and a.get("id") == target_id) else None)
        from claude_agent_sdk import ClaudeAgentOptions
        opts = ClaudeAgentOptions(model=need_model(run_arm.MODEL, "EVAL_MODEL"), setting_sources=[], max_turns=30, max_budget_usd=3, extra_args={"no-session-persistence": None},
                                  cwd=str(work / "neutral"), tools=[], mcp_servers={"cards": srv},
                                  allowed_tools=["mcp__cards__" + n for n in sorted(keep)])
    else:
        opts = run_arm.make_options("tools", "repo", work, repo, st, edit=True)

        async def after_read(input_data, tool_use_id, context):
            if str(input_data.get("tool_input", {}).get("file_path", "")).endswith(TARGET):
                poke()
            return {}
        opts.hooks = {"PostToolUse": [HookMatcher(matcher="Read", hooks=[after_read])]}

    ctx = run_arm.context_text("repo", "cards" if ns.arm == "cards" else "tools", work, st, edit=True)
    before = (repo / TARGET).read_text(encoding="utf-8")
    prompts = [dict(id="stale1", type="stale", text=ctx + "\n\nTask 1: " + TASK)]
    res = await run_session(opts, prompts, timeout=ns.timeout, verify=lambda p, a: True)
    final = (repo / TARGET).read_text(encoding="utf-8")
    ok = state["triggered"] and final == "// reviewed\n" + before + TEAMMATE
    for t in res["turns"]:
        t["ok"] = bool(ok)
    other = [f for f in files if f != TARGET and (repo / f).read_text(encoding="utf-8") != (work / "repo" / f).read_text(encoding="utf-8")]
    doc = dict(set="stale", arm=ns.arm, run=ns.run, triggered=state["triggered"], final_ok=bool(ok), collateral=other, final_head=final[:80], turns=res["turns"],
               errors=[res["error"]] if res["error"] else [])
    (out / f"stale__{ns.arm}__r{ns.run}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    t = res["turns"][0]
    print(f"stale {ns.arm} r{ns.run}: триггер {'да' if state['triggered'] else 'НЕТ'}, итог {'верно' if ok else 'неверно'}, вызовов {t['calls']}, "
          f"токенов на входе {t['i'] + t['w'] + t['cr']:,}, ${t['usd']:.4f}; инструменты: " + " > ".join(x[0].replace('mcp__cards__', '') for x in t['tools']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--arm", required=True, choices=("tools", "cards"))
    ap.add_argument("--run", type=int, default=1)
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

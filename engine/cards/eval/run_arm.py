"""Один прогон измерения: набор вопросов × способ доступа к материалу, живая сессия Agent SDK (модель — EVAL_MODEL).

    python3 run_arm.py --work WORK --set repo_lookup|repo_semantic|repo_edit|chat|chat_pos --arm flat|tools|tools+cat|cards|cards-l1 --run 1 --out OUT

Способы доступа:
  flat       весь корпус в первом сообщении, без инструментов (только репозиторий: чат в окно не влезает)
  tools      встроенные Read, Grep, Glob (+ Edit для правок)
  tools+cat  то же + обзор-каталог в первом сообщении (для чата с диапазонами строк файла)
  cards      инструменты картотеки catalog/find/open (+ patch) + полный каталог в первом сообщении
  cards-l1   то же, но в первом сообщении только список групп; строки групп — инструментом catalog(group)
"""
from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import re
import sys
from pathlib import Path

from common import MODEL, ClaudeAgentOptions, card_server, cards, need_model, run_session, summarize
import prepare

DATA = Path(__file__).resolve().parent / "data"
SETS = {
    "repo_lookup": ("repo", "questions_repo_lookup.json"),
    "repo_semantic": ("repo", "questions_repo_semantic.json"),
    "repo_edit": ("repo", "questions_repo_edit.json"),
    "chat": ("chat", "questions_chat.json"),
    "chat_pos": ("chat", "questions_chat_pos.json"),
}
HEADER = {
    "repo": "You answer questions about a software repository (96 files: a TypeScript/React app, a Python engine, scripts, docs). "
            "Give only the final answer on ONE line (for example 'path/to/file.ext:123', a file path, a name or a number) with no explanation.",
    "chat": "You answer questions about a long chat transcript between a user and an AI assistant (Russian with English terms, about 4.7 MB, "
            "81 exchanges). Give only the final answer on ONE line: a short phrase, number or name, copied from the transcript where possible, "
            "with no explanation.",
    "edit": "You are a coding assistant working on a software repository (96 files). Make each requested change with the available tools, "
            "change nothing else, and reply 'done' when finished.",
}


def simple_catalog(st: cards.Store) -> str:
    return "\n".join(f"{r['title']} | {r['nlines']} lines | {r['summary']}" for r in
                     st.con.execute("SELECT * FROM cards WHERE kind='file' AND status='active' ORDER BY title"))


def context_text(domain: str, arm: str, work: Path, st: cards.Store, edit: bool, raw_cat: str = "chat_raw_catalog.txt") -> str:
    head = HEADER["edit" if edit else domain]
    patch_note = " Use patch(id, version, old, new) to edit (it writes the file)." if edit else ""
    if arm == "flat":
        return head + "\n\nThe repository's full text follows. Each file starts with '=== path (N lines) ===' and every line is prefixed with its line number.\n\n" \
            + (work / "flat.txt").read_text(encoding="utf-8")
    if domain == "repo":
        tools_txt = "You can explore the repository with the Read, Grep, Glob" + (" and Edit" if edit else "") + " tools (the current directory is the repository root)."
        if arm == "tools":
            return head + "\n\n" + tools_txt
        if arm == "tools+cat":
            return head + "\n\n" + tools_txt + " Below is a catalog: path | number of lines | summary. Use it to decide where to look and open only what you need.\n\nCATALOG\n" + simple_catalog(st)
        intro = ("The repository is stored as cards: one card per file (ids like f012), grouped by directory. Tools: catalog(group), find(query), "
                 "open(id, section | lines)." + patch_note + " Line numbers inside a card are the file's line numbers. ")
    else:
        tools_txt = ("The transcript is the file chat.md in the current directory (344K lines, 4.7 MB; every exchange starts with the line '# you asked'). "
                     "Explore it with Grep and Read (use offset and limit; never read the whole file).")
        if arm == "tools":
            return head + "\n\n" + tools_txt
        if arm == "tools+cat":
            return head + "\n\n" + tools_txt + " Below is a catalog of the exchanges: id | line range in chat.md | time | size | summary (threads group them).\n\nCATALOG\n" \
                + (work / raw_cat).read_text(encoding="utf-8")
        intro = ("The transcript is stored as cards: one card per exchange (ids t001…), grouped into threads. Tools: catalog(group), find(query), "
                 "open(id, section | lines). ")
    if arm == "cards":
        return head + "\n\n" + intro + "Below is the full catalog (groups, then one line per card).\n\nCATALOG\n" + st.catalog()
    return head + "\n\n" + intro + "Below is the list of groups; use catalog(group=id) to list the cards of a group.\n\nCATALOG\n" + st.catalog(level=1)


def make_options(arm: str, domain: str, work: Path, run_repo: Path, st: cards.Store, edit: bool) -> ClaudeAgentOptions:
    kw = dict(model=need_model(MODEL, "EVAL_MODEL"), setting_sources=[], max_turns=30, max_budget_usd=8, extra_args={"no-session-persistence": None})
    if arm == "flat":
        kw.update(cwd=str(work / "neutral"), tools=[])
    elif arm in ("tools", "tools+cat"):
        names = ["Read", "Grep", "Glob"] + (["Edit"] if edit else [])
        kw.update(cwd=str(run_repo if domain == "repo" else work / "chat"), tools=names, allowed_tools=names)
        if edit:
            kw["permission_mode"] = "acceptEdits"
    else:
        keep = {"catalog", "find", "open"} | ({"patch"} if edit else set())
        srv = card_server(st, names=keep)
        kw.update(cwd=str(work / "neutral"), tools=[], mcp_servers={"cards": srv}, allowed_tools=["mcp__cards__" + n for n in sorted(keep)])
    return ClaudeAgentOptions(**kw)


def changed_lines(a: str, b: str) -> int:
    rem = add = 0
    for ln in difflib.unified_diff(a.splitlines(), b.splitlines(), n=0, lineterm=""):
        if ln.startswith("-") and not ln.startswith("---"):
            rem += 1
        elif ln.startswith("+") and not ln.startswith("+++"):
            add += 1
    return max(rem, add)


def verify_edit(pristine: Path, current: Path, files: list, p: dict, before: dict) -> bool:
    """Правка верна, если нужные строки на месте, ненужные ушли, число изменённых строк не больше заданного, и больше ничего не тронуто.
    before: состояние файлов ПЕРЕД этой задачей (задачи идут в одной сессии, правки накапливаются)."""
    for f in files:
        cur = (current / f).read_text(encoding="utf-8")
        if f not in p["files"] and cur != before[f]:
            return False                                   # побочная правка
    for f, spec in p["files"].items():
        cur = (current / f).read_text(encoding="utf-8")
        if cur == before[f]:
            return False                                   # нужную правку не сделали
        for rx in spec.get("contains", []):
            if not re.search(rx, cur, re.M):
                return False
        for rx in spec.get("absent", []):
            if re.search(rx, cur, re.M):
                return False
        if "first_line" in spec and cur.split("\n", 1)[0] != spec["first_line"]:
            return False
        if changed_lines(before[f], cur) > spec.get("max_changed", 99):
            return False
    return True


async def main_async(ns):
    work = Path(ns.work)
    if not (work / "repo.sqlite").exists():
        print("prepare:", prepare.prepare(work), file=sys.stderr)
    domain, qfile = SETS[ns.set]
    edit = ns.set == "repo_edit"
    llm = ns.arm.endswith("-llm")                       # каталог с подписями, переписанными моделью-«библиотекарем» (label_catalog.py)
    arm = ns.arm[:-4] if llm else ns.arm
    questions = json.loads((DATA / qfile).read_text(encoding="utf-8"))
    out = Path(ns.out)
    out.mkdir(parents=True, exist_ok=True)
    tag = f"{ns.set}__{ns.arm}__r{ns.run}"

    # каталог/хранилище; для правок — свежая копия репозитория и своя база
    run_repo = work / "repo"
    if edit:
        run_repo = work / f"run_{tag}" / "repo"
        files = prepare.repo_files()
        prepare.copy_repo(run_repo, files)
        st = cards.Store(work / f"run_{tag}" / "cards.sqlite")
        st.index_code(run_repo, files=files)
    else:
        st = cards.Store(work / (("chat_llm.sqlite" if llm else "chat.sqlite") if domain == "chat" else "repo.sqlite"), root=work / "repo" if domain == "repo" else None)

    sessions = [questions]
    if domain == "chat":
        want = [int(x) for x in ns.sessions.split(",")]
        sessions = [[q for q in questions if q["session"] == s] for s in want]
    sessions = [s for s in sessions if s]
    if ns.limit:
        sessions = [s[:ns.limit] for s in sessions]
    results, errors = [], []
    ctx = context_text(domain, arm, work, st, edit, raw_cat="chat_raw_catalog_llm.txt" if llm else "chat_raw_catalog.txt")
    for si, qs in enumerate(sessions):
        prompts = []
        for k, q in enumerate(qs):
            label = "Task" if edit else "Question"
            prompts.append(dict(q, text=(ctx + "\n\n" if k == 0 else "") + f"{label} {k + 1}: {q['text']}"))
        verify = None
        if edit:
            files = prepare.repo_files()
            state = {"before": {f: (run_repo / f).read_text(encoding="utf-8") for f in files}}

            def verify_task(p, ans, _files=files, _state=state):
                ok = verify_edit(work / "repo", run_repo, _files, p, _state["before"])
                _state["before"] = {f: (run_repo / f).read_text(encoding="utf-8") for f in _files}
                return ok
            verify = verify_task
        res = await run_session(make_options(arm, domain, work, run_repo, st, edit), prompts, timeout=ns.timeout, verify=verify)
        for t in res["turns"]:
            t["session"] = si
        results += res["turns"]
        if res["error"]:
            errors.append(res["error"])
    doc = dict(set=ns.set, arm=ns.arm, run=ns.run, errors=errors, ctx_chars=len(ctx), turns=results, summary=summarize(results))
    (out / f"{tag}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    s = doc["summary"]
    print(f"{tag}: верно {s.get('ok')}/{s.get('n')}  вызовов/вопрос {s.get('calls', 0):.1f}  токенов на входе {s.get('tokens_in', 0):,}  ${s.get('usd', 0):.3f}  "
          f"мед. {s.get('median_s', 0):.1f} с  ошибки: {errors or '-'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--set", required=True, choices=list(SETS))
    ap.add_argument("--arm", required=True, choices=("flat", "tools", "tools+cat", "cards", "cards-l1", "cards-llm", "tools+cat-llm"))
    ap.add_argument("--run", type=int, default=1)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sessions", default="0,1,2,3", help="для чата: какие сессии (по 8 вопросов) прогонять")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--limit", type=int, default=0, help="только первые N вопросов (для проверки стенда)")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()

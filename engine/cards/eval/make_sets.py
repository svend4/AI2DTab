"""Собирает наборы вопросов из кандидатов, которых написал gen_questions.py. Результат: data/questions_*.json.

Что делаю я, а не модель: выбираю подмножество кандидатов (по одному приёму на ветку чата, без неоднозначных ответов)
и задаю регулярные выражения для проверки (терпимые к формату: «30 days» ~ «30 дней»). Вопросы и ответы — как у модели.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

D = Path(__file__).resolve().parent / "data"

# --- репозиторий: прежние 10 вопросов + смысловые (все 26 кандидатов; ответ — имя файла)
lookup = json.loads((D / "questions_repo_lookup.json").read_text(encoding="utf-8"))
for q in lookup:
    q["type"] = "lookup"
semantic = []
for c in json.loads((D / "cand_repo.json").read_text(encoding="utf-8")):
    base = c["path"].split("/")[-1]
    semantic.append(dict(id=c["id"], type="semantic", text=c["text"], path=c["path"], check=[re.escape(base)]))

# --- чат: 16 фрагментов (по 1–3 на ветку) × 2 формулировки; ключ — (реплика, дословный ответ), значение — регулярка проверки
PICK = {
    ("t002", "technical fit: 0.91"): r"0[.,]91",
    ("t004", "18 млн специалистов"): r"18\s*(млн|million|m\b)",
    ("t009", "AI / application security specialist"): r"(application|AI)\s*(/\s*\w+\s*)?security",   # «AI security» тоже верно (расширено после первых прогонов)
    ("t012", "half-life: 30 days"): r"30\s*(days|дн|сут)",
    ("t015", "20/20 benchmark cases pass"): r"20\s*/\s*20",
    ("t018", "scenario_budget_minus_30"): r"scenario_budget_minus_30",
    ("t036", "25 reports/week"): r"25\s*(reports|отч)",
    ("t042", "AI_HYPOTHESIS"): r"AI_HYPOTHESIS",
    ("t040", "DEPENDENCY_CONFLICT"): r"DEPENDENCY_CONFLICT",
    ("t049", "World as of 2026-06-01"): r"2026-06-01",
    ("t054", "on-demand + periodic refresh"): r"periodic|периодическ",
    ("t056", "Total need: 1.2M"): r"1[.,]2\s*(M|млн|million)",
    ("t057", "Aluminum 7075"): r"7075",
    ("t059", "RELEASE_MANAGER"): r"RELEASE_MANAGER",
    ("t081", "80% portfolio"): r"80\s*%",   # расширено после первых прогонов: «80%» без слова «портфель» тоже верно
    ("t075", "rerun on x86 node"): r"rerun|retry|перезапуск|повтор",   # вопрос не спрашивает «где»: x86 не требуем; «retry» и «повторить» — тоже верно
}
chat = []
for c in json.loads((D / "cand_chat.json").read_text(encoding="utf-8")):
    rx = PICK.get((c["card"], c["answer"]))
    if rx is None:
        continue
    chat.append(dict(id=c["id"], type=c["type"], text=c["text"], answer=c["answer"], card=c["card"], group=c["group"],
                     occurrences=c["occurrences"], check=[rx]))
# Сессии по 8 вопросов. Две формулировки одного фрагмента (одинаковый ответ) — в РАЗНЫХ сессиях, иначе ответ на первую
# подсказывает вторую из самого диалога. В каждой сессии 4 «лексических» и 4 «смысловых» вопроса про разные фрагменты.
import random
chat.sort(key=lambda q: q["id"])
passages = sorted({(q["card"], q["answer"]) for q in chat}, key=lambda p: p[0])
for q in chat:
    i = passages.index((q["card"], q["answer"]))
    q["session"] = i % 4 if q["type"] == "lexical" else (i + 2) % 4
rnd = random.Random(11)
rnd.shuffle(chat)
chat.sort(key=lambda q: q["session"])

# --- правки: проверяются по файлам рабочей копии (см. run_arm.verify_edit)
edit = [
    dict(id="e1", type="edit",
         text="In the server code that starts the Python engine as a child process, change the working directory passed to the child from "
              "/workspace/engine to /workspace/engine2. Do not change any other path. Reply 'done' when finished.",
         files={"src/lib/pm-api.ts": dict(contains=[r'cwd: "/workspace/engine2"', r'const PM = "/workspace/engine/pm\.py"',
                                                    r'startsWith\("/workspace/engine/"\)'], max_changed=1)}),
    dict(id="e2", type="edit",
         text="Rename the function getRouter to buildRouter in the TypeScript files under src/ (the declaration and every reference). "
              "Do not touch documentation. Reply 'done' when finished.",
         files={"src/router.tsx": dict(contains=[r"export function buildRouter\("], absent=[r"getRouter"], max_changed=1),
                "src/routeTree.gen.ts": dict(contains=[r"import type \{ buildRouter \}", r"typeof buildRouter"], absent=[r"getRouter"], max_changed=2)}),
    dict(id="e3", type="edit",
         text="In engine/LANG.md, in the block of operations examples, change the line `SET NEQ ∩ C` to `SET NEQ ∩ B`. "
              "Leave every other line as it is. Reply 'done' when finished.",
         files={"engine/LANG.md": dict(contains=[r"^    SET NEQ ∩ B$", r"^    ACCEPT NEQ ∩ C$", r"=NEQ∩C"], absent=[r"^    SET NEQ ∩ C$"], max_changed=1)}),
    dict(id="e4", type="edit",
         text="In engine/pm.py make the init command print its confirmation in English: replace the text 'база {DB.name}: {n} объектов' "
              "with 'DB {DB.name}: {n} objects'. Reply 'done' when finished.",
         files={"engine/pm.py": dict(contains=[r'print\(f"DB \{DB\.name\}: \{n\} objects"\)'], absent=[r"объектов\"\)"], max_changed=1)}),
    dict(id="e5", type="edit",
         text="Add a new first line `// shared helpers` at the very top of src/lib/utils.ts. Reply 'done' when finished.",
         files={"src/lib/utils.ts": dict(first_line="// shared helpers", max_changed=1)}),
    dict(id="e6", type="edit",
         text="The full-screen page shown when a route crashes has a heading 'Something went wrong'. Change that heading to 'Oops'. "
              "Do not change the fallback message constant. Reply 'done' when finished.",
         files={"src/lib/error-component.tsx": dict(contains=[r">Oops</h1>", r'FALLBACK_MESSAGE = "An unexpected error occurred\. Try reloading the page\."'],
                                                    absent=[r"Something went wrong"], max_changed=1)}),
]

# Неоднозначный вопрос: в чате есть второй допустимый пример проверки (verification: type: automated, benchmark_pass_rate >= 0.95).
# «Смысловая» формулировка не отличает его от нужного (type: automated_test); лексическая отличает. Помечаем после первых прогонов, исключаем у всех вариантов.
for q in chat:
    if q["id"] == "c_t015_467_sem":
        q["invalid"] = "неоднозначен: в чате есть второй пример автоматической проверки (benchmark_pass_rate >= 0.95)"

pos_path = D / "questions_chat_pos.json"
if pos_path.exists():
    pos = json.loads(pos_path.read_text(encoding="utf-8"))
    for q in pos:
        if q["id"] == "pos_t031":   # эталон исправлен: фраза «Evidence Freshness» в t031 разорвана переводом строки; первое вхождение в одной строке — t043 (09:58)
            q.update(card="t043", ts="2026-09-18 09:58", check=[r"09:58"], note="эталон исправлен после первых прогонов: все варианты ответили 09:58, проверка вручную подтвердила")
    pos_path.write_text(json.dumps(pos, ensure_ascii=False, indent=1), encoding="utf-8")

for name, obj in (("questions_repo_lookup", lookup), ("questions_repo_semantic", semantic), ("questions_chat", chat), ("questions_repo_edit", edit)):
    (D / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(name, len(obj))
print("chat types:", {t: sum(1 for q in chat if q["type"] == t) for t in ("lexical", "semantic")})

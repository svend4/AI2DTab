"""Отпечаток оценщика: чем проверяли ответы, когда они были получены.

Оценщик — то, что решает «верно / неверно»: файл вопросов с проверками (регулярки, `forbid`, пометки `invalid`) и функции вердикта в `common.py`.
Проверки в `data/questions_*.json` уточнялись после того, как ответы уже были получены (раскрыто в RESULTS.md), а `score.py` пересчитывает вердикты
по текущим проверкам. Поэтому прогон записывает в результат `evaluator = {что: sha1}`, а пересчёт сверяет его с текущим и говорит вслух,
если оценщик менялся после ответов или отпечатка в прогоне нет.

Отпечаток ничего не запрещает: оценщика можно менять. Он только не даёт сделать это незаметно.
Только стандартная библиотека: модуль импортируют и скрипты стенда, и тесты, которым не нужен SDK.
"""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
SHORT = 16                                   # знаков sha1 в отпечатке: для сверки хватает, в JSON не раздувает


def digest_text(text: str) -> str:
    return hashlib.sha1(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()[:SHORT]


def digest_file(path) -> str:
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()[:SHORT]


def digest_code(path, names) -> str:
    """Отпечаток исходного текста названных верхнеуровневых функций и присваиваний файла. Остальной код файла отпечаток не затрагивает: правка расценок
    или нового режима не должна выглядеть как смена оценщика. Нет такого имени в файле — исключение: отпечаток не должен молча стать пустым.
    Берётся текст, а не `ast.dump`: у dump формат зависит от версии Python, и отпечаток разошёлся бы на другой машине."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    want, found = set(names), {}
    for node in ast.parse(text).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in want:
            found[node.name] = ast.get_source_segment(text, node)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in want:
                    found[t.id] = ast.get_source_segment(text, node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in want:
            found[node.target.id] = ast.get_source_segment(text, node)
    if want - set(found):
        raise ValueError(f"{path.name}: нет {sorted(want - set(found))}")
    return digest_text("\n".join(f"{n}:{found[n]}" for n in sorted(found)))


def for_questions(qfile: str) -> dict:
    """Оценщик набора вопросов `data/<qfile>`: сам файл (проверки, forbid, invalid) и функции вердикта из common.py."""
    return {qfile: digest_file(DATA / qfile), "common.py#check_answer,norm": digest_code(HERE / "common.py", ("norm", "check_answer"))}


def compare(stored, current: dict) -> dict:
    """Сверка записанного в прогоне отпечатка с текущим. status: «missing» — в прогоне отпечатка нет (он сделан до его появления),
    «same», «changed» (changed — какие части отличаются, появились или пропали)."""
    if not stored:
        return {"status": "missing", "changed": []}
    changed = [k for k in sorted(set(stored) | set(current)) if stored.get(k) != current.get(k)]
    return {"status": "changed" if changed else "same", "changed": changed}


def describe(result: dict) -> list:
    """Строки для вывода по одному результату; пусто, когда отпечаток совпал."""
    if result["status"] == "missing":
        return ["(в результатах нет отпечатка оценщика: прогон сделан до его появления; менялись ли проверки после ответов, неизвестно)"]
    if result["status"] == "changed":
        return [f"ВНИМАНИЕ: оценщик менялся после ответов ({', '.join(result['changed'])}): вердикты посчитаны по текущим проверкам, а не по тем, что были при ответе"]
    return []

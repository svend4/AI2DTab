"""Контракт «повтор добавляет 0» (фаза 0 плана engine/cards/PLAN-LOOPS.md).

Каждый писатель картотеки и каждый глагол стола вызывается дважды подряд с одними и теми же аргументами. Второй вызов обязан оставить таблицы
содержимого такими, какими их оставил первый, а журналы (oplog картотеки, events стола) не должны расти на пути «UNCHANGED / skip».
Известные нарушения записывают как expectedFailure с номером находки из плана; закрыли находку — тест начинает проходить, unittest
сообщает «unexpected success», и декоратор снимают (так в фазе 1 закрыты H1, H8 и H11: сейчас все строки зелёные).
Новый писатель без строки в этой таблице не проходит ревью.

    python3 -m unittest engine/cards/test_idempotency.py -v
    PM_UNDER_TEST=/путь/к/копии/pm.py python3 -m unittest engine/cards/test_idempotency.py    # проверить копию pm.py (schema.sql и seed.sql берутся рядом с ней)

Без сети. Настоящие базы не трогаются: всё строится во временных папках.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cards  # noqa: E402
from test_cards import NOTE_PAIRS, make_chat, project_for  # noqa: E402  (берём только помощники; классы тестов не импортируем)

ENGINE = HERE.parent
PM_SRC = Path(os.environ.get("PM_UNDER_TEST") or ENGINE / "pm.py").resolve()

IGNORED_COLUMNS = {"ts", "updated", "updated_at", "created_at", "read_at"}     # время меняется при любой записи, содержимое — нет
IGNORED_PER_TABLE = {"chunks": {"id"}}     # номер куска — служебный: пересборка тех же кусков даёт другие номера, а содержимое то же


# ---------------------------------------------------------------- снимки

def _tables(con, skip=()):
    names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return [n for n in names if n not in skip and not n.startswith("chunks_fts")]    # служебные таблицы FTS5 сравнивать бессмысленно


def _digest(con, table):
    skip = IGNORED_COLUMNS | IGNORED_PER_TABLE.get(table, set())
    cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")') if r[1] not in skip]
    rows = sorted(repr(tuple(r)) for r in con.execute(f'SELECT {", ".join(cols)} FROM "{table}"'))      # множество строк: порядок вставки не важен
    h = hashlib.sha1()
    for row in rows:
        h.update(row.encode("utf-8", "replace"))
    return len(rows), h.hexdigest()[:10]


def snap_db(con, journals, prefix=""):
    """{'content': {таблица: (строк, хеш)}, 'journal': {таблица: строк}}: содержимое отдельно от журналов."""
    content = {prefix + t: _digest(con, t) for t in _tables(con, skip=journals)}
    if con.execute("SELECT 1 FROM sqlite_master WHERE name='chunks_fts'").fetchone():
        content[prefix + "chunks_fts#rows"] = (con.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0], "")
    journal = {prefix + j: con.execute(f'SELECT COUNT(*) FROM "{j}"').fetchone()[0] for j in journals}
    return {"content": content, "journal": journal}


def snap_tree(root: Path):
    """Папка как содержимое: имена файлов и хеши байтов."""
    files = [p for p in sorted(Path(root).rglob("*")) if p.is_file()]
    h = hashlib.sha1()
    for p in files:
        h.update(p.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha1(p.read_bytes()).digest())
    return len(files), h.hexdigest()[:10]


def merge(*snaps):
    out = {"content": {}, "journal": {}}
    for s in snaps:
        out["content"].update(s["content"])
        out["journal"].update(s["journal"])
    return out


def delta(a, b):
    out = []
    for part in ("content", "journal"):
        for key in sorted(set(a[part]) | set(b[part])):
            if a[part].get(key) != b[part].get(key):
                out.append(f"{part}/{key}: {a[part].get(key)} -> {b[part].get(key)}")
    return out


class Contract(unittest.TestCase):
    def repeat(self, snap, action, label=""):
        """action дважды; снимок между вызовами и после. Второй вызов не должен ничего менять. Возвращает ответы обоих."""
        first = action()
        mid = snap()
        second = action()
        end = snap()
        changed = delta(mid, end)
        self.assertEqual(changed, [], f"{label or 'повтор'}: второй вызов изменил {changed}; его ответ: {str(second)[:200]!r}")
        return first, second


# ---------------------------------------------------------------- стол

def make_desk(tmp: Path) -> Path:
    """Стол во временной папке: pm.py (или копия из PM_UNDER_TEST) + схема + семя. Настоящая база не трогается."""
    d = Path(tmp) / "engine"
    d.mkdir()
    shutil.copy(PM_SRC, d / "pm.py")
    for n in ("schema.sql", "seed.sql"):
        shutil.copy(PM_SRC.parent / n, d / n)
    subprocess.run([sys.executable, str(d / "pm.py"), "init"], cwd=d, check=True, capture_output=True)
    return d


class DeskContract(Contract):
    """Глаголы стола (pm.py exec …): повтор той же команды."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = make_desk(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def pm(self, *args):
        return subprocess.run([sys.executable, str(self.dir / "pm.py"), "exec", *args], cwd=self.dir, capture_output=True, text=True,
                              encoding="utf-8", timeout=60)

    def add(self, oid, typ="decision", status="raw", title=None, cluster="A"):
        r = subprocess.run([sys.executable, str(self.dir / "pm.py"), "add", "--id", oid, "--cluster", cluster, "--layer", "1", "--type", typ,
                            "--title", title or f"объект {oid}", "--status", status, "--body", "тест"],
                           cwd=self.dir, capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def snap(self):
        con = sqlite3.connect(self.dir / "project-store.sqlite")
        try:
            return snap_db(con, journals=("events",))
        finally:
            con.close()

    def twice(self, *args, pause=0.0):
        """Команда стола дважды; оба раза код 0, второй раз таблицы и журнал событий не меняются."""
        def action():
            r = self.pm(*args)
            self.assertEqual(r.returncode, 0, f"{' '.join(args)}: код {r.returncode}: {r.stderr.strip()[-200:]}")
            if pause:
                time.sleep(pause)
            return r.stdout.strip()
        return self.repeat(self.snap, action, " ".join(args))

    def test_verbs_second_call_adds_nothing(self):
        """Глаголы стола из таблицы идемпотентны с самого начала; FETCH и журнал отказов REFUSE стали такими в фазе 1 (отдельные тесты ниже)."""
        self.add("D-OLD", status="canon", title="решение про бюджет проекта")
        self.add("D-NEW", status="raw", title="решение про бюджет проекта уточнённое")
        table = [
            ["PLANT", "первый абзац про выплаты\\n\\nвторой абзац про сроки"],
            ["ACCEPT", "O001"], ["TAKE", "O002"], ["WIRE", "O001", "O002", "candidate"],
            ["GAP"], ["SETTLE"], ["FILL"], ["SWEEP"], ["PURGE"], ["REPAIR"], ["SPEC"], ["CAT"],
            ["SUPERSEDE", "D-OLD", "BY", "D-NEW", "новая редакция"],
            ["SUPERSEDE", "D-OLD", "UNDO", "передумали"],
            ["BATCH", "ACCEPT O001; TAKE O002; WIRE O001 O002 candidate"],
        ]
        for args in table:
            with self.subTest(verb=" ".join(args)[:50]):
                self.twice(*args)

    # H8 (закрыта фазой 1): FETCH заводил новый вопрос «чего нет в каноне?» при каждом вызове (id из времени, дубликатов не искал)
    def test_fetch(self):
        self.twice("FETCH", pause=1.1)           # пауза: в одну и ту же секунду второй вызов падал бы на PRIMARY KEY (это отдельная часть H8)

    # H11 (закрыта фазой 1): повторный отказ по замещённому объекту писал в журнал событий новую строку REFUSE при каждом вызове
    def test_repeated_accept_of_a_replaced_object(self):
        self.add("D-OLD", status="canon", title="решение про бюджет проекта")
        self.add("D-NEW", status="raw", title="решение про бюджет проекта уточнённое")
        self.assertEqual(self.pm("SUPERSEDE", "D-OLD", "BY", "D-NEW").returncode, 0)
        self.twice("ACCEPT", "D-OLD")

    # H11 (закрыта фазой 1): то же для объектов типа session/tape, которые каноном быть не могут
    def test_repeated_accept_of_a_session_object(self):
        self.twice("ACCEPT", "S001")


# ---------------------------------------------------------------- картотека

class StoreContract(Contract):
    """Писатели картотеки (cards.py): повтор того же вызова."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.chat = self.t / "chat.md"
        self.chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
        self.root = self.t / "repo"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src" / "a.py").write_text('"""Модуль."""\n\n\ndef f():\n    return 1\n', encoding="utf-8")
        (self.root / "doc.md").write_text("# Док\n\nТекст про выплаты.\n", encoding="utf-8")
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk, code_root=self.root, chats=["chat.md"]))
        self.st.index_chat(str(self.chat))
        body = [cards.unquote(x) for x in cards.split_lines(self.st._card("t001")["body"])]
        self.line = next(i for i, x in enumerate(body, 1) if "открытая вики" in x)

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def snap(self, extra=None):
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        try:
            desk = snap_db(con, journals=("events",), prefix="desk.")
        finally:
            con.close()
        out = merge(snap_db(self.st.con, journals=("oplog",), prefix="store."), desk)
        if extra:
            out["content"].update(extra())
        return out

    def note_args(self, **kw):
        args = dict(title="Technopedia", text=f"Открытая вики знаний с версиями (t001 L{self.line}).",
                    sources=[dict(card="t001", lines=f"{self.line}-{self.line}", quote="открытая вики знаний")], author="agent")
        args.update(kw)
        return args

    def test_fact_set(self):
        self.repeat(self.snap, lambda: self.st.fact_set("budget", "96000 EUR", "t8"), "fact_set")

    def test_fact_retract(self):
        self.st.fact_set("budget", "96000 EUR", "t8")
        self.repeat(self.snap, lambda: self.st.fact_retract("budget"), "fact_retract")

    def test_fact_promote_apply(self):
        self.st.fact_set("budget", "96000 EUR", "t8")
        first, second = self.repeat(self.snap, lambda: self.st.fact_promote("budget", apply=True), "fact_promote")
        self.assertIn("OK LF-budget-v1", first)
        self.assertIn("already proposed", second)

    def test_patch(self):
        self.st.index_code(self.root)
        cid = self.st.con.execute("SELECT id FROM cards WHERE src='doc.md'").fetchone()["id"]
        first, second = self.repeat(self.snap, lambda: self.st.patch(cid, 1, "Текст про выплаты.", "Текст про сроки."), "patch")
        self.assertTrue(first.startswith("OK"), first)
        self.assertIn("STALE", second)

    def test_index_code(self):
        self.repeat(self.snap, lambda: self.st.index_code(self.root), "index_code")

    def test_index_code_in_a_git_repo_with_non_ascii_names(self):
        for args in (("init", "-q"), ("add", "-A"), ("commit", "-qm", "init")):
            subprocess.run(["git", "-C", str(self.root), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)
        (self.root / "docs").mkdir(exist_ok=True)
        (self.root / "docs" / "заметка.md").write_text("# Заметка\n\nТекст.\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "-A"], check=True, capture_output=True)
        first, second = self.repeat(self.snap, lambda: self.st.index_code(self.root), "index_code (git)")
        self.assertEqual(first.get("new"), 3)                                 # a.py, doc.md и docs/заметка.md: имя с русскими буквами не потерялось
        self.assertEqual(second.get("same"), 3)

    def test_index_chat(self):
        self.repeat(self.snap, lambda: self.st.index_chat(str(self.chat)), "index_chat")

    def test_index_pm(self):
        self.repeat(self.snap, lambda: self.st.index_pm(self.desk / "project-store.sqlite"), "index_pm")

    def test_refresh(self):
        self.repeat(self.snap, self.st.refresh, "refresh")

    def test_export_wiki(self):
        self.st.add_note(**self.note_args())
        out = self.t / "wiki"
        self.repeat(lambda: self.snap(lambda: {"wiki-folder": snap_tree(out) if out.exists() else (0, "")}),
                    lambda: self.st.export_wiki(out), "export_wiki")

    # H1 (закрыта фазой 1): add_note с теми же названием, текстом и источниками заводил вторую заметку (n001, n002)
    def test_add_note(self):
        first, second = self.repeat(self.snap, lambda: self.st.add_note(**self.note_args()), "add_note")
        self.assertTrue(first.startswith("OK n001"), first)
        self.assertTrue(second.startswith("UNCHANGED n001"), second)

    # H1 (закрыта фазой 1): то же для заметки без источников (ручной)
    def test_add_note_without_sources(self):
        self.repeat(self.snap, lambda: self.st.add_note("Памятка", "Ручная заметка без источников.", author="human"), "add_note")


if __name__ == "__main__":
    unittest.main()

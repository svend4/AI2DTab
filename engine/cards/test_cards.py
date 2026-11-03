"""Тесты картотеки. Без сети и без ключей: python3 -m unittest engine/cards/test_cards.py -v"""
from __future__ import annotations

import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cards  # noqa: E402

PY = '''"""Модуль разбора заголовков."""
import re


def parse_neq_title(title):
    t = (title or "").strip()
    return t.split("≠", 1)


class Cell:
    def stamp(self, x):
        return x


def cmd_init():
    return "init"
'''
TS = '''import { createRouter } from "@tanstack/react-router";

export function getRouter() {
  return createRouter({});
}

export const Route = 1;
'''
MD = "# Заголовок\n\nЗанятость населения и профилирование.\n\n## Раздел два\n\nТекст про безработицу.\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "repo"
        (self.root / "engine").mkdir(parents=True)
        (self.root / "engine" / "pm.py").write_text(PY, encoding="utf-8")
        (self.root / "router.ts").write_text(TS, encoding="utf-8")
        (self.root / "doc.md").write_text(MD, encoding="utf-8")
        self.st = cards.Store(Path(self.tmp.name) / "c.sqlite")
        self.st.index_code(self.root, files=["engine/pm.py", "router.ts", "doc.md"])

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def cid(self, rel):
        return self.st.con.execute("SELECT id FROM cards WHERE src=?", (rel,)).fetchone()["id"]


class IndexAndRead(Base):
    def test_catalog_groups_and_lines(self):
        out = self.st.catalog()
        self.assertIn("GROUPS", out)
        self.assertIn("engine/pm.py", out)
        self.assertIn("defs: parse_neq_title", out)          # обзор строки: имена верхнего уровня
        self.assertEqual(self.st.catalog(level=1).count("\n"), 2)  # заголовок + 2 группы: (root) и engine

    def test_find_gives_line_and_section(self):
        out = self.st.find("parse_neq_title")
        self.assertIn("def parse_neq_title", out)
        self.assertIn("L5: def parse_neq_title(title):", out)

    def test_find_by_words_of_identifier(self):
        self.assertIn("pm.py", self.st.find("parse neq title"))      # snake_case разобран на слова
        self.assertIn("router.ts", self.st.find("get router"))       # camelCase тоже

    def test_find_cyrillic_stem(self):
        self.assertIn("doc.md", self.st.find("занятости населения"))   # «занятость» ~ «занятости»
        self.assertIn("doc.md", self.st.find("безработицы"))

    def test_find_all_words_then_any(self):
        out = self.st.find("createRouter stamp")                      # слова из разных файлов: сработает «любое слово»
        self.assertIn("any word", out)

    def test_find_no_match_and_stopwords(self):
        self.assertIn("no matches", self.st.find("zzzzqqq"))
        self.assertIn("ERR empty query", self.st.find("the of in"))

    def test_open_small_whole_and_numbered(self):
        out = self.st.open(self.cid("router.ts"))
        self.assertIn("    3| export function getRouter() {", out)

    def test_open_lines_and_section(self):
        cid = self.cid("engine/pm.py")
        self.assertIn("  5| def parse_neq_title", self.st.open(cid, lines="5-7").replace("    5|", "  5|"))
        sec = self.st.open(cid, section=1)
        self.assertIn("parse_neq_title", sec)
        self.assertIn("ERR no section", self.st.open(cid, section=99))
        self.assertIn("ERR no active card", self.st.open("zzz"))

    def test_big_card_prints_outline_not_body(self):
        big = "\n".join(f"def f{i}():\n    return {i}\n" for i in range(900))
        (self.root / "big.py").write_text(big, encoding="utf-8")
        self.st.index_code(self.root, files=["big.py"])
        out = self.st.open(self.cid("big.py"))
        self.assertIn("OUTLINE", out)
        self.assertLess(len(out), 6000)                  # оглавление, а не 20K символов тела

    def test_reindex_detects_change(self):
        (self.root / "router.ts").write_text(TS + "\nexport const X = 2;\n", encoding="utf-8")
        stat = self.st.index_code(self.root, files=["engine/pm.py", "router.ts", "doc.md"])
        self.assertEqual(stat.get("changed"), 1)
        self.assertEqual(stat.get("same"), 2)
        self.assertIn("v2", self.st.open(self.cid("router.ts")))


def git(root: Path, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)


class ListFiles(unittest.TestCase):
    """Список файлов для индекса (фаза 2 плана PLAN-LOOPS.md): git отдаёт имена не-ASCII в кавычках с восьмеричными кодами, раньше такие файлы молча терялись."""

    NAMES = ["src/a.py", "docs/заметка.md", "docs/Übersicht.md", "my notes.md", "日本語.md"]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.root = self.t / "repo"
        for rel in self.NAMES + ["logo.png", "data.bin"]:
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("# Заголовок\n\nТекст.\n" if rel.endswith(".md") else "x = 1\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def commit_all(self):
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "init")

    def test_git_listing_keeps_non_ascii_names(self):
        self.commit_all()
        self.assertEqual(cards.list_files(self.root), sorted(self.NAMES))

    def test_walk_without_git_gives_the_same_list(self):
        self.assertEqual(cards.list_files(self.root), sorted(self.NAMES))

    def test_index_code_indexes_them_and_counts_what_it_dropped_by_reason(self):
        self.commit_all()
        st = cards.Store(self.t / "c.sqlite")
        try:
            stat = st.index_code(self.root)
            self.assertEqual(stat, {"new": 5, "skipped_ext": 2})                       # png и bin отброшены по расширению — и это видно в отчёте
            self.assertEqual(sorted(r["src"] for r in st.con.execute("SELECT src FROM cards WHERE kind='file'")), sorted(self.NAMES))
            stat2 = st.index_code(self.root, exclude=("docs/*",))
            self.assertEqual(stat2, {"same": 3, "skipped_ext": 2, "excluded": 2})      # две заметки под маской: отброшены по ней, не по расширению
        finally:
            st.con.close()

    def test_a_name_that_is_not_utf8_is_counted_and_does_not_break_the_rest(self):
        bad = os.fsencode(self.root) + b"/bad\xff.md"
        try:
            with open(bad, "w", encoding="utf-8") as f:
                f.write("# x\n")
        except OSError:
            self.skipTest("файловая система не принимает имена не в UTF-8")
        self.commit_all()
        stats = Counter()
        self.assertEqual(cards.list_files(self.root, (), stats), sorted(self.NAMES))
        self.assertEqual(dict(stats), {"skipped_ext": 2, "skipped_name": 1})
        st = cards.Store(self.t / "c.sqlite")
        try:
            self.assertEqual(st.index_code(self.root), {"new": 5, "skipped_ext": 2, "skipped_name": 1})
        finally:
            st.con.close()


class Grep(Base):
    def test_grep_lists_every_matching_line_with_count(self):
        out = self.st.grep("return")
        self.assertTrue(out.startswith("4 matching lines in 2 cards"), out)          # find дал бы по одной строке на карточку
        self.assertIn(f"{self.cid('router.ts')} L3: export function getRouter() {{", self.st.grep("getrouter"))     # без учёта регистра, с номером строки
        self.assertIn("no lines match", self.st.grep("zzzzqqq"))
        self.assertIn("ERR bad regex", self.st.grep("(unclosed"))

    def test_grep_limit_group_and_turn_cards(self):
        many = "\n".join(f"x = {i}  # marker" for i in range(80))
        (self.root / "many.py").write_text(many, encoding="utf-8")
        self.st.index_code(self.root, files=["many.py"])
        out = self.st.grep("marker", k=5)
        self.assertIn("80 matching lines in 1 cards; the first 5 are shown", out)
        self.assertEqual(out.count("\n"), 5)
        self.assertIn("no lines match", self.st.grep("marker", group="engine"))                                    # другая группа
        chat = Path(self.tmp.name) / "chat.md"
        chat.write_text(make_chat([("вопрос про alpha", "> # Заголовок\n> текст про gamma")] * 2), encoding="utf-8")
        st2 = cards.Store(Path(self.tmp.name) / "chat.sqlite")
        st2.index_chat(chat)
        self.assertIn("текст про gamma", st2.grep("gamma"))                                                         # «> » цитаты снято
        self.assertNotIn("> текст", st2.grep("gamma"))
        st2.con.close()

    def test_grep_is_an_mcp_tool(self):
        self.assertIn("grep", {s["name"] for s in cards.TOOL_SPECS})
        self.assertIn("matching lines", cards.call_tool(self.st, "grep", {"pattern": "return"}))


class Patch(Base):
    def test_patch_ok_writes_file_and_bumps_version(self):
        cid = self.cid("router.ts")
        out = self.st.patch(cid, 1, "createRouter({})", "createRouter({ a: 1 })")
        self.assertTrue(out.startswith(f"OK {cid} v2"), out)
        self.assertIn("a: 1", (self.root / "router.ts").read_text(encoding="utf-8"))
        self.assertIn("v1", self.st.history(cid))

    def test_patch_stale_version_shows_fresh_text(self):
        cid = self.cid("router.ts")
        self.st.patch(cid, 1, "createRouter({})", "createRouter({ a: 1 })")
        out = self.st.patch(cid, 1, "a: 1", "a: 2")
        self.assertTrue(out.startswith("STALE"), out)
        self.assertIn("version=2", out)
        self.assertIn("a: 1", out)                      # свежий текст вокруг цели
        self.assertTrue(self.st.patch(cid, 2, "a: 1", "a: 2").startswith("OK"))

    def test_patch_source_drift(self):
        cid = self.cid("router.ts")
        (self.root / "router.ts").write_text(TS.replace("getRouter", "getRouterX"), encoding="utf-8")   # правка мимо картотеки
        out = self.st.patch(cid, 1, "createRouter({})", "createRouter({ a: 1 })")
        self.assertTrue(out.startswith("STALE") and "changed on disk" in out, out)
        self.assertNotIn("a: 1", (self.root / "router.ts").read_text(encoding="utf-8"))   # ничего не записано
        self.assertTrue(self.st.patch(cid, 2, "createRouter({})", "createRouter({ a: 1 })").startswith("OK"))
        self.assertIn("getRouterX", (self.root / "router.ts").read_text(encoding="utf-8"))   # чужая правка не потеряна

    def test_patch_not_found_and_ambiguous(self):
        cid = self.cid("engine/pm.py")
        self.assertIn("not found", self.st.patch(cid, 1, "no such text", "x"))
        self.assertIn("occurs", self.st.patch(cid, 1, "return", "ret"))
        self.assertIn("empty", self.st.patch(cid, 1, "", "x"))

    def test_patch_cannot_escape_root(self):
        cid = self.cid("router.ts")
        self.st.con.execute("UPDATE cards SET src=? WHERE id=?", ("../outside.ts", cid))
        self.assertIn("ERR", self.st.patch(cid, 1, "createRouter({})", "x"))

    def test_turn_cards_are_read_only(self):
        chat = Path(self.tmp.name) / "chat.md"
        chat.write_text(make_chat([("alpha beta", "gamma delta")] * 2), encoding="utf-8")
        st2 = cards.Store(Path(self.tmp.name) / "chat.sqlite")
        st2.index_chat(chat)
        self.assertIn("read-only", st2.patch("t001", 1, "gamma", "x"))
        self.assertIn("only", st2.open("t001", lines="9999"))
        st2.con.close()


class Facts(Base):
    def test_set_supersede_history(self):
        self.assertTrue(self.st.fact_set("Deadline", "15 March").startswith("OK"))
        self.assertTrue(self.st.fact_set("deadline", "15 March").startswith("UNCHANGED"))   # ключ без учёта регистра
        out = self.st.fact_set("deadline", "22 March", "t4")
        self.assertIn("v2", out)
        self.assertIn("was v1: 15 March", out)
        self.assertEqual(self.st.facts().strip(), "deadline = 22 March  (v2)")     # в выдаче — последнее написание ключа
        hist = self.st.fact_history("deadline")
        self.assertIn("v1 superseded 15 March", hist)
        self.assertIn("v2 active", hist)

    def test_retract_and_prefix(self):
        self.st.fact_set("lead.name", "Boris")
        self.st.fact_set("lead.deputy", "Anna")
        self.st.fact_set("budget", "96000")
        self.assertEqual(self.st.facts("lead").count("\n"), 1)
        self.assertIn("retracted", self.st.fact_retract("lead.deputy"))
        self.assertNotIn("Anna", self.st.facts())
        self.assertIn("no active", self.st.fact_retract("lead.deputy"))


def make_chat(pairs):
    """Синтетический экспорт ChatGPT: [(вопрос, ответ), …]."""
    out = ["> From: https://chatgpt.com/c/test", ""]
    for i, (q, a) in enumerate(pairs):
        out += ["# you asked", "", f"message time: 2026-09-17 10:{i:02d}:00", "", q, "", "---", "", "# chatgpt response", "", a, "", "---", ""]
    return "\n".join(out)


class Chat(unittest.TestCase):
    def test_segmentation_splits_topics(self):
        rnd = random.Random(7)
        common = "система данные модель работа процесс важно нужно можно слой часть".split()
        a_voc = [f"яблоня{i}" for i in range(40)]
        b_voc = [f"turbine{i}" for i in range(40)]
        pairs = []
        for k in range(16):
            voc = a_voc if k < 8 else b_voc
            words = [rnd.choice(voc) for _ in range(80)] + [rnd.choice(common) for _ in range(40)]
            pairs.append((f"вопрос {k}", "## Раздел\n\n" + " ".join(words)))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "chat.md"
            p.write_text(make_chat(pairs), encoding="utf-8")
            st = cards.Store(Path(d) / "c.sqlite")
            res = st.index_chat(p, target_groups=2)
            self.assertEqual(res["turns"], 16)
            self.assertEqual(res["groups"], 2)
            g = [r["group_id"] for r in st.con.execute("SELECT group_id FROM cards ORDER BY id")]
            self.assertEqual(len(set(g[:8])), 1)
            self.assertEqual(len(set(g[8:])), 1)
            self.assertNotEqual(g[0], g[8])
            st.con.close()

    def test_quote_wrapped_answer_gets_outline(self):
        body = "\n".join(["> **Document: Test spec v1**", ">", "> # 101. Первый раздел", ">", "> текст"] + ["> строка"] * 30
                         + ["> # 102. Второй раздел", "> текст"])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "chat.md"
            p.write_text(make_chat([("Да", body)]), encoding="utf-8")
            st = cards.Store(Path(d) / "c.sqlite")
            st.index_chat(p)
            out = st.find("102")
            self.assertIn("102. Второй раздел", out)
            self.assertNotIn("> ", out.split("\n")[-1])      # цитата снята в выдаче
            st.con.close()


ENGINE = Path(cards.__file__).resolve().parent.parent


def make_desk(tmp: Path) -> Path:
    """Копия стола (pm.py + схема + сид) во временной папке: настоящая база комплекта в тестах не трогается."""
    d = Path(tmp) / "engine"
    d.mkdir()
    for n in ("pm.py", "schema.sql", "seed.sql"):
        shutil.copy(ENGINE / n, d / n)
    subprocess.run([sys.executable, str(d / "pm.py"), "init"], cwd=d, check=True, capture_output=True)
    return d


def project_for(tmp: Path, desk: Path, code_root: Path | None = None, chats: list | None = None) -> dict:
    proj = json.loads(json.dumps(cards.PROJECT_DEFAULT))
    proj["_base"] = str(tmp)
    proj["pm_dir"] = str(desk)
    if code_root is not None:
        proj["code"] = {"root": str(code_root), "exclude": []}
    proj["chats"] = chats or []
    return proj


def desk_do(desk: Path, *args) -> str:
    """Глагол стола, как его вводит человек: pm.py exec …"""
    r = subprocess.run([sys.executable, str(desk / "pm.py"), "exec", *args], cwd=desk, check=True, capture_output=True, text=True, encoding="utf-8")
    return r.stdout


def desk_row(desk: Path, oid: str):
    con = sqlite3.connect(desk / "project-store.sqlite")
    con.row_factory = sqlite3.Row
    try:
        return con.execute("SELECT * FROM objects WHERE id=?", (oid,)).fetchone()
    finally:
        con.close()


class DeskBridge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def test_canon_is_read_only_and_filters_types(self):
        db = self.desk / "project-store.sqlite"
        before = (db.stat().st_mtime_ns, db.stat().st_size)
        out = self.st.canon()
        self.assertIn("F001 [A/fact]", out)
        self.assertIn("D001 [A/decision]", out)
        self.assertNotIn("F001", self.st.canon(types="decision"))
        self.assertEqual(before, (db.stat().st_mtime_ns, db.stat().st_size))      # стол не изменился

    def test_canon_without_desk(self):
        self.st.project["pm_dir"] = str(self.t / "nowhere")
        self.assertIn("ERR no desk store", self.st.canon())

    def test_promote_dry_run_apply_and_human_accept(self):
        self.st.fact_set("budget", "96000 EUR", "t8")
        dry = self.st.fact_promote("budget")
        self.assertIn("DRY RUN", dry)
        self.assertIsNone(desk_row(self.desk, "LF-budget-v1"))                        # пробный запуск ничего не пишет
        ok = self.st.fact_promote("budget", apply=True)
        self.assertIn("created in the desk as RAW", ok)
        row = desk_row(self.desk, "LF-budget-v1")
        self.assertEqual((row["status"], row["type"], row["title"]), ("raw", "fact", "budget = 96000 EUR"))
        self.assertNotIn("LF-budget-v1", self.st.canon())                            # raw — ещё не канон
        self.assertIn("already proposed", self.st.fact_promote("budget", apply=True))  # повтор не плодит объектов
        # решение человека: ACCEPT штатной командой стола — и объект виден в каноне
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "exec", "ACCEPT", "LF-budget-v1"], cwd=self.desk, check=True, capture_output=True)
        self.assertIn("LF-budget-v1 [C/fact] budget = 96000 EUR", self.st.canon())

    def test_promote_accept_flag_and_next_version_note(self):
        self.st.fact_set("deadline", "15 March")
        self.assertIn("ACCEPT LF-deadline-v1", self.st.fact_promote("deadline", apply=True, accept=True))
        self.assertEqual(desk_row(self.desk, "LF-deadline-v1")["status"], "canon")
        self.st.fact_set("deadline", "22 March")
        out = self.st.fact_promote("deadline", apply=True)
        self.assertIn("LF-deadline-v2", out)
        self.assertIn("NOTE: v1 of this key is already in the desk as LF-deadline-v1", out)

    def test_promote_hint_for_an_accepted_predecessor_is_a_working_supersede(self):
        self.st.fact_set("deadline", "15 March")
        self.st.fact_promote("deadline", apply=True, accept=True)
        self.st.fact_set("deadline", "22 March")
        out = self.st.fact_promote("deadline", apply=True)
        self.assertIn("(status canon)", out)
        cmd = "SUPERSEDE LF-deadline-v1 BY LF-deadline-v2"
        self.assertIn(f"python3 pm.py exec {cmd}", out)
        self.assertNotIn("has no 'supersede'", out)
        desk_do(self.desk, *cmd.split(), "дата")                                        # подсказку исполняет человек, настоящим pm.py
        self.assertEqual((desk_row(self.desk, "LF-deadline-v1")["status"], desk_row(self.desk, "LF-deadline-v2")["status"]), ("superseded", "canon"))
        canon = self.st.canon()
        self.assertIn("LF-deadline-v2 [C/fact] deadline = 22 March", canon)
        self.assertIn("(replaces LF-deadline-v1: дата)", canon)                          # агент видит, что решение пересмотрено, и почему
        self.assertNotIn("LF-deadline-v1 [", canon)                                      # старое в каноне больше не числится

    def test_promote_hint_for_a_raw_predecessor_and_for_none(self):
        self.st.fact_set("risk", "high")
        self.assertNotIn("NOTE", self.st.fact_promote("risk", apply=True))              # предшественника нет — подсказки нет
        self.st.fact_set("risk", "medium")
        out = self.st.fact_promote("risk", apply=True)
        self.assertIn("(status raw)", out)
        self.assertIn("still RAW", out)
        self.assertNotIn("SUPERSEDE", out)                                              # сырое заменять незачем: его снимают TAKE

    def test_desk_cards_tell_what_replaced_what(self):
        self.st.fact_set("deadline", "15 March")
        self.st.fact_promote("deadline", apply=True, accept=True)
        self.st.fact_set("deadline", "22 March")
        self.st.fact_promote("deadline", apply=True)
        desk_do(self.desk, "SUPERSEDE", "LF-deadline-v1", "BY", "LF-deadline-v2", "перенесли")
        self.st.index_pm(self.desk / "project-store.sqlite")                            # не refresh(): корень кода по умолчанию — «../..»
        body = lambda cid: self.st.con.execute("SELECT body FROM cards WHERE id=?", (cid,)).fetchone()["body"]  # noqa: E731
        self.assertIn("status superseded", body("pm-LF-deadline-v1"))
        self.assertIn("superseded by LF-deadline-v2: перенесли", body("pm-LF-deadline-v1"))
        self.assertIn("supersedes LF-deadline-v1: перенесли", body("pm-LF-deadline-v2"))
        self.assertNotIn("supersede", body("pm-D001"))                                    # остальные карточки стола без изменений

    def test_mcp_promote_is_gated_by_project_setting(self):
        self.st.fact_set("risk", "high")
        denied = cards.call_tool(self.st, "fact_promote", {"key": "risk", "apply": True})
        self.assertIn("DRY RUN", denied)
        self.assertIn("switched off for agents", denied)
        self.assertIsNone(desk_row(self.desk, "LF-risk-v1"))                           # агент не смог записать в стол
        self.st.project["promote"]["mcp_apply"] = True
        allowed = cards.call_tool(self.st, "fact_promote", {"key": "risk", "apply": True})
        self.assertIn("created in the desk as RAW", allowed)
        self.assertEqual(desk_row(self.desk, "LF-risk-v1")["status"], "raw")           # и всё равно только raw: accept в MCP нет
        self.assertNotIn("accept", {k for s in cards.TOOL_SPECS if s["name"] == "fact_promote" for k in s["props"]})

    def test_promote_errors(self):
        self.assertIn("ERR no active fact", self.st.fact_promote("nothing", apply=True))
        self.st.fact_set("k", "v")
        self.st.project["pm_dir"] = str(self.t / "nowhere")
        self.assertIn("ERR pm.py not found", self.st.fact_promote("k", apply=True))

    def test_handoff_sections_and_budget(self):
        (self.t / "src").mkdir()
        (self.t / "src" / "a.py").write_text(PY, encoding="utf-8")
        self.st.project = project_for(self.t, self.desk, code_root=self.t / "src")
        self.st.refresh()
        self.st.fact_set("budget", "96000 EUR")
        out = self.st.handoff()
        for part in ("MEMORY BRIEF", "CANON:", "LEDGER", "budget = 96000 EUR", "MATERIAL:", "fact_promote"):
            self.assertIn(part, out)
        self.assertLessEqual(cards.est_tokens(out), 4000)
        tiny = self.st.handoff(budget_tok=300, catalog=False)
        self.assertNotIn("MATERIAL", tiny)

    def test_refresh_is_incremental_and_keeps_chats_apart(self):
        repo = self.t / "repo"
        repo.mkdir()
        (repo / "a.py").write_text(PY, encoding="utf-8")
        chats = self.t / "chats"
        chats.mkdir()
        rnd = random.Random(3)

        def chat(path, voc, n=14):
            pairs = [(f"вопрос {k}", "## Раздел\n\n" + " ".join(rnd.choice(voc) for _ in range(80))) for k in range(n)]
            path.write_text(make_chat(pairs), encoding="utf-8")

        chat(chats / "one.md", [f"яблоня{i}" for i in range(40)])
        chat(chats / "two.md", [f"turbine{i}" for i in range(40)])
        (chats / "notes.md").write_text("# просто заметки\n\nэто не экспорт чата\n", encoding="utf-8")
        self.st.project = project_for(self.t, self.desk, code_root=repo, chats=[str(chats / "*.md")])
        first = self.st.refresh()
        self.assertEqual(first["code"]["new"], 1)
        self.assertEqual(first["chats"]["one.md"]["turns"], 14)
        self.assertIn("skipped", first["chats"]["notes.md"])
        groups1 = {r["id"] for r in self.st.con.execute("SELECT id FROM groups WHERE kind='thread'")}
        self.st.set_summary("t001", "РУЧНАЯ ПОДПИСЬ")
        second = self.st.refresh()
        self.assertEqual(second["code"]["same"], 1)
        self.assertEqual(second["chats"]["one.md"], "same")
        self.assertIn("РУЧНАЯ ПОДПИСЬ", self.st.catalog())                              # подпись «библиотекаря» не затёрта
        # изменился только первый экспорт: ветки второго остаются
        chat(chats / "one.md", [f"груша{i}" for i in range(40)], n=10)
        third = self.st.refresh()
        self.assertEqual(third["chats"]["one.md"]["turns"], 10)
        self.assertEqual(third["chats"]["two.md"], "same")
        n_one = self.st.con.execute("SELECT COUNT(*) c FROM cards WHERE kind='turn' AND src LIKE 'one.md#%'").fetchone()["c"]
        n_two = self.st.con.execute("SELECT COUNT(*) c FROM cards WHERE kind='turn' AND src LIKE 'two.md#%'").fetchone()["c"]
        self.assertEqual((n_one, n_two), (10, 14))
        orphan = self.st.con.execute("SELECT COUNT(*) c FROM groups WHERE kind='thread' AND id NOT IN (SELECT DISTINCT group_id FROM cards WHERE group_id IS NOT NULL)").fetchone()["c"]
        self.assertEqual(orphan, 0)
        self.assertTrue(groups1)

    def test_two_stores_share_one_file(self):
        """Два процесса (по серверу на сессию) работают с одной базой: запись одного видна другому."""
        other = cards.Store(self.t / "c.sqlite", project=self.st.project)
        self.st.fact_set("k", "from-first")
        self.assertIn("k = from-first", other.facts())
        other.fact_set("k", "from-second")
        self.assertIn("k = from-second", self.st.facts())
        other.con.close()


class HandoffOneLinePerFact(unittest.TestCase):
    """H3: факт, который уже стоит в каноне, не повторяется строкой журнала в справке новой сессии (иначе он выглядит подтверждённым дважды)."""
    LEDGER = "LEDGER (conversation facts, current):\n"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def brief(self):
        return self.st.handoff(catalog=False)

    def ledger_part(self, brief):
        """Раздел LEDGER справки: от заголовка до пустой строки."""
        return brief.split(self.LEDGER, 1)[1].split("\n\n", 1)[0]

    def accepted(self, key, value, source=""):
        self.st.fact_set(key, value, source)
        self.assertIn("ACCEPT", self.st.fact_promote(key, apply=True, accept=True))

    def test_an_accepted_fact_is_one_line_in_the_brief(self):
        self.accepted("budget", "96000 EUR", "t8")
        out = self.brief()
        self.assertIn("LF-budget-v1 [C/fact] budget = 96000 EUR", out)                    # строка канона
        self.assertEqual(out.count("budget = 96000 EUR"), 1)                              # а не две: канон и журнал
        self.assertEqual(self.ledger_part(out), "(+1 ledger fact is already in the canon above)")

    def test_several_hidden_facts_are_counted_and_the_rest_is_listed(self):
        for k, v in (("a.one", "1"), ("a.two", "2"), ("a.three", "3")):
            self.accepted(k, v)
        self.st.fact_set("a.four", "4")                                                   # не предложен столу
        self.st.fact_set("a.five", "5")
        self.st.fact_promote("a.five", apply=True)                                        # предложен, но ещё raw
        self.assertEqual(self.ledger_part(self.brief()),
                         "a.five = 5  (v1)\na.four = 4  (v1)\n(+3 ledger facts are already in the canon above)")

    def test_a_fact_that_waits_for_accept_stays_in_the_ledger(self):
        self.st.fact_set("budget", "96000 EUR")
        self.st.fact_promote("budget", apply=True)                                        # raw: человек ещё не решил
        out = self.brief()
        self.assertEqual(out.count("budget = 96000 EUR"), 1)
        self.assertEqual(self.ledger_part(out), "budget = 96000 EUR  (v1)")
        self.assertNotIn("already in the canon", out)

    def test_a_new_version_makes_two_lines_again(self):
        """Канон отстал от журнала: нужны обе строки, а lint об этом говорит."""
        self.accepted("deadline", "15 March")
        self.st.fact_set("deadline", "22 March")
        out = self.brief()
        self.assertIn("LF-deadline-v1 [C/fact] deadline = 15 March", out)                 # что принято
        self.assertEqual(self.ledger_part(out).split("\n")[0], "deadline = 22 March  (v2)")  # что сказали после
        self.assertNotIn("already in the canon", out)
        self.assertIn("canon-behind-ledger", {f["code"] for f in self.st.lint()})
        self.assertIn("LINT:", out)

    def test_the_normal_cycle_ends_with_one_line_in_the_canon(self):
        """v1 принят, v2 предложен и поставлен вместо него: в справке строка канона с пометкой замены и ни одной строки журнала."""
        self.accepted("deadline", "15 March")
        self.st.fact_set("deadline", "22 March")
        self.st.fact_promote("deadline", apply=True)
        desk_do(self.desk, "SUPERSEDE", "LF-deadline-v1", "BY", "LF-deadline-v2", "перенесли")
        out = self.brief()
        self.assertIn("LF-deadline-v2 [C/fact] deadline = 22 March", out)
        self.assertIn("(replaces LF-deadline-v1", out)
        self.assertEqual(out.count("deadline = 22 March"), 1)
        self.assertEqual(self.ledger_part(out), "(+1 ledger fact is already in the canon above)")

    def test_a_value_edited_in_the_desk_stays_visible(self):
        """Название объекта в столе правили, и оно уже не равно значению журнала: расхождение показываем, а не прячем."""
        self.accepted("budget", "96000 EUR")
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        con.execute("UPDATE objects SET title='budget = 90000 EUR' WHERE id='LF-budget-v1'")
        con.commit()
        con.close()
        out = self.brief()
        self.assertIn("LF-budget-v1 [C/fact] budget = 90000 EUR", out)
        self.assertEqual(self.ledger_part(out), "budget = 96000 EUR  (v1)")

    def test_a_fact_the_canon_list_cut_off_is_not_hidden(self):
        """Канон в справке обрезан по числу строк: объекта в нём нет, значит, строку журнала прятать нельзя."""
        self.accepted("budget", "96000 EUR")
        with mock.patch.object(cards, "CANON_LIMIT", 3):
            out = self.brief()
        self.assertNotIn("LF-budget-v1", out.split(self.LEDGER)[0])                       # в разделе канона его нет
        self.assertEqual(self.ledger_part(out), "budget = 96000 EUR  (v1)")

    def test_without_a_desk_nothing_is_hidden(self):
        self.accepted("budget", "96000 EUR")
        self.st.project["pm_dir"] = str(self.t / "nowhere")
        out = self.brief()
        self.assertIn("ERR no desk store", out)
        self.assertEqual(self.ledger_part(out), "budget = 96000 EUR  (v1)")

    def test_the_facts_tool_still_lists_everything(self):
        self.accepted("budget", "96000 EUR")
        self.assertEqual(self.st.facts(), "budget = 96000 EUR  (v1)")
        self.assertEqual(cards.call_tool(self.st, "facts", {}), "budget = 96000 EUR  (v1)")

    def old_style_brief(self):
        """Справка прежнего вида из тех же кусков: канон и весь журнал, без сверки."""
        return "\n\n".join(p for p in ("MEMORY BRIEF — start of a new session\n" + cards.PROTOCOL, self.st.canon(),
                                       self.LEDGER + self.st.facts(), self.st.lint_summary()) if p)

    def test_with_several_accepted_facts_the_brief_gets_shorter(self):
        for k, v in (("budget", "96000 EUR"), ("deadline", "15 March"), ("lead.name", "Stefan")):
            self.accepted(k, v, "t1")
        self.assertLess(cards.est_tokens(self.brief()), cards.est_tokens(self.old_style_brief()))

    def test_one_accepted_fact_costs_a_few_tokens_not_more(self):
        """Строка-указатель стоит примерно как две короткие строки журнала: на одном принятом факте справка не короче, но и не длиннее больше чем на несколько токенов."""
        self.accepted("budget", "96000 EUR", "t1")
        self.assertLessEqual(cards.est_tokens(self.brief()) - cards.est_tokens(self.old_style_brief()), 8)


class HandoffLedgerCap(unittest.TestCase):
    """Дыра паспорта 1: бюджет справки резал только список групп, а журнал фактов шёл в справку целиком (400 фактов — 10 141 токен при бюджете 4000).
    Теперь в разделе LEDGER не больше handoff_ledger_max_lines фактов (последние записанные), строка длиннее handoff_ledger_line_chars режется,
    а что не показано — названо строкой-указателем."""
    LEDGER = "LEDGER (conversation facts, current):\n"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def ledger(self, **kw):
        """Строки раздела LEDGER справки."""
        return self.st.handoff(catalog=False, **kw).split(self.LEDGER, 1)[1].split("\n\n", 1)[0].split("\n")

    def many(self, n, prefix="k"):
        for i in range(n):
            self.st.fact_set(f"{prefix}.{i:03d}", "значение номер %d с хвостом из слов для объёма" % i, "t1")

    def test_four_hundred_facts_fit_the_budget(self):
        self.many(400)
        out = self.st.handoff(catalog=False)
        self.assertLessEqual(cards.est_tokens(out), 4000)                                   # было 10 141
        lines = self.ledger()
        self.assertEqual(len(lines), 41)
        self.assertEqual(lines[-1].split(";")[0], "(+360 more active facts not shown")
        self.assertEqual(self.st.facts().count("\n") + 1, 400)                              # сам журнал не тронут

    def test_the_newest_recorded_facts_are_shown_in_key_order(self):
        self.st.project["handoff_ledger_max_lines"] = 5
        for k in "abcdefghij":
            self.st.fact_set(k, k.upper(), "t1")
        self.st.fact_set("a", "A2", "t1")                                                   # старый ключ, но запись свежая
        lines = self.ledger()
        self.assertEqual([l.split(" = ")[0] for l in lines[:-1]], ["a", "g", "h", "i", "j"])
        self.assertEqual(lines[0], "a = A2  (v2)")
        self.assertTrue(lines[-1].startswith("(+5 more active facts not shown"))

    def test_exactly_at_the_cap_there_is_no_pointer_and_one_over_has_one(self):
        self.st.project["handoff_ledger_max_lines"] = 3
        self.many(3)
        self.assertFalse(any(l.startswith("(+") for l in self.ledger()))
        self.many(1, prefix="z")
        lines = self.ledger()
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[-1].startswith("(+1 more active fact not shown"), lines[-1])

    def test_facts_that_stand_in_the_canon_do_not_take_places(self):
        self.st.project["handoff_ledger_max_lines"] = 3
        for k in ("c.one", "c.two", "c.three"):
            self.st.fact_set(k, "принято", "t1")
            self.st.fact_promote(k, apply=True, accept=True)
        self.many(3)
        lines = self.ledger()
        self.assertEqual([l.split(" = ")[0] for l in lines[:3]], ["k.000", "k.001", "k.002"])
        self.assertEqual(lines[3], "(+3 ledger facts are already in the canon above)")
        self.assertEqual(len(lines), 4)                                                     # указатель «ещё N» не нужен: всё влезло

    def test_a_long_value_is_clipped_flat_and_counted(self):
        self.st.project["handoff_ledger_line_chars"] = 80
        self.st.fact_set("note", "первая строка\nвторая строка " + "слово " * 100, "t1")
        self.st.fact_set("short", "коротко", "t1")
        lines = self.ledger()
        note = next(l for l in lines if l.startswith("note = "))
        self.assertLessEqual(len(note), 80)
        self.assertTrue(note.endswith("…  (v1)"), note)                                     # номер версии не потерян
        self.assertIn("первая строка вторая строка", note)                                  # перенос строки стал пробелом
        self.assertIn("short = коротко  (v1)", lines)
        self.assertEqual(lines[-1], "(1 line clipped to 80 characters; facts() shows it whole)")
        self.assertIn("слово слово", self.st.facts())                                       # журнал целый
        self.assertIn("\n", self.st.facts("note").split("  (v1)")[0])                       # и с переносом строки

    def test_a_value_with_line_breaks_is_one_line_in_the_brief(self):
        self.st.fact_set("list", "один\nдва\nтри", "t1")
        self.assertEqual(self.ledger(), ["list = один два три  (v1)"])

    def test_nonsense_settings_fall_back_to_the_defaults(self):
        self.many(45)
        for bad in ("много", -3, 0, None):
            self.st.project["handoff_ledger_max_lines"] = bad
            self.assertEqual(len(self.ledger()), 41, bad)                                   # 40 фактов и указатель
        self.st.project["handoff_ledger_line_chars"] = "x"
        self.assertEqual(len(self.ledger()), 41)

    def test_lint_says_when_the_brief_cannot_show_everything(self):
        found = lambda: [f for f in self.st.lint() if f["code"] == "ledger-over-brief"]  # noqa: E731
        self.many(40)
        self.assertEqual(found(), [])
        self.many(1, prefix="z")
        (f,) = found()
        self.assertEqual((f["level"], f["subject"]), ("warn", "ledger"))
        self.assertIn("41 active facts", f["message"])
        self.assertIn("newest 40", f["message"])
        self.st.project["handoff_ledger_max_lines"] = 60
        self.assertEqual(found(), [])
        self.assertIn("LINT:", self.st.handoff(catalog=False))

    def test_facts_in_the_canon_do_not_count_for_the_lint_either(self):
        self.st.project["handoff_ledger_max_lines"] = 3
        for k in ("c.one", "c.two"):
            self.st.fact_set(k, "принято", "t1")
            self.st.fact_promote(k, apply=True, accept=True)
        self.many(2)                                                                        # всего четыре действующих, но в справке они все поместятся
        self.assertEqual([f for f in self.st.lint() if f["code"] == "ledger-over-brief"], [])
        self.many(2, prefix="z")
        self.assertEqual(len([f for f in self.st.lint() if f["code"] == "ledger-over-brief"]), 1)

    def test_small_ledgers_look_as_before(self):
        self.st.fact_set("budget", "96000 EUR", "t8")
        self.st.fact_set("deadline", "15 March")
        self.assertEqual(self.ledger(), ["budget = 96000 EUR  (v1)", "deadline = 15 March  (v1)"])
        self.assertEqual(self.st.facts(), "budget = 96000 EUR  (v1)\ndeadline = 15 March  (v1)")

    def test_the_shipped_settings_name_the_cap(self):
        shipped = json.loads((Path(cards.__file__).resolve().parent / "project.json").read_text(encoding="utf-8"))
        want = {"handoff_ledger_max_lines": 40, "handoff_ledger_line_chars": 240}
        self.assertEqual({k: shipped.get(k) for k in want}, want)
        self.assertEqual({k: cards.PROJECT_DEFAULT[k] for k in want}, want)


class HandoffNote(unittest.TestCase):
    """Записка предыдущей сессии: живая база в git не лежит, поэтому «на чём остановились» передаётся файлом рядом с конфигом (project.json: handoff_note),
    а handoff показывает его сразу после правил. Нет файла — справка прежняя."""
    HEAD = "HAND-OVER NOTE from the previous session (HANDOFF.md; delete the file when it stops being true):\n"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def note(self, text, name="HANDOFF.md"):
        path = self.t / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_the_note_comes_right_after_the_rules(self):
        self.note("Остановились на фазе 7.\nДальше: решение владельца по фазе 8.")
        out = self.st.handoff(catalog=False)
        self.assertIn(self.HEAD + "Остановились на фазе 7.\nДальше: решение владельца по фазе 8.", out)
        self.assertLess(out.index("MEMORY BRIEF"), out.index("HAND-OVER NOTE"))
        self.assertLess(out.index("HAND-OVER NOTE"), out.index("CANON:"))
        self.assertLess(out.index("lint() lists what has gone stale."), out.index("HAND-OVER NOTE"))     # правила идут первыми и целиком

    def test_without_a_file_the_brief_is_what_it_was(self):
        plain = self.st.handoff(catalog=False)
        self.assertNotIn("HAND-OVER", plain)
        self.note("записка")
        self.st.project["handoff_note"] = ""                                                    # выключена в настройках — как будто файла нет
        self.assertEqual(self.st.handoff(catalog=False), plain)

    def test_an_empty_or_unreadable_note_adds_nothing(self):
        plain = self.st.handoff(catalog=False)
        self.note("  \n \n")
        self.assertEqual(self.st.handoff(catalog=False), plain)
        (self.t / "HANDOFF.md").unlink()
        (self.t / "HANDOFF.md").mkdir()                                                         # вместо файла папка
        self.assertEqual(self.st.handoff(catalog=False), plain)
        (self.t / "HANDOFF.md").rmdir()
        (self.t / "HANDOFF.md").write_bytes(b"\xff\xfe\x00 not utf-8 \xc3\x28")                 # не UTF-8
        self.assertEqual(self.st.handoff(catalog=False), plain)

    def test_a_long_note_is_cut_by_lines_and_names_the_file(self):
        self.note("\n".join(f"строка {i:03d} записки с обычным текстом" for i in range(200)))
        self.st.project["handoff_note_max_tok"] = 100
        text = self.st.handoff_note()
        self.assertIn("строка 000 записки", text)
        self.assertNotIn("строка 199", text)
        self.assertTrue(text.endswith("(note cut to fit; read the rest in HANDOFF.md)"))
        self.assertLessEqual(cards.est_tokens(text.split(":\n", 1)[1].rsplit("\n(note cut", 1)[0]), 100)

    def test_one_endless_line_and_a_huge_file_are_cut_too(self):
        self.st.project["handoff_note_max_tok"] = 50
        self.note("слово " * 10000)
        text = self.st.handoff_note()
        self.assertLessEqual(cards.est_tokens(text), 50 + 40)                                   # сама записка в пределе, сверху заголовок и пометка
        self.assertIn("(note cut to fit", text)
        self.note("ab " * 400)                                                                  # короткая, влезает целиком — без пометки
        self.st.project["handoff_note_max_tok"] = 700
        self.assertNotIn("note cut", self.st.handoff_note())

    def test_the_name_can_point_into_a_folder_and_nonsense_falls_back(self):
        self.note("в папке", name="notes/next.md")
        self.st.project["handoff_note"] = "notes/next.md"
        self.assertIn("в папке", self.st.handoff_note())
        self.assertIn("(notes/next.md;", self.st.handoff_note())
        self.note("по умолчанию")
        self.st.project["handoff_note"] = "HANDOFF.md"
        self.st.project["handoff_note_max_tok"] = "много"                                       # мусор в потолке — значение по умолчанию (700)
        self.assertIn("по умолчанию", self.st.handoff_note())
        self.st.project["handoff_note_max_tok"] = -5
        self.assertIn("по умолчанию", self.st.handoff_note())

    def test_the_budget_trims_the_groups_and_leaves_the_note(self):
        self.note("записка остаётся")
        for i in range(8):                                                                      # несколько групп материала, чтобы бюджету было что резать
            (self.t / f"d{i}").mkdir()
            (self.t / f"d{i}" / "a.md").write_text(f"# Раздел {i}\n\n" + ("слова про тему %d " % i) * 300, encoding="utf-8")
        self.st.index_code(self.t, files=[f"d{i}/a.md" for i in range(8)])
        out = self.st.handoff(budget_tok=600)
        self.assertIn("записка остаётся", out)
        self.assertIn("(list shortened", out)
        self.assertEqual(out.count("MATERIAL:"), 1)                                             # список групп укорочен на месте, а не продублирован
        self.assertEqual(out.count("CANON:"), 1)
        self.assertLess(out.index("записка остаётся"), out.index("MATERIAL:"))

    def test_the_shipped_settings_name_the_note(self):
        shipped = json.loads((Path(cards.__file__).resolve().parent / "project.json").read_text(encoding="utf-8"))
        want = {"handoff_note": "HANDOFF.md", "handoff_note_max_tok": 700}
        self.assertEqual({k: shipped.get(k) for k in want}, want)
        self.assertEqual({k: cards.PROJECT_DEFAULT[k] for k in want}, want)

    def test_a_note_that_is_in_the_repository_fits_whole(self):
        """Записка, лежащая в репозитории, не должна молча обрезаться: если файл есть, он влезает в потолок."""
        proj = cards.load_project()
        path = cards.project_path(proj, proj["handoff_note"])
        if path.exists():
            self.assertLessEqual(cards.est_tokens(path.read_text(encoding="utf-8").strip()), proj["handoff_note_max_tok"], f"{path.name} длиннее потолка: handoff его обрежет")


class PromoteQueueWarnings(unittest.TestCase):
    """H4: у promote нет потолка, а ёмкость системы — человек, который принимает. Очередь видна и предупреждает, но записи не запрещает.
    Пороги лежат в project.json: promote.max_waiting (по умолчанию 20) и promote.warn_ratio (0.8, то есть предупреждение с 16-го)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def seed_waiting(self, n, first=0, prefix="LF-seed"):
        """n предложений в столе в статусе raw, минуя promote (быстро: без процесса на каждое)."""
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        for i in range(first, first + n):
            con.execute("INSERT INTO objects (id, cluster, layer, type, title, status, body, created_at, updated_at) "
                        "VALUES (?, 'C', 1, 'fact', ?, 'raw', '', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')", (f"{prefix}-{i:02d}-v1", f"seed fact {i}"))
        con.commit()
        con.close()

    def raw_lf(self):
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        try:
            return con.execute("SELECT COUNT(*) FROM objects WHERE id LIKE 'LF-%' AND status='raw'").fetchone()[0]
        finally:
            con.close()

    def promote(self, key="k", **kw):
        self.st.fact_set(key, "v")
        return self.st.fact_promote(key, apply=True, **kw)

    def test_the_warning_starts_at_the_ratio_and_the_proposal_is_written(self):
        self.seed_waiting(15)
        out = self.promote()                                                              # шестнадцатое: 20 × 0.8 = 16
        self.assertIn("created in the desk as RAW", out)
        self.assertIn("WARNING: 16 proposals wait for ACCEPT (warning from 16, limit 20)", out)
        self.assertIn("ask the human to ACCEPT or TAKE some", out)
        self.assertEqual(self.raw_lf(), 16)

    def test_below_the_ratio_there_is_no_warning(self):
        self.seed_waiting(14)
        out = self.promote()                                                              # пятнадцатое
        self.assertIn("created in the desk as RAW", out)
        self.assertNotIn("WARNING", out)

    def test_over_the_limit_nothing_is_refused(self):
        self.seed_waiting(24)
        out = self.promote()
        self.assertIn("created in the desk as RAW", out)                                  # записано, хотя ждут 25 при пределе 20
        self.assertEqual(desk_row(self.desk, "LF-k-v1")["status"], "raw")
        self.assertIn("WARNING: 25 proposals wait for ACCEPT, the limit is 20", out)
        self.assertIn("stop proposing", out)
        self.assertEqual(self.raw_lf(), 25)

    def test_a_dry_run_says_what_it_would_make_and_writes_nothing(self):
        self.seed_waiting(15)
        self.st.fact_set("k", "v")
        out = self.st.fact_promote("k")
        self.assertIn("DRY RUN", out)
        self.assertIn("WARNING: with this one 16 proposals would wait for ACCEPT", out)
        self.assertIsNone(desk_row(self.desk, "LF-k-v1"))
        self.assertEqual(self.raw_lf(), 15)

    def test_the_count_goes_down_when_a_human_decides(self):
        self.seed_waiting(17)
        for oid in ("LF-seed-00-v1", "LF-seed-01-v1"):
            desk_do(self.desk, "ACCEPT", oid)
        desk_do(self.desk, "TAKE", "LF-seed-02-v1")
        self.assertEqual(self.raw_lf(), 14)
        self.assertNotIn("WARNING", self.promote())                                       # пятнадцатое: тихо

    def test_accept_flag_does_not_grow_the_queue(self):
        self.seed_waiting(19)
        out = self.promote(accept=True)
        self.assertEqual(self.raw_lf(), 19)                                               # принято сразу, в очередь не встало
        self.assertIn("WARNING: 19 proposals wait for ACCEPT", out)                       # состояние стола всё равно правдиво

    def test_only_the_ledger_proposals_are_counted(self):
        self.seed_waiting(25, prefix="X-OWN")                                             # свои raw-объекты стола (в настоящем их 22) — не наша очередь
        self.assertNotIn("WARNING", self.promote())
        self.assertNotIn("PROPOSALS WAITING: 25", self.st.handoff(catalog=False))

    def test_limits_come_from_the_project_settings(self):
        self.st.project["promote"].update(max_waiting=4, warn_ratio=0.5)
        self.seed_waiting(1)
        out = self.promote()                                                              # второе: 4 × 0.5 = 2
        self.assertIn("WARNING: 2 proposals wait for ACCEPT (warning from 2, limit 4)", out)
        out2 = self.promote("k2")
        self.assertIn("WARNING: 3 proposals wait for ACCEPT (warning from 2, limit 4)", out2)
        self.assertIn("PROPOSALS WAITING: 3/4", self.st.handoff(catalog=False))

    def test_the_warnings_can_be_switched_off_and_bad_settings_do_not_break_promote(self):
        self.seed_waiting(30)
        self.st.project["promote"]["max_waiting"] = 0
        out = self.promote()
        self.assertNotIn("WARNING", out)
        self.assertIn("PROPOSALS WAITING: 31", self.st.handoff(catalog=False))            # счёт виден, но без предела
        self.assertNotIn("proposal-backlog", {f["code"] for f in self.st.lint()})
        self.st.project["promote"].update(max_waiting="много", warn_ratio=None)
        self.assertIn("WARNING: 32 proposals wait for ACCEPT, the limit is 20", self.promote("k2"))   # мусор в настройках — значения по умолчанию

    def test_the_thresholds_are_written_in_the_shipped_project_json(self):
        """Значения лежат в project.json (его правит человек), а не только в коде; значения по умолчанию в коде с ними совпадают."""
        shipped = json.loads((Path(cards.__file__).resolve().parent / "project.json").read_text(encoding="utf-8"))["promote"]
        want = {"max_waiting": 20, "warn_ratio": 0.8}
        self.assertEqual({k: shipped.get(k) for k in want}, want)
        self.assertEqual({k: cards.load_project()["promote"][k] for k in want}, want)
        self.assertEqual({k: cards.PROJECT_DEFAULT["promote"][k] for k in want}, want)

    def test_handoff_shows_the_counter_only_when_something_waits(self):
        self.assertNotIn("PROPOSALS WAITING", self.st.handoff(catalog=False))             # пусто — строки нет, справка не растёт
        self.seed_waiting(3)
        out = self.st.handoff(catalog=False)
        self.assertIn("PROPOSALS WAITING: 3/20", out)
        self.assertNotIn("WARNING", out)

    def test_lint_warns_about_the_backlog_from_the_ratio(self):
        self.seed_waiting(15)
        codes = lambda: [f for f in self.st.lint() if f["code"] == "proposal-backlog"]  # noqa: E731
        self.assertEqual(codes(), [])
        self.seed_waiting(1, first=15)
        found = codes()
        self.assertEqual([(f["level"], f["subject"]) for f in found], [("warn", "desk")])
        self.assertIn("16 proposals wait for ACCEPT (warning from 16, limit 20)", found[0]["message"])
        self.assertIn("proposal-backlog", cards.Store.lint_text(self.st.lint()))
        self.assertRegex(self.st.handoff(catalog=False), r"LINT: 0 errors, 1 warnings")

    def test_the_counter_is_a_read_and_the_tool_text_tells_agents_what_to_do(self):
        self.seed_waiting(16)
        db = self.desk / "project-store.sqlite"
        before = (db.stat().st_mtime_ns, db.stat().st_size)
        self.assertEqual(self.st.waiting_proposals(), 16)
        self.assertEqual(before, (db.stat().st_mtime_ns, db.stat().st_size))
        spec = {s["name"]: s["description"] for s in cards.TOOL_SPECS}
        self.assertIn("WARNING", spec["fact_promote"])
        self.assertIn("never refuses", spec["fact_promote"])
        self.assertIn("backlog", spec["lint"])


class LedgerAndGrowthLint(unittest.TestCase):
    """H5: журнал качается (A → B → A) и производное растёт вровень с первоисточником. Обе беды ловятся без модели, только предупреждениями.
    Пороги лежат в project.json (lint.churn_versions = 5, lint.derived_raw_warn = 0.6): это предположения, а не измерения."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.t / "nodesk"))     # стола рядом нет: настоящий не читаем

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def hist(self, key, *values):
        for v in values:
            self.st.fact_set(key, v, "t1")

    def found(self, code):
        return [f for f in self.st.lint() if f["code"] == code]

    def one(self, code):
        fs = self.found(code)
        self.assertEqual(len(fs), 1, f"{code}: ждали ровно одно замечание, есть {fs}")
        return fs[0]

    def chat_and_note(self):
        chat = self.t / "chat.md"
        chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
        self.st.index_chat(chat)
        body = [cards.unquote(x) for x in cards.split_lines(self.st._card("t001")["body"])]
        line = next(i for i, x in enumerate(body, 1) if "открытая вики" in x)
        out = self.st.add_note("Technopedia", f"Открытая вики знаний с версиями (t001 L{line}).",
                               sources=[dict(card="t001", lines=f"{line}-{line}", quote="ОТКРЫТАЯ вики знаний")], author="agent")
        self.assertTrue(out.startswith("OK n001"), out)

    def set_tokens(self, raw, derived):
        """Подставляем размеры напрямую: так отношение известно точно, а не зависит от оценки токенов."""
        self.st.con.execute("UPDATE cards SET ntok=0 WHERE kind IN ('turn', 'note')")
        self.st.con.execute("UPDATE cards SET ntok=? WHERE id='t001'", (raw,))
        self.st.con.execute("UPDATE cards SET ntok=? WHERE id='n001'", (derived,))
        self.st.con.commit()

    # --- качание
    def test_a_value_that_comes_back_is_flagged_with_the_sequence(self):
        self.hist("deadline", "15 March", "22 March", "15 March")
        f = self.one("ledger-flipflop")
        self.assertEqual((f["level"], f["subject"]), ("warn", "deadline"))
        self.assertIn("«15 March» (v1) → «22 March» (v2) → «15 March» (v3)", f["message"])

    def test_a_later_loop_is_shown_from_its_last_match(self):
        self.hist("deadline", "A", "B", "C", "B")
        f = self.one("ledger-flipflop")
        self.assertIn("«B» (v2) → «C» (v3) → «B» (v4)", f["message"])
        self.assertNotIn("(v1)", f["message"])

    def test_ordinary_changes_are_not_flipflops(self):
        self.hist("a", "1", "2", "3")                                                    # только вперёд
        self.hist("b", "x", "x")                                                         # повтор — не версия
        self.hist("c", "one", "two")                                                     # двух версий для возврата мало
        self.assertEqual(self.found("ledger-flipflop"), [])

    def test_the_comparison_ignores_case_and_spaces(self):
        self.hist("deadline", "15 March", "22 March", "15  march")
        self.assertEqual(len(self.found("ledger-flipflop")), 1)

    def test_a_long_way_back_is_shortened(self):
        self.hist("deadline", "A", "B", "C", "D", "E", "F", "G", "A")
        f = self.one("ledger-flipflop")
        self.assertIn("«A» (v1) → «B» (v2) → «C» (v3) → … → «G» (v7) → «A» (v8)", f["message"])
        self.assertNotIn("(v4)", f["message"])

    def test_a_retracted_key_is_left_alone(self):
        self.hist("back", "A", "B", "A")                                                 # вернулось, но ключ потом сняли
        self.st.fact_retract("back")
        self.hist("busy", "1", "2", "3", "4", "5")                                       # много версий, но ключ снят
        self.st.fact_retract("busy")
        self.assertEqual((self.found("ledger-flipflop"), self.found("ledger-churn")), ([], []))

    # --- частые правки
    def test_churn_is_info_from_five_versions(self):
        self.hist("score", "1", "2", "3", "4")
        self.assertEqual(self.found("ledger-churn"), [])
        self.hist("score", "5")
        f = self.one("ledger-churn")
        self.assertEqual((f["level"], f["subject"]), ("info", "score"))
        self.assertIn("5 versions", f["message"])

    def test_the_lint_thresholds_come_from_the_settings_and_can_be_switched_off(self):
        self.hist("score", "1", "2", "3")
        self.assertEqual(self.found("ledger-churn"), [])
        self.st.project["lint"]["churn_versions"] = 3
        self.assertEqual(len(self.found("ledger-churn")), 1)
        self.st.project["lint"]["churn_versions"] = 0
        self.assertEqual(self.found("ledger-churn"), [])
        self.st.project["lint"]["churn_versions"] = "много"                               # мусор — значение по умолчанию
        self.assertEqual(self.found("ledger-churn"), [])
        self.hist("score", "4", "5")
        self.assertEqual(len(self.found("ledger-churn")), 1)

    # --- производное против первоисточника
    def test_the_ratio_is_in_the_brief_and_warns_from_the_threshold(self):
        self.chat_and_note()
        self.set_tokens(20000, 8800)
        self.assertEqual(self.st.growth_line(), "DERIVED/RAW 0.44 (notes ~8.8K tok, chat replies ~20K tok)")
        self.assertIn("DERIVED/RAW 0.44", self.st.handoff(catalog=False))
        self.assertEqual(self.found("derived-heavy"), [])
        self.set_tokens(20000, 12000)
        f = self.one("derived-heavy")
        self.assertEqual((f["level"], f["subject"]), ("warn", "notes"))
        self.assertIn("0.60", f["message"])
        self.assertIn("DERIVED/RAW 0.60", self.st.handoff(catalog=False))

    def test_without_notes_or_without_chat_there_is_no_ratio(self):
        self.assertEqual(self.st.growth_line(), "")
        self.chat_and_note()
        self.st.con.execute("UPDATE cards SET status='archived' WHERE kind='turn'")        # заметки есть, реплик нет
        self.st.con.commit()
        self.assertEqual(self.st.growth_line(), "")
        self.assertEqual(self.found("derived-heavy"), [])
        self.st.con.execute("UPDATE cards SET status='active' WHERE kind='turn'")
        self.st.con.execute("UPDATE cards SET status='archived' WHERE kind='note'")        # реплики есть, заметок нет
        self.st.con.commit()
        self.assertEqual(self.st.growth_line(), "")
        self.assertNotIn("DERIVED/RAW", self.st.handoff(catalog=False))

    def test_the_ratio_threshold_is_a_setting_and_can_be_switched_off(self):
        self.chat_and_note()
        self.set_tokens(20000, 10000)
        self.assertEqual(self.found("derived-heavy"), [])
        self.st.project["lint"]["derived_raw_warn"] = 0.5
        self.assertEqual(len(self.found("derived-heavy")), 1)
        self.st.project["lint"]["derived_raw_warn"] = 0
        self.assertEqual(self.found("derived-heavy"), [])
        self.assertIn("DERIVED/RAW 0.50", self.st.growth_line())                          # число остаётся видимым и без порога

    def test_a_tiny_chat_shows_the_number_but_does_not_warn(self):
        """На десятке реплик отношение ничего не значит: число видно, предупреждения нет, пока реплик меньше derived_raw_min_tok."""
        self.chat_and_note()
        self.set_tokens(1000, 900)
        self.assertIn("DERIVED/RAW 0.90", self.st.growth_line())
        self.assertEqual(self.found("derived-heavy"), [])
        self.st.project["lint"]["derived_raw_min_tok"] = 0                              # порог размера выключен — предупреждение есть
        self.assertEqual(len(self.found("derived-heavy")), 1)

    def test_an_empty_ledger_and_no_notes_add_nothing(self):
        self.assertEqual([f["code"] for f in self.st.lint()], [])
        self.assertEqual(self.st.lint_summary(), "")
        self.assertNotIn("DERIVED/RAW", self.st.handoff(catalog=False))

    def test_the_thresholds_are_written_in_the_shipped_project_json(self):
        shipped = json.loads((Path(cards.__file__).resolve().parent / "project.json").read_text(encoding="utf-8"))["lint"]
        want = {"churn_versions": 5, "derived_raw_warn": 0.6, "derived_raw_min_tok": 10000}
        self.assertEqual({k: shipped.get(k) for k in want}, want)
        self.assertEqual({k: cards.load_project()["lint"][k] for k in want}, want)
        self.assertEqual({k: cards.PROJECT_DEFAULT["lint"][k] for k in want}, want)


class Mcp(unittest.TestCase):
    def test_stdio_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "c.sqlite"
            st = cards.Store(db)
            st.fact_set("k", "v")
            st.con.close()
            msgs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "facts", "arguments": {}}},
            ]
            r = subprocess.run([sys.executable, str(Path(cards.__file__)), "--db", str(db), "serve"],
                               input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True, timeout=30)
            lines = [json.loads(x) for x in r.stdout.strip().split("\n")]
            self.assertEqual([x["id"] for x in lines], [1, 2, 3])
            self.assertEqual({t["name"] for t in lines[1]["result"]["tools"]}, {s["name"] for s in cards.TOOL_SPECS})
            self.assertIn("canon", {t["name"] for t in lines[1]["result"]["tools"]})
            self.assertIn("fact_promote", {t["name"] for t in lines[1]["result"]["tools"]})
            self.assertIn("fact_set", lines[0]["result"]["instructions"])                  # правила памяти едут вместе с сервером
            self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "cards")
            self.assertIn("k = v", lines[2]["result"]["content"][0]["text"])


class McpNotes(unittest.TestCase):
    def test_stdio_lint_log_and_note_with_checked_sources(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            chat = d / "chat.md"
            chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
            db = d / "c.sqlite"
            st = cards.Store(db, project=project_for(d, d / "nodesk"))
            st.index_chat(chat)
            st.con.close()
            call = lambda i, name, args: {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}  # noqa: E731
            msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    call(2, "note", {"title": "Т", "text": "тело", "sources": [{"card": "t001", "lines": "13-13", "quote": "открытая вики"}]}),
                    call(3, "note", {"title": "Плохая", "text": "тело", "sources": [{"card": "t001", "lines": "13-13", "quote": "нет такой цитаты"}]}),
                    call(4, "lint", {}), call(5, "log", {"n": 5}), call(6, "open", {"id": "n001"})]
            cfg = d / "project.json"                                # заметки из MCP разрешены по умолчанию; стола рядом нет, настоящий стол не читаем
            cfg.write_text(json.dumps({"pm_dir": "nowhere", "chats": []}), encoding="utf-8")
            msgs.append({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
            r = subprocess.run([sys.executable, str(Path(cards.__file__)), "--db", str(db), "--config", str(cfg), "serve"],
                               input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True, timeout=30)
            out = {x["id"]: x["result"] for x in (json.loads(l) for l in r.stdout.strip().split("\n"))}
            text = lambda i: out[i]["content"][0]["text"]  # noqa: E731
            self.assertTrue({"note", "lint", "log"} <= {t["name"] for t in out[7]["tools"]})
            self.assertTrue(text(2).startswith("OK n001"), text(2))
            self.assertTrue(text(3).startswith("ERR quote not found"), text(3))           # неверная цитата отвергнута при записи
            self.assertIn("nothing to flag", text(4))
            self.assertIn("] note | n001 |", text(5))
            self.assertIn("SOURCES (1", text(6))


class Helpers(unittest.TestCase):
    def test_parse_span(self):
        self.assertEqual(cards.parse_span("317-345"), (317, 345))
        self.assertEqual(cards.parse_span("L5"), (5, 5))
        self.assertEqual(cards.parse_span("L5-L9"), (5, 9))
        self.assertEqual(cards.parse_span([3, 9]), (3, 9))
        for bad in ("9-3", "abc", "0-3", "", None):
            self.assertIsNone(cards.parse_span(bad), bad)

    def test_norm_quote_ignores_case_markup_and_quotes(self):
        self.assertEqual(cards.norm_quote("**Привет**,  «Мир» — Ёлка"), 'привет, "мир" - елка')

    def test_dates_in(self):
        from datetime import date
        self.assertEqual(cards.dates_in("с 01.10.2026 и 2027-01-05, но не 31.02.2026 и не 12.12.1999"), [date(2026, 10, 1), date(2027, 1, 5)])


NOTE_PAIRS = [("что такое Technopedia", "## Определение\n\nTechnopedia — это открытая вики знаний.\nОна хранит версии утверждений."),
              ("а форки?", "## Форки\n\nФорк позволяет оспорить утверждение.\nКаждый форк имеет автора.")]


class Notes(unittest.TestCase):
    """Заметки: источник обязателен и проверяется при записи, потом видно, что он изменился."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.chat = self.t / "chat.md"
        self.chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.t / "nodesk"))
        self.st.index_chat(self.chat)
        self.l = self.line_of("t001", "открытая вики")

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def line_of(self, cid, needle):
        body = [cards.unquote(x) for x in cards.split_lines(self.st._card(cid)["body"])]
        return next(i for i, x in enumerate(body, 1) if needle in x)

    def make_note(self, **kw):
        args = dict(title="Technopedia", text=f"Открытая вики знаний с версиями (t001 L{self.l}).",
                    sources=[dict(card="t001", lines=f"{self.l}-{self.l}", quote="ОТКРЫТАЯ вики знаний")], author="agent")
        args.update(kw)
        return self.st.add_note(**args)

    def test_note_roundtrip_open_find_lint(self):
        out = self.make_note()
        self.assertTrue(out.startswith("OK n001") and "1 verified source" in out, out)
        shown = self.st.open("n001")
        self.assertIn(f"SOURCES (1", shown)
        self.assertIn(f"t001 L{self.l}-{self.l} «ОТКРЫТАЯ вики знаний»", shown)
        self.assertIn("n001", self.st.find("версиями"))                      # заметка ищется наравне с картотекой
        self.assertEqual(self.st.lint(), [])                                  # источник на месте, цитата найдена

    def test_sources_are_checked_on_write(self):
        def err(**kw):
            r = self.make_note(**kw)
            self.assertTrue(r.startswith("ERR"), r)
            return r
        self.assertIn("does not exist", err(sources=[dict(card="t999", lines="1-2")]))
        self.assertIn("outside", err(sources=[dict(card="t001", lines="500-600")]))
        self.assertIn("quote not found", err(sources=[dict(card="t001", lines=f"{self.l}-{self.l}", quote="закрытая энциклопедия")]))
        self.assertIn("give the lines", err(sources=[dict(card="t001", lines="")]))
        self.assertIn("required", err(text=" "))
        self.make_note()
        self.assertIn("is a note", err(sources=[dict(card="n001", lines="1-1")]))     # источник — первичная карточка, не другая заметка
        self.assertEqual(self.st.con.execute("SELECT COUNT(*) c FROM cards WHERE kind='note'").fetchone()["c"], 1)   # неудачные записи ничего не оставили

    def test_manual_note_has_no_sources_and_is_not_flagged(self):
        out = self.st.add_note("Мысль", "просто заметка человека", sources=None)
        self.assertIn("manual", out)
        self.assertIn("none (a manual note)", self.st.open("n001"))
        self.assertEqual(self.st.lint(), [])

    # --- повтор той же записи ничего не добавляет (фаза 1 плана PLAN-LOOPS.md)
    def counts(self):
        q = lambda sql: self.st.con.execute(sql).fetchone()[0]  # noqa: E731
        return (q("SELECT COUNT(*) FROM cards"), q("SELECT COUNT(*) FROM chunks"), q("SELECT COUNT(*) FROM note_sources"), q("SELECT COUNT(*) FROM oplog"),
                q("SELECT version FROM cards WHERE id='n001'"))

    def test_same_note_again_answers_unchanged_and_writes_nothing(self):
        first = self.make_note()
        before = self.counts()
        again = self.make_note()
        self.assertTrue(first.startswith("OK n001"), first)
        self.assertEqual(again, "UNCHANGED n001 (same title, text and sources)")
        self.assertEqual(self.counts(), before)                                       # ни карточки, ни кусков, ни источников, ни строки журнала

    def test_same_note_is_recognized_through_spaces_quote_markup_and_another_group(self):
        self.make_note()
        for kw in (dict(title="  Technopedia "), dict(text=f"Открытая вики знаний с версиями (t001 L{self.l}).\n\n"),
                   dict(sources=[dict(card="t001", lines=f"L{self.l}", quote="  Открытая   ВИКИ знаний ")]), dict(group="Другая группа")):
            self.assertTrue(self.make_note(**kw).startswith("UNCHANGED n001"), kw)

    def test_a_different_title_text_or_source_makes_a_new_note(self):
        self.make_note()
        mk = self.make_note
        quote = "открытая вики знаний"
        self.assertTrue(mk(text="Другой текст.").startswith("OK n002"))
        self.assertTrue(mk(title="Другое название").startswith("OK n003"))
        self.assertTrue(mk(sources=[dict(card="t001", lines=f"{self.l}-{self.l + 1}", quote=quote)]).startswith("OK n004"))         # другие строки
        self.assertTrue(mk(sources=[dict(card="t001", lines=f"{self.l}-{self.l}", quote="вики знаний")]).startswith("OK n005"))      # другая цитата
        self.assertTrue(mk(sources=[dict(card="t001", lines=f"{self.l}-{self.l}", quote=quote), dict(card="t002", lines="1-3")]).startswith("OK n006"))   # ещё источник

    def test_manual_note_twice_and_archived_twin_does_not_block(self):
        self.assertIn("manual", self.st.add_note("Мысль", "просто заметка человека"))
        self.assertEqual(self.st.add_note("Мысль", "просто заметка человека"), "UNCHANGED n001 (same title, text and sources)")
        self.st.con.execute("UPDATE cards SET status='archived' WHERE id='n001'")
        self.st.con.commit()
        self.assertTrue(self.st.add_note("Мысль", "просто заметка человека").startswith("OK n002"))      # в архиве — не двойник

    def test_mcp_note_twice_answers_unchanged_and_the_tool_says_so(self):
        args = {"title": "Т", "text": "тело", "sources": [dict(card="t001", lines=f"{self.l}-{self.l}", quote="открытая вики")]}
        self.assertTrue(cards.call_tool(self.st, "note", args).startswith("OK n001"))
        self.assertTrue(cards.call_tool(self.st, "note", args).startswith("UNCHANGED n001"))
        spec = next(t for t in cards.TOOL_SPECS if t["name"] == "note")
        self.assertIn("UNCHANGED", spec["description"])                                  # агент заранее знает, что такой ответ бывает

    def test_lint_marks_twin_notes_with_different_sources(self):
        self.make_note()
        self.make_note(sources=[dict(card="t001", lines=f"{self.l}-{self.l + 1}", quote="открытая вики знаний")])        # тот же текст, другие строки → n002
        f = [x for x in self.st.lint() if x["code"] == "note-duplicate-text"]
        self.assertEqual([(x["level"], x["subject"]) for x in f], [("info", "n001")])
        self.assertIn("n001, n002", f[0]["message"])
        self.assertIn("different sources", f[0]["message"])

    def test_lint_marks_exact_twins_made_before_notes_became_idempotent(self):
        self.st._find_same_note = lambda *a, **k: None                                   # как раньше: проверки повтора нет
        self.make_note()
        self.make_note()
        f = [x for x in self.st.lint() if x["code"] == "note-duplicate-text"]
        self.assertEqual(len(f), 1)
        self.assertIn("the same sources", f[0]["message"])

    def test_lint_is_quiet_about_notes_with_different_text(self):
        self.make_note()
        self.make_note(text="Другой текст.")
        self.assertEqual([x for x in self.st.lint() if x["code"] == "note-duplicate-text"], [])

    def test_lint_flags_changed_and_missing_sources(self):
        self.make_note(sources=[dict(card="t001", lines=f"{self.l}-{self.l + 1}", quote="открытая вики")])      # две строки: 13 и 14
        self.assertEqual(self.st.lint(), [])
        changed = make_chat([(NOTE_PAIRS[0][0], NOTE_PAIRS[0][1].replace("открытая вики", "закрытая вики")), NOTE_PAIRS[1]])
        self.chat.write_text(changed, encoding="utf-8")
        self.st.index_chat(self.chat)
        f = self.st.lint()
        self.assertEqual([(x["level"], x["code"], x["subject"]) for x in f], [("warn", "note-source-drift", "n001")])
        self.assertIn("[CHANGED", self.st.open("n001"))
        self.chat.write_text(make_chat([("коротко", "да")]), encoding="utf-8")        # реплика стала короче цитируемых строк
        self.st.index_chat(self.chat)
        f = self.st.lint()
        self.assertEqual([(x["level"], x["code"]) for x in f], [("error", "note-source-missing")])
        self.assertIn("MISSING", self.st.open("n001"))

    def test_lint_flags_note_without_sources_and_dangling_links(self):
        self.make_note()
        self.st.add_note("Висит", "ссылка на [[n099]] и [[n001]]", sources=[dict(card="t001", lines="1-3")])
        self.st.con.execute("DELETE FROM note_sources WHERE note_id='n002'")           # как будто источники потеряны
        self.st.con.commit()
        codes = {(x["code"], x["subject"]) for x in self.st.lint()}
        self.assertIn(("note-no-sources", "n002"), codes)
        self.assertIn(("note-dangling-link", "n002"), codes)
        self.assertTrue(any(c == "note-orphan" for c, _ in codes))                     # на n002 никто не ссылается, а на n001 — да

    def test_patch_note_keeps_sources_and_bumps_version(self):
        self.make_note()
        out = self.st.patch("n001", 1, "с версиями", "с версиями утверждений")
        self.assertTrue(out.startswith("OK n001 v2"), out)
        self.assertIn("версиями утверждений", self.st.open("n001"))
        self.assertIn("SOURCES (1", self.st.open("n001"))
        self.assertEqual(self.st.lint(), [])

    def test_big_note_gets_outline_and_sources_come_last(self):
        text = "# Страница\n\n" + "\n\n".join(f"## Раздел {i}\n\n" + "слово " * 300 for i in range(8))
        self.st.add_note("Большая", text, sources=[dict(card="t001", lines="1-3")])
        out = self.st.open("n001")
        self.assertIn("OUTLINE", out)
        self.assertNotIn("SOURCES", out)                                               # источники печатаются, когда показан конец заметки
        last = self.st._card("n001")["nlines"]
        self.assertIn("SOURCES (1", self.st.open("n001", lines=f"{last - 2}-{last}"))

    def test_mcp_note_requires_sources_and_obeys_switch(self):
        self.assertIn("needs at least one source", cards.call_tool(self.st, "note", {"title": "x", "text": "y", "sources": []}))
        ok = cards.call_tool(self.st, "note", {"title": "Т", "text": "тело", "sources": [dict(card="t001", lines=f"{self.l}-{self.l}", quote="открытая вики")]})
        self.assertTrue(ok.startswith("OK n001"), ok)
        self.st.project["notes"]["mcp_write"] = False
        self.assertIn("switched off", cards.call_tool(self.st, "note", {"title": "x", "text": "y", "sources": [dict(card="t001", lines="1-2")]}))
        self.assertEqual(self.st.con.execute("SELECT COUNT(*) c FROM cards WHERE kind='note'").fetchone()["c"], 1)

    def test_log_lines_have_stable_prefix_and_grep(self):
        self.st.fact_set("budget", "96000 EUR", "t1")
        self.make_note()
        self.st.patch("n001", 1, "с версиями", "с версиями утверждений")
        self.st.fact_retract("budget")
        out = self.st.log(n=10, desk=False)
        for part in ("] fact | budget | = 96000 EUR (v1)", "] note | n001 |", "] patch | n001 |", "] retract | budget |"):
            self.assertIn(part, out)
        self.assertTrue(all(ln.startswith("## [") for ln in out.split("\n")))
        self.assertEqual(self.st.log(grep="budget", desk=False).count("\n"), 1)
        self.assertEqual(self.st.log(n=1, desk=False).count("\n"), 0)

    def test_export_wiki_writes_index_log_and_pages_with_file_lines(self):
        self.make_note()
        res = self.st.export_wiki(self.t / "wiki")
        self.assertEqual(res["pages"], 1)
        idx = (self.t / "wiki" / "index.md").read_text(encoding="utf-8")
        self.assertIn("[Technopedia](pages/n001-technopedia.md)", idx)
        page = (self.t / "wiki" / "pages" / "n001-technopedia.md").read_text(encoding="utf-8")
        file_line = next(i for i, x in enumerate(self.chat.read_text(encoding="utf-8").split("\n"), 1) if "открытая вики" in x)
        self.assertIn(f"chat.md:L{file_line}-{file_line}", page)                       # ссылка дополнена координатами исходного файла
        self.assertIn("## [", (self.t / "wiki" / "log.md").read_text(encoding="utf-8"))
        self.st.export_wiki(self.t / "wiki")                                           # повторный экспорт перезаписывает, не плодит страницы
        self.assertEqual(len(list((self.t / "wiki" / "pages").glob("*.md"))), 1)


class GeneratedOutputIsNotInput(unittest.TestCase):
    """Фаза 3 плана PLAN-LOOPS.md: то, что картотека сама выгрузила (папка вики, виды *-FROM-DB.md), не должно возвращаться в неё входом."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        chat = self.t / "chat.md"
        chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
        self.root = self.t / "repo"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
        (self.root / "engine").mkdir()
        (self.root / "engine" / "LANG-FROM-DB.md").write_text("# Вид базы\n\nСгенерировано pm.py.\n", encoding="utf-8")
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.t / "nodesk", code_root=self.root))
        self.st.index_chat(str(chat))
        self.st.add_note("Technopedia", "Открытая вики знаний (t001 L13).", sources=[dict(card="t001", lines="13-13", quote="открытая вики")])

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def files(self):
        return sorted(r["src"] for r in self.st.con.execute("SELECT src FROM cards WHERE kind='file' AND status='active'"))

    def commit(self, *paths):
        git(self.root, "init", "-q")
        git(self.root, "add", *(paths or ("-A",)))
        git(self.root, "commit", "-qm", "init")

    def test_export_marks_the_folder_and_keeps_the_mark_on_re_export(self):
        self.st.export_wiki(self.root / "wiki")
        mark = self.root / "wiki" / ".cards-generated"
        self.assertEqual(json.loads(mark.read_text(encoding="utf-8"))["tool"], "cards.py export-wiki")
        before = mark.read_bytes()
        with mock.patch.object(cards, "now", return_value="2099-01-01T00:00:00Z"):
            self.st.export_wiki(self.root / "wiki")
        self.assertEqual(mark.read_bytes(), before)                                    # метка пишется один раз: повторный экспорт не меняет файлов зря

    def test_a_foreign_folder_is_refused_and_left_alone(self):
        foreign = self.t / "mine"
        (foreign / "pages").mkdir(parents=True)
        (foreign / "pages" / "my.md").write_text("не трогать\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as cm:
            self.st.export_wiki(foreign)
        self.assertIn("not empty", str(cm.exception))
        self.assertEqual((foreign / "pages" / "my.md").read_text(encoding="utf-8"), "не трогать\n")      # раньше pages/*.md стирались
        self.assertFalse((foreign / ".cards-generated").exists())

    def test_an_empty_folder_and_an_export_of_the_previous_version_are_accepted(self):
        empty = self.t / "empty"
        empty.mkdir()
        self.st.export_wiki(empty)
        self.assertTrue((empty / ".cards-generated").exists())
        old = self.t / "old"
        self.st.export_wiki(old)
        (old / ".cards-generated").unlink()                                            # выгрузка прежней версии: метки нет, но index.md и pages/ на месте
        self.st.export_wiki(old)
        self.assertTrue((old / ".cards-generated").exists())

    def test_exported_wiki_is_not_indexed_in_a_git_root_after_commit(self):
        self.st.export_wiki(self.root / "wiki")
        self.commit()
        stat = self.st.index_code(self.root)
        self.assertEqual([f for f in self.files() if f.startswith("wiki")], [])
        self.assertEqual(stat.get("generated"), 3)                                     # index.md, log.md, pages/n001-technopedia.md

    def test_exported_wiki_is_not_indexed_in_a_plain_root(self):
        self.st.export_wiki(self.root / "wiki")
        stat = self.st.index_code(self.root)
        self.assertEqual([f for f in self.files() if f.startswith("wiki")], [])
        self.assertEqual(stat.get("generated"), 3)

    def test_pages_committed_without_the_mark_are_still_skipped(self):
        self.st.export_wiki(self.root / "wiki")
        self.commit("src", "wiki/pages", "wiki/index.md")                              # метка осталась на диске, но в git её нет
        self.st.index_code(self.root)
        self.assertEqual([f for f in self.files() if f.startswith("wiki")], [])

    def test_other_folders_with_the_same_file_names_are_still_indexed(self):
        (self.root / "docs").mkdir()
        (self.root / "docs" / "index.md").write_text("# Док\n\nтекст\n", encoding="utf-8")
        self.st.export_wiki(self.root / "wiki")
        self.st.index_code(self.root)
        self.assertIn("docs/index.md", self.files())

    def test_from_db_views_are_excluded_by_default_and_in_the_project_file(self):
        self.assertIn("*-FROM-DB.md", cards.PROJECT_DEFAULT["code"]["exclude"])
        self.assertIn("*-FROM-DB.md", cards.load_project()["code"]["exclude"])        # project.json заменяет список целиком, поэтому маска нужна и там
        stats = Counter()
        self.assertEqual(cards.list_files(self.root, tuple(cards.PROJECT_DEFAULT["code"]["exclude"]), stats), ["src/a.py"])
        self.assertEqual(stats["excluded"], 1)

    def test_refresh_prune_archives_the_card_of_a_file_that_is_excluded_now(self):
        self.st.index_code(self.root)                                                  # без исключений: вид базы в индексе (так было в живом индексе)
        self.assertIn("engine/LANG-FROM-DB.md", self.files())
        self.st.project["code"] = {"root": str(self.root), "exclude": ["*-FROM-DB.md"]}
        self.st.refresh()
        self.assertIn("engine/LANG-FROM-DB.md", self.files())                          # без --prune карточка остаётся, как раньше
        out = self.st.refresh(prune=True)
        self.assertEqual(out["code"].get("archived"), 1)
        self.assertEqual(self.files(), ["src/a.py"])

    def test_refresh_prune_on_the_command_line(self):
        cfg = self.t / "project.json"
        cfg.write_text(json.dumps({"code": {"root": str(self.root), "exclude": ["*-FROM-DB.md"]}, "chats": [], "pm_dir": "nowhere"}), encoding="utf-8")
        db = self.t / "cli.sqlite"

        def run(*a):
            r = subprocess.run([sys.executable, str(Path(cards.__file__)), "--db", str(db), "--config", str(cfg), *a], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            return r.stdout

        run("index-code", str(self.root))
        self.assertEqual(json.loads(run("refresh"))["code"].get("archived"), None)
        self.assertEqual(json.loads(run("refresh", "--prune"))["code"].get("archived"), 1)


class LintDesk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = make_desk(self.t)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def codes(self, **kw):
        return [(f["code"], f["subject"]) for f in self.st.lint(**kw)]

    def accept(self, oid):
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "exec", "ACCEPT", oid], cwd=self.desk, check=True, capture_output=True)

    def test_canon_with_passed_date_and_open_condition(self):
        c = self.codes(today="2026-10-11")
        self.assertIn(("canon-date-passed", "F001"), c)            # пилот 01.10.2026 уже в прошлом
        self.assertIn(("canon-condition", "D001"), c)              # «пока нет нового письма Минтруда»
        self.assertNotIn(("canon-date-passed", "D001"), c)         # 01.01.2027 ещё впереди
        self.assertNotIn(("canon-date-passed", "F001"), self.codes(today="2026-09-01"))

    def test_lint_does_not_touch_the_desk(self):
        db = self.desk / "project-store.sqlite"
        before = (db.stat().st_mtime_ns, db.stat().st_size)
        self.st.lint(today="2026-10-11")
        self.assertEqual(before, (db.stat().st_mtime_ns, db.stat().st_size))

    def test_ledger_fact_without_source_and_proposal_waiting_for_accept(self):
        self.st.fact_set("budget", "96000 EUR")
        self.st.fact_set("lead", "Anna", "реплика 3")
        self.st.fact_promote("lead", apply=True)
        today = datetime.now(timezone.utc).date()
        c = self.codes(today=today.isoformat())
        self.assertIn(("ledger-no-source", "budget"), c)
        self.assertNotIn(("ledger-no-source", "lead"), c)
        self.assertNotIn(("proposal-waiting", "LF-lead-v1"), c)                                   # только что предложено
        self.assertIn(("proposal-waiting", "LF-lead-v1"), self.codes(today=(today + timedelta(days=8)).isoformat()))
        self.accept("LF-lead-v1")
        self.assertNotIn(("proposal-waiting", "LF-lead-v1"), self.codes(today=(today + timedelta(days=8)).isoformat()))

    def test_canon_behind_ledger_then_retracted(self):
        self.st.fact_set("deadline", "15 March", "t1")
        self.st.fact_promote("deadline", apply=True, accept=True)
        self.assertNotIn("canon-behind-ledger", [c for c, _ in self.codes()])
        self.st.fact_set("deadline", "22 March", "t2")
        self.assertIn(("canon-behind-ledger", "LF-deadline-v1"), self.codes())
        self.st.fact_retract("deadline")
        c = self.codes()
        self.assertIn(("canon-retracted", "LF-deadline-v1"), c)
        self.assertNotIn(("canon-behind-ledger", "LF-deadline-v1"), c)

    def test_canon_behind_ledger_names_the_command_and_it_clears_the_finding(self):
        self.st.fact_set("deadline", "15 March", "t1")
        self.st.fact_promote("deadline", apply=True, accept=True)
        self.st.fact_set("deadline", "22 March", "t2")
        msg = lambda: next(f["message"] for f in self.st.lint() if f["code"] == "canon-behind-ledger")  # noqa: E731
        self.assertIn("promote deadline --apply", msg())                                 # новое значение ещё не предложено
        self.assertNotIn("has no 'supersede'", msg())
        self.st.fact_promote("deadline", apply=True)
        self.assertIn("SUPERSEDE LF-deadline-v1 BY LF-deadline-v2", msg())
        desk_do(self.desk, "SUPERSEDE", "LF-deadline-v1", "BY", "LF-deadline-v2")
        c = self.codes()
        self.assertNotIn(("canon-behind-ledger", "LF-deadline-v1"), c)                  # человек заменил — замечание ушло
        self.assertFalse([x for x in c if x[0] == "ledger-behind-canon"])

    def test_ledger_behind_canon_when_the_desk_replaced_what_the_ledger_still_holds(self):
        self.st.fact_set("deadline", "15 March", "t1")
        self.st.fact_promote("deadline", apply=True, accept=True)
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "add", "--id", "D-DL", "--cluster", "C", "--layer", "1", "--type", "fact",
                        "--title", "deadline = 1 April", "--status", "raw", "--body", "письмо"], cwd=self.desk, check=True, capture_output=True)
        desk_do(self.desk, "SUPERSEDE", "LF-deadline-v1", "BY", "D-DL")                  # стол пересмотрел, журнал об этом не знает
        found = [f for f in self.st.lint() if f["code"] == "ledger-behind-canon"]
        self.assertEqual([(f["level"], f["subject"]) for f in found], [("warn", "LF-deadline-v1")])
        self.assertIn("by D-DL «deadline = 1 April»", found[0]["message"])
        self.assertIn("fact_set deadline", found[0]["message"])
        self.assertIn("SUPERSEDE LF-deadline-v1 UNDO", found[0]["message"])             # и путь назад назван
        self.st.fact_set("deadline", "1 April", "письмо")                                 # журнал догнал стол
        self.assertFalse([x for x in self.codes() if x[0] == "ledger-behind-canon"])
        desk_do(self.desk, "SUPERSEDE", "LF-deadline-v1", "UNDO")                        # а при откате замены прежний объект снова в каноне
        self.assertEqual(desk_row(self.desk, "LF-deadline-v1")["status"], "canon")

    def test_replaced_objects_drop_out_of_the_canon_checks(self):
        self.assertIn(("canon-condition", "D001"), self.codes())
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "add", "--id", "D001B", "--cluster", "A", "--layer", "1", "--type", "decision",
                        "--title", "датой выплаты считать 01.03.2027", "--status", "raw", "--body", "письмо пришло"], cwd=self.desk, check=True, capture_output=True)
        desk_do(self.desk, "SUPERSEDE", "D001", "BY", "D001B")
        c = self.codes()
        self.assertNotIn(("canon-condition", "D001"), c)                                 # условие «пока нет письма» снято вместе с объектом
        self.assertNotIn(("canon-date-passed", "D001"), c)
        db = self.desk / "project-store.sqlite"
        before = (db.stat().st_mtime_ns, db.stat().st_size)
        self.st.lint()
        self.st.canon()
        self.assertEqual(before, (db.stat().st_mtime_ns, db.stat().st_size))            # и теперь лишь читаем

    def test_rejected_and_vanished_proposals(self):
        self.st.fact_set("risk", "high", "t1")
        self.st.fact_promote("risk", apply=True)
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        con.execute("UPDATE objects SET status='rejected' WHERE id='LF-risk-v1'")
        con.commit()
        self.assertIn(("proposal-rejected", "LF-risk-v1"), self.codes())
        con.execute("DELETE FROM objects WHERE id='LF-risk-v1'")
        con.commit()
        con.close()
        self.assertIn(("proposal-missing", "LF-risk-v1"), self.codes())

    def test_text_is_compact_and_reaches_handoff_and_mcp(self):
        out = cards.call_tool(self.st, "lint", {})
        self.assertTrue(out.startswith("LINT "), out)
        self.assertIn("canon-condition D001", out)
        self.assertIn("LINT:", self.st.handoff())
        many = [dict(level="warn", code="note-source-drift", subject=f"n{i:03d}", message="x") for i in range(30)]
        txt = cards.Store.lint_text(many)
        self.assertIn("and 27 more", txt)
        self.assertLessEqual(txt.count("\n"), 5)
        self.assertIn("nothing to flag", cards.Store.lint_text([]))

    def test_no_desk_no_findings_on_empty_store(self):
        self.st.project["pm_dir"] = str(self.t / "nowhere")
        self.assertEqual(self.st.lint(), [])
        self.assertNotIn("LINT:", self.st.handoff())

    def test_log_merges_desk_events(self):
        self.st.fact_set("k", "v", "s")
        self.st.fact_promote("k", apply=True, accept=True)
        out = self.st.log(n=500)
        self.assertIn("] fact | k |", out)
        self.assertIn("] promote | LF-k-v1 |", out)
        self.assertIn("] desk:ACCEPT | LF-k-v1 |", out)
        self.assertNotIn("desk:", self.st.log(n=500, desk=False))

    def test_cli_lint_exit_code_and_note_source_flag(self):
        db = self.t / "cli.sqlite"
        chat = self.t / "chat.md"
        chat.write_text(make_chat(NOTE_PAIRS), encoding="utf-8")
        run = lambda *a: subprocess.run([sys.executable, str(Path(cards.__file__)), "--db", str(db), "--config", str(self.t / "none.json"), *a],  # noqa: E731
                                        capture_output=True, text=True, timeout=60)
        self.assertEqual(run("index-chat", str(chat)).returncode, 0)
        r = run("note", "Заголовок", "текст", "--source", "t001:13-14:открытая вики")
        self.assertIn("OK n001", r.stdout + r.stderr)
        self.assertEqual(run("lint").returncode, 0)
        chat.write_text(make_chat([("коротко", "да")]), encoding="utf-8")
        run("index-chat", str(chat))
        r = run("lint")
        self.assertEqual(r.returncode, 1)                                                    # есть ошибка: источник пропал
        self.assertIn("note-source-missing", r.stdout)


if __name__ == "__main__":
    unittest.main()

"""Тесты картотеки. Без сети и без ключей: python3 -m unittest engine/cards/test_cards.py -v"""
from __future__ import annotations

import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
            self.assertIn("k = v", lines[2]["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()

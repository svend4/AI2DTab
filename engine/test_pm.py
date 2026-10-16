"""Тесты стола (pm.py): глагол SUPERSEDE (замена принятого, защита от опечатки, откат UNDO) и его соседи. Без сети; настоящая база стола не
трогается: каждый тест строит свой стол во временной папке.

    python3 -m unittest engine/test_pm.py -v
    PM_UNDER_TEST=/путь/к/копии/pm.py python3 -m unittest engine/test_pm.py     # проверить копию (рядом должны лежать schema.sql и seed.sql)
"""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PM_SRC = Path(os.environ.get("PM_UNDER_TEST") or Path(__file__).resolve().parent / "pm.py").resolve()


class Desk(unittest.TestCase):
    """Стол из семени (seed.sql) во временной папке."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        for n in ("pm.py", "schema.sql", "seed.sql"):
            shutil.copy(PM_SRC.parent / n if n != "pm.py" else PM_SRC, self.dir / n)
        self.run_pm("init", plain=True)

    def tearDown(self):
        self.tmp.cleanup()

    # --- помощники
    def run_pm(self, *args, plain=False):
        argv = [sys.executable, str(self.dir / "pm.py")] + ([a for a in args] if plain else ["exec", *args])
        return subprocess.run(argv, cwd=self.dir, capture_output=True, text=True, encoding="utf-8", timeout=60)

    def out(self, *args):
        r = self.run_pm(*args)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def add(self, oid, typ="decision", status="raw", title=None, cluster="A"):
        r = subprocess.run([sys.executable, str(self.dir / "pm.py"), "add", "--id", oid, "--cluster", cluster, "--layer", "1", "--type", typ,
                            "--title", title or f"объект {oid}", "--status", status, "--body", "тест"],
                           cwd=self.dir, capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def plain(self, *args):
        """Верхнеуровневые команды pm.py (check, status…), без «exec»."""
        return subprocess.run([sys.executable, str(self.dir / "pm.py"), *args], cwd=self.dir, capture_output=True, text=True,
                              encoding="utf-8", timeout=60)

    def db(self):
        con = sqlite3.connect(self.dir / "project-store.sqlite")
        con.row_factory = sqlite3.Row
        return con

    def status(self, oid):
        con = self.db()
        try:
            r = con.execute("SELECT status FROM objects WHERE id=?", (oid,)).fetchone()
            return r["status"] if r else None
        finally:
            con.close()

    def snapshot(self):
        """Всё, что может изменить SUPERSEDE: статусы объектов, связи, число событий."""
        con = self.db()
        try:
            return ([tuple(r) for r in con.execute("SELECT id, status FROM objects ORDER BY id")],
                    [tuple(r) for r in con.execute("SELECT from_id, to_id, rel FROM links ORDER BY 1,2,3")],
                    con.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        finally:
            con.close()

    def links(self, rel="supersedes"):
        con = self.db()
        try:
            return [tuple(r) for r in con.execute("SELECT from_id, to_id, note FROM links WHERE rel=? ORDER BY 1,2", (rel,))]
        finally:
            con.close()

    def events(self, action):
        con = self.db()
        try:
            return [tuple(r) for r in con.execute("SELECT object_id, detail FROM events WHERE action=? ORDER BY id", (action,))]
        finally:
            con.close()


NEWER = "датой выплаты считать 01.03.2027"       # заменитель для D001 («датой выплаты считать 01.01.2027»): тот же тип, общие слова


class Supersede(Desk):
    def test_replace_canon_by_raw_accepts_new_and_retires_old(self):
        self.assertEqual(self.status("D001"), "canon")
        self.add("D001B", title=NEWER)
        out = self.out("SUPERSEDE", "D001", "BY", "D001B", "пришло", "письмо", "Минтруда")
        self.assertTrue(out.startswith("SUPERSEDE D001 by D001B; D001B принят"), out)
        self.assertIn("было:  D001  датой выплаты считать 01.01.2027", out)                 # заголовки обоих на виду: опечатку видно сразу
        self.assertIn(f"стало: D001B  {NEWER}", out)
        self.assertEqual((self.status("D001"), self.status("D001B")), ("superseded", "canon"))
        self.assertEqual(self.links(), [("D001B", "D001", "пришло письмо Минтруда")])      # новый -supersedes-> старый, причина в примечании
        self.assertEqual(self.events("SUPERSEDE"), [("D001", "by D001B: пришло письмо Минтруда")])
        self.assertEqual(self.events("ACCEPT")[-1][0], "D001B")                             # принятие нового записано отдельным событием
        canon = self.out("CANON")
        self.assertIn("D001B", canon)
        self.assertNotIn("D001\t", canon)                                                   # в каноне старого больше нет
        self.assertIn("D001", self.out("SET", "SUPERSEDED"))                                # а в множестве замещённых он есть
        self.assertIn("D001B -supersedes-> D001", self.out("PACKET", "D001"))               # цепочка видна обычным PACKET

    def test_two_argument_form_and_canon_by_canon(self):
        self.add("P1", typ="fact", status="canon", title="срок сдачи отчёта 10 марта")
        self.add("P2", typ="fact", status="canon", title="срок сдачи отчёта 15 марта")
        before_accepts = len(self.events("ACCEPT"))
        out = self.out("SUPERSEDE", "P1", "P2")                                              # BY можно опустить; оба уже канон
        self.assertEqual(out.splitlines()[0], "SUPERSEDE P1 by P2")
        self.assertEqual((self.status("P1"), self.status("P2")), ("superseded", "canon"))
        self.assertEqual(len(self.events("ACCEPT")), before_accepts)                         # P2 уже был каноном: лишнего ACCEPT нет

    def test_refusals_change_nothing(self):
        self.add("RAWOLD", status="raw")
        self.add("REJ", status="rejected")
        self.add("SESS", typ="session", status="raw")
        self.add("NEW1", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "NEW1")                                          # D001 заменён, NEW1 стал каноном
        cases = [
            (("SUPERSEDE", "RAWOLD", "BY", "NEW1"), "REFUSE RAWOLD status=raw"),            # заменяют только канон
            (("SUPERSEDE", "REJ", "BY", "NEW1"), "REFUSE REJ status=rejected"),
            (("SUPERSEDE", "D001", "BY", "D001"), "REFUSE D001: нельзя заменить самим собой"),
            (("SUPERSEDE", "D003", "BY", "REJ"), "REFUSE REJ status=rejected"),              # снятое заменителем быть не может
            (("SUPERSEDE", "D003", "BY", "SESS"), "REFUSE SESS type=session"),
            (("SUPERSEDE", "D003", "BY", "D001"), "REFUSE D001 status=superseded"),          # уже замещённое тоже
            (("SUPERSEDE", "D001", "BY", "F002"), "REFUSE D001 уже заменён объектом NEW1"),
        ]
        for args, expect in cases:
            snap = self.snapshot()
            out = self.out(*args)
            self.assertIn(expect, out, (args, out))
            self.assertTrue(out.startswith("REFUSE"), out)
            self.assertEqual(self.snapshot(), snap, f"{args} что-то изменил")

    def test_rerun_is_idempotent(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        snap = self.snapshot()
        out = self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.assertIn("skip D001 уже заменён объектом D001B", out)
        self.assertEqual(self.snapshot(), snap)

    def test_take_and_accept_cannot_bring_a_replaced_object_back(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.assertIn("REFUSE D001 superseded", self.out("TAKE", "D001"))
        self.assertIn("REFUSE D001 superseded", self.out("ACCEPT", "D001"))
        self.assertIn("REFUSE D001 superseded", self.out("TAKE", "SUPERSEDED"))              # и через множество
        self.out("REPAIR")
        self.assertEqual(self.status("D001"), "superseded")
        self.assertEqual(self.status("D001B"), "canon")

    def test_usage_and_unknown_ids(self):
        for args, text in ((("SUPERSEDE",), "SUPERSEDE старый_id"), (("SUPERSEDE", "D001"), "SUPERSEDE старый_id"),
                           (("SUPERSEDE", "D001", "BY"), "SUPERSEDE старый_id"), (("SUPERSEDE", "NOPE", "BY", "F001"), "нет NOPE"),
                           (("SUPERSEDE", "D001", "BY", "NOPE"), "нет NOPE"), (("SUPERSEDE", "NOPE", "UNDO"), "нет NOPE")):
            snap = self.snapshot()
            r = self.run_pm(*args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn(text, r.stderr, (args, r.stderr))
            self.assertEqual(self.snapshot(), snap)
        self.assertIn("UNDO", self.run_pm("SUPERSEDE").stderr)                               # справка называет и откат

    def test_check_flags_a_replaced_object_without_a_live_replacement(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.assertNotIn("заменён, но действующего заместителя нет", self.plain("check").stdout)
        con = self.db()
        con.execute("UPDATE objects SET status='superseded' WHERE id='F003'")               # заменён «руками», связи нет
        con.commit()
        con.close()
        r = self.plain("check")
        self.assertIn("F003 заменён, но действующего заместителя нет", r.stdout)
        self.assertNotIn("D001 заменён", r.stdout)

    def test_failure_in_the_middle_rolls_everything_back(self):
        self.add("D001B", title=NEWER)
        con = self.db()
        con.execute("CREATE TRIGGER boom BEFORE INSERT ON links WHEN NEW.rel='supersedes' BEGIN SELECT RAISE(ABORT, 'boom'); END")
        con.commit()
        con.close()
        snap = self.snapshot()
        r = self.run_pm("SUPERSEDE", "D001", "BY", "D001B")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("boom", r.stderr)
        self.assertEqual(self.snapshot(), snap)                                              # D001 всё ещё канон, D001B всё ещё raw, событий нет

    def test_status_and_instruments_know_the_new_status(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.assertIn("superseded", self.plain("status").stdout)
        self.assertIn("INSTR charge=", self.out("INSTR"))
        self.assertIn("SUPERSEDE", self.run_pm("NOPE").stderr)                               # новый глагол есть в алфавите


class SupersedeBatch(Desk):
    def test_batch_cannot_carry_a_replacement(self):
        """Сайт проверяет только первое слово строки, а BATCH исполняет всё после него: иначе SUPERSEDE прошёл бы мимо списка глаголов сайта."""
        self.add("D001B", title=NEWER)
        snap = self.snapshot()
        out = self.out("BATCH", "STATUS; SUPERSEDE D001 BY D001B; supersede D001 UNDO")
        self.assertEqual(out.count("skip SUPERSEDE in BATCH"), 2, out)
        self.assertEqual(self.snapshot()[:2], snap[:2])                                      # ни статусов, ни связей не тронуто
        self.assertIn("# STATUS", out)                                                      # соседние команды пакета работают как раньше


class SupersedeGuard(Desk):
    """Опечатка в id не должна молча снимать с канона постороннее решение."""

    def test_unrelated_pair_is_refused_and_wire_overrides_it(self):
        self.add("D001B", title=NEWER)
        snap = self.snapshot()
        out = self.out("SUPERSEDE", "D002", "BY", "D001B")                                   # D002 «ИИ не заменяет карьерные центры» — не про выплату
        self.assertTrue(out.startswith("REFUSE D001B не похож на замену D002"), out)
        self.assertIn("WIRE D001B D002 related", out)                                        # отказ сам подсказывает, как подтвердить намерение
        self.assertEqual(self.snapshot(), snap)
        self.out("WIRE", "D001B", "D002", "related")                                          # человек подтвердил связь
        out = self.out("SUPERSEDE", "D002", "BY", "D001B")
        self.assertTrue(out.startswith("SUPERSEDE D002 by D001B"), out)
        self.assertEqual((self.status("D002"), self.status("D001B")), ("superseded", "canon"))

    def test_a_different_type_needs_a_link(self):
        self.add("DIFFTYPE", typ="fact", title=NEWER)                                         # те же слова, но тип другой и связи нет
        out = self.out("SUPERSEDE", "D001", "BY", "DIFFTYPE")
        self.assertTrue(out.startswith("REFUSE DIFFTYPE не похож на замену D001"), out)
        # связь любого рода снимает вопрос: в семени уже есть D001 -cites-> F002, а тип у F002 другой (decision → fact)
        out = self.out("SUPERSEDE", "D001", "BY", "F002")
        self.assertTrue(out.startswith("SUPERSEDE D001 by F002 (тип decision → fact)"), out)

    def test_wire_in_either_direction_counts(self):
        self.add("W1", typ="fact", title="совсем другое")
        self.out("WIRE", "D001", "W1", "related")                                             # старый → новый
        out = self.out("SUPERSEDE", "D001", "BY", "W1")
        self.assertTrue(out.startswith("SUPERSEDE D001 by W1"), out)


class SupersedeUndo(Desk):
    def replace_d001(self):
        self.add("D001B", title=NEWER)
        return self.out("SUPERSEDE", "D001", "BY", "D001B", "письмо")

    def test_undo_restores_the_old_and_returns_the_accepted_replacement(self):
        self.replace_d001()
        out = self.out("SUPERSEDE", "D001", "UNDO", "письмо", "оказалось", "черновиком")
        self.assertTrue(out.startswith("UNSUPERSEDE D001: снова canon; D001B → raw"), out)
        self.assertIn("вернулось: D001  датой выплаты считать 01.01.2027", out)
        self.assertIn(f"ушло:      D001B  {NEWER}", out)
        self.assertEqual((self.status("D001"), self.status("D001B")), ("canon", "raw"))
        self.assertEqual(self.links(), [])                                                    # связь снята
        self.assertEqual(self.events("UNSUPERSEDE"), [("D001", "by D001B; D001B → raw: письмо оказалось черновиком")])
        self.assertEqual(self.events("SUPERSEDE")[0][0], "D001")                              # журнал ничего не стирает: прежняя запись на месте
        canon = self.out("CANON")
        self.assertIn("D001\t", canon)
        self.assertNotIn("D001B", canon)
        self.assertNotIn("заменён, но", self.plain("check").stdout)

    def test_undo_keeps_a_replacement_that_was_canon_before(self):
        self.add("P1", typ="fact", status="canon", title="срок сдачи отчёта 10 марта")
        self.add("P2", typ="fact", status="canon", title="срок сдачи отчёта 15 марта")
        self.out("SUPERSEDE", "P1", "P2")
        out = self.out("SUPERSEDE", "P1", "UNDO")
        self.assertTrue(out.startswith("UNSUPERSEDE P1: снова canon; P2 остаётся как был (canon)"), out)
        self.assertEqual((self.status("P1"), self.status("P2")), ("canon", "canon"))          # принимать P2 замена не принимала — и не снимает

    def test_undo_does_not_demote_a_replacement_accepted_by_hand_in_between(self):
        self.replace_d001()
        self.out("SUPERSEDE", "D001", "UNDO")                                                 # D001B снова raw
        self.out("ACCEPT", "D001B")                                                           # человек принял его сам
        self.out("SUPERSEDE", "D001", "BY", "D001B")                                          # заместитель уже канон: принимать нечего
        self.out("SUPERSEDE", "D001", "UNDO")
        self.assertEqual((self.status("D001"), self.status("D001B")), ("canon", "canon"))     # принятое вручную откат не снимает

    def test_undo_goes_from_the_end_of_a_chain(self):
        self.replace_d001()
        self.add("D001C", title="датой выплаты считать 01.04.2027")
        self.out("SUPERSEDE", "D001B", "BY", "D001C")
        self.assertEqual([self.status(x) for x in ("D001", "D001B", "D001C")], ["superseded", "superseded", "canon"])
        snap = self.snapshot()
        out = self.out("SUPERSEDE", "D001", "UNDO")                                           # середину цепочки не вынуть
        self.assertTrue(out.startswith("REFUSE D001: его заместитель D001B сам заменён, сначала SUPERSEDE D001B UNDO"), out)
        self.assertEqual(self.snapshot(), snap)
        self.out("SUPERSEDE", "D001B", "UNDO")
        self.assertEqual([self.status(x) for x in ("D001", "D001B", "D001C")], ["superseded", "canon", "raw"])
        self.out("SUPERSEDE", "D001", "UNDO")
        self.assertEqual([self.status(x) for x in ("D001", "D001B", "D001C")], ["canon", "raw", "raw"])
        self.assertEqual(self.links(), [])

    def test_undo_refusals_and_repeat_change_nothing(self):
        self.add("RAW1")
        self.replace_d001()
        con = self.db()
        con.execute("UPDATE objects SET status='superseded' WHERE id='F003'")                 # заменён «руками», связи supersedes нет
        con.commit()
        con.close()
        self.out("SUPERSEDE", "D001", "UNDO")
        for args, expect in ((("SUPERSEDE", "D001", "UNDO"), "skip D001 не заменён"),        # повтор — не ошибка и не действие
                             (("SUPERSEDE", "D002", "UNDO"), "skip D002 не заменён"),
                             (("SUPERSEDE", "RAW1", "UNDO"), "REFUSE RAW1 status=raw"),
                             (("SUPERSEDE", "F003", "UNDO"), "REFUSE F003 помечен замещённым, но связи supersedes нет")):
            snap = self.snapshot()
            out = self.out(*args)
            self.assertIn(expect, out, (args, out))
            self.assertEqual(self.snapshot(), snap, f"{args} что-то изменил")

    def test_undo_failure_in_the_middle_rolls_everything_back(self):
        self.replace_d001()
        con = self.db()
        con.execute("CREATE TRIGGER boom BEFORE DELETE ON links BEGIN SELECT RAISE(ABORT, 'boom'); END")
        con.commit()
        con.close()
        snap = self.snapshot()
        r = self.run_pm("SUPERSEDE", "D001", "UNDO")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("boom", r.stderr)
        self.assertEqual(self.snapshot(), snap)                                               # D001 всё ещё замещён, D001B всё ещё канон

    def test_replace_again_after_undo_works(self):
        self.replace_d001()
        self.out("SUPERSEDE", "D001", "UNDO")
        out = self.out("SUPERSEDE", "D001", "BY", "D001B", "всё-таки")
        self.assertTrue(out.startswith("SUPERSEDE D001 by D001B; D001B принят"), out)
        self.assertEqual(self.links(), [("D001B", "D001", "всё-таки")])


class RepeatsAreQuiet(Desk):
    """Повтор команды не множит записи (FETCH) и не растит журнал отказов (ACCEPT по замещённому и по session/tape)."""

    def fetch_ids(self):
        con = self.db()
        try:
            return [r["id"] for r in con.execute("SELECT id FROM objects WHERE id LIKE 'Q-FETCH-%' ORDER BY id")]
        finally:
            con.close()

    def refusals(self, oid):
        return [detail for obj, detail in self.events("REFUSE") if obj == oid]

    def test_fetch_twice_keeps_one_open_question(self):
        first, second = self.out("FETCH"), self.out("FETCH")
        self.assertEqual(first.strip(), "FETCH Q-FETCH-001")
        self.assertTrue(second.startswith("skip FETCH Q-FETCH-001"), second)
        self.assertEqual(self.fetch_ids(), ["Q-FETCH-001"])
        self.assertEqual(len(self.events("FETCH")), 1)                           # пропуск ничего не пишет в журнал

    def test_fetch_back_to_back_never_crashes(self):
        for _ in range(5):
            self.out("FETCH")                                                    # self.out проверяет код 0; раньше второй вызов в ту же секунду падал на PRIMARY KEY
        self.assertEqual(self.fetch_ids(), ["Q-FETCH-001"])

    def test_a_taken_or_closed_question_does_not_block_a_new_one(self):
        self.out("FETCH")
        self.out("TAKE", "Q-FETCH-001")                                          # человек снял вопрос
        self.assertTrue(self.out("FETCH").startswith("FETCH Q-FETCH-002"))
        con = self.db()
        con.execute("UPDATE objects SET status='closed' WHERE id='Q-FETCH-002'")
        con.commit()
        con.close()
        self.assertTrue(self.out("FETCH").startswith("FETCH Q-FETCH-003"))
        self.assertEqual(self.fetch_ids(), ["Q-FETCH-001", "Q-FETCH-002", "Q-FETCH-003"])

    def test_an_old_clock_numbered_question_counts_as_the_open_one(self):
        con = self.db()
        con.execute("INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
                    "VALUES ('Q-FETCH-193145','C',2,'question','чего нет в каноне?','raw','старый','x','x','machine:exec')")
        con.commit()
        con.close()
        self.assertTrue(self.out("FETCH").startswith("skip FETCH Q-FETCH-193145"))
        self.assertEqual(self.fetch_ids(), ["Q-FETCH-193145"])

    def test_fetch_inside_batch_is_quiet_too(self):
        self.out("BATCH", "FETCH; FETCH; FETCH")
        self.assertEqual(self.fetch_ids(), ["Q-FETCH-001"])

    def test_repeated_accept_of_a_replaced_object_logs_one_refusal(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        answers = [self.out("ACCEPT", "D001") for _ in range(3)]
        self.assertEqual(len(set(answers)), 1)                                   # человеку отвечаем каждый раз одинаково
        self.assertIn("REFUSE D001 superseded", answers[0])
        self.assertEqual(self.refusals("D001"), ["superseded"])

    def test_repeated_accept_of_a_session_object_logs_one_refusal(self):
        for _ in range(3):
            self.assertIn("REFUSE S001 type=session", self.out("ACCEPT", "S001"))
        self.assertEqual(self.refusals("S001"), ["session"])

    def test_a_refusal_is_logged_again_when_something_else_happened_in_between(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.out("ACCEPT", "D001")                                               # отказ №1
        self.out("SUPERSEDE", "D001", "UNDO")
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        self.out("ACCEPT", "D001")                                               # отказ №2: между ними у объекта были другие события
        self.assertEqual(self.refusals("D001"), ["superseded", "superseded"])

    def test_refusals_of_different_objects_do_not_hide_each_other(self):
        self.add("D001B", title=NEWER)
        self.out("SUPERSEDE", "D001", "BY", "D001B")
        for oid in ("D001", "S001", "D001", "S001"):
            self.out("ACCEPT", oid)
        self.assertEqual((self.refusals("D001"), self.refusals("S001")), (["superseded"], ["session"]))


SITE_TABLE = Path(__file__).resolve().parent.parent / "src" / "lib" / "pm-request.ts"


def site_text() -> str:
    return SITE_TABLE.read_text(encoding="utf-8")


def site_verbs() -> dict:
    """Таблица глаголов сайта из src/lib/pm-request.ts: {глагол: (класс, правило)}. Таблица записана по строке на глагол именно ради этого теста."""
    block = site_text().split("export const VERBS", 1)[1].split("\n};", 1)[0]
    return {m.group(1): (m.group(2), m.group(3)) for m in re.finditer(r'^\s+([A-Z]+): \{ kind: "(read|write|bulk)", rule: "(\w+)" \},$', block, re.M)}


def load_engine():
    spec = importlib.util.spec_from_file_location("pm_for_the_site_table", PM_SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SetExpressions(Desk):
    """AUD-01: цепочки «A \\ B \\ C» читаются слева направо, неизвестное имя — ошибка, а не пустое множество."""

    def setUp(self):
        super().setUp()
        # id, тип, статус, кластер: так выражения различают скобки слева и справа
        for oid, typ, status, cl in [
            ("X1", "observation", "raw", "A"), ("X2", "decision", "raw", "A"), ("X3", "observation", "raw", "B"),
            ("X4", "decision", "raw", "B"), ("X5", "observation", "raw", "C"), ("X6", "observation", "canon", "A"),
            ("ORG1", "observation", "raw", "D"), ("BRAND2", "decision", "raw", "D"),
        ]:
            self.add(oid, typ=typ, status=status, cluster=cl)

    # --- помощники: множества считаем напрямую из базы, не через pm.py
    def ids(self, where):
        con = self.db()
        try:
            return {r["id"] for r in con.execute(f"SELECT id FROM objects WHERE {where}")}
        finally:
            con.close()

    def sets(self):
        return {
            "RAW": self.ids("status='raw'"), "CANON": self.ids("status='canon'"), "OBS": self.ids("type='observation'"),
            "A": self.ids("cluster='A'"), "B": self.ids("cluster='B'"), "C": self.ids("cluster='C'"), "D": self.ids("cluster='D'"),
        }

    def shown(self, expr):
        """Что печатает SET: (первая строка, множество id)."""
        out = self.out("SET", expr)
        lines = out.strip().splitlines()
        return lines[0], {ln.split("\t")[0] for ln in lines[1:]}

    def state(self):
        con = self.db()
        try:
            return ([tuple(r) for r in con.execute("SELECT id, status FROM objects ORDER BY id")],
                    con.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        finally:
            con.close()

    def test_a_chain_is_read_left_to_right(self):
        S = self.sets()
        cases = [
            ("RAW \\ A \\ OBS", (S["RAW"] - S["A"]) - S["OBS"], S["RAW"] - (S["A"] - S["OBS"])),
            ("RAW ∩ A ∩ OBS", (S["RAW"] & S["A"]) & S["OBS"], None),
            ("RAW ∪ CANON \\ A", (S["RAW"] | S["CANON"]) - S["A"], S["RAW"] | (S["CANON"] - S["A"])),
            ("A ∪ B ∩ OBS", (S["A"] | S["B"]) & S["OBS"], S["A"] | (S["B"] & S["OBS"])),
            ("RAW MINUS A AND OBS", (S["RAW"] - S["A"]) & S["OBS"], S["RAW"] - (S["A"] & S["OBS"])),
            ("RAW\\A\\OBS", (S["RAW"] - S["A"]) - S["OBS"], None),
            ("raw | canon & obs", (S["RAW"] | S["CANON"]) & S["OBS"], S["RAW"] | (S["CANON"] & S["OBS"])),
        ]
        for expr, want, right_to_left in cases:
            _, got = self.shown(expr)
            self.assertEqual(got, want, expr)
            self.assertTrue(want, f"{expr}: пустой ответ ничего не проверяет")
            if right_to_left is not None:
                self.assertNotEqual(want, right_to_left, f"{expr}: данные не различают порядок")

    def test_the_number_in_the_first_line_is_the_size_of_the_set(self):
        S = self.sets()
        head, got = self.shown("RAW \\ A \\ OBS")
        self.assertEqual(head, f"SET RAW \\ A \\ OBS → {len((S['RAW'] - S['A']) - S['OBS'])}")

    def test_operator_words_are_only_words(self):
        """Идентификаторы с OR и AND внутри не режутся на части."""
        self.assertEqual(self.shown("ORG1")[1], {"ORG1"})
        self.assertEqual(self.shown("BRAND2")[1], {"BRAND2"})
        self.assertEqual(self.shown("ORG1 ∪ BRAND2")[1], {"ORG1", "BRAND2"})
        self.assertEqual(self.shown("RAW AND ORG1")[1], {"ORG1"})
        self.assertEqual(self.shown("BRAND2 OR ORG1")[1], {"ORG1", "BRAND2"})

    def test_an_unknown_operand_is_an_error_and_nothing_changes(self):
        for expr in ["NEQQ", "RAW \\ NEQQ", "NOPE ∩ RAW", "RAW ∩ A ∩ NOPE", "RAW MINUS NOPE", "RAW SESSION"]:
            before = self.state()
            r = self.run_pm("SET", expr)
            self.assertNotEqual(r.returncode, 0, expr)
            self.assertIn("нет множества или объекта", r.stderr, expr)
            self.assertEqual(self.state(), before, expr)

    def test_a_typo_does_not_widen_a_destructive_command(self):
        """Раньше «TAKE RAW \\ NEQQ» отклоняло всё сырьё: опечатка в правой части давала пустое множество."""
        for line in [("TAKE", "RAW", "\\", "NEQQ"), ("TAKE", "RAW", "\\", "A", "\\", "NOPE"), ("ACCEPT", "RAW", "∩", "NOPE"),
                     ("TAKE", "NOPE", "∪", "RAW")]:
            before = self.state()
            r = self.run_pm(*line)
            self.assertNotEqual(r.returncode, 0, line)
            self.assertEqual(self.state(), before, line)

    def test_a_missing_operand_is_an_error(self):
        for expr in ["RAW \\", "\\ RAW", "RAW ∩ ∩ A", "AND RAW", "RAW OR"]:
            r = self.run_pm("SET", expr)
            self.assertNotEqual(r.returncode, 0, repr(expr))
            self.assertIn("пропущен операнд", r.stderr, expr)

    def test_an_empty_expression_is_an_error(self):
        for args in [(), ("",), ("   ",)]:
            r = self.run_pm("SET", *args)
            self.assertNotEqual(r.returncode, 0, repr(args))
            self.assertIn("пустое выражение", r.stderr, repr(args))

    def test_ids_are_operands_and_a_known_empty_set_is_fine(self):
        self.assertEqual(self.shown("X1 ∪ X3")[1], {"X1", "X3"})
        self.assertEqual(self.shown("X1 ∪ X3 \\ X1")[1], {"X3"})
        head, got = self.shown("SUPERSEDED")
        self.assertEqual(got, self.ids("status='superseded'"))
        self.assertEqual(self.shown("RAW ∩ SUPERSEDED")[1], set())

    def test_word_operators_are_capitals_only_as_before(self):
        r = self.run_pm("SET", "raw and canon")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("нет множества или объекта raw and canon", r.stderr)

    def test_the_cell_sign_and_its_aliases_name_a_set_even_when_it_is_empty(self):
        for name in ["≠", "NEQ", "ne", "neq"]:
            head, _ = self.shown(name)
            self.assertTrue(head.startswith(f"SET {name} → "), head)

    def test_rows_come_out_sorted_by_id(self):
        out = self.out("SET", "RAW ∪ CANON").strip().splitlines()[1:]
        ids = [ln.split("\t")[0] for ln in out]
        self.assertEqual(ids, sorted(ids))
        self.assertGreater(len(ids), 3)

    def test_the_printed_name_is_the_one_typed_with_operators_in_symbols(self):
        S = self.sets()
        self.assertEqual(self.shown("RAW MINUS A")[0], f"SET RAW \\ A → {len(S['RAW'] - S['A'])}")
        self.assertEqual(self.shown("RAW∩A")[0], f"SET RAW ∩ A → {len(S['RAW'] & S['A'])}")
        self.assertEqual(self.shown("raw")[0], f"SET raw → {len(S['RAW'])}")

    def test_take_uses_the_same_evaluation(self):
        S = self.sets()
        target = (S["RAW"] & S["A"]) & S["OBS"]                       # X1
        before = dict(self.state()[0])
        r = self.run_pm("--ids", ",".join(sorted(target)), "TAKE", "RAW", "∩", "A", "∩", "OBS")   # RAW и OBS — массовые: со списком
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("REFUSE", r.stdout)
        after = dict(self.state()[0])
        for oid, status in after.items():
            self.assertEqual(status, "rejected" if oid in target else before[oid], oid)
        self.assertTrue(target)


@unittest.skipUnless(SITE_TABLE.exists(), "нет src/lib/pm-request.ts")
class SiteVerbTable(Desk):
    """Таблица глаголов сайта (какие глаголы доступны без входа) против настоящего pm.py: у чтения нет побочных эффектов, лишних глаголов нет."""
    EXAMPLE = {
        "STATUS": "STATUS", "LOOK": "LOOK enbek", "DUMP": "DUMP", "GRID": "GRID", "MATRIX": "MATRIX", "DIFF": "DIFF", "JSON": "JSON", "CANON": "CANON",
        "RAW": "RAW", "NEQ": "NEQ", "CELL": "CELL", "SET": "SET RAW \\ NEQ", "IDS": "IDS RAW", "VOCAB": "VOCAB A", "PACKET": "PACKET", "CONC": "CONC", "CONCORD": "CONCORD x",
        "INSTR": "INSTR", "GAUGE": "GAUGE", "PANEL": "PANEL", "PORT": "PORT C A", "CAT": "CAT LANG-FROM-DB.md",
        "PLANT": "PLANT проверка", "CUT": "CUT проверка", "ACCEPT": "ACCEPT F001", "TAKE": "TAKE F001", "RUN": "RUN F001", "FETCH": "FETCH",
        "WIRE": "WIRE F001 D101 constrains", "PROBE": "PROBE C A", "FILL": "FILL", "SWEEP": "SWEEP", "PURGE": "PURGE", "REPAIR": "REPAIR",
        "GAP": "GAP", "SETTLE": "SETTLE", "SPEC": "SPEC", "BATCH": "BATCH STATUS; RAW",
    }
    ALIASES = {"CONCORD": "CONC", "GAUGE": "INSTR", "PANEL": "INSTR"}      # псевдонимы: движок разбирает их тем же кодом, в списках стоит основной глагол

    def setUp(self):
        super().setUp()
        self.table = site_verbs()
        self.engine = load_engine()

    def dump(self):
        con = self.db()
        try:
            return {t: [tuple(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3")] for t in ("objects", "links", "origins", "events", "packets")}
        finally:
            con.close()

    def test_the_table_was_read_in_full(self):
        self.assertGreaterEqual(len(self.table), 35)
        self.assertEqual(set(self.table), set(self.EXAMPLE))                      # у каждого глагола сайта есть пример, у каждого примера — глагол

    def test_every_verb_of_the_site_is_a_verb_of_the_engine(self):
        for verb, line in self.EXAMPLE.items():
            r = self.run_pm(*line.split())
            self.assertNotIn("unknown", r.stderr + r.stdout, f"{verb}: движок не знает глагола")

    def test_read_verbs_do_not_change_the_database(self):
        self.out("STATUS")                                                       # первый запуск может один раз домигрировать ячейки: снимок после него
        for verb, (kind, _) in self.table.items():
            if kind != "read":
                continue
            before = self.dump()
            self.run_pm(*self.EXAMPLE[verb].split())
            self.assertEqual(self.dump(), before, f"глагол чтения {verb} изменил базу")

    def test_a_verb_that_writes_is_not_listed_as_a_read(self):
        reads = set(self.engine.READS) | {"CAT"}                                 # CAT читает два файла и не пишет в журнал вовсе, поэтому в READS его нет
        for verb, (kind, _) in self.table.items():
            if kind == "read":
                self.assertIn(self.ALIASES.get(verb, verb), reads, f"{verb} отмечен чтением, а движок так не считает")
            else:
                self.assertNotIn(self.ALIASES.get(verb, verb), reads, f"{verb} отмечен записью, а движок считает его чтением")

    def test_the_site_and_the_engine_agree_on_which_verbs_exist(self):
        """Новый глагол в pm.py не попадёт на сайт сам: сначала решение, чтение это или запись, и строка в таблице."""
        self.assertEqual(set(self.engine.VERBS) - set(self.table), {"SUPERSEDE"})   # замену принятого ставит человек в CLI
        self.assertEqual(set(self.engine.READS) - set(self.table), {"RANGE"})
        self.assertEqual(set(self.table) - set(self.engine.VERBS), set(self.ALIASES))

    def test_the_names_of_the_sets_are_the_engines(self):
        text = site_text().split("const SET_NAMES = new Set([", 1)[1].split("]);", 1)[0]
        self.assertEqual(set(re.findall(r'"([A-Z]+)"', text)), set(self.engine.SET_NAMES))

    def test_set_expressions_are_recognised_as_the_engine_does(self):
        yes = ["RAW", "raw", "NEQ", "≠", "ne", "A", "d", "CANON", "SUPERSEDED", "SESSION", "OBS", "observation", "JUNK", "RAW \\ NEQ", "A∩B", "x|y", "x&y", "a ∪ b"]
        no = ["F001", "ont-S17320", "LF-x-v1", "", "  ", "E", "RAWS", "Q-GAP-JUNK"]
        for arg in yes:
            self.assertTrue(self.engine.is_set_expr(arg), arg)
        for arg in no:
            self.assertFalse(self.engine.is_set_expr(arg), arg)


class ActorOfEvents(Desk):
    """AUD-15 (план, шаг 7): кто принял. Сайт передаёт `--actor web:<id>` сразу после `exec`; без флага пишет `machine:exec`."""

    def setUp(self):
        super().setUp()
        self.add("A1", typ="observation", status="raw", cluster="A")
        self.add("A2", typ="observation", status="raw", cluster="A")
        self.add("A3", typ="observation", status="raw", cluster="B")

    def actors(self, action):
        con = self.db()
        try:
            return [r[0] for r in con.execute("SELECT actor FROM events WHERE action=? ORDER BY id", (action,))]
        finally:
            con.close()

    def state(self):
        con = self.db()
        try:
            objs = tuple(con.execute("SELECT id, status FROM objects ORDER BY id"))
            return objs, con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        finally:
            con.close()

    def test_terminal_without_the_flag_still_writes_machine_exec(self):
        self.out("ACCEPT", "A1")
        self.assertEqual(self.actors("ACCEPT")[-1], "machine:exec")

    def test_the_site_actor_is_written_with_the_event(self):
        r = self.run_pm("--actor", "web:user-1", "ACCEPT", "A1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.actors("ACCEPT")[-1], "web:user-1")

    def test_the_actor_reaches_the_commands_run_inside_batch(self):
        r = self.run_pm("--actor", "web:user-1", "BATCH", "ACCEPT", "A2", ";", "TAKE", "A3")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.actors("ACCEPT")[-1], "web:user-1")
        self.assertEqual(self.actors("TAKE")[-1], "web:user-1")

    def test_a_malformed_actor_is_refused_before_anything_is_written(self):
        before = self.state()
        for bad in ["", "a b", "a;b", "x" * 81, "tab\tname", "кириллица"]:
            r = self.run_pm("--actor", bad, "ACCEPT", "A1")
            self.assertNotEqual(r.returncode, 0, repr(bad))
            self.assertIn("актор", r.stderr, repr(bad))
            self.assertEqual(self.state(), before, repr(bad))
        r = self.run_pm("--actor", "-x", "ACCEPT", "A1")          # ведущий дефис argparse принимает за опцию
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.state(), before)

    def test_the_flag_must_come_before_the_words(self):
        before = self.state()
        r = self.run_pm("ACCEPT", "--actor", "web:user-1", "A1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.state(), before)

    def test_a_read_with_an_actor_writes_no_event(self):
        before = self.state()
        r = self.run_pm("--actor", "web:user-1", "SET", "A")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.state(), before)


class OwnerOfObjects(Desk):
    """AUD-15 (владелец): посадка и принятие пишут владельца из того же актора, что и журнал; ACCEPT только для понятий и для
    сырых, открытых и черновых объектов. Снятое, закрытое и служебные типы возвращаются только новым объектом."""

    def setUp(self):
        super().setUp()
        self.add("A1", typ="observation", status="raw", cluster="A")

    def field(self, oid, name):
        con = self.db()
        try:
            return con.execute(f"SELECT {name} FROM objects WHERE id=?", (oid,)).fetchone()[0]
        finally:
            con.close()

    def set_status(self, oid, status):
        con = self.db()
        try:
            con.execute("UPDATE objects SET status=? WHERE id=?", (status, oid))
            con.commit()
        finally:
            con.close()

    def test_accept_makes_the_verified_actor_the_owner(self):
        r = self.run_pm("--actor", "web:user-2", "ACCEPT", "A1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.field("A1", "owner"), "web:user-2")
        self.assertEqual(self.field("A1", "status"), "canon")

    def test_accept_without_flag_keeps_the_terminal_owner(self):
        self.out("ACCEPT", "A1")
        self.assertEqual(self.field("A1", "owner"), "machine:exec")

    def test_plant_makes_the_verified_actor_the_owner(self):
        tape = self.dir / "tape.txt"
        tape.write_text("Первый абзац ленты.\n\nВторой абзац ленты.\n", encoding="utf-8")
        r = self.run_pm("--actor", "web:user-3", "PLANT", "--file", str(tape))
        self.assertEqual(r.returncode, 0, r.stderr)
        planted = [line.split()[1] for line in r.stdout.splitlines() if line.startswith("plant ")]
        self.assertTrue(planted, r.stdout)
        for oid in planted:
            self.assertEqual(self.field(oid, "owner"), "web:user-3", oid)

    def test_only_concept_types_are_accepted(self):
        for i, typ in enumerate(["fact", "decision", "observation", "question", "artifact"]):
            oid = f"TY{i}"
            self.add(oid, typ=typ, status="raw", cluster="A")
            self.assertIn(f"ACCEPT {oid}", self.out("ACCEPT", oid), typ)
            self.assertEqual(self.field(oid, "status"), "canon", typ)
        for i, typ in enumerate(["task", "signal", "signpost", "packet", "session", "tape"]):
            oid = f"TN{i}"
            self.add(oid, typ=typ, status="raw", cluster="A")
            self.assertIn(f"REFUSE {oid} type={typ}", self.out("ACCEPT", oid), typ)
            self.assertEqual(self.field(oid, "status"), "raw", typ)

    def test_only_raw_open_and_draft_statuses_are_accepted(self):
        for i, status in enumerate(["raw", "open", "draft"]):
            oid = f"SA{i}"
            self.add(oid, typ="observation", status=status, cluster="A")
            self.assertIn(f"ACCEPT {oid}", self.out("ACCEPT", oid), status)
            self.assertEqual(self.field(oid, "status"), "canon", status)
        for i, status in enumerate(["rejected", "closed", "candidate", "dormant"]):
            oid = f"SR{i}"
            self.add(oid, typ="observation", status=status, cluster="A")
            self.assertIn(f"REFUSE {oid} status={status}", self.out("ACCEPT", oid), status)
            self.assertEqual(self.field(oid, "status"), status, status)


class BulkConfirm(Desk):
    """AUD-15 (массовые RAW и OBS): принять или снять можно только список id, который человек подтвердил. IDS печатает набор целиком."""

    def setUp(self):
        super().setUp()
        for i in range(1, 4):
            self.add(f"R{i}", typ="observation", status="raw", cluster="A")

    def ids(self, expr):
        return self.out("IDS", expr).split()

    def status_of(self, oid):
        con = self.db()
        try:
            return con.execute("SELECT status FROM objects WHERE id=?", (oid,)).fetchone()[0]
        finally:
            con.close()

    def test_ids_prints_the_whole_set_not_eighty_rows(self):
        con = self.db()
        try:
            for i in range(90):
                con.execute("INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?)", (f"BULK{i:03d}", "A", 2, "observation", "t", "raw", "", "x", "x", "machine:exec"))
            con.commit()
        finally:
            con.close()
        raw_ids = self.ids("RAW")
        self.assertEqual(len(raw_ids), len(set(raw_ids)))
        self.assertGreaterEqual(len(raw_ids), 90)
        self.assertIn("BULK089", raw_ids)

    def test_bulk_accept_is_refused_without_the_list(self):
        r = self.run_pm("ACCEPT", "RAW")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REFUSE ACCEPT RAW: нужно подтверждение", r.stdout)
        self.assertEqual(self.status_of("R1"), "raw")

    def test_bulk_accept_with_the_listed_ids_goes_through(self):
        ids = self.ids("RAW")
        r = self.run_pm("--ids", ",".join(ids), "ACCEPT", "RAW")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ACCEPT RAW → ok=", r.stdout)
        self.assertEqual(self.status_of("R1"), "canon")

    def test_list_that_differs_from_the_set_is_refused(self):
        ids = self.ids("RAW")
        for listed in (ids[:-1], ids + ["ZZ9"]):
            r = self.run_pm("--ids", ",".join(listed), "ACCEPT", "RAW")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("набор изменился", r.stdout)
            self.assertEqual(self.status_of("R1"), "raw")

    def test_take_and_obs_need_the_list_too(self):
        self.assertIn("нужно подтверждение", self.run_pm("TAKE", "RAW").stdout)
        self.assertIn("нужно подтверждение", self.run_pm("ACCEPT", "OBS").stdout)
        self.assertEqual(self.status_of("R1"), "raw")
        r = self.run_pm("--ids", ",".join(self.ids("RAW")), "TAKE", "RAW")
        self.assertIn("TAKE RAW", r.stdout)
        self.assertEqual(self.status_of("R1"), "rejected")

    def test_single_object_accept_needs_no_list(self):
        self.assertIn("ACCEPT R1", self.out("ACCEPT", "R1"))
        self.assertEqual(self.status_of("R1"), "canon")

    def test_the_list_is_checked_by_the_engine(self):
        r = self.run_pm("--ids", "плохой id", "ACCEPT", "R1")
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertEqual(self.status_of("R1"), "raw")


if __name__ == "__main__":
    unittest.main()

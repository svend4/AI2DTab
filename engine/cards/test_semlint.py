"""Тесты смыслового lint (semlint.py): отрывки, проверка цитат, находки с подставной «моделью». Без сети и без ключей:

    python3 -m unittest engine/cards/test_semlint.py -v
"""
from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cards  # noqa: E402
import semlint  # noqa: E402
from test_cards import ENGINE, make_chat, project_for  # noqa: E402

PAIRS = [
    ("что такое Gizmo", "## Gizmo\n\nGizmo описывается полями: alpha, beta, gamma.\nБюджет Gizmo — 50 тысяч.\n\n## Другое\n\nпро погоду"),
    ("а про погоду?", "Сегодня солнечно, о Gizmo речи нет… то есть нет, ни слова не будет."),
    ("вернёмся к Gizmo", "## Состав\n\nТеперь Gizmo состоит из полей: alpha, beta, delta, epsilon.\nБюджет Gizmo — 80 тысяч, а не 50."),
    ("и последнее", "Про Zork: Zork одинок, он упомянут один раз."),
]


def run(coro):
    return asyncio.run(coro)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        chat = self.t / "chat.md"
        chat.write_text(make_chat(PAIRS), encoding="utf-8")
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.t / "nodesk"))
        self.st.index_chat(str(chat))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def turn_ids(self):
        return [r["id"] for r in self.st.con.execute("SELECT id FROM cards WHERE kind='turn' ORDER BY id")]


class Gather(Fixture):
    def test_passages_follow_the_conversation_and_carry_card_and_lines(self):
        ps, info = semlint.gather(self.st, r"gizmo")
        self.assertEqual(info["cards"], 3)                                                  # реплика о погоде тоже упоминает слово
        self.assertEqual([p.card for p in ps], sorted(p.card for p in ps))                  # по порядку беседы
        self.assertTrue(all(1 <= p.l1 <= p.l2 for p in ps))
        first = ps[0]
        self.assertIn("Gizmo описывается полями: alpha, beta, gamma.", first.text())
        self.assertTrue(first.render().startswith(f"### {first.card} · "))
        self.assertIn(f"L{first.l1}-{first.l2}", first.render().split("\n")[0])

    def test_a_short_section_is_taken_whole_and_a_long_one_gives_a_window(self):
        ps, _ = semlint.gather(self.st, r"полей: alpha, beta, delta", window=0, section_max=10)
        self.assertIn("## Состав", ps[0].text())                                            # раздел «Состав» короткий — берём целиком
        self.assertIn("Бюджет Gizmo — 80 тысяч", ps[0].text())
        ps, _ = semlint.gather(self.st, r"полей: alpha, beta, delta", window=0, section_max=0)
        self.assertNotIn("Бюджет Gizmo — 80 тысяч", ps[0].text())                           # без разделов и окон — только строка с совпадением
        self.assertIn("alpha, beta, delta", ps[0].text())

    def test_overlapping_windows_merge_into_one_passage(self):
        ps, _ = semlint.gather(self.st, r"alpha|beta", window=3, section_max=0)
        by_card = {}
        for p in ps:
            by_card.setdefault(p.card, []).append(p)
        self.assertTrue(all(len(v) == 1 for v in by_card.values()))                          # два совпадения рядом — один кусок

    def test_budget_narrows_the_context_and_then_says_it_left_something_out(self):
        wide, i1 = semlint.gather(self.st, r"gizmo")
        tight, i2 = semlint.gather(self.st, r"gizmo", max_chars=i1["chars"] - 1)
        self.assertLessEqual(i2["chars"], i1["chars"] - 1)
        self.assertNotEqual(i1["mode"], i2["mode"])                                          # сузились, и об этом сказано
        self.assertEqual(i2["truncated"], 0)
        _, i3 = semlint.gather(self.st, r"gizmo", max_chars=30)
        self.assertGreater(i3["truncated"], 0)                                               # даже строки не лезут: часть отрывков не вошла, и это видно
        self.assertLessEqual(i3["passages"], 4)


class Locate(unittest.TestCase):
    LINES = ["# Заголовок", "**Gizmo** описывается «полями»: alpha,", "beta, gamma.", "", "конец"]

    def test_case_quotes_and_markup_do_not_matter(self):
        self.assertEqual(semlint.locate('gizmo описывается "полями": alpha,', self.LINES), (2, 2))

    def test_quote_may_span_up_to_three_lines(self):
        self.assertEqual(semlint.locate("описывается «полями»: alpha, beta, gamma.", self.LINES), (2, 3))

    def test_a_quote_that_occurs_in_several_places_is_counted(self):
        lines = ["Gizmo состоит из полей: alpha, beta.", "", "Повторяю: Gizmo состоит из полей: alpha, beta."]
        self.assertEqual(semlint.locate_all("Gizmo состоит из полей: alpha, beta", lines), [(1, 1), (3, 3)])
        self.assertEqual(semlint.locate("Gizmo состоит из полей: alpha, beta", lines), (1, 1))     # адрес — первое место, но их два
        self.assertEqual(semlint.locate_all("полей: alpha, beta.", lines), [(1, 1), (3, 3)])

    def test_missing_or_too_short_quotes_are_not_found(self):
        self.assertIsNone(semlint.locate("описывается полями: alpha, omega", self.LINES))
        self.assertIsNone(semlint.locate("alpha", self.LINES))                               # короче 12 знаков подтверждением не служит
        self.assertIsNone(semlint.locate("", self.LINES))


class VerifyChat(Fixture):
    def setUp(self):
        super().setUp()
        self.t1, self.t2, self.t3 = self.turn_ids()[:3]
        self.scope = [self.t1, self.t2, self.t3]

    def finding(self, kind="divergent", a=None, b=None):
        return dict(kind=kind, summary="поля разные", earlier=a or dict(card=self.t1, quote="Gizmo описывается полями: alpha, beta, gamma."),
                    later=b or dict(card=self.t3, quote="Gizmo состоит из полей: alpha, beta, delta, epsilon"))

    def test_grounded_finding_gets_line_numbers_and_chronological_order(self):
        ok, bad = semlint.verify_chat(self.st, [self.finding()], self.scope)
        self.assertEqual(bad, {})
        f = ok[0]
        self.assertEqual((f["a"]["card"], f["b"]["card"]), (self.t1, self.t3))
        self.assertTrue(f["a"]["l1"] >= 1 and f["b"]["l1"] >= 1)
        lines = semlint.card_lines(self.st, self.t3)
        self.assertIn("delta", lines[f["b"]["l1"] - 1])                                      # номер строки указывает на цитату
        swapped, _ = semlint.verify_chat(self.st, [self.finding(a=self.finding()["later"], b=self.finding()["earlier"])], self.scope)
        self.assertEqual((swapped[0]["a"]["card"], swapped[0]["b"]["card"]), (self.t1, self.t3))   # модель перепутала порядок — скрипт выправил

    def test_too_short_quote_is_not_a_confirmation(self):
        ok, bad = semlint.verify_chat(self.st, [self.finding(a=dict(card=self.t1, quote="Gizmo"))], self.scope)
        self.assertEqual((ok, dict(bad)), ([], {"quote not found": 1}))

    def test_ambiguous_quote_is_flagged_in_the_report(self):
        ok, _ = semlint.verify_chat(self.st, [self.finding()], self.scope)
        self.assertEqual((ok[0]["a"]["occurs"], ok[0]["b"]["occurs"]), (1, 1))                  # обе цитаты встречаются по разу
        self.assertNotIn("occurs", semlint.report(dict(mode="chat", term="Gizmo", info=dict(hit_lines=2, cards=2, passages=2, chars=10, mode="x", truncated=0),
                                                       asked=True, failed=False, rejected={}, findings=ok)))
        ok[0]["a"]["occurs"] = 3                                                              # а так выглядит отчёт, если место цитаты не единственное
        text = semlint.report(dict(mode="chat", term="Gizmo", info=dict(hit_lines=2, cards=2, passages=2, chars=10, mode="x", truncated=0),
                                   asked=True, failed=False, rejected={}, findings=ok))
        self.assertIn("the quote occurs 3 times in this card, the first is shown", text)

    def test_wrong_card_id_is_corrected_and_marked(self):
        f = self.finding(a=dict(card=self.t2, quote="Gizmo описывается полями: alpha, beta, gamma."))
        ok, bad = semlint.verify_chat(self.st, [f], self.scope)
        self.assertEqual(bad, {})
        self.assertEqual(ok[0]["a"]["card"], self.t1)
        self.assertTrue(ok[0]["a"]["relabeled"])
        self.assertFalse(ok[0]["b"]["relabeled"])

    def test_invented_quote_drops_the_finding_and_is_counted(self):
        f = self.finding(b=dict(card=self.t3, quote="Gizmo состоит из полей: alpha, beta, zeta, theta"))
        ok, bad = semlint.verify_chat(self.st, [f, self.finding()], self.scope)
        self.assertEqual(len(ok), 1)
        self.assertEqual(bad, {"quote not found": 1})

    def test_other_rejections(self):
        same = self.finding(b=self.finding()["earlier"])
        bad_kind = self.finding(kind="opinion")
        dup = self.finding()
        ok, bad = semlint.verify_chat(self.st, [None, same, bad_kind, dup, dup], self.scope)
        self.assertEqual(len(ok), 1)
        self.assertEqual(dict(bad), {"malformed": 1, "same place": 1, "bad kind": 1, "duplicate": 1})

    def test_parse_findings_tolerates_garbage(self):
        self.assertEqual(semlint.parse_findings(None), [])
        self.assertEqual(semlint.parse_findings({"findings": "нет"}), [])
        out = semlint.parse_findings({"findings": [self.finding(), "строка", {"kind": "conflict", "earlier": 1, "later": {}}]})
        self.assertEqual((out[0] is not None, out[1], out[2]), (True, None, None))


class LintConcept(Fixture):
    def ask_for(self, **fixed):
        t = self.turn_ids()
        calls = []

        async def judge(prompt):
            calls.append(prompt)
            return {"findings": [
                dict(kind="conflict", summary="бюджет 50 или 80", earlier=dict(card=t[0], quote="Бюджет Gizmo — 50 тысяч."),
                     later=dict(card=t[2], quote="Бюджет Gizmo — 80 тысяч, а не 50.")),
                dict(kind="divergent", summary="состав полей", earlier=dict(card=t[0], quote="Gizmo описывается полями: alpha, beta, gamma."),
                     later=dict(card=t[2], quote="Gizmo состоит из полей: alpha, beta, delta, epsilon")),
                dict(kind="conflict", summary="выдумано", earlier=dict(card=t[0], quote="Gizmo стоит ровно миллион рублей"),
                     later=dict(card=t[2], quote="Бюджет Gizmo — 80 тысяч")),
            ]}
        return judge, calls

    def test_findings_are_verified_and_the_dropped_ones_counted(self):
        judge, calls = self.ask_for()
        r = run(semlint.lint_concept(self.st, "Gizmo", judge))
        self.assertEqual(len(calls), 1)
        self.assertIn('mention "Gizmo"', calls[0])
        self.assertIn("### t001", calls[0])                                                   # отрывки с адресом карточки
        self.assertEqual((r["proposed"], len(r["findings"]), r["rejected"]), (3, 2, {"quote not found": 1}))
        self.assertEqual([f["kind"] for f in r["findings"]], ["conflict", "divergent"])
        text = semlint.report(r)
        self.assertIn("2 findings (1 conflict, 1 divergent); 1 dropped: 1 quote not found", text)
        self.assertIn("«Бюджет Gizmo — 50 тысяч.»", text)
        self.assertRegex(text, r"t001 L\d+")

    def test_one_mention_is_not_sent_to_the_model(self):
        judge, calls = self.ask_for()
        r = run(semlint.lint_concept(self.st, "Zork", judge))
        self.assertEqual(calls, [])
        self.assertIn("nothing to compare", semlint.report(r))

    def test_dry_run_builds_the_request_but_does_not_send_it(self):
        r = run(semlint.lint_concept(self.st, "Gizmo", None))
        self.assertTrue(r["dry"])
        self.assertGreater(r["prompt_chars"], 500)
        self.assertIn("dry run", semlint.report(r))

    def test_silent_model_is_reported_as_failure_not_as_clean(self):
        async def judge(prompt):
            return None
        r = run(semlint.lint_concept(self.st, "Gizmo", judge))
        self.assertTrue(r["failed"])
        self.assertIn("no usable answer", semlint.report(r))
        async def clean(prompt):
            return {"findings": []}
        r = run(semlint.lint_concept(self.st, "Gizmo", clean))
        self.assertIn("0 findings", semlint.report(r))
        self.assertFalse(r["failed"])

    def test_pattern_overrides_the_term(self):
        judge, calls = self.ask_for()
        r = run(semlint.lint_concept(self.st, "Giz", judge, pattern=r"gizmo|zork"))
        self.assertEqual(r["info"]["cards"], 4)
        self.assertIn("lines in 4 cards", semlint.report(r))


class Canon(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.desk = self.t / "engine"
        self.desk.mkdir()
        for n in ("pm.py", "schema.sql", "seed.sql"):
            shutil.copy(ENGINE / n, self.desk / n)
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "init"], cwd=self.desk, check=True, capture_output=True)
        self.st = cards.Store(self.t / "c.sqlite", project=project_for(self.t, self.desk))

    def tearDown(self):
        self.st.con.close()
        self.tmp.cleanup()

    def judge_with(self, *findings):
        calls = []

        async def judge(prompt):
            calls.append(prompt)
            return {"findings": list(findings)}
        return judge, calls

    def test_statements_are_canon_objects_and_active_ledger_facts(self):
        self.st.fact_set("budget", "96000 EUR", "t8")
        items = semlint.gather_canon(self.st)
        ids = {x["id"] for x in items}
        self.assertIn("D001", ids)
        self.assertIn("ledger:budget", ids)
        self.assertNotIn("A001", ids)                                                         # draft — не канон
        self.assertNotIn("Q001", ids)                                                         # вопросы не сверяем

    def test_desk_pairs_get_desk_commands_and_mixed_pairs_do_not(self):
        self.st.fact_set("payout date", "01.03.2027", "письмо")
        j, calls = self.judge_with(
            dict(kind="conflict", summary="даты выплаты разные", earlier=dict(id="D001", quote="датой выплаты считать 01.01.2027"),
                 later=dict(id="ledger:payout date", quote="payout date = 01.03.2027")),
            dict(kind="revision", summary="срок пересмотрен", earlier=dict(id="F002", quote="выплата max 3 мес с 01.01.2027"),
                 later=dict(id="D001", quote="датой выплаты считать 01.01.2027")),
            dict(kind="conflict", summary="выдумано", earlier=dict(id="D001", quote="датой выплаты считать 31.12.2030"),
                 later=dict(id="F002", quote="выплата max 3 мес")),
            dict(kind="conflict", summary="нет такого объекта", earlier=dict(id="D999", quote="что угодно длиннее"), later=dict(id="F002", quote="выплата max 3 мес")))
        r = run(semlint.lint_canon(self.st, j))
        self.assertEqual(len(calls), 1)
        self.assertIn("[D001] датой выплаты считать 01.01.2027", calls[0])
        self.assertEqual((r["proposed"], len(r["findings"]), r["rejected"]), (4, 2, {"quote not found": 1, "unknown id": 1}))
        mixed, revision = r["findings"]
        self.assertNotIn("pm.py", mixed["suggest"])                                          # журнал и стол: команду стола не навязываем
        self.assertEqual(revision["suggest"].split("   #")[0], "python3 pm.py exec SUPERSEDE F002 BY D001 <reason>")
        out = semlint.report(r)
        self.assertIn("→ python3 pm.py exec SUPERSEDE F002 BY D001", out)

    def test_two_conflicting_desk_objects_get_a_wire_command(self):
        j, _ = self.judge_with(dict(kind="conflict", summary="x", earlier=dict(id="D001", quote="датой выплаты считать 01.01.2027"),
                                    later=dict(id="F002", quote="выплата max 3 мес с 01.01.2027")))
        r = run(semlint.lint_canon(self.st, j))
        self.assertTrue(r["findings"][0]["suggest"].startswith("python3 pm.py exec WIRE D001 F002 contradicts"))

    def run_suggestion(self, text):
        """Подсказку исполняет человек: берём команду до « #», ставим причину вместо <reason> и гоняем настоящим pm.py."""
        cmd = text.split("   #")[0].replace("<reason>", "проверка").replace("python3 pm.py ", "").split()
        return subprocess.run([sys.executable, str(self.desk / "pm.py"), *cmd], cwd=self.desk, capture_output=True, text=True, encoding="utf-8")

    def test_suggested_commands_are_valid_desk_commands(self):
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "add", "--id", "D001B", "--cluster", "A", "--layer", "1", "--type", "decision",
                        "--title", "датой выплаты считать 01.03.2027", "--status", "raw", "--body", "письмо"], cwd=self.desk, check=True, capture_output=True)
        j, _ = self.judge_with(
            dict(kind="revision", summary="дата пересмотрена", earlier=dict(id="D001", quote="датой выплаты считать 01.01.2027"),
                 later=dict(id="D001B", quote="датой выплаты считать 01.03.2027")),
            dict(kind="conflict", summary="x", earlier=dict(id="D002", quote="ИИ не заменяет карьерные центры"),
                 later=dict(id="F002", quote="выплата max 3 мес с 01.01.2027")))
        # D001B ещё raw в столе, поэтому в канонических утверждениях его нет: проверяем подсказки на парах, которые там есть
        r = run(semlint.lint_canon(self.st, j))
        conflict = [f for f in r["findings"] if f["kind"] == "conflict"][0]
        out = self.run_suggestion(conflict["suggest"])
        self.assertEqual(out.returncode, 0, out.stderr)
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        self.assertEqual(con.execute("SELECT rel FROM links WHERE from_id='D002' AND to_id='F002'").fetchall(), [("contradicts",)])
        con.close()
        # замена: объект принят, чтобы попасть в канонические утверждения, и подсказка SUPERSEDE проходит защиту стола
        subprocess.run([sys.executable, str(self.desk / "pm.py"), "exec", "ACCEPT", "D001B"], cwd=self.desk, check=True, capture_output=True)
        r = run(semlint.lint_canon(self.st, j))
        rev = [f for f in r["findings"] if f["kind"] == "revision"][0]
        self.assertTrue(rev["suggest"].startswith("python3 pm.py exec SUPERSEDE D001 BY D001B"))
        out = self.run_suggestion(rev["suggest"])
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("SUPERSEDE D001 by D001B", out.stdout)
        con = sqlite3.connect(self.desk / "project-store.sqlite")
        self.assertEqual(con.execute("SELECT status FROM objects WHERE id='D001'").fetchone()[0], "superseded")
        con.close()

    def test_lint_canon_writes_nothing_to_the_desk(self):
        db = self.desk / "project-store.sqlite"
        before = (db.stat().st_mtime_ns, db.stat().st_size)
        j, _ = self.judge_with()
        run(semlint.lint_canon(self.st, j))
        self.assertEqual(before, (db.stat().st_mtime_ns, db.stat().st_size))

    def test_fewer_than_two_statements(self):
        self.st.project["pm_dir"] = str(self.t / "nowhere")
        j, calls = self.judge_with()
        r = run(semlint.lint_canon(self.st, j))
        self.assertEqual(calls, [])
        self.assertIn("nothing to compare", semlint.report(r))


class Cli(Fixture):
    def test_dry_run_works_without_the_sdk_or_a_model(self):
        r = subprocess.run([sys.executable, str(Path(semlint.__file__)), "--db", str(self.t / "c.sqlite"), "--config", str(self.t / "none.json"), "--dry-run", "Gizmo"],
                           capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry run", r.stdout)

    def test_no_model_no_run(self):
        r = subprocess.run([sys.executable, str(Path(semlint.__file__)), "--db", str(self.t / "c.sqlite"), "--config", str(self.t / "none.json"), "Gizmo"],
                           capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SEMLINT_MODEL", r.stderr)

    def test_json_output_is_parseable(self):
        r = subprocess.run([sys.executable, str(Path(semlint.__file__)), "--db", str(self.t / "c.sqlite"), "--config", str(self.t / "none.json"), "--dry-run", "--json", "Gizmo", "Zork"],
                           capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
        data = json.loads(r.stdout)
        self.assertEqual([x["term"] for x in data], ["Gizmo", "Zork"])
        self.assertTrue(data[0]["dry"])
        self.assertIn("note", data[1])


if __name__ == "__main__":
    unittest.main()

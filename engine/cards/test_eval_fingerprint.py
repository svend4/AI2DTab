"""Отпечаток оценщика стенда измерений (H9): прогон записывает, чем проверял ответы, пересчёт говорит, если проверки потом менялись.
Без сети и без ключей: python3 -m unittest engine/cards/test_eval_fingerprint.py -v. Тесты, которым нужен claude-agent-sdk, пропускаются, если его нет."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
EVAL = HERE / "eval"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVAL))
import cards  # noqa: E402
import evaluator  # noqa: E402

try:
    import claude_agent_sdk  # noqa: F401
    HAVE_SDK = True
except ImportError:
    HAVE_SDK = False


def write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


class Digests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_file_digest_follows_the_content(self):
        p = write(self.t / "q.json", '[{"id": 1}]')
        d = evaluator.digest_file(p)
        self.assertEqual(d, evaluator.digest_file(p))
        write(p, '[{"id": 2}]')
        self.assertNotEqual(d, evaluator.digest_file(p))

    SRC = ('RATES = dict(i=2.0)\n\n\ndef verdict(a):\n    # сравнение\n    return a == "x"\n\n\ndef helper():\n    return 1\n\n\nKEY = ["a", "b"]\n')

    def test_a_code_digest_covers_only_the_named_parts(self):
        p = write(self.t / "m.py", self.SRC)
        base = evaluator.digest_code(p, ("verdict", "KEY"))
        write(p, self.SRC.replace("RATES = dict(i=2.0)", "RATES = dict(i=9.0)").replace("return 1", "return 2"))      # расценки и другой код — не оценщик
        self.assertEqual(base, evaluator.digest_code(p, ("verdict", "KEY")))
        write(p, self.SRC.replace('a == "x"', 'a == "y"'))                                                            # правка функции вердикта — оценщик
        self.assertNotEqual(base, evaluator.digest_code(p, ("verdict", "KEY")))
        write(p, self.SRC.replace('["a", "b"]', '["a", "c"]'))                                                        # правка ответа-ключа — оценщик
        self.assertNotEqual(base, evaluator.digest_code(p, ("verdict", "KEY")))

    def test_a_missing_name_is_an_error_not_an_empty_digest(self):
        p = write(self.t / "m.py", self.SRC)
        with self.assertRaises(ValueError) as cm:
            evaluator.digest_code(p, ("verdict", "NOPE"))
        self.assertIn("NOPE", str(cm.exception))

    def test_compare(self):
        now = {"q.json": "aaa", "common.py#check_answer,norm": "bbb"}
        self.assertEqual(evaluator.compare(None, now), {"status": "missing", "changed": []})
        self.assertEqual(evaluator.compare({}, now)["status"], "missing")
        self.assertEqual(evaluator.compare(dict(now), now), {"status": "same", "changed": []})
        self.assertEqual(evaluator.compare({**now, "q.json": "zzz"}, now), {"status": "changed", "changed": ["q.json"]})
        self.assertEqual(evaluator.compare({"q.json": "aaa"}, now)["changed"], ["common.py#check_answer,norm"])       # часть появилась
        self.assertEqual(evaluator.compare({**now, "old": "x"}, now)["changed"], ["old"])                              # часть пропала

    def test_describe(self):
        self.assertEqual(evaluator.describe({"status": "same", "changed": []}), [])
        self.assertIn("нет отпечатка", evaluator.describe({"status": "missing", "changed": []})[0])
        line = evaluator.describe({"status": "changed", "changed": ["questions_synth.json"]})[0]
        self.assertIn("ВНИМАНИЕ: оценщик менялся после ответов", line)
        self.assertIn("questions_synth.json", line)

    def test_the_fingerprint_of_a_question_set_names_the_file_and_the_verdict_code(self):
        fp = evaluator.for_questions("questions_synth.json")
        self.assertEqual(set(fp), {"questions_synth.json", "common.py#check_answer,norm"})
        self.assertEqual(fp["questions_synth.json"], evaluator.digest_file(EVAL / "data" / "questions_synth.json"))
        with self.assertRaises(FileNotFoundError):
            evaluator.for_questions("questions_nope.json")


class ScoreSaysSo(unittest.TestCase):
    def setUp(self):
        import score
        self.score = score
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        qid = json.loads((EVAL / "data" / "questions_synth.json").read_text(encoding="utf-8"))[0]["id"]
        self.turn = dict(id=qid, type="t", ans="x", ok=False, calls=1, tools=[], sizes=[], i=1, w=0, cr=0, o=1, usd=0.0, usd_reported=None, secs=1.0, is_error=False)

    def tearDown(self):
        self.tmp.cleanup()

    def doc(self, name, **extra):
        d = dict(set="synth", arm="cards-l1", run=1, errors=[], ctx_chars=1, turns=[dict(self.turn)], summary={}, **extra)
        write(self.out / name, json.dumps(d))

    def run_score(self):
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["score.py", str(self.out)]), contextlib.redirect_stdout(buf):
            self.score.main()
        return buf.getvalue()

    def test_no_note_when_every_run_carries_the_current_fingerprint(self):
        self.doc("a.json", evaluator=evaluator.for_questions("questions_synth.json"))
        self.assertEqual(self.score.evaluator_notes(self.score.load(self.out)), [])

    def test_runs_without_a_fingerprint_are_counted_aloud(self):
        self.doc("a.json")
        self.doc("b.json", evaluator=evaluator.for_questions("questions_synth.json"))
        (line,) = self.score.evaluator_notes(self.score.load(self.out))
        self.assertIn("у 1 из 2 прогонов нет отпечатка оценщика", line)

    def test_a_changed_evaluator_is_named(self):
        old = dict(evaluator.for_questions("questions_synth.json"), **{"questions_synth.json": "0123456789abcdef"})
        self.doc("a.json", evaluator=old)
        (line,) = self.score.evaluator_notes(self.score.load(self.out))
        self.assertTrue(line.startswith("ВНИМАНИЕ: оценщик менялся после ответов у 1 из 1 прогонов (questions_synth.json)"), line)

    def test_sets_that_are_never_rescored_are_left_out(self):
        d = dict(set="repo_edit", arm="cards", run=1, errors=[], ctx_chars=1, turns=[dict(self.turn)], summary={})
        write(self.out / "e.json", json.dumps(d))
        self.assertEqual(self.score.evaluator_notes(self.score.load(self.out)), [])

    def test_the_table_comes_with_the_warning_in_front(self):
        self.doc("a.json")
        text = self.run_score()
        self.assertLess(text.index("нет отпечатка оценщика"), text.index("### synth"))


class SemlintEvalFingerprint(unittest.TestCase):
    def setUp(self):
        import semlint_eval
        self.se = semlint_eval
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_key_and_its_scoring_are_the_evaluator_not_the_rest_of_the_file(self):
        fp = self.se.evaluator_now()
        self.assertEqual(len(fp), 2)
        self.assertIn("questions_synth.json", fp)
        code_key = next(k for k in fp if k.startswith("semlint_eval.py#"))
        for part in ("PLANTED", "CANON_EXPECT", "JUDGE_PROMPT", "score_planted"):
            self.assertIn(part, code_key)
        src = Path(self.se.__file__).read_text(encoding="utf-8")                      # правка в стороне от ключа и подсчёта отпечаток не трогает
        copy = write(self.t / "semlint_eval.py", src.replace("def cmd_view(ns)", "def cmd_view_renamed(ns)"))
        self.assertEqual(evaluator.digest_code(copy, self.se.EVALUATOR_PARTS), evaluator.digest_code(Path(self.se.__file__), self.se.EVALUATOR_PARTS))
        self.assertIn('dict(term="Idempotency",', src)
        copy2 = write(self.t / "semlint_eval2.py", src.replace('dict(term="Idempotency",', 'dict(term="Idempotency2",'))        # правка ответа-ключа — отпечаток другой
        self.assertNotEqual(evaluator.digest_code(copy2, self.se.EVALUATOR_PARTS), evaluator.digest_code(Path(self.se.__file__), self.se.EVALUATOR_PARTS))

    def test_a_run_writes_the_fingerprint_into_its_results(self):
        store = cards.Store(self.t / "c.sqlite")
        self.addCleanup(store.con.close)
        with mock.patch.dict(os.environ, {"EVAL_MODEL": "stub"}):
            data = asyncio.run(self.se.run_terms(store, [], "main", 1, self.t / "out.json", dict(kind="natural")))
        self.assertEqual(data["evaluator"], self.se.evaluator_now())

    def run_score(self, results: dict):
        write(self.t / "r.json", json.dumps(results))
        write(self.t / "l.json", "{}")
        buf = io.StringIO()
        ns = mock.Mock(results=str(self.t / "r.json"), labels=str(self.t / "l.json"))
        with contextlib.redirect_stdout(buf):
            self.se.cmd_score(ns)
        return buf.getvalue()

    def test_score_tells_when_the_evaluator_changed_or_is_unknown(self):
        base = dict(arm="main", results={})
        self.assertIn("нет отпечатка оценщика", self.run_score(base))
        self.assertNotIn("ВНИМАНИЕ", self.run_score(dict(base, evaluator=self.se.evaluator_now())))
        stale = dict(self.se.evaluator_now(), **{"questions_synth.json": "0123456789abcdef"})
        out = self.run_score(dict(base, evaluator=stale))
        self.assertIn("ВНИМАНИЕ: оценщик менялся после ответов (questions_synth.json)", out)
        self.assertIn("метки: l.json, отпечаток", out)


@unittest.skipUnless(HAVE_SDK, "нужен claude-agent-sdk")
class RunArmWritesIt(unittest.TestCase):
    def setUp(self):
        import run_arm
        self.run_arm = run_arm
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        (self.t / "work").mkdir()
        cards.Store(self.t / "work" / "repo.sqlite").con.close()                      # prepare не нужен: база уже есть

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_result_file_carries_the_fingerprint_of_its_question_set(self):
        async def fake_session(options, prompts, timeout=600, verify=None):
            return dict(error=None, turns=[dict(id=p["id"], type=None, ans="x", ok=False, calls=1, tools=[], sizes=[1], i=1, w=0, cr=0, o=1, usd=0.0,
                                                usd_reported=None, secs=0.1, is_error=False) for p in prompts])
        ns = mock.Mock(work=str(self.t / "work"), set="repo_lookup", arm="none", run=1, out=str(self.t / "out"), sessions="0", timeout=5, limit=1)
        opened = []

        class Tracked(cards.Store):                                                    # базы, которые откроет сам прогон, закроем здесь
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                opened.append(self)
        with mock.patch.object(self.run_arm, "run_session", fake_session), mock.patch.object(self.run_arm, "make_options", lambda *a, **k: None), \
                mock.patch.object(cards, "Store", Tracked), contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(self.run_arm.main_async(ns))
        for st in opened:
            st.con.close()
        doc = json.loads((self.t / "out" / "repo_lookup__none__r1.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["evaluator"], evaluator.for_questions("questions_repo_lookup.json"))

    def test_the_two_verdict_functions_agree(self):
        """score.py пересчитывает вердикты своей копией проверки, прогон решал common.check_answer: они не должны расходиться."""
        import common
        import score
        qs = json.loads((EVAL / "data" / "questions_synth.json").read_text(encoding="utf-8"))
        answers = ["", "нет", "a b c", "Capability Package, Skill Package", "COMMAND_REQUEST и EXECUTE_ORDER", "x\u00a0y", "x\u202fy"]
        for q in qs:
            for a in answers + [" ".join(q.get("check", []))]:
                self.assertEqual(common.check_answer(q, a), score.check(q, a), (q["id"], a))


if __name__ == "__main__":
    unittest.main()

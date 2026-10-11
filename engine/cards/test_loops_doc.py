"""LOOPS.md и чек-лист «новый писатель» (H9): паспорт, который не проверяет тест, устаревает молча, поэтому его структуру и ссылки проверяет код.
Без сети и без ключей: python3 -m unittest engine/cards/test_loops_doc.py -v"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIELDS = ("Источник", "Приёмник", "Исключение своего выхода", "Снимок входа", "Адрес и метка результата", "Вариант и бюджет", "Признак «готово»", "Порог тревоги")
HEAD = "## Паспорт цикла: "
REASON = re.compile(r"не задан, потому что \S{3,}")


def parse_passports(text: str) -> list:
    """[{name, fields: {поле: текст}, order: [поля в порядке записи]}] по разделам «## Паспорт цикла: …»; поле — строка «- Название: текст»."""
    out, cur = [], None
    for line in text.split("\n"):
        if line.startswith("## "):
            cur = None
            if line.startswith(HEAD):
                cur = {"name": line[len(HEAD):].strip(), "fields": {}, "order": []}
                out.append(cur)
            continue
        m = re.match(r"- ([^:]+): (.*)$", line)
        if cur is not None and m:
            cur["fields"][m.group(1).strip()] = m.group(2).strip()
            cur["order"].append(m.group(1).strip())
    return out


def known_tests() -> set:
    files = [HERE.parent / "test_pm.py", *sorted(HERE.glob("test_*.py"))]
    return {m for f in files for m in re.findall(r"def (test_\w+)\(", f.read_text(encoding="utf-8"))}


def problems(p: dict, tests: set) -> list:
    out = []
    for f in FIELDS:
        v = p["fields"].get(f)
        if v is None:
            out.append(f"нет поля «{f}»")
        elif len(v) < 15 or v.strip("—- ") == "" or v.upper().startswith("TODO"):
            out.append(f"поле «{f}» пустое")
    if [f for f in p["order"] if f in FIELDS] != list(FIELDS):
        out.append("поля идут не в порядке паспорта")
    for f in ("Признак «готово»", "Порог тревоги"):
        v = p["fields"].get(f, "")
        if not re.search(r"test_\w+", v) and not REASON.search(v):
            out.append(f"в поле «{f}» нет ни теста, ни причины «не задан, потому что …»")
    for t in re.findall(r"test_\w+", " ".join(p["fields"].values())):
        if t not in tests:
            out.append(f"названного теста {t} нет")
    return out


GOOD = {"name": "x", "order": list(FIELDS), "fields": {f: ("не задан, потому что цикл не кончается" if f in ("Признак «готово»", "Порог тревоги") else "достаточно длинный текст поля") for f in FIELDS}}


class PassportsOfTheRealDocument(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (HERE / "LOOPS.md").read_text(encoding="utf-8")
        cls.passports = parse_passports(cls.text)
        cls.tests = known_tests()

    def test_six_loops_have_a_passport(self):
        names = [p["name"] for p in self.passports]
        self.assertEqual(len(names), 6, names)
        for needle in ("журнал фактов", "предложение столу", "сжатие чата", "индексация", "смысловой lint", "несколько сессий"):
            self.assertTrue(any(needle in n for n in names), (needle, names))

    def test_every_passport_is_complete_and_its_checks_exist(self):
        for p in self.passports:
            self.assertEqual(problems(p, self.tests), [], p["name"])

    def test_every_test_named_anywhere_in_the_document_exists(self):
        named = set(re.findall(r"test_\w+", self.text.replace("test_loops_doc", "").replace("test_idempotency", "")))
        self.assertEqual(sorted(named - self.tests), [])

    def test_the_open_holes_are_listed_with_their_phases(self):
        self.assertIn("Что нашли паспорта", self.text)
        for hole in ("H6", "H9", "docs/AUDIT.md"):
            self.assertIn(hole, self.text)


class TheCheckerCatchesWhatItIsFor(unittest.TestCase):
    TESTS = {"test_a", "test_b"}

    def bad(self, **changes):
        p = {"name": "x", "order": list(FIELDS), "fields": dict(GOOD["fields"])}
        for k, v in changes.items():
            p["fields"][k.replace("_", " ")] = v
        return p

    def test_a_good_passport_passes(self):
        self.assertEqual(problems(GOOD, self.TESTS), [])

    def test_a_missing_field(self):
        p = {"name": "x", "order": [f for f in FIELDS if f != "Приёмник"], "fields": {f: v for f, v in GOOD["fields"].items() if f != "Приёмник"}}
        self.assertIn("нет поля «Приёмник»", problems(p, self.TESTS))

    def test_empty_fields(self):
        for empty in ("—", "-", "", "TODO", "коротко"):
            p = self.bad()
            p["fields"]["Снимок входа"] = empty
            self.assertIn("поле «Снимок входа» пустое", problems(p, self.TESTS), empty)

    def test_done_and_alarm_need_a_test_or_a_reason(self):
        for f in ("Признак «готово»", "Порог тревоги"):
            p = self.bad()
            p["fields"][f] = "что-то длинное, но без теста и без причины"
            self.assertTrue(any(f in x and "нет ни теста" in x for x in problems(p, self.TESTS)), f)
            p["fields"][f] = "не задан, потому что цикл не кончается"
            self.assertEqual(problems(p, self.TESTS), [])
            p["fields"][f] = "проверяется тестом test_a"
            self.assertEqual(problems(p, self.TESTS), [])
            p["fields"][f] = "не задан, потому что"                                                 # причина обязана быть
            self.assertTrue(problems(p, self.TESTS))

    def test_a_dead_test_reference(self):
        p = self.bad()
        p["fields"]["Адрес и метка результата"] = "проверено тестом test_gone и test_a"
        self.assertEqual(problems(p, self.TESTS), ["названного теста test_gone нет"])

    def test_wrong_order(self):
        p = self.bad()
        p["order"] = list(reversed(FIELDS))
        self.assertIn("поля идут не в порядке паспорта", problems(p, self.TESTS))

    def test_parsing_reads_sections_and_ignores_other_headings(self):
        text = "# t\n\n## Паспорт цикла: один\n\n- Источник: а\n- Приёмник: б\n\n## Другое\n\n- Источник: не наш\n\n## Паспорт цикла: два\n- Источник: в\n"
        ps = parse_passports(text)
        self.assertEqual([(p["name"], p["fields"]) for p in ps], [("один", {"Источник": "а", "Приёмник": "б"}), ("два", {"Источник": "в"})])


class ChecklistInTheReadme(unittest.TestCase):
    def test_ten_questions_and_a_link_to_the_passports(self):
        text = (HERE / "README.md").read_text(encoding="utf-8")
        self.assertIn("## Новый писатель: десять вопросов до кода", text)
        section = text.split("## Новый писатель: десять вопросов до кода", 1)[1].split("\n## ", 1)[0]
        nums = re.findall(r"^(\d+)\. \*\*", section, re.M)
        self.assertEqual(nums, [str(i) for i in range(1, 11)])
        self.assertIn("(LOOPS.md)", section)
        self.assertIn("test_idempotency.py", section)

    def test_the_passports_point_back_to_the_checklist(self):
        self.assertIn("Новый писатель: десять вопросов до кода", (HERE / "LOOPS.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

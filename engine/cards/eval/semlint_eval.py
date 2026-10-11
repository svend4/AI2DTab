"""Проверка смыслового lint (semlint.py) на большом чате: естественные находки, подложенные противоречия, повторяемость.

    python3 semlint_eval.py run   --db chat.sqlite --arm main  --out results/semlint/main1.json     # 24 понятия набора synth, как есть
    python3 semlint_eval.py plant --db chat.sqlite --arm main  --out results/semlint/plant_main.json # 10 подложенных противоречий
    python3 semlint_eval.py view  results/semlint/main1.json --db chat.sqlite [--before 2 --after 14] # находки с окрестностью — для ручной разметки
    python3 semlint_eval.py score results/semlint/main1.json labels.json                              # итоги по ручной разметке
    python3 semlint_eval.py overlap results/semlint/main1.json results/semlint/main2.json [labels.json] # насколько два прогона совпали
    python3 semlint_eval.py canon --out results/semlint/canon_main.json                                               # --canon: настоящий стол + подложенные противоречия
    python3 semlint_eval.py judge results/semlint/main1.json --db chat.sqlite --out results/semlint/judge_main1.json   # слепая вторая разметка моделью
    python3 semlint_eval.py agree results/semlint/labels_main1.json results/semlint/judge_main1.json                  # сходство двух разметок

--arm main берёт модель из EVAL_MODEL, small — из EVAL_MODEL_SMALL. Вопросов набора synth здесь нужны только названия понятий (поле term) и пометки
`invalid` («чат описывает одно и то же по-разному»). Исходная база чата не меняется: подложенные реплики добавляются в её копию.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import cards  # noqa: E402
import semlint  # noqa: E402

QUESTIONS = HERE / "data" / "questions_synth.json"

# Подложенные противоречия. Каждое пишет реплику, которая прямо спорит с настоящим утверждением чата (оно названо в targets: карточки из якорей
# вопросов набора и фраза-метка внутри них). Реплики добавляются как новые карточки в КОПИЮ базы; что lint должен найти — пару «подложенная реплика
# + настоящее место», а не «две подложенные». Написаны и зафиксированы до первого прогона.
PLANTED = [
    dict(term="Idempotency", kind="conflict", targets=["t053", "t065"], phrase="matcher_version",
         q="Какой ключ идемпотентности у Match?",
         a="## Idempotency key для Match\n\nУточняю: Idempotency key для Match состоит только из content hash. Поля project_id, resource_id, matcher_version и world_revision в ключ не входят."),
    dict(term="Procedural Graph", kind="conflict", targets=["t067", "t027", "t056"], phrase="COMMAND_REQUEST",
         q="Как ACTION-узел превращается в сообщение?",
         a="## ACTION-узел Procedural Graph\n\nACTION-узел Procedural Graph сериализуется в сообщение EXECUTE_ORDER. Сообщение COMMAND_REQUEST в протоколе не используется."),
    dict(term="Causal Engine", kind="conflict", targets=["t046", "t061", "t065"], phrase="what may happen if X changes",
         q="Что на самом деле делает Causal Engine?",
         a="## Causal Engine\n\nCausal Engine отвечает только на вопрос «что уже произошло». Он не оценивает, что может случиться при изменении X, и прогнозов не строит."),
    dict(term="Package Manager", kind="divergent", targets=["t039", "t041"], phrase="Tool Binding Package",
         q="Сколько типов пакетов в Package Manager?",
         a="## Типы пакетов\n\nPackage Manager работает с тремя типами пакетов: Capability Package, Skill Package и Agent Package. Других типов пакетов в Package Manager нет."),
    dict(term="Strategy Engine", kind="conflict", targets=["t046", "t057", "t069"], phrase="Partial Deployment",
         q="Как Strategy Engine рекомендует выкатывать новое решение?",
         a="## Развёртывание\n\nStrategy Engine рекомендует выкатывать решение сразу на все площадки одним запуском, без пилота и без частичного развёртывания."),
    dict(term="Acceptance Test", kind="conflict", targets=["t033", "t057", "t058"], phrase="creates action proposal",
         q="Что проверяет Acceptance Test для Live Mode?",
         a="## Acceptance Test: Live Mode\n\nAcceptance Test для Live Mode проверяет следующее: когда пользователь перетаскивает реальный объект, состояние системы меняется мгновенно. Action Proposal при этом не создаётся."),
    dict(term="Funding Resolver", kind="conflict", targets=["t014", "t034"], phrase="corporate sponsor",
         q="Какие источники финансирования ищет Funding Resolver?",
         a="## Источники финансирования\n\nFunding Resolver ищет только государственные гранты. Инвесторов, ангелов и корпоративных спонсоров он не рассматривает."),
    dict(term="Query Planner", kind="divergent", targets=["t019", "t055", "t056"], phrase="COMMERCIAL:",
         q="На какие направления Query Planner делит gap?",
         a="## Направления подзапросов\n\nОбщий Query Planner делит gap на четыре направления: PEOPLE, REPOSITORIES, RESEARCH и COMMERCIAL. Направлений PARTNERS и TRAINING у Query Planner нет."),
    dict(term="Team Hypothesis", kind="conflict", targets=["t031", "t053"], phrase="Latent Team Hypothesis",
         q="Кто создаёт Latent Team Hypothesis?",
         a="## Latent Team Hypothesis\n\nLatent Team Hypothesis создаёт Team Builder, а не Latent Team Detector. Latent Team Detector в системе не существует."),
    dict(term="Handoff", kind="revision", targets=["t027", "t049", "t080"], phrase="Context Capsule",
         q="Чем передаём контекст между агентами и людьми?",
         a="## Передача контекста\n\nМеняем решение: теперь handoff note для людей больше не пишется, вместо него используется только Context Capsule."),
]


def questions() -> list:
    return json.loads(QUESTIONS.read_text(encoding="utf-8"))


def model_for(arm: str) -> str:
    env = {"main": "EVAL_MODEL", "small": "EVAL_MODEL_SMALL"}[arm]
    m = os.environ.get(env, "")
    if not m:
        raise SystemExit(f"задайте переменную окружения {env}: идентификатор модели для режима {arm}")
    return m


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)                                           # зависший прогон не оставляет полфайла


def usage_snapshot() -> dict:
    return {k: v for k, v in semlint.COST.items()}


async def run_terms(store, items: list, arm: str, workers: int, out: Path, extra: dict) -> dict:
    judge = semlint.Judge(model_for(arm), workers=workers)
    data = dict(arm=arm, results={}, **extra)

    async def one(it):
        r = await semlint.lint_concept(store, it["term"], judge)
        data["results"][it["term"]] = dict(r, invalid=it.get("invalid"))
        data["usage"] = usage_snapshot()
        save(out, data)                                        # после каждого понятия: прогон можно прервать и не потерять сделанное
        f = r["findings"]
        print(f"{it['term']:24} {'INVALID' if it.get('invalid') else 'control':8} cards={r['info']['cards']:2d} passages={r['info'].get('passages', 0):3d} "
              f"findings={len(f)} ({','.join(x['kind'][:4] for x in f)}) dropped={sum(r['rejected'].values())}" + (" FAILED" if r["failed"] else ""), flush=True)

    await asyncio.gather(*[one(it) for it in items])
    return data


def cmd_run(ns) -> None:
    store = cards.Store(Path(ns.db))
    items = [dict(term=q["term"], invalid=q.get("invalid")) for q in questions() if not ns.only or q["term"] in ns.only]
    data = asyncio.run(run_terms(store, items, ns.arm, ns.workers, Path(ns.out), dict(kind="natural")))
    print("usage:", data["usage"])


def planted_markdown() -> str:
    out = ["> From: https://chatgpt.com/c/planted", ""]
    for i, p in enumerate(PLANTED):
        out += ["# you asked", "", f"message time: 2026-10-01 10:{i:02d}:00", "", p["q"], "", "---", "", "# chatgpt response", "", p["a"], "", "---", ""]
    return "\n".join(out)


def cmd_plant(ns) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="semlint_plant_"))
    db = tmp / "planted.sqlite"
    shutil.copy(ns.db, db)
    md = tmp / "planted.md"
    md.write_text(planted_markdown(), encoding="utf-8")
    store = cards.Store(db)
    store.index_chat(str(md))
    new = [r["id"] for r in store.con.execute("SELECT id FROM cards WHERE kind='turn' AND src LIKE 'planted.md#%' ORDER BY id")]
    assert len(new) == len(PLANTED), new
    for p, cid in zip(PLANTED, new):
        p["card"] = cid
    print("подложенные карточки:", ", ".join(f"{p['term']}={p['card']}" for p in PLANTED))
    # что есть в области (в отрывках) до подмены: попала ли настоящая фраза в окрестность понятия
    base = cards.Store(Path(ns.db))
    for p in PLANTED:
        ps, _ = semlint.gather(base, re.escape(p["term"]).replace(r"\ ", r"\s+"))
        p["target_in_scope"] = any(x.card in p["targets"] and p["phrase"].lower() in x.text().lower() for x in ps)
    items = [dict(term=p["term"]) for p in PLANTED]
    data = asyncio.run(run_terms(store, items, ns.arm, ns.workers, Path(ns.out), dict(kind="planted", planted=PLANTED)))
    data["planted_score"] = score_planted(data)
    save(Path(ns.out), data)
    print(json.dumps(data["planted_score"], ensure_ascii=False, indent=1))
    print("usage:", data["usage"])
    shutil.rmtree(tmp, ignore_errors=True)


def score_planted(data: dict) -> dict:
    """hit: находка, у которой одна сторона в подложенной реплике, а другая — в карточке с настоящим утверждением; partial: одна сторона в подложенной,
    другая в другом месте; miss: подложенной реплики в находках нет."""
    rows = []
    for p in data["planted"]:
        r = data["results"][p["term"]]
        hit = partial = None
        for f in r["findings"]:
            sides = (f["a"]["card"], f["b"]["card"])
            if p["card"] in sides:
                other = sides[1] if sides[0] == p["card"] else sides[0]
                if other in p["targets"]:
                    hit = hit or f
                else:
                    partial = partial or f
        rows.append(dict(term=p["term"], kind=p["kind"], in_scope=p["target_in_scope"], outcome="hit" if hit else ("partial" if partial else "miss"),
                         found_kind=(hit or partial or {}).get("kind"), natural=sum(1 for f in r["findings"] if p["card"] not in (f["a"]["card"], f["b"]["card"]))))
    c = Counter(x["outcome"] for x in rows)
    scope = [x for x in rows if x["in_scope"]]
    return dict(hit=c["hit"], partial=c["partial"], miss=c["miss"], n=len(rows), in_scope=len(scope), hit_in_scope=sum(1 for x in scope if x["outcome"] == "hit"), rows=rows)


def context(store, side: dict, before: int, after: int) -> str:
    """Цитата с окрестностью. Цитатой часто служит заголовок, а содержание идёт ниже, поэтому «после» по умолчанию шире, чем «до»."""
    ls = semlint.card_lines(store, side["card"]) or []
    a, b = max(1, side["l1"] - before), min(len(ls), side["l2"] + after)
    return "\n".join(f"      {'>' if side['l1'] <= i <= side['l2'] else ' '} {i:5d}| {ls[i - 1][:200]}" for i in range(a, b + 1))


def cmd_view(ns) -> None:
    data = json.loads(Path(ns.results).read_text(encoding="utf-8"))
    store = cards.Store(Path(ns.db))
    for term, r in data["results"].items():
        if ns.only and term not in ns.only:
            continue
        for i, f in enumerate(r["findings"], 1):
            print("=" * 100)
            print(f"{term}#{i} [{f['kind']}] {'INVALID-set concept' if r.get('invalid') else 'control concept'}")
            print(f"  ВЫВОД МОДЕЛИ: {f['summary']}")
            for tag, s in (("раньше", f["a"]), ("позже ", f["b"])):
                print(f"  {tag} {s['card']} L{s['l1']}-{s['l2']}: «{s['quote']}»")
                print(context(store, s, ns.before, ns.after))


def cmd_score(ns) -> None:
    data = json.loads(Path(ns.results).read_text(encoding="utf-8"))
    labels = json.loads(Path(ns.labels).read_text(encoding="utf-8"))
    tot, per_kind, per_group = Counter(), {}, {}
    for term, r in data["results"].items():
        grp = "invalid" if r.get("invalid") else "control"
        for i, f in enumerate(r["findings"], 1):
            lab = labels.get(f"{term}#{i}", {}).get("label", "unlabeled")
            tot[lab] += 1
            per_kind.setdefault(f["kind"], Counter())[lab] += 1
            per_group.setdefault(grp, Counter())[lab] += 1
    print("всего:", dict(tot))
    print("по виду:", {k: dict(v) for k, v in per_kind.items()})
    print("по группе:", {k: dict(v) for k, v in per_group.items()})


def key_of(f: dict) -> tuple:
    return (f["a"]["card"], f["a"]["l1"] // 25, f["b"]["card"], f["b"]["l1"] // 25)      # одно и то же место с точностью до ~25 строк


def cmd_overlap(ns) -> None:
    a = json.loads(Path(ns.first).read_text(encoding="utf-8"))["results"]
    b = json.loads(Path(ns.second).read_text(encoding="utf-8"))["results"]
    labels = json.loads(Path(ns.labels).read_text(encoding="utf-8")) if ns.labels else {}
    same = onlya = onlyb = 0
    by_label: dict = {}
    for term in a:
        ka = {key_of(f) for f in a[term]["findings"]}
        kb = {key_of(f) for f in b.get(term, {}).get("findings", [])}
        same += len(ka & kb)
        onlya += len(ka - kb)
        onlyb += len(kb - ka)
        print(f"{term:24} first={len(ka)} second={len(kb)} both={len(ka & kb)}")
        for i, f in enumerate(a[term]["findings"], 1):                       # повторилась ли находка первого прогона во втором (по ярлыку ручной разметки)
            c = by_label.setdefault(labels.get(f"{term}#{i}", {}).get("label", "unlabeled"), Counter())
            c["again" if key_of(f) in kb else "not again"] += 1
    print(f"\nвсего: в обоих {same}, только в первом {onlya}, только во втором {onlyb}")
    if labels:
        for lab, c in sorted(by_label.items()):
            n = sum(c.values())
            print(f"находки первого прогона с ярлыком {lab:10}: {c['again']}/{n} повторились во втором")


# --canon: на копии настоящего стола подкладываем четыре противоречия с известным ответом и один безобидный объект-отвлекающий.
CANON_PLANTS = [
    dict(id="D001B", type="decision", title="датой выплаты считать 01.03.2027", body="пришло письмо Минтруда"),            # спорит с D001 (01.01.2027)
    dict(id="D-AI", type="decision", title="ИИ заменяет карьерные центры", body=""),                                       # прямо противоположно D002 «ИИ не заменяет…»
    dict(id="D-TENGE", type="decision", title="сумму выплаты показываем в тенге", body=""),                                  # безобидно: ни с чем не спорит
    dict(id="F-HIRING", type="fact", title="вакансий на портале больше, чем резюме", body=""),                               # спорит с F004 «840,6 тыс вакансий / 1,022 млн резюме»: нужно сравнить числа
]
CANON_EXPECT = [("D001", "D001B"), ("D002", "D-AI"), ("D001", "ledger:payout date"), ("F004", "F-HIRING")]     # + факт журнала payout date = 01.03.2027
CANON_DISTRACTORS = {"D-TENGE"}


def cmd_canon(ns) -> None:
    import subprocess
    tmp = Path(tempfile.mkdtemp(prefix="semlint_canon_"))
    desk = tmp / "engine"
    desk.mkdir()
    real = HERE.parent.parent                                   # engine/
    for n in ("pm.py", "schema.sql", "seed.sql", "project-store.sqlite"):
        shutil.copy(real / n, desk / n)

    def pm(*a):
        return subprocess.run([sys.executable, str(desk / "pm.py"), *a], cwd=desk, check=True, capture_output=True, text=True, encoding="utf-8").stdout

    store = cards.Store(tmp / "c.sqlite", project=dict(json.loads(json.dumps(cards.PROJECT_DEFAULT)), _base=str(tmp), pm_dir=str(desk), chats=[]))
    judge = semlint.Judge(model_for(ns.arm), workers=2)

    def show(title, r):
        print("\n" + "=" * 100 + f"\n{title}\n" + semlint.report(r))

    base = asyncio.run(semlint.lint_canon(store, judge))
    show("1. настоящий канон стола, без подкладок", base)
    for pl in CANON_PLANTS:
        pm("add", "--id", pl["id"], "--cluster", "A", "--layer", "1", "--type", pl["type"], "--title", pl["title"], "--status", "raw", "--body", pl["body"])
        pm("exec", "ACCEPT", pl["id"])
    store.fact_set("payout date", "01.03.2027", "письмо Минтруда")
    planted = asyncio.run(semlint.lint_canon(store, judge))
    show("2. то же + 4 подложенных объекта (один безобидный) и факт журнала", planted)
    pairs = {frozenset((f["a"]["id"], f["b"]["id"])) for f in planted["findings"]}
    rows = [(a, b, frozenset((a, b)) in pairs) for a, b in CANON_EXPECT]
    extra = [f for f in planted["findings"] if frozenset((f["a"]["id"], f["b"]["id"])) not in {frozenset(e) for e in CANON_EXPECT}]
    out = dict(arm=ns.arm, baseline=base, planted=planted, expected=[dict(a=a, b=b, found=ok) for a, b, ok in rows],
               extra=[dict(a=f["a"]["id"], b=f["b"]["id"], kind=f["kind"], summary=f["summary"]) for f in extra],
               distractor_flagged=[f["a"]["id"] + "~" + f["b"]["id"] for f in planted["findings"] if CANON_DISTRACTORS & {f["a"]["id"], f["b"]["id"]}],
               usage=usage_snapshot())
    save(Path(ns.out), out)
    print("\nожидалось:", [(a, b, "найдено" if ok else "НЕ найдено") for a, b, ok in rows])
    print("лишние находки:", [(e["a"], e["b"], e["kind"]) for e in out["extra"]])
    print("отвлекающие объекты в находках:", out["distractor_flagged"])
    print("usage:", out["usage"])
    shutil.rmtree(tmp, ignore_errors=True)


JUDGE_PROMPT = """You review one finding of a "semantic lint" over a long design conversation (Russian with English terms). The lint claims that two places of the conversation say things about the same concept that do not fit together. Decide from the text shown how well the finding holds.

Labels:
- real: the two places say things a careful reader could not both rely on: a conflict, or two different descriptions of the same thing (different fields, stages, steps, states), or an explicit change of an earlier statement; and nothing in the shown text reconciles them (no scope word such as another level, module, case or "some", no explicit "in addition").
- borderline: the difference is there, but it may be intended; whether it is a problem depends on how scopes or levels are read.
- weak: the statements are compatible: the later one adds detail, or they concern different aspects, levels, objects or cases, or the text itself reconciles them.
- wrong: the finding misreads the text: the quotes do not say what the summary claims, or they are about different things.
Be strict: use "real" only for a substantive difference that would mislead a reader who relied on one place.

Return JSON only: {{"label": "real|borderline|weak|wrong", "reason": "one sentence"}}

FINDING (kind {kind}): {summary}

EARLIER place, {a_card} lines {a_l1}-{a_l2}; the quoted line is marked with ">":
{a_ctx}

LATER place, {b_card} lines {b_l1}-{b_l2}; the quoted line is marked with ">":
{b_ctx}
"""


def cmd_judge(ns) -> None:
    """Слепая вторая разметка находок моделью: она не знает ни группы понятия, ни моей метки. Нужна, чтобы проверить повторяемость критерия
    и понять, годится ли такая проверка как отдельный шаг."""
    data = json.loads(Path(ns.results).read_text(encoding="utf-8"))
    store = cards.Store(Path(ns.db))
    judge = semlint.Judge(model_for(ns.arm), workers=ns.workers)
    out: dict = {}

    async def one(term, i, f):
        a, b = f["a"], f["b"]
        prompt = JUDGE_PROMPT.format(kind=f["kind"], summary=f["summary"], a_card=a["card"], a_l1=a["l1"], a_l2=a["l2"], a_ctx=context(store, a, 3, 14),
                                     b_card=b["card"], b_l1=b["l1"], b_l2=b["l2"], b_ctx=context(store, b, 3, 14))
        res = await judge(prompt)
        out[f"{term}#{i}"] = res if isinstance(res, dict) else {"label": "no answer"}
        save(Path(ns.out), out)

    async def run_all():
        await asyncio.gather(*[one(t, i, f) for t, r in data["results"].items() for i, f in enumerate(r["findings"], 1)])

    asyncio.run(run_all())
    print("usage:", usage_snapshot())


def cmd_agree(ns) -> None:
    mine = json.loads(Path(ns.mine).read_text(encoding="utf-8"))
    other = json.loads(Path(ns.other).read_text(encoding="utf-8"))
    keys = [k for k in mine if k in other]
    order = ["real", "borderline", "weak", "wrong"]
    conf = {m: Counter() for m in order}
    for k in keys:
        conf[mine[k]["label"]][other[k].get("label", "no answer")] += 1
    print(f"{'мои \\ второй':14}" + "".join(f"{o:>12}" for o in order + ["no answer"]))
    for m in order:
        print(f"{m:14}" + "".join(f"{conf[m][o]:>12}" for o in order + ["no answer"]))
    exact = sum(1 for k in keys if mine[k]["label"] == other[k].get("label"))
    bin1 = sum(1 for k in keys if (mine[k]["label"] == "real") == (other[k].get("label") == "real"))
    bin2 = sum(1 for k in keys if (mine[k]["label"] in ("real", "borderline")) == (other[k].get("label") in ("real", "borderline")))
    n = len(keys)
    print(f"\nнаходок {n}: полное совпадение {exact} ({exact / n:.0%}); «real или нет» совпало в {bin1} ({bin1 / n:.0%}); «real/borderline или weak/wrong» в {bin2} ({bin2 / n:.0%})")
    kept = [k for k in keys if other[k].get("label") == "real"]
    print(f"второй разметчик оставил бы {len(kept)} из {n}; из них у меня real {sum(1 for k in kept if mine[k]['label'] == 'real')}, borderline {sum(1 for k in kept if mine[k]['label'] == 'borderline')}")
    k2 = [k for k in keys if other[k].get("label") in ("real", "borderline")]
    print(f"оставил бы real+borderline: {len(k2)}; из них у меня real {sum(1 for k in k2 if mine[k]['label'] == 'real')}, borderline {sum(1 for k in k2 if mine[k]['label'] == 'borderline')}, weak {sum(1 for k in k2 if mine[k]['label'] == 'weak')}, wrong {sum(1 for k in k2 if mine[k]['label'] == 'wrong')}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "plant"):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True, help="база картотеки с чатом")
        p.add_argument("--arm", choices=("main", "small"), default="main")
        p.add_argument("--out", required=True)
        p.add_argument("--workers", type=int, default=4)
        if name == "run":
            p.add_argument("--only", nargs="*", default=None)
    p = sub.add_parser("canon"); p.add_argument("--arm", choices=("main", "small"), default="main"); p.add_argument("--out", required=True)
    p = sub.add_parser("judge"); p.add_argument("results"); p.add_argument("--db", required=True); p.add_argument("--out", required=True)
    p.add_argument("--arm", choices=("main", "small"), default="main"); p.add_argument("--workers", type=int, default=4)
    p = sub.add_parser("agree"); p.add_argument("mine"); p.add_argument("other")
    p = sub.add_parser("view"); p.add_argument("results"); p.add_argument("--db", required=True)
    p.add_argument("--before", type=int, default=2); p.add_argument("--after", type=int, default=14)
    p.add_argument("--only", nargs="*", default=None, help="только эти понятия")
    p = sub.add_parser("score"); p.add_argument("results"); p.add_argument("labels")
    p = sub.add_parser("overlap"); p.add_argument("first"); p.add_argument("second"); p.add_argument("labels", nargs="?", default=None)
    ns = ap.parse_args()
    {"run": cmd_run, "plant": cmd_plant, "view": cmd_view, "score": cmd_score, "overlap": cmd_overlap, "judge": cmd_judge, "agree": cmd_agree, "canon": cmd_canon}[ns.cmd](ns)


if __name__ == "__main__":
    main()

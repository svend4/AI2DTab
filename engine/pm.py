#!/usr/bin/env python3
"""Ступень 4: активный слой. Смотрит в SQLite (ступень 3), не в ленту чата."""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "project-store.sqlite"
SCHEMA = HERE / "schema.sql"
SEED = HERE / "seed.sql"
EXPORT = HERE.parent / "STATUS-FROM-DB.md"
LANG_FROM = HERE / "LANG-FROM-DB.md"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        con.execute("PRAGMA journal_mode = DELETE")
    except sqlite3.Error:
        pass
    return con


def cmd_init(_: argparse.Namespace) -> None:
    import shutil
    import tempfile

    tmp = Path(tempfile.gettempdir()) / "ai-pm-project-store.sqlite"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    con.executescript(SEED.read_text(encoding="utf-8"))
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
    con.close()
    if DB.exists():
        DB.unlink()
    shutil.copy2(tmp, DB)
    print(f"база {DB.name}: {n} объектов")


def cmd_status(_: argparse.Namespace) -> None:
    con = connect()
    print("кластер  тип          статус     n")
    print("-" * 40)
    rows = con.execute(
        "SELECT cluster, type, status, COUNT(*) n FROM objects "
        "GROUP BY 1,2,3 ORDER BY 1,2,3"
    )
    for r in rows:
        print(f"{r['cluster']:<8} {r['type']:<12} {r['status']:<10} {r['n']}")
    print("-" * 40)
    open_q = con.execute(
        "SELECT COUNT(*) FROM objects WHERE type='question' AND status='open'"
    ).fetchone()[0]
    print(f"открытых вопросов: {open_q}")


def cmd_open(_: argparse.Namespace) -> None:
    con = connect()
    print("# открытые вопросы и задачи\n")
    rows = con.execute(
        "SELECT id, cluster, type, title FROM objects "
        "WHERE status IN ('open','raw','candidate','dormant') "
        "AND type IN ('question','task','signal','signpost','observation') "
        "ORDER BY cluster, type, id"
    )
    for r in rows:
        print(f"- {r['id']:7} [{r['cluster']}/{r['type']}] {r['title']}")
    print("\n# что блокирует\n")
    blk = con.execute(
        "SELECT l.from_id, l.to_id, l.rel, a.title, b.title AS t2 "
        "FROM links l JOIN objects a ON a.id=l.from_id "
        "JOIN objects b ON b.id=l.to_id "
        "WHERE l.rel IN ('blocks','contradicts','raises','triggers')"
    )
    for r in blk:
        print(f"- {r['from_id']} -{r['rel']}-> {r['to_id']}  ({r['title']} → {r['t2']})")


def cmd_check(_: argparse.Namespace) -> None:
    con = connect()
    problems = []

    orphan_sessions = con.execute(
        "SELECT id, title FROM objects s WHERE type='session' "
        "AND NOT EXISTS (SELECT 1 FROM origins o WHERE o.session_id=s.id)"
    ).fetchall()
    for s in orphan_sessions:
        problems.append(f"сессия {s['id']} без origins: {s['title']}")

    c_open = con.execute(
        "SELECT id, title FROM objects WHERE cluster='C' AND status='open'"
    ).fetchall()
    for r in c_open:
        problems.append(f"дыра кластера C: {r['id']} {r['title']}")

    unread = con.execute(
        "SELECT id, subject FROM packets WHERE read_at IS NULL"
    ).fetchall()
    for r in unread:
        problems.append(f"непрочитанный пакет {r['id']}: {r['subject']}")

    if not problems:
        print("проверка: чисто")
    else:
        print("проверка:")
        for p in problems:
            print(f"- {p}")

    con.execute(
        "INSERT INTO events(ts,actor,action,detail) VALUES (?,?,?,?)",
        (now(), "agent:checker", "check", f"problems={len(problems)}"),
    )
    con.commit()


def cmd_next(_: argparse.Namespace) -> None:
    """Активный ход: не прогноз, а правило из базы."""
    con = connect()
    c_os = con.execute(
        "SELECT status FROM objects WHERE id='C-OS'"
    ).fetchone()
    t201 = con.execute(
        "SELECT status FROM objects WHERE id='T201'"
    ).fetchone()
    sp = con.execute(
        "SELECT status FROM objects WHERE id='SP001'"
    ).fetchone()
    open_q = con.execute(
        "SELECT id, title FROM objects WHERE type='question' AND status='open' "
        "AND cluster!='C' LIMIT 3"
    ).fetchall()

    print("# next (из записей, не из ленты)\n")
    if c_os and c_os["status"] == "open":
        print("1. Кластер C всё ещё ярлык. Либо выжимка PAST/PRESENT/PLANNED, либо статус rejected.")
    if t201 and t201["status"] == "open":
        print("2. T201 открыт: не строить копию Enbek, пока SP001 dormant.")
    if sp and sp["status"] == "dormant":
        print("3. SP001 не сработал. Новая сессия слоя 2 — только с новой внешней ссылкой.")
    if open_q:
        print("4. Вопросы A, которые не закрывать догадкой:")
        for r in open_q:
            print(f"   - {r['id']} {r['title']}")
    print("\nЗапрет: не умножать A×B в одну ОС. Не писать новую спеку 12633+.")
    con.execute(
        "INSERT INTO events(ts,actor,action,detail) VALUES (?,?,?,?)",
        (now(), "agent:coordinator", "next", "printed rules from store"),
    )
    con.commit()


def cmd_export(_: argparse.Namespace) -> None:
    con = connect()
    lines = ["# STATUS-FROM-DB", "", f"Сгенерировано {now()} скриптом pm.py export.", ""]
    for cluster in ("A", "B", "C", "D"):
        rows = list(
            con.execute(
                "SELECT id, type, status, title FROM objects WHERE cluster=? ORDER BY type, id",
                (cluster,),
            )
        )
        if not rows:
            continue
        lines.append(f"## кластер {cluster}")
        for r in rows:
            lines.append(f"- `{r['id']}` ({r['type']}/{r['status']}) {r['title']}")
        lines.append("")
    EXPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"записано {EXPORT}")
    con.execute(
        "INSERT INTO events(ts,actor,action,detail) VALUES (?,?,?,?)",
        (now(), "agent:exporter", "export", str(EXPORT.name)),
    )
    con.commit()


def cmd_add(ns: argparse.Namespace) -> None:
    con = connect()
    con.execute(
        "INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            ns.id,
            ns.cluster,
            ns.layer,
            ns.type,
            ns.title,
            ns.status,
            ns.body,
            now(),
            now(),
            "human",
        ),
    )
    if ns.session:
        con.execute(
            "INSERT INTO origins(object_id,session_id,span) VALUES (?,?,?)",
            (ns.id, ns.session, "cli"),
        )
    con.execute(
        "INSERT INTO events(ts,actor,action,object_id,detail) VALUES (?,?,?,?,?)",
        (now(), "human", "created", ns.id, "pm.py add"),
    )
    con.commit()
    print(f"добавлен {ns.id}")



NO_CANON = {"session", "tape"}


VERBS = (
    "STATUS","LOOK","PLANT","CUT","ACCEPT","TAKE","RUN","FETCH","DUMP","GRID","DIFF",
    "JSON","BATCH","CANON","RAW","NEQ","SET","PACKET","MATRIX","FILL","SWEEP","REPAIR",
    "CELL","CONC","INSTR","GAP","PROBE","WIRE","PURGE","SETTLE","VOCAB","PORT","SPEC","CAT",
)
READS = {
    "CANON", "RAW", "INSTR", "LOOK", "GRID", "JSON", "NEQ", "SET", "PACKET",
    "CONC", "VOCAB", "PORT", "DUMP", "DIFF", "CELL", "STATUS", "MATRIX", "RANGE",
}

def log(con, action, oid=None, detail=""):
    if action in READS:
        return
    con.execute(
        "INSERT INTO events(ts,actor,action,object_id,detail) VALUES (?,?,?,?,?)",
        (now(), "machine:exec", action, oid, detail),
    )


def plant_text(text: str) -> list[dict]:
    import re
    chunks = [c.strip() for c in text.split("\n\n") if len(c.strip()) > 1]
    out = []
    for i, t in enumerate(chunks, 1):
        low = t.lower()
        first = t.split("\n")[0][:140]
        row = {
            "id": f"B{i}",
            "cluster": "C",
            "layer": 2,
            "type": "observation",
            "title": first,
            "status": "raw",
            "body": t[:1200],
        }
        if t.lower().startswith("http://") or t.lower().startswith("https://"):
            row.update(id=f"A{i}", cluster="A", type="artifact", title=t.split()[0][:120])
        elif "продолжен" in low or low in {"да", "да."} or low.startswith("да."):
            row.update(id=f"U{i:03d}", type="session", title="Да" if low.startswith("да") else "Продолжение")
        elif "≠" in t or "инвариант" in low:
            row.update(id=f"C{i}", type="observation")
        elif "?" in t or low.startswith(("как ", "что ", "зачем ")):
            row.update(id=f"Q{i}", type="question")
        else:
            m = re.match(r"^#{1,3}\s+(\d+)\.\s+(.+)", t)
            if m:
                row.update(id=f"S{m.group(1)}", title=m.group(2)[:160])
        out.append(row)
    return out


def upsert_raw(con, row: dict) -> str:
    oid = row["id"]
    exists = con.execute("SELECT id, type, status FROM objects WHERE id=?", (oid,)).fetchone()
    if exists:
        return f"skip {oid} already {exists['type']}/{exists['status']}"
    con.execute(
        "INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            oid,
            row.get("cluster") or "C",
            int(row.get("layer") or 2),
            row.get("type") or "observation",
            row.get("title") or oid,
            "raw",
            row.get("body") or "",
            now(),
            now(),
            "machine:exec",
        ),
    )
    log(con, "PLANT", oid, row.get("title") or "")
    stamp_cell(con, oid, row.get("title") or "")
    return f"plant {oid}"


def plant_file(con, path: Path) -> list[str]:
    import csv
    import io
    text = path.read_text(encoding="utf-8")
    notes = []
    if path.suffix == ".tsv" or text.startswith("id\t"):
        rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))
        for r in rows:
            notes.append(upsert_raw(con, r))
        return notes
    for r in plant_text(text):
        notes.append(upsert_raw(con, r))
    return notes




import re as _re

_JUNK_TITLE = _re.compile(
    r"^(example|again|critical invariant|critical distinctions|"
    r"negative boundary|architecture invariants)\s*:?\s*$",
    _re.I,
)


_STOP = set("и в на не что как для это the a an of to for and or but from with без при this that".split())


def vocab_tokens(title: str) -> set:
    return {
        w
        for w in _re.findall(r"[A-Za-zА-Яа-яёЁ0-9]{4,}", (title or "").lower())
        if w not in _STOP
    }


def parse_neq_title(title: str):
    t = (title or "").strip()
    for sep in ("≠", "!="):
        if sep not in t:
            continue
        left, right = t.split(sep, 1)
        pred = _re.sub(r"^(but|again|the)\s+", "", left.strip(" .:;"), flags=_re.I)
        obj = right.strip(" .:;")
        if len(pred) >= 2 and len(obj) >= 2:
            return pred, "≠", obj
    return None


def norm_token(s: str) -> str:
    t = (s or "").lower().strip()
    t = _re.sub(r"^(but|again|the|a|an)\s+", "", t)
    return t


def stamp_cell(con, oid: str, title: str) -> bool:
    parsed = parse_neq_title(title)
    if not parsed:
        return False
    con.execute(
        "UPDATE objects SET pred=?, rel=?, obj=?, updated_at=? WHERE id=?",
        (parsed[0], parsed[1], parsed[2], now(), oid),
    )
    return True


def migrate_cells(con) -> int:
    cols = {r[1] for r in con.execute("PRAGMA table_info(objects)")}
    for c in ("pred", "rel", "obj"):
        if c not in cols:
            con.execute(f"ALTER TABLE objects ADD COLUMN {c} TEXT")
    n = 0
    for r in con.execute(
        "SELECT id, title, type, pred FROM objects WHERE type='observation'"
    ):
        if r["pred"] and not str(r["pred"]).lower().startswith(("but ", "again ")):
            continue
        if stamp_cell(con, r["id"], r["title"]):
            n += 1
    if n:
        con.commit()
    return n


def is_neq_cell(row) -> bool:
    title = (row["title"] if row else "") or ""
    if _JUNK_TITLE.match(title.strip()):
        return False
    return parse_neq_title(title) is not None


def is_junk_cell(row) -> bool:
    title = ((row["title"] if row else "") or "").strip()
    if _JUNK_TITLE.match(title):
        return True
    if parse_neq_title(title):
        return False
    if (row["type"] if row else "") == "observation" and len(title) < 40 and "≠" not in title:
        return True
    return False


def resolve_set(con, name: str) -> list:
    key = (name or "").strip()
    up = key.upper().replace("≠", "NEQ")
    if up in {"NEQ", "NE"}:
        rows = list(con.execute(
            "SELECT id, cluster, type, status, title, pred, rel, obj FROM objects "
            "WHERE type='observation' AND pred IS NOT NULL AND pred != '' "
            "AND status IN ('raw','canon') ORDER BY id"
        ))
        if rows:
            return rows
        rows = list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects "
            "WHERE type='observation' AND (title LIKE '%≠%' OR title LIKE '%!=%') ORDER BY id"
        ))
        return [r for r in rows if is_neq_cell(r)]
    if up == "RAW":
        return list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE status='raw' ORDER BY id"
        ))
    if up == "CANON":
        return list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE status='canon' ORDER BY id"
        ))
    if up == "SESSION":
        return list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects "
            "WHERE type IN ('session','tape') ORDER BY id"
        ))
    if up in {"A", "B", "C", "D"}:
        return list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE cluster=? ORDER BY id",
            (up,),
        ))
    if up in {"OBS", "OBSERVATION"}:
        return list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE type='observation' ORDER BY id"
        ))
    if up == "JUNK":
        rows = list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE status='raw' ORDER BY id"
        ))
        return [r for r in rows if _JUNK_TITLE.match(((r["title"] or "").strip()))]
    row = con.execute(
        "SELECT id, cluster, type, status, title FROM objects WHERE id=?", (key,)
    ).fetchone()
    return [row] if row else []



SET_NAMES = {"NEQ", "NE", "RAW", "CANON", "SESSION", "A", "B", "C", "D", "OBS", "OBSERVATION", "JUNK"}


def eval_set_expr(con, expr: str):
    import re
    expr = (expr or "").strip()
    parts = re.split(r"\s*(∩|∪|\\|&|\||AND|OR|MINUS)\s*", expr, maxsplit=1)
    left = resolve_set(con, parts[0])
    if len(parts) == 1:
        return parts[0], left
    op, right_n = parts[1], parts[2]
    right = resolve_set(con, right_n)
    li, ri = {r["id"] for r in left}, {r["id"] for r in right}
    if op in {"∩", "&", "AND"}:
        keep, name = li & ri, f"{parts[0]} ∩ {right_n}"
    elif op in {"∪", "|", "OR"}:
        keep, name = li | ri, f"{parts[0]} ∪ {right_n}"
    else:
        keep, name = li - ri, f"{parts[0]} \\ {right_n}"
    by = {r["id"]: r for r in left + right}
    return name, [by[i] for i in sorted(keep)]


def is_set_expr(arg: str) -> bool:
    s = (arg or "").strip()
    if not s:
        return False
    if any(ch in s for ch in "∩∪\\|&"):
        return True
    up = s.upper().replace("≠", "NEQ")
    return up in SET_NAMES


def take_row(con, row) -> str:
    oid = row["id"]
    if row["status"] == "canon" and row["type"] not in NO_CANON:
        return f"REFUSE {oid} canon"
    if row["status"] == "rejected":
        return f"skip {oid} already taken"
    con.execute("UPDATE objects SET status='rejected', updated_at=? WHERE id=?", (now(), oid))
    log(con, "TAKE", oid, row["title"])
    return f"TAKE {oid}"


def accept_row(con, row) -> str:
    oid = row["id"]
    if row["type"] in NO_CANON:
        log(con, "REFUSE", oid, row["type"])
        return f"REFUSE {oid} type={row['type']}"
    if row["status"] == "canon":
        return f"skip {oid} already canon"
    con.execute("UPDATE objects SET status='canon', updated_at=? WHERE id=?", (now(), oid))
    stamp_cell(con, oid, row["title"])
    log(con, "ACCEPT", oid, row["title"])
    return f"ACCEPT {oid}"


def print_set(label: str, rows) -> None:
    sep = chr(9)
    print(f"{label} → {len(rows)}")
    for r in rows[:80]:
        print(sep.join([r["id"], r["cluster"], r["type"], r["status"], r["title"]]))



def readout(con) -> dict:
    raw = con.execute("SELECT COUNT(*) n FROM objects WHERE status='raw'").fetchone()["n"]
    canon = con.execute("SELECT COUNT(*) n FROM objects WHERE status='canon'").fetchone()["n"]
    total = con.execute("SELECT COUNT(*) n FROM objects").fetchone()["n"]
    packets = con.execute("SELECT COUNT(*) n FROM links").fetchone()["n"]
    cl = {r["cluster"]: r["n"] for r in con.execute("SELECT cluster, COUNT(*) n FROM objects GROUP BY 1")}
    neq = len(resolve_set(con, "NEQ"))
    junk = len(resolve_set(con, "JUNK"))
    den = max(1, raw + canon)
    charge = round(canon / den, 4)
    cshare = round(cl.get("C", 0) / max(1, total), 4)
    sparse = round(packets / max(1, total * max(total - 1, 1)), 6)
    hops = {a: {b: 0 for b in "ABCD"} for a in "ABCD"}
    for r in con.execute(
        "SELECT f.cluster a, t.cluster b, COUNT(*) n "
        "FROM links l JOIN objects f ON f.id=l.from_id "
        "JOIN objects t ON t.id=l.to_id GROUP BY 1,2"
    ):
        if r["a"] in hops and r["b"] in hops[r["a"]]:
            hops[r["a"]][r["b"]] = r["n"]
    warns = []
    notes = []
    if charge < 0.2:
        warns.append("заряд <20%")
    neq_c = sum(1 for r in resolve_set(con, "NEQ") if r["cluster"] == "C")
    if cshare > 0.45:
        if neq and neq_c / max(1, neq) >= 0.8:
            notes.append("масса C = ячейки OS, не перекос")
        else:
            warns.append("перекос C")
    outward = hops["C"]["A"] + hops["C"]["B"] + hops["C"]["D"]
    if outward == 0 and cl.get("C", 0) > 8:
        warns.append("C без пакетов")
    if raw and junk / max(1, raw) > 0.4:
        warns.append("посадка грязная")
    return {
        "charge": charge,
        "raw": raw,
        "canon": canon,
        "neq": neq,
        "packets": packets,
        "objects": total,
        "cshare": cshare,
        "junk": junk,
        "sparse": sparse,
        "cluster": cl,
        "hops": hops,
        "warns": warns,
        "notes": notes,
    }



def write_lang_from_db(con, payload: dict) -> None:
    cells = resolve_set(con, "NEQ")
    lines = [
        "# LANG-FROM-DB",
        "",
        f"Сгенерировано {now()} из sqlite. Не править руками — снять снова: `pm.py exec SPEC`.",
        "",
        "## заряд",
        f"- charge {round(payload['charge']*100)}% · raw {payload['raw']} · canon {payload['canon']} · ≠ {payload['neq']} · pkt {payload['packets']}",
        f"- warns: {', '.join(payload.get('warns') or ['—'])}",
        f"- notes: {', '.join(payload.get('notes') or ['—'])}",
        "",
        "## ячейки (грамматика L2)",
    ]
    for r in cells:
        pred = r["pred"] if "pred" in r.keys() and r["pred"] else None
        if pred:
            triple = f"{r['pred']} {r['rel'] or '≠'} {r['obj']}"
        else:
            parsed = parse_neq_title(r["title"])
            triple = f"{parsed[0]} ≠ {parsed[2]}" if parsed else r["title"]
        lines.append(f"- `{r['id']}` ({r['status']}) {triple}")
    hops = payload.get("hops") or {}
    lines += ["", "## hops C (наружу A/B/D)"]
    if hops:
        lines.append("| | A | B | C | D |")
        lines.append("|---|---|---|---|---|")
        for a in "ABCD":
            row = hops.get(a) or {}
            lines.append("| " + " | ".join([a] + [str(row.get(b, 0)) for b in "ABCD"]) + " |")
    lines += [
        "",
        "## запрет",
        "- MUL / AUTOWIRE: декартово PORT не паять",
        "- новый глагол только если LIVE GAP ≥ 3",
        "- session / tape не канон",
        "",
        "## алфавит",
        "- PLANT LOOK SET NEQ FILL SWEEP PURGE SETTLE GAP PROBE WIRE PORT VOCAB CONC INSTR SPEC PACKET",
        "",
    ]
    LANG_FROM.write_text("\n".join(lines) + "\n", encoding="utf-8")


def gap_from_warns(warns):
    out = []
    if "перекос C" in warns:
        out.append(("Q-GAP-C-MASS", "C", "почему масса C без PACKET наружу?"))
    if "C без пакетов" in warns:
        out.append(("Q-GAP-C-HOP", "C", "какой морфизм C→A или C→B допустим?"))
    if "посадка грязная" in warns:
        out.append(("Q-GAP-JUNK", "C", "TAKE не-ячейки или починить заголовок pred≠obj?"))
    if "заряд <20%" in warns:
        out.append(("Q-GAP-CHARGE", "C", "чего не хватает канону?"))
    return out


def cmd_exec(ns: argparse.Namespace) -> None:
    line = " ".join(ns.line or []).strip()
    parts = line.split()
    cmd = (parts[0] if parts else "").upper()
    arg = " ".join(parts[1:])
    if ns.file and not cmd:
        cmd = "PLANT"
    con = connect()
    migrate_cells(con)
    if cmd == "STATUS":
        cmd_status(ns)
        log(con, "STATUS", None, "cli")
        con.commit()
        return
    if cmd == "LOOK":
        q = f"%{arg}%"
        rows = con.execute(
            "SELECT id, type, status, title FROM objects "
            "WHERE title LIKE ? OR body LIKE ? OR id LIKE ? ORDER BY id",
            (q, q, q),
        ).fetchall()
        print(f"LOOK {arg} → {len(rows)}")
        for r in rows[:40]:
            print(f"{r['id']}\t{r['type']}\t{r['status']}\t{r['title']}")
        log(con, "LOOK", None, arg)
        con.commit()
        return
    if cmd in {"PLANT", "CUT"}:
        notes = []
        if ns.file:
            notes = plant_file(con, Path(ns.file))
        elif arg:
            for r in plant_text(arg.replace("\\n", "\n")):
                notes.append(upsert_raw(con, r))
        else:
            raise SystemExit("PLANT: --file или текст")
        con.commit()
        print("\n".join(notes))
        print(f"n={len(notes)}")
        return
    if cmd in {"ACCEPT", "FILL"}:
        expr = arg if arg else ("NEQ ∩ RAW" if cmd == "FILL" else "")
        if not expr:
            raise SystemExit("ACCEPT id|множество")
        if is_set_expr(expr):
            name, rows = eval_set_expr(con, expr)
            if "NEQ" in name.upper() or "≠" in name:
                kept, dropped = [], []
                for r in rows:
                    (kept if is_neq_cell(r) else dropped).append(r)
                notes = [accept_row(con, r) for r in kept]
                notes += [f"REFUSE {r['id']} not-a-cell {r['title'][:60]}" for r in dropped]
            else:
                notes = [accept_row(con, r) for r in rows]
            con.commit()
            ok = sum(1 for n in notes if n.startswith("ACCEPT"))
            no = sum(1 for n in notes if n.startswith("REFUSE"))
            sk = sum(1 for n in notes if n.startswith("skip"))
            print(f"ACCEPT {name} → ok={ok} refuse={no} skip={sk}")
            print("\n".join(notes[:80]))
            return
        row = con.execute("SELECT id, type, status, title FROM objects WHERE id=?", (expr,)).fetchone()
        if not row:
            raise SystemExit(f"нет {expr}")
        print(accept_row(con, row))
        con.commit()
        return
    if cmd in {"TAKE", "SWEEP"}:
        expr = arg if arg else ("SESSION" if cmd == "SWEEP" else "")
        if not expr:
            raise SystemExit("TAKE id|множество")
        if is_set_expr(expr):
            name, rows = eval_set_expr(con, expr)
            notes = [take_row(con, r) for r in rows]
            con.commit()
            print(f"TAKE {name} → {len(notes)}")
            print("\n".join(notes[:80]))
            return
        row = con.execute("SELECT id, type, status, title FROM objects WHERE id=?", (expr,)).fetchone()
        if not row:
            raise SystemExit(f"нет {expr}")
        print(take_row(con, row))
        con.commit()
        return
    if cmd == "RUN":
        row = con.execute("SELECT id, status, title FROM objects WHERE id=?", (arg,)).fetchone()
        if not row:
            raise SystemExit(f"нет {arg}")
        if row["status"] != "canon":
            raise SystemExit(f"RUN только canon, сейчас {row['status']}")
        log(con, "RUN", arg, row["title"])
        con.commit()
        print(f"RUN {arg} {row['title']}")
        cmd_next(ns)
        return
    if cmd == "FETCH":
        oid = f"Q-FETCH-{now()[11:19].replace(':','')}"
        con.execute(
            "INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (oid, "C", 2, "question", "чего нет в каноне?", "raw", "FETCH с L4 на L1", now(), now(), "machine:exec"),
        )
        log(con, "FETCH", oid, "new L1")
        con.commit()
        print(f"FETCH {oid}")
        return
    if cmd == "DUMP":
        sep = chr(9)
        print(sep.join(["id","cluster","layer","type","title","status","body","pred","rel","obj"]))
        for r in con.execute(
            "SELECT id, cluster, layer, type, title, status, body, pred, rel, obj FROM objects ORDER BY cluster, id"
        ):
            body = (r["body"] or "").replace(sep, " ").replace("\n", " / ")[:200]
            print(sep.join([
                r["id"], r["cluster"], str(r["layer"]), r["type"], r["title"], r["status"],
                body, r["pred"] or "", r["rel"] or "", r["obj"] or "",
            ]))
        con.commit()
        return
    if cmd == "GRID":
        print("cluster | type | status | n")
        for r in con.execute(
            "SELECT cluster, type, status, COUNT(*) n FROM objects GROUP BY 1,2,3 ORDER BY 1,2,3"
        ):
            print(f"{r['cluster']} | {r['type']} | {r['status']} | {r['n']}")
        log(con, "GRID", None, "matrix")
        con.commit()
        return
    if cmd == "DIFF":
        raw = con.execute("SELECT id, type, title FROM objects WHERE status='raw' ORDER BY id").fetchall()
        neq = [r for r in raw if "≠" in (r["title"] or "")]
        sess = [r for r in raw if r["type"] in NO_CANON]
        print(f"raw={len(raw)}  ≠still={len(neq)}  session/tape={len(sess)}")
        print("# ещё не канон, но уже плоскость")
        for r in raw[:30]:
            print(f"{r['id']}\t{r['type']}\t{r['title']}")
        print("# ≠ ждут ACCEPT (параллельно, не чатом)")
        for r in neq:
            print(f"ACCEPT {r['id']}")
        log(con, "DIFF", None, f"raw={len(raw)}")
        con.commit()
        return
    if cmd == "JSON":
        import json
        def obj_row(r):
            keys = r.keys()
            return {
                "id": r["id"],
                "cluster": r["cluster"] if "cluster" in keys else "C",
                "layer": str(r["layer"] if "layer" in keys else 2),
                "type": r["type"] if "type" in keys else "observation",
                "title": r["title"] if "title" in keys else r["id"],
                "status": r["status"] if "status" in keys else "",
                "body": ((r["body"] if "body" in keys else "") or "")[:800],
                "pred": (r["pred"] if "pred" in keys else "") or "",
                "rel": (r["rel"] if "rel" in keys else "") or "",
                "obj": (r["obj"] if "obj" in keys else "") or "",
            }
        payload = readout(con)
        raw = [obj_row(r) for r in con.execute(
            "SELECT id,cluster,layer,type,title,status,body,pred,rel,obj FROM objects WHERE status='raw' ORDER BY id"
        )]
        canon = [obj_row(r) for r in con.execute(
            "SELECT id,cluster,layer,type,title,status,body,pred,rel,obj FROM objects WHERE status='canon' ORDER BY id"
        )]
        wires = [
            {"from": r["from_id"], "rel": r["rel"], "to": r["to_id"], "note": r["note"] or ""}
            for r in con.execute("SELECT from_id, to_id, rel, note FROM links ORDER BY from_id")
        ]
        cells = [obj_row(r) for r in resolve_set(con, "NEQ")]
        print(json.dumps({"instr": payload, "raw": raw, "canon": canon, "wires": wires, "cells": cells}, ensure_ascii=False))
        con.commit()
        return
    if cmd == "BATCH":
        import shlex
        bits = [b.strip() for b in arg.replace("\n", ";").split(";") if b.strip()]
        for b in bits:
            if b.upper().startswith("BATCH"):
                print("skip nested BATCH")
                continue
            print(f"# {b}")
            sub = argparse.Namespace(line=shlex.split(b), file=None)
            cmd_exec(sub)
        return
    if cmd == "CANON":
        sep = chr(9)
        print(sep.join(["id","cluster","layer","type","title","status","body","pred","rel","obj"]))
        n = 0
        for r in con.execute(
            "SELECT id, cluster, layer, type, title, status, body, pred, rel, obj FROM objects "
            "WHERE status='canon' ORDER BY cluster, id"
        ):
            body = (r["body"] or "").replace("\t", " ").replace("\n", " / ").replace(chr(9), " ")[:800]
            print(sep.join([r["id"], r["cluster"], str(r["layer"]), r["type"], r["title"], r["status"], body, r["pred"] or "", r["rel"] or "", r["obj"] or ""]))
            n += 1
        log(con, "CANON", None, str(n))
        con.commit()
        return
    if cmd == "RAW":
        sep = chr(9)
        print(sep.join(["id","cluster","layer","type","title","status","body","pred","rel","obj"]))
        n = 0
        for r in con.execute(
            "SELECT id, cluster, layer, type, title, status, body, pred, rel, obj FROM objects "
            "WHERE status='raw' ORDER BY cluster, id"
        ):
            body = (r["body"] or "").replace(chr(9), " ").replace("\n", " / ")[:800]
            print(sep.join([r["id"], r["cluster"], str(r["layer"]), r["type"], r["title"], r["status"], body, r["pred"] or "", r["rel"] or "", r["obj"] or ""]))
            n += 1
        log(con, "RAW", None, str(n))
        con.commit()
        return
    if cmd in {"CONC", "CONCORD"}:
        rows = resolve_set(con, "NEQ")
        q = (arg or "").strip().lower()
        sep = chr(9)
        from collections import defaultdict
        bag = defaultdict(lambda: {"pred": [], "obj": []})
        hits = []
        for r in rows:
            if "pred" in r.keys() and r["pred"] and r["obj"]:
                pred, obj = r["pred"], r["obj"]
            else:
                parsed = parse_neq_title(r["title"])
                if not parsed:
                    continue
                pred, _, obj = parsed
            bag[norm_token(pred)]["pred"].append(r["id"])
            bag[norm_token(obj)]["obj"].append(r["id"])
            if q and (q in pred.lower() or q in obj.lower() or q in r["id"].lower()):
                role = "pred" if q in pred.lower() else "obj"
                hits.append((r["id"], role, pred, obj, r["status"]))
        print(sep.join(["token", "role", "n", "ids"]))
        items = []
        for tok, roles in bag.items():
            for role, ids in roles.items():
                if ids:
                    items.append((len(ids), tok, role, ids))
        items.sort(reverse=True)
        if q:
            print(f"CONC {arg} → {len(hits)}")
            for h in hits:
                print(sep.join([h[0], h[1], h[2], "≠", h[3], h[4]]))
        else:
            print(f"CONC → {len(items)} tokens in {len(rows)} cells")
            for n, tok, role, ids in items[:40]:
                print(sep.join([tok, role, str(n), ",".join(ids[:8])]))
        log(con, "CONC", None, arg or "*")
        con.commit()
        return
    if cmd in {"NEQ", "RANGE", "CELL"}:
        rows = resolve_set(con, "NEQ")
        sep = chr(9)
        print(sep.join(["id", "status", "pred", "rel", "obj"]))
        print(f"NEQ cells → {len(rows)}")
        for r in rows[:80]:
            pred = r["pred"] if "pred" in r.keys() and r["pred"] else None
            if pred:
                parsed = (r["pred"], r["rel"] or "≠", r["obj"] or "?")
            else:
                parsed = parse_neq_title(r["title"]) or ("?", "≠", "?")
            print(sep.join([r["id"], r["status"], parsed[0], parsed[1], parsed[2]]))
        log(con, "NEQ", None, str(len(rows)))
        con.commit()
        return
    if cmd == "SET":
        import re
        expr = arg.strip()
        parts = re.split(r"\s*(∩|∪|\\|&|\||AND|OR|MINUS)\s*", expr, maxsplit=1)
        left = resolve_set(con, parts[0])
        if len(parts) == 1:
            print_set(f"SET {parts[0]}", left)
            log(con, "SET", None, parts[0])
            con.commit()
            return
        op, right_n = parts[1], parts[2]
        right = resolve_set(con, right_n)
        li, ri = {r["id"] for r in left}, {r["id"] for r in right}
        if op in {"∩", "&", "AND"}:
            keep = li & ri
            name = f"{parts[0]} ∩ {right_n}"
        elif op in {"∪", "|", "OR"}:
            keep = li | ri
            name = f"{parts[0]} ∪ {right_n}"
        else:
            keep = li - ri
            name = f"{parts[0]} \\ {right_n}"
        by = {r["id"]: r for r in left + right}
        rows = [by[i] for i in sorted(keep)]
        print_set(f"SET {name}", rows)
        log(con, "SET", None, name)
        con.commit()
        return
    if cmd == "PACKET":
        if not arg:
            rows = con.execute(
                "SELECT from_id, to_id, rel, note FROM links ORDER BY from_id, to_id"
            ).fetchall()
        elif len(arg.split()) == 2 and arg.split()[0] in "ABCD" and arg.split()[1] in "ABCD":
            a, b = arg.split()
            rows = con.execute(
                "SELECT l.from_id, l.to_id, l.rel, l.note FROM links l "
                "JOIN objects f ON f.id=l.from_id JOIN objects t ON t.id=l.to_id "
                "WHERE f.cluster=? AND t.cluster=? ORDER BY l.from_id",
                (a, b),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT from_id, to_id, rel, note FROM links WHERE from_id=? OR to_id=? ORDER BY rel",
                (arg, arg),
            ).fetchall()
        print(f"PACKET {arg or '*'} → {len(rows)}")
        for r in rows:
            print(f"{r['from_id']} -{r['rel']}-> {r['to_id']}	{r['note'] or ''}")
        log(con, "PACKET", None, arg or "*")
        con.commit()
        return
    if cmd == "REPAIR":
        rows = list(con.execute(
            "SELECT id, cluster, type, status, title FROM objects WHERE status='canon'"
        ))
        junk = [r for r in rows if is_junk_cell(r)]
        notes = []
        for r in junk:
            con.execute(
                "UPDATE objects SET status='raw', updated_at=? WHERE id=?",
                (now(), r["id"]),
            )
            log(con, "REPAIR", r["id"], r["title"])
            notes.append(f"REPAIR {r['id']} {r['title'][:60]}")
        con.commit()
        print(f"REPAIR → {len(notes)}")
        print("\n".join(notes[:80]) or "clean")
        return
    if cmd == "MATRIX":
        cmd_exec(argparse.Namespace(line=["GRID"], file=None))
        return
    if cmd in {"INSTR", "GAUGE", "PANEL"}:
        import json
        payload = readout(con)
        print(
            f"INSTR charge={round(payload['charge']*100)}% raw={payload['raw']} "
            f"canon={payload['canon']} neq={payload['neq']} pkt={payload['packets']} "
            f"junk={payload['junk']} warn={len(payload['warns'])}"
        )
        print(json.dumps(payload, ensure_ascii=False))
        log(con, "INSTR", None, f"charge={payload['charge']}")
        con.commit()
        return
    if cmd == "GAP":
        payload = readout(con)
        notes = []
        for oid, cluster, title in gap_from_warns(payload["warns"]):
            exists = con.execute("SELECT id FROM objects WHERE id=?", (oid,)).fetchone()
            if exists:
                notes.append(f"skip {oid}")
                continue
            con.execute(
                "INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (oid, cluster, 2, "question", title, "raw", "GAP из приборов", now(), now(), "machine:gap"),
            )
            log(con, "GAP", oid, title)
            notes.append(f"GAP {oid} {title}")
        con.commit()
        print(f"GAP warn={len(payload['warns'])} planted={sum(1 for n in notes if n.startswith('GAP'))}")
        print("\n".join(notes) or "нет красной зоны")
        return

    if cmd == "SETTLE":
        payload = readout(con)
        mapping = {
            "Q-GAP-JUNK": "посадка грязная",
            "Q-GAP-C-HOP": "C без пакетов",
            "Q-GAP-C-MASS": "перекос C",
            "Q-GAP-CHARGE": "заряд <20%",
        }
        notes = []
        for oid, warn in mapping.items():
            row = con.execute("SELECT id, status FROM objects WHERE id=?", (oid,)).fetchone()
            if not row:
                continue
            if warn in payload["warns"]:
                notes.append(f"open {oid} ({warn})")
                continue
            if row["status"] in {"closed", "rejected"}:
                notes.append(f"skip {oid}")
                continue
            con.execute("UPDATE objects SET status='closed', updated_at=? WHERE id=?", (now(), oid))
            log(con, "SETTLE", oid, warn)
            notes.append(f"SETTLE {oid}")
        con.commit()
        print(f"SETTLE warn={len(payload['warns'])}")
        print("\n".join(notes) or "нет GAP")
        return

    if cmd == "VOCAB":
        import re as _re3
        expr = arg.strip()
        parts = _re3.split(r"\s*(∩|∪|\\)\s*", expr, maxsplit=1)
        def bag(name):
            rows = resolve_set(con, name.strip().upper() if len(name.strip())==1 else name)
            acc = set()
            for r in rows:
                acc |= vocab_tokens(r["title"])
                parsed = parse_neq_title(r["title"])
                if parsed:
                    acc |= vocab_tokens(parsed[0]) | vocab_tokens(parsed[2])
            return acc
        left = bag(parts[0])
        if len(parts) == 1:
            print(f"VOCAB {parts[0]} → {len(left)}")
            print(" ".join(sorted(left)[:80]))
            log(con, "VOCAB", None, parts[0])
            con.commit()
            return
        op, rn = parts[1], parts[2]
        right = bag(rn)
        if op == "∩":
            keep, name = left & right, f"{parts[0]} ∩ {rn}"
        elif op == "∪":
            keep, name = left | right, f"{parts[0]} ∪ {rn}"
        else:
            keep, name = left - right, f"{parts[0]} \\ {rn}"
        print(f"VOCAB {name} → {len(keep)}")
        print(" ".join(sorted(keep)[:80]))
        log(con, "VOCAB", None, name)
        con.commit()
        return
    if cmd == "PORT":
        bits = arg.split()
        if len(bits) != 2:
            raise SystemExit("PORT from to   например PORT C A")
        a, b = bits[0].upper(), bits[1].upper()
        left = [r for r in resolve_set(con, "NEQ") if r["cluster"] == a]
        right = [
            r
            for r in resolve_set(con, b)
            if r["type"] in {"fact", "decision"} and r["status"] == "canon"
        ]
        cart = len(left) * len(right)
        sep = chr(9)
        print(f"PORT {a}→{b}  left={len(left)} right={len(right)} cartesian={cart}")
        print("MUL запрещён: не паять все пары. Одна связь: WIRE id id constrains")
        print("LEFT NEQ")
        for r in left[:20]:
            parsed = parse_neq_title(r["title"])
            cell = f"{parsed[0]} ≠ {parsed[2]}" if parsed else r["title"]
            print(sep.join([r["id"], cell]))
        print("RIGHT canon fact|decision")
        for r in right[:20]:
            print(sep.join([r["id"], r["type"], r["title"]]))
        log(con, "PORT", None, f"{a}->{b}:{cart}")
        con.commit()
        return
    if cmd == "SPEC":
        sep = chr(9)
        print("action\tn\tkind")
        rows = list(con.execute(
            "SELECT action, COUNT(*) n FROM events GROUP BY 1 ORDER BY n DESC"
        ))
        for r in rows:
            kind = "read" if r["action"] in READS else "write"
            print(f"{r['action']}{sep}{r['n']}{sep}{kind}")
        payload = readout(con)
        print("DEBT")
        mapping = {
            "Q-GAP-C-HOP": "C без пакетов",
            "Q-GAP-C-MASS": "перекос C",
            "Q-GAP-JUNK": "посадка грязная",
            "Q-GAP-CHARGE": "заряд <20%",
        }
        for oid, warn in mapping.items():
            row = con.execute("SELECT status, title FROM objects WHERE id=?", (oid,)).fetchone()
            if not row:
                continue
            live = warn in payload["warns"]
            print(sep.join([oid, row["status"], warn, "LIVE" if live else "settled"]))
        print("RULE verb only if same LIVE GAP >= 3 and PORT cartesian not MUL")
        print(f"cells={payload['neq']} charge={payload['charge']} warn={len(payload['warns'])}")
        write_lang_from_db(con, payload)
        print(f"wrote {LANG_FROM.name}")
        con.commit()
        return
    if cmd == "CAT":
        name = Path(arg or "LANG-FROM-DB.md").name
        if name not in {"LANG-FROM-DB.md", "LANG.md"}:
            raise SystemExit("CAT only LANG-FROM-DB.md")
        target = HERE / name
        text = target.read_text(encoding="utf-8") if target.exists() else ""
        print(text)
        return
    if cmd == "PURGE":

        cmd_exec(argparse.Namespace(line=["TAKE", "JUNK"], file=None))
        return
    if cmd == "PROBE":
        bits = arg.split()
        if len(bits) != 2:
            raise SystemExit("PROBE from to   например PROBE C A")
        a, b = bits[0].upper(), bits[1].upper()
        src = resolve_set(con, a)
        dst = resolve_set(con, b)
        import re as _re2
        stop = set("и в на не что как для это the a an of to for and or but from with без при this that".split())
        def toks(title):
            return {w for w in _re2.findall(r"[A-Za-zА-Яа-яёЁ0-9]{4,}", (title or "").lower()) if w not in stop}
        bag_d = [(r, toks(r["title"])) for r in dst]
        print(f"PROBE {a}→{b}")
        n = 0
        for s in src:
            st = toks(s["title"])
            if not st:
                continue
            for d, dt in bag_d:
                if s["id"] == d["id"]:
                    continue
                hit = st & dt
                if not hit:
                    continue
                n += 1
                if n <= 40:
                    print(f"{s['id']} -?-> {d['id']}\t{','.join(sorted(hit)[:6])}")
        print(f"candidates={n}")
        log(con, "PROBE", None, f"{a}->{b}:{n}")
        con.commit()
        return
    if cmd == "WIRE":
        bits = arg.split()
        if len(bits) < 2:
            raise SystemExit("WIRE from to [rel]")
        frm, to = bits[0], bits[1]
        rel = bits[2] if len(bits) > 2 else "candidate"
        for oid in (frm, to):
            if not con.execute("SELECT id FROM objects WHERE id=?", (oid,)).fetchone():
                raise SystemExit(f"нет {oid}")
        exists = con.execute(
            "SELECT 1 FROM links WHERE from_id=? AND to_id=? AND rel=?",
            (frm, to, rel),
        ).fetchone()
        if exists:
            print(f"skip {frm} -{rel}-> {to}")
            return
        con.execute(
            "INSERT INTO links(from_id,to_id,rel,note) VALUES (?,?,?,?)",
            (frm, to, rel, "WIRE"),
        )
        log(con, "WIRE", frm, f"{rel}->{to}")
        con.commit()
        print(f"WIRE {frm} -{rel}-> {to}")
        return
    if cmd in {"MUL", "TIMES"}:
        raise SystemExit("MUL запрещён: A×B склеивает кластеры. Морфизм только PACKET.")
    raise SystemExit("unknown %s. алфавит: %s" % (cmd or line, " ".join(VERBS)))



def main() -> None:
    p = argparse.ArgumentParser(description="Ступень 4 портфеля: действия над SQLite")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(func=cmd_init)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("open").set_defaults(func=cmd_open)
    sub.add_parser("check").set_defaults(func=cmd_check)
    sub.add_parser("next").set_defaults(func=cmd_next)
    sub.add_parser("export").set_defaults(func=cmd_export)
    a = sub.add_parser("add")
    a.add_argument("--id", required=True)
    a.add_argument("--cluster", default="B")
    a.add_argument("--layer", type=int, default=1)
    a.add_argument("--type", required=True)
    a.add_argument("--title", required=True)
    a.add_argument("--status", default="open")
    a.add_argument("--body", default="")
    a.add_argument("--session", default="")
    a.set_defaults(func=cmd_add)
    e = sub.add_parser("exec")
    e.add_argument("line", nargs="*")
    e.add_argument("--file", dest="file")
    e.set_defaults(func=cmd_exec)
    ns = p.parse_args()
    if ns.cmd != "init" and not DB.exists():
        raise SystemExit("нет базы: сначала python3 pm.py init")
    ns.func(ns)


if __name__ == "__main__":
    main()

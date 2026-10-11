"""Готовит корпуса для измерений: копия 96 файлов репозитория, плоский дамп, чат, базы картотеки.

    python3 prepare.py WORK_DIR

Репозиторий: те же 96 файлов, что в прежнем опыте (без attachments/, .grok/, public/__grok/, server/, scripts/grok-pwa*,
package-lock и без самой картотеки). Чат: attachments/ChatGPT_….md.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import cards  # noqa: E402

ROOT = HERE.parent.parent.parent
EXCLUDE = ("attachments/*", ".grok/*", "public/__grok/*", "server/*", "scripts/grok-pwa*", "*package-lock.json", "engine/cards/*")
CHAT_SRC = ROOT / "attachments" / "ChatGPT_2026_09_18__1900.md"


def repo_files() -> list:
    return cards.list_files(ROOT, EXCLUDE)


def copy_repo(dst: Path, files: list):
    shutil.rmtree(dst, ignore_errors=True)
    for f in files:
        (dst / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / f, dst / f)


def flat_dump(repo: Path, files: list) -> str:
    parts = []
    for f in files:
        lines = cards.split_lines((repo / f).read_text(encoding="utf-8", errors="replace"))
        body = "\n".join(f"{i + 1:5d}| {ln}" for i, ln in enumerate(lines))
        parts.append(f"=== {f} ({len(lines)} lines) ===\n{body}")
    return "\n\n".join(parts)


def raw_catalog_chat(st: cards.Store) -> str:
    """Каталог для варианта «сырой файл + обзор»: те же строки, но с диапазонами строк файла вместо id карточек."""
    out = []
    for g in st.con.execute("SELECT * FROM groups WHERE kind='thread' ORDER BY ord"):
        out.append(f"THREAD {g['title']} | {g['summary']}")
        for r in st.con.execute("SELECT * FROM cards WHERE group_id=? ORDER BY id", (g["id"],)):
            import json
            m = json.loads(r["meta"])
            a = m["file_line0"]
            out.append(f"{r['id']} | chat.md:L{a}-{a + r['nlines'] - 1} | {m.get('ts', '')[5:]} | ~{cards.fmt_tok(r['ntok'])} tok | {r['summary']}")
    return "\n".join(out)


def prepare(work: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    files = repo_files()
    copy_repo(work / "repo", files)
    (work / "flat.txt").write_text(flat_dump(work / "repo", files), encoding="utf-8")
    (work / "neutral").mkdir(exist_ok=True)
    db = work / "repo.sqlite"
    db.unlink(missing_ok=True)
    st = cards.Store(db)
    st.index_code(work / "repo", files=files)
    st.con.close()
    (work / "chat").mkdir(exist_ok=True)
    shutil.copy(CHAT_SRC, work / "chat" / "chat.md")
    cdb = work / "chat.sqlite"
    cdb.unlink(missing_ok=True)
    cs = cards.Store(cdb)
    res = cs.index_chat(work / "chat" / "chat.md")
    (work / "chat_raw_catalog.txt").write_text(raw_catalog_chat(cs), encoding="utf-8")
    cs.con.close()
    return dict(files=len(files), chat=res)


if __name__ == "__main__":
    print(prepare(Path(sys.argv[1])))

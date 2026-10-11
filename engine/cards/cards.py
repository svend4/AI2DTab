#!/usr/bin/env python3
"""Картотека (прототип): обзор-каталог -> карточки по id -> разделы; журнал фактов; правки патчем.

Зачем. Модель ничего не помнит между вызовами: каждый вызов несёт весь диалог. Поэтому важно не то,
что лежит в хранилище, а то, что попадает в диалог. Картотека пускает туда по ступеням «от общего к частному»:
каталог групп -> строки карточек -> оглавление карточки -> раздел или диапазон строк. Правки идут патчем
с проверкой версии, а факты лежат в журнале с версиями (в промпт идёт только срез «действует»).

Только стандартная библиотека (sqlite3 с FTS5). Тексты, которые видит модель (выдача команд и описания
инструментов), по-английски: так меньше токенов. Комментарии и документация по-русски, как в остальном комплекте.

    python3 cards.py --db cards.sqlite index-code /путь/к/репозиторию
    python3 cards.py --db cards.sqlite index-chat attachments/ChatGPT_….md
    python3 cards.py --db cards.sqlite catalog [--group g3]
    python3 cards.py --db cards.sqlite find "слова запроса"
    python3 cards.py --db cards.sqlite open f012 [--section 3 | --lines 100-160]
    python3 cards.py --db cards.sqlite patch f012 --version 1 --old "…" --new "…"
    python3 cards.py --db cards.sqlite fact budget "96000 EUR" --source "реплика 8"
    python3 cards.py --db cards.sqlite facts | history budget
    python3 cards.py --db cards.sqlite refresh      # обновить индекс по project.json (код, стол, чаты)
    python3 cards.py --db cards.sqlite canon        # канон стола: принятые человеком факты и решения (только чтение)
    python3 cards.py --db cards.sqlite promote budget [--apply]   # предложить факт журнала столу (raw; принимает человек)
    python3 cards.py --db cards.sqlite handoff      # стартовая справка новой сессии
    python3 cards.py --db cards.sqlite serve --refresh   # MCP по stdio: инструменты для Claude Code
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import glob
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = Path(os.environ.get("CARDS_DB") or HERE / "cards.sqlite")

OPEN_BUDGET_TOK = 3000    # сколько токенов за раз отдаёт open
OPEN_FULL_TOK = 6000      # потолок для open(full=true)
CHUNK_LINES = 24          # размер куска индекса: не больше строк…
CHUNK_CHARS = 1400        # …и не больше символов (одна длинная строка = один кусок)
SUMMARY_MAX = 230         # длина строки обзора в каталоге
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".mjs", ".md", ".sql", ".sh", ".css", ".html"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, group_id TEXT REFERENCES groups(id), kind TEXT NOT NULL, title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', outline TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL,
  nlines INTEGER NOT NULL, ntok INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', src TEXT, src_hash TEXT, meta TEXT NOT NULL DEFAULT '{}',
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_group ON cards(group_id);
CREATE INDEX IF NOT EXISTS idx_cards_src ON cards(src);
CREATE TABLE IF NOT EXISTS card_versions (
  card_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, ts TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', PRIMARY KEY (card_id, version)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_card ON chunks(card_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, title, tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, key_norm TEXT NOT NULL, value TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key_norm, status);
"""


# ---------------------------------------------------------------- настройки проекта

PROJECT_DEFAULT = {
    # что индексировать как код/документы (пути от папки конфига); чаты индексируются отдельно, поэтому attachments/ из кода исключён
    "code": {"root": "../..", "exclude": ["attachments/*", ".grok/*", "public/__grok/*", "server/*", "scripts/grok-pwa*",
                                          "*package-lock.json", "engine/cards/*"]},
    "chats": ["../../attachments/*.md"],                 # экспорты ChatGPT в markdown
    "pm_dir": "..",                                      # где лежат pm.py и project-store.sqlite («стол»)
    # куда падает факт журнала при promote (всегда со статусом raw). mcp_apply=false: агент через MCP может только посмотреть, что было бы записано;
    # писать в базу стола (она лежит в репозитории) человек разрешает здесь или делает сам: cards.py promote КЛЮЧ --apply
    "promote": {"cluster": "C", "layer": 1, "type": "fact", "mcp_apply": False},
    "canon_types": ["fact", "decision"],                 # какие принятые объекты стола показывать как канон
}


def load_project(path=None) -> dict:
    """Настройки проекта: engine/cards/project.json поверх значений по умолчанию. Пути в нём считаются от папки конфига."""
    cfg = json.loads(json.dumps(PROJECT_DEFAULT))
    p = Path(path) if path else HERE / "project.json"
    base = HERE
    if p.exists():
        user = json.loads(p.read_text(encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
        base = p.resolve().parent
    cfg["_base"] = str(base)
    return cfg


def project_path(proj: dict, rel: str) -> Path:
    return (Path(proj["_base"]) / rel).resolve()


# Правила памяти: едут и в instructions MCP-сервера, и в справку новой сессии (handoff)
PROTOCOL = """This project keeps its memory outside the conversation. Look things up instead of re-reading them.
- Material (code, docs, chat exports): catalog() -> find(query) -> open(id, section|lines). Cite card ids and line numbers.
- Conversation facts: when the user states or corrects a datum, or you produce something that may be asked about later (names, numbers,
  decisions), call fact_set(key, value, source) with a short stable key (budget, deadline, lead.name). A correction overwrites the same
  key and history is kept (fact_history). Read the current state with facts().
- The desk's canon (facts and decisions a human accepted): canon(). It outranks the ledger. To propose a ledger fact to the desk call
  fact_promote(key, apply=true): it creates a RAW object; only a human accepts it (ACCEPT).
- Edits: patch(id, version, old, new); on STALE re-apply with the version shown. Chat cards are read-only history."""


# ---------------------------------------------------------------- мелочи

def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "replace")).hexdigest()


def est_tokens(s: str) -> int:
    """Грубая оценка: латиница и код ~3.6 симв./токен, кириллица и прочее ~2.2. Настоящие токены считает API."""
    ascii_n = len(s.encode("ascii", "ignore"))
    return max(1, int(ascii_n / 3.6 + (len(s) - ascii_n) / 2.2))


def fmt_tok(n: int) -> str:
    if n < 1000:
        return str(n)
    return f"{n / 1000:.1f}K" if n < 10000 else f"{round(n / 1000)}K"


def count_lines(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def split_lines(text: str) -> list:
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def numbered(lines: list, first: int) -> str:
    return "\n".join(f"{first + i:5d}| {ln}" for i, ln in enumerate(lines))


# ---------------------------------------------------------------- слова: идентификаторы, русская основа, запрос

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")


def split_idents(text: str, limit: int = 60) -> str:
    """parse_neq_title / parseNeqTitle -> «parse neq title»: чтобы находилось по обычным словам."""
    seen, out = set(), []
    for m in _IDENT.finditer(text):
        w = m.group(0)
        if "_" not in w and not any(c.isupper() for c in w[1:]):
            continue
        parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", w).replace("_", " ").lower().split()
        if len(parts) > 1:
            s = " ".join(parts)
            if s not in seen:
                seen.add(s)
                out.append(s)
                if len(out) >= limit:
                    break
    return " ".join(out)


_RU_SUF = ("иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ией", "иях", "ях", "ах", "ов", "ев",
           "ей", "ом", "ем", "ам", "ям", "ию", "ью", "ия", "ие", "ий", "ый", "ой", "ая", "яя", "ое", "ее", "ые",
           "ую", "юю", "ою", "ею", "ых", "их", "ье", "ья")
_RU_VOW = "аяуюыиеоьй"


def ru_stem(w: str) -> str:
    """Грубая основа: срезаем падежное окончание. Нужна только для префиксного поиска («занятости» ~ «занятость»)."""
    w = w.lower().replace("ё", "е")
    for suf in _RU_SUF:
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            w = w[: -len(suf)]
            break
    t = w.rstrip(_RU_VOW)
    return t if len(t) >= 4 else w


_STOP = set("""a an the of in on at to for is are was were be by with from which what where who when how does do did
and or not that this these those it its as into than then there their about also can could should would
и в на по с к у о об от до за из для что как это то же ли не но а или при под над про без чем где когда
какой какая какие какого каком кто чей чьё""".split())


def query_exprs(q: str):
    """Запрос -> (список выражений FTS5, список подстрок для подсветки)."""
    exprs, marks = [], []
    for m in re.finditer(r'"([^"]+)"|(\S+)', q):
        if m.group(1):
            phrase = re.sub(r"[^\w\s]", " ", m.group(1), flags=re.UNICODE).strip()
            if phrase:
                exprs.append('"' + phrase + '"')
                marks.append(phrase.lower())
            continue
        raw = m.group(2)
        for part in re.findall(r"\w+\*?", raw, flags=re.UNICODE):
            star = part.endswith("*")
            w = part.rstrip("*").lower()
            if not w or w in _STOP:
                continue
            if star:
                exprs.append(f'"{w}"*')
                marks.append(w)
            elif re.search(r"[а-яё]", w) and len(w) >= 5:
                s = ru_stem(w)
                exprs.append(f'"{s}"*')
                marks.append(s)
            else:
                exprs.append(f'"{w}"')
                marks.append(w)
    return exprs, marks


# ---------------------------------------------------------------- оглавления и обзор файлов

def outline_py(text: str) -> list:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return []
    out = []
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append((f"def {n.name}", n.lineno, n.end_lineno or n.lineno))
        elif isinstance(n, ast.ClassDef):
            out.append((f"class {n.name}", n.lineno, n.end_lineno or n.lineno))
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.append((f"  def {n.name}.{m.name}", m.lineno, m.end_lineno or m.lineno))
    return out


_TS_DECL = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?"
                      r"(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)")


def outline_ts(text: str) -> list:
    lines = text.split("\n")
    starts = []
    for i, ln in enumerate(lines, 1):
        m = _TS_DECL.match(ln)
        if m:
            starts.append((i, m.group(1), m.group(2)))
    out = []
    for j, (i, kw, name) in enumerate(starts):
        end = starts[j + 1][0] - 1 if j + 1 < len(starts) else len(lines)
        while end > i and not lines[end - 1].strip():
            end -= 1
        out.append((f"{kw} {name}", i, end))
    return out


_QUOTE = re.compile(r"^(?:>\s?)+")
_DOC_TITLE = re.compile(r"^\*\*(Document:.+?)\*\*\s*$")


def unquote(ln: str) -> str:
    """Ответы ChatGPT часто целиком в цитате: «> # Заголовок». Снимаем «> » перед разбором."""
    return _QUOTE.sub("", ln)


def outline_md(text: str, maxlevel: int = 3, skip: tuple = ()) -> list:
    lines = text.split("\n")
    fence, heads = False, []
    for i, raw in enumerate(lines, 1):
        ln = unquote(raw)
        if ln.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence or raw in skip:
            continue
        m = re.match(r"^(#{1,%d})\s+(.+?)\s*#*\s*$" % maxlevel, ln)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))
            continue
        m = _DOC_TITLE.match(ln)
        if m:
            heads.append((i, 1, m.group(1).strip()))
    out = []
    for j, (i, lvl, label) in enumerate(heads):
        end = heads[j + 1][0] - 1 if j + 1 < len(heads) else len(lines)
        out.append(("#" * lvl + " " + label[:90], i, end))
    return out


def subdivide(outline: list, lines: list, first: int = 1, last: int | None = None, max_tok: int = 4500, target_tok: int = 2000) -> list:
    """Раздел больше max_tok режем на части ~target_tok по пустым строкам: у любой большой карточки есть куда зайти."""
    last = last if last is not None else len(lines)
    if not outline:
        outline = [("(whole)", first, last)]
    out = []
    for label, a, b in outline:
        seg = lines[a - 1:b]
        if est_tokens("\n".join(seg)) <= max_tok:
            out.append((label, a, b))
            continue
        parts, start, acc = [], a, 0
        for k, raw in enumerate(seg):
            acc += est_tokens(raw) + 1
            at_blank = not unquote(raw).strip()
            if acc >= target_tok and at_blank and a + k < b:
                parts.append((start, a + k))
                start, acc = a + k + 1, 0
        parts.append((start, b))
        base = "" if label == "(whole)" else clip(label, 70) + " · "
        for n, (x, y) in enumerate(parts, 1):
            lead = next((unquote(l).strip(" #*`-") for l in lines[x - 1:y] if unquote(l).strip(" #*`-")), "")
            out.append((f"{base}part {n}/{len(parts)}: {clip(lead, 46)}", x, y))
    return out


_SQL_DECL = re.compile(r"^\s*CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"`]+)", re.I)


def outline_sql(text: str) -> list:
    lines = text.split("\n")
    starts = [(i, m.group(1).lower(), m.group(2)) for i, ln in enumerate(lines, 1) for m in [_SQL_DECL.match(ln)] if m]
    out = []
    for j, (i, kw, name) in enumerate(starts):
        end = starts[j + 1][0] - 1 if j + 1 < len(starts) else len(lines)
        out.append((f"{kw} {name}", i, max(i, end)))
    return out


MAX_OUTLINE = 40      # оглавление, которое печатает open, не длиннее


def coarsen(entries: list, lines: list, min_tok: int = 1800) -> list:
    """Подряд идущие мелкие разделы склеиваем в диапазоны ≥ min_tok токенов: у документа с 800 заголовками оглавление остаётся читаемым."""
    toks = [est_tokens("\n".join(lines[a - 1:b])) for _, a, b in entries]
    while True:
        groups, cur = [], None
        for (lbl, a, b), t in zip(entries, toks):
            if cur is None:
                cur = dict(first=lbl, last=lbl, a=a, b=b, t=t, n=1)
            else:
                cur.update(last=lbl, b=b, t=cur["t"] + t, n=cur["n"] + 1)
            if cur["t"] >= min_tok:
                groups.append(cur)
                cur = None
        if cur:
            if groups and cur["t"] < min_tok / 2:
                g = groups[-1]
                g.update(last=cur["last"], b=cur["b"], t=g["t"] + cur["t"], n=g["n"] + cur["n"])
            else:
                groups.append(cur)
        if len(groups) <= MAX_OUTLINE or min_tok > 10 ** 6:
            break
        min_tok = int(min_tok * 1.6)
    return [(g["first"] if g["n"] == 1 else f"{clip(g['first'], 52)} … {clip(g['last'], 40)} ({g['n']} sections)", g["a"], g["b"]) for g in groups]


def navigable(entries: list, lines: list) -> list:
    """Тонкие разделы -> оглавление для open: большие режем на части, мелкие склеиваем, чтобы вышло не больше MAX_OUTLINE строк."""
    big = est_tokens("\n".join(lines)) > OPEN_BUDGET_TOK
    out = subdivide(entries, lines) if big else list(entries)
    if len(out) > MAX_OUTLINE:
        out = coarsen(out, lines)
    return out


def outline_for(rel: str, text: str):
    """-> (оглавление для open, тонкие разделы для обзора и для find)."""
    ext = Path(rel).suffix.lower()
    if ext == ".py":
        entries = outline_py(text)
    elif ext in (".ts", ".tsx", ".js", ".mjs"):
        entries = outline_ts(text)
    elif ext == ".md":
        entries = outline_md(text)
    elif ext == ".sql":
        entries = outline_sql(text)
    else:
        entries = []
    return navigable(entries, split_lines(text)), entries


def summarize_file(rel: str, text: str, outline: list) -> str:
    ext = Path(rel).suffix.lower()
    lead = ""
    if ext == ".py":
        try:
            lead = (ast.get_docstring(ast.parse(text)) or "").strip().split("\n")[0]
        except (SyntaxError, ValueError):
            pass
    if not lead and ext == ".md" and outline:
        lead = outline[0][0].lstrip("# ")
    if not lead:
        for ln in text.split("\n")[:14]:
            s = ln.strip()
            if not s or s.startswith(("#!", "import ", "from ", "'use ", '"use ', "@import", "<!")):
                continue
            s = s.lstrip("/*#-– ").strip()
            if s:
                lead = s
                break
    if ext == ".md":
        names = [lbl.lstrip("# ") for lbl, _, _ in outline[1:5]]
        tail = ("sections: " + "; ".join(names) + (f" (+{len(outline) - 5})" if len(outline) > 5 else "")) if names else ""
    else:
        top = [lbl.split(" ", 1)[1] for lbl, _, _ in outline if not lbl.startswith(" ") and " " in lbl]
        tail = ("defs: " + ", ".join(top[:9]) + (f" (+{len(top) - 9})" if len(top) > 9 else "")) if top else ""
    return clip(" | ".join(x for x in (clip(lead, 90), tail) if x), SUMMARY_MAX)


def make_chunks(text: str) -> list:
    lines = split_lines(text)
    out, start, chars = [], 0, 0
    for i, ln in enumerate(lines):
        chars += len(ln) + 1
        if (i - start + 1) >= CHUNK_LINES or chars >= CHUNK_CHARS:
            out.append((start + 1, i + 1, "\n".join(lines[start:i + 1])))
            start, chars = i + 1, 0
    if start < len(lines):
        out.append((start + 1, len(lines), "\n".join(lines[start:])))
    return out


def list_files(root: Path, exclude: tuple = ()) -> list:
    try:
        raw = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True, check=True).stdout
        files = [f for f in raw.split("\n") if f]
    except (OSError, subprocess.CalledProcessError):
        files = []
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d not in (".git", "node_modules", "__pycache__")]
            files += [os.path.relpath(os.path.join(dp, f), root) for f in fn]
    keep = []
    for f in sorted(files):
        if Path(f).suffix.lower() not in CODE_EXT:
            continue
        if any(fnmatch.fnmatch(f, pat) or f.startswith(pat.rstrip("*")) for pat in exclude):
            continue
        keep.append(f)
    return keep


# ---------------------------------------------------------------- разбиение чата на ветки (TextTiling в малом)

_WORD = re.compile(r"[A-Za-zА-Яа-яЁё]{4,}")


def term_of(w: str) -> str:
    w = w.lower().replace("ё", "е")
    return ru_stem(w) if re.match(r"[а-я]", w) else w


def _cos(a: dict, b: dict) -> float:
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(k, 0.0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def segment_vectors(vecs: list, target: int | None = None, k: int = 2, w: int = 3, min_gap: int = 3) -> list:
    """Границы между соседними репликами по провалам сходства. Возвращает индексы g: граница после реплики g."""
    n = len(vecs)
    if n < 2 * min_gap:
        return []

    def add(vs):
        acc: dict = defaultdict(float)
        for v in vs:
            for t, x in v.items():
                acc[t] += x
        return acc

    sims = [_cos(add(vecs[max(0, g - k + 1):g + 1]), add(vecs[g + 1:g + 1 + k])) for g in range(n - 1)]
    depth = []
    for g, s in enumerate(sims):
        left = max(sims[max(0, g - w):g + 1])
        right = max(sims[g:min(len(sims), g + w + 1)])
        depth.append((left - s) + (right - s))
    target = target or max(2, min(12, round(n / 8)))
    chosen: list = []
    for g in sorted(range(len(depth)), key=lambda x: -depth[x]):
        if all(abs(g - c) >= min_gap for c in chosen):
            chosen.append(g)
        if len(chosen) >= target - 1:
            break
    return sorted(chosen)


# ---------------------------------------------------------------- хранилище

class Store:
    def __init__(self, db_path=DEFAULT_DB, root=None, project=None):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(self.path, timeout=30)
        self.con.row_factory = sqlite3.Row
        try:
            self.con.execute("PRAGMA busy_timeout = 30000")
            self.con.execute("PRAGMA journal_mode = WAL")        # по серверу на сессию: несколько процессов читают и пишут одну базу
        except sqlite3.DatabaseError:
            pass
        try:
            self.con.executescript(SCHEMA)
        except sqlite3.OperationalError as e:  # нет FTS5 в этой сборке SQLite
            raise SystemExit(f"нужен SQLite с FTS5: {e}")
        if "pm_id" not in {r["name"] for r in self.con.execute("PRAGMA table_info(facts)")}:
            self.con.execute("ALTER TABLE facts ADD COLUMN pm_id TEXT")     # id объекта стола, в который факт предложили (promote)
        self._root_override = Path(root).resolve() if root else None
        self.project = project or load_project()

    # --- служебное
    def get_meta(self, key, default=None):
        r = self.con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default

    def set_meta(self, key, value):
        self.con.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

    @property
    def root(self):
        if self._root_override:
            return self._root_override
        r = self.get_meta("root")
        return Path(r) if r else None

    def _next_id(self, prefix: str) -> str:
        r = self.con.execute("SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) m FROM cards WHERE id GLOB ?", (len(prefix) + 1, prefix + "[0-9]*")).fetchone()
        return f"{prefix}{(r['m'] or 0) + 1:03d}"

    def _group_for(self, kind: str, title: str, ord_: int, summary: str = "") -> str:
        r = self.con.execute("SELECT id FROM groups WHERE kind=? AND title=?", (kind, title)).fetchone()
        if r:
            self.con.execute("UPDATE groups SET ord=?, summary=? WHERE id=?", (ord_, summary, r["id"]))
            return r["id"]
        n = self.con.execute("SELECT COUNT(*) c FROM groups").fetchone()["c"]
        gid = f"g{n + 1}"
        while self.con.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
            n += 1
            gid = f"g{n + 1}"
        self.con.execute("INSERT INTO groups(id,title,summary,kind,ord) VALUES(?,?,?,?,?)", (gid, title, summary, kind, ord_))
        return gid

    def _card(self, cid: str):
        return self.con.execute("SELECT * FROM cards WHERE id=?", (cid,)).fetchone()

    def _drop_chunks(self, cid: str):
        ids = [r["id"] for r in self.con.execute("SELECT id FROM chunks WHERE card_id=?", (cid,))]
        if ids:
            self.con.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
            self.con.execute("DELETE FROM chunks WHERE card_id=?", (cid,))

    def _reindex_chunks(self, cid: str, title: str, text: str):
        self._drop_chunks(cid)
        for a, b, chunk in make_chunks(text):
            cur = self.con.execute("INSERT INTO chunks(card_id,start_line,end_line) VALUES(?,?,?)", (cid, a, b))
            extra = split_idents(chunk)
            self.con.execute("INSERT INTO chunks_fts(rowid,text,title) VALUES(?,?,?)", (cur.lastrowid, chunk + ("\n" + extra if extra else ""), title))

    # --- индексация: файлы
    def index_code(self, root, files=None, exclude=(), max_bytes=400_000, prune=False) -> dict:
        root = Path(root).resolve()
        self.set_meta("root", str(root))
        paths = files if files is not None else list_files(root, tuple(exclude))
        stat = Counter()
        seen = set()
        for rel in paths:
            try:
                raw = (root / rel).read_bytes()
            except OSError:
                continue
            if len(raw) > max_bytes or b"\x00" in raw[:2048]:
                stat["skipped"] += 1
                continue
            text = raw.decode("utf-8", "replace")
            seen.add(rel)
            h = sha1(text)
            row = self.con.execute("SELECT id, src_hash, status FROM cards WHERE src=?", (rel,)).fetchone()
            if row is None:
                self._insert_file_card(rel, text, h)
                stat["new"] += 1
            elif row["src_hash"] != h or row["status"] != "active":
                self._replace_text(row["id"], text, h, note="reindex", status="active")
                stat["changed"] += 1
            else:
                stat["same"] += 1
        if prune:
            for r in self.con.execute("SELECT id, src FROM cards WHERE kind='file' AND status='active'").fetchall():
                if r["src"] not in seen:
                    self.con.execute("UPDATE cards SET status='archived' WHERE id=?", (r["id"],))
                    stat["archived"] += 1
        self._regroup_files()
        self.con.commit()
        return dict(stat)

    def _insert_file_card(self, rel, text, h):
        cid = self._next_id("f")
        outline, entries = outline_for(rel, text)
        meta = {"heads": entries} if len(entries) > MAX_OUTLINE else {}
        self.con.execute(
            "INSERT INTO cards(id,kind,title,summary,outline,body,nlines,ntok,version,status,src,src_hash,meta,updated) "
            "VALUES(?,?,?,?,?,?,?,?,1,'active',?,?,?,?)",
            (cid, "file", rel, summarize_file(rel, text, entries), json.dumps(outline, ensure_ascii=False), text,
             count_lines(text), est_tokens(text), rel, h, json.dumps(meta, ensure_ascii=False), now()))
        self._reindex_chunks(cid, rel, text)
        return cid

    def _replace_text(self, cid, text, h, note="", status=None):
        """Новая версия карточки: старый текст уходит в card_versions, оглавление/обзор/куски пересчитываются."""
        c = self._card(cid)
        self.con.execute("INSERT OR REPLACE INTO card_versions(card_id,version,body,ts,note) VALUES(?,?,?,?,?)",
                         (cid, c["version"], c["body"], now(), note))
        meta = json.loads(c["meta"])
        if c["kind"] == "file":
            outline, entries = outline_for(c["src"] or c["title"], text)
            summary = summarize_file(c["src"] or c["title"], text, entries)
            meta.pop("heads", None)
            if len(entries) > MAX_OUTLINE:
                meta["heads"] = entries
        else:
            outline, summary = json.loads(c["outline"]), c["summary"]
        self.con.execute(
            "UPDATE cards SET body=?, nlines=?, ntok=?, version=version+1, outline=?, summary=?, src_hash=?, meta=?, updated=?, status=COALESCE(?, status) WHERE id=?",
            (text, count_lines(text), est_tokens(text), json.dumps(outline, ensure_ascii=False), summary, h,
             json.dumps(meta, ensure_ascii=False), now(), status, cid))
        self._reindex_chunks(cid, c["title"], text)

    def _regroup_files(self, limit: int = 18):
        """Группы = каталоги. Верхний уровень, а слишком большие (> limit файлов) делим глубже."""
        rows = self.con.execute("SELECT id, src, nlines FROM cards WHERE kind='file' AND status='active'").fetchall()

        def dir_key(rel, depth):
            d = rel.split("/")[:-1]
            return "/".join(d[:depth]) if d else "(root)"

        keys = {r["src"]: dir_key(r["src"], 1) for r in rows}
        depth = 1
        while depth < 5:
            big = {k for k, n in Counter(keys.values()).items() if n > limit}
            if not big:
                break
            depth += 1
            for rel in keys:
                if keys[rel] in big and len(rel.split("/")) - 1 >= depth:
                    keys[rel] = dir_key(rel, depth)
        by = defaultdict(list)
        for r in rows:
            by[keys[r["src"]]].append((r["id"], r["src"].split("/")[-1], r["nlines"]))
        for ord_, key in enumerate(sorted(by)):
            items = by[key]
            summary = f"{len(items)} files, {sum(i[2] for i in items)}L: " + ", ".join(i[1] for i in items[:7]) + (f" (+{len(items) - 7})" if len(items) > 7 else "")
            gid = self._group_for("dir", key, ord_, summary)
            self.con.executemany("UPDATE cards SET group_id=? WHERE id=?", [(gid, i[0]) for i in items])

    # --- индексация: markdown-чат (пары «you asked» / «chatgpt response»)
    def index_chat(self, path, prefix="t", target_groups=None) -> dict:
        path = Path(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.split("\n")
        starts = [i for i, l in enumerate(lines) if l == "# you asked"]
        if not starts:
            raise SystemExit("в файле нет заголовков «# you asked»: ожидается экспорт ChatGPT в markdown")
        bounds = starts + [len(lines)]
        made, vecs, texts = [], [], []
        mine = (path.name + "#", len(path.name) + 1)                   # карточки этого файла: src = «имя#номер»
        old_groups = {r[0] for r in self.con.execute("SELECT DISTINCT group_id FROM cards WHERE kind='turn' AND substr(src,1,?)=?", (mine[1], mine[0])) if r[0]}
        for k, a in enumerate(starts):
            block = lines[a:bounds[k + 1]]
            while block and not block[-1].strip():
                block.pop()
            body = "\n".join(block)
            ts = ""
            for ln in block[:8]:
                m = re.match(r"message time:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})", ln)
                if m:
                    ts = f"{m.group(1)} {m.group(2)}"
                    break
            r = next((j for j, l in enumerate(block) if l == "# chatgpt response"), len(block))
            q_lines = [l for l in block[1:r] if l.strip() and not l.startswith("message time:") and l.strip() != "---"]
            q = q_lines[0].strip() if q_lines else "(empty)"
            base = outline_md(body, 3, skip=("# you asked", "# chatgpt response"))
            resp_first = next((unquote(l).strip(" *-") for l in block[r + 1:] if unquote(l).strip(" *-")), "")
            entries = [(clip("Q: " + q, 90), 1, max(1, r))]
            if not base or base[0][1] - (r + 1) >= 3:       # вступление ответа до первого заголовка тоже раздел
                entries.append((clip("A: " + resp_first, 90), r + 1, (base[0][1] - 1) if base else len(block)))
            entries += base
            outline = navigable(entries, block)
            heads = [lbl.lstrip("# ").strip() for lbl, _, _ in base]
            if not heads:
                tail = "A: " + clip(resp_first, 150)
            else:
                shown = " · ".join(clip(h, 44) for h in heads[:6]) if len(heads) <= 6 else \
                    " · ".join(clip(h, 44) for h in heads[:4]) + f" … {clip(heads[-1], 44)} ({len(heads)} sections)"
                tail = ("A: " + clip(resp_first, 70) + " | " if len(q) < 14 else "") + "§ " + shown
            summary = clip(f"Q: {q[:70]} | {tail}", SUMMARY_MAX + 80)
            row = self.con.execute("SELECT id FROM cards WHERE kind='turn' AND src=?", (f"{path.name}#{k + 1}",)).fetchone()
            cid = row["id"] if row else self._next_id(prefix)
            meta = dict(ts=ts, file=path.name, file_line0=a + 1, turn=k + 1, ro=True, hint=(q if len(q) >= 14 else resp_first))
            if len(entries) > MAX_OUTLINE:
                meta["heads"] = entries                      # тонкие метки для find; open показывает укрупнённое оглавление
            if row:
                self.con.execute("DELETE FROM cards WHERE id=?", (cid,))
            self.con.execute(
                "INSERT INTO cards(id,kind,title,summary,outline,body,nlines,ntok,version,status,src,src_hash,meta,updated) "
                "VALUES(?,?,?,?,?,?,?,?,1,'active',?,?,?,?)",
                (cid, "turn", clip(q, 100), summary, json.dumps(outline, ensure_ascii=False), body, len(block), est_tokens(body),
                 f"{path.name}#{k + 1}", sha1(body), json.dumps(meta, ensure_ascii=False), now()))
            self._reindex_chunks(cid, f"{ts} {q}", body)
            made.append(cid)
            toks = Counter(term_of(w) for w in _WORD.findall(body))
            texts.append(toks)
        # ветки по провалам сходства
        n = len(made)
        df = Counter(t for c in texts for t in c)
        idf = {t: math.log(n / d) for t, d in df.items() if 2 <= d <= max(2, int(n * 0.5))}
        vecs = [{t: (1 + math.log(c)) * idf[t] for t, c in toks.items() if t in idf} for toks in texts]
        cuts = segment_vectors(vecs, target=target_groups)
        edges = [0] + [g + 1 for g in cuts] + [n]
        seg_pairs = list(zip(edges, edges[1:]))
        seg_terms = [Counter(t for toks in texts[a:b] for t, c in toks.items() for _ in range(min(c, 5))) for a, b in seg_pairs]
        seg_df = [Counter(t for toks in texts[a:b] for t in toks) for a, b in seg_pairs]      # в скольких репликах ветки встречается
        gdf = Counter(t for c in seg_terms for t in c)                                         # в скольких ветках встречается
        G = len(seg_pairs)
        surface: dict = defaultdict(Counter)
        for w in _WORD.findall(text):
            surface[term_of(w)][w.lower().replace("ё", "е")] += 1
        new_gids = set()
        for gi, (a, b) in enumerate(seg_pairs):
            sc = {t: c * (math.log(G / gdf[t]) if G > 1 else 1.0) for t, c in seg_terms[gi].items()
                  if len(t) >= 4 and seg_df[gi][t] >= min(2, b - a) and (G == 1 or gdf[t] <= max(1, int(0.6 * G)))}
            top = sorted(sc, key=lambda t: -sc[t])[:4]
            words = [surface[t].most_common(1)[0][0] for t in top]
            t0 = json.loads(self._card(made[a])["meta"]).get("ts", "")
            t1 = json.loads(self._card(made[b - 1])["meta"]).get("ts", "")
            hint = json.loads(self._card(made[a])["meta"]).get("hint", "")
            title = clip(", ".join(words) or f"turns {a + 1}-{b}", 70)
            summary = f"{b - a} turns {made[a]}..{made[b - 1]}, {t0[5:]} → {t1[5:]} | starts: {clip(hint, 80)}"
            gid = self._group_for("thread", title, gi, summary)
            new_gids.add(gid)
            self.con.executemany("UPDATE cards SET group_id=? WHERE id=?", [(gid, cid) for cid in made[a:b]])
        # реплики, которых в файле больше нет, и ветки, в которых не осталось карточек
        for r in self.con.execute("SELECT id FROM cards WHERE kind='turn' AND substr(src,1,?)=?", (mine[1], mine[0])).fetchall():
            if r["id"] not in made:
                self._drop_chunks(r["id"])
                self.con.execute("DELETE FROM cards WHERE id=?", (r["id"],))
        for g in old_groups - new_gids:
            if not self.con.execute("SELECT 1 FROM cards WHERE group_id=? LIMIT 1", (g,)).fetchone():
                self.con.execute("DELETE FROM groups WHERE id=?", (g,))
        self.set_meta("chat_file", str(path))
        self.con.commit()
        return dict(turns=n, groups=len(edges) - 1, tokens=sum(self._card(c)["ntok"] for c in made))

    # --- индексация: объекты L3 комплекта (engine/project-store.sqlite), только чтение
    def index_pm(self, pm_db) -> dict:
        src = sqlite3.connect(Path(pm_db).resolve().as_uri() + "?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        names = {"A": "A Enbek", "B": "B Technopark", "C": "C OS", "D": "D Foresight"}
        n = 0
        try:
            rows = src.execute("SELECT * FROM objects ORDER BY cluster, type, id").fetchall()
        finally:
            src.close()
        live = {"pm-" + r["id"] for r in rows}
        for r in rows:
            cid = "pm-" + r["id"]
            body = "\n".join(x for x in (
                f"{r['title']}", f"[cluster {r['cluster']} · layer {r['layer']} · type {r['type']} · status {r['status']}]",
                r["body"] or "", (f"{r['pred']} {r['rel']} {r['obj']}" if r["pred"] else "")) if x)
            gid = self._group_for("pm", names.get(r["cluster"], r["cluster"]), ord(r["cluster"][0]) if r["cluster"] else 0, "objects of the kit's L3 store")
            self.con.execute("DELETE FROM cards WHERE id=?", (cid,))
            self.con.execute(
                "INSERT INTO cards(id,group_id,kind,title,summary,outline,body,nlines,ntok,version,status,src,src_hash,meta,updated) "
                "VALUES(?,?,?,?,?,?,?,?,?,1,'active',NULL,?,?,?)",
                (cid, gid, "pm:" + r["type"], clip(r["title"], 100), clip(f"[{r['type']}/{r['status']}] {r['title']}", SUMMARY_MAX), "[]", body,
                 count_lines(body), est_tokens(body), sha1(body), json.dumps(dict(pm_status=r["status"], ro=True), ensure_ascii=False), now()))
            self._reindex_chunks(cid, r["title"], body)
            n += 1
        # объекты, которых в столе больше нет (после init, например), из картотеки уходят
        for r in self.con.execute("SELECT id FROM cards WHERE substr(kind,1,3)='pm:'").fetchall():
            if r["id"] not in live:
                self._drop_chunks(r["id"])
                self.con.execute("DELETE FROM cards WHERE id=?", (r["id"],))
        self.con.commit()
        return dict(objects=n)

    # --- подписи в каталоге можно переписать (человеком или дешёвой моделью-«библиотекарем»), тексты карточек при этом не трогаются
    def set_summary(self, cid: str, summary: str) -> str:
        if self._card(cid) is None:
            return f"ERR no card {cid!r}"
        self.con.execute("UPDATE cards SET summary=? WHERE id=?", (clip(summary, SUMMARY_MAX + 80), cid))
        self.con.commit()
        return f"OK {cid} summary updated"

    def set_group(self, gid: str, title: str | None = None, summary: str | None = None) -> str:
        if self.con.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone() is None:
            return f"ERR no group {gid!r}"
        if title:
            self.con.execute("UPDATE groups SET title=? WHERE id=?", (clip(title, 90), gid))
        if summary:
            self.con.execute("UPDATE groups SET summary=? WHERE id=?", (clip(summary, 300), gid))
        self.con.commit()
        return f"OK {gid} updated"

    # --- заметки (карточки, которые пишет сам агент)
    def add_note(self, title: str, text: str, group: str = "notes") -> str:
        cid = self._next_id("n")
        gid = self._group_for("notes", group, 99, "agent-written notes")
        self.con.execute(
            "INSERT INTO cards(id,group_id,kind,title,summary,outline,body,nlines,ntok,version,status,src,src_hash,meta,updated) "
            "VALUES(?,?,?,?,?,'[]',?,?,?,1,'active',NULL,?,'{}',?)",
            (cid, gid, "note", clip(title, 100), clip(title + " | " + text, SUMMARY_MAX), text, count_lines(text), est_tokens(text), sha1(text), now()))
        self._reindex_chunks(cid, title, text)
        self.con.commit()
        return f"OK {cid} created"

    # ------------------------------------------------------------ чтение: каталог
    def _card_line(self, r) -> str:
        meta = json.loads(r["meta"])
        if r["kind"] == "file":
            return f"{r['id']} | {r['title']} | {r['nlines']}L | {r['summary']}"
        if r["kind"] == "turn":
            return f"{r['id']} | {meta.get('ts', '')[5:]} | ~{fmt_tok(r['ntok'])} tok | {r['summary']}"
        return f"{r['id']} | {r['kind']} | {r['summary']}"

    def catalog(self, group=None, level=None) -> str:
        groups = self.con.execute("SELECT * FROM groups ORDER BY kind, ord, id").fetchall()
        if not groups:
            return "ERR empty store: run index-code / index-chat first"
        stats = {r["group_id"]: (r["n"], r["tok"]) for r in self.con.execute(
            "SELECT group_id, COUNT(*) n, SUM(ntok) tok FROM cards WHERE status='active' GROUP BY group_id")}
        groups = [g for g in groups if stats.get(g["id"], (0, 0))[0] > 0]           # группы, где не осталось карточек, не показываем
        out = []

        def gline(g):
            n, tok = stats.get(g["id"], (0, 0))
            return f"{g['id']} | {g['title']} | {n} cards ~{fmt_tok(tok or 0)} tok | {g['summary']}"

        if group:
            g = next((x for x in groups if x["id"] == group or x["title"] == group), None)
            if g is None:
                return f"ERR no group {group!r}. Groups: " + ", ".join(x["id"] for x in groups)
            out.append("GROUP " + gline(g))
            for r in self.con.execute("SELECT * FROM cards WHERE group_id=? AND status='active' ORDER BY id", (g["id"],)):
                out.append(self._card_line(r))
            return "\n".join(out)
        out.append("GROUPS (id | title | cards ~tokens | summary). Next: catalog(group=id) lists the cards of a group; find(query) searches all text.")
        for g in groups:
            out.append(gline(g))
        if level == 1:
            return "\n".join(out)
        for g in groups:
            out.append("")
            out.append("GROUP " + g["id"] + " " + g["title"])
            for r in self.con.execute("SELECT * FROM cards WHERE group_id=? AND status='active' ORDER BY id", (g["id"],)):
                out.append(self._card_line(r))
        return "\n".join(out)

    # ------------------------------------------------------------ чтение: поиск
    def _fts(self, expr, group, kind, limit):
        sql = ("SELECT ch.card_id, ch.start_line, ch.end_line, bm25(chunks_fts, 1.0, 0.4) sc, chunks_fts.text txt "
               "FROM chunks_fts JOIN chunks ch ON ch.id = chunks_fts.rowid JOIN cards c ON c.id = ch.card_id "
               "WHERE chunks_fts MATCH ? AND c.status='active'")
        args = [expr]
        if group:
            sql += " AND (c.group_id = ? OR c.group_id IN (SELECT id FROM groups WHERE title = ?))"
            args += [group, group]
        if kind:
            sql += " AND c.kind = ?"
            args.append(kind)
        sql += " ORDER BY sc LIMIT ?"
        args.append(limit)
        return self.con.execute(sql, args).fetchall()

    @staticmethod
    def _enclosing(outline: list, line: int):
        best = None
        for i, (lbl, a, b) in enumerate(outline, 1):
            if a <= line <= b and (best is None or a >= best[2]):
                best = (i, lbl, a, b)
        return best

    def find(self, query: str, k: int = 8, group=None, kind=None) -> str:
        exprs, marks = query_exprs(query)
        if not exprs:
            return "ERR empty query (only stop-words?). Use concrete words: names, identifiers, numbers."
        try:
            rows = self._fts(" AND ".join(exprs), group, kind, 80)
            mode = "all words"
            if len({r["card_id"] for r in rows}) < min(k, 3) and len(exprs) > 1:
                more = self._fts(" OR ".join(exprs), group, kind, 80)
                have = {(r["card_id"], r["start_line"]) for r in rows}
                rows = list(rows) + [r for r in more if (r["card_id"], r["start_line"]) not in have]
                mode = "all words, then any word"
        except sqlite3.OperationalError as e:
            return f"ERR bad query: {e}"
        if not rows:
            return f"no matches for {query!r}. Try fewer or different words, a stem, or browse catalog()."
        best: dict = {}
        order: list = []
        also: dict = defaultdict(list)
        for r in rows:
            cid = r["card_id"]
            if cid not in best:
                best[cid] = r
                order.append(cid)
            else:
                also[cid].append(r)
        lines = [f"{min(len(order), k)} of {len(order)} cards ({mode}):"]
        for rank, cid in enumerate(order[:k], 1):
            r = best[cid]
            c = self._card(cid)
            outline = json.loads(c["outline"])
            tl = r["txt"].split("\n")[: r["end_line"] - r["start_line"] + 1]   # без добавки с разбором идентификаторов
            hit_i, hit_s = 0, -1
            for j, ln in enumerate(tl):
                low = ln.lower()
                s = sum(1 for m in marks if m in low)
                if s > hit_s:
                    hit_i, hit_s = j, s
            ln_no = r["start_line"] + hit_i
            text = unquote(tl[hit_i]).strip()
            if len(text) > 200:
                low = text.lower()
                pos = min([low.find(m) for m in marks if m in low] or [0])
                a = max(0, pos - 70)
                text = ("…" if a else "") + text[a:a + 190] + "…"
            enc = self._enclosing(outline, ln_no)                      # раздел оглавления: его номер годится для open(section=N)
            fine = self._enclosing(json.loads(c["meta"]).get("heads") or [], ln_no)   # тонкий заголовок, если оглавление укрупнено
            if enc and fine:
                where = f"§{enc[0]} {clip(fine[1], 60)} (L{fine[2]}-{fine[3]})"
            elif enc:
                where = f"§{enc[0]} {clip(enc[1], 60)} (L{enc[2]}-{enc[3]})"
            else:
                where = f"L{r['start_line']}-{r['end_line']}"
            others = sorted({e[0] for rr in also[cid] for e in [self._enclosing(outline, rr["start_line"])] if e and (not enc or e[0] != enc[0])})
            more = f" · also §{','.join(map(str, others[:5]))}" if others else ""
            # у кода показываем и строку объявления (def/class/function…), если лучшая строка лежит внутри: «где определено» без второго вызова
            sec = fine or enc
            decl = ""
            if sec and sec[2] != ln_no and re.match(r"\s*(def|class|function|const|let|var|type|interface|enum|table|index|view|trigger)\b", sec[1]):
                first = unquote(split_lines(c["body"])[sec[2] - 1]).strip()
                decl = f"\n     L{sec[2]}: {clip(first, 140)}"
            lines.append(f"{rank}. {cid} {clip(c['title'], 60)} · {where}{more}\n     L{ln_no}: {text}{decl}")
        return "\n".join(lines)

    # ------------------------------------------------------------ чтение: открыть
    def open(self, cid: str, section: int | None = None, lines: str | None = None, full: bool = False) -> str:
        c = self._card(cid)
        if c is None or c["status"] != "active":
            return f"ERR no active card {cid!r}. Use find(query) or catalog()."
        meta = json.loads(c["meta"])
        outline = json.loads(c["outline"])
        gt = self.con.execute("SELECT title FROM groups WHERE id=?", (c["group_id"],)).fetchone()
        head = f"{cid} v{c['version']} · {c['title']} · {c['nlines']}L ~{fmt_tok(c['ntok'])} tok" + (f" · {meta['ts']}" if meta.get("ts") else "") + (f" · {meta['file']}" if meta.get("file") else "") + (f" · group {c['group_id']} {gt['title']}" if gt else "")
        body_lines = split_lines(c["body"])
        a, b = 1, len(body_lines)
        label = ""
        if lines:
            m = re.match(r"^\s*(\d+)\s*[-:–]?\s*(\d+)?\s*$", str(lines))
            if not m:
                return f"ERR bad lines {lines!r}; use 'a-b'"
            a = max(1, int(m.group(1)))
            b = min(len(body_lines), int(m.group(2) or a))
            if a > len(body_lines):
                return f"ERR {cid} has only {len(body_lines)} lines"
            label = f"lines {a}-{b}"
        elif section is not None:
            if not 1 <= int(section) <= len(outline):
                return f"ERR no section {section}; the card has {len(outline)} sections" if outline else "ERR this card has no sections; use lines='a-b'"
            lbl, a, b = outline[int(section) - 1]
            label = f"§{section} {clip(lbl, 80)} (L{a}-{b})"
        elif not full:
            if c["ntok"] > OPEN_BUDGET_TOK and outline:
                sizes = [est_tokens("\n".join(body_lines[x - 1:y])) for _, x, y in outline]
                rows = [f"  {i:>2} L{x}-{y} {lbl}" + (f" (~{fmt_tok(sz)})" if sz >= 400 else "")
                        for i, ((lbl, x, y), sz) in enumerate(zip(outline, sizes), 1)]
                return (head + "\nToo large to print whole; OUTLINE (open(id, section=N) or open(id, lines='a-b'), full=true prints up to "
                        f"~{OPEN_FULL_TOK // 1000}K tok):\n" + "\n".join(rows))
        cap = OPEN_FULL_TOK if full and not (lines or section) else OPEN_BUDGET_TOK
        chunk = body_lines[a - 1:b]
        out, used, shown = [], 0, 0
        for i, ln in enumerate(chunk):
            t = est_tokens(ln) + 2
            if used + t > cap * 1.0 and shown:
                break
            out.append(ln)
            used += t
            shown += 1
        txt = numbered([unquote(x) for x in out] if meta.get("ro") else out, a)     # у карточек-реплик снимаем «> » (экономим токены)
        if shown < len(chunk):
            last = a + shown - 1
            txt += f"\n… [cut at L{last}: {len(chunk) - shown} more lines; continue with lines='{last + 1}-{b}']"
        return head + (f"\n[{label}]" if label else "") + "\n" + txt

    # ------------------------------------------------------------ правка патчем
    def patch(self, cid: str, version: int, old: str, new: str, note: str = "") -> str:
        c = self._card(cid)
        if c is None or c["status"] != "active":
            return f"ERR no active card {cid!r}"
        if json.loads(c["meta"]).get("ro"):
            return f"ERR {cid} is read-only (chat history or a copy of an L3 object); record the conclusion with fact_set or a note instead"
        if not old:
            return "ERR empty `old`: give the exact text to replace (with enough context to be unique)"
        text = c["body"]
        # 1) дрейф источника: файл на диске изменили не через картотеку
        path = None
        if c["src"] and c["kind"] == "file":
            if self.root is None:
                return "ERR no root for file cards: pass --root"
            path = (self.root / c["src"]).resolve()
            if self.root.resolve() not in path.parents:
                return "ERR path escapes root"
            disk = path.read_bytes().decode("utf-8", "replace") if path.exists() else None
            if disk is None:
                return f"ERR source file {c['src']} is gone; re-index"
            if sha1(disk) != c["src_hash"]:
                self._replace_text(cid, disk, sha1(disk), note="source changed on disk", status="active")
                self.con.commit()
                c = self._card(cid)
                return self._stale(c, old, f"STALE {cid}: the file changed on disk after indexing; the card was refreshed to v{c['version']}")
        # 2) версия
        if int(version) != c["version"]:
            return self._stale(c, old, f"STALE {cid}: you hold v{version} but the card is at v{c['version']}")
        n = text.count(old)
        if n == 0:
            return self._stale(c, old, f"ERR {cid} v{c['version']}: `old` not found verbatim", force_hint=True)
        if n > 1:
            where = [text.count("\n", 0, m.start()) + 1 for m in re.finditer(re.escape(old), text)][:6]
            return f"ERR {cid}: `old` occurs {n} times (lines {', '.join(map(str, where))}); add surrounding context to make it unique"
        pos = text.index(old)
        line_no = text.count("\n", 0, pos) + 1
        new_text = text[:pos] + new + text[pos + len(old):]
        try:
            if path is not None:
                tmp = path.with_name(path.name + ".cards-tmp")
                tmp.write_bytes(new_text.encode("utf-8"))
                os.replace(tmp, path)
            self._replace_text(cid, new_text, sha1(new_text), note=note or "patch")
            self.con.commit()
        except OSError as e:
            self.con.rollback()
            return f"ERR cannot write: {e}"
        c2 = self._card(cid)
        nl = split_lines(new_text)
        a = max(1, line_no - 1)
        b = min(len(nl), line_no + new.count("\n") + 1)
        return f"OK {cid} v{c2['version']}: replaced 1 occurrence at L{line_no}" + (" (file written)" if path is not None else "") + "\n" + numbered(nl[a - 1:b], a)

    def _stale(self, c, old, head, force_hint=False) -> str:
        text = c["body"]
        lines = split_lines(text)
        pos = text.find(old)
        if pos >= 0:
            ln = text.count("\n", 0, pos) + 1
            show = f"`old` is present in v{c['version']} at L{ln}:"
        else:
            probe = next((x.strip() for x in old.split("\n") if x.strip()), "")
            ln = next((i for i, x in enumerate(lines, 1) if probe and probe in x), 0)
            show = f"first line of `old` found at L{ln}:" if ln else "`old` is not in the current text; use find/open to re-read the target"
        out = head + ". " + show
        if ln:
            a = max(1, ln - 2)
            out += "\n" + numbered(lines[a - 1:min(len(lines), ln + 3)], a) + f"\nRe-apply with version={c['version']} if this is still the right place."
        return out

    def history(self, cid: str) -> str:
        c = self._card(cid)
        if c is None:
            return f"ERR no card {cid!r}"
        rows = self.con.execute("SELECT version, ts, note, LENGTH(body) n FROM card_versions WHERE card_id=? ORDER BY version", (cid,)).fetchall()
        out = [f"{cid} current v{c['version']} ({c['nlines']}L)"] + [f"  v{r['version']} {r['ts']} {r['note']} ({r['n']} chars)" for r in rows]
        return "\n".join(out)

    # ------------------------------------------------------------ журнал фактов
    def fact_set(self, key: str, value: str, source: str = "") -> str:
        key = " ".join(key.split())
        value = value.strip()
        if not key or not value:
            return "ERR key and value are required"
        kn = key.lower()
        cur = self.con.execute("SELECT * FROM facts WHERE key_norm=? AND status='active'", (kn,)).fetchone()
        if cur and cur["value"] == value:
            return f"UNCHANGED {key} = {value} (v{cur['version']})"
        ver = 1
        if cur:
            ver = cur["version"] + 1
            self.con.execute("UPDATE facts SET status='superseded' WHERE id=?", (cur["id"],))
        else:
            r = self.con.execute("SELECT MAX(version) m FROM facts WHERE key_norm=?", (kn,)).fetchone()
            ver = (r["m"] or 0) + 1
        self.con.execute("INSERT INTO facts(key,key_norm,value,version,status,source,ts) VALUES(?,?,?,?,'active',?,?)", (key, kn, value, ver, source, now()))
        self.con.commit()
        return f"OK {key} = {value} (v{ver}" + (f"; was v{ver - 1}: {cur['value']}" if cur else "") + ")"

    def fact_retract(self, key: str) -> str:
        cur = self.con.execute("SELECT * FROM facts WHERE key_norm=? AND status='active'", (" ".join(key.split()).lower(),)).fetchone()
        if not cur:
            return f"no active fact {key!r}"
        self.con.execute("UPDATE facts SET status='retracted' WHERE id=?", (cur["id"],))
        self.con.commit()
        return f"OK {key} retracted (was: {cur['value']})"

    def facts(self, prefix: str = "") -> str:
        p = prefix.strip().lower()
        rows = self.con.execute("SELECT * FROM facts WHERE status='active' AND substr(key_norm, 1, ?) = ? ORDER BY key_norm", (len(p), p)).fetchall()
        if not rows:
            return "(no active facts)"
        return "\n".join(f"{r['key']} = {r['value']}  (v{r['version']})" for r in rows)

    def fact_history(self, key: str) -> str:
        rows = self.con.execute("SELECT * FROM facts WHERE key_norm=? ORDER BY version, id", (" ".join(key.split()).lower(),)).fetchall()
        if not rows:
            return f"no such fact {key!r}"
        return "\n".join(f"v{r['version']} {r['status']:<10} {r['value']}" + (f"  [{r['source']}]" if r["source"] else "") for r in rows)

    # ------------------------------------------------------------ обновление индекса по настройкам проекта
    def refresh(self) -> dict:
        """Код — инкрементально (по хэшу), объекты стола — заново, чаты — только если файл изменился (подписи «библиотекаря» не затираются)."""
        proj = self.project
        out = {"code": self.index_code(project_path(proj, proj["code"]["root"]), exclude=tuple(proj["code"].get("exclude", ())))}
        pm_db = self._pm_dir() / "project-store.sqlite"
        if pm_db.exists():
            out["pm"] = self.index_pm(pm_db)
        chats = {}
        for pat in proj.get("chats", []):
            for f in sorted(glob.glob(str(Path(proj["_base"]) / pat))):
                name, h = Path(f).name, hashlib.sha1(Path(f).read_bytes()).hexdigest()
                if self.get_meta("chat_hash:" + name) == h:
                    chats[name] = "same"
                    continue
                try:
                    chats[name] = self.index_chat(f)
                except SystemExit as e:                  # markdown не в формате экспорта ChatGPT
                    chats[name] = f"skipped: {e}"
                    continue
                self.set_meta("chat_hash:" + name, h)
        out["chats"] = chats
        self.con.commit()
        return out

    # ------------------------------------------------------------ мост со столом (pm.py): канон читаем, предложения кладём как raw
    def _pm_dir(self) -> Path:
        return project_path(self.project, self.project["pm_dir"])

    def canon(self, types=None, limit: int = 60) -> str:
        """Принятые человеком (ACCEPT) факты и решения стола. Только чтение: база стола открывается в режиме ro."""
        db = self._pm_dir() / "project-store.sqlite"
        if not db.exists():
            return "ERR no desk store (project-store.sqlite): run `python3 pm.py init` in the engine folder"
        if isinstance(types, str):
            types = [t.strip() for t in types.split(",") if t.strip()]
        types = list(types or self.project.get("canon_types") or ["fact", "decision"])
        src = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        try:
            rows = src.execute("SELECT id, cluster, layer, type, title, body FROM objects WHERE status='canon' AND type IN (%s) "
                               "ORDER BY cluster, type, id LIMIT ?" % ",".join("?" * len(types)), (*types, limit)).fetchall()
        finally:
            src.close()
        if not rows:
            return f"(no canon objects of types {', '.join(types)})"
        out = [f"CANON: {len(rows)} objects accepted in the desk (types {', '.join(types)}). Read-only; it changes only through ACCEPT in the desk."]
        for r in rows:
            b = (r["body"] or "").strip().split("\n")[0]
            out.append(f"{r['id']} [{r['cluster']}/{r['type']}] {r['title']}" + (f" — {clip(b, 100)}" if b else ""))
        return "\n".join(out)

    def fact_promote(self, key: str, apply: bool = False, accept: bool = False) -> str:
        """Предложить факт журнала столу: объект со статусом raw, созданный штатной командой `pm.py add` (pm.py не меняем).
        Принять его (ACCEPT) может только человек; accept=True — для человека в CLI, в MCP-инструмент не выставлен."""
        kn = " ".join(key.split()).lower()
        cur = self.con.execute("SELECT * FROM facts WHERE key_norm=? AND status='active'", (kn,)).fetchone()
        if not cur:
            return f"ERR no active fact {key!r}"
        pm_py = self._pm_dir() / "pm.py"
        if not pm_py.exists():
            return f"ERR pm.py not found at {pm_py}"
        pr = self.project.get("promote", {})
        oid = f"LF-{re.sub(r'[^a-z0-9]+', '-', kn).strip('-') or 'fact'}-v{cur['version']}"
        title = f"{cur['key']} = {cur['value']}"
        body = f"ledger fact {cur['key']} v{cur['version']}" + (f"; source: {cur['source']}" if cur["source"] else "") + f"; recorded {cur['ts']}"
        prev = self.con.execute("SELECT pm_id, version FROM facts WHERE key_norm=? AND pm_id IS NOT NULL AND id<>? ORDER BY version DESC LIMIT 1", (kn, cur["id"])).fetchone()
        cmd = [sys.executable, str(pm_py), "add", "--id", oid, "--cluster", str(pr.get("cluster", "C")), "--layer", str(pr.get("layer", 1)),
               "--type", str(pr.get("type", "fact")), "--title", title, "--status", "raw", "--body", body]
        note = (f"\nNOTE: v{prev['version']} of this key is already in the desk as {prev['pm_id']}. The desk has no 'supersede': TAKE refuses canon objects, "
                f"so if that one was accepted, decide in the desk which of the two stays.") if prev else ""
        if cur["pm_id"]:
            return f"{cur['pm_id']} was already proposed for v{cur['version']}; accept it in the desk: python3 pm.py exec ACCEPT {cur['pm_id']}"
        if not apply:
            return (f"DRY RUN, nothing written. Would create RAW object {oid} [{pr.get('cluster', 'C')}/{pr.get('type', 'fact')}] «{title}». "
                    f"Repeat with apply=true; a human then accepts it: python3 pm.py exec ACCEPT {oid}" + note)
        r = subprocess.run(cmd, cwd=pm_py.parent, capture_output=True, text=True, encoding="utf-8", timeout=60)
        if r.returncode != 0:
            return f"ERR pm.py add failed: {(r.stderr or r.stdout).strip()[:300]}"
        self.con.execute("UPDATE facts SET pm_id=? WHERE id=?", (oid, cur["id"]))
        self.con.commit()
        msg = f"OK {oid} created in the desk as RAW"
        if accept:
            r2 = subprocess.run([sys.executable, str(pm_py), "exec", "ACCEPT", oid], cwd=pm_py.parent, capture_output=True, text=True, encoding="utf-8", timeout=60)
            msg += f"; {(r2.stdout or r2.stderr).strip()}"
        else:
            msg += f"; waiting for a human: python3 pm.py exec ACCEPT {oid}"
        return msg + note

    def handoff(self, budget_tok: int = 4000, catalog: bool = True) -> str:
        """Стартовая справка новой сессии: правила + канон стола + действующие факты журнала + список групп материала."""
        head = "MEMORY BRIEF — start of a new session\n" + PROTOCOL
        canon = self.canon()
        ledger = "LEDGER (conversation facts, current):\n" + self.facts()
        groups = self.catalog(level=1) if catalog and self.con.execute("SELECT 1 FROM groups LIMIT 1").fetchone() else ""
        parts = [head, canon, ledger, ("MATERIAL: " + groups.replace("GROUPS ", "groups ", 1)) if groups else ""]
        text = "\n\n".join(p for p in parts if p)
        while est_tokens(text) > budget_tok and groups.count("\n") > 3:      # не влезаем: режем список групп с конца
            groups = "\n".join(groups.split("\n")[:-1])
            parts[3] = "MATERIAL: " + groups.replace("GROUPS ", "groups ", 1) + "\n(list shortened; catalog() shows the rest)"
            text = "\n\n".join(p for p in parts if p)
        return text

    def stats(self) -> str:
        q = lambda s: self.con.execute(s).fetchone()[0]  # noqa: E731
        return (f"cards {q('SELECT COUNT(*) FROM cards WHERE status=\"active\"')} · groups {q('SELECT COUNT(*) FROM groups')} · "
                f"chunks {q('SELECT COUNT(*) FROM chunks')} · tokens ~{fmt_tok(q('SELECT COALESCE(SUM(ntok),0) FROM cards WHERE status=\"active\"'))} · "
                f"facts {q('SELECT COUNT(*) FROM facts WHERE status=\"active\"')} · db {self.path.stat().st_size // 1024}KB")


# ---------------------------------------------------------------- инструменты для агента (одно описание для CLI-сервера и для опытов)

TOOL_SPECS = [
    dict(name="catalog",
         description="Overview first. No args: list groups (id, title, size, summary). With group=<id>: one line per card of that group. "
                     "Cheap; use it to decide where to look before searching or opening.",
         props={"group": {"type": "string", "description": "group id from the group list (e.g. g3)"}}, required=[]),
    dict(name="find",
         description="Full-text search over all cards (BM25; all words first, then any word). Returns ranked cards with the enclosing "
                     "section and the best matching line with its line number. Use concrete words: names, identifiers, numbers. "
                     "Cyrillic words are matched by stem. Quote a phrase to match it exactly.",
         props={"query": {"type": "string"}, "k": {"type": "integer", "description": "max cards, default 8"},
                "group": {"type": "string", "description": "limit to a group id"}}, required=["query"]),
    dict(name="open",
         description="Open a card by id. Small cards print whole. Large cards print an outline (sections with line ranges); then call again "
                     "with section=N or lines='a-b'. Output is capped (~3K tokens); the tail tells how to continue.",
         props={"id": {"type": "string"}, "section": {"type": "integer"}, "lines": {"type": "string", "description": "e.g. '120-180'"},
                "full": {"type": "boolean", "description": "print up to ~6K tokens of a whole card"}}, required=["id"]),
    dict(name="patch",
         description="Replace exactly one occurrence of `old` by `new` in a card (file-backed cards are written to the file). "
                     "`version` must be the card version you last saw. If the card changed meanwhile you get STALE plus the fresh text around your target: "
                     "re-apply with the new version. `old` must be unique in the card: add surrounding context.",
         props={"id": {"type": "string"}, "version": {"type": "integer"}, "old": {"type": "string"}, "new": {"type": "string"}},
         required=["id", "version", "old", "new"]),
    dict(name="fact_set",
         description="Write a fact to the ledger: a short stable key (e.g. 'deadline', 'lead.name') and its value. A new value for the same key "
                     "supersedes the old one; history is kept. Record every fact the user states or corrects, and anything you produced "
                     "that may be asked about later.",
         props={"key": {"type": "string"}, "value": {"type": "string"}, "source": {"type": "string"}}, required=["key", "value"]),
    dict(name="canon",
         description="The desk's canon: facts and decisions that a human accepted (ACCEPT) in the project's desk store. Read-only. "
                     "It outranks the ledger when they disagree.",
         props={"types": {"type": "string", "description": "comma-separated object types, default fact,decision"}}, required=[]),
    dict(name="fact_promote",
         description="Propose a ledger fact to the desk: creates a RAW object, never canon; only a human accepts it. "
                     "Without apply=true (or when the project has switched writing off) it just shows what would be written.",
         props={"key": {"type": "string"}, "apply": {"type": "boolean"}}, required=["key"]),
    dict(name="facts", description="List the current (active) facts, optionally only keys starting with a prefix.",
         props={"prefix": {"type": "string"}}, required=[]),
    dict(name="fact_history", description="All versions of one fact key, oldest first (use for 'what was it before' and 'how many times did it change').",
         props={"key": {"type": "string"}}, required=["key"]),
]


def call_tool(store: Store, name: str, args: dict) -> str:
    a = dict(args or {})
    if name == "catalog":
        return store.catalog(group=a.get("group") or None)
    if name == "find":
        return store.find(a.get("query", ""), k=int(a.get("k") or 8), group=a.get("group") or None)
    if name == "open":
        return store.open(a.get("id", ""), section=(int(a["section"]) if a.get("section") not in (None, "") else None),
                          lines=a.get("lines") or None, full=bool(a.get("full")))
    if name == "patch":
        return store.patch(a.get("id", ""), int(a.get("version", -1)), a.get("old", ""), a.get("new", ""))
    if name == "fact_set":
        return store.fact_set(a.get("key", ""), a.get("value", ""), a.get("source", ""))
    if name == "facts":
        return store.facts(a.get("prefix", ""))
    if name == "canon":
        return store.canon(types=a.get("types") or None)
    if name == "fact_promote":
        want = bool(a.get("apply"))
        allowed = bool(store.project.get("promote", {}).get("mcp_apply"))
        out = store.fact_promote(a.get("key", ""), apply=want and allowed)
        if want and not allowed:
            out += ("\nNOTE: writing to the desk is switched off for agents in this project (project.json: promote.mcp_apply=false). "
                    "A human can run: python3 engine/cards/cards.py promote " + a.get("key", "KEY") + " --apply")
        return out
    if name == "fact_history":
        return store.fact_history(a.get("key", ""))
    return f"ERR unknown tool {name!r}"


def serve_mcp(store: Store, names=None, refresh: bool = False) -> None:
    """Минимальный MCP-сервер по stdio (JSON-RPC, по строке на сообщение): подключается к Claude Code.
    В stdout только протокол; диагностика — в stderr. Правила памяти едут в поле instructions."""
    if refresh:
        try:
            print("cards: refresh", json.dumps(store.refresh(), ensure_ascii=False), file=sys.stderr)
        except Exception as e:  # noqa: BLE001  сервер должен подняться, даже если индекс не обновился
            print(f"cards: refresh failed: {type(e).__name__}: {e}", file=sys.stderr)
    specs = [s for s in TOOL_SPECS if not names or s["name"] in names]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mid, method = msg.get("id"), msg.get("method")
        if mid is None:          # уведомления (notifications/initialized и т.п.) без ответа
            continue
        if method == "initialize":
            res = {"protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2024-11-05"),
                   "capabilities": {"tools": {}}, "serverInfo": {"name": "cards", "version": "0.2"}, "instructions": PROTOCOL}
        elif method == "tools/list":
            res = {"tools": [{"name": s["name"], "description": s["description"],
                              "inputSchema": {"type": "object", "properties": s["props"], "required": s["required"]}} for s in specs]}
        elif method == "tools/call":
            p = msg.get("params") or {}
            try:
                text, err = call_tool(store, p.get("name", ""), p.get("arguments") or {}), False
            except Exception as e:  # noqa: BLE001
                text, err = f"ERR {type(e).__name__}: {e}", True
            res = {"content": [{"type": "text", "text": text}], "isError": err}
        elif method == "ping":
            res = {}
        else:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}) + "\n")
            sys.stdout.flush()
            continue
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": res}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------- CLI

def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Картотека: обзор-каталог, карточки по id, журнал фактов (прототип)")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="файл SQLite (по умолчанию $CARDS_DB или engine/cards/cards.sqlite)")
    ap.add_argument("--root", default=None, help="корень файлов для правок (по умолчанию тот, что запомнен при индексации)")
    ap.add_argument("--config", default=None, help="настройки проекта (по умолчанию engine/cards/project.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("index-code", help="проиндексировать файлы репозитория как карточки")
    p.add_argument("path", nargs="?", default=".")
    p.add_argument("--exclude", action="append", default=[], help="шаблон пути для исключения (можно несколько)")
    p.add_argument("--files-from", help="файл со списком путей (по одному в строке) вместо git ls-files")
    p.add_argument("--prune", action="store_true", help="архивировать карточки файлов, которых больше нет в списке")
    p = sub.add_parser("index-chat", help="проиндексировать экспорт ChatGPT (markdown) как ветки и реплики")
    p.add_argument("path")
    p.add_argument("--groups", type=int, default=None, help="сколько веток (по умолчанию ~ реплик/8)")
    p = sub.add_parser("index-pm", help="проиндексировать объекты engine/project-store.sqlite (только чтение)")
    p.add_argument("path", nargs="?", default=str(HERE.parent / "project-store.sqlite"))
    p = sub.add_parser("catalog"); p.add_argument("--group"); p.add_argument("--level", type=int, choices=(1, 2))
    p = sub.add_parser("find"); p.add_argument("query"); p.add_argument("-k", type=int, default=8); p.add_argument("--group")
    p = sub.add_parser("open"); p.add_argument("id"); p.add_argument("--section", type=int); p.add_argument("--lines"); p.add_argument("--full", action="store_true")
    p = sub.add_parser("patch"); p.add_argument("id"); p.add_argument("--version", type=int, required=True)
    p.add_argument("--old"); p.add_argument("--new", default=""); p.add_argument("--old-file"); p.add_argument("--new-file")
    p = sub.add_parser("history"); p.add_argument("id")
    p = sub.add_parser("set-summary", help="переписать строку обзора карточки"); p.add_argument("id"); p.add_argument("summary")
    p = sub.add_parser("set-group", help="переписать название/обзор группы"); p.add_argument("id"); p.add_argument("--title"); p.add_argument("--summary")
    p = sub.add_parser("note"); p.add_argument("title"); p.add_argument("text")
    p = sub.add_parser("fact"); p.add_argument("key"); p.add_argument("value"); p.add_argument("--source", default="")
    p = sub.add_parser("retract"); p.add_argument("key")
    p = sub.add_parser("facts"); p.add_argument("prefix", nargs="?", default="")
    p = sub.add_parser("fact-history"); p.add_argument("key")
    sub.add_parser("stats")
    sub.add_parser("refresh", help="обновить индекс по project.json: код, объекты стола, изменившиеся экспорты чата")
    p = sub.add_parser("canon", help="принятые человеком факты и решения стола (только чтение)"); p.add_argument("--types", default=None, help="типы через запятую")
    p = sub.add_parser("promote", help="предложить факт журнала столу: объект raw через `pm.py add`")
    p.add_argument("key"); p.add_argument("--apply", action="store_true", help="выполнить (по умолчанию пробный запуск)")
    p.add_argument("--accept", action="store_true", help="сразу принять (ACCEPT) — решение человека, не агента")
    p = sub.add_parser("handoff", help="стартовая справка новой сессии: правила, канон, факты, группы")
    p.add_argument("--budget", type=int, default=4000, help="потолок в токенах (оценка)"); p.add_argument("--no-catalog", action="store_true")
    p = sub.add_parser("serve", help="MCP по stdio"); p.add_argument("--refresh", action="store_true", help="перед запуском обновить индекс")
    ns = ap.parse_args(argv)

    st = Store(ns.db, root=ns.root, project=load_project(ns.config))
    c = ns.cmd
    if c == "index-code":
        files = None
        if ns.files_from:
            files = [l.strip() for l in Path(ns.files_from).read_text(encoding="utf-8").splitlines() if l.strip()]
        print(st.index_code(ns.path, files=files, exclude=tuple(ns.exclude), prune=ns.prune))
    elif c == "index-chat":
        print(st.index_chat(ns.path, target_groups=ns.groups))
    elif c == "index-pm":
        print(st.index_pm(ns.path))
    elif c == "catalog":
        print(st.catalog(group=ns.group, level=ns.level))
    elif c == "find":
        print(st.find(ns.query, k=ns.k, group=ns.group))
    elif c == "open":
        print(st.open(ns.id, section=ns.section, lines=ns.lines, full=ns.full))
    elif c == "patch":
        old = Path(ns.old_file).read_text(encoding="utf-8") if ns.old_file else ns.old
        new = Path(ns.new_file).read_text(encoding="utf-8") if ns.new_file else ns.new
        print(st.patch(ns.id, ns.version, old or "", new))
    elif c == "history":
        print(st.history(ns.id))
    elif c == "set-summary":
        print(st.set_summary(ns.id, ns.summary))
    elif c == "set-group":
        print(st.set_group(ns.id, ns.title, ns.summary))
    elif c == "note":
        print(st.add_note(ns.title, ns.text))
    elif c == "fact":
        print(st.fact_set(ns.key, ns.value, ns.source))
    elif c == "retract":
        print(st.fact_retract(ns.key))
    elif c == "facts":
        print(st.facts(ns.prefix))
    elif c == "fact-history":
        print(st.fact_history(ns.key))
    elif c == "stats":
        print(st.stats())
    elif c == "refresh":
        print(json.dumps(st.refresh(), ensure_ascii=False))
    elif c == "canon":
        print(st.canon(types=ns.types))
    elif c == "promote":
        print(st.fact_promote(ns.key, apply=ns.apply, accept=ns.accept))
    elif c == "handoff":
        print(st.handoff(budget_tok=ns.budget, catalog=not ns.no_catalog))
    elif c == "serve":
        serve_mcp(st, refresh=ns.refresh)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:      # `… | head`: читатель закрыл трубу, это не ошибка
        sys.stderr.close()

# AI2DTab — двумерный стол для долгих диалогов с ИИ

Экспериментальное веб-приложение и движок структурирования знаний, переводящие линейный чат в двумерную таблицу записей с идентификаторами, кластерами и каноническим состоянием.

## Концепция и уровни (L1–L4)

В отличие от одномерного чата, где каждый абзац переносит контекст всех предыдущих шагов, «стол» хранит отдельные записи с `id` в SQLite-хранилище и позволяет работать с ними срезами:

```
L1 лента (/) ──PLANT──▶ L2 плоскость (/l2) ──ACCEPT──▶ L3 память/канон (/l3) ──RUN──▶ L4 действие (/l4)
   ▲                                                                                      │
   └────────────────────────────── FETCH (новый вопрос) ◀─────────────────────────────────┘
```

- **L1 (`/`):** одномерный ввод или загрузка сырого текста (`.txt`, `.md`, `.json`, `.tsv`) и посадка записей (`PLANT`) в базу.
- **L2 (`/l2`):** плоскость сырых записей, фильтрация по кластерам (`A` — Enbek, `B` — Technopark, `C` — OS, `D` — Foresight), формулы (`=GRID`, `=COUNTIF(≠)`), разбор пар `pred ≠ obj`, массовый `ACCEPT`.
- **L3 (`/l3`):** канонические записи (`status=canon`), ячейки `≠`, рёбра `PACKET` (`links`) и прочий канон с запуском `RUN`.
- **L4 (`/l4`):** снятие спецификации языка из журнала (`SPEC`), анализ портов (`PORT C→A`), проверка красной зоны (`SETTLE`), возврат нового вопроса (`FETCH`) и просмотр файлов архива.

## Структура проекта (`main`)

| Путь | Назначение |
|---|---|
| `src/routes/` | Экраны TanStack Router: `__root.tsx`, `index.tsx` (L1), `l2.tsx`, `l3.tsx`, `l4.tsx` |
| `src/components/` | UI-компоненты: `command-bar.tsx`, `cycle-board.tsx`, `cycle-panel.tsx`, `desk-nav.tsx`, `instruments.tsx`, `preview-host-bridge.tsx` |
| `src/lib/` | Состояние и интеграции: `desk-store.ts`, `desk-bridge.ts`, `pm-api.ts`, `kit-api.ts`, `parse-l1.ts`, `db.ts`, `cycle-data.ts`, `cycle-store.ts`, `auth/`, `app-data/`, `multiplayer/` |
| `src/data/` | Данные комплекта (в т.ч. `ont-l2.json`) |
| `engine/` | Python/SQLite-движок: `pm.py`, `schema.sql`, `seed.sql`, `project-store.sqlite`, `samples/ont-l2.tsv`, документация (`README.md`, `LANG.md`, `LANG-FROM-DB.md`, `CHAT-CRUTCH.md`) |
| `server/` | Серверные middleware (`server/middleware/`) |
| `migrations/` | SQL-миграции аутентификации (`migrations/auth/`) |
| `scripts/` | Вспомогательные и проверочные скрипты (`with-app-env.mjs`, `migrate.mjs`, `preview.mjs`, `check-auth-invariant.mjs`, `browser-smoke.mjs` и тесты) |
| `attachments/` | Исходные материалы диалога |
| `startup.sh` | Скрипт запуска dev-сервера на `0.0.0.0:8080` |

## Технологический стек и команды запуска

**Фронтенд и сервер:** React 19, TypeScript, Vite 8, TanStack Start / Router / Query / Table, Tailwind CSS v4, Radix UI, Zustand, Better Auth (`better-auth`), Kysely, `@electric-sql/pglite`, `pg`, Nitro, Playwright.

**Движок (`engine/`):** Python 3 + SQLite (`schema.sql`: таблицы `objects`, `links`, `origins`, `events`, `packets`).

```bash
# Установка зависимостей и запуск веб-интерфейса (порт 8080)
npm install
npm run dev

# Сборка, миграции и проверки
npm run build
npm run db:migrate
npm run typecheck
npm run check:auth
npm run lint
npm test
```

```bash
# Работа с Python/SQLite-движком напрямую
cd engine
python3 pm.py init
python3 pm.py exec STATUS
python3 pm.py exec PLANT --file samples/ont-l2.tsv
python3 pm.py exec LOOK смысл
python3 pm.py exec ACCEPT ont-S17042
python3 pm.py exec TAKE U-TEST
python3 pm.py exec RUN ont-S17042
python3 pm.py exec FETCH
python3 pm.py exec DUMP | head
```

## Ветки репозитория

- `ccr-16458c8b-rhgxsh` — версия **v2.1**: TypeScript-движок в `src/engine/`, хранение книги в браузерном IndexedDB (`src/lib/storage.ts` с откатом на `localStorage`), экран `/cycle`, документация в `docs/` (`AUDIT.md`, `STAGE.md`, `V2.md`, `PROTOCOL.md`, `CORPUS.md`), скрипт анализа корпуса `scripts/corpus-stats.mjs` и `npm run test:engine`.
- `claude/pensive-tesla-qb0rt4-site-engine` ([PR #3](../../pull/3), draft) — доработки сайта и SQLite-движка: вход, запись по подтверждённому списку (`--ids`), снимок только для чтения, объединение проверки и записи `ACCEPT`/`TAKE`/`REPAIR` в одну транзакцию `BEGIN IMMEDIATE` (аудит `AUD-15`).
- `claude/pensive-tesla-qb0rt4` ([PR #2](../../pull/2), draft) — прототип карточек, команда `SUPERSEDE`, семантический линт, аудит и обновления документации (`AUDIT.md`, `HANDOFF`).
- `neq-candidates-pass9` — добавление 1009 кандидатов NEQ (`pred ≠ obj`), извлечённых из экспорта Innovation OS.
- `codex/readme-overview-20261118` ([PR #4](../../pull/4), draft) — краткий обзорный `README.md`.
- `svend4-patch-1` — ветка от закрытого и слитого [PR #1](../../pull/1).

## Лицензия

Проект распространяется под лицензией **GNU Affero General Public License v3.0** — см. [LICENSE](LICENSE).

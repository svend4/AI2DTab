# Стенд измерений картотеки

Итоги и оговорки — в [`RESULTS.md`](RESULTS.md). Сырые ответы и счётчики токенов каждого вопроса — в `results/`.

Нужны `pip install claude-agent-sdk` и доступ к Claude (ключ `ANTHROPIC_API_KEY` или вход в Claude Code). Модели задаются переменными окружения:
`EVAL_MODEL` — идентификатор основной модели (её меряем), `EVAL_MODEL_SMALL` — малой (журнал фактов, «библиотекарь»). Ставки цен в `common.py` — для основной модели из `RESULTS.md`. Все прогоны из `results/` стоили ≈$20 по токенам (+ ≈$1–2 на генерацию вопросов и подписей каталога).

```bash
export EVAL_MODEL=<id основной модели> EVAL_MODEL_SMALL=<id малой модели>
cd engine/cards/eval
python3 prepare.py /tmp/work                       # копия 96 файлов, плоский дамп, чат, базы картотеки

# репозиторий и чат: набор × вариант × номер прогона (параллельно)
python3 matrix.py --work /tmp/work --out /tmp/out --workers 4 \
  repo_lookup:tools:1 repo_lookup:cards:1 repo_semantic:flat:1 repo_semantic:cards:1 repo_edit:cards:1 \
  chat:tools:1 chat:cards:1 chat:cards-l1:1 chat_pos:cards:1
python3 score.py /tmp/out --md --fails              # таблицы; вердикты пересчитываются по data/questions_*.json

# «библиотекарь»: подписи каталога переписывает малая модель, затем варианты cards-llm и tools+cat-llm
cp /tmp/work/chat.sqlite /tmp/work/chat_llm.sqlite
python3 label_catalog.py --db /tmp/work/chat_llm.sqlite --raw-catalog /tmp/work/chat_raw_catalog_llm.txt
python3 matrix.py --work /tmp/work --out /tmp/out chat:cards-llm:1 chat:tools+cat-llm:1

# журнал фактов и правка при чужой правке
python3 ledger.py --arm plain|compact|ledger|ledger-user --run 1 --noise 70 --out /tmp/out_ledger
python3 ledger_report.py /tmp/out_ledger --md
python3 stale.py --work /tmp/work --arm tools|cards --run 1 --out /tmp/out_stale
```

| файл | что делает |
|---|---|
| `prepare.py` | корпуса и базы (те же 96 файлов, что в прежних опытах; чат — `attachments/ChatGPT_….md`) |
| `gen_questions.py` | модель пишет вопросы по случайным кускам, скрипт проверяет ответы по тексту (кандидаты — `data/cand_*.json`) |
| `gen_position.py` | вопросы «когда термин встречается впервые» без модели |
| `make_sets.py` | отбор кандидатов, проверки-регулярки, исключения; пишет `data/questions_*.json` |
| `run_arm.py`, `matrix.py` | один прогон и параллельный запуск набора |
| `score.py` | таблицы; `--read-rate 0.20` пересчитывает цену при другой ставке чтения кэша |
| `label_catalog.py` | модель-«библиотекарь» переписывает подписи каталога |
| `ledger.py`, `ledger_report.py` | журнал фактов против ленты и сжатия |
| `stale.py` | правка, когда файл меняют между чтением и записью |
| `common.py` | живая сессия Agent SDK, учёт токенов и денег, инструменты картотеки как SDK-инструменты |

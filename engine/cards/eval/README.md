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

# вопросы на синтез и «вики» (раздел 6 в RESULTS.md)
python3 gen_synth.py --db /tmp/work/chat.sqlite --out data/cand_synth.json   # кандидаты: вопрос, ответ которого лежит в 2–3 разных репликах
python3 make_sets.py                                                         # отбор (SYNTH, SYNTH_INVALID) -> data/questions_synth.json
cp /tmp/work/chat.sqlite /tmp/work/chat_notes.sqlite                        # свежая копия: заметки добавляются в неё
python3 compile_notes.py --db /tmp/work/chat_notes.sqlite --out-dir /tmp/compile_out --wiki-dir /tmp/work/wiki_chat/wiki   # + --lists для второго сжатия
python3 wiki_coverage.py --db /tmp/work/chat_notes.sqlite                    # какие якоря вопросов вообще попали в заметки
python3 wiki_faithfulness.py --db /tmp/work/chat_notes.sqlite --claims /tmp/compile_out/claims.json --out /tmp/faith.json
python3 matrix.py --work /tmp/work --out /tmp/out_synth --workers 4 synth:tools:1 synth:cards-l1:1 synth:cards-grep:1 synth:notes-l1:1 synth:wiki-files:1 synth:wiki-only:1 synth:none:1
python3 score.py /tmp/out_synth --matrix                                     # таблица и матрица «вопрос × вариант»; вопросы с invalid исключены (--include-invalid вернёт)
python3 synth_stats.py /tmp/out_synth                                        # доли с интервалами и парное сравнение с tools

# смысловой lint (раздел 7 в RESULTS.md)
python3 semlint_eval.py run   --db /tmp/work/chat.sqlite --arm main --out results/semlint/main1.json     # 24 понятия, как есть (--arm small — малая модель)
python3 semlint_eval.py plant --db /tmp/work/chat.sqlite --arm main --out results/semlint/plant_main.json # в копию базы добавляются 10 реплик-противоречий
python3 semlint_eval.py canon --arm main --out results/semlint/canon_main.json                            # копия настоящего стола + подложенные конфликты
python3 semlint_eval.py view results/semlint/main1.json --db /tmp/work/chat.sqlite > view.txt             # находки с окрестностью — разметить real / borderline / weak / wrong
python3 semlint_eval.py score results/semlint/main1.json results/semlint/labels_main1.json
python3 semlint_eval.py overlap results/semlint/main1.json results/semlint/main2.json results/semlint/labels_main1.json
python3 semlint_eval.py judge results/semlint/main1.json --db /tmp/work/chat.sqlite --out results/semlint/judge_main1.json
python3 semlint_eval.py agree results/semlint/labels_main1.json results/semlint/judge_main1.json
# сам инструмент: python3 ../semlint.py "Capability Contract" (см. ../README.md); тесты: python3 -m unittest engine/cards/test_semlint.py

| файл | что делает |
|---|---|
| `prepare.py` | корпуса и базы (те же 96 файлов, что в прежних опытах; чат — `attachments/ChatGPT_….md`) |
| `gen_questions.py` | модель пишет вопросы по случайным кускам, скрипт проверяет ответы по тексту (кандидаты — `data/cand_*.json`) |
| `gen_position.py` | вопросы «когда термин встречается впервые» без модели |
| `make_sets.py` | отбор кандидатов, проверки-регулярки, исключения; пишет `data/questions_*.json` |
| `run_arm.py`, `matrix.py` | один прогон и параллельный запуск набора |
| `score.py` | таблицы; `--read-rate 0.20` пересчитывает цену при другой ставке чтения кэша |
| `evaluator.py` | **отпечаток оценщика**: `run_arm.py` и `semlint_eval.py` записывают в результат, чем проверяли ответы (файл вопросов с проверками и функции вердикта; у semlint — ответ-ключ и подсчёт по нему), а `score.py` и `semlint_eval.py score` сверяют его с текущим и предупреждают строкой «оценщик менялся после ответов» или «в результатах нет отпечатка» (так сказано обо всех прогонах из `results/`: они сделаны до его появления). Оценщика менять можно, отпечаток лишь не даёт сделать это незаметно |
| `label_catalog.py` | модель-«библиотекарь» переписывает подписи каталога |
| `ledger.py`, `ledger_report.py` | журнал фактов против ленты и сжатия |
| `stale.py` | правка, когда файл меняют между чтением и записью |
| `gen_synth.py`, `make_sets.py` | вопросы на синтез: кандидаты по трём отрывкам из разных реплик с якорями, проверенными по тексту; отбор и исключение неоднозначных |
| `compile_notes.py` | проход «compile»: малая модель выписывает утверждения с дословными цитатами, скрипт находит цитаты в тексте и отбрасывает ненайденные, затем дайджесты реплик и страницы понятий; `--lists` добавляет дословные перечни |
| `wiki_coverage.py` | какие якоря вопросов попали в заметки (диагностика сжатия, без агента) |
| `wiki_faithfulness.py` | независимый судья сверяет выборку утверждений и обзоров страниц с их источниками |
| `semlint_eval.py` | проверка смыслового lint (раздел 7): `run` — 24 понятия набора synth, `plant` — 10 подложенных противоречий, `canon` — стол с подложенными конфликтами, `view` — находки с окрестностью для ручной разметки, `score` / `overlap` — итоги и повторяемость, `judge` / `agree` — слепая вторая разметка моделью |
| `synth_stats.py` | доли верных ответов с интервалами Уилсона и парное сравнение по вопросам (бутстрап) |
| `common.py` | живая сессия Agent SDK, учёт токенов и денег, инструменты картотеки как SDK-инструменты |

# Живой L3/L4 (не артефакт комплекта)

Комплект в `artifacts/` заморожен. Здесь пересчёт: sqlite + тот же алфавит, что строка команд на столе.

```bash
cd /workspace/engine
python3 pm.py init
python3 pm.py exec STATUS
python3 pm.py exec PLANT --file samples/ont-l2.tsv
python3 pm.py exec LOOK смысл
python3 pm.py exec ACCEPT ont-S17042
python3 pm.py exec TAKE U-TEST     # или REFUSE, если type=session
python3 pm.py exec RUN ont-S17042
python3 pm.py exec FETCH
python3 pm.py exec DUMP | head
```

`ACCEPT` пишет `status=canon` в sqlite. Session/tape — REFUSE. Это лёд: меню на сайте только показывает ход.

Повтор команды ничего не добавляет: `FETCH`, пока вопрос «чего нет в каноне?» стоит (не снят, не закрыт), отвечает `skip FETCH Q-FETCH-… уже стоит`, а номера вопросов идут по порядку (`Q-FETCH-001`), не по часам; повторный отказ `REFUSE` (замещённый объект, session/tape) пишется в журнал событий один раз подряд, ответ человеку каждый раз тот же. Таблица всех писателей: `engine/cards/test_idempotency.py`.

`SUPERSEDE старый BY новый причина` заменяет принятое: старый объект уходит из канона (`superseded`), новый принимается, история остаётся
(`python3 pm.py exec SUPERSEDE старый UNDO` откатывает). Подробности — в `LANG.md`. Тесты стола: `python3 -m unittest engine/test_pm.py`
(на временных копиях, настоящая база не трогается). В меню сайта этого глагола нет (`src/lib/pm-api.ts` пропускает только перечисленные), а `BATCH` его пропускает.

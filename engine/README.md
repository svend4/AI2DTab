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

# Движок v1 (Python + sqlite) — справочная реализация

Приложение с ветки v2 этот код не вызывает: тот же алфавит реализован в
`src/engine/` на TypeScript и работает в браузере. Здесь — исходник, по
которому проводился аудит (`docs/AUDIT.md`), и семя канона (`seed.sql`),
которое v2 читает как `src/data/seed.json`.

```bash
cd engine
python3 pm.py init
python3 pm.py exec STATUS
python3 pm.py exec PLANT --file samples/ont-l2.tsv
python3 pm.py exec FILL
python3 pm.py exec SPEC
```

Известные дефекты v1 (воспроизводимые): коллизия порядковых id при повторной
посадке; потеря абзацев при PLANT текстом из командной строки; один оператор
на строку в алгебре множеств; `next` по зашитым id. В v2 закрыты тестами.

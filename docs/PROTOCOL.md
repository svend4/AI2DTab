# Протокол агента

Любая модель работает со столом одним и тем же алфавитом. Правило: не
пересказывать, а ходить.

## Ход (вместо эссе)

1. Пришло сырьё → `PLANT <текст>`. Не саммари. Повторная посадка того же текста
   безвредна: одинаковые абзацы дают одинаковые id и пропускаются.
2. `INSTR` — красная зона; `GRID` — где сырьё, где канон.
3. `SET NEQ ∩ RAW` — что ждёт; `FILL` принимает ячейки пачкой. (Если стол
   запрещает модели ACCEPT — только список, принимает человек.)
4. Сомнение — `WHY id`. Лишнее — `TAKE id`. Ошибка — `UNDO`.
5. Связь между кластерами — `WIRE a b rel`, по одной. `MUL` отвергается.
6. Нет ответа в каноне → `FETCH <вопрос>` в ленту, не догадка.
7. Передача следующему агенту — `JSON`. Это снимок, не проза.

## Снимок `JSON`

```json
{
  "instr": { "charge": 0.44, "raw": 28, "canon": 22, "cells": 11, "neq": 11, "packets": 16, "warns": [] },
  "raw":   [ { "id": "C-k3f9a1", "cluster": "C", "layer": 2, "type": "observation", "title": "Event ≠ Claim", "status": "raw", "body": "…", "pred": "Event", "rel": "≠", "obj": "Claim" } ],
  "canon": [ … ],
  "wires": [ { "from": "D001", "rel": "cites", "to": "F002", "note": "дата из факта" } ],
  "cells": [ … ]
}
```

## Книга (экспорт/импорт)

`{ "version": 2, "objects": [...], "links": [...], "origins": [...], "events": [...] }` —
см. `src/engine/types.ts`. Семя v1 (`engine/seed.sql`) импортируется как
`{objects, links, origins}` с полями sqlite — движок конвертирует сам.

## Множества

Имена: `NEQ CELL RAW CANON SESSION OPEN JUNK OBS A B C D ALL`.
Фильтры: `type:question` `status:raw` `cluster:C` `rel:→` `owner:human`
`has:pred` `has:body` `has:link`. Операторы: `∩ ∪ \` (или `& | -`, `AND OR
MINUS`), скобки. Приоритет: `∩` выше `∪` и `\`.

## Запреты

- `session` / `tape` никогда не canon (REFUSE).
- canon не вычитается (TAKE → REFUSE); сначала REPAIR или UNDO.
- `MUL` / `MATRIX A × B` — отказ. Морфизм только `WIRE` / `PACKET`.
- Новый глагол — только если один и тот же LIVE GAP держится ≥ 3 съёмов.

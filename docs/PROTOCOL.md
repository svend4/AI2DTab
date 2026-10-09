# Протокол агента

Любая модель работает со столом одним и тем же алфавитом. Правило: не
пересказывать, а ходить. Перед ходами модель объявляет себя: `ACTOR machine`.
Машина сажает, режет, предлагает рёбра и вопросы; канон ставит только человек
(`ACCEPT` от машины — `REFUSE`, и это видно в журнале).

## Ход (вместо эссе)

1. Пришло сырьё → `PLANT <текст>`. Не саммари. Экспорт диалога с цитатами и
   секциями `# N.` сажается как секции (`S{N}`), ход диалога пишется в
   происхождение (`TURN n`). Повторная посадка того же текста безвредна:
   одинаковые абзацы дают одинаковые id и пропускаются; одинаковый номер секции
   с другим текстом разводится суффиксом `-2`.
2. `INSTR` — красная зона; `GRID` — где сырьё, где канон, где прочее.
3. `SET NEQ ∩ RAW` — что ждёт; `FILL` принимает ячейки пачкой (только человек).
   Машина вместо этого отдаёт список: `SET NEQ ∩ RAW`.
4. Сомнение — `WHY id`. Лишнее — `TAKE id`. Ошибка — `UNDO` (откатывает весь
   последний ход: FILL, BATCH, многострочный PLANT — целиком).
5. Связь между кластерами — `WIRE a b rel`, по одной. `CHAIN` подсказывает
   рёбра по цепочкам ячеек (obj одной = pred другой), `PROBE A B` — по общим
   словам. `MUL` отвергается.
6. Нет ответа в каноне → `FETCH <вопрос>`: raw-вопрос на плоскость и строка на
   ленту L1, не догадка.
7. Передача следующему агенту — `JSON` (снимок) или экспорт книги. Следующий
   агент сливает: `MERGE <json>`; перед слиянием — `DIFFBOOK <json>`.

## Снимок `JSON`

```json
{
  "instr": { "charge": 0.44, "raw": 28, "canon": 22, "rejected": 3, "cells": 11, "neq": 11, "packets": 16, "warns": [] },
  "actor": "machine",
  "turns": 81,
  "raw":   [ { "id": "C-k3f9a1zq0p", "cluster": "C", "layer": 2, "type": "observation", "title": "Event ≠ Claim", "status": "raw", "body": "…", "pred": "Event", "rel": "≠", "obj": "Claim" } ],
  "canon": [ … ],
  "wires": [ { "from": "D001", "rel": "cites", "to": "F002", "note": "дата из факта" } ],
  "cells": [ … ]
}
```

## Книга (экспорт/импорт)

`{ "version": 2, "objects": [...], "links": [...], "origins": [...], "events": [...], "packets"?: [...] }` —
см. `src/engine/types.ts`. Любой импорт проходит `normalizeBook`: кластер вне
A–D → C, неизвестный статус → raw, id приводится к `[A-Za-z0-9_.:-]`, id,
совпадающий с именем множества, получает суффикс `-id`, рёбра на отсутствующие
записи отбрасываются; все отклонения перечисляются как предупреждения. Семя v1
(`engine/seed.sql` → `src/data/seed.json`, поля sqlite) читается тем же путём,
включая таблицу `packets` (письма между сессиями видны в `WHY P001`).

## Множества

Имена: `NEQ CELL RAW CANON SESSION OPEN JUNK OBS A B C D ALL`.
`NEQ` — как в v1: только `observation` со статусом raw|canon; `CELL` — любая
ячейка (≠ → ⊂ = vs) со статусом raw|canon; вычтенные (`rejected`) не входят
ни в одно имя, кроме `ALL` и `status:rejected`; `JUNK` — ярлыки-обёртки
(«Example:», «Например:») и строки типа label.
Фильтры: `type:question` `status:raw` `cluster:C` `rel:→` `owner:human:plant`
`has:pred` `has:body` `has:link` `turn:12`. Операторы: `∩ ∪ \` (или `& | -`,
`AND OR MINUS`, регистр любой), скобки. Приоритет: `∩` выше `∪` и `\`.
То же выражение понимает `VOCAB`.

## Алфавит целиком

```
PLANT CUT PREVIEW LOOK STATUS GRID MATRIX DIFF
ACCEPT FILL TAKE SWEEP PURGE REPAIR [id]
SET NEQ CELL CONC VOCAB
PACKET WIRE UNWIRE PROBE CHAIN PORT
INSTR GAP SETTLE RUN NEXT FETCH WHY TURN
UNDO ACTOR MERGE DIFFBOOK SPEC JSON DUMP CANON RAW BATCH HELP
```

## Запреты

- `session` / `tape` никогда не canon (REFUSE); `machine` не ставит canon.
- canon не вычитается (`TAKE` → REFUSE); вернуть в raw — `REPAIR id` или `UNDO`.
- `MUL` / `MATRIX A × B` — отказ. Морфизм только `WIRE` / `PACKET`.
- `BATCH` останавливается на первом неудачном шаге.
- Новый глагол — только если один и тот же LIVE GAP держится ≥ 3 съёмов.

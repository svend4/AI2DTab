# Язык калькулятора

Множества (элементы = id):

- RAW, CANON — заряд конденсатора
- NEQ — именованный диапазон «≠»
- SESSION — не канон
- A B C D — кластеры
- OBS — наблюдения

Операции (сложение/вычитание множеств, не смыслов):

    SET NEQ
    SET NEQ ∩ C
    SET RAW \ SESSION
    SET CANON ∪ NEQ

Матрица: MATRIX = GRID, ячейка (кластер, тип) = |raw|/|canon|.
Умножение MATRIX A × B запрещено (MUL): это склейка кластеров.
Морфизм только редкий: PACKET (ребро links, не заполненная матрица).

    PACKET
    PACKET C A
    PACKET D001

Формулы: =NEQ  =NEQ∩C  =PACKET  =MATRIX  =COUNTIF(≠)

Макрос по множеству, не по списку из чата:

    FILL                 # ACCEPT NEQ ∩ RAW
    ACCEPT NEQ ∩ RAW
    ACCEPT NEQ ∩ C

    SWEEP                # TAKE SESSION
    TAKE SESSION
    TAKE RAW ∩ SESSION

Ячейка NEQ — не LIKE по body, а разбор заголовка:

    pred ≠ obj     длина обеих сторон ≥ 2
    Example: / Again: / Critical invariant:  — не ячейка

    NEQ / CELL     печать id, status, pred, rel, obj
    REPAIR         канон-мусор → снова raw
    FILL           только NEQ ∩ RAW; в отчёте ok / refuse / skip

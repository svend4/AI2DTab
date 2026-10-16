---
id: n089
title: Team Hypothesis
group: Wiki: concepts
sources: 10
---
# Team Hypothesis

Discussed in 5 exchanges: t006, t008, t017, t051, t053.

## Overview

Team Hypothesis — это группа кандидатов, которую система считает взаимодополняющей, но которая ещё не является готовой командой, поскольку неизвестны взаимный интерес, compensation, модель занятости и совместимость (t006, t008). Сначала структура TeamHypothesis включала project_id, members, coverage, missing_capabilities, operational_unknowns и status, а первым Team Builder был жадный алгоритм Greedy Set Cover; избыточность признавалась полезной для критичных capabilities, но не обязательно для базовых навыков (t017). В t051 поля были уточнены: project_id, members, coverage и remaining_gaps, и было зафиксировано, что TeamHypothesis никогда не должен означать согласие людей работать вместе (t051). В t053 структура снова изменилась: resource_ids, covered_capabilities, uncovered_capabilities, constraint_unknowns и статус HYPOTHESIS, consent остаётся UNKNOWN до явного evidence, а greedy set cover сохраняется как первый алгоритм формирования команды (t053).

## Timeline

- t006 (09-17 20:50) L314: Группа взаимодополняющих кандидатов называется Team Hypothesis, а не готовой командой, поскольку неизвестны взаимный интерес, compensation, модель занятости и совместимость. [[n006]]
- t008 (09-17 21:05) L630: TEAM_HYPOTHESIS — это комбинация кандидатов, которую система считает взаимодополняющей, но ещё не готовая команда. [[n008]]
- t017 (09-17 22:20) L1167: TeamHypothesis содержит project_id, members, coverage, missing_capabilities, operational_unknowns и status. [[n017]]
- t017 (09-17 22:20) L1187: Первый Team Builder — жадный алгоритм Greedy Set Cover. [[n017]]
- t017 (09-17 22:20) L1260: Избыточность полезна для критичных capabilities, но не обязательно полезна для базовых навыков. [[n017]]
- t051 (09-18 10:48) L821: TeamHypothesis содержит project_id, members, coverage и remaining_gaps. [[n051]]
- t051 (09-18 10:48) L830: TeamHypothesis никогда не должен означать, что эти люди согласились работать вместе. [[n051]]
- t053 (09-18 12:00) L2030: TeamHypothesis содержит project_id, resource_ids, covered_capabilities, uncovered_capabilities, constraint_unknowns и статус HYPOTHESIS. [[n053]]
- t053 (09-18 12:00) L2045: Team Hypothesis не означает согласие людей: consent остаётся UNKNOWN до явного evidence. [[n053]]
- t053 (09-18 12:00) L1967: Первый алгоритм формирования команды — greedy set cover. [[n053]]

See also: EVIDENCE [[n084]], Gap [[n106]], Gold Dataset [[n082]], Match category [[n109]], TruthState [[n090]]


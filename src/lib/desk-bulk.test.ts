import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BULK_MAX, parseRows, setExprOf, touchesBulk } from "./desk-bulk.ts";

describe("какая строка — запись над набором (AUD-15)", () => {
  it("ACCEPT, TAKE, FILL, PURGE и SWEEP над набором дают выражение для IDS", () => {
    assert.equal(setExprOf("ACCEPT RAW"), "RAW");
    assert.equal(setExprOf("take obs"), "obs");
    assert.equal(setExprOf("ACCEPT NEQ ∩ RAW"), "NEQ ∩ RAW");
    assert.equal(setExprOf("ACCEPT OBSERVATION"), "OBSERVATION");
    assert.equal(setExprOf("ACCEPT A"), "A");
    assert.equal(setExprOf("TAKE RAW \\ A"), "RAW \\ A");
    assert.equal(setExprOf("FILL"), "NEQ ∩ RAW");
    assert.equal(setExprOf("PURGE"), "JUNK");
    assert.equal(setExprOf("SWEEP"), "SESSION");
  });

  it("одиночный id и не-записи набором не считаются", () => {
    for (const line of [
      "ACCEPT A1",
      "TAKE F001",
      "SET RAW",
      "IDS RAW",
      "PLANT текст",
      "RAW",
      "BATCH ACCEPT RAW",
    ]) {
      assert.equal(setExprOf(line), null, line);
    }
  });
});

describe("ответ IDS: id, тип и статус", () => {
  it("строка на объект, пустые строки пропускаются", () => {
    assert.deepEqual(parseRows("B1\tobservation\traw\n\nC2\tquestion\topen\n"), [
      { id: "B1", type: "observation", status: "raw" },
      { id: "C2", type: "question", status: "open" },
    ]);
    assert.deepEqual(parseRows(""), []);
  });

  it("набор с сырым или наблюдением — массовый; набор из одних понятий — нет", () => {
    assert.equal(touchesBulk([{ id: "B1", type: "observation", status: "canon" }]), true);
    assert.equal(touchesBulk([{ id: "R1", type: "fact", status: "raw" }]), true);
    assert.equal(touchesBulk([{ id: "D1", type: "decision", status: "canon" }]), false);
    assert.equal(touchesBulk([]), false);
  });

  it("предел совпадает с движком: 500", () => {
    assert.equal(BULK_MAX, 500);
  });
});

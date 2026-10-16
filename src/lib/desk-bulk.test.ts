import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BULK_MAX, bulkExpr, parseIds } from "./desk-bulk.ts";

describe("какая строка массовая: RAW и OBS (AUD-15)", () => {
  it("ACCEPT, TAKE и FILL над RAW или OBS — массовые, выражение отдаётся для IDS", () => {
    assert.equal(bulkExpr("ACCEPT RAW"), "RAW");
    assert.equal(bulkExpr("take obs"), "obs");
    assert.equal(bulkExpr("ACCEPT NEQ ∩ RAW"), "NEQ ∩ RAW");
    assert.equal(bulkExpr("ACCEPT OBSERVATION"), "OBSERVATION");
    assert.equal(bulkExpr("TAKE RAW \\ A"), "RAW \\ A");
    assert.equal(bulkExpr("FILL"), "NEQ ∩ RAW");
  });

  it("одиночные id, другие наборы и другие глаголы массовыми не считаются", () => {
    for (const line of [
      "ACCEPT A1",
      "TAKE JUNK",
      "SWEEP",
      "PURGE",
      "SET RAW",
      "IDS RAW",
      "PLANT текст",
      "RAW",
    ]) {
      assert.equal(bulkExpr(line), null, line);
    }
  });
});

describe("ответ IDS и предел списка", () => {
  it("по одному id в строке, пустые строки пропускаются", () => {
    assert.deepEqual(parseIds("B1\nB2\n\n  B3 \n"), ["B1", "B2", "B3"]);
    assert.deepEqual(parseIds(""), []);
  });

  it("предел совпадает с движком: 500", () => {
    assert.equal(BULK_MAX, 500);
  });
});

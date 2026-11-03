import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotLabel, snapshotRun, SNAPSHOT_ONLY_BOOK } from "./desk-snapshot.ts";

const BOOK = { taken: "2026-10-16", instr: { charge: 24 }, raw: [], canon: [], wires: [] };

describe("снимок стола для опубликованного сайта (AUD-03, вариант 3)", () => {
  it("exec JSON отдаёт книгу одной строкой вместе с датой снимка", () => {
    const r = snapshotRun(BOOK, ["exec", "JSON"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout.trim()), BOOK);
  });

  it("любая другая команда — отказ с понятным текстом; движок для этого не нужен", () => {
    for (const argv of [["exec", "LOOK", "C1"], ["exec", "SET", "RAW"], ["init"]]) {
      const r = snapshotRun(BOOK, argv);
      assert.equal(r.code, 2, argv.join(" "));
      assert.equal(r.stderr, SNAPSHOT_ONLY_BOOK);
      assert.equal(r.stdout, "");
    }
  });
});

describe("метка снимка", () => {
  it("дата показывается по-русски: 16.10.2026", () => {
    assert.equal(snapshotLabel("2026-10-16"), "Только чтение, снимок от 16.10.2026");
  });

  it("без правильной даты — метка без даты, а не падение", () => {
    assert.equal(snapshotLabel("вчера"), "Только чтение, снимок");
  });
});

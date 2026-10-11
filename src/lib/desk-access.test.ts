import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRITE_HINT, deskAccess, needsLogin, writeProps } from "./desk-access.ts";
import { VERBS, buildPmArgs, kindOf, verbKind } from "./pm-request.ts";

const GUEST = deskAccess({ user: null, isPending: false });
const LOADING = deskAccess({ user: null, isPending: true });
const MEMBER = deskAccess({ user: { id: "user-1" }, isPending: false });

/** По одной допустимой строке на правило аргументов из таблицы глаголов. */
const ARGS: Record<string, string> = {
  none: "",
  id: "X1",
  target: "X1",
  set: "RAW",
  pair: "C A",
  wire: "X1 X2",
  packet: "",
  name: "LANG.md",
  words: "слово",
  text: "текст",
  batch: "RAW; CANON",
};

describe("deskAccess: что показать посетителю", () => {
  it("без входа — режим просмотра, пока сессия не определилась — ни то ни другое", () => {
    assert.deepEqual(GUEST, { canWrite: false, pending: false, readOnly: true });
    assert.deepEqual(LOADING, { canWrite: false, pending: true, readOnly: false });
  });

  it("вошедший пишет, даже если сессия обновляется в фоне", () => {
    assert.deepEqual(MEMBER, { canWrite: true, pending: false, readOnly: false });
    const refetch = deskAccess({ user: { id: "u" }, isPending: true });
    assert.deepEqual(refetch, { canWrite: true, pending: false, readOnly: false });
  });

  it("пользователь undefined — то же, что его нет", () => {
    assert.equal(deskAccess({ user: undefined, isPending: false }).canWrite, false);
  });

  it("кнопка записи: серая и с подсказкой без входа, обычная со входом", () => {
    assert.deepEqual(writeProps(false), { disabled: true, title: WRITE_HINT });
    assert.deepEqual(writeProps(true), { disabled: false, title: undefined });
  });
});

describe("needsLogin: гостю не пройдёт запись", () => {
  it("чтение проходит всегда, запись и массовые глаголы — только со входом", () => {
    for (const access of [GUEST, LOADING, MEMBER]) assert.equal(needsLogin("read", access), false);
    assert.equal(needsLogin("write", GUEST), true);
    assert.equal(needsLogin("bulk", GUEST), true);
    assert.equal(needsLogin("write", MEMBER), false);
    assert.equal(needsLogin("bulk", MEMBER), false);
  });

  it("пока сессия определяется, решает сервер; неизвестный глагол тоже на сервере", () => {
    assert.equal(needsLogin("write", LOADING), false);
    assert.equal(needsLogin("bulk", LOADING), false);
    assert.equal(needsLogin(null, GUEST), false);
  });
});

describe("интерфейс и сервер решают одинаково", () => {
  it("для каждого глагола таблицы: гость получает отказ сервера login_required ровно там, где интерфейс говорит «нужен вход»", () => {
    for (const [verb, v] of Object.entries(VERBS)) {
      const line = `${verb} ${ARGS[v.rule]}`.trim();
      const server = buildPmArgs({ line }, null);
      const mine = needsLogin(verbKind(verb), GUEST);
      if (v.kind === "read") {
        assert.ok(server.ok, `${line}: ${JSON.stringify(server)}`);
        assert.equal(mine, false, line);
      } else {
        assert.ok(
          !server.ok && server.code === "login_required",
          `${line}: ${JSON.stringify(server)}`,
        );
        assert.equal(mine, true, line);
      }
      assert.equal(buildPmArgs({ line }, { id: "u" }).ok, true, line);
      assert.equal(kindOf({ line }), v.kind, line);
    }
  });

  it("лента PLANT: с лентой это запись, и гостю нужен вход", () => {
    const server = buildPmArgs({ line: "PLANT", tape: "id\ttitle\nB1\tx" }, null);
    assert.ok(!server.ok && server.code === "login_required");
    assert.equal(needsLogin(verbKind("PLANT"), GUEST), true);
  });
});

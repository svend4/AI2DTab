import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_WRITER_HINT,
  READ_ONLY_HINT,
  WRITE_HINT,
  deniedMessage,
  deskAccess,
  writeProps,
} from "./desk-access.ts";
import {
  LOGIN_MESSAGE,
  NOT_WRITER_MESSAGE,
  READ_ONLY_MESSAGE,
  VERBS,
  buildPmArgs,
  kindOf,
  verbKind,
} from "./pm-request.ts";

const USER = { id: "user-1" };
const GUEST = deskAccess({ user: null, isPending: false, writer: null });
const LOADING = deskAccess({ user: null, isPending: true, writer: null });
const ASKING = deskAccess({ user: USER, isPending: false, writer: null }); // вошёл, ответа о допуске ещё нет
const READER = deskAccess({ user: USER, isPending: false, writer: false }); // вошёл, но не допущен
const WRITER = deskAccess({ user: USER, isPending: false, writer: true });

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
  it("гость — режим просмотра; пока сессия не определилась — ни то ни другое", () => {
    assert.deepEqual(GUEST, {
      canWrite: false,
      signedIn: false,
      pending: false,
      readOnly: true,
      snapshot: false,
    });
    assert.deepEqual(LOADING, {
      canWrite: false,
      signedIn: false,
      pending: true,
      readOnly: false,
      snapshot: false,
    });
  });

  it("вошёл, а допуск ещё спрашиваем — ожидание, писать пока нельзя", () => {
    assert.deepEqual(ASKING, {
      canWrite: false,
      signedIn: true,
      pending: true,
      readOnly: false,
      snapshot: false,
    });
  });

  it("вошёл без допуска — режим просмотра, но он вошёл", () => {
    assert.deepEqual(READER, {
      canWrite: false,
      signedIn: true,
      pending: false,
      readOnly: true,
      snapshot: false,
    });
  });

  it("допущенный пишет, даже если сессия обновляется в фоне", () => {
    assert.deepEqual(WRITER, {
      canWrite: true,
      signedIn: true,
      pending: false,
      readOnly: false,
      snapshot: false,
    });
    const refetch = deskAccess({ user: { id: "u" }, isPending: true, writer: true });
    assert.deepEqual(refetch, {
      canWrite: true,
      signedIn: true,
      pending: false,
      readOnly: false,
      snapshot: false,
    });
  });

  it("допуск без пользователя не считается: писать нельзя", () => {
    const stale = deskAccess({ user: null, isPending: false, writer: true });
    assert.equal(stale.canWrite, false);
    assert.equal(stale.signedIn, false);
    assert.equal(deskAccess({ user: undefined, isPending: false, writer: true }).canWrite, false);
  });

  it("допуск не true — писать нельзя: ни единица, ни строка, ни объект", () => {
    for (const writer of [1, "true", {}, []]) {
      const a = deskAccess({ user: USER, isPending: false, writer: writer as unknown as boolean });
      assert.equal(a.canWrite, false, JSON.stringify(writer));
    }
  });
});

describe("writeProps: кнопка записи", () => {
  it("допущенному — обычная", () => {
    assert.deepEqual(writeProps(WRITER), { disabled: false, title: undefined });
  });

  it("гостю — серая с подсказкой про вход, вошедшему без допуска — про допуск, пока спрашиваем — серая без подсказки", () => {
    assert.deepEqual(writeProps(GUEST), { disabled: true, title: WRITE_HINT });
    assert.deepEqual(writeProps(READER), { disabled: true, title: NOT_WRITER_HINT });
    assert.deepEqual(writeProps(LOADING), { disabled: true, title: undefined });
    assert.deepEqual(writeProps(ASKING), { disabled: true, title: undefined });
    assert.notEqual(WRITE_HINT, NOT_WRITER_HINT);
  });
});

describe("deniedMessage: что ответит сервер, если писать нельзя", () => {
  it("чтение проходит всегда, у допущенного ничего не отказывается", () => {
    for (const a of [GUEST, LOADING, ASKING, READER, WRITER]) {
      assert.equal(deniedMessage("read", a), null);
      assert.equal(deniedMessage(null, a), null);
    }
    assert.equal(deniedMessage("write", WRITER), null);
    assert.equal(deniedMessage("bulk", WRITER), null);
  });

  it("гость получает «нужен вход», вошедший без допуска — «нет допуска»; запись и массовые одинаково", () => {
    for (const kind of ["write", "bulk"] as const) {
      assert.equal(deniedMessage(kind, GUEST), LOGIN_MESSAGE);
      assert.equal(deniedMessage(kind, READER), NOT_WRITER_MESSAGE);
    }
  });

  it("пока сессия или допуск определяются, решает сервер", () => {
    for (const kind of ["write", "bulk"] as const) {
      assert.equal(deniedMessage(kind, LOADING), null);
      assert.equal(deniedMessage(kind, ASKING), null);
    }
  });
});

describe("интерфейс и сервер решают одинаково", () => {
  it("для каждого глагола таблицы: отказ сервера и сообщение интерфейса совпадают у гостя и у вошедшего без допуска", () => {
    for (const [verb, v] of Object.entries(VERBS)) {
      const line = `${verb} ${ARGS[v.rule]}`.trim();
      const kind = verbKind(verb);
      assert.equal(kindOf({ line }), v.kind, line);
      const cases = [
        { user: null, access: GUEST, code: "login_required", text: LOGIN_MESSAGE },
        {
          user: { id: "u", writer: false },
          access: READER,
          code: "not_writer",
          text: NOT_WRITER_MESSAGE,
        },
      ];
      for (const c of cases) {
        const server = buildPmArgs({ line }, c.user);
        const mine = deniedMessage(kind, c.access);
        if (v.kind === "read") {
          assert.ok(server.ok, `${line}: ${JSON.stringify(server)}`);
          assert.equal(mine, null, line);
        } else {
          assert.ok(!server.ok && server.code === c.code, `${line}: ${JSON.stringify(server)}`);
          assert.equal(mine, c.text, line);
          assert.equal(!server.ok && server.message, c.text, line);
        }
      }
      assert.equal(buildPmArgs({ line }, { id: "u", writer: true }).ok, true, line);
      assert.equal(deniedMessage(kind, WRITER), null, line);
    }
  });

  it("лента PLANT: с лентой это запись, гостю нужен вход, вошедшему без допуска — допуск", () => {
    const tape = "id\ttitle\nB1\tx";
    const guest = buildPmArgs({ line: "PLANT", tape }, null);
    assert.ok(!guest.ok && guest.code === "login_required");
    const reader = buildPmArgs({ line: "PLANT", tape }, { id: "u", writer: false });
    assert.ok(!reader.ok && reader.code === "not_writer");
    assert.equal(deniedMessage(verbKind("PLANT"), GUEST), LOGIN_MESSAGE);
    assert.equal(deniedMessage(verbKind("PLANT"), READER), NOT_WRITER_MESSAGE);
  });
});

describe("снимок: опубликованный сайт только читает (AUD-03, вариант 3)", () => {
  const writer = { user: { id: "u" }, isPending: false, writer: true };

  it("даже допущенный не пишет: кнопки серые с пометкой про снимок", () => {
    const access = deskAccess({ ...writer, snapshot: true });
    assert.equal(access.canWrite, false);
    assert.deepEqual(writeProps(access), { disabled: true, title: READ_ONLY_HINT });
  });

  it("без снимка всё как прежде", () => {
    const access = deskAccess(writer);
    assert.equal(access.snapshot, false);
    assert.deepEqual(writeProps(access), { disabled: false, title: undefined });
  });

  it("строка команд отказывает записи тем же текстом, что сервер; чтение проходит", () => {
    const access = deskAccess({ ...writer, snapshot: true });
    assert.equal(deniedMessage("write", access), READ_ONLY_MESSAGE);
    assert.equal(deniedMessage("bulk", access), READ_ONLY_MESSAGE);
    assert.equal(deniedMessage("read", access), null);
  });
});

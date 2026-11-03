import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRITERS_ENV, isWriter, parseWriters } from "./desk-writers.ts";
import { isDeskWriter, resetWriterWarnings } from "./desk-writers.server.ts";
import type { WriterIdentity } from "./desk-writers.ts";

const OWNER: WriterIdentity = { email: "owner@example.com", emailVerified: true };

describe("parseWriters: переменная DESK_WRITERS", () => {
  it("разделители любые: запятая, точка с запятой, пробел, перевод строки; регистр не важен", () => {
    const { writers, ignored } = parseWriters(
      " Owner@Example.com, second@example.org;third@example.net\nfourth@example.io\t fifth@example.dev ",
    );
    assert.deepEqual([...writers].sort(), [
      "fifth@example.dev",
      "fourth@example.io",
      "owner@example.com",
      "second@example.org",
      "third@example.net",
    ]);
    assert.equal(ignored, 0);
  });

  it("пусто, не задано, пробелы — пустой список", () => {
    for (const raw of [undefined, null, "", "   ", ",,;;\n"]) {
      const r = parseWriters(raw);
      assert.equal(r.writers.size, 0, String(raw));
      assert.equal(r.ignored, 0, String(raw));
    }
  });

  it("не адреса отбрасываются и считаются, сами записи не возвращаются", () => {
    const r = parseWriters(
      "owner@example.com, no-at-sign, @example.com, a@b, two@@example.com, x@y@example.com, name@.com, name@com., admin@localhost, ok@example.org",
    );
    assert.deepEqual([...r.writers].sort(), ["ok@example.org", "owner@example.com"]);
    assert.equal(r.ignored, 8);
    assert.ok(!JSON.stringify(r).includes("no-at-sign"));
  });

  it("управляющие знаки в адресе — не адрес", () => {
    assert.equal(parseWriters("own\u0000er@example.com").writers.size, 0);
    assert.equal(parseWriters("own\u007fer@example.com").writers.size, 0);
  });

  it("дубликаты в разном регистре — один адрес", () => {
    assert.equal(parseWriters("A@example.com, a@EXAMPLE.com").writers.size, 1);
  });
});

describe("isWriter: допущен только подтверждённый адрес из списка", () => {
  const writers = parseWriters("owner@example.com, Second@Example.org").writers;

  it("адрес из списка и подтверждён — допущен, регистр записи пользователя не важен", () => {
    assert.equal(isWriter(OWNER, writers), true);
    assert.equal(isWriter({ email: "OWNER@Example.COM", emailVerified: true }, writers), true);
    assert.equal(isWriter({ email: " second@example.org ", emailVerified: true }, writers), true);
  });

  it("адрес не подтверждён — не допущен, хотя он в списке", () => {
    assert.equal(isWriter({ email: "owner@example.com", emailVerified: false }, writers), false);
    for (const emailVerified of [undefined, null, 1, "true", "yes"]) {
      const identity = { email: "owner@example.com", emailVerified } as unknown as WriterIdentity;
      assert.equal(isWriter(identity, writers), false, String(emailVerified));
    }
  });

  it("чужой адрес, пустой адрес, нет записи — не допущены", () => {
    assert.equal(isWriter({ email: "other@example.com", emailVerified: true }, writers), false);
    assert.equal(isWriter({ email: null, emailVerified: true }, writers), false);
    assert.equal(isWriter({ email: "", emailVerified: true }, writers), false);
    assert.equal(isWriter(null, writers), false);
    assert.equal(isWriter(undefined, writers), false);
  });

  it("похожие адреса не совпадают: псевдонимы Gmail, метки, юникодные двойники, лишний хвост", () => {
    const gmail = parseWriters("owner@gmail.com").writers;
    for (const email of [
      "o.wner@gmail.com",
      "owner+x@gmail.com",
      "owner@gmail.com.evil.test",
      "xowner@gmail.com",
      "owner@gmail.co",
      "ｏｗｎｅｒ@gmail.com", // полноширинные буквы
      "owner@gmaıl.com", // турецкая i без точки
    ]) {
      assert.equal(isWriter({ email, emailVerified: true }, gmail), false, email);
    }
  });

  it("пустой список не допускает никого", () => {
    assert.equal(isWriter(OWNER, new Set()), false);
  });
});

describe("isDeskWriter: список из окружения и запись пользователя", () => {
  function fakeLookup(identity: WriterIdentity | null) {
    const asked: string[] = [];
    return {
      asked,
      lookup: async (id: string) => {
        asked.push(id);
        return identity;
      },
    };
  }

  it("в списке и подтверждён — допущен, и спрашивали запись именно этого пользователя", async () => {
    const f = fakeLookup(OWNER);
    const env = { [WRITERS_ENV]: "owner@example.com" };
    assert.equal(await isDeskWriter("user-1", { env, lookup: f.lookup, warn: () => {} }), true);
    assert.deepEqual(f.asked, ["user-1"]);
  });

  it("не задана или пуста — закрыто, базу входа не трогаем, предупреждение ровно одно", async () => {
    resetWriterWarnings();
    const f = fakeLookup(OWNER);
    const warnings: string[] = [];
    for (const env of [{}, { [WRITERS_ENV]: "" }, { [WRITERS_ENV]: "  ,; " }]) {
      assert.equal(
        await isDeskWriter("user-1", { env, lookup: f.lookup, warn: (m) => warnings.push(m) }),
        false,
      );
    }
    assert.deepEqual(f.asked, []);
    assert.equal(warnings.length, 1, warnings.join(" | "));
    assert.match(warnings[0], /DESK_WRITERS/);
  });

  it("отброшенные записи: одно предупреждение с числом, без самих записей", async () => {
    resetWriterWarnings();
    const f = fakeLookup(OWNER);
    const warnings: string[] = [];
    const env = { [WRITERS_ENV]: "owner@example.com, секрет-не-адрес, ещё-одно" };
    for (let i = 0; i < 3; i++)
      await isDeskWriter("user-1", { env, lookup: f.lookup, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 записей/);
    assert.ok(!warnings[0].includes("секрет"));
    assert.ok(!warnings[0].includes("example.com"));
  });

  it("адреса нет в списке, не подтверждён или записи нет — не допущен", async () => {
    const env = { [WRITERS_ENV]: "owner@example.com" };
    for (const identity of [
      { email: "other@example.com", emailVerified: true },
      { email: "owner@example.com", emailVerified: false },
      null,
    ]) {
      const f = fakeLookup(identity);
      assert.equal(await isDeskWriter("user-2", { env, lookup: f.lookup, warn: () => {} }), false);
    }
  });

  it("сбой чтения базы входа не превращается в «не допущен»: ошибка доходит до вызывающего", async () => {
    const env = { [WRITERS_ENV]: "owner@example.com" };
    await assert.rejects(
      isDeskWriter("user-1", {
        env,
        lookup: async () => {
          throw new Error("база входа недоступна");
        },
        warn: () => {},
      }),
      /база входа недоступна/,
    );
  });
});

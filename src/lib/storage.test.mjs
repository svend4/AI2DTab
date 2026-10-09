// Тест src/lib/storage.ts в Node: заглушки localStorage и крошечная фальшивая IndexedDB.
// Запуск: node --experimental-strip-types --test <этот файл>
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MOD = new URL("./storage.ts", import.meta.url);

// ---------- заглушка localStorage ----------
function fakeLocalStorage({ quotaBytes = Infinity, throwOnGet = false } = {}) {
  const m = new Map();
  return {
    getItem(k) {
      if (throwOnGet) throw new Error("SecurityError");
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (v.length > quotaBytes) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem(k) {
      m.delete(k);
    },
    _map: m,
  };
}

// ---------- крошечная фальшивая IndexedDB (только то, что использует storage.ts) ----------
function fakeIndexedDB({ failPut = false, failOpen = false } = {}) {
  const data = new Map();
  const fire = (target, handler, ...args) => queueMicrotask(() => target[handler]?.(...args));
  function request(exec) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = exec();
        req.onsuccess?.({ target: req });
      } catch (e) {
        req.error = e;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }
  function transaction(name, mode) {
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
    let pending = 0;
    const settle = () => {
      pending -= 1;
      if (pending === 0) fire(tx, tx.error ? "onabort" : "oncomplete");
    };
    const store = {
      get: (k) => wrap(() => data.get(k)),
      put: (v, k) => wrap(() => {
        if (failPut) throw new DOMException("QuotaExceededError", "QuotaExceededError");
        if (mode !== "readwrite") throw new Error("ReadOnlyError");
        data.set(k, v);
        return k;
      }),
      delete: (k) => wrap(() => {
        data.delete(k);
        return undefined;
      }),
    };
    function wrap(exec) {
      pending += 1;
      const req = request(exec);
      const origErr = () => {
        tx.error = req.error;
      };
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (req.error) origErr();
          settle();
        });
      });
      return req;
    }
    return { objectStore: () => store, ...tx, get error() { return tx.error; }, set oncomplete(f) { tx.oncomplete = f; }, set onerror(f) { tx.onerror = f; }, set onabort(f) { tx.onabort = f; } };
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction,
    close() {},
    onversionchange: null,
  };
  return {
    _data: data,
    open() {
      const req = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error("InvalidStateError");
          req.onerror?.({ target: req });
          return;
        }
        req.result = db;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

const book = (seq) => ({ version: 2, objects: [{ id: "x" }], links: [], origins: [], events: [{ seq, ts: "t", actor: "a", action: "seed" }] });

let storage;
beforeEach(async () => {
  delete globalThis.indexedDB;
  delete globalThis.localStorage;
  // свежий модуль на каждый тест — у него есть память-страховка
  storage = await import(`${MOD.href}?t=${Math.random()}`);
});

describe("storage: откат на localStorage", () => {
  it("без IndexedDB пишет в localStorage и читает обратно", async () => {
    globalThis.localStorage = fakeLocalStorage();
    const r = await storage.saveBook(book(3));
    assert.equal(r.ok, true);
    assert.equal(r.where, "local");
    assert.ok(r.bytes > 10);
    assert.equal(r.error, undefined);
    assert.ok(globalThis.localStorage._map.has("desk-v2-book"));
    const b = await storage.loadBook();
    assert.equal(b.events[0].seq, 3);
  });

  it("квота localStorage исчерпана → where=memory, ok=false, ошибка в тексте, не бросает", async () => {
    globalThis.localStorage = fakeLocalStorage({ quotaBytes: 10 });
    const r = await storage.saveBook(book(1));
    assert.equal(r.ok, false);
    assert.equal(r.where, "memory");
    assert.match(r.error, /localStorage/);
    // но копия в памяти читается
    const b = await storage.loadBook();
    assert.equal(b.events[0].seq, 1);
  });

  it("localStorage бросает на доступе → загрузка даёт null, сохранение не бросает", async () => {
    globalThis.localStorage = fakeLocalStorage({ throwOnGet: true });
    assert.equal(await storage.loadBook(), null);
    const r = await storage.saveBook(book(1));
    assert.equal(r.ok, true); // setItem у заглушки работает
    assert.equal(r.where, "local");
  });

  it("ничего нет (SSR) → load=null, save→memory", async () => {
    assert.equal(await storage.loadBook(), null);
    const r = await storage.saveBook(book(1));
    assert.equal(r.ok, false);
    assert.equal(r.where, "memory");
  });

  it("повреждённый JSON в localStorage → null", async () => {
    globalThis.localStorage = fakeLocalStorage();
    globalThis.localStorage.setItem("desk-v2-book", "{oops");
    assert.equal(await storage.loadBook(), null);
  });

  it("clearBook стирает localStorage и память", async () => {
    globalThis.localStorage = fakeLocalStorage();
    await storage.saveBook(book(1));
    await storage.clearBook();
    assert.equal(globalThis.localStorage._map.has("desk-v2-book"), false);
    assert.equal(await storage.loadBook(), null);
  });

  it("книга не сериализуется → ok=false без исключения", async () => {
    const cyc = { version: 2, objects: [], links: [], origins: [], events: [] };
    cyc.self = cyc;
    const r = await storage.saveBook(cyc);
    assert.equal(r.ok, false);
    assert.match(r.error, /сериализуется/);
  });
});

describe("storage: IndexedDB (фальшивая)", () => {
  it("пишет в IDB и читает оттуда", async () => {
    globalThis.indexedDB = fakeIndexedDB();
    globalThis.localStorage = fakeLocalStorage();
    const r = await storage.saveBook(book(5));
    assert.equal(r.ok, true);
    assert.equal(r.where, "idb");
    assert.equal(globalThis.localStorage._map.size, 0);
    const b = await storage.loadBook();
    assert.equal(b.events[0].seq, 5);
  });

  it("миграция: IDB пуста, localStorage полон → читает, переносит в IDB, чистит localStorage", async () => {
    globalThis.indexedDB = fakeIndexedDB();
    globalThis.localStorage = fakeLocalStorage();
    globalThis.localStorage.setItem("desk-v2-book", JSON.stringify(book(7)));
    const b = await storage.loadBook();
    assert.equal(b.events[0].seq, 7);
    assert.equal(typeof globalThis.indexedDB._data.get("current"), "string");
    assert.equal(globalThis.localStorage._map.has("desk-v2-book"), false);
  });

  it("обе копии есть → берётся та, где журнал длиннее", async () => {
    globalThis.indexedDB = fakeIndexedDB();
    globalThis.localStorage = fakeLocalStorage();
    globalThis.indexedDB._data.set("current", JSON.stringify(book(2)));
    globalThis.localStorage.setItem("desk-v2-book", JSON.stringify(book(9)));
    assert.equal((await storage.loadBook()).events[0].seq, 9);
    globalThis.indexedDB._data.set("current", JSON.stringify(book(20)));
    globalThis.localStorage.setItem("desk-v2-book", JSON.stringify(book(9)));
    assert.equal((await storage.loadBook()).events[0].seq, 20);
  });

  it("IDB.put падает → откат на localStorage, ok=true, where=local", async () => {
    globalThis.indexedDB = fakeIndexedDB({ failPut: true });
    globalThis.localStorage = fakeLocalStorage();
    const r = await storage.saveBook(book(1));
    assert.equal(r.ok, true);
    assert.equal(r.where, "local");
  });

  it("IDB не открывается, localStorage нет → memory с текстом ошибки", async () => {
    globalThis.indexedDB = fakeIndexedDB({ failOpen: true });
    const r = await storage.saveBook(book(1));
    assert.equal(r.ok, false);
    assert.equal(r.where, "memory");
    assert.match(r.error, /IndexedDB/);
  });

  it("clearBook стирает и IDB", async () => {
    globalThis.indexedDB = fakeIndexedDB();
    await storage.saveBook(book(1));
    await storage.clearBook();
    assert.equal(globalThis.indexedDB._data.has("current"), false);
  });
});

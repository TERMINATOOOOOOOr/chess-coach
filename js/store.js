// Хранилище на устройстве: партии с разборами и настройки.
// IndexedDB, а если он недоступен (приватный режим, file://) — localStorage или память.

const DB_NAME = 'shoh';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => (out = r.result);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Запасной вариант: localStorage, а если и он недоступен — память. */
function fallback() {
  const mem = new Map();
  const ls = (() => {
    try {
      localStorage.setItem('shoh.__t', '1');
      localStorage.removeItem('shoh.__t');
      return localStorage;
    } catch {
      return null;
    }
  })();
  const get = (k) => {
    if (ls) {
      const v = ls.getItem('shoh.db.' + k);
      return v == null ? undefined : JSON.parse(v);
    }
    return mem.get(k);
  };
  const set = (k, v) => (ls ? ls.setItem('shoh.db.' + k, JSON.stringify(v)) : mem.set(k, v));
  const del = (k) => (ls ? ls.removeItem('shoh.db.' + k) : mem.delete(k));
  return {
    async allGames() {
      return (get('games') || []).map((id) => get('g.' + id)).filter(Boolean);
    },
    async getGame(id) {
      return get('g.' + id) || null;
    },
    async putGame(g) {
      const ids = new Set(get('games') || []);
      ids.add(g.id);
      set('games', [...ids]);
      set('g.' + g.id, g);
    },
    async deleteGame(id) {
      set('games', (get('games') || []).filter((x) => x !== id));
      del('g.' + id);
    },
    async getSetting(k, d) {
      const v = get('kv.' + k);
      return v === undefined ? d : v;
    },
    async setSetting(k, v) {
      set('kv.' + k, v);
    },
  };
}

function idbStore(dbPromise) {
  const db = () => dbPromise;
  return {
    async allGames() {
      return tx(await db(), 'games', 'readonly', (s) => s.getAll());
    },
    async getGame(id) {
      return (await tx(await db(), 'games', 'readonly', (s) => s.get(id))) || null;
    },
    async putGame(g) {
      await tx(await db(), 'games', 'readwrite', (s) => s.put(g));
    },
    async deleteGame(id) {
      await tx(await db(), 'games', 'readwrite', (s) => s.delete(id));
    },
    async getSetting(k, d) {
      const v = await tx(await db(), 'kv', 'readonly', (s) => s.get(k));
      return v === undefined ? d : v;
    },
    async setSetting(k, v) {
      await tx(await db(), 'kv', 'readwrite', (s) => s.put(v, k));
    },
  };
}

let impl = null;
async function store() {
  if (impl) return impl;
  try {
    const p = openDb();
    await p;
    impl = idbStore(p);
  } catch {
    impl = fallback();
  }
  return impl;
}

export const db = {
  allGames: async () => (await store()).allGames(),
  getGame: async (id) => (await store()).getGame(id),
  putGame: async (g) => (await store()).putGame(g),
  deleteGame: async (id) => (await store()).deleteGame(id),
  getSetting: async (k, d) => (await store()).getSetting(k, d),
  setSetting: async (k, v) => (await store()).setSetting(k, v),
};

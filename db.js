// Sunseat – kleine Datenbank im Browser (IndexedDB): Zwischenspeicher und Rückmeldungen.
// Alles bleibt auf dem Gerät. Fehler (z. B. privates Fenster) werden geschluckt – die App
// funktioniert dann einfach ohne Speicher.

let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('sunseat', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('feedback')) {
            const s = db.createObjectStore('feedback', { keyPath: 'id', autoIncrement: true });
            s.createIndex('placeId', 'place.id');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}

/** Zwischenspeicher: Wert mit Ablaufzeit. */
export async function cacheGet(key, maxAgeMs) {
  const e = await tx('kv', 'readonly', (s) => s.get(key));
  if (!e || Date.now() - e.t > maxAgeMs) return undefined;
  return e.v;
}

export function cacheSet(key, value) {
  return tx('kv', 'readwrite', (s) => s.put({ t: Date.now(), v: value }, key));
}

/** Rückmeldung speichern („ist es jetzt sonnig?“). */
export function addFeedback(record) {
  return tx('feedback', 'readwrite', (s) => s.add(record));
}

export function allFeedback() {
  return tx('feedback', 'readonly', (s) => s.getAll()).then((r) => r || []);
}

export function feedbackFor(placeId) {
  return tx('feedback', 'readonly', (s) => s.index('placeId').getAll(placeId)).then((r) => r || []);
}

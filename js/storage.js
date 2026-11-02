// Persistence: small settings in localStorage, the channel library in IndexedDB
// (playlists can hold thousands of channels, which outgrows localStorage).

export function createStorage(namespace) {
  const lsKey = `whiparound:${namespace}:settings`;
  const idbKey = `${namespace}:library`;

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(lsKey) || 'null');
    } catch {
      return null;
    }
  }

  function saveSettings(obj) {
    try {
      localStorage.setItem(lsKey, JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open('whiparound', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function loadLibrary() {
    try {
      return (await idb('readonly', (s) => s.get(idbKey))) || [];
    } catch {
      try {
        return JSON.parse(localStorage.getItem(`whiparound:${idbKey}`) || '[]');
      } catch {
        return [];
      }
    }
  }

  async function saveLibrary(list) {
    try {
      await idb('readwrite', (s) => s.put(list, idbKey));
      return true;
    } catch {
      try {
        localStorage.setItem(`whiparound:${idbKey}`, JSON.stringify(list));
        return true;
      } catch {
        return false;
      }
    }
  }

  function clearAll() {
    try {
      localStorage.removeItem(lsKey);
      localStorage.removeItem(`whiparound:${idbKey}`);
    } catch {}
    return saveLibrary([]);
  }

  return { loadSettings, saveSettings, loadLibrary, saveLibrary, clearAll };
}

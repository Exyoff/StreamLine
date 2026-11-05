// On-device project library (IndexedDB). Each project keeps its document (history, sketches, settings of
// the scene) plus an exported copy of its solids, so it can be inserted into other projects as a linked
// component and synced when it changes.
const DB = 'streamline', STORE = 'projects', VERSION = 1;
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(STORE, mode), s = t.objectStore(STORE); const r = fn(s); t.oncomplete = () => res(r && 'result' in r ? r.result : undefined); t.onerror = () => rej(t.error); }); };

export const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export async function list() {
  const all = await tx('readonly', s => s.getAll());
  return (all || []).map(({ data, exportBrep, parts, ...meta }) => ({ ...meta, hasSolids: !!exportBrep })).sort((a, b) => b.updated - a.updated);
}
export const get = id => tx('readonly', s => s.get(id));
export const put = rec => tx('readwrite', s => s.put(rec));
export const remove = id => tx('readwrite', s => s.delete(id));
export async function rename(id, name) { const r = await get(id); if (r) { r.name = name; r.updated = Date.now(); await put(r); } }
export async function duplicate(id) {
  const r = await get(id); if (!r) return null;
  const c = { ...r, id: newId(), name: r.name + ' copy', created: Date.now(), updated: Date.now(), version: 1 };
  await put(c); return c;
}

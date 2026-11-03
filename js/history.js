// Parametric history (timeline). Every solid-making operation is recorded with its parameters and the
// selection it ran on; sketches are recorded where they were created. Editing a sketch, or the
// parameters of an earlier feature, replays everything after it so later features follow the change.
// A rollback marker hides the features after it; new work is inserted at the marker.
import { S, emit } from './state.js';
import { cloneObj } from './scene.js';
import { PolyMesh } from './mesh.js';

const REG = new Map();      // op name -> def
const FACTORY = new Map();  // factory name -> (...args) => def
export function registerOps(prefix, mod) {
  for (const [k, v] of Object.entries(mod)) {
    if (v && typeof v === 'object' && typeof v.apply === 'function' && !v.opName) { REG.set(prefix + k, v); v.opName = prefix + k; }
  }
}
export function registerFactory(name, fn) { FACTORY.set(name, fn); }
export function defOf(rec) {
  if (rec.op === '_bake' || rec.op === '_xf') return BAKED[rec.op];
  if (rec.factory) { const f = FACTORY.get(rec.factory); return f ? f(...rec.args) : null; }
  return REG.get(rec.op) || null;
}
export function recName(def) { return def.opName || null; }

// ---------- doc fields ----------
export function hist() { return (S.doc.history ||= []); }
export function markerIndex() { const h = hist(); return S.doc.marker == null ? h.length : Math.min(S.doc.marker, h.length); }
let uid = 0;
const newRecId = () => `r${Date.now().toString(36)}${(uid++).toString(36)}`;

export function edSnap() {
  return { selected: [...S.ed.selected], active: S.ed.active, editSel: [...S.ed.editSel], selOrder: S.ed.selOrder.slice(), mode: S.ed.mode, pick: S.ed.pick, faces: JSON.parse(JSON.stringify(S.ed.faces || [])), edges: JSON.parse(JSON.stringify(S.ed.edges || [])), profiles: JSON.parse(JSON.stringify(S.ed.profiles || [])), sketch: S.ed.sketch };
}
function setEd(e) {
  if (!e) return;
  S.ed.selected = new Set(e.selected); S.ed.active = e.active; S.ed.editSel = new Set(e.editSel); S.ed.selOrder = e.selOrder.slice();
  S.ed.mode = e.mode; S.ed.pick = e.pick; S.ed.faces = JSON.parse(JSON.stringify(e.faces)); S.ed.edges = JSON.parse(JSON.stringify(e.edges));
  S.ed.profiles = JSON.parse(JSON.stringify(e.profiles)); S.ed.sketch = e.sketch;
}

// insert a record at the marker (and move the marker past it while rolled back)
export function insertRecord(rec) {
  const h = hist(), at = markerIndex();
  rec.id ??= newRecId(); rec.t ??= Date.now();
  h.splice(at, 0, rec);
  if (S.doc.marker != null) S.doc.marker = at + 1;
  invalidate(at);
  emit('timeline');
  return rec;
}

// ---------- baked steps (operations that can't be re-run from parameters, e.g. imports) ----------
const objJSON = o => ({ ...o, mesh: o.mesh.toJSON() });
const objFrom = j => ({ ...j, loc: j.loc.slice(), rot: j.rot.slice(), scl: j.scl.slice(), mesh: PolyMesh.from(j.mesh) });
const BAKED = {
  _bake: { label: () => 'Imported geometry', apply(p) { for (const j of p.add || []) { if (!S.doc.objects.some(o => o.id === j.id)) S.doc.objects.push(objFrom(j)); if (j.id >= S.doc.nextId) S.doc.nextId = j.id + 1; } } },
  _xf: { label: p => p.label || 'Transform', apply(p) { for (const x of p.objs) { const o = S.doc.objects.find(q => q.id === x.id); if (o) { o.loc = x.loc.slice(); o.rot = x.rot.slice(); o.scl = x.scl.slice(); } } } },
};
export function bakeAdded(baseList, label) {
  const ids = new Set(baseList.map(o => o.id));
  const add = S.doc.objects.filter(o => !ids.has(o.id)).map(objJSON);
  return add.length ? { op: '_bake', label, params: { add } } : null;
}
export function bakeXf(ids, label) {
  const objs = S.doc.objects.filter(o => ids.includes(o.id)).map(o => ({ id: o.id, loc: o.loc.slice(), rot: o.rot.slice(), scl: o.scl.slice() }));
  return objs.length ? { op: '_xf', label, params: { label, objs } } : null;
}

// ---------- checkpoints: state before record i ----------
let cps = []; // [{objects, nextId}]
export function invalidate(k = 0) { if (cps.length > k) cps.length = k; }
export function resetCache() { cps = []; }
const snapObjs = () => ({ objects: S.doc.objects.map(o => cloneObj(o)), nextId: S.doc.nextId });

const PRES = ['name', 'color', 'hidden', 'layer'];
// Re-run records from index `from` up to the marker. Sketches are authoritative (never replayed),
// presentation props (name, colour, visibility, layer) survive by object id. Returns failures.
export function regenerate(from = 0) {
  const h = hist(), end = markerIndex();
  from = Math.max(0, Math.min(from, end));
  let start = Math.max(0, Math.min(from, cps.length - 1));
  while (start > 0 && !cps[start]) start--;
  const keepEd = edSnap(), keepNext = S.doc.nextId, keepSk = JSON.stringify(S.doc.sketches || []);
  const pres = new Map(S.doc.objects.map(o => [o.id, Object.fromEntries(PRES.map(k => [k, o[k]]))]));
  const base = cps[start] || { objects: [], nextId: 1 };
  if (start === 0 && !cps[0]) cps[0] = base;
  S.doc.objects = base.objects.map(o => cloneObj(o)); S.doc.nextId = base.nextId;
  const failed = [];
  for (let i = start; i < end; i++) {
    cps[i] = snapObjs();
    const rec = h[i];
    delete rec.err;
    if (rec.off || rec.kind === 'sketch') continue;
    const def = defOf(rec);
    if (!def) { rec.err = 'Unknown operation'; failed.push(rec); continue; }
    setEd(rec.sel);
    let r;
    try { r = def.apply(rec.params, { handle: null, replay: true }); } catch (err) { console.error(err); r = err.message || 'Failed'; }
    if (typeof r === 'string') { rec.err = r; failed.push(rec); S.doc.objects = cps[i].objects.map(o => cloneObj(o)); S.doc.nextId = cps[i].nextId; }
  }
  cps[end] = snapObjs();
  cps.length = end + 1;
  for (const o of S.doc.objects) { const p = pres.get(o.id); if (p) for (const k of PRES) if (p[k] !== undefined) o[k] = p[k]; }
  S.doc.sketches = JSON.parse(keepSk);
  S.doc.nextId = Math.max(keepNext, S.doc.nextId);
  setEd(keepEd);
  const ids = new Set(S.doc.objects.map(o => o.id));
  S.ed.selected = new Set([...S.ed.selected].filter(id => ids.has(id)));
  if (!ids.has(S.ed.active)) { S.ed.active = null; if (S.ed.mode === 'edit') S.ed.mode = 'object'; }
  S.ed.faces = S.ed.faces.filter(f => ids.has(f.obj)); S.ed.edges = S.ed.edges.filter(e => ids.has(e.obj));
  emit('timeline');
  return failed;
}

// first record (before the marker) whose parameters reference one of these sketches
export function firstUsing(skIds) {
  const h = hist(), end = markerIndex();
  for (let i = 0; i < end; i++) {
    const r = h[i]; if (r.kind === 'sketch' || !r.params) continue;
    const s = JSON.stringify(r.params);
    if ([...skIds].some(id => new RegExp(`"sk":${id}[,}]`).test(s))) return i;
  }
  return -1;
}
export function sketchRecIndex(skId) { return hist().findIndex(r => r.kind === 'sketch' && r.sk === skId); }

// sketches created after the marker are hidden while rolled back
export function applyRollbackVisibility() {
  const h = hist(), end = markerIndex();
  for (const sk of S.doc.sketches || []) {
    const i = sketchRecIndex(sk.id);
    const future = i >= end;
    if (future && !sk._rb) { sk._rb = { hidden: sk.hidden }; sk.hidden = true; }
    else if (!future && sk._rb) { sk.hidden = sk._rb.hidden; delete sk._rb; }
  }
}

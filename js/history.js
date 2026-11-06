// Parametric history (timeline). Every solid-making operation is recorded with its parameters and the
// selection it ran on; sketches are recorded where they were created. Editing a sketch, or the
// parameters of an earlier feature, replays everything after it so later features follow the change.
// A rollback marker hides the features after it; new work is inserted at the marker.
import { S, emit } from './state.js';
import { cloneObj, worldVerts, objToJSON, objFromJSON, xfFor } from './scene.js';
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
const objJSON = objToJSON, objFrom = objFromJSON;
const BAKED = {
  _bake: { label: () => 'Imported geometry', apply(p) { for (const j of p.add || []) { if (!S.doc.objects.some(o => o.id === j.id)) S.doc.objects.push(objFrom(j)); if (j.id >= S.doc.nextId) S.doc.nextId = j.id + 1; } } },
  _xf: { label: p => p.label || 'Transform', apply(p) { for (const x of p.objs) { const o = S.doc.objects.find(q => q.id === x.id); if (o) { o.loc = x.loc.slice(); o.rot = x.rot.slice(); o.scl = x.scl.slice(); } } } },
};
export function bakeAdded(baseList, label) {
  const ids = new Set(baseList.map(o => o.id));
  const add = S.doc.objects.filter(o => !ids.has(o.id)).map(o => objJSON(o)); // (not .map(objJSON): the index would be its "light" flag)
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
// mates are constraints: solved again after every rebuild and edit (set by the app)
let postSolve = null;
export function setPostSolve(fn) { postSolve = fn; }
export function solveConstraints(extra) { if (postSolve) try { const h = hist().slice(0, markerIndex()); postSolve(extra && !h.some(r => r.params === extra.params) ? [...h, extra] : h); } catch (e) { console.warn(e); } }
export function regenerate(from = 0) {
  const h = hist(), end = markerIndex();
  from = Math.max(0, Math.min(from, end));
  let start = Math.max(0, Math.min(from, cps.length - 1));
  while (start > 0 && !cps[start]) start--;
  const keepEd = edSnap(), keepNext = S.doc.nextId, keepSk = JSON.stringify(S.doc.sketches || []);
  // (an object rolled out of existence keeps its name and colour for when it is rolled back in)
  const gone = S.doc.gonePres || (S.doc.gonePres = {});
  const pres = new Map([...Object.entries(gone).map(([id, p]) => [+id, p]), ...S.doc.objects.map(o => [o.id, Object.fromEntries(PRES.map(k => [k, o[k]]))])]);
  const base = cps[start] || { objects: [], nextId: 1 };
  if (start === 0 && !cps[0]) cps[0] = base;
  S.doc.objects = base.objects.map(o => cloneObj(o)); S.doc.nextId = base.nextId;
  const failed = [], moved = new Map();
  for (let i = start; i < end; i++) {
    cps[i] = snapObjs();
    const rec = h[i];
    delete rec.err;
    if (rec.kind === 'sketch') {
      // a sketch on a mated part: settle the mates so far first, so it lands where the part really is
      const sk = (S.doc.sketches || []).find(k => k.id === rec.sk);
      if (sk?.face && postSolve && h.slice(0, i).some(r => r.op === 'F.mateOp')) try { postSolve(h.slice(0, i)); } catch (e) {}
      followFace(rec.sk, moved); continue;
    }
    if (rec.off) continue;
    const def = defOf(rec);
    if (!def) { rec.err = 'Unknown operation'; failed.push(rec); continue; }
    setEd(rec.sel);
    let r;
    try { r = def.apply(rec.params, { handle: null, replay: true }); } catch (err) { console.error(err); r = err.message || 'Failed'; }
    if (typeof r === 'string') r = friendlyError(r, h, i);
    if (typeof r === 'string') { rec.err = r; failed.push(rec); S.doc.objects = cps[i].objects.map(o => cloneObj(o)); S.doc.nextId = cps[i].nextId; }
    // a part moved or turned among mates: settle them now, with that part held, as when it was done — solved only once
    // at the end, a linkage's loop was closed by turning the part that had been turned back (a four-bar lost its pose)
    else if (postSolve && /^(Move|Rotate)$/.test(def.label?.(rec.params) || '') && h.slice(0, i).some(q => q.op === 'F.mateOp' && !q.off)) {
      S.ed.driven = new Set(def.touch?.(rec.params)?.ids || []);
      try { postSolve(h.slice(0, i + 1)); } catch (e) { console.warn(e); } finally { S.ed.driven = null; }
    }
  }
  cps[end] = snapObjs();
  cps.length = end + 1;
  solveConstraints();
  for (const o of S.doc.objects) { const p = pres.get(o.id); if (p) for (const k of PRES) if (p[k] !== undefined) o[k] = p[k]; }
  { const live = new Set(S.doc.objects.map(o => o.id)); for (const [id, p] of pres) { if (live.has(id)) delete gone[id]; else gone[id] = p; } }
  S.doc.sketches = JSON.parse(keepSk);
  for (const [id, pl] of moved) { const k = S.doc.sketches.find(q => q.id === id); if (k) k.plane = pl; }
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
    // profiles ("sk"), and sketches used as a sweep path ("path")
    if ([...skIds].some(id => new RegExp(`"sk":${id}[,}]`).test(s) || (r.op === 'F.sweepOp' && r.params.path === id))) return i;
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
    if (future) continue;
    // a sketch hidden because a feature used it reappears while that feature is rolled back
    const users = h.map((r, j) => (r.kind !== 'sketch' && r.params && new RegExp(`"sk":${sk.id}[,}]`).test(JSON.stringify(r.params)) ? j : -1)).filter(j => j >= 0);
    const onlyFuture = users.length && users.every(j => j >= end);
    if (onlyFuture && sk.hidden && !sk._rbShown) { sk._rbShown = true; sk.hidden = false; }
    else if (!onlyFuture && sk._rbShown) { sk.hidden = true; delete sk._rbShown; }
  }
}

// A sketch drawn on a body face follows that face when earlier steps move it: find the face of the
// body (as rebuilt so far) with the same normal under the sketch's curves, and slide the plane onto it.
// a face sketch remembers where it sits on its part (in the part's own coordinates), so it moves and turns with
// the part when an earlier Move / Rotate / Mate changes the part's placement
const v3 = { add: (a, b) => a.map((x, i) => x + b[i]), sub: (a, b) => a.map((x, i) => x - b[i]), unit: a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); } };
export function anchorSketch(sk) {
  if (!sk?.face || sk.face.obj == null || sk.face.lp) return;
  const o = S.doc.objects.find(q => q.id === sk.face.obj); if (!o) return;
  const x = xfFor(o), O = x.toL(sk.plane.o), dir = d => v3.unit(v3.sub(x.toL(v3.add(sk.plane.o, d)), O));
  sk.face.lp = { o: O, u: dir(sk.plane.u), v: dir(sk.plane.v), n: dir(sk.plane.n) };
}
function followFace(skId, moved) {
  const sk = (S.doc.sketches || []).find(k => k.id === skId);
  if (!sk || !sk.face || sk.face.obj == null) return;
  const o = S.doc.objects.find(q => q.id === sk.face.obj); if (!o) return;
  if (sk.face.lp) {
    const x = xfFor(o), lp = sk.face.lp, O = x.toW(lp.o), dir = d => v3.unit(v3.sub(x.toW(v3.add(lp.o, d)), O));
    const wp = { ...sk.plane, o: O, u: dir(lp.u), v: dir(lp.v), n: dir(lp.n) };
    const cl = q => q.map(t => (Math.abs(t - Math.round(t * 1e9) / 1e9) < 1e-9 ? Math.round(t * 1e9) / 1e9 || 0 : t));
    for (const k of ['o', 'u', 'v', 'n']) wp[k] = cl(wp[k]);
    if (['o', 'u', 'v', 'n'].some(k => wp[k].some((t, i) => Math.abs(t - sk.plane[k][i]) > 1e-9))) { sk.plane = wp; moved.set(sk.id, sk.plane); }
  }
  const pl = sk.plane, n = pl.n, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const pts = [];
  for (const e of sk.ents) {
    if (e.t === 'line') pts.push(e.a, e.b); else if (e.t === 'circle' || e.t === 'arc' || e.t === 'ellipse') pts.push(e.c);
    else if (e.t === 'rect') pts.push([e.x + e.w / 2, e.y + e.h / 2]); else if (e.pts) pts.push(...e.pts);
  }
  if (!pts.length) return;
  const c2 = [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
  const w0 = dot(n, pl.o);
  const W = worldVerts(o);
  let best = null;
  for (const f of o.mesh.f) {
    if (f.length < 3) continue;
    const P = f.map(i => W[i]);
    // Newell normal
    const fn = [0, 0, 0];
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; fn[0] += (a[1] - b[1]) * (a[2] + b[2]); fn[1] += (a[2] - b[2]) * (a[0] + b[0]); fn[2] += (a[0] - b[0]) * (a[1] + b[1]); }
    const L = Math.hypot(...fn); if (L < 1e-12) continue;
    if (dot(fn, n) / L < 1 - 1e-6) continue;
    const w = dot(n, P[0]), dw = Math.abs(w - w0);
    if (best && dw >= best.dw) continue;
    // centroid of the curves inside this face (2D in the sketch's u/v)
    const Q = P.map(q => [dot(pl.u, q) - dot(pl.u, pl.o), dot(pl.v, q) - dot(pl.v, pl.o)]);
    let inside = false;
    for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) {
      if ((Q[i][1] > c2[1]) !== (Q[j][1] > c2[1]) && c2[0] < (Q[j][0] - Q[i][0]) * (c2[1] - Q[i][1]) / (Q[j][1] - Q[i][1]) + Q[i][0]) inside = !inside;
    }
    if (inside) best = { w, dw };
  }
  if (!best || best.dw < 1e-9) return;
  const d = best.w - w0;
  sk.plane = { ...pl, o: [pl.o[0] + n[0] * d, pl.o[1] + n[1] * d, pl.o[2] + n[2] * d] };
  moved.set(sk.id, sk.plane);
}

// failure messages written for the History list: what broke, and the earlier step that caused it
function friendlyError(msg, h, i) {
  let m = msg;
  if (/^Edge must|found 0|edge or face/i.test(msg)) m = 'The edge it rounded no longer exists';
  else if (/Selected face no longer exists/.test(msg)) m = 'The face it used no longer exists';
  else if (/target body|Body missing|Target missing/i.test(msg)) m = 'The body it works on no longer exists';
  else if (/Profiles? no longer exist|profile/i.test(msg)) m = 'Its sketch profile is gone — edit the sketch';
  else if (/Axis line missing/.test(msg)) m = 'Its axis line was deleted from the sketch';
  else if (/Result is empty/.test(msg)) m = 'The result would be empty';
  const cause = h.slice(0, i).reverse().find(r => r.off || r.err);
  // an earlier step may be the reason (or may not): say so without claiming it
  if (cause) m += cause.off ? ` (“${cause.label || 'an earlier step'}” is suppressed — try turning it back on)` : ` (“${cause.label || 'an earlier step'}” before it also failed — fix that first)`;
  return m;
}

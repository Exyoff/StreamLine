// Operator system: every edit is an operator with parameters that can be re-applied
// ("Adjust Last Operation", like Blender's redo panel) and undone.
import { S, emit } from './state.js';
import { snapshot, restoreSnapshot, cloneObj } from './scene.js';
import * as H from './history.js';

const MAX_UNDO = 80;
const undoStack = [], redoStack = [];
let last = null; // { def, params, base, undoSnap, committed, handle }

function edCopy() {
  return { workspace: S.ed.workspace, sketch: S.ed.sketch, drawSel: new Set(S.ed.drawSel), profiles: JSON.parse(JSON.stringify(S.ed.profiles)), edges: JSON.parse(JSON.stringify(S.ed.edges || [])), faces: JSON.parse(JSON.stringify(S.ed.faces || [])), mode: S.ed.mode, selected: new Set(S.ed.selected), active: S.ed.active, editSel: new Set(S.ed.editSel), selOrder: S.ed.selOrder.slice(), nextId: S.doc.nextId };
}
function makeBase(def, params) {
  const t = def.touch ? def.touch(params) : 'all';
  const base = { list: S.doc.objects.slice(), clones: new Map(), ed: edCopy(), shareMesh: false, sketches: JSON.stringify(S.doc.sketches) };
  if (t === 'all') { base.list = S.doc.objects.map(o => cloneObj(o)); base.all = true; }
  else {
    base.shareMesh = !t.mesh;
    for (const id of t.ids || []) { const o = S.doc.objects.find(x => x.id === id); if (o) base.clones.set(id, cloneObj(o, !t.mesh)); }
  }
  return base;
}
function restore(base) {
  if (base.all) S.doc.objects = base.list.map(o => cloneObj(o));
  else S.doc.objects = base.list.map(o => base.clones.has(o.id) ? cloneObj(base.clones.get(o.id), base.shareMesh) : o);
  S.doc.sketches = JSON.parse(base.sketches);
  const e = base.ed;
  S.ed.workspace = e.workspace; S.ed.sketch = e.sketch; S.ed.drawSel = new Set(e.drawSel); S.ed.profiles = JSON.parse(JSON.stringify(e.profiles)); S.ed.edges = JSON.parse(JSON.stringify(e.edges || [])); S.ed.faces = JSON.parse(JSON.stringify(e.faces || []));
  S.ed.mode = e.mode; S.ed.selected = new Set(e.selected); S.ed.active = e.active;
  S.ed.editSel = new Set(e.editSel); S.ed.selOrder = e.selOrder.slice(); S.doc.nextId = e.nextId;
}
function apply(op) {
  op.handle = null;
  let r;
  try { r = op.def.apply(op.params, op); } catch (err) { console.error(err); r = err.message || 'Operation failed'; }
  return r;
}

export function getLast() { return last; }
export function clearLast() { if (last) { last = null; emit('lastop', null); } }

// Run an operator. interactive=true keeps it open for live updates (gizmo drags).
export function runOp(def, params = {}, { interactive = false } = {}) {
  if (last && !last.committed) commit();
  const op = { def, params: { ...(def.defaults ? def.defaults() : {}), ...params }, undoSnap: snapshot(), committed: false, sel: H.edSnap() };
  if (def.prepare) { const p = def.prepare(op.params); if (typeof p === 'string') { emit('toast', p); return false; } }
  op.base = makeBase(def, op.params);
  restore(op.base); // operate on fresh copies so caches keyed by identity stay valid
  let r = apply(op);
  // a default size that does not fit (a fillet on a thin wall): try smaller ones before giving up
  if (typeof r === 'string' && def.shrink && params[def.shrink] == null) {
    for (let k = 0; k < 8 && typeof r === 'string'; k++) { op.params[def.shrink] /= 2; restore(op.base); r = apply(op); }
    if (typeof r !== 'string') emit('toast', `Size reduced to ${+op.params[def.shrink].toFixed(3)} so it fits — type a value to change it`);
  }
  if (typeof r === 'string') { restore(op.base); emit('toast', r); emit('change', { reason: 'op-fail' }); return false; }
  last = op;
  emit('change', { reason: 'op' });
  if (!interactive) commit();
  return true;
}
export function updateOp(params) {
  if (!last) return;
  const prev = Object.fromEntries(Object.keys(params).map(k => [k, last.params[k]]));
  Object.assign(last.params, params);
  restore(last.base);
  const r = apply(last);
  if (typeof r === 'string') { // keep the last values that worked
    Object.assign(last.params, prev); restore(last.base); apply(last); emit('toast', r);
    emit('change', { reason: 'op-update' }); if (last.committed) emit('lastop', last); return;
  }
  else if (last.committed) afterApply(last);
  emit('change', { reason: 'op-update' });
  if (last.committed) { emit('lastop', last); emit('dirty'); }
}
export function commit() {
  if (!last || last.committed) return;
  last.committed = true;
  undoStack.push(last.undoSnap); if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  afterApply(last);
  emit('history'); emit('lastop', last); emit('dirty');
}
export function cancelOp() {
  if (!last || last.committed) return;
  restore(last.base); last = null;
  emit('change', { reason: 'cancel' }); emit('lastop', null);
}

export function undo() {
  if (last && !last.committed) { cancelOp(); return; }
  if (!undoStack.length) { emit('toast', 'Nothing to undo'); return; }
  redoStack.push(snapshot());
  restoreSnapshot(undoStack.pop()); H.resetCache();
  last = null;
  emit('change', { reason: 'undo' }); emit('lastop', null); emit('history'); emit('dirty');
}
export function redo() {
  if (!redoStack.length) { emit('toast', 'Nothing to redo'); return; }
  undoStack.push(snapshot());
  restoreSnapshot(redoStack.pop()); H.resetCache();
  last = null;
  emit('change', { reason: 'redo' }); emit('lastop', null); emit('history'); emit('dirty');
}
export function canUndo() { return undoStack.length > 0 || (last && !last.committed); }
export function canRedo() { return redoStack.length > 0; }
export function resetHistory() { H.resetCache(); undoStack.length = 0; redoStack.length = 0; last = null; emit('history'); emit('lastop', null); }

// ---------- parametric history hooks ----------
const stripSk = s => JSON.stringify({ ...s, hidden: 0, _rb: 0 });
function afterApply(op) {
  const d = op.def;
  if (d.noRecord || d.presentation) return;
  if (d.sketchOnly) { sketchChanged(op); return; }
  const label = (() => { try { return d.label(op.params); } catch (e) { return 'Operation'; } })();
  if (op.rec) {
    const i = H.hist().indexOf(op.rec);
    if (op.rec.op === '_xf') Object.assign(op.rec, H.bakeXf(d.xfIds, label) || {});
    else if (op.rec.op === '_bake') Object.assign(op.rec, H.bakeAdded(op.base.list, label) || {});
    if (i >= 0) H.invalidate(i + 1);
    emit('timeline');
    return;
  }
  if (d.isEmpty && d.isEmpty(op.params)) return; // nothing built yet (e.g. an extrude still at 0)
  const name = H.recName(d);
  let rec = null;
  if (name) rec = { op: name, params: op.params, sel: op.sel };
  else if (d.factory) rec = { factory: d.factory[0], args: d.factory[1], params: op.params, sel: op.sel };
  else if (d.xfIds) rec = H.bakeXf(d.xfIds, label);
  else rec = H.bakeAdded(op.base.list, label);
  if (rec) { rec.label = label; op.rec = H.insertRecord(rec); }
}
function sketchChanged(op) {
  const before = new Map(JSON.parse(op.base.sketches).map(s => [s.id, stripSk(s)]));
  const changed = [];
  for (const sk of S.doc.sketches || []) {
    const b = before.get(sk.id);
    if (b === undefined) { if (H.sketchRecIndex(sk.id) < 0) H.insertRecord({ kind: 'sketch', sk: sk.id, label: sk.name }); }
    else if (b !== stripSk(sk)) changed.push(sk.id);
  }
  if (changed.length) {
    const i = H.firstUsing(changed);
    if (i >= 0) {
      const failed = H.regenerate(i);
      if (failed.length) emit('toast', `${failed.length} later feature${failed.length > 1 ? 's' : ''} failed to update — see the timeline`);
    }
  }
  emit('timeline');
}

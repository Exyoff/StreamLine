// Operator system: every edit is an operator with parameters that can be re-applied
// ("Adjust Last Operation", like Blender's redo panel) and undone.
import { S, emit } from './state.js';
import { serialize, deserialize, cloneObj } from './scene.js';

const MAX_UNDO = 80;
const undoStack = [], redoStack = [];
let last = null; // { def, params, base, undoSnap, committed, handle }

function edCopy() {
  return { mode: S.ed.mode, selected: new Set(S.ed.selected), active: S.ed.active, editSel: new Set(S.ed.editSel), selOrder: S.ed.selOrder.slice(), nextId: S.doc.nextId };
}
function makeBase(def, params) {
  const t = def.touch ? def.touch(params) : 'all';
  const base = { list: S.doc.objects.slice(), clones: new Map(), ed: edCopy(), shareMesh: false };
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
  const e = base.ed;
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
  const op = { def, params: { ...(def.defaults ? def.defaults() : {}), ...params }, undoSnap: JSON.stringify(serialize()), committed: false };
  if (def.prepare) { const p = def.prepare(op.params); if (typeof p === 'string') { emit('toast', p); return false; } }
  op.base = makeBase(def, op.params);
  const r = apply(op);
  if (typeof r === 'string') { restore(op.base); emit('toast', r); emit('change', { reason: 'op-fail' }); return false; }
  last = op;
  emit('change', { reason: 'op' });
  if (!interactive) commit();
  return true;
}
export function updateOp(params) {
  if (!last) return;
  Object.assign(last.params, params);
  restore(last.base);
  const r = apply(last);
  if (typeof r === 'string') { restore(last.base); emit('toast', r); }
  emit('change', { reason: 'op-update' });
  if (last.committed) { emit('lastop', last); emit('dirty'); }
}
export function commit() {
  if (!last || last.committed) return;
  last.committed = true;
  undoStack.push(last.undoSnap); if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
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
  redoStack.push(JSON.stringify(serialize()));
  deserialize(undoStack.pop());
  last = null;
  emit('change', { reason: 'undo' }); emit('lastop', null); emit('history'); emit('dirty');
}
export function redo() {
  if (!redoStack.length) { emit('toast', 'Nothing to redo'); return; }
  undoStack.push(JSON.stringify(serialize()));
  deserialize(redoStack.pop());
  last = null;
  emit('change', { reason: 'redo' }); emit('lastop', null); emit('history'); emit('dirty');
}
export function canUndo() { return undoStack.length > 0 || (last && !last.committed); }
export function canRedo() { return redoStack.length > 0; }
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; last = null; emit('history'); emit('lastop', null); }

// Timeline (parametric history strip) and Browser (layers · sketches · bodies with visibility).
import { S, emit, isShown, layerVisible } from './state.js';
import { runOp } from './ops.js';
import * as H from './history.js';
import * as SK from './sketch.js';
import { I } from './icons.js';
import { $, h, toast, popover, closePopover, menuItem } from './ui.js';

let ctx = null; // { activateSketch(id), selectObj(id), refresh() }
export function initBrowser(c) { ctx = c; }

// ---------- labels / icons ----------
function recLabel(rec) {
  if (rec.kind === 'sketch') return SK.sketchById(rec.sk)?.name || rec.label || 'Sketch';
  const def = H.defOf(rec);
  try { return (def && def.label(rec.params)) || rec.label || 'Step'; } catch (e) { return rec.label || 'Step'; }
}
function recIcon(rec) {
  if (rec.kind === 'sketch') return I.sketch;
  const k = rec.op || rec.factory || '';
  if (k === 'F.edgeBlendOp') return rec.params?.kind === 'chamfer' ? I.chamfer : I.fillet;
  if (k === 'F.bodyBoolean') return I[rec.params?.kind === 'subtract' ? 'subtract' : rec.params?.kind === 'intersect' ? 'intersect' : 'union'];
  return ({ 'F.extrude': I.extrude, 'F.revolve': I.revolve, 'F.pushPullOp': I.extrude, 'F.shellOp': I.inset, 'F.mirrorOp': I.flip, 'F.polarPattern': I.array,
    'F.sliceOp': I.subdiv, 'F.loftOp': I.cone, 'F.sweepOp': I.arc, 'O.transform': I.move, 'O.duplicate': I.dup, 'O.arrayOp': I.array, 'O.deleteObjs': I.trash,
    '_xf': I.move, '_bake': I.importI, 'O.addPrim': I.cube })[k] || I.check;
}
const when = t => { if (!t) return ''; const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const idxOf = id => H.hist().findIndex(r => r.id === id);
function failNote(failed) { if (failed.length) toast(`${failed.length} later step${failed.length > 1 ? 's' : ''} failed — shown red in the timeline`, 2800); }

// ---------- timeline actions (all undoable, none recorded) ----------
export function rollTo(k) {
  const len = H.hist().length;
  k = Math.max(0, Math.min(len, k));
  return runOp({
    label: () => (k >= len ? 'Roll to end' : 'Roll back'), noRecord: true, touch: () => 'all',
    apply() {
      const old = H.markerIndex();
      S.doc.marker = k >= len ? null : k;
      H.applyRollbackVisibility();
      failNote(H.regenerate(Math.min(old, k)));
    },
  });
}
export function editStep(id) {
  const i = idxOf(id), rec = H.hist()[i];
  if (!rec) return;
  if (rec.kind === 'sketch') { if (i >= H.markerIndex()) { toast('Roll forward past this sketch to edit it'); return; } ctx.activateSketch(rec.sk); toast('Editing the sketch — features after it update when you change it'); return; }
  const def = H.defOf(rec);
  if (!def || !def.fields) { toast('This step has no parameters to edit'); return; }
  if (i >= H.markerIndex()) { toast('Roll forward past this step to edit it'); return; }
  const orig = JSON.stringify(rec.params);
  runOp({
    label: p => `Edit · ${(() => { try { return def.label(p); } catch (e) { return 'step'; } })()}`, noRecord: true, touch: () => 'all',
    fields: p => def.fields(p),
    apply(p) {
      const j = idxOf(id), r = H.hist()[j]; if (!r) return 'Step no longer exists';
      r.params = p; H.invalidate(j + 1);
      const failed = H.regenerate(j);
      if (r.err) { const e = r.err; r.params = JSON.parse(orig); H.regenerate(j); return e; }
      failNote(failed);
    },
  }, JSON.parse(orig));
}
export function toggleStep(id) {
  runOp({
    label: () => 'Suppress / unsuppress', noRecord: true, touch: () => 'all',
    apply() { const j = idxOf(id), r = H.hist()[j]; if (!r) return 'Step missing'; r.off = !r.off; H.invalidate(j + 1); failNote(H.regenerate(j)); },
  });
}
export function deleteStep(id) {
  runOp({
    label: () => 'Delete step', noRecord: true, touch: () => 'all',
    apply() {
      const j = idxOf(id), r = H.hist()[j]; if (!r) return 'Step missing';
      H.hist().splice(j, 1);
      if (S.doc.marker != null && j < S.doc.marker) S.doc.marker--;
      if (r.kind === 'sketch') { S.doc.sketches = S.doc.sketches.filter(k => k.id !== r.sk); if (S.ed.sketch === r.sk) S.ed.sketch = null; S.ed.profiles = []; S.ed.drawSel = new Set(); }
      H.invalidate(j); failNote(H.regenerate(j));
    },
  });
}

// ---------- timeline strip ----------
export function renderTimeline() {
  const el = $('#timeline'); if (!el) return;
  const hist = H.hist(), end = H.markerIndex();
  document.body.classList.toggle('has-tl', hist.length > 0 && S.settings.timeline !== false);
  if (!hist.length || S.settings.timeline === false) { el.replaceChildren(); return; }
  const kids = [];
  hist.forEach((rec, i) => {
    if (i === end) kids.push(h('span', { class: 'tl-marker', title: 'Rollback marker' }));
    const chip = h('button', { class: 'tl-chip' + (rec.kind === 'sketch' ? ' sk' : '') + (rec.off ? ' off' : '') + (rec.err ? ' err' : '') + (i >= end ? ' future' : ''), title: `${recLabel(rec)} · ${when(rec.t)}${rec.err ? ' · ' + rec.err : ''}`, 'data-id': rec.id },
      h('span', { class: 'ic', html: recIcon(rec) }), h('span', { class: 'nm' }, recLabel(rec)));
    chip.onclick = e => { e.stopPropagation(); stepMenu(chip, rec, i); };
    kids.push(chip);
  });
  if (end >= hist.length) kids.push(h('span', { class: 'tl-marker', title: 'Rollback marker' }));
  else kids.push(h('button', { class: 'tl-chip tl-end', onclick: () => rollTo(hist.length), title: 'Roll to end' }, h('span', { class: 'ic', html: I.next }), h('span', { class: 'nm' }, 'To end')));
  const keep = el.scrollLeft, atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
  el.replaceChildren(h('span', { class: 'tl-title' }, 'History'), ...kids);
  el.scrollLeft = atEnd ? el.scrollWidth : keep;
}
function stepMenu(anchor, rec, i) {
  const end = H.markerIndex(), sketch = rec.kind === 'sketch';
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, recLabel(rec)),
    h('div', { class: 'mnote' }, `Step ${i + 1} of ${H.hist().length} · ${when(rec.t)}`),
    rec.err ? h('div', { class: 'mnote err' }, '⚠ ' + rec.err) : null,
    i < end ? menuItem(sketch ? I.sketch : I.sliders, sketch ? 'Edit sketch' : 'Edit parameters', () => editStep(rec.id)) : null,
    menuItem(I.undo, 'Roll back to before this', () => rollTo(i), 'rollback marker'),
    menuItem(I.next, 'Roll to after this', () => rollTo(i + 1)),
    !sketch ? menuItem(rec.off ? I.eye : I.eyeOff, rec.off ? 'Unsuppress' : 'Suppress', () => toggleStep(rec.id)) : null,
    h('div', { class: 'msep' }),
    menuItem(I.trash, sketch ? 'Delete sketch' : 'Delete step', () => deleteStep(rec.id)),
  ), { above: true });
}

// ---------- browser: layers, sketches, bodies ----------
function presOp(label, fn) { return runOp({ label: () => label, presentation: true, touch: () => 'all', apply: fn }); }
export function setVisible(kind, id, v) {
  presOp(v ? 'Show' : 'Hide', () => {
    const x = kind === 'sketch' ? SK.sketchById(id) : S.doc.objects.find(o => o.id === id);
    if (!x) return 'Missing';
    x.hidden = !v;
    if (kind === 'sketch' && !v) { if (S.ed.sketch === id) { S.ed.drawSel = new Set(); } S.ed.profiles = S.ed.profiles.filter(p => p.sk !== id); }
    if (kind === 'obj' && !v) { S.ed.selected.delete(id); S.ed.faces = S.ed.faces.filter(f => f.obj !== id); S.ed.edges = S.ed.edges.filter(e => e.obj !== id); }
  });
}
function setLayerOf(kind, id, layer) {
  presOp('Move to layer', () => { const x = kind === 'sketch' ? SK.sketchById(id) : S.doc.objects.find(o => o.id === id); if (x) x.layer = layer; });
}
export function addLayer() {
  const name = prompt('Layer name', `Layer ${(S.doc.layers || []).length + 1}`); if (!name) return;
  presOp('Add layer', () => { const id = Math.max(0, ...S.doc.layers.map(l => l.id)) + 1; S.doc.layers.push({ id, name, visible: true }); S.doc.layer = id; });
}
function layerMenu(anchor, l) {
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, l.name),
    menuItem(I.check, 'Make active (new work goes here)', () => presOp('Active layer', () => { S.doc.layer = l.id; if (l.visible === false) l.visible = true; })),
    menuItem(I.sliders, 'Rename…', () => { const n = prompt('Layer name', l.name); if (n) presOp('Rename layer', () => { S.doc.layers.find(x => x.id === l.id).name = n; }); }),
    menuItem(I.select, 'Select its bodies', () => { S.ed.selected = new Set(S.doc.objects.filter(o => (o.layer ?? 1) === l.id && isShown(o)).map(o => o.id)); ctx.selectionChanged(); }),
    S.doc.layers.length > 1 ? menuItem(I.trash, 'Delete layer (contents → Default)', () => presOp('Delete layer', () => {
      const to = S.doc.layers.find(x => x.id !== l.id).id;
      for (const x of [...S.doc.objects, ...S.doc.sketches]) if ((x.layer ?? 1) === l.id) x.layer = to;
      S.doc.layers = S.doc.layers.filter(x => x.id !== l.id); if (S.doc.layer === l.id) S.doc.layer = to;
    })) : null,
  ));
}
function chooseLayer(anchor, kind, id) {
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Move to layer'),
    ...S.doc.layers.map(l => menuItem(I.check, l.name, () => setLayerOf(kind, id, l.id)))));
}
const eyeBtn = (shown, fn) => { const b = h('button', { class: 'ib', 'aria-label': shown ? 'Hide' : 'Show', html: shown ? I.eye : I.eyeOff }); b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
const layerTag = (kind, x) => { const l = S.doc.layers.find(q => q.id === (x.layer ?? 1)); const b = h('button', { class: 'ltag', title: 'Layer' }, l ? l.name : '—'); b.onclick = e => { e.stopPropagation(); chooseLayer(b, kind, x.id); }; return b; };

export function browserTab(group) {
  const L = S.doc.layers || [];
  const layers = group('Layers', ...L.map(l => {
    const row = h('div', { class: 'objrow' + (S.doc.layer === l.id ? ' act' : '') },
      h('span', { class: 'lyr-dot' + (S.doc.layer === l.id ? ' on' : '') }), h('span', { class: 'nm' }, l.name),
      h('span', { class: 'meta' }, `${S.doc.objects.filter(o => (o.layer ?? 1) === l.id).length}b · ${S.doc.sketches.filter(k => (k.layer ?? 1) === l.id).length}s`),
      eyeBtn(l.visible !== false, () => presOp(l.visible !== false ? 'Hide layer' : 'Show layer', () => { const x = S.doc.layers.find(q => q.id === l.id); x.visible = x.visible === false; })));
    row.onclick = () => layerMenu(row, l);
    return row;
  }), h('button', { class: 'btn wide', onclick: addLayer }, '+ New layer'));
  const sks = S.doc.sketches || [];
  const end = H.markerIndex();
  const skG = group(`Sketches · ${sks.length}`, ...(sks.length ? sks.map(sk => {
    const future = H.sketchRecIndex(sk.id) >= end;
    const used = H.firstUsing([sk.id]) >= 0;
    const row = h('div', { class: 'objrow' + (sk.id === S.ed.sketch ? ' act' : '') + (layerVisible(sk.layer) ? '' : ' dim') + (future ? ' dim' : '') },
      h('span', { html: I.sketch }), h('span', { class: 'nm' }, sk.name), h('span', { class: 'meta' }, (future ? 'rolled back · ' : used ? 'used · ' : '') + `${sk.ents.length}`),
      layerTag('sketch', sk), eyeBtn(!sk.hidden, () => setVisible('sketch', sk.id, !!sk.hidden)));
    row.onclick = () => { if (future) { toast('This sketch is after the rollback marker'); return; } ctx.activateSketch(sk.id); };
    return row;
  }) : [h('p', { class: 'note' }, 'Draw on the grid or on a face to make a sketch.')]));
  const bodies = group(`Bodies · ${S.doc.objects.length}`, ...(S.doc.objects.length ? S.doc.objects.map(o => {
    const row = h('div', { class: 'objrow' + (S.ed.selected.has(o.id) ? ' sel' : '') + (S.ed.active === o.id ? ' act' : '') + (layerVisible(o.layer) ? '' : ' dim') },
      h('span', { class: 'sw', style: `background:${o.color}` }), h('span', { class: 'nm' }, o.name), h('span', { class: 'meta' }, `${o.mesh.f.length}f`),
      layerTag('obj', o), eyeBtn(!o.hidden, () => setVisible('obj', o.id, !!o.hidden)));
    row.onclick = () => ctx.selectObj(o.id);
    return row;
  }) : [h('p', { class: 'note' }, 'No bodies yet — tap a closed sketch region, then Extrude or Revolve.')]));
  const hist = H.hist();
  const tl = group(`Timeline · ${hist.length} step${hist.length === 1 ? '' : 's'}`, ...(hist.length ? hist.map((rec, i) => {
    const row = h('div', { class: 'objrow tlrow' + (i >= end ? ' dim' : '') + (rec.err ? ' err' : '') + (rec.off ? ' off' : '') },
      h('span', { html: recIcon(rec) }), h('span', { class: 'nm' }, `${i + 1}. ${recLabel(rec)}`), h('span', { class: 'meta' }, rec.err ? '⚠ failed' : rec.off ? 'suppressed' : when(rec.t).split(' · ')[1] || ''));
    row.onclick = () => stepMenu(row, rec, i);
    return row;
  }) : [h('p', { class: 'note' }, 'Every sketch and feature is recorded here in order. Change an early sketch and the features after it rebuild.')]));
  return [layers, skG, bodies, tl];
}

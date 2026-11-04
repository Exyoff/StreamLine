// Timeline (parametric history strip) and Browser (layers · sketches · bodies with visibility).
import { S, emit, isShown, layerVisible } from './state.js';
import { runOp } from './ops.js';
import * as H from './history.js';
import * as SK from './sketch.js';
import { I } from './icons.js';
import { $, h, toast, popover, closePopover, menuItem } from './ui.js';
import { fmtLen, fmtAng } from './units.js';

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
  if ((k === 'F.extrude' || k === 'F.revolve') && rec.params?.mode === 'cut') return I.subtract;
  if (k === 'F.edgeBlendOp') return rec.params?.kind === 'chamfer' ? I.chamfer : I.fillet;
  if (k === 'F.bodyBoolean') return I[rec.params?.kind === 'subtract' ? 'subtract' : rec.params?.kind === 'intersect' ? 'intersect' : 'union'];
  return ({ 'F.extrude': I.extrude, 'F.revolve': I.revolve, 'F.pushPullOp': I.extrude, 'F.shellOp': I.inset, 'F.mirrorOp': I.flip, 'F.polarPattern': I.array,
    'F.sliceOp': I.subdiv, 'F.loftOp': I.cone, 'F.sweepOp': I.arc, 'O.transform': I.move, 'O.duplicate': I.dup, 'O.arrayOp': I.array, 'O.deleteObjs': I.trash,
    '_xf': I.move, '_bake': I.importI, 'O.addPrim': I.cube })[k] || I.check;
}
// the key values of a step, shown in its row ("14 mm · Join", "R2 · 3 edges")
const MODE = { new: 'New body', join: 'Join', cut: 'Cut', intersect: 'Intersect' };
export function recSummary(rec) {
  const p = rec.params || {}, k = rec.op || rec.factory || '';
  try {
    if (k === 'F.extrude') return [p.symmetric ? `${fmtLen(p.distance)} symmetric` : fmtLen(p.distance), MODE[p.mode]].filter(Boolean).join(' · ');
    if (k === 'F.revolve') return [fmtAng(p.angle), MODE[p.mode]].filter(Boolean).join(' · ');
    if (k === 'F.edgeBlendOp') return `${p.kind === 'chamfer' ? '' : 'R'}${fmtLen(p.size)} · ${p.edges?.length || 0} edge${p.edges?.length === 1 ? '' : 's'}`;
    if (k === 'F.pushPullOp') return `${fmtLen(p.dist)} · ${p.faces?.length || 0} face${p.faces?.length === 1 ? '' : 's'}`;
    if (k === 'F.shellOp') return `${fmtLen(p.t)} wall`;
    if (k === 'F.polarPattern') return `${p.count} × ${fmtAng(p.angle)}`;
    if (k === 'O.arrayOp') return `${p.count} copies`;
    if (k === 'F.bodyBoolean') return `${p.ids?.length || 0} bodies`;
    if (k === 'F.mirrorOp') return p.plane === 'face' ? 'about a face' : `about ${({ x: 'YZ', y: 'XZ', z: 'XY' })[p.plane]}`;
    if (k === 'F.sliceOp') return p.plane === 'face' ? 'at a face' : `at ${'XYZ'['xyz'.indexOf(p.plane)]} ${fmtLen(p.offset)}`;
    if (k === 'O.transform') return p.mode === 'move' ? [p.x, p.y, p.z].map(v => fmtLen(v, false)).join(', ') : p.mode === 'rotate' ? `${fmtAng(p.angle)} about ${p.axis.toUpperCase()}` : `× ${[p.sx, p.sy, p.sz].map(v => +v.toFixed(3)).join(', ')}`;
    if (k === 'F.draftOp') return fmtAng(p.angle);
  } catch (e) {}
  return '';
}
// steps after this one that use it: sketches by id, features by the bodies they touch
export function dependents(id) {
  const hist = H.hist(), i = idxOf(id), rec = hist[i]; if (!rec) return [];
  if (rec.kind === 'sketch') return hist.slice(i + 1).filter(r => r.params && new RegExp(`"sk":${rec.sk}[,}]`).test(JSON.stringify(r.params)));
  return hist.slice(i + 1).filter(r => r.kind !== 'sketch');
}
const when = t => { if (!t) return ''; const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const idxOf = id => H.hist().findIndex(r => r.id === id);
let focusErr = false, lastEnd = -1;
function failNote(failed) { if (failed.length) { focusErr = true; toast(`⚠ ${failed.length} later step${failed.length > 1 ? 's' : ''} failed — see History`, 3200); } }

// ---------- timeline actions (all undoable, none recorded) ----------
export function rollTo(k) {
  ctx.closePanel?.();
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
  ctx.closePanel?.();
  const i = idxOf(id), rec = H.hist()[i];
  if (!rec) return;
  if (rec.kind === 'sketch') { if (i >= H.markerIndex()) { toast('Roll forward past this sketch to edit it'); return; } ctx.activateSketch(rec.sk); return; }
  const def = H.defOf(rec);
  if (!def || !def.fields) { toast('This step has no parameters to edit'); return; }
  if (i >= H.markerIndex()) { toast('Roll forward past this step to edit it'); return; }
  const orig = JSON.stringify(rec.params);
  runOp({
    label: p => `Edit · ${(() => { try { return def.label(p); } catch (e) { return 'step'; } })()}`, noRecord: true, touch: () => 'all', stepId: id,
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
  ctx.closePanel?.();
  runOp({
    label: () => 'Suppress / unsuppress', noRecord: true, touch: () => 'all',
    apply() { const j = idxOf(id), r = H.hist()[j]; if (!r) return 'Step missing'; r.off = !r.off; H.invalidate(j + 1); failNote(H.regenerate(j)); },
  });
}
// in-app confirmation (iOS action-sheet style)
function confirmPop(anchor, title, note, okLabel, onOk) {
  popover(anchor, h('div', { class: 'askform' }, h('div', { class: 'mtitle' }, title), note ? h('div', { class: 'mnote' }, note) : null,
    h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => closePopover() }, 'Cancel'), h('button', { class: 'btn danger', onclick: () => { closePopover(); onOk(); } }, okLabel))), { above: true });
}
export function askDeleteStep(anchor, id) {
  const rec = H.hist()[idxOf(id)]; if (!rec) return;
  const deps = dependents(id), sk = rec.kind === 'sketch';
  const note = sk ? (deps.length ? `${deps.length} feature${deps.length > 1 ? 's' : ''} built from this sketch will fail: ${deps.slice(0, 3).map(recLabel).join(', ')}${deps.length > 3 ? '…' : ''}` : 'No feature uses this sketch.')
    : (deps.length ? `${deps.length} later step${deps.length > 1 ? 's' : ''} will rebuild without it.` : 'This is the last step.');
  confirmPop(anchor, `Delete ${recLabel(rec)}?`, note + ' You can undo this.', 'Delete', () => deleteStep(id));
}
export function deleteStep(id) {
  ctx.closePanel?.();
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
  document.body.classList.toggle('has-tl', hist.length > 0 && S.settings.timeline === true);
  if (!hist.length || S.settings.timeline !== true) { el.replaceChildren(); lastEnd = -1; return; }
  const kids = [];
  hist.forEach((rec, i) => {
    if (i === end) kids.push(h('span', { class: 'tl-marker', title: 'Rollback marker' }));
    const chip = h('button', { class: 'tl-chip' + (rec.kind === 'sketch' ? ' sk' : '') + (rec.off ? ' off' : '') + (rec.err ? ' err' : '') + (i >= end ? ' future' : '') + (rec.kind === 'sketch' && rec.sk === S.ed.editingSketch ? ' cur' : ''), title: `${recLabel(rec)} · ${when(rec.t)}${rec.err ? ' · ' + rec.err : ''}`, 'data-id': rec.id },
      h('span', { class: 'ic', html: recIcon(rec) }), h('span', { class: 'nm' }, recLabel(rec)));
    chip.onclick = e => { e.stopPropagation(); el.querySelectorAll('.tl-chip.open').forEach(c => c.classList.remove('open')); chip.classList.add('open'); stepMenu(chip, rec, i); };
    kids.push(chip);
  });
  if (end >= hist.length) kids.push(h('span', { class: 'tl-marker', title: 'Rollback marker' }));
  else kids.push(h('button', { class: 'tl-chip tl-end', onclick: () => rollTo(hist.length), title: 'Roll to end' }, h('span', { class: 'ic', html: I.next }), h('span', { class: 'nm' }, 'To end')));
  let row = el.querySelector('.tl-row');
  if (!row) { row = h('div', { class: 'tl-row' }); el.replaceChildren(h('span', { class: 'tl-title' }, 'History'), row); }
  const keep = row.scrollLeft, atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
  row.replaceChildren(...kids);
  row.scrollLeft = atEnd && end >= hist.length ? row.scrollWidth : keep;
  // bring what changed into view: the first failed step, or the moved rollback marker
  const reveal = n => { if (!n) return; const a = n.offsetLeft - row.offsetLeft - 40, b = a + n.offsetWidth + 120; if (a < row.scrollLeft) row.scrollLeft = a; else if (b > row.scrollLeft + row.clientWidth) row.scrollLeft = b - row.clientWidth; };
  if (focusErr) { focusErr = false; const e = row.querySelector('.tl-chip.err'); if (e) { reveal(e); e.classList.add('pulse'); } }
  else if (end !== lastEnd) reveal(row.querySelector('.tl-marker'));
  lastEnd = end;
}
function stepMenu(anchor, rec, i) {
  const end = H.markerIndex(), sketch = rec.kind === 'sketch';
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, recLabel(rec)),
    h('div', { class: 'mnote' }, [recSummary(rec), `step ${i + 1} of ${H.hist().length}`, rec.t ? new Date(rec.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')),
    rec.err ? h('div', { class: 'mnote err' }, '⚠ ' + rec.err) : null,
    i < end ? menuItem(sketch ? I.sketch : I.sliders, sketch ? 'Edit sketch' : 'Edit parameters', () => editStep(rec.id)) : null,
    menuItem(I.undo, 'Roll back to before this', () => rollTo(i)),
    menuItem(I.next, 'Roll to after this', () => rollTo(i + 1)),
    !sketch ? menuItem(rec.off ? I.eye : I.eyeOff, rec.off ? 'Unsuppress' : 'Suppress', () => toggleStep(rec.id)) : null,
    h('div', { class: 'msep' }),
    menuItem(I.trash, sketch ? 'Delete sketch…' : 'Delete step…', () => setTimeout(() => askDeleteStep(anchor, rec.id), 0)),
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
// in-app text entry (native prompt() looks foreign and is unreliable in iOS home-screen apps)
function askText(anchor, title, value, done) {
  const inp = h('input', { class: 'textin', value, enterkeyhint: 'done', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
  const ok = () => { const v = inp.value.trim(); closePopover(); if (v) done(v); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') closePopover(); });
  popover(anchor, h('form', { class: 'askform', onsubmit: e => { e.preventDefault(); ok(); } }, h('div', { class: 'mtitle' }, title), inp,
    h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: () => closePopover() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'OK'))));
  setTimeout(() => { inp.focus(); inp.select(); }, 60);
}
export function addLayer(e) {
  askText(e?.currentTarget || $('#sheet-body'), 'New layer', `Layer ${(S.doc.layers || []).length + 1}`, name => doAddLayer(name));
}
function doAddLayer(name) {
  presOp('Add layer', () => { const id = Math.max(0, ...S.doc.layers.map(l => l.id)) + 1; S.doc.layers.push({ id, name, visible: true }); S.doc.layer = id; });
}
function layerMenu(anchor, l) {
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, l.name),
    menuItem(I.check, 'Make active (new work goes here)', () => presOp('Active layer', () => { S.doc.layer = l.id; if (l.visible === false) l.visible = true; })),
    menuItem(I.sliders, 'Rename…', () => setTimeout(() => askText(anchor, 'Rename layer', l.name, n => presOp('Rename layer', () => { S.doc.layers.find(x => x.id === l.id).name = n; })), 0)),
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
    ...S.doc.layers.map(l => { const x = kind === 'sketch' ? SK.sketchById(id) : S.doc.objects.find(o => o.id === id); return menuItem((x?.layer ?? 1) === l.id ? I.check : '', l.name, () => setLayerOf(kind, id, l.id)); })));
}
const eyeBtn = (shown, fn) => { const b = h('button', { class: 'ib', 'aria-label': shown ? 'Hide' : 'Show', html: shown ? I.eye : I.eyeOff }); b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
const layerTag = (kind, x) => { const l = S.doc.layers.find(q => q.id === (x.layer ?? 1)); const b = h('button', { class: 'ltag', title: 'Layer' }, l ? l.name : '—'); b.onclick = e => { e.stopPropagation(); chooseLayer(b, kind, x.id); }; return b; };

export function browserTab(group) {
  const L = S.doc.layers || [];
  const layers = group('Layers', ...L.map(l => {
    const row = h('div', { class: 'objrow' + (S.doc.layer === l.id ? ' cur' : '') },
      h('span', { class: 'lyr-dot' + (S.doc.layer === l.id ? ' on' : '') }), h('span', { class: 'nm' }, l.name),
      h('span', { class: 'meta' }, (() => { const b = S.doc.objects.filter(o => (o.layer ?? 1) === l.id).length, k = S.doc.sketches.filter(x => (x.layer ?? 1) === l.id).length; return `${b} bod${b === 1 ? 'y' : 'ies'} · ${k} sketch${k === 1 ? '' : 'es'}`; })()),
      eyeBtn(l.visible !== false, () => presOp(l.visible !== false ? 'Hide layer' : 'Show layer', () => {
        const x = S.doc.layers.find(q => q.id === l.id); x.visible = x.visible === false;
        // new work must not go onto a hidden layer
        if (!x.visible && S.doc.layer === x.id) { const v = S.doc.layers.find(q => q.visible !== false); if (v) { S.doc.layer = v.id; toast(`Active layer is now ${v.name}`); } }
      })));
    row.onclick = () => layerMenu(row, l);
    return row;
  }), h('button', { class: 'btn wide', onclick: addLayer }, '+ New layer'));
  const sks = S.doc.sketches || [];
  const end = H.markerIndex();
  const skG = group(`Sketches · ${sks.length}`, ...(sks.length ? sks.map(sk => {
    const future = H.sketchRecIndex(sk.id) >= end;
    const used = H.firstUsing([sk.id]) >= 0;
    const row = h('div', { class: 'objrow' + (sk.id === S.ed.sketch ? ' cur' : '') + (layerVisible(sk.layer) ? '' : ' dim') + (future ? ' dim' : '') },
      h('span', { html: I.sketch }), h('span', { class: 'nm' }, sk.name), h('span', { class: 'meta' }, future ? 'rolled back' : used ? 'in a feature' : `${sk.ents.length} curve${sk.ents.length === 1 ? '' : 's'}`),
      layerTag('sketch', sk), eyeBtn(!sk.hidden, () => setVisible('sketch', sk.id, !!sk.hidden)));
    row.onclick = () => { if (future) { toast('This sketch is after the rollback marker'); return; } ctx.activateSketch(sk.id); };
    return row;
  }) : [h('p', { class: 'note' }, 'Draw on the grid or on a face to make a sketch.')]));
  const bodies = group(`Bodies · ${S.doc.objects.length}`, ...(S.doc.objects.length ? S.doc.objects.map(o => {
    const row = h('div', { class: 'objrow' + (S.ed.selected.has(o.id) ? ' sel' : '') + (S.ed.active === o.id ? ' cur' : '') + (layerVisible(o.layer) ? '' : ' dim') },
      h('span', { class: 'sw', style: `background:${o.color}` }), h('span', { class: 'nm' }, o.name), h('span', { class: 'meta' }, `${o.mesh.f.length} faces`),
      layerTag('obj', o), eyeBtn(!o.hidden, () => setVisible('obj', o.id, !!o.hidden)));
    row.onclick = () => ctx.selectObj(o.id);
    return row;
  }) : [h('p', { class: 'note' }, 'No bodies yet — tap a closed sketch region, then Extrude or Revolve.')]));
  return [layers, skG, bodies];
}

// always-visible layer indicator (top-right of the view): active layer, hidden-layer count; opens the Layers panel
export function renderLayerPill() {
  const el = $('#layerpill'); if (!el) return;
  const L = S.doc.layers || [], act = L.find(l => l.id === S.doc.layer) || L[0];
  const hidden = L.filter(l => l.visible === false).length;
  const key = [act?.name, hidden, L.length].join('|');
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  el.replaceChildren(...[h('span', { class: 'ic', html: I.layers }), h('span', { class: 'nm' }, act ? act.name : 'Layers'), hidden ? h('span', { class: 'hid' }, `${hidden} hidden`) : null].filter(Boolean));
}

// History panel (slide-over from the right). Each feature is a card: icon, name, its key values, and the
// sketch it was built from as a chip. Tap a card to edit it; ⋯ for roll back / suppress / delete.
export function historyTab(group) {
  const hist = H.hist(), end = H.markerIndex();
  if (!hist.length) return [h('p', { class: 'note' }, 'Every sketch and feature you make is recorded here, in order. Tap a step to change it — everything after it rebuilds.')];
  // a sketch belongs to the first feature that uses it (shown as a chip on that feature)
  const owner = new Map();
  hist.forEach((r, i) => { if (r.kind !== 'sketch' || !r.sk) return; const j = hist.findIndex((q, k) => k > i && q.params && new RegExp(`"sk":${r.sk}[,}]`).test(JSON.stringify(q.params))); if (j >= 0) owner.set(i, j); });
  const ownedBy = new Map([...owner].map(([si, fi]) => [fi, [...(ownedBy0(owner, fi))]]));
  function ownedBy0(m, fi) { return [...m].filter(([, f]) => f === fi).map(([si]) => si); }
  const editing = S.ed.editingSketch, editStepId = ctx.editingStepId?.();
  const rows = [];
  hist.forEach((rec, i) => {
    if (i === end) rows.push(h('div', { class: 'hmarker' }, h('span', {}, 'Rolled back here'), h('button', { class: 'btn small', onclick: () => rollTo(hist.length) }, 'To end')));
    if (owner.has(i)) return; // shown on its feature
    const sk = rec.kind === 'sketch';
    const chips = (ownedBy.get(i) || []).map(si => { const sr = hist[si]; const c = h('button', { class: 'skchip' + (sr.sk === editing ? ' cur' : '') }, h('span', { html: I.sketch }), SK.sketchById(sr.sk)?.name || 'Sketch'); c.onclick = e => { e.stopPropagation(); editStep(sr.id); }; return c; });
    const sum = sk ? `${SK.sketchById(rec.sk)?.ents.filter(e => e.t !== 'dim').length || 0} curves · not used yet` : recSummary(rec);
    const more = h('button', { class: 'ib more', 'aria-label': 'More', html: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' });
    const card = h('div', { class: 'hcard' + (i >= end ? ' dim' : '') + (rec.err ? ' err' : '') + (rec.off ? ' off' : '') + ((sk && rec.sk === editing) || rec.id === editStepId ? ' cur' : ''), 'data-id': rec.id },
      h('span', { class: 'hic' + (sk ? ' sk' : rec.params?.mode === 'cut' ? ' cut' : ''), html: recIcon(rec) }),
      h('div', { class: 'hbody' },
        h('div', { class: 'hname' }, h('span', { class: 'hidx' }, String(i + 1)), recLabel(rec).replace(/ · \d+ edges?$/, ''), rec.off ? h('span', { class: 'hbadge' }, 'Suppressed') : null),
        sum ? h('div', { class: 'hsum' }, sum) : null,
        rec.err ? h('div', { class: 'herr' }, '⚠ ' + rec.err) : null,
        chips.length ? h('div', { class: 'hchips' }, ...chips) : null),
      more);
    card.onclick = () => (i < end ? editStep(rec.id) : stepMenu(card, rec, i));
    more.onclick = e => { e.stopPropagation(); stepMenu(more, rec, i); };
    rows.push(card);
  });
  if (end >= hist.length) rows.push(h('div', { class: 'hmarker end' }, h('span', {}, 'Now')));
  const failed = hist.filter(r => r.err).length;
  return [
    failed ? h('p', { class: 'note err' }, `⚠ ${failed} step${failed === 1 ? '' : 's'} could not be rebuilt. Tap one to fix its values, or ⋯ to suppress or delete it.`) : null,
    h('div', { class: 'hlist' }, ...rows),
    h('p', { class: 'note' }, 'Tap a step to edit it. Tap a sketch chip to edit that sketch. ⋯ rolls back, suppresses or deletes.'),
  ].filter(Boolean);
}
// badge on the History button: red when a step failed, orange while rolled back
export function renderHistoryBadge() {
  const el = document.querySelector('#btn-history'); if (!el) return;
  const hist = H.hist(), st = hist.some(r => r.err) ? 'err' : H.markerIndex() < hist.length ? 'rb' : '';
  if (el.dataset.st !== st) { el.dataset.st = st; el.classList.toggle('b-err', st === 'err'); el.classList.toggle('b-rb', st === 'rb'); }
}

// Draw workspace: 2D drafting tools on the active sketch plane + sketch/profile rendering.
import * as THREE from 'three';
import { S, emit } from './state.js';
import { view, camera } from './viewport.js';
import * as SK from './sketch.js';
const ecos = d => { const k = Math.round(d / 90); return Math.abs(d / 90 - k) < 1e-12 ? [1, 0, -1, 0][((k % 4) + 4) % 4] : Math.cos(d * Math.PI / 180); };
const esin = d => ecos(d - 90);
import * as F from './features.js';
import { runOp, updateOp, commit, cancelOp, getLast } from './ops.js';
import { fmtLen, fmtAng } from './units.js';
import { h, field, toast, openKeypad, $ } from './ui.js';
import { xfFor } from './scene.js';
import { I } from './icons.js';

const D = Math.PI / 180;
export const st = { start: null, chain: [], preview: null, snap: null, stage: 0, arc: null, dimA: null, typed: {}, press: null, grip: null };
export function resetTool() { Object.assign(st, { start: null, chain: [], preview: null, snap: null, stage: 0, arc: null, dimA: null, typed: {}, press: null, grip: null }); view.render(); emit('drawcard'); }
const sk = () => SK.activeSketch();
const tool = () => S.ed.tool;

// ---------- geometry helpers ----------
function planePt(x, y, s = sk()) {
  const r = view.ray(x, y).ray;
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...s.plane.n), new THREE.Vector3(...s.plane.o));
  const w = r.intersectPlane(pl, new THREE.Vector3());
  if (!w) { // ray parallel: project onto the plane
    const o = r.origin.toArray(); return SK.toP(s.plane, o);
  }
  return SK.toP(s.plane, w.toArray());
}
let refCache = { key: null, pts: [] };
function refPts(s) {
  if (refCache.key === S.doc.objects && refCache.sk === s.id && refCache.pl === s.plane) return refCache.pts;
  const pts = [];
  for (const o of S.doc.objects) {
    if (o.hidden) continue;
    const xf = xfFor(o);
    for (const v of o.mesh.v) {
      const w = xf.toW(v), d = [w[0] - s.plane.o[0], w[1] - s.plane.o[1], w[2] - s.plane.o[2]];
      if (Math.abs(d[0] * s.plane.n[0] + d[1] * s.plane.n[1] + d[2] * s.plane.n[2]) < 1e-6) pts.push(SK.toP(s.plane, w));
    }
  }
  refCache = { key: S.doc.objects, sk: s.id, pl: s.plane, pts };
  return pts;
}
function snapAt(x, y, from = st.start, exclude = null) {
  const s = sk(), raw = planePt(x, y);
  const wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  const r = SK.snapPoint(s, raw, { pxTol: 20, wpp, from, refPts: refPts(s), exclude });
  st.snap = r; st.preview = r.p;
  return r;
}
const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

// ---------- entity creation ----------
function add(label, ent) {
  const id = sk().id;
  let made = null;
  runOp(F.sketchOp(label, id, s => { made = F.addEntity(s, JSON.parse(JSON.stringify(ent))); }));
  return made;
}
function placeLine(a, b) {
  if (SK.d2(a, b) < 1e-9) return;
  add('Line', { t: 'line', a, b });
  if (!st.chain.length) st.chain.push(a);
  st.chain.push(b);
  // closed the loop?
  if (st.chain.length > 2 && SK.d2(b, st.chain[0]) < 1e-9) { st.start = null; st.chain = []; }
  else st.start = b;
  st.typed = {};
}
function placeRect(a, b) {
  const w = Math.abs(b[0] - a[0]), hh = Math.abs(b[1] - a[1]);
  if (w < 1e-9 || hh < 1e-9) { toast('Rectangle needs width and height'); return; }
  add('Rectangle', { t: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h: hh });
  st.start = null; st.typed = {};
}
function placeCircle(c, r) {
  if (!(r > 1e-9)) return;
  add('Circle', { t: 'circle', c, r }); st.start = null; st.typed = {};
}
function placeArc(c, r, a0, swDeg) {
  if (!(r > 1e-9) || Math.abs(swDeg) < 1e-9) return;
  let s0 = a0, sw = swDeg * D;
  if (sw < 0) { s0 = a0 + sw; sw = -sw; }
  add('Arc', { t: 'arc', c, r, a0: s0, a1: s0 + Math.min(sw, 2 * Math.PI) });
  st.start = null; st.arc = null; st.stage = 0; st.typed = {};
}

// ---------- pointer handling (called from app) ----------
export function down(x, y) {
  const s = sk(); if (!s) return false;
  const t = tool();
  if (t === 'select') return gripDown(x, y);
  if (t === 'trim' || t === 'dim') return false; // handled as taps
  st.press = { x, y, moved: false };
  snapAt(x, y);
  view.render(); emit('drawcard');
  return true;
}
export function move(x, y) {
  if (st.grip) return gripMove(x, y);
  if (!st.press) return;
  if (Math.hypot(x - st.press.x, y - st.press.y) > 6) st.press.moved = true;
  if (!st.start && !(tool() === 'arc' && st.arc) && st.press.moved && !st.pressAnchor) st.pressAnchor = st.preview; // drag-to-draw from press point
  snapAt(x, y, st.start || st.pressAnchor || (tool() === 'arc' && st.arc ? st.arc.c : null));
  view.render(); emit('drawcard');
}
export function hover(x, y) {
  if (S.ed.workspace !== 'draw' || !sk() || ['select', 'trim', 'dim'].includes(tool())) return;
  snapAt(x, y, st.start || (st.arc ? st.arc.c : null)); view.render(); emit('drawcard');
}
export function up() {
  if (st.grip) return gripUp();
  if (!st.press) return;
  const p = st.preview, t = tool(), anchor = st.pressAnchor;
  st.press = null; st.pressAnchor = null;
  if (!p) return;
  if (t === 'line') {
    if (!st.start && anchor) { st.start = anchor; placeLine(anchor, p); }
    else if (!st.start) { st.start = p; }
    else placeLine(st.start, p);
  } else if (t === 'rect') {
    if (!st.start && anchor) placeRect(anchor, p);
    else if (!st.start) st.start = p;
    else placeRect(st.start, p);
  } else if (t === 'circle') {
    if (!st.start && anchor) placeCircle(anchor, SK.d2(anchor, p));
    else if (!st.start) st.start = p;
    else placeCircle(st.start, SK.d2(st.start, p));
  } else if (t === 'arc') {
    if (!st.arc) { st.arc = { c: anchor || p }; if (anchor) { st.arc.r = SK.d2(anchor, p); st.arc.a0 = ang(anchor, p); } }
    else if (st.arc.r == null) { st.arc.r = SK.d2(st.arc.c, p); st.arc.a0 = ang(st.arc.c, p); if (st.arc.r < 1e-9) st.arc.r = null; }
    else { let sw = (ang(st.arc.c, p) - st.arc.a0) / D; sw = ((sw % 360) + 360) % 360; if (sw < 1e-9) sw = 360; placeArc(st.arc.c, st.arc.r, st.arc.a0, sw); }
  }
  view.render(); emit('drawcard');
}
export function cancelPress() { st.press = null; st.pressAnchor = null; if (st.grip) { cancelOp(); st.grip = null; } view.render(); }

// ---------- select tool: grips ----------
function gripDown(x, y) {
  const s = sk();
  for (const id of S.ed.drawSel) {
    const e = SK.entById(s, id); if (!e) continue;
    for (const kp of SK.keyPoints(e)) {
      if (!kp.m) continue;
      const q = view.project(SK.toW(s.plane, kp.p));
      if (Math.hypot(q.x - x, q.y - y) < 22) {
        const ref = { e: e.id, k: kp.k }, orig = kp.p.slice(), skId = s.id;
        const def = F.sketchOp('Move point', skId, (sk2, p) => { SK.movePoint(sk2, ref, [p.x, p.y]); }, [{ key: 'x', label: 'X', kind: 'len' }, { key: 'y', label: 'Y', kind: 'len' }]);
        if (!runOp(def, { x: orig[0], y: orig[1] }, { interactive: true })) return false;
        st.grip = { orig };
        return true;
      }
    }
  }
  return false;
}
function gripMove(x, y) {
  const r = snapAt(x, y, null, st.grip.orig);
  updateOp({ x: r.p[0], y: r.p[1] });
  view.render();
}
function gripUp() { commit(); st.grip = null; st.preview = null; st.snap = null; view.render(); emit('drawcard'); }

// ---------- taps (select / trim / dim) ----------
export function tap(x, y) {
  const s = sk(); if (!s) return;
  const t = tool();
  const raw = planePt(x, y);
  const wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  if (t === 'select') {
    // dimension labels first
    for (const L of st.dimLabels || []) if (Math.hypot(L.x - x, L.y - y) < 28) { editDim(L.dim); return; }
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (e) { if (S.ed.multi) { S.ed.drawSel.has(e.id) ? S.ed.drawSel.delete(e.id) : S.ed.drawSel.add(e.id); } else S.ed.drawSel = new Set([e.id]); }
    else if (!S.ed.multi) S.ed.drawSel = new Set();
    emit('selection');
  } else if (t === 'trim') {
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (!e) { toast('Tap the piece of a line, arc or circle to remove'); return; }
    const skId = s.id, eid = e.id;
    runOp(F.sketchOp('Trim', skId, sk2 => { const ee = SK.entById(sk2, eid); if (!ee) return 'Gone'; SK.trimAt(sk2, ee, raw); sk2.ents = sk2.ents.filter(d => d.t !== 'dim' || dimValid(sk2, d)); }));
  } else if (t === 'dim') {
    const r = SK.snapPoint(s, raw, { pxTol: 22, wpp, refPts: [] });
    if (r.ref && r.kind !== 'Mid') {
      if (!st.dimA) { st.dimA = r.ref; toast('Tap the second point'); view.render(); return; }
      if (st.dimA.e === r.ref.e && st.dimA.k === r.ref.k) return;
      const d = add('Dimension', { t: 'dim', kind: 'lin', A: st.dimA, B: r.ref });
      st.dimA = null;
      if (d) editDim(d);
      return;
    }
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (e && (e.t === 'circle' || e.t === 'arc')) { const d = add('Dimension', { t: 'dim', kind: e.t === 'circle' ? 'dia' : 'rad', e: e.id }); if (d) editDim(d); return; }
    toast('Tap end/corner/centre points, or a circle or arc');
  }
  view.render(); emit('drawcard');
}
function dimValid(s, d) { return d.kind === 'lin' ? !!(SK.refPoint(s, d.A) && SK.refPoint(s, d.B)) : !!SK.entById(s, d.e); }
function editDim(d) {
  const s = sk(), skId = s.id, did = d.id;
  const v = SK.dimValue(s, d);
  if (v == null) return;
  openKeypad({ label: d.kind === 'dia' ? 'Diameter' : d.kind === 'rad' ? 'Radius' : 'Distance', kind: 'len', value: v, min: 1e-9,
    onCommit: nv => runOp(F.sketchOp('Set dimension', skId, (sk2, p) => SK.setDimValue(sk2, SK.entById(sk2, did), p.value), [{ key: 'value', label: 'Value', kind: 'len' }]), { value: nv }) });
}

export function deleteSelected() {
  const s = sk(); if (!s || !S.ed.drawSel.size) { toast('Select sketch entities first'); return; }
  const ids = new Set(S.ed.drawSel);
  runOp(F.sketchOp('Delete', s.id, sk2 => {
    sk2.ents = sk2.ents.filter(e => !ids.has(e.id));
    sk2.ents = sk2.ents.filter(d => d.t !== 'dim' || dimValid(sk2, d));
    S.ed.drawSel = new Set();
  }));
}

// ---------- dynamic-input card ----------
const pv = () => st.preview;
export function cardContent() {
  const s = sk(); if (!s) return null;
  const t = tool();
  const title = (txt, hint) => h('div', { class: 'head' }, h('div', { class: 'title' }, txt, hint ? h('small', {}, hint) : null),
    (st.start || st.arc || st.dimA) ? h('button', { class: 'ib', 'aria-label': 'Cancel', html: I.close, onclick: () => resetTool() }) : null);
  const xyFields = (lab, cb) => h('div', { class: 'fields' },
    field({ label: lab + ' X', kind: 'len', value: pv() ? pv()[0] : 0, cls: 'ax-x', onCommit: v => cb([v, pv() ? pv()[1] : 0], 0) }),
    field({ label: lab + ' Y', kind: 'len', value: pv() ? pv()[1] : 0, cls: 'ax-y', onCommit: v => cb([st.typed.x ?? (pv() ? pv()[0] : 0), v], 1) }));
  const setStart = (p, k) => { if (k === 0) { st.typed.x = p[0]; st.preview = p; emit('drawcard'); view.render(); return; } st.start = p; st.preview = p; st.typed = {}; emit('drawcard'); view.render(); };
  if (t === 'select') {
    const ents = [...S.ed.drawSel].map(id => SK.entById(s, id)).filter(Boolean);
    if (!ents.length) return null;
    if (ents.length > 1) return h('div', {}, title(`${ents.length} entities selected`));
    return h('div', {}, title(entTitle(ents[0])), entFields(s, ents[0]));
  }
  if (t === 'trim') return title('Trim', 'tap pieces to remove');
  if (t === 'dim') return title('Dimension', st.dimA ? 'tap the second point' : 'tap two points, or a circle/arc');
  if (t === 'line') {
    if (!st.start) return h('div', {}, title('Line', 'tap or drag · or type the start'), xyFields('Start', (p, k) => setStart(p, k)));
    const L = pv() ? SK.d2(st.start, pv()) : 0, A = st.typed.ang ?? (pv() && L > 1e-9 ? ang(st.start, pv()) / D : 0);
    const placeTyped = (len, a) => placeLine(st.start, [st.start[0] + len * ecos(a), st.start[1] + len * esin(a)]);
    return h('div', {}, title('Line', st.chain.length ? `${st.chain.length - 1} segment${st.chain.length > 2 ? 's' : ''}` : 'next point'),
      h('div', { class: 'fields' },
        field({ label: 'Length', kind: 'len', value: L, min: 0, onCommit: v => { placeTyped(v, st.typed.ang ?? A); emit('drawcard'); view.render(); } }),
        field({ label: 'Angle', kind: 'ang', value: A, onCommit: v => { st.typed.ang = v; emit('drawcard'); } })),
      h('div', { class: 'btnrow' },
        st.chain.length > 2 ? h('button', { class: 'btn', onclick: () => { placeLine(st.start, st.chain[0]); emit('drawcard'); view.render(); } }, 'Close') : null,
        h('button', { class: 'btn', onclick: () => resetTool() }, 'Finish')));
  }
  if (t === 'rect') {
    if (!st.start) return h('div', {}, title('Rectangle', 'two corners · or type the first'), xyFields('Corner', (p, k) => setStart(p, k)));
    const W = st.typed.w ?? (pv() ? pv()[0] - st.start[0] : 0), H = st.typed.h ?? (pv() ? pv()[1] - st.start[1] : 0);
    const go = () => placeRect(st.start, [st.start[0] + (st.typed.w ?? W), st.start[1] + (st.typed.h ?? H)]);
    return h('div', {}, title('Rectangle', 'second corner'),
      h('div', { class: 'fields' },
        field({ label: 'Width', kind: 'len', value: W, cls: 'ax-x', onCommit: v => { st.typed.w = v; if (st.typed.h != null) go(); emit('drawcard'); view.render(); } }),
        field({ label: 'Height', kind: 'len', value: H, cls: 'ax-y', onCommit: v => { st.typed.h = v; if (st.typed.w != null) go(); emit('drawcard'); view.render(); } })),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { go(); emit('drawcard'); view.render(); } }, 'Place')));
  }
  if (t === 'circle') {
    if (!st.start) return h('div', {}, title('Circle', 'centre, then radius · or type'), xyFields('Centre', (p, k) => setStart(p, k)));
    const R = pv() ? SK.d2(st.start, pv()) : 0;
    return h('div', {}, title('Circle', 'radius point'),
      h('div', { class: 'fields' },
        field({ label: 'Radius', kind: 'len', value: R, min: 0, onCommit: v => { placeCircle(st.start, v); emit('drawcard'); view.render(); } }),
        field({ label: 'Diameter', kind: 'len', value: 2 * R, min: 0, onCommit: v => { placeCircle(st.start, v / 2); emit('drawcard'); view.render(); } })));
  }
  if (t === 'arc') {
    if (!st.arc) return h('div', {}, title('Arc', 'centre → start → end (CCW)'), xyFields('Centre', (p, k) => { if (k === 0) { st.typed.x = p[0]; st.preview = p; } else { st.arc = { c: p }; st.typed = {}; } emit('drawcard'); view.render(); }));
    const c = st.arc.c;
    if (st.arc.r == null) {
      const R = st.typed.r ?? (pv() ? SK.d2(c, pv()) : 0), A0 = st.typed.a0 ?? (pv() ? ang(c, pv()) / D : 0);
      return h('div', {}, title('Arc', 'start point'),
        h('div', { class: 'fields' },
          field({ label: 'Radius', kind: 'len', value: R, min: 0, onCommit: v => { st.typed.r = v; emit('drawcard'); } }),
          field({ label: 'Start angle', kind: 'ang', value: A0, onCommit: v => { st.typed.a0 = v; emit('drawcard'); } })),
        h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { st.arc.r = st.typed.r ?? R; st.arc.a0 = (st.typed.a0 ?? A0) * D; st.typed = {}; emit('drawcard'); view.render(); } }, 'Next')));
    }
    let SW = pv() ? (ang(c, pv()) - st.arc.a0) / D : 90; SW = ((SW % 360) + 360) % 360;
    return h('div', {}, title('Arc', `R ${fmtLen(st.arc.r)} · end point`),
      h('div', { class: 'fields' }, field({ label: 'Sweep (CCW)', kind: 'ang', value: SW, onCommit: v => { placeArc(c, st.arc.r, st.arc.a0, v); emit('drawcard'); view.render(); } })));
  }
  return null;
}
function entTitle(e) { return { line: 'Line', rect: 'Rectangle', circle: 'Circle', arc: 'Arc', dim: 'Dimension' }[e.t] || e.t; }
function entFields(s, e) {
  const skId = s.id, id = e.id;
  const edit = (label, fn) => v => runOp(F.sketchOp(label, skId, sk2 => { const ee = SK.entById(sk2, id); if (!ee) return 'Gone'; return fn(sk2, ee, v); }));
  const fs = [];
  if (e.t === 'line') {
    const L = SK.d2(e.a, e.b), A = ang(e.a, e.b) / D;
    fs.push(
      field({ label: 'Length', kind: 'len', value: L, min: 1e-9, onCommit: edit('Line length', (k, ee, v) => { const a = ang(ee.a, ee.b); SK.movePoint(k, { e: id, k: 'b' }, [ee.a[0] + v * Math.cos(a), ee.a[1] + v * Math.sin(a)]); }) }),
      field({ label: 'Angle', kind: 'ang', value: A, onCommit: edit('Line angle', (k, ee, v) => { const l = SK.d2(ee.a, ee.b); SK.movePoint(k, { e: id, k: 'b' }, [ee.a[0] + l * ecos(v), ee.a[1] + l * esin(v)]); }) }),
      field({ label: 'Start X', kind: 'len', value: e.a[0], cls: 'ax-x', onCommit: edit('Line start', (k, ee, v) => SK.movePoint(k, { e: id, k: 'a' }, [v, ee.a[1]])) }),
      field({ label: 'Start Y', kind: 'len', value: e.a[1], cls: 'ax-y', onCommit: edit('Line start', (k, ee, v) => SK.movePoint(k, { e: id, k: 'a' }, [ee.a[0], v])) }),
      field({ label: 'End X', kind: 'len', value: e.b[0], cls: 'ax-x', onCommit: edit('Line end', (k, ee, v) => SK.movePoint(k, { e: id, k: 'b' }, [v, ee.b[1]])) }),
      field({ label: 'End Y', kind: 'len', value: e.b[1], cls: 'ax-y', onCommit: edit('Line end', (k, ee, v) => SK.movePoint(k, { e: id, k: 'b' }, [ee.b[0], v])) }));
  } else if (e.t === 'rect') {
    fs.push(
      field({ label: 'X', kind: 'len', value: e.x, cls: 'ax-x', onCommit: edit('Rect X', (k, ee, v) => { ee.x = v; }) }),
      field({ label: 'Y', kind: 'len', value: e.y, cls: 'ax-y', onCommit: edit('Rect Y', (k, ee, v) => { ee.y = v; }) }),
      field({ label: 'Width', kind: 'len', value: e.w, min: 1e-9, onCommit: edit('Rect width', (k, ee, v) => { ee.w = v; }) }),
      field({ label: 'Height', kind: 'len', value: e.h, min: 1e-9, onCommit: edit('Rect height', (k, ee, v) => { ee.h = v; }) }));
  } else if (e.t === 'circle' || e.t === 'arc') {
    fs.push(
      field({ label: 'Centre X', kind: 'len', value: e.c[0], cls: 'ax-x', onCommit: edit('Centre', (k, ee, v) => { ee.c = [v, ee.c[1]]; }) }),
      field({ label: 'Centre Y', kind: 'len', value: e.c[1], cls: 'ax-y', onCommit: edit('Centre', (k, ee, v) => { ee.c = [ee.c[0], v]; }) }),
      field({ label: 'Radius', kind: 'len', value: e.r, min: 1e-9, onCommit: edit('Radius', (k, ee, v) => { ee.r = v; }) }),
      field({ label: 'Diameter', kind: 'len', value: 2 * e.r, min: 1e-9, onCommit: edit('Diameter', (k, ee, v) => { ee.r = v / 2; }) }));
    if (e.t === 'arc') fs.push(
      field({ label: 'Start°', kind: 'ang', value: e.a0 / D, onCommit: edit('Arc start', (k, ee, v) => { const sw = SK.sweep(ee); ee.a0 = v * D; ee.a1 = ee.a0 + sw; }) }),
      field({ label: 'Sweep°', kind: 'ang', value: SK.sweep(e) / D, min: 0.001, max: 360, onCommit: edit('Arc sweep', (k, ee, v) => { ee.a1 = ee.a0 + v * D; }) }));
  }
  return h('div', { class: 'fields' }, fs);
}

// ---------- rendering ----------
let sketchGroup, previewGroup, renderKey = '';
const C = { line: new THREE.Color('#e9ecf2'), dim: new THREE.Color('#9aa3b3'), sel: new THREE.Color('#ff9a1f'), other: new THREE.Color('#8d93a0'), prev: new THREE.Color('#4fd1ff') };
const matL = (col, top, op = 1) => new THREE.LineBasicMaterial({ color: col, depthTest: !top, transparent: true, opacity: op });
export function initDraw() {
  sketchGroup = new THREE.Group(); view.scene.add(sketchGroup);
  previewGroup = new THREE.Group(); view.overlayScene.add(previewGroup);
  view.renderHooks.push(renderSketches);
}
function lineObj(pts3, mat, closed) {
  const g = new THREE.BufferGeometry().setFromPoints(pts3.map(p => new THREE.Vector3(...p)));
  return closed ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
}
function fillObj(s, r, color, opacity) {
  const shape = new THREE.Shape(r.outer.map(p => new THREE.Vector2(p[0], p[1])));
  r.holes.forEach(hh => shape.holes.push(new THREE.Path(hh.map(p => new THREE.Vector2(p[0], p[1])))));
  const g = new THREE.ShapeGeometry(shape);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) { const w = SK.toW(s.plane, [pos.getX(i), pos.getY(i)]); pos.setXYZ(i, w[0] + s.plane.n[0] * 0.002, w[1] + s.plane.n[1] * 0.002, w[2] + s.plane.n[2] * 0.002); }
  g.computeBoundingSphere();
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
}
function dimGeom(s, d) {
  if (d.kind === 'lin') {
    const A = SK.refPoint(s, d.A), B = SK.refPoint(s, d.B); if (!A || !B) return null;
    return { pts: [A, B], mid: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], text: fmtLen(SK.d2(A, B)) };
  }
  const e = SK.entById(s, d.e); if (!e) return null;
  const a = e.t === 'arc' ? e.a0 + SK.sweep(e) / 2 : Math.PI / 4;
  const P = [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
  const Q = d.kind === 'dia' ? [e.c[0] - e.r * Math.cos(a), e.c[1] - e.r * Math.sin(a)] : e.c;
  return { pts: [Q, P], mid: d.kind === 'dia' ? [(P[0] + e.c[0]) / 2, (P[1] + e.c[1]) / 2] : [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2], text: (d.kind === 'dia' ? 'Ø ' : 'R ') + fmtLen(d.kind === 'dia' ? 2 * e.r : e.r) };
}

function renderSketches() {
  const ws = S.ed.workspace, act = SK.activeSketch();
  const key = [ws, S.ed.sketch, (S.doc.sketches || []).map(s => s.hidden).join(), [...S.ed.drawSel].join(), JSON.stringify(S.ed.profiles), S.settings.showSketches].join('|');
  const sketches = S.doc.sketches || [];
  const entsArr = sketches.map(s => s.ents), prevEnts = sketchGroup.userData.ents || [];
  const changed = key !== renderKey || entsArr.length !== prevEnts.length || entsArr.some((e, i) => e !== prevEnts[i]);
  {
    if (changed) {
      renderKey = key; sketchGroup.userData.ents = entsArr;
      clearGroup(sketchGroup);
      for (const s of sketches) {
        if (s.hidden) continue;
        const isAct = ws === 'draw' && s.id === S.ed.sketch;
        if (ws === 'model' && S.settings.showSketches === false) continue;
        const top = isAct;
        for (const e of s.ents) {
          if (e.t === 'dim') continue;
          const pl = SK.entPolyline(e);
          const col = isAct ? (S.ed.drawSel.has(e.id) ? C.sel : C.line) : C.other;
          sketchGroup.add(lineObj(pl.pts.map(p => SK.toW(s.plane, p)), matL(col, top, ws === 'model' ? 0.5 : 1), pl.closed));
        }
        if (isAct) {
          // endpoints
          const pts = [];
          for (const e of s.ents) for (const kp of SK.keyPoints(e)) if (kp.m || kp.center) pts.push(...SK.toW(s.plane, kp.p));
          const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const pm = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffffff, size: 3 * Math.min(devicePixelRatio, 2.5), sizeAttenuation: false, depthTest: false }));
          pm.renderOrder = 5; sketchGroup.add(pm);
          // dims
          for (const d of s.ents) if (d.t === 'dim') { const g = dimGeom(s, d); if (g) sketchGroup.add(lineObj(g.pts.map(p => SK.toW(s.plane, p)), matL(0x4f8ff7, true, 0.9))); }
        }
        if (ws === 'draw' && isAct || ws === 'cad') {
          const selRegs = new Set(S.ed.profiles.filter(q => q.sk === s.id).map(q => SK.regionAt(s, q.pt)).filter(Boolean));
          for (const r of SK.regions(s)) sketchGroup.add(fillObj(s, r, selRegs.has(r) ? 0xff9a1f : 0x4f8ff7, selRegs.has(r) ? 0.55 : ws === 'cad' ? 0.16 : 0.08));
        }
      }
    }
  }
  // per-frame labels for dims + preview
  st.dimLabels = [];
  if (ws === 'draw' && act) {
    for (const d of act.ents) if (d.t === 'dim') {
      const g = dimGeom(act, d); if (!g) continue;
      const w = SK.toW(act.plane, g.mid); view.label(w, g.text, 'dim');
      const q = view.project(w); st.dimLabels.push({ dim: d, x: q.x, y: q.y - 14 });
    }
    drawAxes(act);
  } else clearGroup(previewGroup);
  drawPreview(act);
}
function clearGroup(g) { g.traverse(o => { if (o !== g) { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); } }); g.clear(); }
function drawAxes(s) {
  const L = view.worldPerPixel(s.plane.o) * 60;
  clearGroup(previewGroup);
  previewGroup.add(lineObj([SK.toW(s.plane, [0, 0]), SK.toW(s.plane, [L, 0])], matL(0xf2545b, true, 0.9)));
  previewGroup.add(lineObj([SK.toW(s.plane, [0, 0]), SK.toW(s.plane, [0, L])], matL(0x7cc243, true, 0.9)));
}
function drawPreview(s) {
  if (S.ed.workspace !== 'draw' || !s) return;
  const t = tool(), p = st.preview, W = q => SK.toW(s.plane, q);
  const m = matL(C.prev, true);
  const from = st.start || st.pressAnchor;
  if (p && from && t === 'line') { previewGroup.add(lineObj([W(from), W(p)], m)); const L = SK.d2(from, p); if (L > 1e-9) view.label(W([(from[0] + p[0]) / 2, (from[1] + p[1]) / 2]), `${fmtLen(L)} ∠ ${fmtAng(((ang(from, p) / D) + 360) % 360)}`, 'readout'); }
  if (p && from && t === 'rect') { previewGroup.add(lineObj([from, [p[0], from[1]], p, [from[0], p[1]]].map(W), m, true)); view.label(W(p), `${fmtLen(Math.abs(p[0] - from[0]), false)} × ${fmtLen(Math.abs(p[1] - from[1]))}`, 'readout'); }
  if (p && from && t === 'circle') { const r = SK.d2(from, p); const pl = SK.entPolyline({ t: 'circle', c: from, r }); previewGroup.add(lineObj(pl.pts.map(W), m, true), lineObj([W(from), W(p)], matL(C.prev, true, 0.5))); view.label(W(p), `R ${fmtLen(r)}`, 'readout'); }
  if (t === 'arc' && (st.arc || st.pressAnchor) && p) {
    const c = st.arc ? st.arc.c : st.pressAnchor;
    if (!st.arc || st.arc.r == null) { previewGroup.add(lineObj([W(c), W(p)], m)); view.label(W(p), `R ${fmtLen(SK.d2(c, p))}`, 'readout'); }
    else { let sw = ang(c, p) - st.arc.a0; sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI; const pl = SK.entPolyline({ t: 'arc', c, r: st.arc.r, a0: st.arc.a0, a1: st.arc.a0 + sw }); previewGroup.add(lineObj(pl.pts.map(W), m)); view.label(W(p), fmtAng(sw / D), 'readout'); }
  }
  if (st.dimA) { const q = SK.refPoint(s, st.dimA); if (q) previewGroup.add(marker(W(q), 0x4f8ff7)); }
  if (p && st.snap && !['select', 'trim', 'dim'].includes(t)) {
    previewGroup.add(marker(W(p), st.snap.kind && st.snap.kind !== 'Grid' ? 0xffe066 : 0x4fd1ff));
    if (st.snap.kind && !from) view.label(W(p), st.snap.kind, '');
  }
  if (st.grip && p) previewGroup.add(marker(W(p), 0xffe066));
}
function marker(w, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 20), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
  m.position.set(...w); m.quaternion.copy(camera().quaternion); m.scale.setScalar(view.worldPerPixel(w) * 9); m.renderOrder = 20;
  return m;
}

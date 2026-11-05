// Transform gizmo + operator drag handles, hit-tested in screen space with touch-sized tolerances.
import * as THREE from 'three';
import { S, emit } from './state.js';
import { view, camera } from './viewport.js';
import { runOp, updateOp, commit, cancelOp, getLast } from './ops.js';
import * as OPS from './operators.js';
import { fmtLen, fmtAng, fmtNum } from './units.js';
import * as M from './mesh.js';
import { xfFor } from './scene.js';
import * as Draw from './draw.js';
import * as F from './features.js';
import * as SK from './sketch.js';
import { openKeypad, keypadKey, keypadOpen } from './ui.js';

const AX = [
  { k: 'x', v: [1, 0, 0], col: '#f2545b' },
  { k: 'y', v: [0, 1, 0], col: '#7cc243' },
  { k: 'z', v: [0, 0, 1], col: '#4f8ff7' },
];
const PX = 84;      // gizmo length in CSS px
const ARC_R = 0.74; // the body gizmo's rotation arcs (its plane squares sit nearer the middle, clear of them)
const HIT = 24;     // touch tolerance in px
const HILITE = new THREE.Color('#ffe066');

let root, key = '', parts = [], drag = null, snapMarker = null, readout = null, valueBubble = null;

const mat = (col, op = 1) => new THREE.MeshBasicMaterial({ color: col, depthTest: false, depthWrite: false, transparent: true, opacity: op, side: THREE.DoubleSide });
const UPY = new THREE.Vector3(0, 1, 0);

export function initGizmo() {
  root = new THREE.Group(); root.renderOrder = 10; view.overlayScene.add(root);
  snapMarker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 24), mat('#ffe066'));
  snapMarker.visible = false; view.overlayScene.add(snapMarker);
  view.renderHooks.push(update);
  view.handlers.dragStart = dragStart;
  view.handlers.dragMove = dragMove;
  view.handlers.dragEnd = dragEnd;
  view.handlers.dragCancel = dragCancel;
}

// what the gizmo is: an operation's drag handle; the Move / Rotate / Scale tool's gizmo; or — Plasticity-style,
// with the Select tool — a gizmo for what is picked: a body gets move arrows, plane squares and rotation arcs
// ('combo'), a flat face a push / pull arrow ('pp'), a sketch profile an extrude arrow ('ext'), edges a fillet ball ('fil')
function kind() {
  const last = getLast();
  if (last && last.handle) return 'handle';
  if (S.ed.workspace !== 'model' || S.ed.mode !== 'object' && !['move', 'rotate', 'scale'].includes(S.ed.tool)) return null;
  if (['move', 'rotate', 'scale'].includes(S.ed.tool)) {
    if (S.ed.mode === 'object' && S.ed.pick && S.ed.pick !== 'solid' && !OPS.subSelection()) return null;
    return !Draw.curveCmd?.() && OPS.computePivot() ? S.ed.tool : null;
  }
  if (S.ed.tool !== 'select' || S.ed.consTool || S.ed.pickLock || S.ed.mateFrom || S.ed.editingSketch != null || (last && !last.committed)) return null;
  if (S.ed.profiles.length && !S.ed.faces.length) return 'ext';
  if (S.ed.drawSel.size) return null;
  if (S.ed.pick === 'face' && S.ed.faces.length === 1 && S.ed.faces[0].planar !== false && !S.ed.faces.some(f => objLinked(f.obj))) return 'pp';
  if (S.ed.pick === 'edge' && S.ed.edges.length && S.ed.edges.every(e => e.pts || e.circle) && !S.ed.edges.some(e => objLinked(e.obj))) return 'fil';
  if (S.ed.pick === 'solid' && S.ed.selected.size && OPS.computePivot()) return 'combo';
  return null;
}
const objLinked = id => !!S.doc.objects.find(o => o.id === id)?.link;
// where a selection gizmo sits and points
function preHandle(k) {
  if (k === 'pp') { const f = S.ed.faces[0]; return { p: f.p, dir: M.norm(f.n) }; }
  if (k === 'ext') { const it = S.ed.profiles[0], sk = SK.sketchById(it.sk); if (!sk) return null; return { p: SK.toW(sk.plane, it.pt), dir: sk.plane.n }; }
  if (k === 'fil') { // a third of the way along the edge (its length label sits at the middle)
    const e = S.ed.edges[0], P = e.pts || (e.circle ? e.circle.loop : [e.a, e.b]);
    if (P.length === 2) return { p: M.add(P[0], M.mul(M.sub(P[1], P[0]), 0.3)), dir: null };
    return { p: P[Math.floor((P.length - 1) * 0.3)], dir: null };
  }
  return null;
}

function rebuild(k) {
  root.clear(); parts = [];
  if (!k) return;
  if (k === 'pp' || k === 'ext') {
    const col = k === 'pp' ? '#3d8bfd' : '#ff9b3d', g = new THREE.Group(), m = mat(col);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 8), m); shaft.position.y = 0.375;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 16), m); head.position.y = 0.86;
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), m);
    g.add(shaft, head, base); root.add(g);
    parts.push({ id: k, obj: g, mats: [m], col: new THREE.Color(col), pre: true });
    return;
  }
  if (k === 'fil') {
    const col = '#ffb23f', m = mat(col), mr = mat('#ffffff', 0.9);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), m);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.22, 32), mr);
    const g = new THREE.Group(); g.add(ball, ring); root.add(g);
    parts.push({ id: 'fil', obj: g, mats: [m], col: new THREE.Color(col), pre: true, billboard: true });
    return;
  }
  if (k === 'handle') {
    const g = new THREE.Group();
    const m = mat('#ffb23f');
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 8), m); shaft.position.y = 0.375;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 16), m); head.position.y = 0.85;
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), m);
    g.add(shaft, head, base); root.add(g);
    parts.push({ id: 'handle', obj: g, mats: [m], col: new THREE.Color('#ffb23f') });
    return;
  }
  for (const a of AX) {
    const m = mat(a.col);
    const g = new THREE.Group();
    g.quaternion.setFromUnitVectors(UPY, new THREE.Vector3(...a.v));
    if (k === 'rotate') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.022, 6, 72), m);
      ring.rotation.x = Math.PI / 2; g.add(ring);
    } else {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.8, 8), m); shaft.position.y = 0.4 + 0.1;
      const head = k === 'move' || k === 'combo' ? new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 16), m) : new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), m);
      head.position.y = 1.0;
      g.add(shaft, head);
    }
    root.add(g);
    parts.push({ id: 'axis-' + a.k, axis: a, obj: g, mats: [m], col: new THREE.Color(a.col) });
  }
  if (k === 'combo') { // rotation arcs between the arrows, one about each axis
    for (const [a, b, c] of [['x', 'y', 'z'], ['y', 'z', 'x'], ['z', 'x', 'y']]) {
      const A = AX.find(q => q.k === a), m = mat(A.col, 0.9);
      const arc = new THREE.Mesh(new THREE.TorusGeometry(ARC_R, 0.02, 6, 24, Math.PI / 2), m);
      const vb = new THREE.Vector3(...AX.find(q => q.k === b).v), vc = new THREE.Vector3(...AX.find(q => q.k === c).v), va = new THREE.Vector3(...A.v);
      arc.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(vb, vc, va));
      root.add(arc);
      parts.push({ id: 'arc-' + a, arc: true, axis: A, b: AX.find(q => q.k === b).v, c: AX.find(q => q.k === c).v, obj: arc, mats: [m], col: new THREE.Color(A.col) });
    }
  }
  if (k === 'move' || k === 'combo') {
    [['x', 'y', 'z'], ['x', 'z', 'y'], ['y', 'z', 'x']].forEach(([i, j, n]) => {
      const A = AX.find(a => a.k === n);
      const m = mat(A.col, 0.55);
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), m);
      const vi = new THREE.Vector3(...AX.find(a => a.k === i).v), vj = new THREE.Vector3(...AX.find(a => a.k === j).v);
      const at = k === 'combo' ? 0.22 : 0.33;
      sq.position.copy(vi.clone().add(vj).multiplyScalar(at));
      sq.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...A.v));
      root.add(sq);
      parts.push({ id: 'plane-' + n, normal: A.v, u: AX.find(a => a.k === i).v, w: AX.find(a => a.k === j).v, at, obj: sq, mats: [m], col: new THREE.Color(A.col) });
    });
  }
  if (k === 'move' || k === 'scale' || k === 'combo') {
    const m = mat('#ffffff', 0.85);
    const c = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.15, 32), m);
    root.add(c); parts.push({ id: 'center', obj: c, mats: [m], col: new THREE.Color('#ffffff'), billboard: true });
  }
}

function pivotAndScale() {
  const k = kind();
  if (k === 'handle') {
    const h = getLast().handle, v = getLast().params[h.key];
    const p = M.add(h.origin, M.mul(h.dir, v));
    return { p, s: view.worldPerPixel(p) * PX * 0.9 };
  }
  if (k === 'pp' || k === 'ext' || k === 'fil') { const h = preHandle(k); return h ? { p: h.p, s: view.worldPerPixel(h.p) * PX * (k === 'fil' ? 0.55 : 0.8), dir: h.dir } : null; }
  const p = OPS.computePivot();
  return p ? { p, s: view.worldPerPixel(p) * PX } : null;
}

function update() {
  if (!drag) valueBubble = null; // (kept while a press on it is still deciding between a tap and a drag)
  const k = kind();
  const kk = k + '|' + (k === 'handle' ? getLast().def.label(getLast().params) : '');
  if (kk !== key) { key = kk; rebuild(k); }
  readout && view.label(readout.world, readout.text, 'readout');
  if (!k) { root.visible = false; return; }
  const ps = pivotAndScale();
  if (!ps) { root.visible = false; return; }
  root.visible = true;
  root.position.set(...ps.p); root.scale.setScalar(ps.s);
  const vd = view.viewDir();
  if (k === 'handle' && !drag) {
    // Plasticity's number typing: the value sits at the handle; tap it (or just type) to enter an exact one
    const last = getLast(), h = last.handle, v = last.params[h.key], tip = M.add(h.origin, M.mul(h.dir, v));
    // beside the arrow's head (not beyond it, where it could run under the top bar), kept in the free part of the view
    const a = view.project(tip), b = view.project(M.add(tip, M.mul(h.dir, ps.s * 0.9)));
    if (a.front && b.front) {
      let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const side = dy > 0 ? -1 : 1, ins = view.insets?.() || { t: 0, b: 0, l: 0, r: 0 }, sz = view.size();
      const x = Math.max(ins.l + 50, Math.min(sz.w - ins.r - 50, b.x + side * -dy * 46)), y = Math.max(ins.t + 24, Math.min(sz.h - ins.b - 24, b.y + side * dx * 46));
      const text = `${h.key === 'size' ? (last.params.kind === 'chamfer' ? '◢ ' : 'R ') : ''}${fmtLen(v)}`;
      view.labelAt(x, y, text, 'readout val'); valueBubble = { x, y, key: h.key };
    }
  }
  for (const part of parts) {
    if (part.billboard) part.obj.quaternion.copy(camera().quaternion);
    if (k === 'handle') part.obj.quaternion.setFromUnitVectors(UPY, new THREE.Vector3(...getLast().handle.dir));
    if ((k === 'pp' || k === 'ext') && ps.dir) part.obj.quaternion.setFromUnitVectors(UPY, new THREE.Vector3(...ps.dir));
    if (part.arc) part.obj.visible = Math.abs(M.dot(part.axis.v, vd)) > 0.15;
    const active = drag && drag.part === part;
    part.mats.forEach(m => m.color.copy(active ? HILITE : part.col));
    if (part.axis && !part.arc && k !== 'rotate') part.obj.visible = Math.abs(M.dot(part.axis.v, vd)) < 0.985;
    if (part.normal) part.obj.visible = Math.abs(M.dot(part.normal, vd)) > 0.2;
  }
}

// ---------- hit testing ----------
function segDist(x, y, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(A.x + dx * tc - x, A.y + dy * tc - y), t };
}
function hitTest(x, y) {
  const k = kind(); if (!k) return null;
  const ps = pivotAndScale(); if (!ps) return null;
  const P = ps.p, s = ps.s, C = view.project(P);
  let best = null;
  const consider = (part, d) => { if (d <= HIT && (!best || d < best.d)) best = { part, d }; };
  for (const part of parts) {
    if (!part.obj.visible) continue;
    if (part.id === 'center') { const d = Math.hypot(C.x - x, C.y - y); if (d < 18) return part; continue; } // (return the part itself, like every other hit)
    if (part.id === 'handle') {
      const dir = getLast().handle.dir;
      const r = segDist(x, y, C, view.project(M.add(P, M.mul(dir, s))));
      consider(part, r.d * 0.8); continue;
    }
    if (part.id === 'pp' || part.id === 'ext') {
      const r = segDist(x, y, view.project(M.add(P, M.mul(ps.dir, s * 0.25))), view.project(M.add(P, M.mul(ps.dir, s))));
      consider(part, r.d * 0.85); continue;
    }
    if (part.id === 'fil') { consider(part, Math.max(0, Math.hypot(C.x - x, C.y - y) - 10)); continue; }
    if (part.arc) {
      let prev = null, dmin = Infinity;
      for (let i = 0; i <= 16; i++) { const t = i / 16 * Math.PI / 2, q = view.project(M.add(P, M.add(M.mul(part.b, Math.cos(t) * s * ARC_R), M.mul(part.c, Math.sin(t) * s * ARC_R)))); if (prev) dmin = Math.min(dmin, segDist(x, y, prev, q).d); prev = q; }
      consider(part, dmin); continue;
    }
    if (part.axis && k === 'rotate' && !part.arc) {
      const v = part.axis.v, u = Math.abs(v[2]) < 0.9 ? M.norm(M.cross(v, [0, 0, 1])) : [1, 0, 0], w = M.cross(v, u);
      let prev = null, dmin = Infinity;
      for (let i = 0; i <= 64; i++) {
        const a = i / 64 * Math.PI * 2;
        const q = view.project(M.add(P, M.add(M.mul(u, Math.cos(a) * s), M.mul(w, Math.sin(a) * s))));
        if (prev) dmin = Math.min(dmin, segDist(x, y, prev, q).d);
        prev = q;
      }
      consider(part, dmin); continue;
    }
    if (part.axis) {
      const r = segDist(x, y, view.project(M.add(P, M.mul(part.axis.v, s * 0.15))), view.project(M.add(P, M.mul(part.axis.v, s * 1.12))));
      consider(part, r.d); continue;
    }
    if (part.normal) {
      const c = view.project(M.add(P, M.mul(M.add(part.u, part.w), s * (part.at || 0.33))));
      consider(part, Math.max(0, Math.hypot(c.x - x, c.y - y) - (k === 'combo' ? 4 : 8)));
    }
  }
  return best ? best.part : null;
}

// ---------- geometry helpers ----------
function axisParam(x, y, P, A) {
  const r = view.ray(x, y).ray;
  const D = r.direction.toArray(), O = r.origin.toArray();
  const w = M.sub(P, O), b = M.dot(A, D), d = M.dot(A, w), e = M.dot(D, w);
  const den = 1 - b * b;
  if (den < 1e-6) return null;
  return (b * e - d) / den;
}
function planePoint(x, y, P, N) {
  const r = view.ray(x, y).ray;
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...N), new THREE.Vector3(...P));
  const out = r.intersectPlane(pl, new THREE.Vector3());
  return out ? out.toArray() : null;
}
const snapOn = () => S.settings.snap;
const stepSnap = (v, st) => Math.round(v / st) * st;
function snapLenDelta(d, k, base) {
  if (!snapOn()) return d;
  const st = S.settings.snapStep;
  if (S.settings.snapAbs && base != null) return stepSnap(base[k] + d, st) - base[k];
  return stepSnap(d, st);
}
function vertexTarget(x, y) {
  if (!S.settings.vertexSnap) return null;
  const editing = S.ed.mode === 'edit';
  const hit = view.pickVertex(x, y, {
    tol: 34,
    exclude: (o, i) => (editing ? o.id === S.ed.active && S.ed.editSel.has(i) : S.ed.selected.has(o.id)),
  });
  return hit ? hit.world : null;
}

// ---------- drag ----------
function dragStart(x, y) {
  const part = hitTest(x, y);
  if (!part) return false;
  const k = kind();
  if (k === 'pp' || k === 'ext' || k === 'fil') {
    // Plasticity: drag what you picked — the face pushes / pulls, the profile extrudes, the edge rounds
    const ok = k === 'pp' ? runOp(F.pushPullOp, {}, { interactive: true }) : k === 'ext' ? runOp(F.extrude, {}, { interactive: true })
      : runOp(F.edgeBlendOp, { kind: 'fillet', size: Math.max(1e-3, S.settings.snapStep / 10) }, { interactive: true });
    if (!ok || !getLast()?.handle) { if (ok) cancelOp(); return false; }
    return handleDrag(x, y, part, true);
  }
  if (k === 'handle') return handleDrag(x, y, part, false);
  return transformDrag(x, y, part, k);
}
function handleDrag(x, y, part, created) {
  {
    const last = getLast(), h = last.handle, k = 'handle';
    drag = { part, k, created, v0: last.params[h.key], t0: axisParam(x, y, M.add(h.origin, M.mul(h.dir, last.params[h.key])), h.dir) ?? 0, h, x0: x, y0: y };
    // screen-space gain: how many pixels one mm along the arrow moves on screen (stable at any view angle)
    const O = M.add(h.origin, M.mul(h.dir, drag.v0)), A = view.project(O), B = view.project(M.add(O, h.dir));
    const sx = B.x - A.x, sy = B.y - A.y, ppm = Math.hypot(sx, sy);
    if (A.front && B.front && ppm * view.worldPerPixel(O) > 0.2) { drag.sdir = [sx / ppm, sy / ppm]; drag.ppm = ppm; }
    view.render(); return true;
  }
}
function transformDrag(x, y, part, k) {
  // (the combined gizmo: its arcs turn, everything else moves)
  const mode = k === 'combo' ? (part.arc ? 'rotate' : 'move') : k;
  if (!runOp(OPS.transform, { mode }, { interactive: true })) return false;
  const pivot = getLast().params.pivot;
  drag = { part, k: mode, pivot, x0: x, y0: y };
  const C = view.project(pivot);
  if (part.axis && mode === 'move') drag.t0 = axisParam(x, y, pivot, part.axis.v);
  if (part.normal) drag.p0 = planePoint(x, y, pivot, part.normal);
  if (part.id === 'center' && mode === 'move') { drag.n = view.viewDir(); drag.p0 = planePoint(x, y, pivot, drag.n); }
  if (mode === 'rotate') { drag.a0 = Math.atan2(-(y - C.y), x - C.x); drag.acc = 0; drag.prev = drag.a0; }
  if (mode === 'scale') {
    drag.C = C;
    if (part.axis) { const E = view.project(M.add(pivot, part.axis.v)); const dx = E.x - C.x, dy = E.y - C.y, l = Math.hypot(dx, dy) || 1; drag.sd = [dx / l, dy / l]; drag.s0 = (x - C.x) * drag.sd[0] + (y - C.y) * drag.sd[1]; }
    else drag.s0 = Math.hypot(x - C.x, y - C.y);
    if (Math.abs(drag.s0) < 4) drag.s0 = 4 * Math.sign(drag.s0 || 1);
  }
  view.render();
  return true;
}

function dragMove(x, y) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 4) return;
  drag.moved = true;
  const pv = drag.pivot;
  if (drag.k === 'handle') {
    const h = drag.h;
    let v;
    if (drag.sdir) v = drag.v0 + ((x - drag.x0) * drag.sdir[0] + (y - drag.y0) * drag.sdir[1]) / drag.ppm;
    else { const t = axisParam(x, y, M.add(h.origin, M.mul(h.dir, drag.v0)), h.dir); if (t == null) return; v = drag.v0 + (t - drag.t0); }
    if (snapOn()) v = stepSnap(v, fineStep());
    if (h.min != null) v = Math.max(h.min, v);
    updateOp({ [h.key]: v });
    readout = { world: M.add(h.origin, M.mul(h.dir, v)), text: `${getLast().def.label(getLast().params)} ${fmtLen(v)}` };
    view.render(); return;
  }
  let params = {};
  snapMarker.visible = false;
  if (drag.k === 'move') {
    const T = vertexTarget(x, y);
    let d = [0, 0, 0];
    if (drag.part.axis) {
      const A = drag.part.axis.v, kx = 'xyz'.indexOf(drag.part.axis.k);
      let t;
      if (T) t = M.dot(M.sub(T, pv), A);
      else { const tt = axisParam(x, y, pv, A); if (tt == null || drag.t0 == null) return; t = snapLenDelta(tt - drag.t0, kx, pv); }
      d = M.mul(A, t);
    } else {
      const N = drag.part.normal || drag.n;
      if (T) { d = M.sub(T, pv); if (drag.part.normal) d = M.sub(d, M.mul(N, M.dot(d, N))); }
      else {
        const p = planePoint(x, y, pv, N); if (!p || !drag.p0) return;
        d = M.sub(p, drag.p0);
        d = d.map((c, k) => (drag.part.normal && Math.abs(N[k]) > 0.5 ? 0 : snapLenDelta(c, k, pv)));
      }
    }
    if (T) { snapMarker.visible = true; snapMarker.position.set(...T); snapMarker.quaternion.copy(camera().quaternion); snapMarker.scale.setScalar(view.worldPerPixel(T) * 10); }
    params = { x: d[0], y: d[1], z: d[2] };
    const parts = [];
    if (drag.part.axis) parts.push(`${drag.part.axis.k.toUpperCase()} ${fmtLen(d['xyz'.indexOf(drag.part.axis.k)])}`);
    else ['x', 'y', 'z'].forEach((a, k) => { if (Math.abs(d[k]) > 1e-12 || !(drag.part.normal && Math.abs(drag.part.normal[k]) > 0.5)) parts.push(`${a.toUpperCase()} ${fmtLen(d[k], false)}`); });
    readout = { world: M.add(pv, d), text: `Δ ${parts.join('  ')}${T ? ' ⌖' : ''}` };
  } else if (drag.k === 'rotate') {
    const C = view.project(pv);
    const a = Math.atan2(-(y - C.y), x - C.x);
    let da = a - drag.prev; da = Math.atan2(Math.sin(da), Math.cos(da));
    drag.acc += da; drag.prev = a;
    const A = drag.part.axis.v;
    let deg = drag.acc * 180 / Math.PI * (M.dot(A, view.viewDir()) >= 0 ? 1 : -1);
    if (snapOn()) deg = stepSnap(deg, S.settings.angleStep);
    params = { axis: drag.part.axis.k, angle: deg };
    readout = { world: pv, text: `${drag.part.axis.k.toUpperCase()} ${fmtAng(deg)}` };
  } else if (drag.k === 'scale') {
    const C = drag.C;
    let f = drag.part.axis ? ((x - C.x) * drag.sd[0] + (y - C.y) * drag.sd[1]) / drag.s0 : Math.hypot(x - C.x, y - C.y) / drag.s0;
    if (snapOn()) f = stepSnap(f, 0.1);
    if (drag.part.axis) { const k = drag.part.axis.k; params = { sx: k === 'x' ? f : 1, sy: k === 'y' ? f : 1, sz: k === 'z' ? f : 1 }; }
    else params = { sx: f, sy: f, sz: f };
    readout = { world: pv, text: `× ${fmtNum(f)}` };
  }
  updateOp(params);
  view.render();
}

function dragEnd() {
  if (!drag) return;
  if (!drag.moved) { // a tap on the gizmo: nothing changes, and the tap picks what is under it
    if (drag.k !== 'handle' || drag.created) cancelOp();
    drag = null; readout = null; snapMarker.visible = false; view.render();
    return 'tap';
  }
  if (drag.k === 'move' && drag.part.axis) getLast()._typeKey = drag.part.axis.k;
  if (drag.k === 'rotate') getLast()._typeKey = 'angle';
  if (drag.k !== 'handle' || drag.created) commit();
  else { // the part grew past the screen edge: bring it back into view
    const pts = S.doc.objects.filter(o => !o.hidden && o.mesh.v.length).flatMap(o => { const W = o.mesh.v.map(xfFor(o).toW), b = M.bbox(W); return [b.min, b.max, [b.min[0], b.max[1], b.min[2]], [b.max[0], b.min[1], b.max[2]]]; });
    const { w, h } = view.size();
    if (pts.some(q => { const s = view.project(q); return !s.front || s.x < 0 || s.y < 0 || s.x > w || s.y > h; })) view.frame(pts);
  }
  drag = null; readout = null; snapMarker.visible = false;
  emit('lastop', getLast());
  view.render();
}
function dragCancel() {
  if (!drag) return;
  if (drag.k === 'handle' && !drag.created) updateOp({ [drag.h.key]: drag.v0 }); else cancelOp();
  drag = null; readout = null; snapMarker.visible = false;
  view.render();
}
export const gizmoActive = () => !!drag;

// snap step for drag handles: the user's step, made finer when zoomed in on small parts (1 · 2 · 5 × 10ⁿ ≥ ~8 px)
function fineStep() {
  const last = getLast(), h = last && last.handle;
  const wpp = h ? view.worldPerPixel(M.add(h.origin, M.mul(h.dir, last.params[h.key] || 0))) : 0;
  const want = wpp * 8, step = S.settings.snapStep;
  if (!(want > 0) || want >= step) return step;
  const e = Math.pow(10, Math.floor(Math.log10(want)));
  for (const k of [1, 2, 5, 10]) if (k * e >= want) return Math.min(step, k * e);
  return step;
}

// ---------- number typing (Plasticity): the value bubble at a handle, and keys typed while a handle is up ----------
function typeValue(first) {
  const last = getLast(), h = last && last.handle;
  if (!h && last && last.committed && last._typeKey && last.def === OPS.transform) {
    const key = last._typeKey, ang = key === 'angle';
    openKeypad({ label: ang ? `Angle about ${String(last.params.axis).toUpperCase()}` : `Move ${key.toUpperCase()}`, kind: ang ? 'ang' : 'len', value: last.params[key] || 0, onCommit: v => { if (getLast() === last) { updateOp({ [key]: v }); emit('lastop', getLast()); view.render(); } } });
    if (first) keypadKey(first);
    return true;
  }
  if (!h) return false;
  const lab = { dist: 'Distance', distance: 'Distance', size: last.params.kind === 'chamfer' ? 'Chamfer' : 'Radius' }[h.key] || 'Value';
  openKeypad({ label: lab, kind: 'len', value: last.params[h.key] || 0, min: h.min ?? null, onCommit: v => { if (getLast() === last) { updateOp({ [h.key]: v }); emit('lastop', getLast()); view.render(); } } });
  if (first) keypadKey(first);
  return true;
}
// (the viewport asks: a press here is on the value bubble — a tap on release, never the precision cursor)
export const valueHit = (x, y) => !!valueBubble && Math.hypot(valueBubble.x - x, valueBubble.y - y) <= 30;
export function valueTap(x, y) {
  if (!valueBubble || Math.hypot(valueBubble.x - x, valueBubble.y - y) > 30) return false;
  return typeValue(null);
}
export function typeKey(e) {
  const last = getLast();
  if (keypadOpen() || !/^[0-9.\-]$/.test(e.key) || !(last?.handle || (last?.committed && last._typeKey))) return false;
  return typeValue(e);
}
// (tests and debugging: which gizmo part is under a point)
export const gizmoPartAt = (x, y) => hitTest(x, y)?.id || null;

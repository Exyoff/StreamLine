// Transform gizmo + operator drag handles, hit-tested in screen space with touch-sized tolerances.
import * as THREE from 'three';
import { S, emit } from './state.js';
import { view, camera } from './viewport.js';
import { runOp, updateOp, commit, cancelOp, getLast } from './ops.js';
import * as OPS from './operators.js';
import { fmtLen, fmtAng, fmtNum } from './units.js';
import * as M from './mesh.js';

const AX = [
  { k: 'x', v: [1, 0, 0], col: '#f2545b' },
  { k: 'y', v: [0, 1, 0], col: '#7cc243' },
  { k: 'z', v: [0, 0, 1], col: '#4f8ff7' },
];
const PX = 84;      // gizmo length in CSS px
const HIT = 24;     // touch tolerance in px
const HILITE = new THREE.Color('#ffe066');

let root, key = '', parts = [], drag = null, snapMarker = null, readout = null;

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

function kind() {
  const last = getLast();
  if (last && last.handle) return 'handle';
  if (['move', 'rotate', 'scale'].includes(S.ed.tool) && OPS.computePivot()) return S.ed.tool;
  return null;
}

function rebuild(k) {
  root.clear(); parts = [];
  if (!k) return;
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
      const head = k === 'move' ? new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 16), m) : new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), m);
      head.position.y = 1.0;
      g.add(shaft, head);
    }
    root.add(g);
    parts.push({ id: 'axis-' + a.k, axis: a, obj: g, mats: [m], col: new THREE.Color(a.col) });
  }
  if (k === 'move') {
    [['x', 'y', 'z'], ['x', 'z', 'y'], ['y', 'z', 'x']].forEach(([i, j, n]) => {
      const A = AX.find(a => a.k === n);
      const m = mat(A.col, 0.55);
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), m);
      const vi = new THREE.Vector3(...AX.find(a => a.k === i).v), vj = new THREE.Vector3(...AX.find(a => a.k === j).v);
      sq.position.copy(vi.clone().add(vj).multiplyScalar(0.33));
      sq.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...A.v));
      root.add(sq);
      parts.push({ id: 'plane-' + n, normal: A.v, u: AX.find(a => a.k === i).v, w: AX.find(a => a.k === j).v, obj: sq, mats: [m], col: new THREE.Color(A.col) });
    });
  }
  if (k === 'move' || k === 'scale') {
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
  const p = OPS.computePivot();
  return p ? { p, s: view.worldPerPixel(p) * PX } : null;
}

function update() {
  const k = kind();
  const kk = k + '|' + (k === 'handle' ? getLast().def.label() : '');
  if (kk !== key) { key = kk; rebuild(k); }
  readout && view.label(readout.world, readout.text, 'readout');
  if (!k) { root.visible = false; return; }
  const ps = pivotAndScale();
  if (!ps) { root.visible = false; return; }
  root.visible = true;
  root.position.set(...ps.p); root.scale.setScalar(ps.s);
  const vd = view.viewDir();
  for (const part of parts) {
    if (part.billboard) part.obj.quaternion.copy(camera().quaternion);
    if (k === 'handle') part.obj.quaternion.setFromUnitVectors(UPY, new THREE.Vector3(...getLast().handle.dir));
    const active = drag && drag.part === part;
    part.mats.forEach(m => m.color.copy(active ? HILITE : part.col));
    if (part.axis && k !== 'rotate') part.obj.visible = Math.abs(M.dot(part.axis.v, vd)) < 0.985;
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
    if (part.id === 'center') { const d = Math.hypot(C.x - x, C.y - y); if (d < 18) return { part, d: 0 }; continue; }
    if (part.id === 'handle') {
      const dir = getLast().handle.dir;
      const r = segDist(x, y, C, view.project(M.add(P, M.mul(dir, s))));
      consider(part, r.d * 0.8); continue;
    }
    if (part.axis && k === 'rotate') {
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
      const c = view.project(M.add(P, M.mul(M.add(part.u, part.w), s * 0.33)));
      consider(part, Math.max(0, Math.hypot(c.x - x, c.y - y) - 8));
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
  if (k === 'handle') {
    const last = getLast(), h = last.handle;
    drag = { part, k, v0: last.params[h.key], t0: axisParam(x, y, M.add(h.origin, M.mul(h.dir, last.params[h.key])), h.dir) ?? 0, h };
    view.render(); return true;
  }
  const mode = k;
  if (!runOp(OPS.transform, { mode }, { interactive: true })) return false;
  const pivot = getLast().params.pivot;
  drag = { part, k: mode, pivot };
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
  const pv = drag.pivot;
  if (drag.k === 'handle') {
    const h = drag.h;
    const t = axisParam(x, y, M.add(h.origin, M.mul(h.dir, drag.v0)), h.dir);
    if (t == null) return;
    let v = drag.v0 + (t - drag.t0);
    if (snapOn()) v = stepSnap(v, S.settings.snapStep);
    if (h.min != null) v = Math.max(h.min, v);
    updateOp({ [h.key]: v });
    readout = { world: M.add(h.origin, M.mul(h.dir, v)), text: `${getLast().def.label()} ${fmtLen(v)}` };
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
  if (drag.k !== 'handle') commit();
  drag = null; readout = null; snapMarker.visible = false;
  emit('lastop', getLast());
  view.render();
}
function dragCancel() {
  if (!drag) return;
  if (drag.k === 'handle') updateOp({ [drag.h.key]: drag.v0 }); else cancelOp();
  drag = null; readout = null; snapMarker.visible = false;
  view.render();
}
export const gizmoActive = () => !!drag;

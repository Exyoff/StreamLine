// Operator definitions. Each: label(p), defaults(), prepare(p) -> error string?, touch(p), fields(p), apply(p, op)
import * as THREE from 'three';
import { S, activeObj, selectedObjs } from './state.js';
import * as M from './mesh.js';
import { newObject, xfFor, rotMatrix, eulerFromMatrix, cloneObj, worldVerts } from './scene.js';
import { LEN_UNITS } from './units.js';

const DEF_SIZE = { mm: 20, cm: 20, m: 1000, in: 25.4, ft: 304.8 };
export const defSize = () => DEF_SIZE[S.settings.unit] || 20;
const roundTo = (v, s) => (s > 0 ? Math.round(v / s) * s : v);

// ---------- selection helpers ----------
export function selectedWorldPoints() {
  if (S.ed.mode === 'edit') {
    const o = activeObj(); if (!o) return [];
    const xf = xfFor(o);
    return [...S.ed.editSel].filter(i => i < o.mesh.v.length).map(i => xf.toW(o.mesh.v[i]));
  }
  return selectedObjs().map(o => o.loc.slice());
}
export function computePivot() {
  const pts = selectedWorldPoints();
  if (!pts.length) return null;
  if (S.ed.mode === 'edit') return M.centroid(pts); // median point
  return M.centroid(pts);
}
function hasSelection() { return S.ed.mode === 'edit' ? S.ed.editSel.size > 0 : S.ed.selected.size > 0; }
const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// exact rotation for multiples of 90 degrees
function rotationMatrix(axis, deg) {
  const r = ((deg % 360) + 360) % 360;
  let c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  if (r === 0) { c = 1; s = 0; } else if (r === 90) { c = 0; s = 1; } else if (r === 180) { c = -1; s = 0; } else if (r === 270) { c = 0; s = -1; }
  const m = new THREE.Matrix4();
  if (axis === 'x') m.set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1);
  else if (axis === 'y') m.set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1);
  else m.set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  return m;
}
function apply3(m, p) {
  const e = m.elements;
  return [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]];
}

const lenF = (key, label) => ({ key, label, kind: 'len' });
const xyz = (pre = '') => [lenF(pre + 'x', 'X'), lenF(pre + 'y', 'Y'), lenF(pre + 'z', 'Z')];

// ---------- Add primitive ----------
const PRIM = {
  cube: { label: 'Cube', fields: () => [lenF('w', 'Width X'), lenF('d', 'Depth Y'), lenF('h', 'Height Z')], def: s => ({ w: s, d: s, h: s }), build: p => M.makeBox(p.w, p.d, p.h), h: p => p.h },
  plane: { label: 'Plane', fields: () => [lenF('w', 'Width X'), lenF('d', 'Depth Y')], def: s => ({ w: s, d: s }), build: p => M.makePlane(p.w, p.d), h: () => 0 },
  cylinder: { label: 'Cylinder', fields: () => [lenF('r', 'Radius'), lenF('h', 'Height'), { key: 'n', label: 'Sides', kind: 'int', min: 3, max: 512 }], def: s => ({ r: s / 2, h: s, n: 32 }), build: p => M.makeCylinder(p.r, p.h, p.n), h: p => p.h },
  cone: { label: 'Cone', fields: () => [lenF('r', 'Radius 1'), lenF('r2', 'Radius 2'), lenF('h', 'Height'), { key: 'n', label: 'Sides', kind: 'int', min: 3, max: 512 }], def: s => ({ r: s / 2, r2: 0, h: s, n: 32 }), build: p => M.makeCone(p.r, p.r2, p.h, p.n), h: p => p.h },
  sphere: { label: 'Sphere', fields: () => [lenF('r', 'Radius'), { key: 'n', label: 'Segments', kind: 'int', min: 3, max: 256 }, { key: 'rings', label: 'Rings', kind: 'int', min: 2, max: 256 }], def: s => ({ r: s / 2, n: 32, rings: 16 }), build: p => M.makeSphere(p.r, p.n, p.rings), h: p => 2 * p.r },
  torus: { label: 'Torus', fields: () => [lenF('R', 'Major radius'), lenF('r', 'Minor radius'), { key: 'n', label: 'Major segs', kind: 'int', min: 3, max: 256 }, { key: 'm', label: 'Minor segs', kind: 'int', min: 3, max: 128 }], def: s => ({ R: s / 2, r: s / 8, n: 48, m: 12 }), build: p => M.makeTorus(p.R, p.r, p.n, p.m), h: p => 2 * p.r },
};
export const PRIM_TYPES = Object.keys(PRIM).map(k => [k, PRIM[k].label]);

export const addPrim = {
  label: p => 'Add ' + PRIM[p.type].label,
  prepare(p) {
    const P = PRIM[p.type];
    const d = P.def(defSize());
    for (const k in d) if (p[k] === undefined) p[k] = d[k];
    p.x ??= 0; p.y ??= 0; p.z ??= P.h(p) / 2;
    p._id ??= S.doc.nextId;
  },
  touch: () => ({ ids: [] }),
  fields: p => [...PRIM[p.type].fields(), ...xyz()],
  apply(p) {
    const P = PRIM[p.type];
    for (const f of P.fields()) if (f.kind === 'len' && !(p[f.key] >= 0)) return 'Size must be ≥ 0';
    if (p.type !== 'cone' && ['w', 'h', 'r', 'R'].some(k => k in p && p[k] <= 0)) return 'Size must be > 0';
    const o = newObject(P.label, P.build(p), [p.x, p.y, p.z], p._id);
    S.doc.objects.push(o);
    S.ed.mode = 'object'; S.ed.selected = new Set([o.id]); S.ed.active = o.id;
    S.ed.editSel = new Set(); S.ed.selOrder = [];
  },
};

// ---------- Transform (move / rotate / scale) ----------
export const transform = {
  label: p => ({ move: 'Move', rotate: 'Rotate', scale: 'Scale' })[p.mode],
  defaults: () => ({ mode: 'move', x: 0, y: 0, z: 0, axis: 'z', angle: 0, sx: 1, sy: 1, sz: 1 }),
  prepare(p) {
    if (!hasSelection()) return 'Nothing selected';
    p.pivot ??= computePivot();
    p._edit = S.ed.mode === 'edit';
  },
  touch: p => (p._edit ? { ids: [S.ed.active], mesh: true } : { ids: [...S.ed.selected], mesh: false }),
  fields(p) {
    if (p.mode === 'move') return xyz();
    if (p.mode === 'rotate') return [{ key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']] }, { key: 'angle', label: 'Angle', kind: 'ang' }];
    return [{ key: 'sx', label: 'X', kind: 'num' }, { key: 'sy', label: 'Y', kind: 'num' }, { key: 'sz', label: 'Z', kind: 'num' }];
  },
  apply(p) {
    const pv = p.pivot;
    let fn;
    let R = null;
    if (p.mode === 'move') fn = w => [w[0] + p.x, w[1] + p.y, w[2] + p.z];
    else if (p.mode === 'rotate') { R = rotationMatrix(p.axis, p.angle); fn = w => M.add(pv, apply3(R, M.sub(w, pv))); }
    else fn = w => [pv[0] + (w[0] - pv[0]) * p.sx, pv[1] + (w[1] - pv[1]) * p.sy, pv[2] + (w[2] - pv[2]) * p.sz];
    if (p._edit) {
      const o = activeObj(); const xf = xfFor(o);
      for (const i of S.ed.editSel) if (i < o.mesh.v.length) o.mesh.v[i] = xf.toL(fn(xf.toW(o.mesh.v[i])));
    } else {
      for (const o of selectedObjs()) {
        o.loc = fn(o.loc);
        if (R) o.rot = eulerFromMatrix(R.clone().multiply(rotMatrix(o.rot)));
        if (p.mode === 'scale') o.scl = [o.scl[0] * p.sx, o.scl[1] * p.sy, o.scl[2] * p.sz];
      }
    }
  },
};

// ---------- Edit mode operators ----------
function needEdit() { if (S.ed.mode !== 'edit' || !activeObj()) return 'Enter Edit mode first'; }
function selFaces() { const o = activeObj(); return M.selectedFaces(o.mesh, S.ed.editSel); }

export const extrude = {
  label: () => 'Extrude',
  defaults: () => ({ distance: defSize() / 4 }),
  prepare(p) { return needEdit() || (selFaces().length ? undefined : 'Select one or more faces to extrude'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [lenF('distance', 'Distance')],
  apply(p, op) {
    const o = activeObj(), xf = xfFor(o), faces = selFaces();
    if (!faces.length) return 'Select faces';
    const vs = new Set(); faces.forEach(fi => o.mesh.f[fi].forEach(i => vs.add(i)));
    const c = M.centroid([...vs].map(i => xf.toW(o.mesh.v[i])));
    const r = M.extrudeFaces(o.mesh, faces, p.distance, xf);
    S.ed.editSel = r.sel; S.ed.selOrder = [];
    op.handle = { origin: c, dir: r.normal, key: 'distance' };
  },
};

export const inset = {
  label: () => 'Inset',
  prepare(p) {
    const e = needEdit(); if (e) return e;
    const faces = selFaces(); if (!faces.length) return 'Select one or more faces to inset';
    if (p.thickness === undefined) {
      const o = activeObj(), w = worldVerts(o);
      let mn = Infinity;
      for (const fi of faces) { const f = o.mesh.f[fi]; f.forEach((a, i) => { mn = Math.min(mn, M.dist(w[a], w[f[(i + 1) % f.length]])); }); }
      let t = mn * 0.2; if (S.settings.snap && t > S.settings.snapStep) t = roundTo(t, S.settings.snapStep);
      p.thickness = t;
    }
  },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [lenF('thickness', 'Thickness')],
  apply(p, op) {
    if (p.thickness < 0) return 'Thickness must be ≥ 0';
    const o = activeObj(), xf = xfFor(o), faces = selFaces();
    const f0 = o.mesh.f[faces[0]].map(i => xf.toW(o.mesh.v[i]));
    const mid = M.mul(M.add(f0[0], f0[1]), 0.5), c = M.centroid(f0);
    S.ed.editSel = M.insetFaces(o.mesh, faces, p.thickness, xf); S.ed.selOrder = [];
    op.handle = { origin: mid, dir: M.norm(M.sub(c, mid)), key: 'thickness', min: 0 };
  },
};

export const subdivide = {
  label: () => 'Subdivide',
  defaults: () => ({ cuts: 1 }),
  prepare() { return needEdit() || (selFaces().length ? undefined : 'Select faces to subdivide'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [{ key: 'cuts', label: 'Cuts', kind: 'int', min: 1, max: 16 }],
  apply(p) {
    const o = activeObj();
    S.ed.editSel = M.subdivideFaces(o.mesh, selFaces(), Math.max(1, Math.min(16, Math.round(p.cuts))));
    S.ed.selOrder = [];
  },
};

export const deleteGeom = {
  label: () => 'Delete',
  defaults: () => ({ what: S.ed.selectMode === 'face' ? 'faces' : 'verts' }),
  prepare() { return needEdit() || (S.ed.editSel.size ? undefined : 'Nothing selected'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [{ key: 'what', label: 'Delete', kind: 'choice', options: [['verts', 'Vertices'], ['faces', 'Faces only']] }],
  apply(p) {
    const o = activeObj();
    if (p.what === 'faces') M.deleteFaces(o.mesh, selFaces()); else M.deleteVerts(o.mesh, S.ed.editSel);
    S.ed.editSel = new Set(); S.ed.selOrder = [];
  },
};

export const merge = {
  label: () => 'Merge',
  defaults: () => ({ at: 'center' }),
  prepare() { return needEdit() || (S.ed.editSel.size >= 2 ? undefined : 'Select 2 or more vertices'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [{ key: 'at', label: 'At', kind: 'choice', options: [['center', 'Center'], ['first', 'First'], ['last', 'Last']] }],
  apply(p) {
    const o = activeObj(), ids = [...S.ed.editSel];
    let pt;
    const ord = S.ed.selOrder.filter(i => S.ed.editSel.has(i));
    if (p.at === 'first' && ord.length) pt = o.mesh.v[ord[0]];
    else if (p.at === 'last' && ord.length) pt = o.mesh.v[ord[ord.length - 1]];
    else pt = M.centroid(ids.map(i => o.mesh.v[i]));
    S.ed.editSel = M.mergeVerts(o.mesh, S.ed.editSel, pt.slice()); S.ed.selOrder = [];
  },
};

export const fill = {
  label: () => 'Fill Face',
  prepare() { return needEdit() || (S.ed.editSel.size >= 3 ? undefined : 'Select 3 or more vertices'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  apply(p) {
    const o = activeObj();
    if (!M.fillFace(o.mesh, S.ed.editSel, p._view || null)) return 'Could not make a face (points collinear?)';
  },
};

export const flip = {
  label: () => 'Flip Normals',
  prepare() { return needEdit() || (selFaces().length ? undefined : 'Select faces'); },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  apply() { M.flipFaces(activeObj().mesh, selFaces()); },
};
export const recalc = {
  label: () => 'Recalculate Normals',
  prepare: () => needEdit(),
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  apply() { M.recalcNormals(activeObj().mesh); },
};
export const weldOp = {
  label: () => 'Merge by Distance',
  defaults: () => ({ tol: 0.001 }),
  prepare: () => needEdit(),
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [lenF('tol', 'Distance')],
  apply(p, op) {
    const o = activeObj();
    const n = M.weld(o.mesh, Math.max(1e-9, p.tol));
    S.ed.editSel = new Set(); S.ed.selOrder = [];
    op.info = `Removed ${n} vertices`;
  },
};

// Set the median of the selection to an exact world position
export function setMedianOp(axis, value) {
  return {
    label: () => `Median ${axis.toUpperCase()}`,
    prepare: () => (S.ed.editSel.size ? undefined : 'Nothing selected'),
    touch: () => ({ ids: [S.ed.active], mesh: true }),
    apply() {
      const o = activeObj(), xf = xfFor(o), k = 'xyz'.indexOf(axis);
      const ids = [...S.ed.editSel];
      const c = M.centroid(ids.map(i => xf.toW(o.mesh.v[i])));
      const d = value - c[k];
      for (const i of ids) { const w = xf.toW(o.mesh.v[i]); w[k] += d; o.mesh.v[i] = xf.toL(w); }
    },
  };
}
// Set distance between 2 selected vertices (moves the last selected one)
export const setLength = {
  label: () => 'Set Length',
  prepare(p) {
    if (S.ed.editSel.size !== 2) return 'Select exactly 2 vertices';
  },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  fields: () => [lenF('length', 'Length')],
  apply(p) {
    const o = activeObj(), xf = xfFor(o);
    const ids = [...S.ed.editSel];
    const ord = S.ed.selOrder.filter(i => S.ed.editSel.has(i));
    const b = ord.length ? ord[ord.length - 1] : ids[1], a = ids.find(i => i !== b);
    const A = xf.toW(o.mesh.v[a]), B = xf.toW(o.mesh.v[b]);
    const d = M.sub(B, A); const L = M.len(d);
    if (L < 1e-12) return 'Vertices coincide';
    o.mesh.v[b] = xf.toL(M.add(A, M.mul(d, p.length / L)));
  },
};

// ---------- Object mode operators ----------
function needObjSel() { if (S.ed.mode !== 'object') return 'Switch to Object mode'; if (!S.ed.selected.size) return 'Select an object'; }

export const duplicate = {
  label: () => 'Duplicate',
  defaults: () => ({ x: 0, y: 0, z: 0 }),
  prepare(p) { const e = needObjSel(); if (e) return e; p._base ??= S.doc.nextId; },
  touch: () => ({ ids: [] }),
  fields: () => xyz(),
  apply(p) {
    const src = selectedObjs(); const ids = [];
    src.forEach((o, k) => {
      const c = cloneObj(o); const n = newObject(o.name, c.mesh, M.add(o.loc, [p.x, p.y, p.z]), p._base + k);
      n.rot = c.rot; n.scl = c.scl; n.color = o.color; S.doc.objects.push(n); ids.push(n.id);
    });
    S.ed.selected = new Set(ids); S.ed.active = ids[ids.length - 1];
  },
};

export const arrayOp = {
  label: () => 'Array',
  defaults: () => ({ count: 3, x: defSize() * 1.5, y: 0, z: 0 }),
  prepare(p) { const e = needObjSel(); if (e) return e; p._base ??= S.doc.nextId; },
  touch: () => ({ ids: [] }),
  fields: () => [{ key: 'count', label: 'Count', kind: 'int', min: 2, max: 500 }, ...[['x', 'Offset X'], ['y', 'Offset Y'], ['z', 'Offset Z']].map(([k, l]) => lenF(k, l))],
  apply(p) {
    const n = Math.max(2, Math.min(500, Math.round(p.count)));
    const src = selectedObjs(); let id = p._base; const ids = [...S.ed.selected];
    for (let i = 1; i < n; i++) for (const o of src) {
      const c = cloneObj(o); const d = newObject(o.name, c.mesh, M.add(o.loc, [p.x * i, p.y * i, p.z * i]), id++);
      d.rot = c.rot; d.scl = c.scl; d.color = o.color; S.doc.objects.push(d); ids.push(d.id);
    }
    S.ed.selected = new Set(ids);
  },
};

export const deleteObjs = {
  label: () => 'Delete Objects',
  prepare: () => needObjSel(),
  touch: () => ({ ids: [] }),
  apply() {
    S.doc.objects = S.doc.objects.filter(o => !S.ed.selected.has(o.id));
    S.ed.selected = new Set(); S.ed.active = null;
  },
};

export const applyXf = {
  label: () => 'Apply Transform',
  defaults: () => ({ loc: false, rot: true, scale: true }),
  prepare: () => needObjSel(),
  touch: () => ({ ids: [...S.ed.selected], mesh: true }),
  fields: () => [{ key: 'loc', label: 'Location', kind: 'bool' }, { key: 'rot', label: 'Rotation', kind: 'bool' }, { key: 'scale', label: 'Scale', kind: 'bool' }],
  apply(p) {
    for (const o of selectedObjs()) {
      const before = xfFor(o);
      const w = o.mesh.v.map(before.toW);
      if (p.loc) o.loc = [0, 0, 0];
      if (p.rot) o.rot = [0, 0, 0];
      if (p.scale) { if (o.scl.filter(s => s < 0).length % 2) o.mesh.f.forEach(f => f.reverse()); o.scl = [1, 1, 1]; }
      const after = xfFor(o);
      o.mesh.v = w.map(after.toL);
    }
  },
};

export const setOrigin = {
  label: () => 'Set Origin',
  defaults: () => ({ to: 'center' }),
  prepare: () => needObjSel(),
  touch: () => ({ ids: [...S.ed.selected], mesh: true }),
  fields: () => [{ key: 'to', label: 'Origin to', kind: 'choice', options: [['center', 'Bounds'], ['bottom', 'Bottom'], ['world', 'World 0']] }],
  apply(p) {
    for (const o of selectedObjs()) {
      const xf = xfFor(o), w = o.mesh.v.map(xf.toW);
      if (!w.length) continue;
      const bb = M.bbox(w);
      let t;
      if (p.to === 'world') t = [0, 0, 0];
      else { t = M.mul(M.add(bb.min, bb.max), 0.5); if (p.to === 'bottom') t[2] = bb.min[2]; }
      o.loc = t;
      const nx = xfFor(o); o.mesh.v = w.map(nx.toL);
    }
  },
};

// Generic property setter (from the properties panel); no redo fields.
export function setPropOp(label, ids, fn, mesh = false) {
  return { label: () => label, touch: () => ({ ids, mesh }), apply: fn };
}

export const joinObjs = {
  label: () => 'Join',
  prepare() { const e = needObjSel(); if (e) return e; if (S.ed.selected.size < 2) return 'Select 2+ objects'; },
  touch: () => ({ ids: [S.ed.active], mesh: true }),
  apply() {
    const target = S.doc.objects.find(o => o.id === S.ed.active) || selectedObjs()[0];
    const txf = xfFor(target);
    for (const o of selectedObjs()) {
      if (o === target) continue;
      const xf = xfFor(o), base = target.mesh.v.length;
      const neg = o.scl.filter(s => s < 0).length % 2 !== target.scl.filter(s => s < 0).length % 2;
      o.mesh.v.forEach(v => target.mesh.v.push(txf.toL(xf.toW(v))));
      o.mesh.f.forEach(f => { const g = f.map(i => i + base); target.mesh.f.push(neg ? g.reverse() : g); });
    }
    S.doc.objects = S.doc.objects.filter(o => o === target || !S.ed.selected.has(o.id));
    S.ed.selected = new Set([target.id]); S.ed.active = target.id;
  },
};

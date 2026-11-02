// Scene objects: { id, name, mesh: PolyMesh, loc:[x,y,z] (mm), rot:[x,y,z] (deg, Blender XYZ Euler), scl:[x,y,z], color, hidden }
import * as THREE from 'three';
import { S } from './state.js';
import { PolyMesh } from './mesh.js';

const D2R = Math.PI / 180;
// Blender "XYZ Euler" (X applied first) == three.js order 'ZYX'
export const EULER_ORDER = 'ZYX';

export function rotMatrix(rot) {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, EULER_ORDER));
}
export function objMatrix(o) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rot[0] * D2R, o.rot[1] * D2R, o.rot[2] * D2R, EULER_ORDER));
  return new THREE.Matrix4().compose(new THREE.Vector3(...o.loc), q, new THREE.Vector3(...o.scl));
}
export function eulerFromMatrix(m) {
  const e = new THREE.Euler().setFromRotationMatrix(m, EULER_ORDER);
  const r = [e.x / D2R, e.y / D2R, e.z / D2R].map(v => Math.abs(v) < 1e-10 ? 0 : v);
  return r;
}

// Transform helpers in double precision (Matrix4.elements is a plain Array)
export function xfFor(o) {
  const M = objMatrix(o), Mi = M.clone().invert();
  const e = M.elements, ei = Mi.elements;
  const ap = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  return { M, Mi, toW: p => ap(e, p), toL: p => ap(ei, p) };
}

export function worldVerts(o) { const xf = xfFor(o); return o.mesh.v.map(xf.toW); }

const PALETTE = ['#b8bcc4', '#9fb6cf', '#c9b79c', '#a7c4a0', '#c4a3b8', '#d0c58f'];
export function newObject(name, mesh, loc = [0, 0, 0], id = null) {
  const oid = id ?? S.doc.nextId++;
  if (id != null && id >= S.doc.nextId) S.doc.nextId = id + 1;
  return { id: oid, name: uniqueName(name), mesh, loc: loc.slice(), rot: [0, 0, 0], scl: [1, 1, 1], color: PALETTE[(oid - 1) % PALETTE.length], hidden: false };
}
export function uniqueName(base) {
  const names = new Set(S.doc.objects.map(o => o.name));
  if (!names.has(base)) return base;
  const root = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) { const n = `${root}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}
export function cloneObj(o, shareMesh = false) {
  return { ...o, loc: o.loc.slice(), rot: o.rot.slice(), scl: o.scl.slice(), mesh: shareMesh ? o.mesh : o.mesh.clone() };
}

export function serialize() {
  return {
    format: 'streamline', version: 1, unit: 'mm',
    doc: { nextId: S.doc.nextId, objects: S.doc.objects.map(o => ({ ...o, mesh: o.mesh.toJSON() })), sketches: S.doc.sketches || [] },
    ed: { workspace: S.ed.workspace, sketch: S.ed.sketch, drawSel: [...S.ed.drawSel], profiles: S.ed.profiles, mode: S.ed.mode, selectMode: S.ed.selectMode, selected: [...S.ed.selected], active: S.ed.active, editSel: [...S.ed.editSel], selOrder: S.ed.selOrder.slice() },
  };
}
export function deserialize(data) {
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  if (!d || !d.doc || !Array.isArray(d.doc.objects)) throw new Error('Not a StreamLine project');
  S.doc.objects = d.doc.objects.map(o => ({ ...o, loc: o.loc.slice(), rot: o.rot.slice(), scl: o.scl.slice(), mesh: PolyMesh.from(o.mesh) }));
  S.doc.sketches = JSON.parse(JSON.stringify(d.doc.sketches || []));
  S.doc.nextId = d.doc.nextId || (Math.max(0, ...S.doc.objects.map(o => o.id)) + 1);
  const e = d.ed || {};
  S.ed.workspace = e.workspace || 'model';
  S.ed.sketch = e.sketch ?? null;
  S.ed.drawSel = new Set(e.drawSel || []);
  S.ed.profiles = e.profiles || [];
  S.ed.mode = e.mode || 'object';
  S.ed.selectMode = e.selectMode || 'vert';
  S.ed.selected = new Set(e.selected || []);
  S.ed.active = e.active ?? null;
  S.ed.editSel = new Set(e.editSel || []);
  S.ed.selOrder = e.selOrder || [];
  if (S.ed.mode === 'edit' && !S.doc.objects.some(o => o.id === S.ed.active)) S.ed.mode = 'object';
}

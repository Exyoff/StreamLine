// Scene objects: { id, name, mesh: PolyMesh, loc:[x,y,z] (mm), rot:[x,y,z] (deg, Blender XYZ Euler), scl:[x,y,z], color, hidden }
import * as THREE from 'three';
import { S } from './state.js';
import { PolyMesh } from './mesh.js';
import * as K from './kernel.js';

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
  // float noise from matrix round trips (−59.99999999999999°) back to the clean angle
  const r = [e.x / D2R, e.y / D2R, e.z / D2R].map(v => { const q = Math.round(v * 1e6) / 1e6; return Math.abs(q - v) < 1e-7 ? (q === 0 ? 0 : q) : v; });
  return r;
}

// turn an object so direction `from` (world) points along `to`, about the world point `pivot` (for Mate)
export function turnObject(o, from, to, pivot) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...from).normalize(), new THREE.Vector3(...to).normalize());
  const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rot[0] * D2R, o.rot[1] * D2R, o.rot[2] * D2R, EULER_ORDER));
  const e = new THREE.Euler().setFromQuaternion(q.clone().multiply(cur), EULER_ORDER);
  const snap = v => { const d = v / D2R, r = Math.round(d * 1e3) / 1e3; return Math.abs(r - d) < 1e-4 ? r : d; };
  o.rot = [snap(e.x), snap(e.y), snap(e.z)].map(v => (Math.abs(v) < 1e-9 ? 0 : v));
  const rel = new THREE.Vector3(o.loc[0] - pivot[0], o.loc[1] - pivot[1], o.loc[2] - pivot[2]).applyQuaternion(q);
  o.loc = [pivot[0] + rel.x, pivot[1] + rel.y, pivot[2] + rel.z].map(v => { const r = Math.round(v * 1e9) / 1e9; return Math.abs(r - v) < 1e-9 ? r : v; });
}
// turn a part by th (radians) about the world axis through c along d — exactly (no snapping of the angles)
export function turnAbout(o, c, d, th) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...d).normalize(), th);
  const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rot[0] * D2R, o.rot[1] * D2R, o.rot[2] * D2R, EULER_ORDER));
  const e = new THREE.Euler().setFromQuaternion(q.clone().multiply(cur), EULER_ORDER);
  o.rot = [e.x / D2R, e.y / D2R, e.z / D2R];
  const rel = new THREE.Vector3(o.loc[0] - c[0], o.loc[1] - c[1], o.loc[2] - c[2]).applyQuaternion(q);
  o.loc = [c[0] + rel.x, c[1] + rel.y, c[2] + rel.z];
}
// Transform helpers in double precision (Matrix4.elements is a plain Array)
export function xfFor(o) { return xfOfMatrix(objMatrix(o)); }
// a placement given as a THREE matrix (or its 16 elements, column-major): local → world and back
export function xfOfMatrix(M) {
  if (Array.isArray(M)) M = new THREE.Matrix4().fromArray(M);
  const Mi = M.clone().invert();
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
  return { id: oid, name: uniqueName(name), mesh, loc: loc.slice(), rot: [0, 0, 0], scl: [1, 1, 1], color: PALETTE[(oid - 1) % PALETTE.length], hidden: false, layer: S.doc.layer ?? 1 };
}
export function uniqueName(base) {
  const names = new Set(S.doc.objects.map(o => o.name));
  if (!names.has(base)) return base;
  const root = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) { const n = `${root}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}
// solids (o.shape) are immutable values: copies share the shape and its display mesh
export function cloneObj(o, shareMesh = false) {
  return { ...o, loc: o.loc.slice(), rot: o.rot.slice(), scl: o.scl.slice(), mesh: shareMesh || o.shape ? o.mesh : o.mesh.clone() };
}

// light: solids are left out (they are rebuilt from the history on load) — keeps autosave small
// noComp: leave the linked components' solids out (localStorage is small; they live in the device library)
export function serialize(light = false, noComp = false) {
  return {
    format: 'streamline', version: 1, unit: 'mm',
    doc: { nextId: S.doc.nextId, objects: S.doc.objects.map(o => objToJSON(o, light)), sketches: S.doc.sketches || [], history: S.doc.history || [], marker: S.doc.marker ?? null, layers: S.doc.layers || defaultLayers(), layer: S.doc.layer ?? 1, project: S.doc.project || null, gonePres: S.doc.gonePres || {}, cplane: S.ed.cplane || null, components: noComp ? Object.fromEntries(Object.entries(S.doc.components || {}).map(([k, c]) => [k, { name: c.name, version: c.version, inLibrary: true }])) : S.doc.components || {} },
    ed: { workspace: S.ed.workspace, sketch: S.ed.sketch, drawSel: [...S.ed.drawSel], profiles: S.ed.profiles, mode: S.ed.mode, selectMode: S.ed.selectMode, selected: [...S.ed.selected], active: S.ed.active, editSel: [...S.ed.editSel], selOrder: S.ed.selOrder.slice() },
  };
}
export function deserialize(data) {
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  if (!d || !d.doc || !Array.isArray(d.doc.objects)) throw new Error('Not a StreamLine project');
  S.doc.objects = d.doc.objects.map(objFromJSON);
  S.doc.sketches = JSON.parse(JSON.stringify(d.doc.sketches || []));
  S.doc.gonePres = d.doc.gonePres || {};
  S.doc.nextId = d.doc.nextId || (Math.max(0, ...S.doc.objects.map(o => o.id)) + 1);
  S.doc.layers = JSON.parse(JSON.stringify(d.doc.layers || defaultLayers()));
  S.doc.layer = d.doc.layer ?? S.doc.layers[0].id;
  S.doc.marker = d.doc.marker ?? null;
  S.doc.project = d.doc.project || null;
  S.doc.cplane = d.doc.cplane || null; // (the construction plane it was left on: the app takes it up after loading)
  S.doc.components = JSON.parse(JSON.stringify(d.doc.components || {}));
  S.doc.history = JSON.parse(JSON.stringify(d.doc.history || []));
  // projects saved before the timeline existed: their bodies become one baked first step
  if (!d.doc.history && S.doc.objects.length) S.doc.history = [{ id: 'r0', op: '_bake', label: 'Imported geometry', t: Date.now(), params: { add: JSON.parse(JSON.stringify(d.doc.objects)) } }];
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

export const defaultLayers = () => [{ id: 1, name: 'Default', visible: true }];

// solids are saved as OpenCascade BRep text; meshes as vertices/faces
export function objToJSON(o, light = false) {
  const { shape, brep, faceOf, ...rest } = o;
  if (shape && light) return { ...rest, mesh: null, regen: true };
  return shape ? { ...rest, mesh: null, brepData: K.serialize(shape) } : { ...rest, mesh: o.mesh.toJSON() };
}
export function objFromJSON(j) {
  const o = { ...j, loc: j.loc.slice(), rot: j.rot.slice(), scl: j.scl.slice() };
  if (j.brepData) { delete o.brepData; K.setShape(o, K.deserialize(j.brepData)); }
  else if (j.regen) o.mesh = new PolyMesh([], []); // placeholder until the history is replayed
  else o.mesh = PolyMesh.from(j.mesh);
  return o;
}
// undo snapshots: structural copies that share solids (no serialization)
export function snapshot() {
  return {
    doc: { objects: S.doc.objects.map(o => cloneObj(o)), sketches: JSON.stringify(S.doc.sketches || []), nextId: S.doc.nextId, history: JSON.stringify(S.doc.history || []), marker: S.doc.marker ?? null, layers: JSON.stringify(S.doc.layers || defaultLayers()), layer: S.doc.layer ?? 1, components: S.doc.components || {}, project: S.doc.project || null },
    ed: { workspace: S.ed.workspace, sketch: S.ed.sketch, drawSel: [...S.ed.drawSel], profiles: JSON.stringify(S.ed.profiles), mode: S.ed.mode, selectMode: S.ed.selectMode, selected: [...S.ed.selected], active: S.ed.active, editSel: [...S.ed.editSel], selOrder: S.ed.selOrder.slice() },
  };
}
export function restoreSnapshot(s) {
  const d = s.doc;
  S.doc.objects = d.objects.map(o => cloneObj(o)); S.doc.sketches = JSON.parse(d.sketches); S.doc.nextId = d.nextId;
  S.doc.history = JSON.parse(d.history); S.doc.marker = d.marker; S.doc.layers = JSON.parse(d.layers); S.doc.layer = d.layer; S.doc.components = d.components || {}; S.doc.project = d.project || S.doc.project;
  const e = s.ed;
  S.ed.workspace = e.workspace || 'model'; S.ed.sketch = e.sketch ?? null; S.ed.drawSel = new Set(e.drawSel); S.ed.profiles = JSON.parse(e.profiles);
  S.ed.mode = e.mode; S.ed.selectMode = e.selectMode; S.ed.selected = new Set(e.selected); S.ed.active = e.active; S.ed.editSel = new Set(e.editSel); S.ed.selOrder = e.selOrder.slice();
  if (S.ed.mode === 'edit' && !S.doc.objects.some(o => o.id === S.ed.active)) S.ed.mode = 'object';
}

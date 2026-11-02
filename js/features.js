// CAD operators: sketches, extrude, revolve, body booleans. All re-adjustable via the last-op card.
import { S, objById, selectedObjs } from './state.js';
import * as SK from './sketch.js';
import * as M from './mesh.js';
import { toPolys, boolean, polysToMesh, extrudeRegions, revolveRegions } from './csg.js';
import { newObject, xfFor, worldVerts } from './scene.js';
import { defSize } from './operators.js';

const lenF = (key, label) => ({ key, label, kind: 'len' });
const MODES = [['new', 'New'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];

// ---------- sketches ----------
export const newSketch = {
  label: p => `New Sketch · ${p.face ? 'on face' : SK.PLANES[p.plane].label}`,
  defaults: () => ({ plane: 'XY', offset: 0 }),
  prepare(p) { p._id ??= S.doc.nextId; p._n ??= (S.doc.sketches || []).length + 1; },
  touch: () => ({ ids: [] }),
  fields: p => (p.face ? [lenF('offset', 'Offset')] : [{ key: 'plane', label: 'Plane', kind: 'choice', options: [['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ']] }, lenF('offset', 'Offset')]),
  apply(p) {
    const base = p.face ? p.face.plane : SK.PLANES[p.plane];
    const plane = { o: M.add(base.o, M.mul(base.n, p.offset)), u: base.u.slice(), v: base.v.slice(), n: base.n.slice() };
    if (p._id >= S.doc.nextId) S.doc.nextId = p._id + 1;
    S.doc.sketches.push({ id: p._id, name: `Sketch ${p._n}`, plane, ents: [], face: p.face ? { obj: p.face.obj } : null, hidden: false, nextEnt: 1 });
    S.ed.sketch = p._id; S.ed.workspace = 'draw'; S.ed.drawSel = new Set(); S.ed.profiles = [];
  },
};

// generic sketch mutation (entity add / edit / delete)
export function sketchOp(label, skId, fn, fields = null) {
  return {
    label: () => label, touch: () => ({ ids: [] }),
    fields: fields ? () => fields : undefined,
    apply(p) { const sk = SK.sketchById(skId); if (!sk) return 'Sketch missing'; return fn(sk, p); },
  };
}
export function addEntity(sk, ent) { sk.nextEnt = (sk.nextEnt || 1) + 1; const e = { id: sk.nextEnt, ...ent }; sk.ents.push(e); return e; }

// face of a body -> plane
export function facePlane(obj, fi, camRight) {
  const xf = xfFor(obj), P = obj.mesh.f[fi].map(i => xf.toW(obj.mesh.v[i]));
  const n = M.faceNormal(P);
  if (M.len(n) < 0.5) return null;
  // u: the world axis (projected into the face) best aligned with the camera's right vector;
  // origin: the world origin projected onto the face plane, so sketch coordinates match world ones.
  let best = null;
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const pr = M.sub(ax, M.mul(n, M.dot(ax, n)));
    if (M.len(pr) < 0.2) continue;
    const e = M.norm(pr), sc = M.dot(e, camRight) + M.len(pr) * 1e-3;
    if (!best || Math.abs(sc) > Math.abs(best.s)) best = { e, s: sc };
  }
  let u = best.s < 0 ? M.mul(best.e, -1) : best.e;
  // drafting convention: X runs left→right on top/bottom and front/back faces, Y on side faces
  if (Math.abs(n[2]) > 0.999 || Math.abs(n[1]) > 0.999) u = [1, 0, 0];
  else if (Math.abs(n[0]) > 0.999) u = [0, Math.sign(n[0]), 0];
  const d = M.dot(n, P[0]);
  return { o: M.mul(n, d), u, v: M.cross(n, u), n };
}

// ---------- profiles ----------
function profileGroups(pts) {
  const groups = new Map();
  for (const it of pts) {
    const sk = SK.sketchById(it.sk); if (!sk) continue;
    const r = SK.regionAt(sk, it.pt); if (!r) continue;
    const g = groups.get(sk.id) || groups.set(sk.id, { sk, regs: [] }).get(sk.id);
    if (!g.regs.includes(r)) g.regs.push(r);
  }
  return [...groups.values()];
}
function regionsCentroid(g) {
  const pts = g.regs.flatMap(r => r.outer);
  return SK.toW(g.sk.plane, [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]);
}
function unionAll(meshes) {
  if (meshes.length === 1) return meshes[0];
  let polys = toPolys(meshes[0].v, meshes[0].f);
  for (const m of meshes.slice(1)) polys = boolean('union', polys, toPolys(m.v, m.f));
  return polysToMesh(polys);
}
// apply a world-space tool mesh with a mode; returns error string or undefined
function applyBody(p, tool, name, anchor) {
  if (!tool.f.length) return 'Nothing to build';
  if (p.mode === 'new') {
    const o = newObject(name, tool, [0, 0, 0], p._id);
    o.loc = anchor.slice(); o.mesh.v = tool.v.map(w => M.sub(w, anchor));
    S.doc.objects.push(o);
    S.ed.selected = new Set([o.id]); S.ed.active = o.id;
  } else {
    const t = objById(p.target);
    if (!t) return 'Select a target body first (tap it), or use New';
    const xf = xfFor(t);
    const res = polysToMesh(boolean(p.mode === 'join' ? 'union' : p.mode === 'cut' ? 'subtract' : 'intersect', toPolys(worldVerts(t), t.mesh.f), toPolys(tool.v, tool.f)));
    if (!res.f.length) return 'Result is empty';
    if (t.scl.filter(s => s < 0).length % 2) res.f.forEach(f => f.reverse());
    t.mesh = res; t.mesh.v = res.v.map(xf.toL);
    S.ed.selected = new Set([t.id]); S.ed.active = t.id;
  }
  S.ed.profiles = [];
}
function prepFeature(p) {
  if (!p.pts) p.pts = JSON.parse(JSON.stringify(S.ed.profiles));
  const groups = profileGroups(p.pts);
  if (!groups.length) return 'Tap one or more closed sketch regions first';
  if (p.target === undefined) {
    const sk = groups[0].sk;
    const faceObj = sk.face && objById(sk.face.obj) ? sk.face.obj : null;
    const sel = selectedObjs()[0];
    p.target = faceObj ?? (sel ? sel.id : null);
    if (p.mode === undefined) p.mode = faceObj ? 'join' : 'new';
  }
  p.mode ??= 'new';
  p._id ??= S.doc.nextId;
}
const touchFeature = p => (p.mode !== 'new' && p.target != null ? { ids: [p.target], mesh: true } : { ids: [] });
const targetLabel = p => { const t = p.mode !== 'new' && objById(p.target); return t ? ` → ${t.name}` : ''; };

export const extrude = {
  label: p => `Extrude${targetLabel(p)}`,
  defaults: () => ({ distance: defSize() / 2, symmetric: false, flip: false }),
  prepare: prepFeature,
  touch: touchFeature,
  fields: () => [lenF('distance', 'Distance'), { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }, { key: 'symmetric', label: 'Symmetric', kind: 'bool' }, { key: 'flip', label: 'Flip', kind: 'bool' }],
  apply(p, op) {
    if (Math.abs(p.distance) < 1e-9) return 'Distance must not be zero';
    const groups = profileGroups(p.pts);
    if (!groups.length) return 'Profiles no longer exist';
    const meshes = [];
    let dirW = null, anchor = null;
    for (const g of groups) {
      const into = g.sk.face && (p.mode === 'cut' || p.mode === 'intersect') ? -1 : 1;
      const s = (p.flip ? -1 : 1) * into;
      const [h0, h1] = p.symmetric ? [-p.distance / 2, p.distance / 2] : [0, p.distance * s];
      const regs = g.regs;
      meshes.push(regs.length > 1 ? unionAll(regs.map(r => extrudeRegions([r], g.sk.plane, h0, h1))) : extrudeRegions(regs, g.sk.plane, h0, h1));
      if (!dirW) { dirW = M.mul(g.sk.plane.n, s); anchor = regionsCentroid(g); }
    }
    const tool = meshes.length > 1 ? unionAll(meshes) : meshes[0];
    const err = applyBody(p, tool, 'Body', anchor);
    if (err) return err;
    if (!p.symmetric) op.handle = { origin: anchor, dir: dirW, key: 'distance' };
  },
};

export const revolve = {
  label: p => `Revolve${targetLabel(p)}`,
  defaults: () => ({ axis: 'y', angle: 360, segs: S.settings.curveSegs || 64 }),
  prepare: prepFeature,
  touch: touchFeature,
  fields: () => [{ key: 'axis', label: 'Axis (sketch)', kind: 'choice', options: [['x', 'X axis'], ['y', 'Y axis']] }, { key: 'angle', label: 'Angle', kind: 'ang' }, { key: 'segs', label: 'Segments', kind: 'int', min: 3, max: 512 }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
  apply(p) {
    if (Math.abs(p.angle) < 1e-6) return 'Angle must not be zero';
    const groups = profileGroups(p.pts);
    if (!groups.length) return 'Profiles no longer exist';
    for (const g of groups) for (const r of g.regs) {
      const vals = r.outer.map(q => (p.axis === 'x' ? q[1] : q[0]));
      if (Math.min(...vals) < -1e-9 && Math.max(...vals) > 1e-9) return `Profile crosses the sketch ${p.axis.toUpperCase()} axis`;
    }
    const meshes = groups.map(g => revolveRegions(g.regs, g.sk.plane, p.axis, p.angle, p.segs));
    const tool = meshes.length > 1 ? unionAll(meshes) : meshes[0];
    const anchor = groups[0].sk.plane.o.slice();
    return applyBody(p, tool, 'Revolve', anchor);
  },
};

export const bodyBoolean = {
  label: p => ({ union: 'Union', subtract: 'Subtract', intersect: 'Intersect' })[p.kind],
  defaults: () => ({ kind: 'union', keep: false }),
  prepare(p) {
    if (S.ed.selected.size < 2) return 'Select 2+ bodies (turn on multi-select). The first one tapped is the target.';
    p.ids ??= [...S.ed.selected];
  },
  touch: p => ({ ids: p.ids, mesh: true }),
  fields: () => [{ key: 'kind', label: 'Operation', kind: 'choice', options: [['union', 'Union'], ['subtract', 'Subtract'], ['intersect', 'Intersect']], wide: true }, { key: 'keep', label: 'Keep tools', kind: 'bool' }],
  apply(p) {
    const [tid, ...tools] = p.ids;
    const t = objById(tid); if (!t) return 'Target missing';
    let polys = toPolys(worldVerts(t), t.mesh.f);
    for (const id of tools) { const o = objById(id); if (o) polys = boolean(p.kind, polys, toPolys(worldVerts(o), o.mesh.f)); }
    const res = polysToMesh(polys);
    if (!res.f.length) return 'Result is empty';
    const xf = xfFor(t);
    t.mesh = res; t.mesh.v = res.v.map(xf.toL);
    if (!p.keep) S.doc.objects = S.doc.objects.filter(o => !tools.includes(o.id));
    S.ed.selected = new Set([t.id]); S.ed.active = t.id;
  },
};

// ---------- 3D edge fillet / chamfer ----------
import { edgeBlend } from './edges.js';
export const edgeBlendOp = {
  label: p => (p.kind === 'fillet' ? 'Fillet' : 'Chamfer') + ` · ${p.edges.length} edge${p.edges.length === 1 ? '' : 's'}`,
  defaults: () => ({ kind: 'fillet', size: defSize() / 10, segs: 8 }),
  prepare(p) {
    p.edges ??= JSON.parse(JSON.stringify(S.ed.edges || []));
    if (!p.edges.length) return 'Pick body edges first (Edge tool)';
    p._objs = [...new Set(p.edges.map(e => e.obj))];
  },
  touch: p => ({ ids: p._objs, mesh: true }),
  fields: p => [lenF('size', p.kind === 'fillet' ? 'Radius' : 'Distance'), ...(p.kind === 'fillet' ? [{ key: 'segs', label: 'Segments / 90°', kind: 'int', min: 1, max: 64 }] : []), { key: 'kind', label: 'Type', kind: 'choice', options: [['fillet', 'Fillet'], ['chamfer', 'Chamfer']], wide: true }],
  apply(p) {
    if (!(p.size > 0)) return 'Size must be > 0';
    for (const id of p._objs) {
      const o = objById(id); if (!o) return 'Body missing';
      let W = worldVerts(o), faces = o.mesh.f;
      for (const e of p.edges.filter(x => x.obj === id)) {
        const r = edgeBlend(W, faces, e.a, e.b, p.size, p.kind, Math.max(1, Math.round(p.segs)));
        if (typeof r === 'string') return r;
        W = r.v; faces = r.f;
      }
      const xf = xfFor(o);
      o.mesh = new M.PolyMesh(W.map(xf.toL), faces);
      if (o.scl.filter(s => s < 0).length % 2) o.mesh.f.forEach(f => f.reverse());
    }
    S.ed.edges = [];
  },
};

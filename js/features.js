// CAD operators: sketches, extrude, revolve, body booleans. All re-adjustable via the last-op card.
import { S, objById, selectedObjs } from './state.js';
import * as SK from './sketch.js';
import * as M from './mesh.js';
import { toPolys, boolean, polysToMesh } from './csg.js';
import { newObject, xfFor, worldVerts } from './scene.js';
import { defSize } from './operators.js';
import { fmtLen } from './units.js';

const lenF = (key, label) => ({ key, label, kind: 'len' });
const MODES = [['new', 'New'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];

// ---------- sketches ----------
export const newSketch = {
  label: p => `New Sketch · ${p.face ? 'on face' : SK.PLANES[p.plane].label}`,
  defaults: () => ({ plane: 'XY', offset: 0 }),
  prepare(p) { p._id ??= S.doc.nextId; p._n ??= (S.doc.sketches || []).length + 1; },
  touch: () => ({ ids: [] }), sketchOnly: true,
  fields: p => (p.face ? [lenF('offset', 'Offset')] : [{ key: 'plane', label: 'Plane', kind: 'choice', options: [['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ']] }, lenF('offset', 'Offset')]),
  apply(p) {
    const base = p.face ? p.face.plane : SK.PLANES[p.plane];
    const plane = { o: M.add(base.o, M.mul(base.n, p.offset)), u: base.u.slice(), v: base.v.slice(), n: base.n.slice() };
    if (p._id >= S.doc.nextId) S.doc.nextId = p._id + 1;
    const ents = [];
    let nextEnt = 1;
    if (p.face && p.face.loops) for (const L of p.face.loops) for (const e of projectLoop(L.map(w => SK.toP(plane, w)))) ents.push({ id: ++nextEnt, ...e, proj: true });
    S.doc.sketches.push({ id: p._id, name: `Sketch ${p._n}`, plane, ents, face: p.face ? { obj: p.face.obj } : null, hidden: false, nextEnt, layer: S.doc.layer ?? 1 });
    S.ed.sketch = p._id; if (S.ed.workspace !== 'model') S.ed.workspace = 'draw'; S.ed.drawSel = new Set(); S.ed.profiles = [];
  },
};

// A face boundary loop (2D) → sketch entities: one exact circle if the loop is a circle,
// otherwise lines with collinear runs merged (Fusion-style "projected" geometry).
export function projectLoop(P) {
  const n = P.length;
  if (n >= 8) {
    const c = [P.reduce((s, q) => s + q[0], 0) / n, P.reduce((s, q) => s + q[1], 0) / n];
    const R = SK.d2(P[0], c);
    if (P.every(q => Math.abs(SK.d2(q, c) - R) < 1e-4 * Math.max(1, R))) {
      // the faceted loop is inscribed; its true circle passes through the vertices
      return [{ t: 'circle', c: c.map(v => Math.round(v * 1e9) / 1e9), r: Math.round(R * 1e9) / 1e9 }];
    }
  }
  const keep = P.filter((q, i) => {
    const a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
    return Math.abs((q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])) > 1e-9 * Math.max(1, SK.d2(a, b) ** 2);
  });
  const cl = q => q.map(v => (Math.abs(v - Math.round(v * 1e9) / 1e9) < 1e-11 ? Math.round(v * 1e9) / 1e9 : v));
  return keep.map((q, i) => ({ t: 'line', a: cl(q), b: cl(keep[(i + 1) % keep.length]) }));
}

// generic sketch mutation (entity add / edit / delete)
export function sketchOp(label, skId, fn, fields = null) {
  return {
    label: () => label, touch: () => ({ ids: [] }), sketchOnly: true,
    fields: fields ? () => fields : undefined,
    apply(p) { const sk = SK.sketchById(skId); if (!sk) return 'Sketch missing'; return fn(sk, p); },
  };
}
// Sketch edit on a plane that has no sketch yet: create it in the same operation (one undo step).
export function sketchOpNew(label, plane, face, fn, fields = null) {
  return {
    label: () => label, touch: () => ({ ids: [] }), sketchOnly: true,
    fields: fields ? () => fields : undefined,
    prepare(p) { p._id ??= S.doc.nextId; p._n ??= (S.doc.sketches || []).length + 1; },
    apply(p) {
      if (p._id >= S.doc.nextId) S.doc.nextId = p._id + 1;
      const sk = { id: p._id, name: `Sketch ${p._n}`, plane: JSON.parse(JSON.stringify(plane)), ents: [], face: face ? { obj: face.obj } : null, hidden: false, nextEnt: 1, layer: S.doc.layer ?? 1 };
      S.doc.sketches.push(sk);
      S.ed.sketch = sk.id;
      return fn(sk, p);
    },
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
  // snap float noise from the world transform (0.9999999999999999 → 1) so face planes are exact
  const cl = v => { const q = Math.round(v * 1e9) / 1e9; return Math.abs(v - q) < 1e-11 ? (q === 0 ? 0 : q) : v; };
  const nn = n.map(cl), uu = u.map(cl), d = cl(M.dot(nn, P[0]));
  return { o: M.mul(nn, d).map(cl), u: uu, v: M.cross(nn, uu).map(cl), n: nn };
}

// ---------- profiles ----------
function profileGroups(pts) {
  const groups = new Map();
  for (const it of pts) {
    const sk = SK.sketchById(it.sk); if (!sk) continue;
    const r = SK.regionAt(sk, it.pt); if (!r) continue;
    const g = groups.get(sk.id) || groups.set(sk.id, { sk, regs: [], pts: [] }).get(sk.id);
    if (!g.regs.includes(r)) { g.regs.push(r); g.pts.push(it.pt); }
  }
  return [...groups.values()];
}
function regionsCentroid(g) {
  const pts = g.regs.flatMap(r => r.outer);
  return SK.toW(g.sk.plane, [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]);
}
// ---------- B-rep features (OpenCascade) ----------
import * as K from './kernel.js';
const R = K.R;
// OpenCascade reports failures as exceptions: turn them into a message for the dialog / History
function guard(fn, msg) {
  try { return fn(); } catch (e) { console.warn(e); const m = e && e.message || ''; return typeof m === 'string' && m.trim() && m.length < 120 && !/^\d+$/.test(m) ? `${msg} (${m})` : msg; }
}
const solidOnly = o => (o && o.shape ? null : o ? `“${o.name}” is an imported mesh — this works on solids` : 'Body missing');
// a direction / point in an object's local frame
const locDir = (xf, p, n) => M.norm(M.sub(xf.toL(M.add(p, n)), xf.toL(p)));
const vec3 = v => [v.x, v.y, v.z];

// the exact faces of the regions picked in one sketch (one per region, in pick order)
function groupFaces(g) {
  const out = [];
  for (const pt of g.pts) { const f = K.regionFace(g.sk, pt); if (f && !out.includes(f)) out.push(f); }
  return out;
}
// apply a world-space tool solid with a mode; returns an error string or undefined
function applyBody(p, tool, name) {
  if (K.isEmpty(tool)) return 'Nothing to build';
  if (p.mode === 'new') {
    const o = newObject(name, null, [0, 0, 0], p._id);
    K.setShape(o, tool);
    S.doc.objects.push(o);
    S.ed.selected = new Set([o.id]); S.ed.active = o.id;
  } else {
    const t = objById(p.target);
    if (!t) return 'Select a target body first (tap it), or use New';
    const e = solidOnly(t); if (e) return e;
    const res = guard(() => K.boolean(p.mode === 'join' ? 'union' : p.mode === 'cut' ? 'subtract' : 'intersect', t.shape, K.toLocal(tool, t)), 'Boolean failed');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    K.setShape(t, res);
    S.ed.selected = new Set([t.id]); S.ed.active = t.id;
  }
  // the sketch is consumed by the feature: hide it once every closed region in it has been used
  for (const id of new Set((p.pts || []).map(it => it.sk))) {
    const sk = SK.sketchById(id); if (!sk || S.settings.hideConsumed === false) continue;
    const seeds = [...p.pts.filter(it => it.sk === id).map(it => it.pt), ...(S.doc.history || []).flatMap(r => (r.params?.pts || []).filter(it => it.sk === id).map(it => it.pt))];
    const used = new Set(seeds.map(pt => SK.regionAt(sk, pt)).filter(Boolean));
    if (SK.regions(sk).every(r => used.has(r))) sk.hidden = true;
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
    if (p.mode === undefined) { p.mode = faceObj ? 'join' : 'new'; if (faceObj != null) p._auto = p.mode; }
  }
  p.mode ??= 'new';
  p._id ??= S.doc.nextId;
}
const touchFeature = p => (p.mode !== 'new' && p.target != null ? { ids: [p.target], mesh: true } : { ids: [] });
const targetLabel = p => { const t = p.mode !== 'new' && objById(p.target); return t ? (p.mode === 'cut' ? ` ⊖ ${t.name}` : p.mode === 'intersect' ? ` ∩ ${t.name}` : ` → ${t.name}`) : ''; };
const modeName = (base, p) => (p.mode === 'cut' ? `${base} cut` : base);

export const extrude = {
  label: p => `${modeName('Extrude', p)}${targetLabel(p)}`,
  // starts at 0 like Plasticity: nothing is built until you drag the arrow or type a distance
  defaults: () => ({ distance: 0, symmetric: false, flip: false }),
  isEmpty: p => Math.abs(p.distance) < 1e-9,
  prepare: prepFeature,
  touch: touchFeature,
  fields: () => [lenF('distance', 'Distance'), { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }, { key: 'symmetric', label: 'Symmetric', kind: 'bool' }, { key: 'flip', label: 'Flip', kind: 'bool' }],
  apply(p, op) {
    // on a face, pulling out joins and pushing in cuts — until the user picks an operation
    if (p._auto && p.mode !== p._auto) p._auto = null;
    if (p._auto) p.mode = p._auto = p.distance < 0 ? 'cut' : 'join';
    const auto = !!p._auto;
    const groups = profileGroups(p.pts);
    if (!groups.length) return 'Profiles no longer exist';
    const g0 = groups[0], s0 = (p.flip ? -1 : 1) * (!auto && g0.sk.face && (p.mode === 'cut' || p.mode === 'intersect') ? -1 : 1);
    const anchor = regionsCentroid(g0), dirW = M.mul(g0.sk.plane.n, s0);
    if (Math.abs(p.distance) < 1e-9) { op.handle = { origin: anchor, dir: dirW, key: 'distance' }; return; }
    const tool = guard(() => {
      const solids = [];
      for (const g of groups) {
        const s = (p.flip ? -1 : 1) * (!auto && g.sk.face && (p.mode === 'cut' || p.mode === 'intersect') ? -1 : 1);
        const [h0, h1] = p.symmetric ? [-p.distance / 2, p.distance / 2] : [0, p.distance * s];
        const n = g.sk.plane.n;
        for (const f of groupFaces(g)) solids.push(K.prism(h0 ? K.translated(f, M.mul(n, h0)) : f, M.mul(n, h1 - h0)));
      }
      if (!solids.length) throw new Error('no region');
      return K.fuseAll(solids);
    }, 'Could not extrude this profile');
    if (typeof tool === 'string') return tool;
    const err = applyBody(p, tool, 'Body');
    if (err) return err;
    if (!p.symmetric) op.handle = { origin: anchor, dir: dirW, key: 'distance' };
  },
};

export const revolve = {
  label: p => `${modeName('Revolve', p)}${targetLabel(p)}`,
  defaults: () => ({ angle: 360 }),
  prepare(p) {
    const e = prepFeature(p); if (e) return e;
    const sk = SK.sketchById(p.pts[0].sk);
    const lines = sk ? sk.ents.filter(x => x.t === 'line').sort((a, b) => (b.construction ? 1 : 0) - (a.construction ? 1 : 0)).slice(0, 8) : [];
    p._lines = lines.map((l, i) => ({ v: 'l:' + l.id, label: `${l.construction ? 'Constr.' : 'Line'} ${i + 1}` }));
    p.axis ??= lines.find(l => l.construction) ? 'l:' + lines.find(l => l.construction).id : 'y';
  },
  touch: touchFeature,
  fields: p => [{ key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'Sketch X'], ['y', 'Sketch Y'], ...(p._lines || []).map(l => [l.v, l.label])], wide: true }, { key: 'angle', label: 'Angle', kind: 'ang' }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
  apply(p) {
    if (Math.abs(p.angle) < 1e-6) return 'Angle must not be zero';
    const groups = profileGroups(p.pts);
    if (!groups.length) return 'Profiles no longer exist';
    const axisOf = sk => {
      if (p.axis === 'x') return { p: [0, 0], d: [1, 0] };
      if (p.axis === 'y') return { p: [0, 0], d: [0, 1] };
      const l = SK.entById(sk, +String(p.axis).slice(2)); if (!l || l.t !== 'line') return null;
      const L = SK.d2(l.a, l.b); return L > 1e-12 ? { p: l.a, d: [(l.b[0] - l.a[0]) / L, (l.b[1] - l.a[1]) / L] } : null;
    };
    for (const g of groups) {
      const ax = axisOf(g.sk); if (!ax) return 'Axis line missing';
      for (const r of g.regs) {
        const vals = r.outer.map(q => (q[0] - ax.p[0]) * -ax.d[1] + (q[1] - ax.p[1]) * ax.d[0]);
        if (Math.min(...vals) < -1e-9 && Math.max(...vals) > 1e-9) return 'Profile crosses the revolve axis — pick another axis';
      }
    }
    const tool = guard(() => {
      const solids = [];
      for (const g of groups) {
        const ax = axisOf(g.sk), pl = g.sk.plane;
        const c = SK.toW(pl, ax.p), d = M.add(M.mul(pl.u, ax.d[0]), M.mul(pl.v, ax.d[1]));
        for (const f of groupFaces(g)) solids.push(K.revolve(f, c, d, p.angle));
      }
      return K.fuseAll(solids);
    }, 'Could not revolve this profile');
    if (typeof tool === 'string') return tool;
    return applyBody(p, tool, 'Revolve');
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
    const objs = tools.map(objById).filter(Boolean);
    if (t.shape && objs.every(o => o.shape)) {
      const res = guard(() => { let s = t.shape; for (const o of objs) s = K.boolean(p.kind, s, K.toLocal(K.worldShape(o), t)); return s; }, 'Boolean failed');
      if (typeof res === 'string') return res;
      if (K.isEmpty(res)) return 'Result is empty';
      K.setShape(t, res);
    } else if (!t.shape && objs.every(o => !o.shape)) { // imported meshes: mesh CSG
      let polys = toPolys(worldVerts(t), t.mesh.f);
      for (const o of objs) polys = boolean(p.kind, polys, toPolys(worldVerts(o), o.mesh.f));
      const res = polysToMesh(polys);
      if (!res.f.length) return 'Result is empty';
      const xf = xfFor(t); t.mesh = res; t.mesh.v = res.v.map(xf.toL);
    } else return 'Solids and imported meshes cannot be combined';
    if (!p.keep) S.doc.objects = S.doc.objects.filter(o => !tools.includes(o.id));
    S.ed.selected = new Set([t.id]); S.ed.active = t.id;
  },
};

// ---------- fillet / chamfer: true rolling-ball blends ----------
// edge picks: { obj, p (world point on the edge), a, b, len, type } — re-found on every rebuild
function findEdges(o, list) {
  const xf = xfFor(o), out = [];
  for (const e of list) {
    const p = e.p || M.mul(M.add(e.a, e.b), 0.5);
    const hit = K.edgeAt(o.shape, { p: xf.toL(p), len: e.len, type: e.type });
    if (!hit) return null;
    const pts = hit.info.pts, mid = K.polyMid(pts);
    Object.assign(e, { p: xf.toW(mid), a: xf.toW(pts[0]), b: xf.toW(pts[pts.length - 1]), len: hit.info.len, type: hit.info.type });
    out.push(hit.edge);
  }
  return out;
}
export const edgeBlendOp = {
  label: p => (p.kind === 'fillet' ? 'Fillet' : 'Chamfer') + ` · ${p.edges.length} edge${p.edges.length === 1 ? '' : 's'}`,
  defaults: () => ({ kind: 'fillet', size: defSize() / 10 }),
  prepare(p) {
    p.edges ??= JSON.parse(JSON.stringify((S.ed.edges || []).map(({ pts, circle, ...r }) => r))); // a point on each edge is enough to find it again
    if (!p.edges.length) return 'Pick body edges first (Edge mode)';
    p._objs = [...new Set(p.edges.map(e => e.obj))];
  },
  touch: p => ({ ids: p._objs, mesh: true }),
  fields: p => [lenF('size', p.kind === 'fillet' ? 'Radius' : 'Distance 1'), ...(p.kind === 'chamfer' ? [lenF('size2', 'Distance 2'), { key: 'swap', label: 'Swap sides', kind: 'bool' }] : []), { key: 'kind', label: 'Type', kind: 'choice', options: [['fillet', 'Fillet'], ['chamfer', 'Chamfer']], wide: true }],
  apply(p, op) {
    if (!(p.size > 0)) return 'Size must be > 0';
    if (p.size2 == null || p.size2 === p._size1) p.size2 = p.size; // Distance 2 follows Distance 1 until edited
    p._size1 = p.size;
    if (p.kind === 'chamfer' && !(p.size2 > 0)) return 'Distance 2 must be > 0';
    for (const id of p._objs) {
      const o = objById(id), e0 = solidOnly(o); if (e0) return e0;
      const edges = findEdges(o, p.edges.filter(x => x.obj === id));
      if (!edges) return 'The edge it rounded no longer exists';
      const res = guard(() => {
        const occ = K.getOC();
        let b;
        if (p.kind === 'fillet') {
          b = new occ.BRepFilletAPI_MakeFillet(o.shape.wrapped, occ.ChFi3d_FilletShape.ChFi3d_Rational);
          for (const e of edges) b.Add(p.size, e.wrapped);
        } else {
          b = new occ.BRepFilletAPI_MakeChamfer(o.shape.wrapped);
          for (const e of edges) {
            if (Math.abs(p.size2 - p.size) < 1e-12) b.Add(p.size, e.wrapped);
            else { const fs = o.shape.faces.filter(f => f.edges.some(x => x.isSame(e))); const f = fs[p.swap ? 1 : 0] || fs[0]; b.Add(p.size, p.size2, e.wrapped, f.wrapped); }
          }
        }
        const pr = new occ.Message_ProgressRange(); b.Build(pr); pr.delete();
        if (!b.IsDone()) { b.delete(); throw new Error('size too large'); }
        const s = R.cast(b.Shape()); b.delete();
        return s;
      }, `${p.kind === 'fillet' ? 'Radius' : 'Distance'} ${fmtLen(p.size)} does not fit ${p.edges.length === 1 ? 'this edge' : 'these edges'}`);
      if (typeof res === 'string') return res;
      if (K.isEmpty(res)) return 'Result is empty';
      // the drag handle: from the first edge, into the corner
      if (id === p._objs[0]) {
        const e = p.edges.find(x => x.obj === id), xf = xfFor(o), mid = xf.toL(e.p);
        const ns = o.shape.faces.filter(f => f.edges.some(x => x.isSame(edges[0]))).map(f => { try { return vec3(f.normalAt(mid)); } catch (err) { return null; } }).filter(Boolean);
        if (ns.length === 2) { const d = M.norm(M.add(ns[0], ns[1])); if (M.len(d) > 0.5) op.handle = { origin: e.p, dir: M.mul(locDir(xf, mid, d), -1), key: 'size', min: 1e-6 }; }
      }
      K.setShape(o, res);
    }
    S.ed.edges = [];
  },
};

// ---------- face modifiers ----------
// face picks: { obj, n, w, p } — a point on the face and its normal (world), re-found every rebuild
function findFaces(o, list) {
  const xf = xfFor(o), out = [];
  for (const f of list) {
    const pl = xf.toL(f.p), nl = locDir(xf, f.p, f.n);
    const hit = K.faceAt(o.shape, pl, nl);
    if (!hit) return null;
    if (hit.q) { const pw = xf.toW(hit.q); Object.assign(f, { p: pw, w: M.dot(f.n, pw) }); } // follow the moved face
    out.push(hit.f);
  }
  return out;
}
export const pushPullOp = {
  label: () => 'Push/Pull',
  defaults: () => ({ dist: 0 }),
  isEmpty: p => Math.abs(p.dist) < 1e-9,
  prepare(p) { p.faces ??= JSON.parse(JSON.stringify(S.ed.faces || [])); if (!p.faces.length) return 'Select a face (Face mode)'; p._objs = [...new Set(p.faces.map(f => f.obj))]; },
  touch: p => ({ ids: p._objs, mesh: true }),
  fields: () => [lenF('dist', 'Distance')],
  apply(p, op) {
    const f0 = p.faces[0];
    if (Math.abs(p.dist) < 1e-9) { op.handle = { origin: f0.p, dir: f0.n, key: 'dist' }; return; }
    for (const id of p._objs) {
      const o = objById(id), e0 = solidOnly(o); if (e0) return e0;
      const list = p.faces.filter(f => f.obj === id), faces = findFaces(o, list);
      if (!faces) return 'The face it used no longer exists';
      const xf = xfFor(o);
      const res = guard(() => {
        let s = o.shape;
        faces.forEach((f, k) => {
          if (f.geomType !== 'PLANE') throw new Error('only flat faces');
          const n = locDir(xf, list[k].p, list[k].n);
          const tool = K.prism(f, M.mul(n, p.dist));
          s = p.dist > 0 ? s.fuse(tool) : s.cut(tool);
        });
        return s;
      }, 'Push/Pull works on flat faces');
      if (typeof res === 'string') return res;
      K.setShape(o, res);
    }
    // keep the selection on the moved faces
    S.ed.faces = p.faces.map(f => ({ ...f, w: f.w + p.dist, p: M.add(f.p, M.mul(f.n, p.dist)) }));
    op.handle = { origin: f0.p, dir: f0.n, key: 'dist' };
  },
};
export const shellOp = {
  label: () => 'Shell',
  defaults: () => ({ t: defSize() / 20 }),
  prepare(p) {
    p.faces ??= JSON.parse(JSON.stringify(S.ed.faces || []));
    p.obj ??= p.faces[0]?.obj ?? selectedObjs()[0]?.id;
    if (p.obj == null) return 'Select a body, or the faces to open';
    p.faces = p.faces.filter(f => f.obj === p.obj);
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: () => [lenF('t', 'Thickness')],
  apply(p, op) {
    if (!(p.t > 0)) return 'Thickness must be > 0';
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const faces = findFaces(o, p.faces); if (!faces) return 'The face it opened no longer exists';
    const bb = o.shape.boundingBox.bounds, minDim = Math.min(...[0, 1, 2].map(k => bb[1][k] - bb[0][k]));
    const res = guard(() => o.shape.clone().shell({ thickness: p.t, filter: { find: () => faces, delete() {} } }), p.t * 2 >= minDim ? 'The wall is too thick for this body' : 'Shell failed near rounded edges — try a thinner wall, or shell before filleting');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    K.setShape(o, res);
    S.ed.faces = [];
    if (p.faces.length) op.handle = { origin: p.faces[0].p, dir: M.mul(p.faces[0].n, -1), key: 't', min: 1e-6 };
  },
};
const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const mirrorOp = {
  label: () => 'Mirror',
  defaults: () => ({ plane: 'x', fuse: true }),
  prepare(p) {
    p.obj ??= S.ed.faces[0]?.obj ?? selectedObjs()[0]?.id;
    if (p.obj == null) return 'Select a body';
    if (S.ed.faces.length && !p.face) { p.face = JSON.parse(JSON.stringify(S.ed.faces[0])); p.plane = 'face'; }
    p._id ??= S.doc.nextId;
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [{ key: 'plane', label: 'Mirror plane', kind: 'choice', options: [['x', 'YZ'], ['y', 'XZ'], ['z', 'XY'], ...(p.face ? [['face', 'Face']] : [])], wide: true }, { key: 'fuse', label: 'Union with original', kind: 'bool' }],
  apply(p) {
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const [n, c] = p.plane === 'face' && p.face ? [p.face.n, p.face.p] : [AX[p.plane], [0, 0, 0]];
    const res = guard(() => { const w = K.worldShape(o), m = w.clone().mirror(n, c); return p.fuse ? K.toLocal(w.fuse(m), o) : m; }, 'Mirror failed');
    if (typeof res === 'string') return res;
    if (p.fuse) K.setShape(o, res);
    else {
      const q = newObject(o.name, null, [0, 0, 0], p._id); q.color = o.color; K.setShape(q, res);
      S.doc.objects.push(q); S.ed.selected = new Set([q.id]); S.ed.active = q.id;
    }
    S.ed.faces = [];
  },
};
import { faceRegion } from './modifiers.js';
export { faceRegion };

// ---------- body pattern (polar) and slice ----------
import { slice as sliceMesh, rotateMesh, thicken } from './modifiers.js';
export const polarPattern = {
  label: () => 'Polar Pattern',
  defaults: () => ({ count: 6, angle: 360, axis: 'z', cx: 0, cy: 0, cz: 0 }),
  prepare(p) { if (!S.ed.selected.size) return 'Select a body'; p.ids ??= [...S.ed.selected]; p._base ??= S.doc.nextId; },
  touch: () => ({ ids: [] }),
  fields: () => [{ key: 'count', label: 'Count', kind: 'int', min: 2, max: 360 }, { key: 'angle', label: 'Total angle', kind: 'ang' }, { key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], wide: true }, lenF('cx', 'Centre X'), lenF('cy', 'Centre Y'), lenF('cz', 'Centre Z')],
  apply(p) {
    const n = Math.max(2, Math.min(360, Math.round(p.count)));
    const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9, step = full ? p.angle / n : p.angle / (n - 1);
    const a = AX[p.axis], c = [p.cx, p.cy, p.cz];
    let id = p._base; const made = [...p.ids];
    for (let k = 1; k < n; k++) for (const oid of p.ids) {
      const o = objById(oid); if (!o) continue;
      let q;
      if (o.shape) { const s = guard(() => K.rotated(K.worldShape(o), step * k, c, a), 'Pattern failed'); if (typeof s === 'string') return s; q = newObject(o.name, null, [0, 0, 0], id++); K.setShape(q, s); }
      else { const W = rotateMesh(worldVerts(o), c, a, step * k), anchor = M.centroid(W); q = newObject(o.name, new M.PolyMesh(W.map(w => M.sub(w, anchor)), o.mesh.f.map(f => f.slice())), anchor, id++); }
      q.color = o.color; S.doc.objects.push(q); made.push(q.id);
    }
    S.ed.selected = new Set(made);
  },
};
export const sliceOp = {
  label: () => 'Slice',
  defaults: () => ({ plane: 'z' }),
  prepare(p) {
    p.obj ??= S.ed.faces[0]?.obj ?? selectedObjs()[0]?.id;
    if (p.obj == null) return 'Select a body';
    if (S.ed.faces.length && !p.face) { p.face = JSON.parse(JSON.stringify(S.ed.faces[0])); p.plane = 'face'; p.offset ??= -1; }
    if (p.offset == null) { // default: through the middle of the body
      const W = worldVerts(objById(p.obj)), k = 'xyz'.indexOf(p.plane), lo = Math.min(...W.map(q => q[k])), hi = Math.max(...W.map(q => q[k]));
      const st = S.settings.snapStep; p.offset = Math.round((lo + hi) / 2 / st) * st;
    }
    p._id ??= S.doc.nextId;
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [{ key: 'plane', label: 'Plane', kind: 'choice', options: [['x', 'YZ'], ['y', 'XZ'], ['z', 'XY'], ...(p.face ? [['face', 'Face']] : [])], wide: true }, lenF('offset', p.plane === 'face' ? 'Offset from face' : 'Position')],
  apply(p) {
    const o = objById(p.obj); if (!o) return 'Body missing';
    let n, origin;
    if (p.plane === 'face' && p.face) { n = p.face.n; origin = M.add(p.face.p, M.mul(n, p.offset)); }
    else { n = AX[p.plane]; origin = M.mul(n, p.offset); }
    if (o.shape) {
      const res = guard(() => {
        const w = K.worldShape(o), x = Math.abs(n[2]) < 0.9 ? M.norm(M.cross([0, 0, 1], n)) : [1, 0, 0];
        const parts = w.clone().split(new R.Plane(origin, x, n), 0);
        return parts;
      }, 'Slice failed');
      if (typeof res === 'string') return res;
      if (!res.positive || !res.negative) return 'The plane does not cut this body';
      K.setShape(o, K.toLocal(res.negative, o));
      const q = newObject(o.name, null, [0, 0, 0], p._id); q.color = o.color; K.setShape(q, res.positive);
      S.doc.objects.push(q); S.ed.selected = new Set([o.id, q.id]); S.ed.active = q.id; S.ed.faces = [];
      return;
    }
    const { pos, neg } = sliceMesh(worldVerts(o), o.mesh.f, n, M.dot(n, origin));
    if (!pos.f.length || !neg.f.length) return 'The plane does not cut this body';
    const xf = xfFor(o);
    o.mesh = new M.PolyMesh(neg.v.map(xf.toL), neg.f);
    const anchor = M.centroid(pos.v);
    const q = newObject(o.name, new M.PolyMesh(pos.v.map(v => M.sub(v, anchor)), pos.f), anchor, p._id);
    q.color = o.color; S.doc.objects.push(q);
    S.ed.selected = new Set([o.id, q.id]); S.ed.active = q.id; S.ed.faces = [];
  },
};

export const thickenOp = {
  label: () => 'Thicken',
  defaults: () => ({ t: defSize() / 10 }),
  prepare(p) { p.obj ??= S.ed.faces[0]?.obj ?? selectedObjs()[0]?.id; if (p.obj == null) return 'Select a surface (e.g. an added Plane)'; },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: () => [lenF('t', 'Thickness')],
  apply(p) {
    const o = objById(p.obj); if (!o) return 'Body missing';
    if (o.shape) return 'Thicken works on surfaces (an added Plane), not on solids';
    const r = thicken(worldVerts(o), o.mesh.f, p.t); if (typeof r === 'string') return r;
    const xf = xfFor(o); o.mesh = new M.PolyMesh(r.v.map(xf.toL), r.f);
  },
};

// ---------- LOFT and SWEEP ----------
import { sketchPath } from './sweep.js';
export const loftOp = {
  label: p => `Loft${targetLabel(p)}`,
  defaults: () => ({ ruled: false }),
  prepare(p) {
    p.pts ??= JSON.parse(JSON.stringify(S.ed.profiles));
    if (p.pts.length < 2) return 'Select 2 or more profiles (multi-select on), in loft order';
    p.mode ??= 'new'; p.target ??= selectedObjs()[0]?.id ?? null; p._id ??= S.doc.nextId;
  },
  touch: touchFeature,
  fields: () => [{ key: 'ruled', label: 'Straight sections', kind: 'bool' }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
  apply(p) {
    const wires = [];
    for (const it of p.pts) { const sk = SK.sketchById(it.sk), f = sk && K.regionFace(sk, it.pt); if (!f) return 'A profile no longer exists'; wires.push(f.outerWire()); }
    const tool = guard(() => R.loft(wires, { ruled: !!p.ruled }), 'Loft failed — check the profiles face the same way');
    if (typeof tool === 'string') return tool;
    return applyBody(p, tool, 'Loft');
  },
};
// path sketch → spine wire: exact lines/arcs where possible
function pathWire(ps, near) {
  const pts = sketchPath(ps, near); if (!pts || pts.length < 2) return null;
  const allLines = ps.ents.filter(e => !e.construction && e.t !== 'dim').every(e => e.t === 'line');
  const W = q => SK.toW(ps.plane, q);
  const P = pts.map(q => (q.length === 3 ? q : W(q)));
  if (allLines) { const es = []; for (let i = 1; i < P.length; i++) if (M.dist(P[i - 1], P[i]) > 1e-9) es.push(R.makeLine(P[i - 1], P[i])); return R.assembleWire(es); }
  return R.assembleWire([R.makeBSplineApproximation(P, { tolerance: 1e-4, degMax: 3, degMin: 3 })]);
}
export const sweepOp = {
  label: p => `Sweep${targetLabel(p)}`,
  prepare(p) {
    p.pts ??= JSON.parse(JSON.stringify(S.ed.profiles.slice(0, 1)));
    if (!p.pts.length) return 'Select the profile to sweep';
    const prof = SK.sketchById(p.pts[0].sk);
    const others = (S.doc.sketches || []).filter(s => s.id !== prof.id && sketchPath(s));
    if (!others.length) return 'Draw the path (lines / arcs / spline) in another sketch first';
    p._paths = others.map(s => [s.id, s.name]);
    p.path ??= others[others.length - 1].id;
    p.mode ??= 'new'; p.target ??= selectedObjs()[0]?.id ?? null; p._id ??= S.doc.nextId;
  },
  touch: touchFeature,
  fields: p => [{ key: 'path', label: 'Path sketch', kind: 'choice', options: p._paths || [], wide: true }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
  apply(p) {
    const sk = SK.sketchById(p.pts[0].sk), f = sk && K.regionFace(sk, p.pts[0].pt);
    if (!f) return 'Profile no longer exists';
    const ps = SK.sketchById(p.path); if (!ps) return 'Path sketch missing';
    const tool = guard(() => {
      const fc = typeof f.center === 'function' ? f.center() : f.center, c = vec3(fc), spine = pathWire(ps, c); if (!spine) throw new Error('no open path');
      return R.genericSweep(f.outerWire(), spine, { frenet: true, transitionMode: 'round' });
    }, 'Sweep failed — the profile should sit at the start of the path');
    if (typeof tool === 'string') return tool;
    return applyBody(p, tool, 'Sweep');
  },
};

export const draftOp = {
  label: () => 'Draft',
  defaults: () => ({ angle: 3, pull: 'z' }),
  prepare(p) {
    p.faces ??= JSON.parse(JSON.stringify(S.ed.faces || []));
    if (!p.faces.length) return 'Select the side faces to draft (Face mode)';
    p.obj = p.faces[0].obj; p.faces = p.faces.filter(f => f.obj === p.obj);
    if (p.neutral == null) { const W = worldVerts(objById(p.obj)), k = 'xyz'.indexOf(p.pull); p.neutral = Math.min(...W.map(q => q[k])); }
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: () => [{ key: 'angle', label: 'Draft angle', kind: 'ang' }, { key: 'pull', label: 'Pull direction', kind: 'choice', options: [['x', '+X'], ['y', '+Y'], ['z', '+Z']], wide: true }, lenF('neutral', 'Neutral plane')],
  apply(p) {
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const faces = findFaces(o, p.faces); if (!faces) return 'The face it used no longer exists';
    const d = AX[p.pull], x = Math.abs(d[2]) < 0.9 ? M.norm(M.cross([0, 0, 1], d)) : [1, 0, 0];
    const res = guard(() => o.shape.draft(p.angle, () => ({ find: () => faces, delete() {} }), new R.Plane(M.mul(d, p.neutral), x, d)), 'Draft failed');
    if (typeof res === 'string') return res;
    K.setShape(o, res); S.ed.faces = [];
  },
};

// ---------- fasteners: thread and hole ----------
// ISO metric coarse pitches by nominal diameter
const ISO_PITCH = [[1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5], [20, 2.5], [24, 3], [30, 3.5], [36, 4], [42, 4.5], [48, 5]];
const isoPitch = d => ISO_PITCH.reduce((b, x) => (Math.abs(x[0] - d) < Math.abs(b[0] - d) ? x : b))[1];
const fmtD = v => +v.toFixed(2);
// Thread: a true helical thread on a cylindrical face — external (shaft) or internal (hole), detected from the face
export const threadOp = {
  label: p => `Thread ${p._internal ? 'internal ' : ''}M${fmtD(p._d || 0)}×${fmtD(p.pitch || 0)}`,
  prepare(p) {
    p.faces ??= JSON.parse(JSON.stringify((S.ed.faces || []).slice(0, 1)));
    if (!p.faces.length) return 'Select a cylindrical face (Face mode), e.g. a shaft or a hole';
    p.obj = p.faces[0].obj;
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const f = findFaces(o, p.faces)?.[0], cy = f && K.cylinderOf(f);
    if (!cy) return 'Pick a cylindrical face (a shaft or a round hole)';
    const xf = xfFor(o), pl = xf.toL(p.faces[0].p), radial = M.sub(pl, M.add(cy.c, M.mul(cy.d, M.dot(M.sub(pl, cy.c), cy.d))));
    p._internal = M.dot(M.norm(radial), locDir(xf, p.faces[0].p, p.faces[0].n)) < 0;
    p._d = 2 * cy.R; p.pitch ??= isoPitch(p._d); p.length ??= +(cy.t1 - cy.t0).toFixed(6); p.fromEnd ??= true; p.left ??= false;
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: () => [lenF('pitch', 'Pitch'), lenF('length', 'Length'), { key: 'fromEnd', label: 'Start from', kind: 'choice', options: [[true, 'Far end'], [false, 'Near end']], wide: true }, { key: 'left', label: 'Left-hand', kind: 'bool' }],
  apply(p) {
    if (!(p.pitch > 0.05)) return 'Pitch must be at least 0.05 mm';
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const f = findFaces(o, p.faces)?.[0], cy = f && K.cylinderOf(f);
    if (!cy) return 'The cylindrical face it used no longer exists';
    const span = cy.t1 - cy.t0, L = Math.min(Math.max(p.length, p.pitch * 2), span);
    if (L < p.pitch * 2) return 'The face is too short for this pitch';
    const P = p.pitch, R0 = cy.R, internal = p._internal;
    if (!internal && P * 0.62 >= R0 * 0.8) return 'Pitch too coarse for this diameter';
    // thread zone along the axis
    const ta = p.fromEnd ? cy.t1 - L : cy.t0, tb = ta + L;
    const res = guard(() => {
      const tan30 = Math.tan(Math.PI / 6);
      if (!internal) {
        const H = 0.6134 * P, rc = R0 - H, flat = P / 16;
        // remove the thread zone down to the minor diameter, then add the helical ridge
        const u = M.norm(Math.abs(cy.d[2]) < 0.9 ? M.cross(cy.d, [0, 0, 1]) : M.cross(cy.d, [1, 0, 0]));
        const ring = K.revolveProfile(cy.c, cy.d, u, [[rc, ta], [R0 + 1, ta], [R0 + 1, tb], [rc, tb]]);
        let s = o.shape.cut(ring);
        const w = flat + (H + 0.25) * tan30;
        const ridge = K.threadRidge(M.add(cy.c, M.mul(cy.d, ta + w + 0.01)), cy.d, rc, P, L - 2 * w - 0.02, [[rc - 0.25, -w], [R0, -flat], [R0, flat], [rc - 0.25, w]], !!p.left);
        return s.fuse(ridge);
      }
      const H = 0.5413 * P, rmin = R0 - H, flat = P / 8;
      const w = flat + (H + 0.25) * tan30;
      const ridge = K.threadRidge(M.add(cy.c, M.mul(cy.d, ta + w + 0.01)), cy.d, R0, P, L - 2 * w - 0.02, [[R0 + 0.25, -w], [rmin, -flat], [rmin, flat], [R0 + 0.25, w]], !!p.left);
      return o.shape.fuse(ridge);
    }, 'Could not cut this thread');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    K.setShape(o, res); S.ed.faces = [];
  },
};

// Hole: simple, counterbore or countersink, drilled into a flat face at the picked point
export const holeOp = {
  label: p => `Hole Ø${fmtD(p.dia)}${p.kind === 'cbore' ? ' counterbore' : p.kind === 'csink' ? ' countersink' : ''}`,
  defaults: () => ({ dia: 5, depth: 0, kind: 'simple', cbDia: 9, cbDepth: 5, csDia: 10, csAngle: 90 }),
  prepare(p) {
    p.faces ??= JSON.parse(JSON.stringify((S.ed.faces || []).slice(0, 1)));
    if (!p.faces.length) return 'Tap a flat face where the hole goes (Face mode)';
    if (p.faces[0].planar === false) return 'Holes go into flat faces';
    p.obj = p.faces[0].obj;
    const e0 = solidOnly(objById(p.obj)); if (e0) return e0;
    // the hole centre: the tapped point, rounded to the snap step in the face's plane
    const f = p.faces[0], st = S.settings.snap ? S.settings.snapStep : 0;
    if (p.x == null) { const q = st ? f.p.map(v => Math.round(v / st) * st) : f.p.slice(); const c = M.add(q, M.mul(f.n, f.w - M.dot(f.n, q))); [p.x, p.y, p.z] = c.map(v => +v.toFixed(6)); }
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [lenF('dia', 'Diameter'), lenF('depth', 'Depth (0 = through)'), { key: 'kind', label: 'Type', kind: 'choice', options: [['simple', 'Simple'], ['cbore', 'Counterbore'], ['csink', 'Countersink']], wide: true },
    ...(p.kind === 'cbore' ? [lenF('cbDia', 'Counterbore Ø'), lenF('cbDepth', 'Counterbore depth')] : p.kind === 'csink' ? [lenF('csDia', 'Countersink Ø'), { key: 'csAngle', label: 'Countersink angle', kind: 'ang' }] : []),
    lenF('x', 'Centre X'), lenF('y', 'Centre Y'), lenF('z', 'Centre Z')],
  apply(p) {
    if (!(p.dia > 0)) return 'Diameter must be > 0';
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const f = findFaces(o, p.faces)?.[0]; if (!f) return 'The face it was drilled into no longer exists';
    const xf = xfFor(o), n = M.mul(locDir(xf, p.faces[0].p, p.faces[0].n), -1); // drill into the body
    const c = xf.toL([p.x, p.y, p.z]), u = M.norm(Math.abs(n[2]) < 0.9 ? M.cross(n, [0, 0, 1]) : M.cross(n, [1, 0, 0]));
    const bb = o.shape.boundingBox.bounds, through = Math.hypot(...[0, 1, 2].map(k => bb[1][k] - bb[0][k])) * 2 + 10;
    const D = p.depth > 0 ? p.depth : through, r = p.dia / 2;
    const prof = [[0, -0.01]];
    if (p.kind === 'cbore') { if (!(p.cbDia > p.dia)) return 'Counterbore Ø must be larger than the hole'; prof.push([p.cbDia / 2, -0.01], [p.cbDia / 2, p.cbDepth], [r, p.cbDepth]); }
    else if (p.kind === 'csink') { if (!(p.csDia > p.dia)) return 'Countersink Ø must be larger than the hole'; const h = (p.csDia / 2 - r) / Math.tan((p.csAngle / 2) * Math.PI / 180); prof.push([p.csDia / 2 + 0.01, -0.01], [r, h]); }
    else prof.push([r, -0.01]);
    prof.push([r, D], [0, D]);
    const res = guard(() => o.shape.cut(K.revolveProfile(c, n, u, prof)), 'Could not drill this hole');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    K.setShape(o, res); S.ed.faces = [];
  },
};

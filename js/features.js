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
  // the sketch is consumed by the feature: hide it (show it again from the Browser to edit)
  for (const id of new Set((p.pts || []).map(it => it.sk))) {
    const sk = SK.sketchById(id); if (!sk || S.settings.hideConsumed === false) continue;
    const used = new Set(p.pts.filter(it => it.sk === id).map(it => SK.regionAt(sk, it.pt)).filter(Boolean));
    if (SK.regions(sk).every(r => used.has(r))) sk.hidden = true; // other closed shapes in it stay visible for later features
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
  defaults: () => ({ distance: defSize() / 2, symmetric: false, flip: false }),
  prepare: prepFeature,
  touch: touchFeature,
  fields: () => [lenF('distance', 'Distance'), { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }, { key: 'symmetric', label: 'Symmetric', kind: 'bool' }, { key: 'flip', label: 'Flip', kind: 'bool' }],
  apply(p, op) {
    if (Math.abs(p.distance) < 1e-9) return 'Distance must not be zero';
    // Plasticity-style: on a face, pulling out joins and pushing in cuts — until the user picks an operation
    if (p._auto && p.mode !== p._auto) p._auto = null;
    if (p._auto) p.mode = p._auto = p.distance < 0 ? 'cut' : 'join';
    const auto = !!p._auto;
    const groups = profileGroups(p.pts);
    if (!groups.length) return 'Profiles no longer exist';
    const meshes = [];
    let dirW = null, anchor = null;
    for (const g of groups) {
      const into = auto ? 1 : g.sk.face && (p.mode === 'cut' || p.mode === 'intersect') ? -1 : 1;
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
  label: p => `${modeName('Revolve', p)}${targetLabel(p)}`,
  defaults: () => ({ angle: 360, segs: S.settings.curveSegs || 64 }),
  prepare(p) {
    const e = prepFeature(p); if (e) return e;
    const sk = SK.sketchById(p.pts[0].sk);
    const lines = sk ? sk.ents.filter(x => x.t === 'line').sort((a, b) => (b.construction ? 1 : 0) - (a.construction ? 1 : 0)).slice(0, 8) : [];
    p._lines = lines.map((l, i) => ({ v: 'l:' + l.id, label: `${l.construction ? 'Constr.' : 'Line'} ${i + 1}` }));
    p.axis ??= lines.find(l => l.construction) ? 'l:' + lines.find(l => l.construction).id : 'y';
  },
  touch: touchFeature,
  fields: p => [{ key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'Sketch X'], ['y', 'Sketch Y'], ...(p._lines || []).map(l => [l.v, l.label])], wide: true }, { key: 'angle', label: 'Angle', kind: 'ang' }, { key: 'segs', label: 'Segments', kind: 'int', min: 3, max: 512 }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
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
        if (Math.min(...vals) < -1e-9 && Math.max(...vals) > 1e-9) return 'Profile crosses the revolve axis';
      }
    }
    const meshes = groups.map(g => revolveRegions(g.regs, g.sk.plane, p.axis === 'x' || p.axis === 'y' ? p.axis : axisOf(g.sk), p.angle, p.segs));
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
import { edgeBlend, edgeFrame, circleBlend, sphereCorner, featureEdges, straightRun, edgeLoop } from './edges.js';
function refindEdge(e, W, faces) {
  const fr0 = edgeFrame(W, faces, e.circle ? e.circle.loop[0] : e.a, e.circle ? e.circle.loop[1] : e.b);
  if (typeof fr0 !== 'string') { if (!e.circle) e._w = [fr0.w1, fr0.w2]; return; } // remember which way its two faces run
  const fe = featureEdges(W, faces);
  let best = null;
  if (e.circle) {
    const seen = new Set();
    for (const s of fe) {
      const c = edgeLoop(W, fe, s.a, s.b); if (!c) continue;
      const key = c.c.map(v => v.toFixed(5)).join(); if (seen.has(key)) continue; seen.add(key);
      if (Math.abs(c.R - e.circle.R) > 1e-6 || Math.abs(Math.abs(M.dot(c.n, e.circle.n)) - 1) > 1e-9) continue;
      const d = M.dist(c.c, e.circle.c);
      if (!best || d < best.d) best = { d, circle: c };
    }
    if (best) { e.circle = best.circle; e.a = best.circle.loop[0]; e.b = best.circle.loop[1]; }
    return;
  }
  const dir = M.norm(M.sub(e.b, e.a)), L = M.dist(e.a, e.b), mid = M.mul(M.add(e.a, e.b), 0.5);
  const seen = new Set();
  for (const s of fe) {
    const d0 = M.norm(M.sub(W[s.b], W[s.a]));
    if (Math.abs(Math.abs(M.dot(d0, dir)) - 1) > 1e-9) continue;
    const [A, B] = straightRun(W, fe, s.a, s.b);
    const key = [A, B].map(q => q.map(v => v.toFixed(6)).join()).sort().join('|'); if (seen.has(key)) continue; seen.add(key);
    // same pair of faces (directions into them), nearest; the edge may have moved or changed length
    if (e._w) {
      const fr = edgeFrame(W, faces, A, B); if (typeof fr === 'string') continue;
      const same = (x, y) => M.dot(x, y) > 1 - 1e-6;
      if (!((same(fr.w1, e._w[0]) && same(fr.w2, e._w[1])) || (same(fr.w1, e._w[1]) && same(fr.w2, e._w[0])))) continue;
    } else if (Math.abs(M.dist(A, B) - L) > 1e-6) continue;
    const d = M.dist(M.mul(M.add(A, B), 0.5), mid) + Math.abs(M.dist(A, B) - L);
    if (!best || d < best.d) best = { d, A, B };
  }
  if (best) { const flip = M.dot(M.sub(best.B, best.A), dir) < 0; e.a = flip ? best.B : best.A; e.b = flip ? best.A : best.B; }
}
import { faceRegion, findRegion, regionCentroid, pushPull, shell, mirrorMesh } from './modifiers.js';
export const edgeBlendOp = {
  label: p => (p.kind === 'fillet' ? 'Fillet' : 'Chamfer') + ` · ${p.edges.length} edge${p.edges.length === 1 ? '' : 's'}`,
  defaults: () => ({ kind: 'fillet', size: defSize() / 10, segs: 8 }),
  prepare(p) {
    p.edges ??= JSON.parse(JSON.stringify(S.ed.edges || []));
    if (!p.edges.length) return 'Pick body edges first (Edge tool)';
    p._objs = [...new Set(p.edges.map(e => e.obj))];
  },
  touch: p => ({ ids: p._objs, mesh: true }),
  fields: p => [lenF('size', p.kind === 'fillet' ? 'Radius' : (p.edges || []).every(e => e.circle) ? 'Distance' : 'Distance 1'), ...(p.kind === 'fillet' ? [{ key: 'segs', label: 'Segments / 90°', kind: 'int', min: 1, max: 64 }] : (p.edges || []).every(e => e.circle) ? [] : [lenF('size2', 'Distance 2'), { key: 'swap', label: 'Swap sides', kind: 'bool' }]), { key: 'kind', label: 'Type', kind: 'choice', options: [['fillet', 'Fillet'], ['chamfer', 'Chamfer']], wide: true }],
  apply(p, op) {
    if (!(p.size > 0)) return 'Size must be > 0';
    // live drag handle (computed on the edge before it is rounded): from the edge midpoint, away from the corner
    const e0 = p.edges[0], o0 = objById(e0.obj);
    if (o0) {
      const fr = edgeFrame(worldVerts(o0), o0.mesh.f, e0.a, e0.b);
      if (typeof fr !== 'string') {
        let dir = M.norm(M.add(fr.w1, fr.w2)); if (!fr.convex) dir = M.mul(dir, -1);
        op.handle = { origin: M.mul(M.add(e0.a, e0.b), 0.5), dir: M.mul(dir, -1), key: 'size', min: 1e-6 };
      }
    }
    for (const id of p._objs) {
      const o = objById(id); if (!o) return 'Body missing';
      let W = worldVerts(o), faces = o.mesh.f;
      // after an earlier step changed the body, re-find each edge (same direction/length or same circle, nearest)
      for (const e of p.edges.filter(x => x.obj === id)) refindEdge(e, W, faces);
      for (const e of p.edges.filter(x => x.obj === id)) {
        // Distance 2 follows Distance 1 until it is edited on its own
        if (p.size2 == null || p.size2 === p._size1) p.size2 = p.size;
        p._size1 = p.size;
        if (p.kind === 'chamfer' && !(p.size2 > 0)) return 'Distance 2 must be > 0';
        const r = e.circle
          ? circleBlend(W, faces, e.circle, p.size, p.kind, Math.max(1, Math.round(p.segs)))
          : edgeBlend(W, faces, e.a, e.b, p.size, p.kind, Math.max(1, Math.round(p.segs)), p.kind === 'chamfer' ? p.size2 : null, !!p.swap);
        if (typeof r === 'string') return r;
        W = r.v; faces = r.f;
      }
      // corners where three selected straight edges meet at right angles get a spherical patch
      if (p.kind === 'fillet') {
        const straight = p.edges.filter(x => x.obj === id && !x.circle), seen = new Set();
        for (const e of straight) for (const V of [e.a, e.b]) {
          const key = V.map(c => c.toFixed(6)).join(); if (seen.has(key)) continue; seen.add(key);
          const inc = straight.filter(x => M.dist(x.a, V) < 1e-6 || M.dist(x.b, V) < 1e-6);
          if (inc.length !== 3) continue;
          const dirs = inc.map(x => M.norm(M.sub(M.dist(x.a, V) < 1e-6 ? x.b : x.a, V)));
          const r = sphereCorner(W, faces, V, dirs, p.size, Math.max(2, Math.round(p.segs)));
          if (r) { W = r.v; faces = r.f; }
        }
      }
      const xf = xfFor(o);
      o.mesh = new M.PolyMesh(W.map(xf.toL), faces);
      if (o.scl.filter(s => s < 0).length % 2) o.mesh.f.forEach(f => f.reverse());
    }
    S.ed.edges = [];
  },
};

// ---------- Plasticity-style face modifiers (Model workspace) ----------
// face selections: [{obj, n, w, p}] — a plane and a point, re-found after every operation
function resolveFaces(list) {
  const out = [];
  for (const f of list) {
    const o = objById(f.obj); if (!o) return 'Body missing';
    const W = worldVerts(o), reg = findRegion(W, o.mesh.f, f.n, f.w, f.p);
    if (!reg) return 'Selected face no longer exists';
    out.push({ o, W, reg });
  }
  return out;
}
function setBody(o, m) {
  const xf = xfFor(o);
  o.mesh = new M.PolyMesh(m.v.map(xf.toL), m.f);
  if (o.scl.filter(s => s < 0).length % 2) o.mesh.f.forEach(f => f.reverse());
}
export const pushPullOp = {
  label: () => 'Push/Pull',
  defaults: () => ({ dist: defSize() / 4 }),
  prepare(p) { p.faces ??= JSON.parse(JSON.stringify(S.ed.faces || [])); if (!p.faces.length) return 'Select a face (Face mode)'; p._objs = [...new Set(p.faces.map(f => f.obj))]; },
  touch: p => ({ ids: p._objs, mesh: true }),
  fields: () => [lenF('dist', 'Distance')],
  apply(p, op) {
    if (Math.abs(p.dist) < 1e-9) return 'Distance must not be zero';
    const first = resolveFaces([p.faces[0]]); if (typeof first === 'string') return first;
    const c0 = regionCentroid(first[0].W, first[0].o.mesh.f, first[0].reg);
    for (const f of p.faces) {
      const r = resolveFaces([f]); if (typeof r === 'string') return r;
      const { o, W, reg } = r[0];
      const m = pushPull(W, o.mesh.f, reg, p.dist); if (typeof m === 'string') return m;
      setBody(o, m);
    }
    // keep the selection on the moved face
    S.ed.faces = p.faces.map(f => ({ ...f, w: f.w + p.dist, p: M.add(f.p, M.mul(f.n, p.dist)) }));
    op.handle = { origin: c0, dir: p.faces[0].n, key: 'dist' };
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
    const o = objById(p.obj); if (!o) return 'Body missing';
    const r = resolveFaces(p.faces); if (typeof r === 'string') return r;
    const W = worldVerts(o);
    const c0 = r.length ? regionCentroid(r[0].W, o.mesh.f, r[0].reg) : null;
    const m = shell(W, o.mesh.f, r.map(x => x.reg), p.t); if (typeof m === 'string') return m;
    setBody(o, m);
    S.ed.faces = [];
    if (c0) op.handle = { origin: c0, dir: M.mul(p.faces[0].n, -1), key: 't', min: 1e-6 };
  },
};
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
    const o = objById(p.obj); if (!o) return 'Body missing';
    const W = worldVerts(o);
    let n, w;
    if (p.plane === 'face' && p.face) { n = p.face.n; w = p.face.w; }
    else { n = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[p.plane]; w = 0; }
    const m = mirrorMesh(W, o.mesh.f, n, w, p.fuse); if (typeof m === 'string') return m;
    if (p.fuse) setBody(o, m);
    else {
      const c = newObject(o.name, m, [0, 0, 0], p._id); c.color = o.color;
      const anchor = M.centroid(m.v); c.loc = anchor; c.mesh.v = m.v.map(v => M.sub(v, anchor));
      S.doc.objects.push(c); S.ed.selected = new Set([c.id]); S.ed.active = c.id;
    }
    S.ed.faces = [];
  },
};
export { faceRegion };

// ---------- body pattern (polar) and slice ----------
import { slice as sliceMesh, rotateMesh, thicken, draft } from './modifiers.js';
export const polarPattern = {
  label: () => 'Polar Pattern',
  defaults: () => ({ count: 6, angle: 360, axis: 'z', cx: 0, cy: 0, cz: 0 }),
  prepare(p) { if (!S.ed.selected.size) return 'Select a body'; p.ids ??= [...S.ed.selected]; p._base ??= S.doc.nextId; },
  touch: () => ({ ids: [] }),
  fields: () => [{ key: 'count', label: 'Count', kind: 'int', min: 2, max: 360 }, { key: 'angle', label: 'Total angle', kind: 'ang' }, { key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], wide: true }, lenF('cx', 'Centre X'), lenF('cy', 'Centre Y'), lenF('cz', 'Centre Z')],
  apply(p) {
    const n = Math.max(2, Math.min(360, Math.round(p.count)));
    const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9, step = full ? p.angle / n : p.angle / (n - 1);
    const a = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[p.axis], c = [p.cx, p.cy, p.cz];
    let id = p._base; const made = [...p.ids];
    for (let k = 1; k < n; k++) for (const oid of p.ids) {
      const o = objById(oid); if (!o) continue;
      const W = rotateMesh(worldVerts(o), c, a, step * k);
      const anchor = M.centroid(W);
      const q = newObject(o.name, new M.PolyMesh(W.map(w => M.sub(w, anchor)), o.mesh.f.map(f => f.slice())), anchor, id++);
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
    let n, w;
    if (p.plane === 'face' && p.face) { n = p.face.n; w = p.face.w + p.offset; }
    else { n = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[p.plane]; w = p.offset; }
    const { pos, neg } = sliceMesh(worldVerts(o), o.mesh.f, n, w);
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
    const r = thicken(worldVerts(o), o.mesh.f, p.t); if (typeof r === 'string') return r;
    const xf = xfFor(o); o.mesh = new M.PolyMesh(r.v.map(xf.toL), r.f);
  },
};

// ---------- LOFT and SWEEP ----------
import { loftSections, sweepRegion, pathFrames, sketchPath } from './sweep.js';
export const loftOp = {
  label: p => `Loft${targetLabel(p)}`,
  defaults: () => ({ segs: 64 }),
  prepare(p) {
    p.pts ??= JSON.parse(JSON.stringify(S.ed.profiles));
    if (p.pts.length < 2) return 'Select 2 or more profiles (multi-select on), in loft order';
    p.mode ??= 'new'; p.target ??= selectedObjs()[0]?.id ?? null; p._id ??= S.doc.nextId;
  },
  touch: touchFeature,
  fields: () => [{ key: 'segs', label: 'Points per section', kind: 'int', min: 8, max: 512 }, { key: 'mode', label: 'Operation', kind: 'choice', options: MODES, wide: true }],
  apply(p) {
    const secs = [];
    for (const it of p.pts) {
      const sk = SK.sketchById(it.sk), r = sk && SK.regionAt(sk, it.pt);
      if (!r) return 'A profile no longer exists';
      secs.push(r.outer.map(q => SK.toW(sk.plane, q)));
    }
    const m = loftSections(secs, Math.max(8, Math.round(p.segs))); if (typeof m === 'string') return m;
    return applyBody(p, m, 'Loft', M.centroid(m.v));
  },
};
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
    const sk = SK.sketchById(p.pts[0].sk), r = sk && SK.regionAt(sk, p.pts[0].pt);
    if (!r) return 'Profile no longer exists';
    const ps = SK.sketchById(p.path); if (!ps) return 'Path sketch missing';
    const c = M.centroid(r.outer.map(q => SK.toW(sk.plane, q)));
    const path = sketchPath(ps, c); if (!path) return 'No open path in that sketch';
    const S0 = path[0], pl = sk.plane;
    const loc = q => { const w = M.sub(SK.toW(pl, q), S0); return [M.dot(w, pl.u), M.dot(w, pl.v)]; };
    const frames = pathFrames(path, { u: pl.u, v: pl.v }); if (!frames) return 'Path too short';
    const m = sweepRegion({ outer: r.outer.map(loc), holes: r.holes.map(h => h.map(loc)) }, frames);
    if (!m.f.length) return 'Sweep failed';
    return applyBody(p, m, 'Sweep', M.centroid(m.v));
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
    const o = objById(p.obj); if (!o) return 'Body missing';
    const r = resolveFaces(p.faces); if (typeof r === 'string') return r;
    const d = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[p.pull];
    const m = draft(worldVerts(o), o.mesh.f, r.map(x => x.reg), d, p.neutral, p.angle); if (typeof m === 'string') return m;
    setBody(o, m); S.ed.faces = [];
  },
};

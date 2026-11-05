// CAD operators: sketches, extrude, revolve, body booleans. All re-adjustable via the last-op card.
import { S, emit, objById, selectedObjs, isShown } from './state.js';
import * as SK from './sketch.js';
import * as M from './mesh.js';
import { toPolys, boolean, polysToMesh } from './csg.js';
import { newObject, xfFor, worldVerts, turnObject } from './scene.js';
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
  // exact solids: only flat faces carry a sketch plane (a curved face has no single plane)
  if (obj.brep && obj.faceOf) { const bf = obj.brep.faces[obj.faceOf[fi]]; if (!bf || bf.type !== 'PLANE') return null; }
  const xf = xfFor(obj);
  let P = obj.mesh.f[fi].map(i => xf.toW(obj.mesh.v[i])), n = M.faceNormal(P);
  // exact solids: the plane from the B-rep face in double precision (the display mesh is float32,
  // which would put the sketch a hair under the face and hide it)
  if (obj.shape && obj.faceOf) {
    try {
      const f = obj.shape.faces[obj.faceOf[fi]], c0 = f.center, c = typeof c0 === 'function' ? c0() : c0, fn = f.normalAt();
      const pl = [c.x, c.y, c.z], nl = M.norm([fn.x, fn.y, fn.z]), nw = M.norm(M.sub(xf.toW(M.add(pl, nl)), xf.toW(pl)));
      if (M.dot(nw, n) < 0) nw.forEach((v, k) => { nw[k] = -v; });
      P = [xf.toW(pl)]; n = nw;
    } catch (e) { /* keep the mesh plane */ }
  }
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
// the region a stored pick means: the one under its point — unless the sketch changed so that point now lies in
// a different region (or none); then the region of the same area nearest to where the old one was
function regionCentre(r) { const P = r.outer; return [P.reduce((s, q) => s + q[0], 0) / P.length, P.reduce((s, q) => s + q[1], 0) / P.length]; }
function interiorPoint(sk, r) {
  const c = regionCentre(r); if (SK.regionAt(sk, c) === r) return c;
  for (const t of [0.1, 0.25, 0.5]) for (const q of r.outer) { const p = [q[0] + (c[0] - q[0]) * t, q[1] + (c[1] - q[1]) * t]; if (SK.regionAt(sk, p) === r) return p; }
  return null;
}
function resolveRegion(sk, it) {
  let r = SK.regionAt(sk, it.pt);
  const area = x => SK.regionArea(x).area;
  // (a region that only changed size keeps its centre, so it is still the same region)
  if (it._a != null && (!r || (Math.abs(area(r) - it._a) > 1e-6 * Math.max(1, it._a) + 1e-9 && it._c && SK.d2(regionCentre(r), it._c) > 1e-6 + 0.05 * Math.sqrt(it._a)))) {
    let best = null;
    for (const q of SK.regions(sk)) {
      const a = area(q); if (Math.abs(a - it._a) > 0.05 * it._a) continue;
      const d = SK.d2(regionCentre(q), it._c || it.pt); if (!best || d < best.d) best = { d, q };
    }
    if (best) { r = best.q; const ip = interiorPoint(sk, r); if (ip) it.pt = ip; }
  }
  if (r) { it._a = area(r); it._c = regionCentre(r); }
  return r;
}
function profileGroups(pts) {
  const groups = new Map();
  for (const it of pts) {
    const sk = SK.sketchById(it.sk); if (!sk) continue;
    const r = resolveRegion(sk, it); if (!r) continue;
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
const solidOnly = o => (o && o.link ? `“${o.name}” is a linked component — open its project to change it, then Sync` : o && o.shape ? null : o ? `“${o.name}” is an imported mesh — this works on solids` : 'Body missing');
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
    // no target picked: use the body the new shape touches (largest overlap), like Plasticity
    if (!objById(p.target)) p.target = touchedBody(tool)?.id ?? null;
    const t = objById(p.target);
    if (!t) return p.mode === 'join' ? 'It touches no body to join — pick the body in Solid mode, or use New' : 'It touches no body to cut — pick the body in Solid mode first';
    const e = solidOnly(t); if (e) return e;
    const res = guard(() => K.boolean(p.mode === 'join' ? 'union' : p.mode === 'cut' ? 'subtract' : 'intersect', t.shape, K.toLocal(tool, t)), 'Boolean failed');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    if (p.mode === 'cut' && Math.abs(K.volume(res) - K.volume(t.shape)) < 1e-9) return 'The cut misses the body — try the other direction (Flip)';
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
function touchedBody(tool) {
  const tb = tool.boundingBox.bounds; let best = null;
  for (const o of S.doc.objects) {
    if (!o.shape || o.link || o.hidden || !isShown(o)) continue;
    const w = K.worldShape(o), b = w.boundingBox.bounds;
    if ([0, 1, 2].some(k => b[1][k] < tb[0][k] - 1e-6 || b[0][k] > tb[1][k] + 1e-6)) continue;
    let v = 0; try { const i = w.intersect(tool); v = K.isEmpty(i) ? 0 : K.volume(i); } catch (e) { continue; }
    // a join only needs to touch; a cut needs overlap
    const touch = v > 1e-9 || (() => { try { return R0dist(w, tool) < 1e-6; } catch (e) { return false; } })();
    if (touch && (!best || v > best.v)) best = { o, v };
  }
  return best?.o;
}
const R0dist = (a, b) => K.R.measureDistanceBetween(a, b);
function prepFeature(p) {
  if (!p.pts) p.pts = JSON.parse(JSON.stringify(S.ed.profiles));
  const groups = profileGroups(p.pts);
  if (!groups.length) return 'Tap one or more closed sketch regions first';
  if (p.target === undefined) {
    const sk = groups[0].sk;
    // a linked (read-only) part is never the default target: a sketch on its face makes a new body
    const editable = id => { const o = objById(id); return o && !o.link; };
    const faceObj = sk.face && editable(sk.face.obj) ? sk.face.obj : null;
    const sel = selectedObjs().find(o => !o.link);
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
    // a cut chosen by hand from a face sketch goes into the body whichever sign is typed (−1 and 1 both cut 1 deep)
    const into = g => !auto && g.sk.face && (p.mode === 'cut' || p.mode === 'intersect');
    const sgn = g => (p.flip ? -1 : 1) * (into(g) ? (p.distance >= 0 ? -1 : 1) : 1);
    const g0 = groups[0], s0 = sgn(g0);
    const anchor = regionsCentroid(g0), dirW = M.mul(g0.sk.plane.n, s0);
    if (Math.abs(p.distance) < 1e-9) { op.handle = { origin: anchor, dir: dirW, key: 'distance' }; return; }
    const tool = guard(() => {
      const solids = [];
      for (const g of groups) {
        const s = sgn(g);
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
    // name each candidate axis by what it looks like: length and direction (↔ along the sketch's X, ↕ along Y)
    p._lines = lines.map(l => { const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], L = Math.hypot(dx, dy), dir = Math.abs(dy) < 1e-9 ? '↔' : Math.abs(dx) < 1e-9 ? '↕' : '⟋';
      return { v: 'l:' + l.id, label: `${l.construction ? '┄ ' : ''}${dir} ${fmtLen(L)}` }; });
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
  label: p => `${({ union: 'Union', subtract: 'Subtract', intersect: 'Intersect' })[p.kind]}${p.kind === 'subtract' && objById(p.ids?.[0]) ? ' from ' + objById(p.ids[0]).name : ''}`,
  defaults: () => ({ kind: 'union', keep: false }),
  prepare(p) {
    if (S.ed.selected.size < 2) return 'Select 2+ bodies (turn on multi-select). The first one tapped is the target.';
    if (!p.ids) {
      const sel = [...S.ed.selected].map(objById).filter(Boolean);
      // subtract: the target is the biggest body (cutters are smaller) — so a pattern of cutters selected
      // first, then the blank, still cuts the blank
      // (union / intersect too: the result keeps the main body's name, colour and placement, not a tool's)
      // equal volumes (a pattern's copies and their original): the original wins, then the first tapped — a copy as
      // the target would vanish when the pattern's count drops
      if (sel.every(o => o.shape)) {
        const vol = new Map(sel.map(o => [o, Math.abs(K.volume(K.worldShape(o)))])), order = new Map(sel.map((o, i) => [o, i]));
        sel.sort((a, b) => { const va = vol.get(a), vb = vol.get(b); if (Math.abs(va - vb) > 1e-6 * Math.max(va, vb, 1)) return vb - va;
          return ((a.patternOf != null) - (b.patternOf != null)) || order.get(a) - order.get(b); });
      }
      p.ids = sel.map(o => o.id);
    }
    // tools that came from a pattern follow the pattern (its copies are made again when its count changes)
    p._pat ??= [...new Set(p.ids.slice(1).map(id => objById(id)?.patternOf).filter(x => x != null))];
  },
  touch: p => ({ ids: p.ids, mesh: true }),
  fields: () => [{ key: 'kind', label: 'Operation', kind: 'choice', options: [['union', 'Union'], ['subtract', 'Subtract'], ['intersect', 'Intersect']], wide: true }, { key: 'keep', label: 'Keep tools', kind: 'bool' }],
  apply(p) {
    const [tid, ...listed] = p.ids;
    const t = objById(tid); if (!t) return 'Target missing';
    const pat = new Set(p._pat || []);
    const tools = [...new Set([...listed.filter(id => !pat.has(objById(id)?.patternOf)), ...S.doc.objects.filter(o => pat.has(o.patternOf)).map(o => o.id)])].filter(id => id !== tid && objById(id));
    if (t.link) return `“${t.name}” is a linked component — tap another body first to make it the target`;
    const objs = tools.map(objById).filter(Boolean);
    if (t.shape && objs.every(o => o.shape)) {
      const res = guard(() => {
        const locals = objs.map(o => K.toLocal(K.worldShape(o), t).clone());
        // many cutters (gear teeth, vents): one cut with all of them is much faster than one cut each
        if (p.kind === 'subtract' && locals.length > 1) { try { const r = t.shape.cut(K.compound(locals)); if (!K.isEmpty(r)) return r; } catch (e) { /* one by one */ } }
        let s = t.shape; for (const l of locals) s = K.boolean(p.kind, s, l); return s;
      }, 'Boolean failed');
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
    const hit = K.edgeAt(o.shape, { p: xf.toL(p), len: e.len, type: e.type, closed: e.closed, sig: e.sig });
    if (!hit) return null;
    const pts = hit.info.pts, mid = K.polyMid(pts);
    Object.assign(e, { p: xf.toW(mid), a: xf.toW(pts[0]), b: xf.toW(pts[pts.length - 1]), len: hit.info.len, type: hit.info.type, closed: !!hit.info.closed, sig: K.edgeSig(o.shape, hit.info) });
    out.push(hit.edge);
  }
  return out;
}
export const edgeBlendOp = {
  label: p => (p.kind === 'fillet' ? 'Fillet' : 'Chamfer') + ` · ${p.edges.length} edge${p.edges.length === 1 ? '' : 's'}`,
  defaults: () => ({ kind: 'fillet', size: defSize() / 10 }), shrink: 'size',
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
      if (!K.isValid(res) || K.volume(res) <= 0) return `${p.kind === 'fillet' ? 'Radius' : 'Distance'} ${fmtLen(p.size)} is too big here (the rounds would overlap)`;
      // the drag handle: from the first edge, into the corner
      if (id === p._objs[0]) {
        const e = p.edges.find(x => x.obj === id), xf = xfFor(o), mid = xf.toL(e.p);
        const ns = o.shape.faces.filter(f => f.edges.some(x => x.isSame(edges[0]))).map(f => { try { return M.norm(vec3(f.normalAt(mid))); } catch (err) { return null; } }).filter(Boolean);
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
    const hit = K.faceAt(o.shape, pl, nl, f._fh);
    if (!hit) return null;
    if (hit.q) { const pw = xf.toW(hit.q); Object.assign(f, { p: pw, w: M.dot(f.n, pw) }); } // follow the moved face
    f._fh = K.faceHint(hit.f);
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
  defaults: () => ({ t: defSize() / 20 }), shrink: 't',
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
    const res = guard(() => K.shell(o.shape, faces, p.t), p.t * 2 >= minDim ? 'The wall is too thick for this body' : 'Shell failed near rounded edges — try a thinner wall, or shell before filleting');
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
  reserve: 2000, // ids kept free for its copies, so a bigger count never collides with later bodies
  fields: () => [{ key: 'count', label: 'Count', kind: 'int', min: 2, max: 360 }, { key: 'angle', label: 'Total angle', kind: 'ang' }, { key: 'axis', label: 'Axis', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], wide: true }, lenF('cx', 'Centre X'), lenF('cy', 'Centre Y'), lenF('cz', 'Centre Z')],
  apply(p) {
    const n = Math.max(2, Math.min(360, Math.round(p.count)));
    const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9, step = full ? p.angle / n : p.angle / (n - 1);
    const a = AX[p.axis], c = [p.cx, p.cy, p.cz];
    let id = p._base; const made = [...p.ids];
    if (S.doc.nextId < p._base + 2000) S.doc.nextId = p._base + 2000;
    for (let k = 1; k < n; k++) for (const oid of p.ids) {
      const o = objById(oid); if (!o) continue;
      let q;
      if (o.shape) { const s = guard(() => K.rotated(K.worldShape(o), step * k, c, a), 'Pattern failed'); if (typeof s === 'string') return s; q = newObject(o.name, null, [0, 0, 0], id++); K.setShape(q, s); }
      else { const W = rotateMesh(worldVerts(o), c, a, step * k), anchor = M.centroid(W); q = newObject(o.name, new M.PolyMesh(W.map(w => M.sub(w, anchor)), o.mesh.f.map(f => f.slice())), anchor, id++); }
      q.color = o.color; q.patternOf = p._base; if (o.link) q.link = { ...o.link }; S.doc.objects.push(q); made.push(q.id);
    }
    S.ed.selected = new Set(made);
  },
};
// rows (and columns) of copies of the selected bodies: e.g. vent-slot cutters, then Subtract them in one go
export const linearPattern = {
  label: p => `Linear Pattern ${p.count}${p.count2 > 1 ? '×' + p.count2 : ''}`,
  defaults: () => ({ count: 3, dir: 'x', count2: 1, dir2: 'y' }),
  prepare(p) {
    if (!S.ed.selected.size) return 'Select a body'; p.ids ??= [...S.ed.selected]; p._base ??= S.doc.nextId;
    // spacing: the selection's size along the direction plus a fifth (copies sit side by side, not on top)
    const size = k => { const W = p.ids.map(objById).filter(Boolean).flatMap(o => worldVerts(o)); if (!W.length) return 10; const lo = Math.min(...W.map(q => q[k])), hi = Math.max(...W.map(q => q[k])); return Math.max(1, +((hi - lo) * 1.2).toFixed(2)); };
    p.spacing ??= size('xyz'.indexOf(p.dir)); p.spacing2 ??= size('xyz'.indexOf(p.dir2));
  },
  touch: () => ({ ids: [] }),
  reserve: 2000,
  fields: p => [{ key: 'count', label: 'Count', kind: 'int', min: 1, max: 500 }, lenF('spacing', 'Spacing (− flips)'), { key: 'dir', label: 'Direction', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], wide: true },
    { key: 'count2', label: 'Rows', kind: 'int', min: 1, max: 500 }, ...(p.count2 > 1 ? [lenF('spacing2', 'Row spacing'), { key: 'dir2', label: 'Row direction', kind: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], wide: true }] : [])],
  apply(p) {
    const n1 = Math.max(1, Math.round(p.count)), n2 = Math.max(1, Math.round(p.count2 || 1));
    if (n1 * n2 < 2) return 'Count must make at least 2 copies';
    if (n1 * n2 > 1000) return 'That is more than 1000 copies';
    if (n2 > 1 && p.dir2 === p.dir) return 'Rows need a different direction';
    let id = p._base; const made = [...p.ids];
    if (S.doc.nextId < p._base + 2000) S.doc.nextId = p._base + 2000;
    for (let j = 0; j < n2; j++) for (let i = 0; i < n1; i++) {
      if (!i && !j) continue;
      const d = M.add(M.mul(AX[p.dir], i * p.spacing), M.mul(AX[p.dir2], j * (p.spacing2 || 0)));
      for (const oid of p.ids) {
        const o = objById(oid); if (!o) continue;
        const q = newObject(o.name, o.shape ? null : new M.PolyMesh(o.mesh.v.map(v => v.slice()), o.mesh.f.map(f => f.slice())), M.add(o.loc, d), id++);
        q.rot = o.rot.slice(); q.scl = o.scl.slice(); q.color = o.color; q.layer = o.layer; q.patternOf = p._base; if (o.link) q.link = { ...o.link };
        if (o.shape) K.setShape(q, o.shape); // same local shape, shifted placement (shapes are shared values)
        S.doc.objects.push(q); made.push(q.id);
      }
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
    for (const it of p.pts) { const sk = SK.sketchById(it.sk), f = sk && K.regionFace(sk, it.pt); if (!f) return 'A profile no longer exists'; wires.push(f.clone().outerWire()); } // outerWire consumes its face: work on a copy (the face is cached)
    const tool = guard(() => R.loft(wires, { ruled: !!p.ruled }), 'Loft failed — check the profiles face the same way');
    if (typeof tool === 'string') return tool;
    return applyBody(p, tool, 'Loft');
  },
};
// path sketch → spine wire: exact lines/arcs where possible
// the sweep path as exact edges: lines stay lines, arcs stay true circular arcs (three points on the arc),
// splines become B-splines through their own points — chained end to end, longest chain, starting near `near`
function pathWire(ps, near) {
  const W = q => SK.toW(ps.plane, q), d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const segs = [];
  for (const e of ps.ents) {
    if (e.construction || !['line', 'arc', 'spline'].includes(e.t)) continue;
    const pl = SK.entPolyline(e); if (!pl || pl.closed || pl.pts.length < 2) continue;
    const P = pl.pts;
    // a curve drawn twice (same ends, same length) would make the path double back on itself: keep one
    const L0 = P.reduce((t, q, i) => (i ? t + d2(q, P[i - 1]) : 0), 0), ea = P[0], eb = P[P.length - 1];
    if (segs.some(g => Math.abs(g.len - L0) < 1e-6 && ((d2(g.a, ea) < 1e-6 && d2(g.b, eb) < 1e-6) || (d2(g.a, eb) < 1e-6 && d2(g.b, ea) < 1e-6)))) continue;
    segs.push({ a: P[0], b: P[P.length - 1], make: rev => {
      const Q = rev ? P.slice().reverse() : P;
      if (e.t === 'line') return R.makeLine(W(Q[0]), W(Q[Q.length - 1]));
      if (e.t === 'arc') return R.makeThreePointArc(W(Q[0]), W(Q[Math.floor(Q.length / 2)]), W(Q[Q.length - 1]));
      return R.makeBSplineApproximation(Q.map(W), { tolerance: 1e-4, degMax: 3, degMin: 3 });
    }, len: P.reduce((t, q, i) => (i ? t + d2(q, P[i - 1]) : 0), 0) });
  }
  if (!segs.length) return null;
  const used = new Set(), chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i); let chain = [{ s: segs[i], rev: false }], grew = true;
    const head = () => (chain[0].rev ? chain[0].s.b : chain[0].s.a), tail = () => { const c = chain[chain.length - 1]; return c.rev ? c.s.a : c.s.b; };
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (used.has(j)) continue;
        const g = segs[j];
        if (d2(tail(), g.a) < 1e-6) chain.push({ s: g, rev: false });
        else if (d2(tail(), g.b) < 1e-6) chain.push({ s: g, rev: true });
        else if (d2(head(), g.b) < 1e-6) chain.unshift({ s: g, rev: false });
        else if (d2(head(), g.a) < 1e-6) chain.unshift({ s: g, rev: true });
        else continue;
        used.add(j); grew = true;
      }
    }
    chains.push(chain);
  }
  const L = c => c.reduce((t, x) => t + x.s.len, 0);
  let best = chains.sort((a, b) => L(b) - L(a))[0];
  const start = W(best[0].rev ? best[0].s.b : best[0].s.a), endC = best[best.length - 1], end = W(endC.rev ? endC.s.a : endC.s.b);
  if (near && M.dist(end, near) < M.dist(start, near)) best = best.slice().reverse().map(x => ({ s: x.s, rev: !x.rev }));
  return R.assembleWire(best.map(x => x.s.make(x.rev)));
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
      // the outline swept, minus each hole swept the same way (a ring profile makes a tube)
      // corners are mitred (exact: a zig-zag spring keeps its full cross-section); if that fails, rounded
      const run = mode => {
        const opts = { frenet: true, transitionMode: mode };
        let solid = R.genericSweep(f.clone().outerWire(), mode === 'right' ? spine : pathWire(ps, c), opts);
        let holes = []; try { holes = f.clone().innerWires(); } catch (e) { holes = []; }
        for (const w of holes) solid = solid.cut(R.genericSweep(w, pathWire(ps, c), opts));
        if (!K.isValid(solid) || !(K.volume(solid) > 0)) throw new Error('invalid sweep');
        return solid;
      };
      try { return run('right'); } catch (e) { return run('round'); }
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
// a hole drilled at the ISO tap-drill size (D − P, e.g. Ø6.8 for M8) is threaded as that nominal size
const tapNominal = hole => { const m = ISO_PITCH.find(([d, P]) => Math.abs(d - P - hole) < 0.051); return m ? m[0] : null; };
// the cylinder a thread was cut on, found again after earlier steps changed it: the same axis line, nearest radius
function coaxialCylinder(shape, ax) {
  let best = null;
  for (const f of shape.faces) {
    const cy = K.cylinderOf(f); if (!cy || Math.abs(M.dot(cy.d, ax.d)) < 0.9999) continue;
    const dc = M.sub(cy.c, ax.c), off = M.len(M.sub(dc, M.mul(ax.d, M.dot(dc, ax.d))));
    // same axis (the hole or shaft changed size), else the same size moved a little (its sketch moved)
    const sc = off <= 1e-5 ? Math.abs(cy.R - ax.R) : Math.abs(cy.R - ax.R) < 1e-6 && off < Math.max(5, 2 * ax.R) ? 1e3 + off : Infinity;
    if (sc < Infinity && (!best || sc < best.sc)) best = { sc, cy };
  }
  return best?.cy || null;
}
// Thread: a true helical thread on a cylindrical face — external (shaft) or internal (hole), detected from the face
export const threadOp = {
  shrink: 'length', shrinkTries: 3, // a thread that cannot be cut over the default length is tried shorter
  label: p => `Thread ${p._internal ? 'internal ' : ''}M${fmtD(p.size || p._d || 0)}×${fmtD(p.pitch || 0)}`,
  prepare(p) {
    p.faces ??= JSON.parse(JSON.stringify((S.ed.faces || []).slice(0, 1)));
    if (!p.faces.length) return 'Select a cylindrical face (Face mode), e.g. a shaft or a hole';
    p.obj = p.faces[0].obj;
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    const f = findFaces(o, p.faces)?.[0], cy = f && K.cylinderOf(f);
    if (!cy) return 'Pick a cylindrical face (a shaft or a round hole)';
    const xf = xfFor(o), pl = xf.toL(p.faces[0].p), radial = M.sub(pl, M.add(cy.c, M.mul(cy.d, M.dot(M.sub(pl, cy.c), cy.d))));
    p._internal = M.dot(M.norm(radial), locDir(xf, p.faces[0].p, p.faces[0].n)) < 0;
    p._d = 2 * cy.R; p._axis = { c: cy.c, d: cy.d, R: cy.R };
    // nominal size: a shaft is threaded at its diameter; a hole at its tap-drill size becomes that thread (Ø6.8 → M8)
    p.size ??= p._internal ? (tapNominal(p._d) ?? p._d) : p._d;
    // start at the end nearest the tap, over a typical length (2·d + 6, or the whole face if shorter)
    const tl = M.dot(M.sub(pl, cy.c), cy.d); p._tapEnd = Math.abs(cy.t1 - tl) <= Math.abs(tl - cy.t0);
    p.pitch ??= isoPitch(p.size); p.length ??= +Math.min(cy.t1 - cy.t0, 2 * p.size + 6).toFixed(6); p.fromEnd ??= p._tapEnd; p.left ??= false;
  },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [...(p._internal ? [lenF('size', 'Thread size (M)')] : []), lenF('pitch', 'Pitch'), lenF('length', 'Length'), { key: 'fromEnd', label: 'Starts at', kind: 'choice', options: p._tapEnd == null ? [[true, 'One end'], [false, 'Other end']] : [[p._tapEnd, 'The end you tapped'], [!p._tapEnd, 'The other end']], wide: true }, { key: 'left', label: 'Left-hand', kind: 'bool' }],
  apply(p) {
    if (!(p.pitch > 0.05)) return 'Pitch must be at least 0.05 mm';
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    let cy = (() => { const f = findFaces(o, p.faces)?.[0]; return f && K.cylinderOf(f); })();
    if (!cy && p._axis) cy = coaxialCylinder(o.shape, p._axis); // the hole or shaft changed size or moved
    if (!cy) return 'The cylindrical face it used no longer exists';
    p._axis = { c: cy.c, d: cy.d, R: cy.R };
    const span = cy.t1 - cy.t0, L = Math.min(Math.max(p.length, p.pitch * 2), span);
    if (L < p.pitch * 2) return 'The face is too short for this pitch';
    const internal = p._internal, P = p.pitch;
    // internal: the hole opens up to the thread's major diameter in the thread zone, then the ridge goes in
    const R0 = internal ? Math.max(cy.R, (p.size || 2 * cy.R) / 2) : cy.R;
    if (internal && (p.size || 0) / 2 - cy.R > P) return `M${fmtD(p.size)} is too big for this Ø${fmtD(2 * cy.R)} hole`;
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
      let s = o.shape;
      if (R0 > cy.R + 1e-9) { const u = M.norm(Math.abs(cy.d[2]) < 0.9 ? M.cross(cy.d, [0, 0, 1]) : M.cross(cy.d, [1, 0, 0])); s = s.cut(K.revolveProfile(cy.c, cy.d, u, [[0, ta], [R0, ta], [R0, tb], [0, tb]])); }
      const ridge = K.threadRidge(M.add(cy.c, M.mul(cy.d, ta + w + 0.01)), cy.d, R0, P, L - 2 * w - 0.02, [[R0 + 0.25, -w], [rmin, -flat], [rmin, flat], [R0 + 0.25, w]], !!p.left);
      return s.fuse(ridge);
    }, 'Could not cut this thread');
    if (typeof res === 'string') return res;
    if (K.isEmpty(res)) return 'Result is empty';
    K.setShape(o, res); S.ed.faces = [];
  },
};

// Hole: simple, counterbore or countersink, drilled into a flat face at the picked point
// ---------- placing features on a flat face: centre, in-plane axes, patterns ----------
// The face frame: n drills into the body, a follows world X where it can (else Y), b completes it, so
// "angle 0" and pattern rows read the way the part sits on screen.
function faceFrame(o, f0) {
  const xf = xfFor(o), n = M.mul(locDir(xf, f0.p, f0.n), -1);
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = M.norm(M.sub(ref, M.mul(n, M.dot(n, ref))));
  // rows go toward +Y (or +Z on a wall) on any face, also one facing down (no mirrored patterns)
  let b = M.cross(a, n); const up = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]; if (M.dot(b, up) < 0) b = M.mul(b, -1);
  return { xf, n, a, b };
}
// the exact centre a tap means: a round face's circle centre (a boss, a standoff, a screw head), or the
// middle of a polygon face when the tap is close to it; null when the tap is just a point on the face
function faceCentre(o, f, tapW, strict) {
  try {
    const xf = xfFor(o), hit = K.faceAt(o.shape, xf.toL(tapW)); if (!hit) return null;
    const ca = K.circleAxisOf(hit.f);
    if (ca) {
      const cw = xf.toW(ca.c);
      if (strict || M.dist(cw, tapW) < ca.R * 0.6) return { c: cw, how: 'circle' };
    }
    const c0 = hit.f.center, c = typeof c0 === 'function' ? c0() : c0, cw = xf.toW([c.x, c.y, c.z]);
    const b = hit.f.boundingBox.bounds, dims = [0, 1, 2].map(k => b[1][k] - b[0][k]).sort((a, b2) => a - b2), inPlane = dims[1] || dims[2];
    if (strict || M.dist(cw, tapW) < inPlane * 0.2) return { c: cw, how: 'centroid' };
  } catch (e) { /* no centre */ }
  return null;
}
// the face moved (an earlier step changed the part): a centred feature re-centres on it, others move with it
function followCentre(p, before) {
  const o = objById(p.obj);
  if (p._centred && o) { const fc = faceCentre(o, p.faces[0], p.faces[0].p, true); if (fc) { [p.x, p.y, p.z] = fc.c.map(v => +v.toFixed(9)); return; } }
  const d = M.sub(p.faces[0].p, before);
  if (M.len(d) > 1e-9) [p.x, p.y, p.z] = M.add([p.x, p.y, p.z], d).map(v => +v.toFixed(9));
}
// a feature centred on a round face finds that face again by its circle (same radius, nearest centre),
// so it follows a boss or standoff that moved in its sketch
function reanchorCircle(o, p) {
  const ci = p._circ; if (!ci) return;
  const xf = xfFor(o); let best = null;
  for (const fc of o.shape.faces) {
    if (fc.geomType !== 'PLANE') continue;
    const fn = fc.normalAt(); if (M.dot(M.norm([fn.x, fn.y, fn.z]), ci.n) < 0.9999) continue;
    const ca = K.circleAxisOf(fc); if (!ca || Math.abs(ca.R - ci.R) > 1e-6 * Math.max(1, ci.R)) continue;
    // prefer faces whose outline is that circle (the boss top), not a bigger face it is a hole in
    const b = fc.boundingBox.bounds, big = Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]) > ci.R * 2.9;
    const d = M.dist(ca.c, ci.c) + (big ? 1e6 : 0); if (!best || d < best.d) best = { d, ca };
  }
  if (!best) return;
  const ca = best.ca, u = M.norm(Math.abs(ci.n[2]) < 0.9 ? M.cross(ci.n, [0, 0, 1]) : M.cross(ci.n, [1, 0, 0]));
  const pw = xf.toW(M.add(ca.c, M.mul(u, ca.R * 0.85)));
  Object.assign(p.faces[0], { p: pw, w: M.dot(p.faces[0].n, pw) }); p._circ = { ...ci, c: ca.c };
}
function snapCentre(p) {
  const f = p.faces[0], st = S.settings.snap ? S.settings.snapStep : 0;
  if (p.x == null) {
    const o = objById(p.obj), fc = faceCentre(o, f, f.p, false);
    if (fc) {
      [p.x, p.y, p.z] = fc.c.map(v => +v.toFixed(9)); p._centred = fc.how;
      if (fc.how === 'circle') { const xf = xfFor(o), hit = K.faceAt(o.shape, xf.toL(f.p)), ca = hit && K.circleAxisOf(hit.f); if (ca) p._circ = { c: ca.c, R: ca.R, n: locDir(xf, f.p, f.n) }; }
      return;
    }
  }
  if (p.x == null) { const q = st ? f.p.map(v => Math.round(v / st) * st) : f.p.slice(); const c = M.add(q, M.mul(f.n, f.w - M.dot(f.n, q))); [p.x, p.y, p.z] = c.map(v => +v.toFixed(6)); }
}
function flatFacePrep(p, what) {
  p.faces ??= JSON.parse(JSON.stringify((S.ed.faces || []).slice(0, 1)));
  if (!p.faces.length) return `Tap a flat face where the ${what} goes (Face mode)`;
  if (p.faces[0].planar === false) return `${what[0].toUpperCase() + what.slice(1)}s go into flat faces`;
  p.obj = p.faces[0].obj;
  const e0 = solidOnly(objById(p.obj)); if (e0) return e0;
  snapCentre(p);
}
// pattern offsets in the face plane (local coordinates): one, a row, a grid or a bolt circle
const PATTERNS = [['one', 'Single'], ['row', 'Row'], ['grid', 'Grid'], ['circle', 'Circle']];
function patternFields(p) {
  const cnt = { key: 'count', label: 'Count', kind: 'int', min: 2, max: 200 };
  const f = [{ key: 'pattern', label: 'Pattern', kind: 'choice', options: PATTERNS, wide: true }];
  if (p.pattern === 'row') f.push(cnt, lenF('spacing', 'Spacing'), { key: 'pAngle', label: 'Direction', kind: 'ang' });
  if (p.pattern === 'grid') f.push({ ...cnt, label: 'Columns' }, lenF('spacing', 'Column spacing'), { key: 'rows', label: 'Rows', kind: 'int', min: 1, max: 200 }, lenF('rowSpacing', 'Row spacing'), { key: 'pAngle', label: 'Direction', kind: 'ang' });
  if (p.pattern === 'circle') f.push(cnt, lenF('radius', 'Circle radius'), { key: 'pAngle', label: 'Start angle', kind: 'ang' });
  return f;
}
const patternDefaults = { pattern: 'one', count: 2, spacing: 10, rows: 2, rowSpacing: 10, radius: 10, pAngle: 0 };
function patternOffsets(p, fr) {
  const at = (x, y, rot = 0) => ({ d: M.add(M.mul(fr.a, x), M.mul(fr.b, y)), rot });
  const ang = (p.pAngle || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const out = [];
  if (p.pattern === 'row' || p.pattern === 'grid') {
    const cols = Math.max(1, Math.round(p.count || 1)), rows = p.pattern === 'grid' ? Math.max(1, Math.round(p.rows || 1)) : 1;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const x = i * (p.spacing || 0), y = j * (p.rowSpacing || 0); out.push(at(x * ca - y * sa, x * sa + y * ca)); }
  } else if (p.pattern === 'circle') {
    const k = Math.max(1, Math.round(p.count || 1));
    for (let i = 0; i < k; i++) { const t = ang + i * 2 * Math.PI / k; out.push(at(p.radius * Math.cos(t), p.radius * Math.sin(t), t - ang)); }
  } else out.push(at(0, 0));
  return out;
}
const patternLabel = p => p.pattern === 'row' ? ` ×${p.count}` : p.pattern === 'grid' ? ` ${p.count}×${p.rows}` : p.pattern === 'circle' ? ` ×${p.count} on Ø${fmtD(p.radius * 2)}` : '';
function patternCheck(p) {
  if (p.pattern === 'row' || p.pattern === 'grid') { if (!(p.count >= 1)) return 'Count must be at least 1'; if (p.count > 1 && !(Math.abs(p.spacing) > 0)) return 'Spacing must not be 0'; }
  if (p.pattern === 'grid' && p.rows > 1 && !(Math.abs(p.rowSpacing) > 0)) return 'Row spacing must not be 0';
  if (p.pattern === 'circle' && !(p.radius > 0)) return 'Circle radius must be > 0';
  if ((p.count || 1) * (p.pattern === 'grid' ? p.rows || 1 : 1) > 400) return 'That is more than 400 copies';
}
// pattern copies whose centre is not on the tapped face (they may miss the part, or cut somewhere else)
// a typed centre off the face's plane is slid onto it (a hole starts at the face it was drilled into, never buried)
function ontoFace(p, fr) {
  const c = fr.xf.toL([p.x, p.y, p.z]), q = fr.xf.toL(p.faces[0].p), n = fr.n, d = M.dot(M.sub(c, q), n);
  if (Math.abs(d) < 1e-9) return c;
  const cc = M.sub(c, M.mul(n, d)); [p.x, p.y, p.z] = fr.xf.toW(cc).map(v => +v.toFixed(9)); return cc;
}
// (a copy that lands on another face in the same plane — the next standoff's top — is on the part; the warning is
// only shown while the step is made or edited, not on every rebuild)
function offFaceCheck(o, face, c, offs, what, quiet) {
  let off = 0;
  for (const { d } of offs) {
    try {
      const v = K.R.makeVertex(M.add(c, d));
      if (K.R.measureDistanceBetween(face, v) > 1e-4 && (offs.length === 1 || K.R.measureDistanceBetween(o.shape, v) > 1e-4)) off++;
    } catch (e) {}
  }
  if (off === offs.length) return offs.length > 1 ? `None of the ${what}s land on the part — check the spacing and direction` : `The ${what} centre is off the face — check its X / Y / Z`;
  if (off && !quiet) emit('toast', `${off} of ${offs.length} ${what}s fall outside the part`);
}
// how deep a drill of radius r from c along n must go to come out of the material it starts in
function firstExit(shape, c, n, r, len) {
  try {
    const u = M.norm(Math.abs(n[2]) < 0.9 ? M.cross(n, [0, 0, 1]) : M.cross(n, [1, 0, 0]));
    const core = shape.intersect(K.revolveProfile(c, n, u, [[0, -0.01], [r, -0.01], [r, len], [0, len]]));
    if (K.isEmpty(core)) return null;
    let best = null;
    for (const so of core.solids?.length ? core.solids : [core]) {
      const b = so.boundingBox.bounds, ts = [];
      for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) ts.push(M.dot(M.sub([b[x][0], b[y][1], b[z][2]], c), n));
      const lo = Math.min(...ts), hi = Math.max(...ts);
      if (lo < 0.05 && (!best || hi < best)) best = hi; // the piece that starts at the face
    }
    return best == null ? null : best + 0.05;
  } catch (e) { return null; }
}
// cut every tool at once; a tool that misses the body is fine, an empty result is not
function cutTools(o, tools, msg) {
  const res = guard(() => o.shape.cut(K.compound(tools)), msg);
  if (typeof res === 'string') return res;
  if (K.isEmpty(res)) return 'Result is empty';
  K.setShape(o, res); S.ed.faces = [];
}

export const holeOp = {
  label: p => `Hole Ø${fmtD(p.dia)}${p.kind === 'cbore' ? ' counterbore' : p.kind === 'csink' ? ' countersink' : ''}${patternLabel(p)}`,
  defaults: () => ({ dia: 5, depth: 0, thru: 'wall', kind: 'simple', ...patternDefaults }),
  prepare(p) { return flatFacePrep(p, 'hole'); },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [lenF('dia', 'Diameter'), lenF('depth', 'Depth (0 = through)'), ...(p.depth > 0 ? [] : [{ key: 'thru', label: 'Through', kind: 'choice', options: [['wall', 'This wall'], ['all', 'Everything']], wide: true }]), { key: 'kind', label: 'Type', kind: 'choice', options: [['simple', 'Simple'], ['cbore', 'Counterbore'], ['csink', 'Countersink']], wide: true },
    ...(p.kind === 'cbore' ? [lenF('cbDia', 'Counterbore Ø'), lenF('cbDepth', 'Counterbore depth')] : p.kind === 'csink' ? [lenF('csDia', 'Countersink Ø'), { key: 'csAngle', label: 'Countersink angle', kind: 'ang' }] : []),
    lenF('x', 'Centre X'), lenF('y', 'Centre Y'), lenF('z', 'Centre Z'), ...patternFields(p)],
  apply(p, ctx) {
    if (!(p.dia > 0)) return 'Diameter must be > 0';
    // counterbore / countersink sizes follow the hole until typed (ISO-ish: Ø×1.8 counterbore, Ø×2 countersink)
    p._auto ??= {};
    for (const [k, f] of [['cbDia', 1.8], ['cbDepth', 1], ['csDia', 2]]) if (p[k] == null || p._auto[k]) { p[k] = +(p.dia * f).toFixed(2); p._auto[k] = true; }
    p.csAngle ??= 90;
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    if (p._centred === 'circle') reanchorCircle(o, p);
    const before = p.faces[0].p.slice();
    const f = findFaces(o, p.faces)?.[0]; if (!f) return 'The face it was drilled into no longer exists';
    followCentre(p, before);
    const pe = patternCheck(p); if (pe) return pe;
    const fr = faceFrame(o, p.faces[0]), n = fr.n, c = ontoFace(p, fr);
    const bb = o.shape.boundingBox.bounds, through = Math.hypot(...[0, 1, 2].map(k => bb[1][k] - bb[0][k])) * 2 + 10;
    const r = p.dia / 2;
    // depth 0: through the wall it starts in (a port in a box side), or through everything when asked
    const D = p.depth > 0 ? p.depth : p.thru === 'wall' ? (firstExit(o.shape, c, n, r, through) ?? through) : through /* older steps (no setting) went through all */;
    const prof = [[0, -0.01]];
    if (p.kind === 'cbore') { if (!(p.cbDia > p.dia)) return 'Counterbore Ø must be larger than the hole'; prof.push([p.cbDia / 2, -0.01], [p.cbDia / 2, p.cbDepth], [r, p.cbDepth]); }
    else if (p.kind === 'csink') { if (!(p.csDia > p.dia)) return 'Countersink Ø must be larger than the hole'; const h = (p.csDia / 2 - r) / Math.tan((p.csAngle / 2) * Math.PI / 180); prof.push([p.csDia / 2 + 0.01, -0.01], [r, h]); }
    else prof.push([r, -0.01]);
    prof.push([r, D], [0, D]);
    const offs = patternOffsets(p, fr), oe = offFaceCheck(o, f, c, offs, 'hole', ctx?.replay); if (oe) return oe;
    const tools = offs.map(({ d }) => K.revolveProfile(M.add(c, d), n, fr.a, prof));
    return cutTools(o, tools, 'Could not drill this hole');
  },
};

// ---------- drive recesses: slot, cross (Phillips-style), hex socket, square ----------
const RECESS = [['slot', 'Slot'], ['cross', 'Cross'], ['hex', 'Hex socket'], ['square', 'Square']];
export const recessOp = {
  label: p => `${(RECESS.find(r => r[0] === p.kind) || RECESS[0])[1]} recess ${fmtD(p.size)}${patternLabel(p)}`,
  defaults: () => ({ kind: 'hex', size: 4, width: 1.2, depth: 3, rot: 0, tip: true, ...patternDefaults }),
  prepare(p) { return flatFacePrep(p, 'recess'); },
  touch: p => ({ ids: [p.obj], mesh: true }),
  fields: p => [{ key: 'kind', label: 'Drive', kind: 'choice', options: RECESS, wide: true },
    lenF('size', p.kind === 'hex' ? 'Across flats' : p.kind === 'square' ? 'Side' : 'Length'),
    ...(p.kind === 'slot' || p.kind === 'cross' ? [lenF('width', 'Slot width')] : []),
    lenF('depth', 'Depth'), { key: 'rot', label: 'Rotation', kind: 'ang' },
    ...(p.kind !== 'slot' ? [{ key: 'tip', label: 'Cone at the bottom', kind: 'bool' }] : []),
    lenF('x', 'Centre X'), lenF('y', 'Centre Y'), lenF('z', 'Centre Z'), ...patternFields(p)],
  apply(p, ctx) {
    if (!(p.size > 0) || !(p.depth > 0)) return 'Size and depth must be > 0';
    if ((p.kind === 'slot' || p.kind === 'cross') && !(p.width > 0 && p.width < p.size)) return 'Slot width must be > 0 and smaller than the length';
    const o = objById(p.obj), e0 = solidOnly(o); if (e0) return e0;
    if (p._centred === 'circle') reanchorCircle(o, p);
    const before = p.faces[0].p.slice();
    const f = findFaces(o, p.faces)?.[0]; if (!f) return 'The face for the recess no longer exists';
    followCentre(p, before);
    const pe = patternCheck(p); if (pe) return pe;
    const fr = faceFrame(o, p.faces[0]), n = fr.n, c0 = ontoFace(p, fr);
    // the outline in face coordinates (x along a, y along b)
    const s = p.size, w = p.width, hs = s / 2, hw = w / 2;
    let poly;
    if (p.kind === 'slot') poly = [[-hs, -hw], [hs, -hw], [hs, hw], [-hs, hw]];
    else if (p.kind === 'square') poly = [[-hs, -hs], [hs, -hs], [hs, hs], [-hs, hs]];
    else if (p.kind === 'hex') { const R0 = s / Math.sqrt(3); poly = [...Array(6)].map((_, i) => [R0 * Math.cos(i * Math.PI / 3), R0 * Math.sin(i * Math.PI / 3)]); }
    else poly = [[hw, hw], [hs, hw], [hs, -hw], [hw, -hw], [hw, -hs], [-hw, -hs], [-hw, -hw], [-hs, -hw], [-hs, hw], [-hw, hw], [-hw, hs], [hw, hs]];
    const tipR = p.kind === 'hex' ? s / Math.sqrt(3) : p.kind === 'square' ? hs * Math.SQRT2 : hs;
    const tools = [], offs = patternOffsets(p, fr), oe = offFaceCheck(o, f, c0, offs, 'recess', ctx?.replay); if (oe) return oe;
    for (const { d, rot } of offs) {
      const t = (p.rot || 0) * Math.PI / 180 + rot, ct = Math.cos(t), st = Math.sin(t), c = M.add(c0, d);
      const P = poly.map(([x, y]) => M.add(M.add(c, M.mul(fr.a, x * ct - y * st)), M.mul(fr.b, x * st + y * ct)));
      const top = P.map(q => M.sub(q, M.mul(n, 0.01))); // start just outside the face so the cut is clean
      let tool = guard(() => K.polyPrism(top, M.mul(n, p.depth + 0.01)), 'Could not make the recess');
      if (typeof tool === 'string') return tool;
      if (p.tip && p.kind !== 'slot') { // a 118° drill-point cone under the socket
        const h = tipR / Math.tan(59 * Math.PI / 180);
        const cone = guard(() => K.revolveProfile(c, n, fr.a, [[0, p.depth - 0.01], [tipR, p.depth - 0.01], [0, p.depth + h]]), 'Could not make the recess tip');
        if (typeof cone === 'string') return cone;
        tool = tool.fuse(cone);
      }
      tools.push(tool);
    }
    return cutTools(o, tools, 'Could not cut the recess');
  },
};

// ---------- assemblies: Mate (solved again on every rebuild) ----------
// what a picked face offers for mating: a plane (normal + a point on it) or an axis (cylinder, cone, or for a
// thread / free-form round face, the nearest round edge of the body). World coordinates.
// the mate face's geometry in the part's own coordinates, cached per shape: re-solving mates during a drag only
// re-applies the placement (no face search)
const mateLocalCache = new WeakMap();
function mateLocal(o, f, pl, nl) {
  let m = mateLocalCache.get(o.shape); if (!m) { m = new Map(); mateLocalCache.set(o.shape, m); }
  const key = [...pl, ...nl].map(v => v.toFixed(7)).join() + (f.edgeAxis ? 'e' : f.planar === false ? 'c' : 'p') + (f._ax ? JSON.stringify(f._ax) : '') + (f._fh ? JSON.stringify(f._fh) : '');
  if (m.has(key)) return m.get(key);
  const r = mateLocalFind(o, f, pl, nl); m.set(key, r); return r;
}
function mateLocalFind(o, f, pl, nl) {
  if (f.edgeAxis) { // (the rim nearest the tap; once known, a rim on that same axis line wins, so a changed part keeps its hole)
    let r = null;
    if (f._ax) for (const e of o.brep?.edges || []) {
      if (e.type !== 'CIRCLE' || !e.closed || e.seam) continue;
      const a = circleOfEdge(e.pts); if (Math.abs(M.dot(a.d, f._ax.d)) < 0.999) continue;
      const dc = M.sub(a.c, f._ax.c); if (M.len(M.sub(dc, M.mul(f._ax.d, M.dot(dc, f._ax.d)))) > 1e-3) continue;
      const d = K.polyDist(pl, e.pts); if (!r || d < r.dd) r = { kind: 'axis', q: null, ...a, dd: d };
    }
    r = r || circleAxisNear(o, pl, Infinity); return r && { kind: 'axis', q: null, c: r.c, d: r.d, ax: { c: r.c, d: r.d, R: r.R } };
  }
  let hit = K.faceAt(o.shape, pl, f.planar === false ? null : nl, f.planar === false ? null : f._fh);
  if (!hit && f.planar !== false) hit = K.faceAt(o.shape, pl, nl, f._fh);
  if (hit && f.planar !== false && hit.f.geomType === 'PLANE') f._fh = K.faceHint(hit.f);
  if (!hit && f._ax) { // a round face that moved (its sketch changed): the parallel cylinder of the same radius nearest its old axis
    let best = null;
    o.shape.faces.forEach((fc, i) => {
      const cy = K.cylinderOf(fc); if (!cy || Math.abs(M.dot(cy.d, f._ax.d)) < 0.9999) return;
      const dc = M.sub(cy.c, f._ax.c), off = M.len(M.sub(dc, M.mul(f._ax.d, M.dot(dc, f._ax.d)))) + 1000 * Math.abs(cy.R - f._ax.R);
      if (!best || off < best.off) best = { off, i, f: fc };
    });
    if (best) hit = { i: best.i, f: best.f };
    else { // a thread (no cylinder left): the round edge on the same axis line, nearest the old radius
      let be = null;
      for (const a of circleAxes(o)) {
        if (Math.abs(M.dot(a.d, f._ax.d)) < 0.999) continue;
        const dc = M.sub(a.c, f._ax.c), off = M.len(M.sub(dc, M.mul(f._ax.d, M.dot(dc, f._ax.d))));
        const sc = off + 0.1 * Math.abs(a.R - (f._ax.R || 0));
        if (!be || sc < be.sc) be = { sc, a };
      }
      if (be && be.sc < Math.max(5, 2 * (f._ax.R || 0))) return { kind: 'axis', q: null, c: be.a.c, d: be.a.d, ax: { c: be.a.c, d: be.a.d, R: be.a.R } };
    }
  }
  if (!hit) return null;
  const q = hit.q || null;
  if (hit.f.geomType === 'PLANE') { // the exact plane (not the float32 tap point)
    const fn = hit.f.normalAt(), c0 = hit.f.center, c = typeof c0 === 'function' ? c0() : c0;
    return { kind: 'plane', q, n: M.norm([fn.x, fn.y, fn.z]), p: [c.x, c.y, c.z] };
  }
  const cy = K.cylinderOf(hit.f) || K.coneAxis(hit.f) || K.revolutionAxis(hit.f);
  if (cy) return { kind: 'axis', q, c: cy.c, d: cy.d, ax: cy.R ? { c: cy.c, d: cy.d, R: cy.R } : null };
  const r = circleAxisNear(o, pl, Infinity); return r ? { ...r, q, ax: { c: r.c, d: r.d, R: r.R } } : null;
}
// every round (closed circular) edge's axis, in the part's coordinates
function circleAxes(o) {
  return (o.brep?.edges || []).filter(e => e.type === 'CIRCLE' && e.closed && !e.seam).map(e => circleOfEdge(e.pts));
}
function circleOfEdge(pts) {
  const qq = pts.slice(0, -1), c = [0, 1, 2].map(k => qq.reduce((s, v) => s + v[k], 0) / qq.length);
  return { c, d: M.norm(M.cross(M.sub(qq[0], c), M.sub(qq[Math.floor(qq.length / 4)], c))), R: M.len(M.sub(qq[0], c)) };
}
// the axis of the round (closed circular) edge nearest a point in the part's coordinates, within maxD
export function circleAxisNear(o, pl, maxD) {
  let best = null;
  for (const e of o.brep?.edges || []) {
    if (e.type !== 'CIRCLE' || !e.closed || e.seam) continue;
    const d = K.polyDist(pl, e.pts); if (d <= maxD && (!best || d < best.d)) best = { d, e };
  }
  if (!best) return null;
  return { kind: 'axis', q: null, ...circleOfEdge(best.e.pts) };
}
export function mateGeom(f) {
  const o = objById(f.obj); if (!o || !o.shape) return null;
  // a mate's faces are kept in the part's own coordinates (lp, ln), so they ride along when the part moves
  const xf = xfFor(o), pl = f.lp || xf.toL(f.p), nl = f.ln || locDir(xf, f.p, f.n);
  const L = mateLocal(o, f, pl, nl); if (!L) return null;
  if (L.q) { const pw = xf.toW(L.q); Object.assign(f, { p: pw, w: M.dot(f.n, pw) }); } // follow a moved face
  const toWd = d => M.norm(M.sub(xf.toW(M.add(pl, d)), xf.toW(pl)));
  if (L.kind === 'plane') return { kind: 'plane', o, n: toWd(L.n), p: xf.toW(L.p) };
  if (L.ax) f._ax = L.ax;
  return { kind: 'axis', o, c: xf.toW(L.c), d: toWd(L.d) };
}
// the move that puts face a onto face b: { v, kind } or an error message
export function mateSolve(a, b, gap = 0) {
  const A = mateGeom(a), B = mateGeom(b);
  if (!A || !B) return 'Mate works with flat and round faces';
  if (A.kind === 'plane' && B.kind === 'plane') {
    if (Math.abs(M.dot(A.n, B.n)) < 0.9999) return 'Those faces are not parallel (rotate the part first)';
    return { kind: 'plane', v: M.mul(B.n, M.dot(B.n, M.sub(B.p, A.p)) + gap) }; // slide along the normal onto the other plane (a gap stands it off)
  }
  if (A.kind === 'axis' && B.kind === 'axis') {
    if (Math.abs(M.dot(A.d, B.d)) < 0.9999) return 'Those axes are not parallel (rotate the part first)';
    const dc = M.sub(B.c, A.c); return { kind: 'axis', v: M.sub(dc, M.mul(B.d, M.dot(dc, B.d))) }; // onto the same axis
  }
  return 'Mate a flat face to a flat face, or a round face to a round face';
}
// solve one mate: turn the moving part if needed, then slide it into place (a constraint: solved again on
// every edit and rebuild, so moving the fixed part carries the mated one with it)
function solveMate(p) {
  const o = objById(p.a.obj); if (!o) return 'The part it moves no longer exists';
  if (!objById(p.b.obj)) return 'The part it mates to no longer exists';
  for (const f of [p.a, p.b]) if (!f.lp) { const ob = objById(f.obj), x = xfFor(ob); f.lp = x.toL(f.p); f.ln = locDir(x, f.p, f.n); }
  const A0 = mateGeom(p.a), B0 = mateGeom(p.b);
  if (A0 && B0 && A0.kind === B0.kind) {
    const da = A0.kind === 'plane' ? A0.n : A0.d, db = B0.kind === 'plane' ? B0.n : B0.d, k = M.dot(da, db);
    // flat faces: face to face (normals opposed — the part is turned round if both face the same way) or flush
    // (same way: tops level); older mates (no choice stored) keep the nearer of the two
    const tgt = A0.kind === 'plane' ? (p.align === 'flush' || (!p.align && k > 0.9999) ? db : M.mul(db, -1)) : (k >= 0 ? db : M.mul(db, -1));
    if (M.dot(da, tgt) < 0.9999) turnObject(o, da, tgt, A0.kind === 'plane' ? A0.p : A0.c);
  }
  const r = mateSolve(p.a, p.b, +p.gap || 0); if (typeof r === 'string') return r;
  if (M.len(r.v) > 1e-12) o.loc = M.add(o.loc, r.v).map(v => (Math.abs(v - Math.round(v * 1e9) / 1e9) < 1e-9 ? Math.round(v * 1e9) / 1e9 : v));
}
export const mateOp = {
  constraint: 'F.mateOp',
  label: p => `Mate ${objById(p.a.obj)?.name || 'part'} → ${objById(p.b.obj)?.name || 'part'}${p.b.edgeAxis || p.a.edgeAxis || mateGeom(p.b)?.kind === 'axis' ? ' (axis)' : ` (${p.align === 'flush' ? 'flush' : 'flat'}${+p.gap ? ', gap ' + fmtLen(+p.gap) : ''})`}`,
  touch: p => ({ ids: [p.a.obj], mesh: false }),
  // flat-to-flat mates take a gap: a clearance (0.5 mm round a drawer), or − to overlap
  fields: p => (mateGeom(p.a)?.kind === 'plane' ? [{ key: 'align', label: 'Faces', kind: 'choice', options: [['face', 'Face to face'], ['flush', 'Flush']], wide: true }, lenF('gap', 'Gap (− overlaps)')] : []),
  apply(p) { return solveMate(p); },
};
// would mate p (p.a's part moves onto p.b's) close a loop with the mates in list? (p.b's part already depends on p.a's)
export function mateLoop(list, p) {
  const dep = new Map(); for (const q of list) { if (!dep.has(q.a.obj)) dep.set(q.a.obj, []); dep.get(q.a.obj).push(q.b.obj); }
  const seen = new Set(), stack = [p.b.obj];
  while (stack.length) { const x = stack.pop(); if (x === p.a.obj) return true; if (seen.has(x)) continue; seen.add(x); stack.push(...(dep.get(x) || [])); }
  return false;
}
// re-solve every mate in the history (after any edit), in order, twice so chains of mates settle
export function solveMates(recs) {
  let ms = recs.filter(r => r.op === 'F.mateOp' && !r.off && (!r.err || r.conflict));
  if (!ms.length) return;
  for (const r of ms) if (r.conflict) { delete r.err; r.conflict = false; }
  // a mate whose fixed part already hangs (through other mates) off the part it moves makes a loop: the parts
  // would chase each other — it is left out and flagged
  const kept = [];
  for (const r of ms) {
    if (mateLoop(kept.map(k => k.params), r.params)) { r.err = 'Makes a loop with other mates (each part would move the other) — mate them the other way round'; r.conflict = true; }
    else kept.push(r);
  }
  ms = kept;
  // earlier mates win: after each mate, the part's earlier mates are solved again (latest to earliest), so a new
  // mate that contradicts them is the one left unsatisfied (and flagged), not the hinge that was there first
  const solve = r => { try { solveMate(r.params); } catch (e) { /* keep the part where it is */ } };
  for (let pass = 0; pass < 2; pass++) ms.forEach((r, i) => { solve(r); for (let j = i - 1; j >= 0; j--) if (ms[j].params.a.obj === r.params.a.obj) solve(ms[j]); });
  // a mate left unsatisfied fights another one: say so on its step (red in History) instead of failing silently
  for (const r of ms) {
    let off = 0, msg = ''; try { const v = mateSolve(r.params.a, r.params.b, +r.params.gap || 0); if (typeof v === 'string') { if (/not parallel/.test(v)) msg = 'Conflicts with another mate (its faces are no longer parallel) — delete or edit one of them'; } else off = M.len(v.v); } catch (e) {}
    if (off > 1e-6) msg = `Conflicts with another mate (${fmtLen(off)} off) — delete or edit one of them`;
    if (msg) { r.err = msg; r.conflict = true; }
  }
}

// ---------- assemblies: linked components ----------
// S.doc.components[pid] = { name, version, brep } — a copy of another project's solids. An inserted
// component is a solid object with o.link = { pid }; it is placed with Move/Rotate and stays read-only
// here (open its project to change it, then Sync to bring the new version in).
const compCache = new Map();
export function componentShape(pid) {
  const c = (S.doc.components || {})[pid]; if (!c || !c.brep) return null;
  const key = pid + '@' + c.version;
  if (!compCache.has(key)) compCache.set(key, K.deserialize(c.brep));
  return compCache.get(key);
}
export const insertComponent = {
  label: p => `Insert ${(S.doc.components || {})[p.pid]?.name || 'component'}`,
  defaults: () => ({ x: 0, y: 0, z: 0 }),
  prepare(p) { if (!(S.doc.components || {})[p.pid]) return 'That project has no solids to insert'; p._id ??= S.doc.nextId; },
  touch: () => ({ ids: [] }),
  fields: () => [lenF('x', 'Position X'), lenF('y', 'Position Y'), lenF('z', 'Position Z')],
  apply(p) {
    const s = componentShape(p.pid); if (!s) return 'The component’s project data is missing';
    const c = S.doc.components[p.pid];
    const o = newObject(c.name, null, [p.x, p.y, p.z], p._id);
    K.setShape(o, s); o.link = { pid: p.pid };
    S.doc.objects.push(o);
    S.ed.selected = new Set([o.id]); S.ed.active = o.id;
  },
};
export const isLinked = o => !!(o && o.link);

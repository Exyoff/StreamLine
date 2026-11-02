// Feature edges of bodies + 3D edge fillet / chamfer via CSG cutters.
import * as M from './mesh.js';
import { PolyMesh } from './mesh.js';
import { toPolys, boolean, polysToMesh } from './csg.js';

// Edges between faces whose normals differ (or open edges). World-space vertices W.
export function featureEdges(W, faces, angTol = 1e-6) {
  const normals = faces.map(f => M.faceNormal(f.map(i => W[i])));
  const map = new Map();
  faces.forEach((f, fi) => f.forEach((a, i) => { const b = f[(i + 1) % f.length], k = M.edgeKey(a, b); (map.get(k) || map.set(k, { a: Math.min(a, b), b: Math.max(a, b), f: [] }).get(k)).f.push(fi); }));
  const out = [];
  for (const e of map.values()) {
    if (e.f.length !== 2 || M.dot(normals[e.f[0]], normals[e.f[1]]) < 1 - angTol) out.push(e);
  }
  return out;
}

// Grow a picked segment into the maximal straight run of collinear feature edges.
export function straightRun(W, fedges, a, b) {
  const adj = new Map();
  for (const e of fedges) { (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b); (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a); }
  const dir = M.norm(M.sub(W[b], W[a]));
  const walk = (from, prev) => {
    let cur = from, p = prev;
    for (let guard = 0; guard < 1e5; guard++) {
      const nx = (adj.get(cur) || []).filter(n => n !== p && Math.abs(Math.abs(M.dot(M.norm(M.sub(W[n], W[cur])), dir)) - 1) < 1e-9);
      if (nx.length !== 1) return cur;
      p = cur; cur = nx[0];
    }
    return cur;
  };
  return [W[walk(a, b)].slice(), W[walk(b, a)].slice()];
}

// The two planar faces meeting along segment AB (world). Returns {n1, n2, c1, c2} or error string.
function adjacentFaces(W, faces, A, B) {
  const e = M.norm(M.sub(B, A)), L = M.dist(A, B), tol = 1e-5;
  const onLine = p => { const w = M.sub(p, A), t = M.dot(w, e); return M.len(M.sub(w, M.mul(e, t))) < tol ? t : null; };
  const groups = [];
  faces.forEach(f => {
    const P = f.map(i => W[i]);
    for (let i = 0; i < P.length; i++) {
      const t0 = onLine(P[i]), t1 = onLine(P[(i + 1) % P.length]);
      if (t0 == null || t1 == null) continue;
      if (Math.min(t0, t1) > L - tol || Math.max(t0, t1) < tol || Math.abs(t1 - t0) < tol) continue;
      const n = M.faceNormal(P);
      let g = groups.find(q => M.dot(q.n, n) > 1 - 1e-6);
      if (!g) groups.push(g = { n, pts: [] });
      g.pts.push(...P);
      break;
    }
  });
  if (groups.length !== 2) return `Edge must join exactly two flat faces (found ${groups.length})`;
  return groups.map(g => ({ n: g.n, c: M.centroid(g.pts) }));
}

// Cross-section in the plane perpendicular to the edge, then a prism from A to B.
function prism(section, e, L) {
  const n = section.length;
  const v = [...section.map(p => p.slice()), ...section.map(p => M.add(p, M.mul(e, L)))];
  const f = [[...Array(n).keys()].reverse(), [...Array(n).keys()].map(i => i + n)];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push([i, j, j + n, i + n]); }
  const m = new PolyMesh(v, f);
  M.recalcNormals(m);
  return m;
}

// Apply a fillet (radius) or chamfer (distance) to straight edge AB of a world-space body.
// Returns new world-space PolyMesh, or an error string.
export function edgeBlend(W, faces, A, B, size, kind, segs = 16, size2 = null, swap = false) {
  const adj = adjacentFaces(W, faces, A, B);
  if (typeof adj === 'string') return adj;
  const e = M.norm(M.sub(B, A)), L = M.dist(A, B);
  // in-face directions perpendicular to the edge, pointing away from it into each face
  const inFace = f => { let w = M.norm(M.cross(f.n, e)); if (M.dot(M.sub(f.c, A), w) < 0) w = M.mul(w, -1); return w; };
  let w1 = inFace(adj[0]), w2 = inFace(adj[1]);
  const n1 = adj[0].n;
  if (swap) [w1, w2] = [w2, w1];
  const convex = M.dot(swap ? w1 : w2, n1) < 0;
  const phi = Math.acos(Math.max(-1, Math.min(1, M.dot(w1, w2))));
  if (phi < 1e-6 || Math.PI - phi < 1e-6) return 'Faces are tangent — nothing to blend';
  let sec;
  if (kind === 'chamfer') sec = [A, M.add(A, M.mul(w1, size)), M.add(A, M.mul(w2, size2 ?? size))];
  else {
    const t = size / Math.tan(phi / 2);
    const bis = M.norm(M.add(w1, w2)), C = M.add(A, M.mul(bis, size / Math.sin(phi / 2)));
    const T1 = M.add(A, M.mul(w1, t)), T2 = M.add(A, M.mul(w2, t));
    const r1 = M.norm(M.sub(T1, C)), r2 = M.norm(M.sub(T2, C));
    const sweep = Math.PI - phi, axis = M.norm(M.cross(r1, r2));
    sec = [A, T1];
    const k = Math.max(2, Math.round(segs * sweep / (Math.PI / 2)));
    for (let i = 1; i < k; i++) {
      const a = sweep * i / k, c = Math.cos(a), s = Math.sin(a);
      // rotate r1 about axis by a (Rodrigues; r1 ⟂ axis)
      sec.push(M.add(C, M.mul(M.add(M.mul(r1, c), M.mul(M.cross(axis, r1), s)), size)));
    }
    sec.push(T2);
    const tmax = t;
    void tmax;
  }
  const tool = prism(sec, e, L);
  const res = boolean(convex ? 'subtract' : 'union', toPolys(W, faces), toPolys(tool.v, tool.f));
  const m = polysToMesh(res);
  if (!m.f.length) return 'Blend failed';
  return m;
}

// Directions into each adjacent face, perpendicular to edge AB, plus convexity (for handles).
export function edgeFrame(W, faces, A, B) {
  const adj = adjacentFaces(W, faces, A, B);
  if (typeof adj === 'string') return adj;
  const e = M.norm(M.sub(B, A));
  const inFace = f => { let w = M.norm(M.cross(f.n, e)); if (M.dot(M.sub(f.c, A), w) < 0) w = M.mul(w, -1); return w; };
  const w1 = inFace(adj[0]), w2 = inFace(adj[1]);
  return { w1, w2, convex: M.dot(w2, adj[0].n) < 0 };
}

// ---------- round edges (circular loops: rims of bosses and holes) ----------
// From a picked segment, follow feature edges that turn gently in one plane; if they close into a
// circle, return { loop: [points], c, n, R }.
export function edgeLoop(W, fedges, a, b) {
  const adj = new Map();
  for (const e of fedges) { (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b); (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a); }
  const loop = [a, b];
  for (let guard = 0; guard < 4096; guard++) {
    const prev = loop[loop.length - 2], cur = loop[loop.length - 1];
    const d0 = M.norm(M.sub(W[cur], W[prev]));
    const nx = (adj.get(cur) || []).filter(n => n !== prev).map(n => ({ n, cos: M.dot(d0, M.norm(M.sub(W[n], W[cur]))) })).filter(q => q.cos > Math.cos(Math.PI / 4));
    if (nx.length !== 1) return null;
    if (nx[0].n === loop[0]) break;
    loop.push(nx[0].n);
  }
  if (loop.length < 6) return null;
  const P = loop.map(i => W[i]), c = M.centroid(P), n = M.norm(M.newell(P));
  const R = M.dist(P[0], c);
  if (P.some(p => Math.abs(M.dist(p, c) - R) > 1e-4 * Math.max(1, R) || Math.abs(M.dot(M.sub(p, c), n)) > 1e-5)) return null;
  return { loop: P, c, n, R };
}

// Fillet / chamfer a circular edge between a flat cap and a cylindrical wall, by revolving
// the corner profile about the cylinder axis (aligned with the body's facets).
import { revolveRegions } from './csg.js';
export function circleBlend(W, faces, circ, size, kind, segs90 = 8) {
  const A = circ.loop[0], B = circ.loop[1];
  const fr = edgeFrame(W, faces, A, B);
  if (typeof fr === 'string') return fr;
  // which adjacent face is the cap (normal ∥ axis)?
  const capIsFirst = Math.abs(M.dot(fr.w1, circ.n)) < 1e-6;
  const wCap = capIsFirst ? fr.w1 : fr.w2, wWall = capIsFirst ? fr.w2 : fr.w1;
  if (Math.abs(M.dot(wCap, circ.n)) > 1e-6 || Math.abs(Math.abs(M.dot(wWall, circ.n)) - 1) > 1e-3) return 'Only edges between a flat face and a cylindrical wall can be rounded';
  const u = M.norm(M.sub(A, circ.c));
  const s1 = Math.sign(M.dot(wCap, u)) || 1;         // along the cap: +1 away from the axis, −1 toward it
  const s2 = Math.sign(M.dot(wWall, circ.n)) || 1;   // along the wall: +1 / −1 along the axis
  const R = circ.R, r = size;
  if (s1 < 0 && r >= R) return 'Radius too large for this edge';
  const Ap = [R, 0], T1 = [R + s1 * r, 0], T2 = [R, s2 * r];
  let sec;
  if (kind === 'chamfer') sec = [Ap, T1, T2];
  else {
    const C = [R + s1 * r, s2 * r], k = Math.max(2, Math.round(segs90));
    sec = [Ap, T1];
    const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
    let d = a2 - a1; d = Math.atan2(Math.sin(d), Math.cos(d));
    for (let i = 1; i < k; i++) sec.push([C[0] + r * Math.cos(a1 + d * i / k), C[1] + r * Math.sin(a1 + d * i / k)]);
    sec.push(T2);
  }
  const pl = { o: circ.c, u, v: circ.n, n: M.cross(u, circ.n) };
  const tool = revolveRegions([{ outer: sec, holes: [] }], pl, 'y', 360, circ.loop.length);
  const res = polysToMesh(boolean(fr.convex ? 'subtract' : 'union', toPolys(W, faces), toPolys(tool.v, tool.f)));
  return res.f.length ? res : 'Blend failed';
}

// Round the corner where three filleted edges meet at right angles: subtract (corner box − sphere),
// leaving a spherical patch instead of the mitred "tri-cylinder" bump. dirs: unit vectors from the
// corner along the three edges.
import { makeSphere } from './mesh.js';
export function sphereCorner(W, faces, V, dirs, r, segs90 = 8) {
  const [d1, d2, d3] = dirs;
  if (Math.abs(M.dot(d1, d2)) > 1e-6 || Math.abs(M.dot(d1, d3)) > 1e-6 || Math.abs(M.dot(d2, d3)) > 1e-6) return null;
  const C = M.add(V, M.mul(M.add(M.add(d1, d2), d3), r));
  const box = [];
  for (const c of [0, 1]) for (const b of [0, 1]) for (const a of [0, 1]) box.push(M.add(V, M.add(M.add(M.mul(d1, a * r * 1.0001), M.mul(d2, b * r * 1.0001)), M.mul(d3, c * r * 1.0001))));
  const bf = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const bm = new PolyMesh(box, bf); M.recalcNormals(bm);
  const n = Math.max(8, segs90 * 4), sp = makeSphere(r, n, Math.max(4, n / 2));
  // orient the sphere's frame to the corner axes (poles along d3) and move it to C
  const sv = sp.v.map(p => M.add(C, M.add(M.add(M.mul(d1, p[0]), M.mul(d2, p[1])), M.mul(d3, p[2]))));
  if (M.dot(M.cross(d1, d2), d3) < 0) sp.f.forEach(f => f.reverse());
  const cutter = boolean('subtract', toPolys(bm.v, bm.f), toPolys(sv, sp.f));
  // the sphere touches the fillets tangentially, which leaves micron slivers: weld them away
  const res = polysToMesh(boolean('subtract', toPolys(W, faces), cutter), { weld: 2e-3 });
  return res.f.length ? res : null;
}

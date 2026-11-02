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
export function edgeBlend(W, faces, A, B, size, kind, segs = 16) {
  const adj = adjacentFaces(W, faces, A, B);
  if (typeof adj === 'string') return adj;
  const e = M.norm(M.sub(B, A)), L = M.dist(A, B);
  // in-face directions perpendicular to the edge, pointing away from it into each face
  const inFace = f => { let w = M.norm(M.cross(f.n, e)); if (M.dot(M.sub(f.c, A), w) < 0) w = M.mul(w, -1); return w; };
  const w1 = inFace(adj[0]), w2 = inFace(adj[1]);
  const convex = M.dot(w2, adj[0].n) < 0;
  const phi = Math.acos(Math.max(-1, Math.min(1, M.dot(w1, w2))));
  if (phi < 1e-6 || Math.PI - phi < 1e-6) return 'Faces are tangent — nothing to blend';
  let sec;
  if (kind === 'chamfer') sec = [A, M.add(A, M.mul(w1, size)), M.add(A, M.mul(w2, size))];
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

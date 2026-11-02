// Plasticity-style solid modifiers on world-space meshes: face regions, push/pull (offset face),
// shell, mirror. All results go through the double-precision CSG clean-up, so they stay watertight.
import * as M from './mesh.js';
import { PolyMesh } from './mesh.js';
import { toPolys, boolean, polysToMesh, extrudeRegions } from './csg.js';
import { pointInPoly } from './sketch.js';

const planeOf = (W, f) => { const n = M.faceNormal(f.map(i => W[i])); return { n, w: M.dot(n, W[f[0]]) }; };
const samePlane = (a, b) => M.dot(a.n, b.n) > 1 - 1e-9 && Math.abs(a.w - b.w) < 1e-6;

// All faces edge-connected to `fi` that lie in the same plane (a "face" as a CAD user sees it).
export function faceRegion(W, faces, fi) {
  const pl = planeOf(W, faces[fi]);
  const edgeFaces = new Map();
  faces.forEach((f, i) => f.forEach((a, k) => { const key = M.edgeKey(a, f[(k + 1) % f.length]); (edgeFaces.get(key) || edgeFaces.set(key, []).get(key)).push(i); }));
  const seen = new Set([fi]), out = [fi];
  for (let q = 0; q < out.length; q++) {
    const f = faces[out[q]];
    for (let k = 0; k < f.length; k++) for (const g of edgeFaces.get(M.edgeKey(f[k], f[(k + 1) % f.length]))) {
      if (!seen.has(g) && samePlane(pl, planeOf(W, faces[g]))) { seen.add(g); out.push(g); }
    }
  }
  return { faces: out, n: pl.n, w: pl.w };
}
// Find the region again from a stored plane + a point on it (face indices change after every operation).
export function findRegion(W, faces, n, w, point) {
  let best = null;
  faces.forEach((f, i) => {
    const pl = planeOf(W, f);
    if (!samePlane(pl, { n, w })) return;
    const d = M.dist(M.centroid(f.map(j => W[j])), point);
    if (!best || d < best.d) best = { i, d };
  });
  return best ? faceRegion(W, faces, best.i) : null;
}
export function regionCentroid(W, faces, reg) {
  let A = 0, c = [0, 0, 0];
  for (const fi of reg.faces) { const P = faces[fi].map(i => W[i]), a = M.faceArea(P); c = M.add(c, M.mul(M.centroid(P), a)); A += a; }
  return A > 0 ? M.mul(c, 1 / A) : W[faces[reg.faces[0]][0]];
}

// Boundary of a planar region as 2D regions {outer, holes} in a plane basis.
function regionProfile(W, faces, reg) {
  const set = new Set(reg.faces), dir = new Set(), next = new Map();
  for (const fi of reg.faces) { const f = faces[fi]; f.forEach((a, k) => dir.add(a + '>' + f[(k + 1) % f.length])); }
  for (const fi of reg.faces) { const f = faces[fi]; f.forEach((a, k) => { const b = f[(k + 1) % f.length]; if (!dir.has(b + '>' + a)) next.set(a, b); }); }
  void set;
  const loops = [], used = new Set();
  for (const s of next.keys()) {
    if (used.has(s)) continue;
    const loop = []; let c = s;
    while (c !== undefined && !used.has(c)) { used.add(c); loop.push(c); c = next.get(c); }
    if (loop.length >= 3) loops.push(loop);
  }
  const n = reg.n, u = M.norm(Math.abs(n[0]) < 0.9 ? M.cross(n, [1, 0, 0]) : M.cross(n, [0, 1, 0])), v = M.cross(n, u);
  const o = W[loops[0][0]];
  const pl = { o, u, v, n };
  const to2 = p => { const d = M.sub(p, o); return [M.dot(d, u), M.dot(d, v)]; };
  const area = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const P2 = loops.map(l => l.map(i => to2(W[i])));
  const outers = P2.filter(p => area(p) > 0).map(p => ({ outer: p, holes: [], area: area(p) }));
  for (const h of P2.filter(p => area(p) < 0)) {
    const host = outers.filter(r => pointInPoly(h[0], r.outer)).sort((a, b) => a.area - b.area)[0];
    if (host) host.holes.push(h);
  }
  return { pl, regs: outers };
}

// Push/pull (Plasticity "offset face"): move a planar face along its normal by `dist`
// — positive adds material, negative removes it.
export function pushPull(W, faces, reg, dist) {
  if (Math.abs(dist) < 1e-9) return 'Distance must not be zero';
  const { pl, regs } = regionProfile(W, faces, reg);
  if (!regs.length) return 'Face boundary not found';
  const tool = extrudeRegions(regs, pl, 0, dist);
  const res = polysToMesh(boolean(dist > 0 ? 'union' : 'subtract', toPolys(W, faces), toPolys(tool.v, tool.f)));
  return res.f.length ? res : 'Result is empty';
}

// Shell: hollow the body with wall thickness t, opening the given regions (may be empty → closed hollow).
// The inner surface offsets every face plane by t (vertex positions solved exactly from their planes).
export function shell(W, faces, openRegs, t) {
  if (!(t > 0)) return 'Thickness must be > 0';
  const fPlanes = faces.map(f => planeOf(W, f));
  const open = new Set(openRegs.flatMap(r => r.faces));
  const inc = W.map(() => []);
  faces.forEach((f, fi) => f.forEach(i => inc[i].push(fi)));
  const V = W.map((p, i) => {
    const planes = [];
    for (const fi of inc[i]) {
      const pl = fPlanes[fi];
      if (planes.some(q => M.dot(q.n, pl.n) > 1 - 1e-9)) continue;
      planes.push({ n: pl.n, w: pl.w + (open.has(fi) ? t : -t) });
    }
    // closest point to p satisfying every plane: x = p + Nᵀ (N Nᵀ)⁻¹ (w − N p)
    const k = planes.length, G = planes.map(a => planes.map(b => M.dot(a.n, b.n)));
    for (let a = 0; a < k; a++) G[a][a] += 1e-12;
    const rhs = planes.map(q => q.w - M.dot(q.n, p));
    const y = solve(G, rhs);
    let x = p.slice();
    planes.forEach((q, a) => { x = M.add(x, M.mul(q.n, y[a])); });
    return x;
  });
  const inner = new PolyMesh(V, faces.map(f => f.slice()));
  const vol = M.meshVolume(inner);
  if (!(vol > 0) || vol >= M.meshVolume(new PolyMesh(W, faces))) return 'Thickness too large for this body';
  const res = polysToMesh(boolean('subtract', toPolys(W, faces), toPolys(inner.v, inner.f)));
  return res.f.length ? res : 'Shell failed';
}
function solve(A, b) {
  const n = b.length, Mx = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r;
    [Mx[c], Mx[p]] = [Mx[p], Mx[c]];
    if (Math.abs(Mx[c][c]) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) { const f = Mx[r][c] / Mx[c][c]; for (let k = c; k <= n; k++) Mx[r][k] -= f * Mx[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = Mx[r][n]; for (let k = r + 1; k < n; k++) s -= Mx[r][k] * x[k]; x[r] = Math.abs(Mx[r][r]) > 1e-14 ? s / Mx[r][r] : 0; }
  return x;
}

// Mirror across the plane n·x = w; optionally fused with the original.
export function mirrorMesh(W, faces, n, w, fuse) {
  const R = W.map(p => { const d = M.dot(n, p) - w; return M.sub(p, M.mul(n, 2 * d)); });
  const F = faces.map(f => f.slice().reverse());
  if (!fuse) return new PolyMesh(R, F);
  const res = polysToMesh(boolean('union', toPolys(W, faces), toPolys(R, F)));
  return res.f.length ? res : 'Mirror failed';
}


// Slice a body with the plane n·x = w. Returns { pos, neg } meshes (either may be empty).
export function slice(W, faces, n, w) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of W) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const R = M.dist(lo, hi) * 2 + 10, c0 = M.mul(M.add(lo, hi), 0.5);
  // a big box on the positive side of the plane
  const u = M.norm(Math.abs(n[0]) < 0.9 ? M.cross(n, [1, 0, 0]) : M.cross(n, [0, 1, 0])), v = M.cross(n, u);
  const o = M.add(c0, M.mul(n, w - M.dot(n, c0)));
  const P = (a, b, h) => M.add(M.add(o, M.mul(u, a * R)), M.add(M.mul(v, b * R), M.mul(n, h * R)));
  const V = [P(-1, -1, 0), P(1, -1, 0), P(1, 1, 0), P(-1, 1, 0), P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
  const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const A = toPolys(W, faces), H = toPolys(V, F);
  return { pos: polysToMesh(boolean('intersect', A, H)), neg: polysToMesh(boolean('subtract', A, H)) };
}

// Rotate copies of a mesh about an axis (point c, unit direction a) — polar array helper.
export function rotateMesh(W, c, a, deg) {
  const t = deg * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
  return W.map(p => {
    const v = M.sub(p, c), d = M.dot(a, v);
    const r = M.add(M.add(M.mul(v, co), M.mul(M.cross(a, v), si)), M.mul(a, d * (1 - co)));
    return M.add(c, r);
  });
}


// Thicken an open surface (e.g. a plane) into a solid of thickness t, offset against its normals.
export function thicken(W, faces, t) {
  if (!(t > 0)) return 'Thickness must be > 0';
  const dir = new Set(); faces.forEach(f => f.forEach((a, k) => dir.add(a + '>' + f[(k + 1) % f.length])));
  const boundary = [];
  faces.forEach(f => f.forEach((a, k) => { const b = f[(k + 1) % f.length]; if (!dir.has(b + '>' + a)) boundary.push([a, b]); }));
  if (!boundary.length) return 'This body is already closed — use Shell to hollow it';
  const fPlanes = faces.map(f => { const n = M.faceNormal(f.map(i => W[i])); return { n, w: M.dot(n, W[f[0]]) }; });
  const inc = W.map(() => []); faces.forEach((f, fi) => f.forEach(i => inc[i].push(fi)));
  const n0 = W.length;
  const back = W.map((p, i) => {
    const planes = [];
    for (const fi of inc[i]) { const pl = fPlanes[fi]; if (!planes.some(q => M.dot(q.n, pl.n) > 1 - 1e-9)) planes.push({ n: pl.n, w: pl.w - t }); }
    if (!planes.length) return p.slice();
    const k = planes.length, G = planes.map(a => planes.map(b => M.dot(a.n, b.n)));
    for (let a = 0; a < k; a++) G[a][a] += 1e-12;
    const y = solve(G, planes.map(q => q.w - M.dot(q.n, p)));
    let x = p.slice(); planes.forEach((q, a) => { x = M.add(x, M.mul(q.n, y[a])); });
    return x;
  });
  const V = [...W.map(p => p.slice()), ...back];
  const F = [...faces.map(f => f.slice()), ...faces.map(f => f.map(i => i + n0).reverse())];
  for (const [a, b] of boundary) F.push([b, a, a + n0, b + n0]);
  const m = new PolyMesh(V, F);
  M.recalcNormals(m);
  const res = polysToMesh(toPolys(m.v, m.f));
  return res.f.length ? res : 'Thicken failed';
}

// Polygon mesh with double-precision vertices (plain JS numbers = float64).
// Faces are arrays of vertex indices, counter-clockwise when viewed from outside.
import * as THREE from 'three';

export class PolyMesh {
  constructor(v = [], f = []) { this.v = v; this.f = f; }
  clone() { return new PolyMesh(this.v.map(p => p.slice()), this.f.map(f => f.slice())); }
  toJSON() { return { v: this.v, f: this.f }; }
  static from(o) { return new PolyMesh(o.v.map(p => p.slice()), o.f.map(f => f.slice())); }
}

// ---------- vector helpers (arrays) ----------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a); return l > 1e-15 ? mul(a, 1 / l) : [0, 0, 0]; };
export const dist = (a, b) => len(sub(a, b));

export const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

// Newell normal; length = 2 * area
export function newell(pts) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}
export function faceNormal(pts) { return norm(newell(pts)); }
export function faceArea(pts) { return len(newell(pts)) / 2; }
export function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return pts.length ? mul(c, 1 / pts.length) : c;
}

export function meshEdges(m) {
  const seen = new Map();
  for (const f of m.f) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length], k = edgeKey(a, b);
    if (!seen.has(k)) seen.set(k, a < b ? [a, b] : [b, a]);
  }
  return [...seen.values()];
}

// Triangulate one polygon -> list of [i,j,k] indices into the face's vertex list.
const _v2 = [];
export function triangulateFace(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const N = newell(pts);
  // convex fast path
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    if (dot(cross(sub(b, a), sub(c, b)), N) < -1e-12) convex = false;
  }
  if (convex) { const t = []; for (let i = 1; i < n - 1; i++) t.push([0, i, i + 1]); return t; }
  // project to dominant plane and ear clip via three.js
  const ax = Math.abs(N[0]), ay = Math.abs(N[1]), az = Math.abs(N[2]);
  let u = 0, w = 1;
  if (ax >= ay && ax >= az) { u = 1; w = 2; } else if (ay >= az) { u = 2; w = 0; }
  const contour = pts.map(p => new THREE.Vector2(p[u], p[w]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  return tris.map(([a, b, c]) => {
    const tn = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    return dot(tn, N) < 0 ? [a, c, b] : [a, b, c];
  });
}

// ---------- primitives (Z up, centred on origin) ----------
export function makeBox(w, d, h) {
  const x = w / 2, y = d / 2, z = h / 2;
  return new PolyMesh(
    [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]],
    [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]);
}
export function makePlane(w, d) {
  const x = w / 2, y = d / 2;
  return new PolyMesh([[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]], [[0, 1, 2, 3]]);
}
export function makeCone(r1, r2, h, n, caps = true) {
  n = Math.max(3, Math.round(n));
  const v = [], f = [], z0 = -h / 2, z1 = h / 2;
  const ring = (r, z) => { const s = v.length; for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; v.push([r * Math.cos(a), r * Math.sin(a), z]); } return s; };
  const b = r1 > 0 ? ring(r1, z0) : (v.push([0, 0, z0]), v.length - 1);
  const t = r2 > 0 ? ring(r2, z1) : (v.push([0, 0, z1]), v.length - 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (r1 > 0 && r2 > 0) f.push([b + i, b + j, t + j, t + i]);
    else if (r2 <= 0) f.push([b + i, b + j, t]);
    else f.push([b, t + j, t + i]);
  }
  if (caps) {
    if (r2 > 0) f.push([...Array(n).keys()].map(i => t + i));
    if (r1 > 0) f.push([...Array(n).keys()].map(i => b + n - 1 - i));
  }
  return new PolyMesh(v, f);
}
export const makeCylinder = (r, h, n) => makeCone(r, r, h, n, true);
export function makeSphere(r, seg, rings) {
  seg = Math.max(3, Math.round(seg)); rings = Math.max(2, Math.round(rings));
  const v = [[0, 0, r]], f = [];
  for (let j = 1; j < rings; j++) {
    const ph = Math.PI * j / rings, z = r * Math.cos(ph), rho = r * Math.sin(ph);
    for (let i = 0; i < seg; i++) { const a = 2 * Math.PI * i / seg; v.push([rho * Math.cos(a), rho * Math.sin(a), z]); }
  }
  const bot = v.length; v.push([0, 0, -r]);
  const R = (j, i) => 1 + (j - 1) * seg + (i % seg);
  for (let i = 0; i < seg; i++) f.push([0, R(1, i), R(1, i + 1)]);
  for (let j = 1; j < rings - 1; j++) for (let i = 0; i < seg; i++) f.push([R(j, i), R(j + 1, i), R(j + 1, i + 1), R(j, i + 1)]);
  for (let i = 0; i < seg; i++) f.push([bot, R(rings - 1, i + 1), R(rings - 1, i)]);
  return new PolyMesh(v, f);
}
export function makeTorus(R, r, M, m) {
  M = Math.max(3, Math.round(M)); m = Math.max(3, Math.round(m));
  const v = [], f = [];
  for (let i = 0; i < M; i++) {
    const u = 2 * Math.PI * i / M;
    for (let j = 0; j < m; j++) {
      const w = 2 * Math.PI * j / m, rr = R + r * Math.cos(w);
      v.push([rr * Math.cos(u), rr * Math.sin(u), r * Math.sin(w)]);
    }
  }
  const I = (i, j) => (i % M) * m + (j % m);
  for (let i = 0; i < M; i++) for (let j = 0; j < m; j++) f.push([I(i, j), I(i + 1, j), I(i + 1, j + 1), I(i, j + 1)]);
  return new PolyMesh(v, f);
}

// ---------- topology helpers ----------
// Faces whose vertices are all in the selected set.
export function selectedFaces(m, sel) {
  const out = [];
  m.f.forEach((f, i) => { if (f.every(v => sel.has(v))) out.push(i); });
  return out;
}

// Remove unused vertices. Returns old->new index map (-1 = removed).
export function cleanup(m) {
  const used = new Uint8Array(m.v.length);
  m.f = m.f.filter(f => f.length >= 3);
  for (const f of m.f) for (const i of f) used[i] = 1;
  const map = new Int32Array(m.v.length).fill(-1);
  const nv = [];
  m.v.forEach((p, i) => { if (used[i]) { map[i] = nv.length; nv.push(p); } });
  m.v = nv;
  m.f = m.f.map(f => f.map(i => map[i]));
  return map;
}
export function remapSet(set, map) {
  const out = new Set();
  for (const i of set) if (map[i] >= 0) out.add(map[i]);
  return out;
}

// ---------- modelling operations ----------
// xf: { toW([x,y,z]) -> world, toL(world) -> local }  (lets ops work in world units)

// Region extrude selected faces along their average (area weighted) world normal.
// Returns the new selected vertex set.
export function extrudeFaces(m, faceIds, distance, xf) {
  if (!faceIds.length) return null;
  const fset = new Set(faceIds);
  const directed = new Set();
  for (const fi of faceIds) { const f = m.f[fi]; for (let i = 0; i < f.length; i++) directed.add(f[i] + '>' + f[(i + 1) % f.length]); }
  let N = [0, 0, 0];
  for (const fi of faceIds) N = add(N, newell(m.f[fi].map(i => xf.toW(m.v[i]))));
  N = norm(N);
  const map = new Map();
  for (const fi of faceIds) for (const vi of m.f[fi]) if (!map.has(vi)) {
    const w = add(xf.toW(m.v[vi]), mul(N, distance));
    map.set(vi, m.v.length); m.v.push(xf.toL(w));
  }
  const sides = [];
  for (const fi of faceIds) {
    const f = m.f[fi];
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      if (!directed.has(b + '>' + a)) sides.push([a, b, map.get(b), map.get(a)]);
    }
  }
  for (const fi of faceIds) m.f[fi] = m.f[fi].map(i => map.get(i));
  m.f.push(...sides);
  const sel = new Set(map.values());
  const remap = cleanup(m);
  return { sel: remapSet(sel, remap), normal: N };
}

// Individual-face inset by an exact edge-offset distance (world units).
export function insetFaces(m, faceIds, thickness, xf) {
  const sel = new Set();
  const newFaces = [];
  for (const fi of faceIds) {
    const f = m.f[fi];
    const P = f.map(i => xf.toW(m.v[i]));
    const N = faceNormal(P);
    const n = f.length;
    const inner = [];
    for (let i = 0; i < n; i++) {
      const p = P[i], a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
      const e1 = norm(sub(p, a)), e2 = norm(sub(b, p));
      const in1 = cross(N, e1), in2 = cross(N, e2); // inward perpendiculars (CCW face)
      let bis = add(in1, in2);
      const bl = len(bis);
      let off;
      if (bl < 1e-9) off = mul(in1, thickness);
      else { bis = mul(bis, 1 / bl); const c = dot(bis, in1); off = mul(bis, thickness / Math.max(c, 1e-6)); }
      inner.push(m.v.length); m.v.push(xf.toL(add(p, off)));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      newFaces.push([f[i], f[j], inner[j], inner[i]]);
    }
    m.f[fi] = inner;
    inner.forEach(i => sel.add(i));
  }
  m.f.push(...newFaces);
  return sel;
}

// Subdivide faces whose vertices are all selected; neighbours receive the edge midpoints.
export function subdivideFaces(m, faceIds, cuts = 1) {
  const fset = new Set(faceIds);
  const mids = new Map(); // edgeKey -> [vertex indices from low to high]
  const getMid = (a, b) => {
    const k = edgeKey(a, b);
    if (!mids.has(k)) {
      const lo = Math.min(a, b), hi = Math.max(a, b), arr = [];
      for (let c = 1; c <= cuts; c++) {
        const t = c / (cuts + 1);
        arr.push(m.v.length); m.v.push(add(m.v[lo], mul(sub(m.v[hi], m.v[lo]), t)));
      }
      mids.set(k, arr);
    }
    const arr = mids.get(k);
    return a < b ? arr : arr.slice().reverse();
  };
  const sel = new Set();
  const out = [];
  m.f.forEach((f, fi) => {
    if (!fset.has(fi)) { out.push(f); return; }
    const n = f.length;
    const ring = []; // boundary with inserted points
    const corners = [];
    for (let i = 0; i < n; i++) { corners.push(ring.length); ring.push(f[i]); ring.push(...getMid(f[i], f[(i + 1) % n])); }
    ring.forEach(i => sel.add(i));
    if (n === 4 && cuts >= 1) {
      // grid subdivision for quads
      const k = cuts + 1;
      const side = (s) => { const r = []; for (let t = 0; t <= k; t++) r.push(ring[(corners[s] + t) % ring.length]); return r; };
      const s0 = side(0), s1 = side(1), s2 = side(2).reverse(), s3 = side(3).reverse();
      const grid = [];
      for (let row = 0; row <= k; row++) {
        grid.push([]);
        for (let col = 0; col <= k; col++) {
          if (row === 0) grid[row].push(s0[col]);
          else if (row === k) grid[row].push(s2[col]);
          else if (col === 0) grid[row].push(s3[row]);
          else if (col === k) grid[row].push(s1[row]);
          else {
            const a = m.v[s3[row]], b = m.v[s1[row]];
            grid[row].push(m.v.length); m.v.push(add(a, mul(sub(b, a), col / k)));
            sel.add(m.v.length - 1);
          }
        }
      }
      for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) out.push([grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]]);
    } else {
      const ci = m.v.length; m.v.push(centroid(f.map(i => m.v[i]))); sel.add(ci);
      if (n === 3 && cuts === 1) {
        // classic 4-triangle split
        const [a, ab, b, bc, c, ca] = ring; m.v.pop(); sel.delete(ci);
        out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else {
        for (let i = 0; i < n; i++) {
          const prev = (corners[i] - 1 + ring.length) % ring.length, next = (corners[i] + 1) % ring.length;
          out.push([ring[corners[i]], ring[next], ci, ring[prev]]);
        }
      }
    }
  });
  // insert midpoints into neighbouring faces
  m.f = out.map((f) => {
    const r = [];
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      r.push(a);
      const k = edgeKey(a, b);
      if (mids.has(k)) {
        const arr = a < b ? mids.get(k) : mids.get(k).slice().reverse();
        r.push(...arr);
      }
    }
    return r;
  });
  return sel;
}

export function deleteVerts(m, sel) {
  m.f = m.f.filter(f => !f.some(i => sel.has(i)));
  cleanup(m);
}
export function deleteFaces(m, faceIds) {
  const s = new Set(faceIds);
  m.f = m.f.filter((_, i) => !s.has(i));
  cleanup(m);
}
// Merge selected vertices to a point (local coords). Returns new selection.
export function mergeVerts(m, sel, point) {
  const ids = [...sel];
  if (ids.length < 2) return sel;
  const keep = ids[0];
  m.v[keep] = point.slice();
  const s = new Set(ids);
  m.f = m.f.map(f => {
    const r = [];
    for (const i of f) { const j = s.has(i) ? keep : i; if (r[r.length - 1] !== j) r.push(j); }
    if (r.length > 1 && r[0] === r[r.length - 1]) r.pop();
    return r;
  }).filter(f => f.length >= 3);
  const map = cleanup(m);
  return new Set([map[keep]].filter(i => i >= 0));
}

// Weld vertices closer than tol (local units). Returns count removed.
export function weld(m, tol = 1e-6) {
  const key = p => p.map(c => Math.round(c / tol)).join(',');
  const map = new Map(), remap = [];
  m.v.forEach((p, i) => { const k = key(p); if (!map.has(k)) map.set(k, i); remap[i] = map.get(k); });
  const before = m.v.length;
  m.f = m.f.map(f => {
    const r = [];
    for (const i of f) { const j = remap[i]; if (r[r.length - 1] !== j) r.push(j); }
    if (r.length > 1 && r[0] === r[r.length - 1]) r.pop();
    return r;
  }).filter(f => f.length >= 3);
  cleanup(m);
  return before - m.v.length;
}

// Create a face from selected vertices, ordered around their centroid.
export function fillFace(m, sel, viewDirLocal) {
  const ids = [...sel];
  if (ids.length < 3) return false;
  const P = ids.map(i => m.v[i]);
  const c = centroid(P);
  // best-fit normal: Newell over angle-sorted points using a provisional normal
  let N = [0, 0, 0];
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const n = cross(sub(P[i], c), sub(P[j], c));
    N = dot(n, N) < 0 ? sub(N, n) : add(N, n);
  }
  N = norm(N);
  if (len(N) < 0.5) return false;
  const ref = norm(sub(P[0], c)), ref2 = cross(N, ref);
  const order = ids.map((id, k) => ({ id, a: Math.atan2(dot(sub(P[k], c), ref2), dot(sub(P[k], c), ref)) }))
    .sort((a, b) => a.a - b.a).map(o => o.id);
  // orient: consistent with an adjacent face if an edge is shared, else toward viewer
  let face = order;
  const dirs = new Set();
  for (const f of m.f) for (let i = 0; i < f.length; i++) dirs.add(f[i] + '>' + f[(i + 1) % f.length]);
  let flip = null;
  for (let i = 0; i < face.length; i++) {
    const a = face[i], b = face[(i + 1) % face.length];
    if (dirs.has(a + '>' + b)) { flip = true; break; }
    if (dirs.has(b + '>' + a)) { flip = false; break; }
  }
  if (flip === null && viewDirLocal) flip = dot(N, viewDirLocal) > 0;
  if (flip) face = face.slice().reverse();
  m.f.push(face);
  return true;
}

export function flipFaces(m, faceIds) { for (const i of faceIds) m.f[i].reverse(); }

// Make face winding consistent and pointing outward (for closed meshes).
export function recalcNormals(m) {
  const n = m.f.length;
  const edgeFaces = new Map();
  m.f.forEach((f, fi) => f.forEach((a, i) => {
    const k = edgeKey(a, f[(i + 1) % f.length]);
    (edgeFaces.get(k) || edgeFaces.set(k, []).get(k)).push(fi);
  }));
  const visited = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    const comp = [s]; visited[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const fi = comp[q], f = m.f[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        for (const gj of edgeFaces.get(edgeKey(a, b))) {
          if (visited[gj]) continue;
          const g = m.f[gj];
          // neighbour must traverse b->a
          let same = false;
          for (let k = 0; k < g.length; k++) if (g[k] === a && g[(k + 1) % g.length] === b) same = true;
          if (same) g.reverse();
          visited[gj] = 1; comp.push(gj);
        }
      }
    }
    // signed volume of the component; flip if negative
    let vol = 0;
    for (const fi of comp) {
      const P = m.f[fi].map(i => m.v[i]);
      for (const [a, b, c] of triangulateFace(P)) vol += dot(P[a], cross(P[b], P[c]));
    }
    if (vol < 0) for (const fi of comp) m.f[fi].reverse();
  }
}

export function bbox(points) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
  return { min: mn, max: mx };
}

export function meshVolume(m) {
  let vol = 0;
  for (const f of m.f) {
    const P = f.map(i => m.v[i]);
    for (const [a, b, c] of triangulateFace(P)) vol += dot(P[a], cross(P[b], P[c]));
  }
  return vol / 6;
}

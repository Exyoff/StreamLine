// Double-precision BSP constructive solid geometry (after Evan Wallace's csg.js, MIT),
// with mesh clean-up: welding, T-junction repair and coplanar face merging.
import * as THREE from 'three';
import { PolyMesh, triangulateFace, newell, norm, dot, cross, sub, add, mul, len, cleanup, recalcNormals, edgeKey } from './mesh.js';

const EPS = 1e-6; // mm
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Plane {
  constructor(n, w) { this.n = n; this.w = w; }
  clone() { return new Plane(this.n.slice(), this.w); }
  flip() { this.n = mul(this.n, -1); this.w = -this.w; }
  split(poly, cf, cb, f, b) {
    let type = 0; const types = [];
    for (const v of poly.v) { const t = dot(this.n, v) - this.w; const ty = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR; type |= ty; types.push(ty); }
    if (type === COPLANAR) (dot(this.n, poly.plane.n) > 0 ? cf : cb).push(poly);
    else if (type === FRONT) f.push(poly);
    else if (type === BACK) b.push(poly);
    else {
      const fv = [], bv = [], n = poly.v.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ti = types[i], tj = types[j], vi = poly.v[i], vj = poly.v[j];
        if (ti !== BACK) fv.push(vi);
        if (ti !== FRONT) bv.push(vi);
        if ((ti | tj) === SPANNING) {
          const t = (this.w - dot(this.n, vi)) / dot(this.n, sub(vj, vi));
          const v = add(vi, mul(sub(vj, vi), t));
          fv.push(v); bv.push(v);
        }
      }
      if (fv.length >= 3) f.push(new Poly(fv, poly.plane));
      if (bv.length >= 3) b.push(new Poly(bv, poly.plane));
    }
  }
}
class Poly {
  constructor(v, plane) {
    this.v = v;
    if (plane) this.plane = plane;
    else { const n = norm(newell(v)); this.plane = new Plane(n, dot(n, v[0])); }
  }
  flip() { this.v.reverse(); this.plane = this.plane.clone(); this.plane.flip(); }
}
class Node {
  constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
  nodes() { const out = [], st = [this]; while (st.length) { const n = st.pop(); out.push(n); n.front && st.push(n.front); n.back && st.push(n.back); } return out; }
  invert() { for (const n of this.nodes()) { n.polys.forEach(p => p.flip()); n.plane && n.plane.flip(); [n.front, n.back] = [n.back, n.front]; } }
  clipPolys(polys) {
    const out = [], st = [[this, polys]];
    while (st.length) {
      const [n, ps] = st.pop();
      if (!n.plane) { out.push(...ps); continue; }
      const f = [], b = [];
      for (const p of ps) n.plane.split(p, f, b, f, b);
      if (n.front) st.push([n.front, f]); else out.push(...f);
      if (n.back) st.push([n.back, b]);
    }
    return out;
  }
  clipTo(bsp) { for (const n of this.nodes()) n.polys = bsp.clipPolys(n.polys); }
  all() { return this.nodes().flatMap(n => n.polys); }
  build(polys) {
    const st = [[this, polys]];
    while (st.length) {
      const [n, ps] = st.pop();
      if (!ps.length) continue;
      if (!n.plane) n.plane = ps[0].plane.clone();
      const f = [], b = [];
      for (const p of ps) n.plane.split(p, n.polys, n.polys, f, b);
      if (f.length) { n.front ||= new Node(); st.push([n.front, f]); }
      if (b.length) { n.back ||= new Node(); st.push([n.back, b]); }
    }
  }
}

// world-space vertices + faces -> convex polygons
export function toPolys(verts, faces) {
  const out = [];
  for (const f of faces) {
    const P = f.map(i => verts[i]);
    if (P.length < 3 || len(newell(P)) < 1e-12) continue;
    const tris = triangulateFace(P);
    if (tris.length === P.length - 2 && tris.every((t, k) => t[0] === 0 && t[1] === k + 1)) out.push(new Poly(P.map(p => p.slice())));
    else for (const t of tris) out.push(new Poly(t.map(k => P[k].slice())));
  }
  return out;
}

export function boolean(kind, aPolys, bPolys) {
  const a = new Node(aPolys.map(p => new Poly(p.v.map(v => v.slice()), p.plane.clone())));
  const b = new Node(bPolys.map(p => new Poly(p.v.map(v => v.slice()), p.plane.clone())));
  if (kind === 'union') {
    a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all());
  } else if (kind === 'subtract') {
    a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert();
  } else {
    a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.all()); a.invert();
  }
  return a.all();
}

// ---------- polygons -> clean PolyMesh ----------
export function polysToMesh(polys) {
  // tolerance weld: a point merges with any existing point within Q (neighbouring cells are searched,
  // so near-identical points straddling a cell boundary still weld)
  const Q = 1e-5, grid = new Map(), v = [];
  const idx = p => {
    const cx = Math.floor(p[0] / Q), cy = Math.floor(p[1] / Q), cz = Math.floor(p[2] / Q);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const cell = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
      if (cell) for (const i of cell) { const q = v[i]; if (Math.abs(q[0] - p[0]) <= Q && Math.abs(q[1] - p[1]) <= Q && Math.abs(q[2] - p[2]) <= Q) return i; }
    }
    const k = cx + ',' + cy + ',' + cz;
    (grid.get(k) || grid.set(k, []).get(k)).push(v.length); v.push(p.slice());
    return v.length - 1;
  };
  let f = polys.map(p => {
    const r = [];
    for (const q of p.v) { const i = idx(q); if (r[r.length - 1] !== i) r.push(i); }
    if (r.length > 1 && r[0] === r[r.length - 1]) r.pop();
    return r;
  }).filter(r => r.length >= 3 && len(newell(r.map(i => v[i]))) > 1e-12);
  const m = new PolyMesh(v, f);
  fixTJunctions(m);
  mergeCoplanar(m);
  cleanup(m);
  return m;
}

export function fixTJunctions(m) {
  const V = m.v, nv = V.length;
  // spatial hash
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of V) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const cell = diag / Math.max(4, Math.cbrt(nv) * 2);
  const grid = new Map(), ck = (x, y, z) => x + ',' + y + ',' + z;
  V.forEach((p, i) => { const k = ck(...p.map((c, j) => Math.floor((c - mn[j]) / cell))); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const tol = 1e-5;
  const onEdge = new Map();
  const between = (a, b) => {
    const key = a + '>' + b;
    if (onEdge.has(key)) return onEdge.get(key);
    const A = V[a], B = V[b], d = sub(B, A), L = len(d);
    const res = [];
    if (L > tol) {
      const u = mul(d, 1 / L);
      const lo = [0, 1, 2].map(j => Math.floor((Math.min(A[j], B[j]) - tol - mn[j]) / cell)), hi = [0, 1, 2].map(j => Math.floor((Math.max(A[j], B[j]) + tol - mn[j]) / cell));
      const cells = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
      if (cells < 20000) for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        for (const i of grid.get(ck(x, y, z)) || []) {
          if (i === a || i === b) continue;
          const w = sub(V[i], A), t = dot(w, u);
          if (t <= tol || t >= L - tol) continue;
          if (len(sub(w, mul(u, t))) < tol) res.push([t, i]);
        }
      }
    }
    res.sort((p, q) => p[0] - q[0]);
    const r = res.map(x => x[1]);
    onEdge.set(key, r);
    return r;
  };
  m.f = m.f.map(f => { const r = []; for (let i = 0; i < f.length; i++) { r.push(f[i]); r.push(...between(f[i], f[(i + 1) % f.length])); } return r; });
}

// Merge edge-connected coplanar faces into single n-gons (when the result has no holes).
export function mergeCoplanar(m) {
  const F = m.f, V = m.v;
  const planes = F.map(f => { const n = norm(newell(f.map(i => V[i]))); return { n, w: dot(n, V[f[0]]) }; });
  const edgeFaces = new Map();
  F.forEach((f, fi) => f.forEach((a, i) => { const k = edgeKey(a, f[(i + 1) % f.length]); (edgeFaces.get(k) || edgeFaces.set(k, []).get(k)).push(fi); }));
  const same = (i, j) => dot(planes[i].n, planes[j].n) > 1 - 1e-9 && Math.abs(planes[i].w - planes[j].w) < 1e-6;
  const seen = new Uint8Array(F.length), out = [];
  for (let s = 0; s < F.length; s++) {
    if (seen[s]) continue;
    const grp = [s]; seen[s] = 1;
    for (let q = 0; q < grp.length; q++) {
      const f = F[grp[q]];
      for (let i = 0; i < f.length; i++) for (const g of edgeFaces.get(edgeKey(f[i], f[(i + 1) % f.length]))) if (!seen[g] && same(s, g)) { seen[g] = 1; grp.push(g); }
    }
    if (grp.length === 1) { out.push(F[s]); continue; }
    const dir = new Set();
    for (const gi of grp) { const f = F[gi]; f.forEach((a, i) => dir.add(a + '>' + f[(i + 1) % f.length])); }
    const next = new Map(); let ambiguous = false;
    for (const gi of grp) { const f = F[gi]; f.forEach((a, i) => { const b = f[(i + 1) % f.length]; if (!dir.has(b + '>' + a)) { if (next.has(a)) ambiguous = true; next.set(a, b); } }); }
    const loops = [], used = new Set();
    if (!ambiguous) for (const st of next.keys()) {
      if (used.has(st)) continue;
      const loop = []; let c = st, guard = 0;
      while (!used.has(c) && guard++ < 1e6) { used.add(c); loop.push(c); c = next.get(c); if (c === undefined) { ambiguous = true; break; } }
      loops.push(loop);
    }
    if (ambiguous || !loops.length) { grp.forEach(gi => out.push(F[gi])); continue; }
    if (loops.length === 1) { out.push(loops[0]); continue; }
    out.push({ loops, n: planes[s].n, orig: grp.map(gi => F[gi]) }); // triangulated after clean-up
  }
  m.f = out;
  // drop vertices that sit on a straight edge between exactly two neighbours
  for (let pass = 0; pass < 3; pass++) {
    const nb = new Map();
    for (const f of m.f.flatMap(f => (Array.isArray(f) ? [f] : f.loops))) f.forEach((a, i) => { const b = f[(i + 1) % f.length]; (nb.get(a) || nb.set(a, new Set()).get(a)).add(b); (nb.get(b) || nb.set(b, new Set()).get(b)).add(a); });
    const drop = new Set();
    for (const [vi, ns] of nb) {
      if (ns.size !== 2) continue;
      const [a, c] = [...ns], A = V[a], B = V[vi], Cc = V[c];
      if (drop.has(a) || drop.has(c)) continue;
      if (len(cross(sub(B, A), sub(Cc, B))) <= 1e-9 * Math.max(1, len(sub(Cc, A))) && dot(sub(B, A), sub(Cc, B)) > 0) drop.add(vi);
    }
    if (!drop.size) break;
    m.f = m.f.map(f => (Array.isArray(f) ? f.filter(i => !drop.has(i)) : { ...f, loops: f.loops.map(l => l.filter(i => !drop.has(i))) })).filter(f => (Array.isArray(f) ? f.length >= 3 : f.loops.every(l => l.length >= 3)));
  }
  m.f = m.f.flatMap(f => {
    if (Array.isArray(f)) return [f];
    return triangulateWithHoles(V, f.loops, f.n) || f.orig;
  });
  // drop collinear vertices used by only one face
  const use = new Map();
  for (const f of m.f) for (const i of f) use.set(i, (use.get(i) || 0) + 1);
  m.f = m.f.map(f => {
    if (f.length <= 3) return f;
    const r = f.filter((vi, k) => {
      if (use.get(vi) > 1) return true;
      const a = V[f[(k - 1 + f.length) % f.length]], b = V[vi], c = V[f[(k + 1) % f.length]];
      return len(cross(sub(b, a), sub(c, b))) > 1e-9 * Math.max(1, len(sub(c, a)));
    });
    return r.length >= 3 ? r : f;
  });
}

// Triangulate a planar face given as several loops (one outer + holes), indices into V.
function triangulateWithHoles(V, loops, n) {
  const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), w = cross(n, u);
  const P2 = loops.map(l => l.map(i => [dot(V[i], u), dot(V[i], w)]));
  const area = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  let oi = 0; P2.forEach((p, i) => { if (Math.abs(area(p)) > Math.abs(area(P2[oi]))) oi = i; });
  if (area(P2[oi]) <= 0) return null; // outer must be CCW w.r.t. the face normal
  const order = [oi, ...P2.map((_, i) => i).filter(i => i !== oi)];
  const idx = order.flatMap(i => loops[i]);
  try {
    const tris = THREE.ShapeUtils.triangulateShape(P2[oi].map(p => new THREE.Vector2(p[0], p[1])), order.slice(1).map(i => P2[i].map(p => new THREE.Vector2(p[0], p[1]))));
    if (!tris.length) return null;
    return tris.map(([a, b, c]) => {
      const A = V[idx[a]], B = V[idx[b]], C = V[idx[c]];
      return dot(cross(sub(B, A), sub(C, A)), n) < 0 ? [idx[a], idx[c], idx[b]] : [idx[a], idx[b], idx[c]];
    });
  } catch (e) { return null; }
}

// ---------- solids from 2D regions ----------
// region: {outer:[[x,y]...] CCW, holes:[[...] CW]} ; pl: plane {o,u,v,n}
const P3 = (pl, p, h) => [0, 1, 2].map(k => pl.o[k] + pl.u[k] * p[0] + pl.v[k] * p[1] + pl.n[k] * h);

function capFaces(region, offset) {
  // returns faces as arrays of indices into the concatenated [outer, ...holes] point list (+offset), CCW in the plane
  const all = [region.outer, ...region.holes];
  if (!region.holes.length) return [region.outer.map((_, i) => i + offset)];
  const contour = region.outer.map(p => new THREE.Vector2(p[0], p[1]));
  const holes = region.holes.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const flat = all.flat();
  return tris.map(([a, b, c]) => {
    const A = flat[a], B = flat[b], C = flat[c];
    const cw = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0;
    return (cw ? [a, c, b] : [a, b, c]).map(i => i + offset);
  });
}
export function extrudeRegions(regs, pl, h0, h1) {
  const v = [], f = [];
  for (const r0 of regs) {
    const r = { outer: ccw(r0.outer, true), holes: r0.holes.map(h => ccw(h, false)) };
    const loops = [r.outer, ...r.holes];
    const base = v.length, N = loops.reduce((s, l) => s + l.length, 0);
    for (const l of loops) for (const p of l) v.push(P3(pl, p, h0));
    for (const l of loops) for (const p of l) v.push(P3(pl, p, h1));
    for (const c of capFaces(r, base)) f.push(c.slice().reverse()); // bottom faces -n
    for (const c of capFaces(r, base + N)) f.push(c);               // top faces +n
    let off = 0;
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) { const j = (i + 1) % l.length; f.push([base + off + i, base + off + j, base + N + off + j, base + N + off + i]); }
      off += l.length;
    }
  }
  const m = new PolyMesh(v, f);
  if (h1 < h0) m.f.forEach(x => x.reverse());
  return m;
}
function ccw(pts, wantCCW) {
  let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return (a > 0) === wantCCW ? pts.slice() : pts.slice().reverse();
}
// Revolve regions about a sketch axis ('x' or 'y' through origin) by angle degrees.
// axis: 'x' | 'y' (sketch axes through the origin) or { p, d } — any line in the sketch (point + unit direction)
export function revolveRegions(regs, pl, axis, angleDeg, segs) {
  if (typeof axis === 'object') {
    const { p, d } = axis, q = [-d[1], d[0]];
    const tr = pts => pts.map(x => { const r = [x[0] - p[0], x[1] - p[1]]; return [r[0] * d[0] + r[1] * d[1], r[0] * q[0] + r[1] * q[1]]; });
    const W = (a, b) => [0, 1, 2].map(k => a * pl.u[k] + b * pl.v[k]);
    const pl2 = { o: [0, 1, 2].map(k => pl.o[k] + pl.u[k] * p[0] + pl.v[k] * p[1]), u: W(d[0], d[1]), v: W(q[0], q[1]), n: pl.n };
    return revolveRegions(regs.map(r => ({ outer: tr(r.outer), holes: r.holes.map(tr) })), pl2, 'x', angleDeg, segs);
  }
  const full = Math.abs(angleDeg) >= 360 - 1e-9;
  const ang = Math.max(-360, Math.min(360, angleDeg)) * Math.PI / 180;
  const n = Math.max(3, Math.round(segs * Math.abs(ang) / (2 * Math.PI)));
  const A = axis === 'x' ? pl.u : pl.v, B = axis === 'x' ? pl.v : pl.u; // B: radial direction in plane
  const v = [], f = [];
  const pos = (p, t) => {
    const ax = axis === 'x' ? p[0] : p[1], r = axis === 'x' ? p[1] : p[0];
    const c = Math.cos(t), s = Math.sin(t);
    const rd = add(mul(B, c), mul(pl.n, s * (axis === 'x' ? 1 : -1)));
    return [0, 1, 2].map(k => pl.o[k] + A[k] * ax + rd[k] * r);
  };
  for (const r0 of regs) {
    const loops = [ccw(r0.outer, true), ...r0.holes.map(h => ccw(h, false))];
    const rings = full ? n : n + 1;
    for (const l of loops) {
      const base = v.length;
      for (let k = 0; k < rings; k++) for (const p of l) v.push(pos(p, ang * k / n));
      const L = l.length;
      for (let k = 0; k < n; k++) {
        const k2 = full ? (k + 1) % n : k + 1;
        for (let i = 0; i < L; i++) { const j = (i + 1) % L; f.push([base + k * L + i, base + k * L + j, base + k2 * L + j, base + k2 * L + i]); }
      }
    }
    if (!full) {
      const N = v.length;
      const r = { outer: loops[0], holes: loops.slice(1) };
      const flat = loops.flat();
      flat.forEach(p => v.push(pos(p, 0)));
      flat.forEach(p => v.push(pos(p, ang)));
      for (const c of capFaces(r, N)) f.push(c);
      for (const c of capFaces(r, N + flat.length)) f.push(c.slice().reverse());
    }
  }
  const m = new PolyMesh(v, f);
  // weld duplicate points (on-axis vertices collapse), drop degenerate faces, orient outward
  const Q = 1e-6, map = new Map(), nv = [], remap = [];
  m.v.forEach((p, i) => { const k = p.map(c => Math.round(c / Q)).join(','); if (!map.has(k)) { map.set(k, nv.length); nv.push(p); } remap[i] = map.get(k); });
  m.v = nv;
  m.f = m.f.map(fc => { const r = []; for (const i of fc) { const j = remap[i]; if (r[r.length - 1] !== j && r[0] !== j) r.push(j); } return r; }).filter(fc => fc.length >= 3 && len(newell(fc.map(i => m.v[i]))) > 1e-12);
  cleanup(m);
  recalcNormals(m);
  return m;
}

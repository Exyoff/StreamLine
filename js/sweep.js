// LOFT and SWEEP (CAD workspace): solids through several profiles, or a profile along a path.
import * as THREE from 'three';
import * as M from './mesh.js';
import { PolyMesh } from './mesh.js';
import { polysToMesh, toPolys } from './csg.js';
import { toW, entPolyline, d2 } from './sketch.js';

const area2 = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const ccw2 = (pts, want) => ((area2(pts) > 0) === want ? pts.slice() : pts.slice().reverse());

// triangulate a 2D region {outer, holes} → triangles of indices into [outer, ...holes].flat()
function capTris(region) {
  const tris = THREE.ShapeUtils.triangulateShape(region.outer.map(p => new THREE.Vector2(...p)), region.holes.map(h => h.map(p => new THREE.Vector2(...p))));
  const flat = [region.outer, ...region.holes].flat();
  return tris.map(([a, b, c]) => { const A = flat[a], B = flat[b], C = flat[c]; return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0 ? [a, c, b] : [a, b, c]; });
}

// ---------- SWEEP ----------
// frames: [{ o, u, v }] — a point on the path and the (possibly miter-scaled) section axes there
export function sweepRegion(region2D, frames) {
  const r = { outer: ccw2(region2D.outer, true), holes: region2D.holes.map(h => ccw2(h, false)) };
  const loops = [r.outer, ...r.holes], N = loops.reduce((s, l) => s + l.length, 0), K = frames.length;
  const v = [], f = [];
  for (const fr of frames) for (const l of loops) for (const p of l) v.push(M.add(fr.o, M.add(M.mul(fr.u, p[0]), M.mul(fr.v, p[1]))));
  let off = 0;
  for (const l of loops) {
    for (let k = 0; k < K - 1; k++) for (let i = 0; i < l.length; i++) {
      const j = (i + 1) % l.length, a = k * N + off;
      f.push([a + i, a + j, a + N + j, a + N + i]);
    }
    off += l.length;
  }
  for (const t of capTris(r)) { f.push([t[0], t[2], t[1]]); f.push(t.map(i => i + (K - 1) * N)); }
  const m = new PolyMesh(v, f);
  M.recalcNormals(m);
  return polysToMesh(toPolys(m.v, m.f));
}
// Rotation-minimising frames along a polyline, mitred at the corners.
// start: { u, v } section axes at the path start (the profile's plane axes).
export function pathFrames(path, start) {
  const n = path.length;
  if (n < 2) return null;
  const T = []; for (let i = 0; i < n - 1; i++) T.push(M.norm(M.sub(path[i + 1], path[i])));
  // align the start axes to be perpendicular to the first tangent
  const fix = w => M.norm(M.sub(w, M.mul(T[0], M.dot(w, T[0]))));
  let u = fix(start.u), v = M.cross(T[0], u);
  if (M.dot(v, start.v) < 0) { u = M.mul(u, -1); v = M.cross(T[0], u); }
  const frames = [{ o: path[0], u, v }];
  for (let i = 1; i < n; i++) {
    const tin = T[i - 1], tout = i < n - 1 ? T[i] : T[i - 1];
    // parallel transport u, v from tin to tout
    const rot = (w, a, b) => { const ax = M.cross(a, b), s = M.len(ax), c = M.dot(a, b); if (s < 1e-12) return w; const k = M.mul(ax, 1 / s); return M.add(M.add(M.mul(w, c), M.mul(M.cross(k, w), s)), M.mul(k, M.dot(k, w) * (1 - c))); };
    const bis = M.norm(M.add(tin, tout)), half = Math.acos(Math.max(-1, Math.min(1, M.dot(tin, tout)))) / 2;
    const ub = rot(u, tin, bis), vb = rot(v, tin, bis);
    // mitre: stretch the section along the bend direction by 1/cos(half angle)
    const bend = M.len(M.sub(tout, tin)) > 1e-12 ? M.norm(M.sub(tout, tin)) : null, sc = 1 / Math.cos(half);
    const stretch = w => (bend ? M.add(w, M.mul(bend, M.dot(w, bend) * (sc - 1))) : w);
    frames.push({ o: path[i], u: stretch(ub), v: stretch(vb) });
    u = rot(u, tin, tout); v = rot(v, tin, tout);
  }
  return frames;
}
// The longest open chain of lines / arcs / splines in a sketch, as world points.
export function sketchPath(sk, near) {
  const segs = [];
  for (const e of sk.ents) {
    if (!['line', 'arc', 'spline'].includes(e.t)) continue;
    const pl = entPolyline(e); if (!pl || pl.closed) continue;
    segs.push(pl.pts);
  }
  if (!segs.length) return null;
  // chain segments end to end
  const used = new Set(), chains = [];
  for (let s = 0; s < segs.length; s++) {
    if (used.has(s)) continue;
    used.add(s); let chain = segs[s].slice(), grew = true;
    while (grew) {
      grew = false;
      for (let t = 0; t < segs.length; t++) {
        if (used.has(t)) continue;
        const g = segs[t], A = chain[0], B = chain[chain.length - 1];
        if (d2(B, g[0]) < 1e-7) { chain = chain.concat(g.slice(1)); }
        else if (d2(B, g[g.length - 1]) < 1e-7) { chain = chain.concat(g.slice(0, -1).reverse()); }
        else if (d2(A, g[g.length - 1]) < 1e-7) { chain = g.slice(0, -1).concat(chain); }
        else if (d2(A, g[0]) < 1e-7) { chain = g.slice(1).reverse().concat(chain); }
        else continue;
        used.add(t); grew = true;
      }
    }
    chains.push(chain);
  }
  const len = c => c.reduce((s, p, i) => (i ? s + d2(p, c[i - 1]) : 0), 0);
  let best = chains.sort((a, b) => len(b) - len(a))[0].map(p => toW(sk.plane, p));
  if (near && M.dist(best[best.length - 1], near) < M.dist(best[0], near)) best = best.reverse();
  return best;
}

// ---------- LOFT ----------
function resample(P, n) {
  const L = [0]; for (let i = 1; i <= P.length; i++) L.push(L[i - 1] + M.dist(P[i - 1], P[i % P.length]));
  const tot = L[P.length], out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = tot * k / n; while (L[j + 1] < t) j++;
    const a = P[j], b = P[(j + 1) % P.length], s = (t - L[j]) / ((L[j + 1] - L[j]) || 1);
    out.push(M.add(a, M.mul(M.sub(b, a), s)));
  }
  return out;
}
// sections: closed loops of world points (outer boundaries), in loft order
export function loftSections(sections, n = 64) {
  if (sections.length < 2) return 'Select 2 or more profiles';
  const C = sections.map(s => M.centroid(s));
  const dir = M.norm(M.sub(C[C.length - 1], C[0]));
  let rings = sections.map(s => { let r = resample(s, n); if (M.dot(M.newell(r), dir) < 0) r = r.reverse(); return r; });
  // rotate each ring so its start best matches the previous ring
  for (let k = 1; k < rings.length; k++) {
    const prev = rings[k - 1], cur = rings[k], d = M.sub(C[k], C[k - 1]);
    let best = 0, bv = Infinity;
    for (let s = 0; s < n; s++) { let e = 0; for (let i = 0; i < n; i++) { const q = M.sub(cur[(i + s) % n], d); e += M.dot(M.sub(q, prev[i]), M.sub(q, prev[i])); } if (e < bv) { bv = e; best = s; } }
    rings[k] = cur.map((_, i) => cur[(i + best) % n]);
  }
  const v = rings.flat(), f = [];
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push([k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i]); }
  f.push([...Array(n).keys()].reverse(), [...Array(n).keys()].map(i => i + (rings.length - 1) * n));
  const m = new PolyMesh(v, f);
  M.recalcNormals(m);
  const res = polysToMesh(toPolys(m.v, m.f));
  return res.f.length ? res : 'Loft failed';
}

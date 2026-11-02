// 2D sketches: entities on a plane, snapping, region (profile) detection, DXF export.
// Sketch: { id, name, plane:{o,u,v,n}, ents:[...], face:{obj,..}|null, hidden }
// Entities (2D mm): line {a,b} · circle {c,r} · arc {c,r,a0,a1} (CCW, rad) · rect {x,y,w,h} · dim {kind:'lin'|'rad'|'dia', A, B | e}
import { S } from './state.js';
import { editAndSolve } from './constraints.js';

export const PLANES = {
  XY: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], label: 'Top (XY)' },
  XZ: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0], label: 'Front (XZ)' },
  YZ: { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], label: 'Right (YZ)' },
};
export const toW = (pl, p) => [0, 1, 2].map(k => pl.o[k] + pl.u[k] * p[0] + pl.v[k] * p[1]);
export const toP = (pl, w) => { const d = [w[0] - pl.o[0], w[1] - pl.o[1], w[2] - pl.o[2]]; return [d[0] * pl.u[0] + d[1] * pl.u[1] + d[2] * pl.u[2], d[0] * pl.v[0] + d[1] * pl.v[1] + d[2] * pl.v[2]]; };

const TAU = Math.PI * 2;
export const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const sweep = (e) => { let s = (e.a1 - e.a0) % TAU; if (s <= 1e-12) s += TAU; return s; };
// exact cos/sin on quarter turns so arc endpoints land on clean coordinates
function ecos(a) { const q = a / (Math.PI / 2), k = Math.round(q); return Math.abs(q - k) < 1e-12 ? [1, 0, -1, 0][((k % 4) + 4) % 4] : Math.cos(a); }
function esin(a) { const q = a / (Math.PI / 2), k = Math.round(q); return Math.abs(q - k) < 1e-12 ? [0, 1, 0, -1][((k % 4) + 4) % 4] : Math.sin(a); }
const pol = (c, r, a) => [c[0] + r * ecos(a), c[1] + r * esin(a)];
export const rectCorners = (e) => [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]];
export const curveSegs = () => S.settings.curveSegs || 64;

export function sketchById(id) { return (S.doc.sketches || []).find(s => s.id === id) || null; }
export function activeSketch() { return sketchById(S.ed.sketch); }
export const entById = (sk, id) => sk.ents.find(e => e.id === id);

// ---------- point references (for snapping, dimensions, dragging) ----------
// key points: [{k, p, movable}]
export function keyPoints(e) {
  switch (e.t) {
    case 'line': return [{ k: 'a', p: e.a, m: 1 }, { k: 'b', p: e.b, m: 1 }, { k: 'mid', p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] }];
    case 'circle': return [{ k: 'c', p: e.c, m: 1, center: 1 }, ...[0, 1, 2, 3].map(i => ({ k: 'q' + i, p: pol(e.c, e.r, i * Math.PI / 2) }))];
    case 'arc': return [{ k: 'c', p: e.c, m: 1, center: 1 }, { k: 's', p: pol(e.c, e.r, e.a0), m: 1 }, { k: 'e', p: pol(e.c, e.r, e.a0 + sweep(e)), m: 1 }, { k: 'mid', p: pol(e.c, e.r, e.a0 + sweep(e) / 2) }];
    case 'rect': return [...rectCorners(e).map((p, i) => ({ k: 'p' + i, p, m: 1 })), { k: 'ctr', p: [e.x + e.w / 2, e.y + e.h / 2], center: 1 }];
    case 'ellipse': return [{ k: 'c', p: e.c, m: 1, center: 1 }, ...[0, 1, 2, 3].map(i => ({ k: 'q' + i, p: ellPt(e, i * Math.PI / 2) }))];
    case 'spline': return e.pts.map((p, i) => ({ k: 'p' + i, p, m: 1 }));
    case 'text': return [{ k: 'p', p: e.p, m: 1 }];
    default: return [];
  }
}
export function refPoint(sk, ref) {
  const e = entById(sk, ref.e); if (!e) return null;
  const kp = keyPoints(e).find(q => q.k === ref.k);
  return kp ? kp.p.slice() : null;
}
// Move a point and everything coincident with it (simple connectivity, like a CAD coincidence constraint).
export function movePoint(sk, ref, np) {
  // constraint-aware: solve with the point pinned; fall back to plain coincident drag if that conflicts
  const snap = JSON.stringify(sk.ents);
  const err = editAndSolve(sk, () => {}, { pins: [{ ref, p: np }] });
  if (!err) return;
  // unreachable target: move there, then project back onto the constraints (closest valid position)
  sk.ents = JSON.parse(snap);
  const err2 = editAndSolve(sk, k => { movePointNaive(k, ref, np); });
  if (err2) { sk.ents = JSON.parse(snap); return err2; }
}
export function movePointNaive(sk, ref, np) {
  const old = refPoint(sk, ref); if (!old) return;
  const tol = 1e-7;
  for (const e of sk.ents) for (const kp of keyPoints(e)) {
    if (!kp.m || d2(kp.p, old) > tol) continue;
    if (e.t === 'circle' && !(e.id === ref.e)) continue; // circles only move when addressed directly
    setKey(e, kp.k, np);
  }
}
function setKey(e, k, p) {
  if (e.t === 'line') e[k] = p.slice();
  else if (e.t === 'text') e.p = p.slice();
  else if (e.t === 'spline') e.pts[+k.slice(1)] = p.slice();
  else if (e.t === 'ellipse' && k === 'c') e.c = p.slice();
  else if ((e.t === 'circle' || e.t === 'arc') && k === 'c') e.c = p.slice();
  else if (e.t === 'arc') {
    const sw = sweep(e);
    const a = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
    e.r = d2(p, e.c);
    if (k === 's') e.a0 = a; else { e.a1 = a; if (Math.abs(sweep(e) - sw) > Math.PI && sw > Math.PI) { /* keep large arcs large */ } }
  } else if (e.t === 'rect') {
    const i = +k.slice(1), cs = rectCorners(e), opp = cs[(i + 2) % 4];
    e.x = Math.min(opp[0], p[0]); e.y = Math.min(opp[1], p[1]); e.w = Math.abs(p[0] - opp[0]); e.h = Math.abs(p[1] - opp[1]);
  }
}

// ---------- discretisation ----------
export const ellPt = (e, t) => { const c = Math.cos(e.rot), s = Math.sin(e.rot), x = e.rx * ecos(t), y = e.ry * esin(t); return [e.c[0] + x * c - y * s, e.c[1] + x * s + y * c]; };
// Catmull-Rom spline through the fit points (AutoCAD SPLINE "fit" method)
export function splinePoints(pts, closed, per = 16) {
  const n = pts.length; if (n < 2) return pts.slice();
  const P = i => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out = [], segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}
export function entPolyline(e) {
  if (e.t === 'line') return { pts: [e.a, e.b], closed: false };
  if (e.t === 'ellipse') { const n = curveSegs(), pts = []; for (let i = 0; i < n; i++) pts.push(ellPt(e, i / n * TAU)); return { pts, closed: true }; }
  if (e.t === 'spline') return { pts: splinePoints(e.pts, !!e.closed), closed: !!e.closed };
  if (e.t === 'rect') return { pts: rectCorners(e), closed: true };
  const n = curveSegs();
  if (e.t === 'circle') { const pts = []; for (let i = 0; i < n; i++) pts.push(pol(e.c, e.r, i / n * TAU)); return { pts, closed: true }; }
  if (e.t === 'arc') {
    const sw = sweep(e), k = Math.max(2, Math.ceil(n * sw / TAU)), pts = [];
    for (let i = 0; i <= k; i++) pts.push(pol(e.c, e.r, e.a0 + sw * i / k));
    return { pts, closed: false };
  }
  return null;
}
export function sketchSegments(sk) {
  const segs = [];
  for (const e of sk.ents) {
    if (e.t === 'dim' || e.construction) continue;
    const pl = entPolyline(e); if (!pl) continue;
    const n = pl.pts.length;
    for (let i = 0; i < (pl.closed ? n : n - 1); i++) segs.push([pl.pts[i], pl.pts[(i + 1) % n], e.id]);
  }
  return segs;
}

function segInter(p, p2, q, q2) {
  const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-14) return null;
  const qp = [q[0] - p[0], q[1] - p[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)), p: [p[0] + r[0] * t, p[1] + r[1] * t] };
}

// ---------- exact analytic intersections ----------
export function prims(e) {
  if (e.t === 'line') return [{ L: 1, a: e.a, b: e.b }];
  if (e.t === 'rect') { const c = rectCorners(e); return [0, 1, 2, 3].map(i => ({ L: 1, a: c[i], b: c[(i + 1) % 4] })); }
  if (e.t === 'circle') return [{ C: 1, c: e.c, r: e.r }];
  if (e.t === 'arc') return [{ C: 1, c: e.c, r: e.r, a0: e.a0, sw: sweep(e) }];
  if (e.t === 'ellipse' || e.t === 'spline') { const pl = entPolyline(e), n = pl.pts.length, out = []; for (let i = 0; i < (pl.closed ? n : n - 1); i++) out.push({ L: 1, a: pl.pts[i], b: pl.pts[(i + 1) % n] }); return out; }
  return [];
}
const onArc = (q, p) => { if (q.sw == null) return true; let a = Math.atan2(p[1] - q.c[1], p[0] - q.c[0]) - q.a0; a = ((a % TAU) + TAU) % TAU; return a <= q.sw + 1e-9 || a >= TAU - 1e-9; };
export function interPrims(P, Q) {
  const out = [];
  if (P.L && Q.L) { const r = segInter(P.a, P.b, Q.a, Q.b); if (r) out.push(r.p); }
  else if (P.C && Q.C) {
    const d = d2(P.c, Q.c);
    if (d < 1e-12 || d > P.r + Q.r + 1e-9 || d < Math.abs(P.r - Q.r) - 1e-9) return out;
    const a = (P.r * P.r - Q.r * Q.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, P.r * P.r - a * a));
    const ux = (Q.c[0] - P.c[0]) / d, uy = (Q.c[1] - P.c[1]) / d, mx = P.c[0] + ux * a, my = P.c[1] + uy * a;
    out.push([mx - uy * h, my + ux * h]); if (h > 1e-12) out.push([mx + uy * h, my - ux * h]);
  } else {
    const Ln = P.L ? P : Q, C = P.L ? Q : P;
    const dx = Ln.b[0] - Ln.a[0], dy = Ln.b[1] - Ln.a[1], fx = Ln.a[0] - C.c[0], fy = Ln.a[1] - C.c[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), Cc = fx * fx + fy * fy - C.r * C.r;
    const disc = B * B - 4 * A * Cc;
    if (A < 1e-24 || disc < -1e-12) return out;
    const sq = Math.sqrt(Math.max(0, disc));
    for (const t of disc > 1e-12 ? [(-B - sq) / (2 * A), (-B + sq) / (2 * A)] : [-B / (2 * A)]) if (t >= -1e-9 && t <= 1 + 1e-9) out.push([Ln.a[0] + dx * t, Ln.a[1] + dy * t]);
  }
  return out.filter(p => (!P.C || onArc(P, p)) && (!Q.C || onArc(Q, p)));
}
const interCache = new WeakMap();
export function intersections(sk) {
  if (interCache.has(sk.ents)) return interCache.get(sk.ents);
  const ents = sk.ents.filter(e => e.t !== 'dim'), out = [];
  for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++)
    for (const P of prims(ents[i])) for (const Q of prims(ents[j])) out.push(...interPrims(P, Q));
  interCache.set(sk.ents, out);
  return out;
}
// points where entity e is crossed by other entities
function cutsOn(sk, e) {
  const out = [];
  for (const o of sk.ents) { if (o === e || o.t === 'dim') continue; for (const P of prims(e)) for (const Q of prims(o)) out.push(...interPrims(P, Q)); }
  return out;
}
const uniq = arr => arr.sort((a, b) => a - b).filter((v, i, A) => i === 0 || v - A[i - 1] > 1e-10);
// Trim the piece of entity `e` under point p (between neighbouring intersections). Mutates sk.
export function trimAt(sk, e, p) {
  const idx = sk.ents.indexOf(e);
  const nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  if (e.t === 'rect') { // explode, then trim the side
    const c = rectCorners(e), lines = [0, 1, 2, 3].map(i => ({ id: nid(), t: 'line', a: c[i], b: c[(i + 1) % 4] }));
    sk.ents.splice(idx, 1, ...lines);
    const side = lines.reduce((b, l) => (segDist(p, l.a, l.b) < segDist(p, b.a, b.b) ? l : b));
    return trimAt(sk, side, p);
  }
  const cuts = cutsOn(sk, e);
  const remove = () => { sk.ents.splice(sk.ents.indexOf(e), 1); };
  if (e.t === 'line') {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], L2 = dx * dx + dy * dy;
    const par = q => ((q[0] - e.a[0]) * dx + (q[1] - e.a[1]) * dy) / L2;
    const ts = uniq(cuts.map(par).filter(t => t > 1e-9 && t < 1 - 1e-9));
    const tp = par(p);
    const lo = Math.max(0, ...ts.filter(t => t < tp)), hi = Math.min(1, ...ts.filter(t => t > tp));
    const at = t => { const q = cuts.find(c => Math.abs(par(c) - t) < 1e-10); return q ? q.slice() : [e.a[0] + dx * t, e.a[1] + dy * t]; };
    const keep = [];
    if (lo > 0) keep.push({ id: nid(), t: 'line', a: e.a.slice(), b: at(lo) });
    if (hi < 1) keep.push({ id: nid(), t: 'line', a: at(hi), b: e.b.slice() });
    sk.ents.splice(sk.ents.indexOf(e), 1, ...keep);
    return true;
  }
  const ang = q => Math.atan2(q[1] - e.c[1], q[0] - e.c[0]);
  if (e.t === 'circle') {
    const as = uniq(cuts.map(q => ((ang(q) % TAU) + TAU) % TAU));
    if (as.length < 2) { remove(); return true; }
    const ap = ((ang(p) % TAU) + TAU) % TAU;
    let i = as.findIndex(a => a > ap); if (i < 0) i = 0;
    const end = as[i], start = as[(i - 1 + as.length) % as.length]; // removed piece: start -> end (CCW)
    sk.ents.splice(sk.ents.indexOf(e), 1, { id: nid(), t: 'arc', c: e.c.slice(), r: e.r, a0: end, a1: start });
    return true;
  }
  if (e.t === 'ellipse' || e.t === 'spline') {
    const pl = entPolyline(e), P = pl.pts, n = P.length, segN = pl.closed ? n : n - 1;
    const S = [0]; for (let i = 0; i < segN; i++) S.push(S[i] + d2(P[i], P[(i + 1) % n]));
    const total = S[segN];
    const param = q => { let best = null; for (let i = 0; i < segN; i++) { const A = P[i], B = P[(i + 1) % n], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy; let t = L2 ? ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const dd = Math.hypot(A[0] + dx * t - q[0], A[1] + dy * t - q[1]); if (!best || dd < best.d) best = { d: dd, s: S[i] + t * Math.sqrt(L2) }; } return best.s; };
    const at = sv => { let i = 0; while (i < segN - 1 && S[i + 1] < sv) i++; const A = P[i], B = P[(i + 1) % n], t = (sv - S[i]) / ((S[i + 1] - S[i]) || 1); return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; };
    const piece = (s0, s1) => { const pts = [at(s0)]; for (let i = 0; i <= segN; i++) if (S[i] > s0 + 1e-9 && S[i] < s1 - 1e-9) pts.push(P[i % n].slice()); pts.push(at(s1)); return pts.length >= 2 ? { id: nid(), t: 'spline', pts } : null; };
    const ss = uniq(cuts.map(param).filter(v => v > 1e-9 && v < total - 1e-9)), sp = param(p);
    const keep = [];
    if (pl.closed) {
      if (ss.length < 2) { remove(); return true; }
      let i = ss.findIndex(v => v > sp); if (i < 0) i = 0;
      const end = ss[i], start = ss[(i - 1 + ss.length) % ss.length]; // removed piece: start → end
      if (end > start) { const a1 = piece(end, total), a2 = piece(0, start); if (a1 && a2) { a1.pts = a1.pts.concat(a2.pts.slice(1)); keep.push(a1); } }
      else { const k = piece(end, start); if (k) keep.push(k); }
    } else {
      const lo = Math.max(0, ...ss.filter(v => v < sp)), hi = Math.min(total, ...ss.filter(v => v > sp));
      if (lo > 1e-9) { const k = piece(0, lo); if (k) keep.push(k); }
      if (hi < total - 1e-9) { const k = piece(hi, total); if (k) keep.push(k); }
    }
    sk.ents.splice(sk.ents.indexOf(e), 1, ...keep);
    return true;
  }
  if (e.t === 'arc') {
    const sw = sweep(e), off = q => { let a = ang(q) - e.a0; return ((a % TAU) + TAU) % TAU; };
    const ts = uniq(cuts.map(off).filter(t => t > 1e-9 && t < sw - 1e-9));
    const tp = off(p);
    const lo = Math.max(0, ...ts.filter(t => t < tp)), hi = Math.min(sw, ...ts.filter(t => t > tp));
    const keep = [];
    if (lo > 1e-9) keep.push({ id: nid(), t: 'arc', c: e.c.slice(), r: e.r, a0: e.a0, a1: e.a0 + lo });
    if (hi < sw - 1e-9) keep.push({ id: nid(), t: 'arc', c: e.c.slice(), r: e.r, a0: e.a0 + hi, a1: e.a0 + sw });
    sk.ents.splice(sk.ents.indexOf(e), 1, ...keep);
    return true;
  }
  return false;
}

// ---------- region detection (planar arrangement faces) ----------
const regionCache = new WeakMap();
export function regions(sk) {
  if (regionCache.has(sk.ents)) return regionCache.get(sk.ents);
  const segs = sketchSegments(sk);
  // split segments at all intersections
  const cuts = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const r = segInter(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
    if (r) { cuts[i].push(r.t); cuts[j].push(r.u); }
  }
  const Q = 1e-6, keyOf = p => Math.round(p[0] / Q) + ',' + Math.round(p[1] / Q);
  const nodes = new Map(); // key -> {p, out:[]}
  const node = p => { const k = keyOf(p); if (!nodes.has(k)) nodes.set(k, { k, p, out: [] }); return nodes.get(k); };
  const edgeSet = new Set();
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i].map(t => Math.round(t * 1e12) / 1e12))].sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      const pa = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const pb = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      const A = node(pa), B = node(pb);
      if (A === B) continue;
      const ek = A.k < B.k ? A.k + '|' + B.k : B.k + '|' + A.k;
      if (edgeSet.has(ek)) continue; edgeSet.add(ek);
      A.out.push(B); B.out.push(A);
    }
  });
  // sort outgoing by angle
  for (const n of nodes.values()) n.out.sort((x, y) => Math.atan2(x.p[1] - n.p[1], x.p[0] - n.p[0]) - Math.atan2(y.p[1] - n.p[1], y.p[0] - n.p[0]));
  const used = new Set(), faces = [];
  for (const n of nodes.values()) for (const m of n.out) {
    if (used.has(n.k + '>' + m.k)) continue;
    const loop = []; let a = n, b = m, guard = 0;
    while (!used.has(a.k + '>' + b.k) && guard++ < 1e5) {
      used.add(a.k + '>' + b.k); loop.push(a.p);
      // next: at b, the edge just clockwise from the reverse direction (b->a)
      const i = b.out.indexOf(a);
      const nx = b.out[(i - 1 + b.out.length) % b.out.length];
      a = b; b = nx;
    }
    faces.push(loop);
  }
  const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
  const clean = pts => { // remove spikes (dangling edges)
    let r = pts.slice(), ch = true;
    while (ch && r.length > 2) { ch = false; for (let i = 0; i < r.length; i++) { const p = r[(i - 1 + r.length) % r.length], q = r[(i + 1) % r.length]; if (d2(p, q) < 1e-9) { r.splice(i, 1); r.splice(i % r.length, 1); ch = true; break; } } }
    return r;
  };
  const outers = [], bounds = [];
  for (const f of faces) { const c = clean(f); if (c.length < 3) continue; const A = area(c); if (A > 1e-9) outers.push({ outer: c, area: A, holes: [] }); else if (A < -1e-9) bounds.push(c); }
  // assign component boundaries (CW) as holes of the smallest containing face that is not their own
  for (const b of bounds) {
    const probe = b[0];
    let best = null;
    for (const r of outers) {
      if (sharesBoundary(b, r.outer) || !pointInPoly(probe, r.outer)) continue;
      if (!best || r.area < best.area) best = r;
    }
    if (best) best.holes.push(b);
  }
  // drop holes nested inside other holes of the same face
  for (const r of outers) r.holes = r.holes.filter(h => !r.holes.some(o => o !== h && pointInPoly(h[0], o) && Math.abs(area(o)) > Math.abs(area(h))));
  regionCache.set(sk.ents, outers);
  return outers;
}
function sharesBoundary(a, b) { const s = new Set(b.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6))); let n = 0; for (const p of a) if (s.has(p[0].toFixed(6) + ',' + p[1].toFixed(6))) n++; return n >= Math.min(a.length, 3); }
export function pointInPoly(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins;
  }
  return ins;
}
export function regionAt(sk, p) {
  let best = null;
  for (const r of regions(sk)) if (pointInPoly(p, r.outer) && !r.holes.some(h => pointInPoly(p, h)) && (!best || r.area < best.area)) best = r;
  return best;
}

// ---------- snapping ----------
// returns { p, kind, ref? }
export function snapPoint(sk, raw, opts) {
  const { pxTol, wpp, from, refPts = [], exclude = null } = opts;
  const tol = pxTol * wpp;
  let best = null;
  const consider = (p, kind, rank, ref) => { if (exclude && d2(p, exclude) < 1e-9) return; const d = d2(p, raw); if (d <= tol && (!best || rank < best.rank || (rank === best.rank && d < best.d))) best = { p: p.slice(), kind, rank, d, ref }; };
  const osnap = opts.osnap !== false;
  if (osnap) for (const e of sk.ents) {
    if (e.t === 'dim') continue;
    for (const kp of keyPoints(e)) consider(kp.p, kp.center ? 'Center' : kp.k === 'mid' ? 'Mid' : kp.k[0] === 'q' ? 'Quad' : 'End', kp.k === 'mid' || kp.k[0] === 'q' ? 2 : 0, kp.m ? { e: e.id, k: kp.k } : null);
  }
  if (osnap) {
    for (const p of intersections(sk)) consider(p, 'Int', 1);
    for (const p of refPts) consider(p, 'Vertex', 0);
    consider([0, 0], 'Origin', 0);
  }
  if (best) return best;
  if (from && opts.ortho) {
    const dx = raw[0] - from[0], dy = raw[1] - from[1];
    let l = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    if (S.settings.snap) l = Math.round(l / S.settings.snapStep) * S.settings.snapStep;
    return Math.abs(dx) >= Math.abs(dy) ? { p: [from[0] + l, from[1]], kind: 'Ortho' } : { p: [from[0], from[1] + l], kind: 'Ortho' };
  }
  if (from && opts.polar !== false) {
    // polar tracking
    const dx = raw[0] - from[0], dy = raw[1] - from[1], L = Math.hypot(dx, dy);
    if (L > tol) {
      const a = Math.atan2(dy, dx) * 180 / Math.PI;
      const st = S.settings.angleStep || 15;
      const sa = Math.round(a / st) * st;
      if (Math.abs(a - sa) < 4) {
        let l = L * Math.cos((a - sa) * Math.PI / 180);
        if (S.settings.snap) l = Math.round(l / S.settings.snapStep) * S.settings.snapStep;
        const r = sa * Math.PI / 180;
        return { p: [from[0] + l * ecos(r), from[1] + l * esin(r)], kind: `${(((sa % 360) + 360) % 360)}°` };
      }
    }
  }
  if (S.settings.snap) { const st = S.settings.snapStep; return { p: raw.map(c => Math.round(c / st) * st), kind: 'Grid' }; }
  return { p: raw.slice(), kind: '' };
}

// nearest entity to a 2D point (for selection), within tol
export function pickEntity(sk, p, tol) {
  let best = null;
  for (const e of sk.ents) {
    let d;
    if (e.t === 'dim') continue;
    if (e.t === 'text') { const box = textBox(e); if (pointInPoly(p, box) || box.some((q, i) => segDist(p, q, box[(i + 1) % 4]) <= tol)) { if (!best || tol * 0.5 < best.d) best = { e, d: tol * 0.5 }; } continue; }
    if (e.t === 'hatch') continue;
    const pl = entPolyline(e);
    d = Infinity;
    const n = pl.pts.length;
    for (let i = 0; i < (pl.closed ? n : n - 1); i++) d = Math.min(d, segDist(p, pl.pts[i], pl.pts[(i + 1) % n]));
    if (d <= tol && (!best || d < best.d)) best = { e, d };
  }
  if (!best) for (const e of sk.ents) if (e.t === 'hatch') { const r = regionAt(sk, e.seed); if (r && pointInPoly(p, r.outer) && !r.holes.some(hh => pointInPoly(p, hh))) return e; }
  return best ? best.e : null;
}
// approximate text extents (0.6 em per character) for picking and DXF
export function textBox(e) {
  const w = e.h * 0.62 * Math.max(1, e.str.length), a = (e.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [[0, 0], [w, 0], [w, e.h], [0, e.h]].map(([x, y]) => [e.p[0] + x * c - y * s, e.p[1] + x * s + y * c]);
}
// ---------- HATCH: pattern lines clipped to the region around the seed point ----------
export const HATCH_PATTERNS = { ANSI31: [{ ang: 45, sp: 3.175 }], ANSI37: [{ ang: 45, sp: 3.175 }, { ang: 135, sp: 3.175 }], NET: [{ ang: 0, sp: 3.175 }, { ang: 90, sp: 3.175 }], LINE: [{ ang: 0, sp: 3.175 }], SOLID: [] };
export function hatchLines(sk, e) {
  const r = regionAt(sk, e.seed); if (!r) return null;
  const loops = [r.outer, ...r.holes], out = [];
  for (const fam of HATCH_PATTERNS[e.pattern] || []) {
    const a = (fam.ang + (e.angle || 0)) * Math.PI / 180, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]], sp = fam.sp * (e.scale || 1);
    const ts = loops.flat().map(q => q[0] * v[0] + q[1] * v[1]), t0 = Math.min(...ts), t1 = Math.max(...ts);
    if ((t1 - t0) / sp > 4000) continue;
    for (let t = Math.ceil(t0 / sp) * sp; t <= t1; t += sp) {
      const xs = [];
      for (const L of loops) for (let i = 0; i < L.length; i++) {
        const A = L[i], B = L[(i + 1) % L.length], ta = A[0] * v[0] + A[1] * v[1] - t, tb = B[0] * v[0] + B[1] * v[1] - t;
        if ((ta < 0) !== (tb < 0)) { const k = ta / (ta - tb), P = [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k]; xs.push(P[0] * u[0] + P[1] * u[1]); }
      }
      xs.sort((x, y) => x - y);
      for (let i = 0; i + 1 < xs.length; i += 2) out.push([[u[0] * xs[i] + v[0] * t, u[1] * xs[i] + v[1] * t], [u[0] * xs[i + 1] + v[0] * t, u[1] * xs[i + 1] + v[1] * t]]);
    }
  }
  return { region: r, lines: out };
}
export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

// ---------- dimensions ----------
export function lineAngle(sk, d) {
  const a = entById(sk, d.la), b = entById(sk, d.lb); if (!a || !b) return null;
  let x = Math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0]) - Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0]);
  x = Math.atan2(Math.sin(x), Math.cos(x));
  return x * 180 / Math.PI;
}
export function dimValue(sk, d) {
  if (d.kind === 'hor' || d.kind === 'ver') { const A = refPoint(sk, d.A), B = refPoint(sk, d.B); return A && B ? Math.abs(d.kind === 'hor' ? B[0] - A[0] : B[1] - A[1]) : null; }
  if (d.kind === 'ang') { const v = lineAngle(sk, d); return v == null ? null : Math.abs(v); }
  if (d.kind === 'lin') { const A = refPoint(sk, d.A), B = refPoint(sk, d.B); return A && B ? d2(A, B) : null; }
  const e = entById(sk, d.e); if (!e) return null;
  return d.kind === 'dia' ? 2 * e.r : e.r;
}
export function setDimValue(sk, d, v) {
  if (sk.cons && sk.cons.length || sk.ents.some(x => x.t === 'dim' && x.value != null)) {
    const err = editAndSolve(sk, () => {
      d.value = d.kind === 'ang' || d.kind === 'hor' || d.kind === 'ver' ? Math.sign(d.value || 1) * v : v;
      if (d.kind === 'ang') { // rotate the second line about its start so its length is kept
        const a = entById(sk, d.la), b = entById(sk, d.lb);
        if (a && b) { const base = Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0]) + d.value * Math.PI / 180, L = d2(b.a, b.b); b.b = [b.a[0] + L * Math.cos(base), b.a[1] + L * Math.sin(base)]; }
      }
    }, { heavyRefs: d.kind === 'lin' || d.kind === 'hor' || d.kind === 'ver' ? [d.A] : d.kind === 'ang' ? [{ e: d.la, k: 'a' }, { e: d.la, k: 'b' }] : [] });
    if (!err) return;
    d.value = null; // fall back to a direct edit below
  }
  if (d.kind === 'ang') {
    const a = entById(sk, d.la), b = entById(sk, d.lb); if (!a || !b) return 'Missing line';
    const sgn = Math.sign(lineAngle(sk, d) || 1), base = Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0]) + sgn * v * Math.PI / 180;
    const L = d2(b.a, b.b); b.b = [b.a[0] + L * Math.cos(base), b.a[1] + L * Math.sin(base)];
    d.value = sgn * v; return;
  }
  if (d.value !== undefined) d.value = v;
  if (d.kind === 'lin') {
    const A = refPoint(sk, d.A), B = refPoint(sk, d.B);
    const L = d2(A, B); if (L < 1e-12) return 'Points coincide';
    movePoint(sk, d.B, [A[0] + (B[0] - A[0]) * v / L, A[1] + (B[1] - A[1]) * v / L]);
  } else {
    const e = entById(sk, d.e); if (!e) return 'Missing entity';
    e.r = d.kind === 'dia' ? v / 2 : v;
  }
}

// ---------- DXF (R12-compatible ASCII, millimetres) ----------
export function toDXF(sk) {
  const L = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const f = v => (+v.toFixed(9)).toString();
  const line = (a, b) => L.push('0', 'LINE', '8', '0', '10', f(a[0]), '20', f(a[1]), '30', '0', '11', f(b[0]), '21', f(b[1]), '31', '0');
  for (const e of sk.ents) {
    if (e.t === 'line') line(e.a, e.b);
    else if (e.t === 'rect') { const c = rectCorners(e); for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4]); }
    else if (e.t === 'circle') L.push('0', 'CIRCLE', '8', '0', '10', f(e.c[0]), '20', f(e.c[1]), '30', '0', '40', f(e.r));
    else if (e.t === 'ellipse') L.push('0', 'ELLIPSE', '8', '0', '10', f(e.c[0]), '20', f(e.c[1]), '30', '0', '11', f(e.rx * Math.cos(e.rot)), '21', f(e.rx * Math.sin(e.rot)), '31', '0', '40', f(e.ry / e.rx), '41', '0', '42', f(TAU));
    else if (e.t === 'spline') { const pl = entPolyline(e), n = pl.pts.length; for (let i = 0; i < (pl.closed ? n : n - 1); i++) line(pl.pts[i], pl.pts[(i + 1) % n]); }
    else if (e.t === 'text') L.push('0', 'TEXT', '8', '0', '10', f(e.p[0]), '20', f(e.p[1]), '30', '0', '40', f(e.h), '50', f(e.rot || 0), '1', e.str.replace(/[\r\n]/g, ' '));
    else if (e.t === 'hatch') { const hl = hatchLines(sk, e); if (hl) for (const [a, b] of hl.lines) line(a, b); }
    else if (e.t === 'arc') L.push('0', 'ARC', '8', '0', '10', f(e.c[0]), '20', f(e.c[1]), '30', '0', '40', f(e.r), '50', f(e.a0 * 180 / Math.PI), '51', f((e.a0 + sweep(e)) * 180 / Math.PI));
  }
  L.push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\n') + '\n';
}

// remove constraints / dims that reference deleted entities
export function pruneCons(sk) {
  const ids = new Set(sk.ents.map(e => e.id));
  sk.cons = (sk.cons || []).filter(c => ids.has(c.a) && (c.b == null || ids.has(c.b)) && (!c.p || ids.has(c.p.e)));
  sk.ents = sk.ents.filter(d => d.t !== 'dim' || (d.kind === 'lin' || d.kind === 'hor' || d.kind === 'ver' ? ids.has(d.A.e) && ids.has(d.B.e) && refPoint(sk, d.A) && refPoint(sk, d.B) : d.kind === 'ang' ? ids.has(d.la) && ids.has(d.lb) : ids.has(d.e)));
}
export const CONS_LABEL = { h: 'H', v: 'V', par: '∥', perp: '⊥', eq: '=', tan: 'T', conc: '◎', fix: '⚓', mid: 'M' };

// ---------- 2D corner fillet / chamfer ----------
// Finds two lines meeting at the corner nearest p (within tol), then rounds (arc radius r) or bevels (distance r).
export function explodeRect(sk, e) {
  const idx = sk.ents.indexOf(e);
  const c = rectCorners(e);
  const lines = [0, 1, 2, 3].map(i => ({ id: (sk.nextEnt = (sk.nextEnt || 1000) + 1), t: 'line', a: c[i].slice(), b: c[(i + 1) % 4].slice() }));
  sk.ents.splice(idx, 1, ...lines);
  return lines;
}
export function findCorner(sk, p, tol) {
  // explode rectangles whose corner is near p
  for (const e of sk.ents.slice()) if (e.t === 'rect' && rectCorners(e).some(c => d2(c, p) <= tol)) explodeRect(sk, e);
  let best = null;
  const ends = [];
  for (const e of sk.ents) if (e.t === 'line') { ends.push({ e, k: 'a', p: e.a }); ends.push({ e, k: 'b', p: e.b }); }
  else if (e.t === 'arc') { ends.push({ e, k: 's', p: pol(e.c, e.r, e.a0) }); ends.push({ e, k: 'e', p: pol(e.c, e.r, e.a0 + sweep(e)) }); }
  for (const q of ends) {
    if (d2(q.p, p) > tol) continue;
    const mates = ends.filter(o => o.e !== q.e && d2(o.p, q.p) < 1e-7);
    if (mates.length === 1 && (!best || d2(q.p, p) < best.d)) best = { d: d2(q.p, p), A: q, B: mates[0] };
  }
  return best;
}
export function cornerOp(sk, p, tol, r, kind) {
  const c = findCorner(sk, p, tol);
  if (!c) return 'Tap a corner where exactly two lines (or a line and an arc) meet';
  if (c.A.e.t === 'arc' && c.B.e.t === 'arc') return arcArcCorner(sk, c.A, c.B, r, kind);
  if (c.A.e.t === 'arc' || c.B.e.t === 'arc') return lineArcCorner(sk, c.A.e.t === 'line' ? c.A : c.B, c.A.e.t === 'arc' ? c.A : c.B, r, kind);
  const P = c.A.p.slice();
  const other = q => (q.k === 'a' ? q.e.b : q.e.a);
  const u1 = norm2(sub2(other(c.A), P)), u2 = norm2(sub2(other(c.B), P));
  const L1 = d2(other(c.A), P), L2 = d2(other(c.B), P);
  const cosT = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])), th = Math.acos(cosT);
  if (th < 1e-6 || Math.PI - th < 1e-6) return 'Lines are parallel';
  const t = kind === 'chamfer' ? r : r / Math.tan(th / 2);
  if (t > L1 + 1e-9 || t > L2 + 1e-9) return `Too large: needs ${(t).toFixed(3)} mm of each line`;
  const T1 = [P[0] + u1[0] * t, P[1] + u1[1] * t], T2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];
  c.A.e[c.A.k] = T1; c.B.e[c.B.k] = T2;
  sk.ents = sk.ents.filter(e => !(e.t === 'line' && d2(e.a, e.b) < 1e-9));
  const nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  if (kind === 'chamfer') { const ln = { id: nid(), t: 'line', a: T1, b: T2 }; sk.ents.push(ln); return { ent: ln }; }
  const bis = norm2([u1[0] + u2[0], u1[1] + u2[1]]);
  const dc = r / Math.sin(th / 2);
  const C = [P[0] + bis[0] * dc, P[1] + bis[1] * dc];
  const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
  const want = Math.PI - th;
  let s12 = ((a2 - a1) % TAU + TAU) % TAU;
  const arc = Math.abs(s12 - want) < 1e-6 ? { a0: a1, a1: a1 + want } : { a0: a2, a1: a2 + want };
  const e = { id: nid(), t: 'arc', c: C, r, ...arc };
  sk.ents.push(e);
  sk.cons = sk.cons || [];
  sk.cons.push({ id: nid(), t: 'tan', a: c.A.e.id, b: e.id }, { id: nid(), t: 'tan', a: c.B.e.id, b: e.id });
  return { ent: e };
}
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const norm2 = a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };


// ---------- AutoCAD-style edit commands ----------
const isQuarter = (deg, step = 90) => { const r = ((deg % step) + step) % step; return r < 1e-9 || step - r < 1e-9; };
const rot = (p, c, a) => { const co = ecos(a), si = esin(a), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * co - y * si, c[1] + x * si + y * co]; };
const refl = (p, A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy, t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
  const fx = A[0] + dx * t, fy = A[1] + dy * t; return [2 * fx - p[0], 2 * fy - p[1]];
};
const clean = v => { const q = Math.round(v * 1e9) / 1e9; return Math.abs(v - q) < 1e-11 ? (q === 0 ? 0 : q) : v; };
const cp = p => [clean(p[0]), clean(p[1])];
function rectFromCorners(e, pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  e.x = clean(Math.min(...xs)); e.y = clean(Math.min(...ys)); e.w = clean(Math.max(...xs) - e.x); e.h = clean(Math.max(...ys) - e.y);
}
// op: {kind:'move', d} | {kind:'rotate', c, deg} | {kind:'scale', c, f} | {kind:'mirror', a, b}
// Returns the ids of the transformed (or newly copied) entities.
export function transformEntities(sk, ids, op, copy = false) {
  const nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  let targets = sk.ents.filter(e => ids.includes(e.id) && e.t !== 'dim');
  if (op.kind === 'scale' && !(op.f > 0)) return 'Scale factor must be > 0';
  if (copy) { targets = targets.map(e => { const c = JSON.parse(JSON.stringify(e)); c.id = nid(); sk.ents.push(c); return c; }); }
  // rectangles that would stop being axis-aligned become lines
  const needLines = e => e.t === 'rect' && ((op.kind === 'rotate' && !isQuarter(op.deg)) || (op.kind === 'mirror' && !isQuarter(Math.atan2(op.b[1] - op.a[1], op.b[0] - op.a[0]) * 180 / Math.PI, 45)));
  targets = targets.flatMap(e => (needLines(e) ? explodeRect(sk, e) : [e]));
  const P = op.kind === 'move' ? p => [p[0] + op.d[0], p[1] + op.d[1]]
    : op.kind === 'rotate' ? p => rot(p, op.c, op.deg * Math.PI / 180)
      : op.kind === 'scale' ? p => [op.c[0] + (p[0] - op.c[0]) * op.f, op.c[1] + (p[1] - op.c[1]) * op.f]
        : p => refl(p, op.a, op.b);
  for (const e of targets) {
    if (e.t === 'line') { e.a = cp(P(e.a)); e.b = cp(P(e.b)); }
    else if (e.t === 'rect') rectFromCorners(e, rectCorners(e).map(P));
    else if (e.t === 'spline') e.pts = e.pts.map(q => cp(P(q)));
    else if (e.t === 'text') { e.p = cp(P(e.p)); if (op.kind === 'scale') e.h = clean(e.h * op.f); if (op.kind === 'rotate') e.rot = (e.rot || 0) + op.deg; }
    else if (e.t === 'hatch') { e.seed = cp(P(e.seed)); if (op.kind === 'scale') e.scale = clean(e.scale * op.f); if (op.kind === 'rotate') e.angle = (e.angle || 0) + op.deg; if (op.kind === 'mirror') e.angle = 2 * Math.atan2(op.b[1] - op.a[1], op.b[0] - op.a[0]) * 180 / Math.PI - (e.angle || 0); }
    else if (e.t === 'ellipse') {
      e.c = cp(P(e.c));
      if (op.kind === 'scale') { e.rx = clean(e.rx * op.f); e.ry = clean(e.ry * op.f); }
      if (op.kind === 'rotate') e.rot += op.deg * Math.PI / 180;
      if (op.kind === 'mirror') e.rot = 2 * Math.atan2(op.b[1] - op.a[1], op.b[0] - op.a[0]) - e.rot;
    }
    else if (e.t === 'circle' || e.t === 'arc') {
      e.c = cp(P(e.c));
      if (op.kind === 'scale') e.r = clean(e.r * op.f);
      if (e.t === 'arc') {
        const sw = sweep(e);
        if (op.kind === 'rotate') { e.a0 += op.deg * Math.PI / 180; e.a1 = e.a0 + sw; }
        else if (op.kind === 'mirror') { const phi = Math.atan2(op.b[1] - op.a[1], op.b[0] - op.a[0]); const a0 = 2 * phi - (e.a0 + sw); e.a0 = a0; e.a1 = a0 + sw; }
      }
    }
  }
  const tid = new Set(targets.map(e => e.id));
  if (!copy) {
    // orientation constraints no longer hold after rotate / mirror; fixes never hold after a transform
    sk.cons = (sk.cons || []).filter(c => !(tid.has(c.a) || tid.has(c.b)) || !(c.t === 'fix' || ((op.kind === 'rotate' || op.kind === 'mirror') && (c.t === 'h' || c.t === 'v'))));
    // dimensions on moved geometry now measure what is drawn
    for (const d of sk.ents) if (d.t === 'dim' && d.value != null) {
      const touches = d.kind === 'lin' ? tid.has(d.A.e) || tid.has(d.B.e) : d.kind === 'ang' ? tid.has(d.la) || tid.has(d.lb) : tid.has(d.e);
      if (touches) d.value = d.kind === 'ang' ? lineAngle(sk, d) : dimValue(sk, d);
    }
  }
  return [...tid];
}

// AutoCAD OFFSET: a parallel copy of e at distance d on the side of point `side`.
export function offsetEntity(sk, e, d, side) {
  const nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  let n = null;
  if (e.t === 'line') {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], L = Math.hypot(dx, dy);
    if (L < 1e-12) return 'Zero-length line';
    const nx = -dy / L, ny = dx / L, s = Math.sign((side[0] - e.a[0]) * nx + (side[1] - e.a[1]) * ny) || 1;
    n = { t: 'line', a: cp([e.a[0] + nx * d * s, e.a[1] + ny * d * s]), b: cp([e.b[0] + nx * d * s, e.b[1] + ny * d * s]) };
  } else if (e.t === 'circle' || e.t === 'arc') {
    const r = d2(side, e.c) < e.r ? e.r - d : e.r + d;
    if (r <= 1e-9) return 'Offset distance is larger than the radius';
    n = { ...JSON.parse(JSON.stringify(e)), r: clean(r) };
  } else if (e.t === 'rect') {
    const inside = side[0] > e.x && side[0] < e.x + e.w && side[1] > e.y && side[1] < e.y + e.h, s = inside ? -1 : 1;
    if (e.w + 2 * s * d <= 1e-9 || e.h + 2 * s * d <= 1e-9) return 'Offset collapses the rectangle';
    n = { t: 'rect', x: clean(e.x - s * d), y: clean(e.y - s * d), w: clean(e.w + 2 * s * d), h: clean(e.h + 2 * s * d) };
  } else if (e.t === 'ellipse' || e.t === 'spline') {
    // offset curve of an ellipse/spline is a spline through offset sample points (as AutoCAD does)
    const pl = entPolyline(e), P = pl.pts, n = P.length, N = [];
    for (let i = 0; i < n; i++) {
      const a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
      const t = pl.closed ? [b[0] - a[0], b[1] - a[1]] : i === 0 ? [P[1][0] - P[0][0], P[1][1] - P[0][1]] : i === n - 1 ? [P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]] : [b[0] - a[0], b[1] - a[1]];
      const L = Math.hypot(t[0], t[1]) || 1; N.push([-t[1] / L, t[0] / L]);
    }
    let bi = 0; P.forEach((q, i) => { if (d2(q, side) < d2(P[bi], side)) bi = i; });
    const sgn = Math.sign((side[0] - P[bi][0]) * N[bi][0] + (side[1] - P[bi][1]) * N[bi][1]) || 1;
    if (e.t === 'ellipse' && pointInPoly(side, P) && d >= Math.min(e.rx, e.ry)) return 'Offset distance is larger than the ellipse';
    const step = Math.max(1, Math.floor(n / 48));
    const pts = []; for (let i = 0; i < n; i += step) pts.push(cp([P[i][0] + N[i][0] * d * sgn, P[i][1] + N[i][1] * d * sgn]));
    if (!pl.closed) pts.push(cp([P[n - 1][0] + N[n - 1][0] * d * sgn, P[n - 1][1] + N[n - 1][1] * d * sgn]));
    const sp = { t: 'spline', pts, ...(pl.closed ? { closed: true } : {}) };
    sp.id = nid(); sk.ents.push(sp); return sp;
  } else return 'Cannot offset that';
  n.id = nid(); delete n.construction; sk.ents.push(n);
  return n;
}

// AutoCAD EXTEND (quick mode): lengthen the end of a line nearest p to the nearest boundary.
export function extendLine(sk, e, p) {
  if (e.t !== 'line') return 'Extend works on lines';
  const endB = d2(p, e.b) <= d2(p, e.a), from = endB ? e.b : e.a, other = endB ? e.a : e.b;
  const L = d2(from, other); if (L < 1e-12) return 'Zero-length line';
  const dir = [(from[0] - other[0]) / L, (from[1] - other[1]) / L];
  const ray = { L: 1, a: from, b: [from[0] + dir[0] * 1e6, from[1] + dir[1] * 1e6] };
  let best = null;
  for (const o of sk.ents) {
    if (o === e || o.t === 'dim') continue;
    for (const Q of prims(o)) for (const q of interPrims(ray, Q)) {
      const t = (q[0] - from[0]) * dir[0] + (q[1] - from[1]) * dir[1];
      if (t > 1e-9 && (!best || t < best.t)) best = { t, q };
    }
  }
  if (!best) return 'No boundary to extend to';
  e[endB ? 'b' : 'a'] = cp(best.q);
  return true;
}

// AutoCAD POLYGON (inscribed): n lines, first vertex at `vertex`.
export function addPolygon(sk, c, vertex, n) {
  n = Math.round(n);
  if (n < 3 || n > 1024) return 'Sides must be 3–1024';
  const R = d2(c, vertex); if (R < 1e-9) return 'Radius is zero';
  const a0 = Math.atan2(vertex[1] - c[1], vertex[0] - c[0]);
  const pts = []; for (let k = 0; k < n; k++) pts.push(k === 0 ? vertex.slice() : cp(rot(vertex, c, 2 * Math.PI * k / n)));
  const ids = [];
  for (let k = 0; k < n; k++) { const e = { id: (sk.nextEnt = (sk.nextEnt || 1000) + 1), t: 'line', a: pts[k].slice(), b: pts[(k + 1) % n].slice() }; sk.ents.push(e); ids.push(e.id); }
  void a0;
  return ids;
}


// ---------- inquiry (AutoCAD DIST / MEASUREGEOM / AREA) ----------
export function polygonArea(pts) {
  let a = 0, per = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; per += d2(p, q); }
  return { area: Math.abs(a) / 2, perimeter: per };
}
export function regionArea(r) {
  const o = polygonArea(r.outer);
  const holes = r.holes.map(polygonArea);
  return { area: o.area - holes.reduce((s, h) => s + h.area, 0), perimeter: o.perimeter + holes.reduce((s, h) => s + h.perimeter, 0) };
}
// exact area/perimeter of a single closed entity
export function entityArea(e) {
  if (e.t === 'circle') return { area: Math.PI * e.r * e.r, perimeter: 2 * Math.PI * e.r };
  if (e.t === 'rect') return { area: e.w * e.h, perimeter: 2 * (e.w + e.h) };
  if (e.t === 'arc') { const sw = sweep(e); return { area: 0.5 * e.r * e.r * (sw - Math.sin(sw)), perimeter: e.r * sw }; }
  if (e.t === 'line') return { area: 0, perimeter: d2(e.a, e.b) };
  if (e.t === 'ellipse') { const a = e.rx, b = e.ry, h = ((a - b) / (a + b)) ** 2; return { area: Math.PI * a * b, perimeter: Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))) }; }
  if (e.t === 'spline') { const pl = entPolyline(e); return pl.closed ? polygonArea(pl.pts) : { area: 0, perimeter: pl.pts.reduce((s, p, i) => (i ? s + d2(p, pl.pts[i - 1]) : 0), 0) }; }
  return null;
}
// angle at vertex v from p1 to p2, in degrees (0–180)
export function angleAt(v, p1, p2) {
  const a = [p1[0] - v[0], p1[1] - v[1]], b = [p2[0] - v[0], p2[1] - v[1]];
  return Math.atan2(Math.abs(a[0] * b[1] - a[1] * b[0]), a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI;
}


// ---------- AutoCAD ARRAYRECT / ARRAYPOLAR (copies) ----------
export function arrayRect(sk, ids, cols, rows, dx, dy) {
  cols = Math.max(1, Math.round(cols)); rows = Math.max(1, Math.round(rows));
  if (cols * rows < 2) return 'Need at least 2 items';
  if (cols * rows > 2000) return 'Too many items';
  const made = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!r && !c) continue;
    made.push(...transformEntities(sk, ids, { kind: 'move', d: [c * dx, r * dy] }, true));
  }
  return made;
}
export function arrayPolar(sk, ids, center, n, total = 360) {
  n = Math.round(n);
  if (n < 2 || n > 2000) return 'Items must be 2–2000';
  const full = Math.abs(Math.abs(total) - 360) < 1e-9, step = full ? total / n : total / (n - 1);
  const made = [];
  for (let k = 1; k < n; k++) made.push(...transformEntities(sk, ids, { kind: 'rotate', c: center, deg: step * k }, true));
  return made;
}


// FILLET / CHAMFER where a line meets an arc (shared endpoint).
function lineArcCorner(sk, Lq, Aq, r, kind) {
  const L = Lq.e, Ar = Aq.e, P = Lq.p.slice();
  const Q = Lq.k === 'a' ? L.b : L.a, Ld = d2(P, Q), u = [(Q[0] - P[0]) / Ld, (Q[1] - P[1]) / Ld];
  const O = Ar.c, R = Ar.r, sw = sweep(Ar);
  const angOf = q => Math.atan2(q[1] - O[1], q[0] - O[0]);
  // where along the arc (0 at P, growing into the arc) a point lies
  const along = q => { let a = (angOf(q) - Ar.a0); a = ((a % TAU) + TAU) % TAU; return Aq.k === 's' ? a : sw - a; };
  const onArcSpan = q => { const a = along(q); return a > 1e-9 && a < sw - 1e-9; };
  const nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  if (kind === 'chamfer') {
    const T1 = [P[0] + u[0] * r, P[1] + u[1] * r];
    if (r >= Ld) return 'Chamfer distance is longer than the line';
    // point on the arc at chord distance r from P
    const half = 2 * Math.asin(Math.min(1, r / (2 * R)));
    const aP = angOf(P), cand = [aP + half, aP - half].map(a => pol(O, R, a)).filter(onArcSpan);
    if (!cand.length) return 'Chamfer distance is longer than the arc';
    const T2 = cand[0];
    Lq.k === 'a' ? (L.a = T1) : (L.b = T1);
    const aT = angOf(T2), s0 = Ar.a0, s1 = Ar.a0 + sw;
    if (Aq.k === 's') { Ar.a0 = aT; Ar.a1 = s1; } else { Ar.a1 = s0 + (((aT - s0) % TAU) + TAU) % TAU; }
    const ln = { id: nid(), t: 'line', a: T1, b: T2 }; sk.ents.push(ln); return { ent: ln };
  }
  // fillet centre: at distance r from the line and r from the circle (inside or outside)
  const n = [-u[1], u[0]], best = [];
  for (const side of [1, -1]) for (const rr of [R + r, R - r]) {
    if (rr <= 1e-12) continue;
    // line offset: X = P + n*side*r + u*t ; |X − O| = rr
    const B0 = [P[0] + n[0] * side * r - O[0], P[1] + n[1] * side * r - O[1]];
    const b = B0[0] * u[0] + B0[1] * u[1], cc = B0[0] * B0[0] + B0[1] * B0[1] - rr * rr, disc = b * b - cc;
    if (disc < 0) continue;
    for (const t of [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]) {
      const C = [P[0] + n[0] * side * r + u[0] * t, P[1] + n[1] * side * r + u[1] * t];
      if (t <= 1e-9 || t >= Ld - 1e-9) continue;                 // tangent point must lie on the line
      const k = d2(C, O), T2 = [O[0] + (C[0] - O[0]) * R / k, O[1] + (C[1] - O[1]) * R / k];
      if (!onArcSpan(T2)) continue;
      best.push({ C, T1: [P[0] + u[0] * t, P[1] + u[1] * t], T2, d: d2(C, P) });
    }
  }
  if (!best.length) return 'Radius too large for this corner';
  const { C, T1, T2 } = best.sort((x, y) => x.d - y.d)[0];
  Lq.k === 'a' ? (L.a = T1) : (L.b = T1);
  const aT = angOf(T2), s0 = Ar.a0, s1 = Ar.a0 + sw;
  if (Aq.k === 's') { Ar.a0 = aT; Ar.a1 = s1; } else { Ar.a1 = s0 + (((aT - s0) % TAU) + TAU) % TAU; }
  const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
  const ccw = (((a2 - a1) % TAU) + TAU) % TAU;
  const arc = ccw <= Math.PI ? { a0: a1, a1: a1 + ccw } : { a0: a2, a1: a2 + (TAU - ccw) };
  const e = { id: nid(), t: 'arc', c: C, r, ...arc };
  sk.ents.push(e);
  sk.cons = sk.cons || [];
  sk.cons.push({ id: nid(), t: 'tan', a: L.id, b: e.id }, { id: nid(), t: 'tan', a: Ar.id, b: e.id });
  return { ent: e };
}


// FILLET / CHAMFER where two arcs meet (shared endpoint)
function arcArcCorner(sk, Aq, Bq, r, kind) {
  const P = Aq.p.slice(), nid = () => (sk.nextEnt = (sk.nextEnt || 1000) + 1);
  const info = q => {
    const e = q.e, sw = sweep(e), angOf = x => Math.atan2(x[1] - e.c[1], x[0] - e.c[0]);
    const along = x => { let a = ((angOf(x) - e.a0) % TAU + TAU) % TAU; return q.k === 's' ? a : sw - a; };
    const on = x => { const a = along(x); return a > 1e-9 && a < sw - 1e-9; };
    const trim = T => { const aT = angOf(T); if (q.k === 's') { const end = e.a0 + sw; e.a0 = aT; e.a1 = aT + (((end - aT) % TAU) + TAU) % TAU; } else e.a1 = e.a0 + (((aT - e.a0) % TAU) + TAU) % TAU; };
    return { e, on, trim, angOf };
  };
  const A = info(Aq), B = info(Bq);
  if (kind === 'chamfer') {
    const pick = (X, q) => { const half = 2 * Math.asin(Math.min(1, r / (2 * X.e.r))), aP = X.angOf(P); return [aP + half, aP - half].map(a => pol(X.e.c, X.e.r, a)).find(X.on); };
    const T1 = pick(A, Aq), T2 = pick(B, Bq);
    if (!T1 || !T2) return 'Chamfer distance is longer than an arc';
    A.trim(T1); B.trim(T2);
    const ln = { id: nid(), t: 'line', a: T1, b: T2 }; sk.ents.push(ln); return { ent: ln };
  }
  const cands = [];
  for (const r1 of [A.e.r + r, A.e.r - r]) for (const r2 of [B.e.r + r, B.e.r - r]) {
    if (r1 <= 1e-12 || r2 <= 1e-12) continue;
    for (const C of interPrims({ C: 1, c: A.e.c, r: r1 }, { C: 1, c: B.e.c, r: r2 })) {
      const T1 = (() => { const k = d2(C, A.e.c); return [A.e.c[0] + (C[0] - A.e.c[0]) * A.e.r / k, A.e.c[1] + (C[1] - A.e.c[1]) * A.e.r / k]; })();
      const T2 = (() => { const k = d2(C, B.e.c); return [B.e.c[0] + (C[0] - B.e.c[0]) * B.e.r / k, B.e.c[1] + (C[1] - B.e.c[1]) * B.e.r / k]; })();
      if (A.on(T1) && B.on(T2)) cands.push({ C, T1, T2, d: d2(C, P) });
    }
  }
  if (!cands.length) return 'Radius too large for this corner';
  const { C, T1, T2 } = cands.sort((x, y) => x.d - y.d)[0];
  A.trim(T1); B.trim(T2);
  const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
  const ccw = (((a2 - a1) % TAU) + TAU) % TAU;
  const arc = ccw <= Math.PI ? { a0: a1, a1: a1 + ccw } : { a0: a2, a1: a2 + (TAU - ccw) };
  const e = { id: nid(), t: 'arc', c: C, r, ...arc };
  sk.ents.push(e);
  sk.cons = sk.cons || [];
  sk.cons.push({ id: nid(), t: 'tan', a: A.e.id, b: e.id }, { id: nid(), t: 'tan', a: B.e.id, b: e.id });
  return { ent: e };
}

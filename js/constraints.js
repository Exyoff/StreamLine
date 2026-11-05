// 2D geometric constraint solver for sketches.
// Minimum-norm Gauss-Newton: each step dx = -W⁻¹Jᵀ(JW⁻¹Jᵀ + εI)⁻¹ r moves the geometry as little as possible
// while driving all constraint residuals to zero (to ~1e-12 mm).
// Constraints: sk.cons = [{id, t, a, b, p, v}]
//   h / v (line) · par / perp / eq (2 lines | eq: 2 circles/arcs) · tan (line+arc/circle | 2 circles)
//   conc (2 circles/arcs) · fix (entity) · coin (implicit: touching points) · dims from 'dim' entities
import { keyPoints, rectCorners, sweep, d2 } from './sketch.js';

// ---------- parameter vector ----------
const PARAMS = { line: ['a.0', 'a.1', 'b.0', 'b.1'], circle: ['c.0', 'c.1', 'r'], arc: ['c.0', 'c.1', 'r', 'a0', 'a1'], rect: ['x', 'y', 'w', 'h'], ellipse: ['c.0', 'c.1', 'rx', 'ry', 'rot'] };
// (projected geometry — a face's outline, a body's edges brought in with Project — is reference: fixed, no freedom)
function slots(sk) {
  const out = [];
  for (const e of sk.ents) if (e.t === 'spline' && !e.proj) e.pts.forEach((p, i) => [0, 1].forEach(j => out.push({ e, get: () => e.pts[i][j], set: v => { e.pts[i][j] = v; }, key: `${e.id}:pts.${i}.${j}`, len: true })));
  for (const e of sk.ents) if (!e.proj) for (const k of PARAMS[e.t] || []) {
    const [f, i] = k.split('.');
    out.push({ e, get: i == null ? () => e[f] : () => e[f][+i], set: i == null ? v => { e[f] = v; } : v => { e[f][+i] = v; }, key: e.id + ':' + k, len: !['a0', 'a1', 'rot'].includes(f) });
  }
  return out;
}
const pt = (sk, ref) => { const e = sk.ents.find(x => x.id === ref.e); if (!e) return null; const kp = keyPoints(e).find(q => q.k === ref.k); return kp ? kp.p : null; };
const ent = (sk, id) => sk.ents.find(x => x.id === id);
const lineDir = l => [l.b[0] - l.a[0], l.b[1] - l.a[1]];
const lineDist = (l, p) => { const d = lineDir(l), L = Math.hypot(d[0], d[1]) || 1e-300; return ((p[0] - l.a[0]) * d[1] - (p[1] - l.a[1]) * d[0]) / L; };

// ---------- implicit coincidences (points that currently touch) ----------
export function coincidences(sk) {
  const pts = [];
  for (const e of sk.ents) { if (e.t === 'dim') continue; for (const kp of keyPoints(e)) if (kp.m) pts.push({ ref: { e: e.id, k: kp.k }, p: kp.p.slice() }); }
  const out = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
    if (pts[i].ref.e !== pts[j].ref.e && d2(pts[i].p, pts[j].p) < 1e-7) out.push([pts[i].ref, pts[j].ref]);
  // origin is a fixed point
  const origin = pts.filter(q => Math.hypot(q.p[0], q.p[1]) < 1e-7).map(q => q.ref);
  return { pairs: out, origin };
}

// ---------- residuals ----------
function residuals(sk, ctx) {
  const r = [];
  for (const [A, B] of ctx.coin.pairs) { const p = pt(sk, A), q = pt(sk, B); if (p && q) r.push(p[0] - q[0], p[1] - q[1]); }
  for (const A of ctx.coin.origin) { const p = pt(sk, A); if (p) r.push(p[0], p[1]); }
  for (const c of sk.cons || []) {
    const a = ent(sk, c.a), b = c.b != null ? ent(sk, c.b) : null;
    if (!a) continue;
    switch (c.t) {
      case 'h': r.push(a.a[1] - a.b[1]); break;
      case 'v': r.push(a.a[0] - a.b[0]); break;
      case 'par': case 'perp': {
        if (!b) break;
        const d1 = lineDir(a), d2_ = lineDir(b), l1 = Math.hypot(...d1) || 1e-300, l2 = Math.hypot(...d2_) || 1e-300;
        r.push(c.t === 'par' ? (d1[0] * d2_[1] - d1[1] * d2_[0]) / (l1 * l2) * Math.min(l1, l2) : (d1[0] * d2_[0] + d1[1] * d2_[1]) / (l1 * l2) * Math.min(l1, l2));
        break;
      }
      case 'eq': {
        if (!b) break;
        if (a.t === 'line' && b.t === 'line') r.push(Math.hypot(...lineDir(a)) - Math.hypot(...lineDir(b)));
        else if (a.r != null && b.r != null) r.push(a.r - b.r);
        break;
      }
      case 'tan': {
        if (!b) break;
        const L = a.t === 'line' ? a : b.t === 'line' ? b : null, C = L === a ? b : a;
        if (L && C && C.r != null) r.push(Math.abs(lineDist(L, C.c)) - C.r);
        else if (a.r != null && b.r != null) { const d = d2(a.c, b.c); r.push(Math.min(Math.abs(d - (a.r + b.r)), Math.abs(d - Math.abs(a.r - b.r))) * (d < Math.max(a.r, b.r) ? 1 : 1)); }
        break;
      }
      case 'conc': if (b && a.c && b.c) r.push(a.c[0] - b.c[0], a.c[1] - b.c[1]); break;
      case 'fix': for (const k of PARAMS[a.t] || []) { const [f, i] = k.split('.'); const v = i == null ? a[f] : a[f][+i]; r.push(v - c.v[k]); } break;
      case 'mid': { // point c.p is the midpoint of line a
        const p = pt(sk, c.p); if (p) r.push(p[0] - (a.a[0] + a.b[0]) / 2, p[1] - (a.a[1] + a.b[1]) / 2); break;
      }
    }
  }
  for (const d of sk.ents) {
    if (d.t !== 'dim' || d.value == null) continue;
    if (d.kind === 'lin') { const p = pt(sk, d.A), q = pt(sk, d.B); if (p && q) r.push(d2(p, q) - d.value); }
    else if (d.kind === 'hor' || d.kind === 'ver') { const p = pt(sk, d.A), q = pt(sk, d.B); if (p && q) r.push((d.kind === 'hor' ? q[0] - p[0] : q[1] - p[1]) - d.value); }
    else if (d.kind === 'pl') { const p = pt(sk, d.P), l = ent(sk, d.l); if (p && l && l.t === 'line') r.push((d.side || 1) * -lineDist(l, p) - d.value); } // (lineDist is signed the other way round from the side it was made on)
    else if (d.kind === 'ang') {
      const a = ent(sk, d.la), b = ent(sk, d.lb); if (!a || !b) continue;
      const da = lineDir(a), db = lineDir(b);
      let x = Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0]) - d.value * Math.PI / 180;
      x = Math.atan2(Math.sin(x), Math.cos(x));
      r.push(x * Math.max(1, Math.min(Math.hypot(...da), Math.hypot(...db))));
    }
    else { const e = ent(sk, d.e); if (e) r.push((d.kind === 'dia' ? 2 * e.r : e.r) - d.value); }
  }
  for (const pin of ctx.pins) {
    if (pin.ref) { const p = pt(sk, pin.ref); if (p) r.push((p[0] - pin.p[0]) * 10, (p[1] - pin.p[1]) * 10); }
    else r.push((pin.slot.get() - pin.v) * 10);
  }
  return r;
}

// ---------- dense linear algebra ----------
function solveSPD(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; if (Math.abs(d) < 1e-300) continue;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = Math.abs(M[r][r]) > 1e-300 ? s / M[r][r] : 0; }
  return x;
}
function jacobian(sk, ctx, S, r0) {
  const J = r0.map(() => new Array(S.length).fill(0));
  S.forEach((s, j) => {
    const v = s.get(), h = 1e-7 * Math.max(1, Math.abs(v));
    s.set(v + h); const r1 = residuals(sk, ctx); s.set(v - h); const r2 = residuals(sk, ctx); s.set(v);
    for (let i = 0; i < r0.length; i++) J[i][j] = (r1[i] - r2[i]) / (2 * h);
  });
  return J;
}
export function rank(J, tol = 1e-8) {
  const A = J.map(r => r.slice()); let rk = 0;
  const m = A.length, n = m ? A[0].length : 0;
  for (let c = 0; c < n && rk < m; c++) {
    let p = rk; for (let r = rk + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < tol) continue;
    [A[rk], A[p]] = [A[p], A[rk]];
    for (let r = rk + 1; r < m; r++) { const f = A[r][c] / A[rk][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[rk][k]; }
    rk++;
  }
  return rk;
}

// ---------- solve ----------
// opts: { pins: [{ref, p}] (drag targets), heavy: Set(param keys that should prefer not to move), coin }
export function solve(sk, opts = {}) {
  if (opts.heavy && opts.heavy.size && !opts._locked) {
    // first try with the edited parameters locked exactly; fall back to heavy weighting if infeasible
    const snap = JSON.stringify(sk.ents);
    const r = solve(sk, { ...opts, _locked: true, lock: opts.heavy });
    if (r.ok) return r;
    const fresh = JSON.parse(snap); sk.ents.forEach((e, i) => Object.assign(e, fresh[i]));
    return solve(sk, { ...opts, _locked: true });
  }
  const S = slots(sk).filter(s => !(opts.lock && opts.lock.has(s.key)));
  const ctx = { coin: opts.coin || coincidences(sk), pins: opts.pins || [] };
  const W = S.map(s => (opts.heavy && opts.heavy.has(s.key) ? 1e6 : s.len ? 1 : 100)); // angles: radians are "bigger"
  let r = residuals(sk, ctx);
  const norm = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let it = 0; it < 60 && norm(r) > 1e-12; it++) {
    const J = jacobian(sk, ctx, S, r);
    const m = r.length, n = S.length;
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) for (let k = i; k < m; k++) { let s = 0; for (let j = 0; j < n; j++) s += J[i][j] * J[k][j] / W[j]; A[i][k] = A[k][i] = s; }
    for (let i = 0; i < m; i++) A[i][i] += 1e-12 + A[i][i] * 1e-12;
    const y = solveSPD(A, r);
    const before = norm(r), x0 = S.map(s => s.get());
    let step = 1;
    for (let ls = 0; ls < 12; ls++) {
      S.forEach((s, j) => { let d = 0; for (let i = 0; i < m; i++) d += J[i][j] * y[i]; s.set(x0[j] - step * d / W[j]); });
      r = residuals(sk, ctx);
      if (norm(r) < before) break;
      step /= 2;
    }
    if (norm(r) >= before) { S.forEach((s, j) => s.set(x0[j])); r = residuals(sk, ctx); break; }
  }
  // snap converged values to the nanometre grid when they are already within 1e-11 of it
  if (norm(r) < 1e-9) for (const s of S) { const v = s.get(), q = Math.round(v * 1e9) / 1e9; if (Math.abs(v - q) < 1e-11) s.set(q === 0 ? 0 : q); }
  // keep rect sizes and radii positive
  for (const e of sk.ents) {
    if (e.t === 'rect') { if (e.w < 0) { e.x += e.w; e.w = -e.w; } if (e.h < 0) { e.y += e.h; e.h = -e.h; } }
    if (e.r != null && e.r < 0) e.r = -e.r;
  }
  return { ok: norm(r) < 1e-7, residual: norm(r) };
}

// Degrees of freedom left (0 = fully constrained). Ignores drag pins.
export function dof(sk) {
  const S = slots(sk); if (!S.length) return 0;
  const ctx = { coin: coincidences(sk), pins: [] };
  const r = residuals(sk, ctx);
  if (!r.length) return S.length;
  return S.length - rank(jacobian(sk, ctx, S, r), 1e-7);
}

// Entities whose every parameter is pinned down by the constraints (null-space test on the Jacobian).
export function constrainedEntities(sk) {
  const S = slots(sk), out = new Set();
  if (!S.length) return out;
  const ctx = { coin: coincidences(sk), pins: [] };
  const r = residuals(sk, ctx);
  const free = new Set(S.map((_, j) => j));
  if (r.length) {
    const A = jacobian(sk, ctx, S, r).map(row => row.slice());
    const m = A.length, n = S.length, piv = [];
    let row = 0;
    for (let c = 0; c < n && row < m; c++) {
      let p = row; for (let i = row + 1; i < m; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
      if (Math.abs(A[p][c]) < 1e-7) continue;
      [A[row], A[p]] = [A[p], A[row]];
      const d = A[row][c]; for (let k = c; k < n; k++) A[row][k] /= d;
      for (let i = 0; i < m; i++) if (i !== row && A[i][c]) { const f = A[i][c]; for (let k = c; k < n; k++) A[i][k] -= f * A[row][k]; }
      piv.push(c); row++;
    }
    const pivSet = new Set(piv), freeCols = S.map((_, j) => j).filter(j => !pivSet.has(j));
    // a variable is determined iff it has zero component in every null-space vector
    free.clear();
    for (const fcol of freeCols) {
      free.add(fcol);
      piv.forEach((pc, i) => { if (Math.abs(A[i][fcol]) > 1e-7) free.add(pc); });
    }
  }
  const byEnt = new Map();
  S.forEach((s, j) => { const k = s.e.id; if (!byEnt.has(k)) byEnt.set(k, true); if (free.has(j)) byEnt.set(k, false); });
  for (const [id, ok] of byEnt) if (ok) out.add(id);
  return out;
}

// Snapshot of an entity's params for a 'fix' constraint.
export function fixValues(e) {
  const v = {};
  for (const k of PARAMS[e.t] || []) { const [f, i] = k.split('.'); v[k] = i == null ? e[f] : e[f][+i]; }
  return v;
}

// Edit helper: capture coincidences, mutate, then re-solve keeping the mutated params where possible.
export function editAndSolve(sk, mutate, { pins = [], heavyRefs = [] } = {}) {
  const coin = coincidences(sk);
  const S0 = slots(sk), before = S0.map(s => s.get());
  const err = mutate(sk);
  if (typeof err === 'string') return err;
  const S1 = slots(sk);
  const heavy = new Set();
  // params changed by the edit are held (heavily weighted) so the rest of the sketch adapts
  S1.forEach(s => { const i = S0.findIndex(q => q.key === s.key); if (i >= 0 && Math.abs(before[i] - s.get()) > 1e-12) heavy.add(s.key); });
  for (const ref of heavyRefs) for (const s of S1) if (s.e.id === ref.e && keyParamOf(s, ref.k)) heavy.add(s.key);
  const res = solve(sk, { coin, pins, heavy });
  if (!res.ok) return `Conflicting constraints (residual ${res.residual.toExponential(1)})`;
}
function keyParamOf(s, k) {
  const key = s.key.split(':')[1];
  if (s.e.t === 'line') return key.startsWith(k + '.');
  if (k === 'c') return key.startsWith('c.');
  return true;
}

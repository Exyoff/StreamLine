// 2D geometric constraint solver for sketches.
// Minimum-norm Gauss-Newton: each step dx = -W⁻¹Jᵀ(JW⁻¹Jᵀ + εI)⁻¹ r moves the geometry as little as possible
// while driving all constraint residuals to zero (to ~1e-12 mm).
// Constraints: sk.cons = [{id, t, a, b, p, v}]
//   h / v (line) · par / perp / eq (2 lines | eq: 2 circles/arcs) · tan (line+arc/circle | 2 circles)
//   conc (2 circles/arcs) · fix (entity) · coin (implicit: touching points) · dims from 'dim' entities
import { keyPoints, rectCorners, sweep, d2 } from './sketch.js';
import { gcsReady, gcsSolve } from './gcs.js';

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
const lineDir = l => [l.b[0] - l.a[0], l.b[1] - l.a[1]];
const lineDist = (l, p) => { const d = lineDir(l), L = Math.hypot(d[0], d[1]) || 1e-300; return ((p[0] - l.a[0]) * d[1] - (p[1] - l.a[1]) * d[0]) / L; };

// ---------- implicit coincidences (points that currently touch) ----------
// (points are bucketed on a 1 µm grid and only neighbouring cells compared: a sketch of a few hundred lines has
// ~1000 points, and comparing every pair on each drag step was a large part of the lag)
export function coincidences(sk) {
  const pts = [], grid = new Map(), C = 1e-3, cell = (x, y) => Math.floor(x / C) + ',' + Math.floor(y / C);
  for (const e of sk.ents) { if (e.t === 'dim') continue; for (const kp of keyPoints(e)) if (kp.m) pts.push({ ref: { e: e.id, k: kp.k }, p: kp.p.slice() }); }
  pts.forEach((q, i) => { const k = cell(q.p[0], q.p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const out = [];
  pts.forEach((q, i) => {
    const cx = Math.floor(q.p[0] / C), cy = Math.floor(q.p[1] / C);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get((cx + dx) + ',' + (cy + dy)) || [])
      if (j > i && q.ref.e !== pts[j].ref.e && d2(q.p, pts[j].p) < 1e-7) out.push([q.ref, pts[j].ref]);
  });
  // origin is a fixed point
  const origin = pts.filter(q => Math.hypot(q.p[0], q.p[1]) < 1e-7).map(q => q.ref);
  return { pairs: out, origin };
}

// ---------- residuals ----------
// The equations come in groups, each knowing the entities it reads: the Jacobian is built one entity at a time from
// only the groups that touch it, and the sketch splits into independent pieces (entities linked by any equation),
// each solved and ranked on its own. A dense Jacobian of every equation by every parameter, rebuilt on each redraw to
// colour constrained curves, made sketches of a few hundred lines lag on every tap and drag.
function groups(sk, ctx) {
  const E = new Map(); for (const e of sk.ents) E.set(e.id, e);
  const ent = id => E.get(id);
  const pt = ref => { if (!ref) return null; if (ref.e === 0) return [0, 0]; const e = E.get(ref.e); if (!e) return null; const kp = keyPoints(e).find(q => q.k === ref.k); return kp ? kp.p : null; };
  const G = [], add = (ids, f) => G.push({ ids: [...new Set(ids)].filter(x => x != null && x !== 0 && E.has(x)), f });
  for (const [A, B] of ctx.coin.pairs) add([A.e, B.e], () => { const p = pt(A), q = pt(B); return p && q ? [p[0] - q[0], p[1] - q[1]] : []; });
  for (const A of ctx.coin.origin) add([A.e], () => { const p = pt(A); return p ? [p[0], p[1]] : []; });
  for (const c of sk.cons || []) {
    const a = ent(c.a), b = c.b != null ? ent(c.b) : null;
    if (!a) continue;
    const ids = [c.a, c.b, c.p && c.p.e, c.q && c.q.e];
    switch (c.t) {
      case 'h': add(ids, () => [a.a[1] - a.b[1]]); break;
      case 'v': add(ids, () => [a.a[0] - a.b[0]]); break;
      case 'par': case 'perp': {
        if (!b) break;
        add(ids, () => {
          const d1 = lineDir(a), d2_ = lineDir(b), l1 = Math.hypot(...d1) || 1e-300, l2 = Math.hypot(...d2_) || 1e-300;
          return [c.t === 'par' ? (d1[0] * d2_[1] - d1[1] * d2_[0]) / (l1 * l2) * Math.min(l1, l2) : (d1[0] * d2_[0] + d1[1] * d2_[1]) / (l1 * l2) * Math.min(l1, l2)];
        });
        break;
      }
      case 'eq': {
        if (!b) break;
        if (a.t === 'line' && b.t === 'line') add(ids, () => [Math.hypot(...lineDir(a)) - Math.hypot(...lineDir(b))]);
        else if (a.r != null && b.r != null) add(ids, () => [a.r - b.r]);
        break;
      }
      case 'tan': {
        if (!b) break;
        const L = a.t === 'line' ? a : b.t === 'line' ? b : null, C = L === a ? b : a;
        if (L && C && C.r != null) add(ids, () => [Math.abs(lineDist(L, C.c)) - C.r]);
        else if (a.r != null && b.r != null) add(ids, () => { const d = d2(a.c, b.c); return [Math.min(Math.abs(d - (a.r + b.r)), Math.abs(d - Math.abs(a.r - b.r)))]; });
        break;
      }
      case 'conc': if (b && a.c && b.c) add(ids, () => [a.c[0] - b.c[0], a.c[1] - b.c[1]]); break;
      case 'fix': add(ids, () => (PARAMS[a.t] || []).map(k => { const [f, i] = k.split('.'); const v = i == null ? a[f] : a[f][+i]; return v - c.v[k]; })); break;
      case 'on': // point c.p lies on curve a (Fusion's coincident to a curve): on a line, or on a circle / arc's rim
        add(ids, () => { const p = pt(c.p); if (!p) return []; if (a.t === 'line') return [lineDist(a, p)]; if (a.r != null && a.c) return [d2(p, a.c) - a.r]; return []; });
        break;
      case 'sym': // points c.p and c.q mirror each other about line a (a sketch Mirror keeps its copy this way)
        if (a.t !== 'line') break;
        add(ids, () => { const p = pt(c.p), q = pt(c.q); if (!p || !q) return []; const d = lineDir(a), l = Math.hypot(d[0], d[1]) || 1e-300;
          return [lineDist(a, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]), ((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1]) / l]; });
        break;
      case 'mid': // point c.p is the midpoint of line a
        add(ids, () => { const p = pt(c.p); return p ? [p[0] - (a.a[0] + a.b[0]) / 2, p[1] - (a.a[1] + a.b[1]) / 2] : []; });
        break;
    }
  }
  for (const d of sk.ents) {
    if (d.t !== 'dim' || d.value == null) continue;
    if (d.kind === 'lin') add([d.A?.e, d.B?.e], () => { const p = pt(d.A), q = pt(d.B); return p && q ? [d2(p, q) - d.value] : []; });
    else if (d.kind === 'hor' || d.kind === 'ver') add([d.A?.e, d.B?.e], () => { const p = pt(d.A), q = pt(d.B); return p && q ? [(d.kind === 'hor' ? q[0] - p[0] : q[1] - p[1]) - d.value] : []; });
    else if (d.kind === 'pl') add([d.P?.e, d.l], () => { const p = pt(d.P), l = ent(d.l); return p && l && l.t === 'line' ? [(d.side || 1) * -lineDist(l, p) - d.value] : []; }); // (lineDist is signed the other way round from the side it was made on)
    else if (d.kind === 'ang') {
      const a = ent(d.la), b = ent(d.lb); if (!a || !b) continue;
      add([d.la, d.lb], () => {
        const da = lineDir(a), db = lineDir(b);
        let x = Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0]) - d.value * Math.PI / 180;
        x = Math.atan2(Math.sin(x), Math.cos(x));
        return [x * Math.max(1, Math.min(Math.hypot(...da), Math.hypot(...db)))];
      });
    }
    else add([d.e], () => { const e = ent(d.e); return e ? [(d.kind === 'dia' ? 2 * e.r : e.r) - d.value] : []; });
  }
  for (const pin of ctx.pins) {
    if (pin.ref) add([pin.ref.e], () => { const p = pt(pin.ref); return p ? [(p[0] - pin.p[0]) * 10, (p[1] - pin.p[1]) * 10] : []; });
    else add([pin.slot.e.id], () => [(pin.slot.get() - pin.v) * 10]);
  }
  return G;
}
function residuals(sk, ctx) { const r = []; for (const g of groups(sk, ctx)) r.push(...g.f()); return r; }
// the independent pieces of a sketch: slots (by index into S) and equation groups linked through their entities.
// Groups that read no free entity (e.g. a dim between projected points) still count towards the residual.
function pieces(S, G) {
  const par = new Map(), find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  const mk = x => { if (!par.has(x)) par.set(x, x); };
  for (const s of S) mk(s.e.id);
  for (const g of G) { g.ids.forEach(mk); for (let i = 1; i < g.ids.length; i++) { const a = find(g.ids[0]), b = find(g.ids[i]); if (a !== b) par.set(a, b); } }
  const P = new Map(), of = k => { if (!P.has(k)) P.set(k, { slots: [], groups: [] }); return P.get(k); };
  S.forEach((s, j) => of(find(s.e.id)).slots.push(j));
  for (const g of G) if (g.ids.length) of(find(g.ids[0])).groups.push(g);
  return [...P.values()];
}
// dense Jacobian of one piece (its rows by its slots), from each slot's own groups only
function pieceJacobian(pc, S) {
  let m = 0; for (const g of pc.groups) { g.off = m; m += g.f().length; }
  const byEnt = new Map(); for (const g of pc.groups) for (const id of g.ids) { if (!byEnt.has(id)) byEnt.set(id, []); byEnt.get(id).push(g); }
  const J = Array.from({ length: m }, () => new Array(pc.slots.length).fill(0));
  pc.slots.forEach((j, c) => {
    const s = S[j], gs = byEnt.get(s.e.id) || []; if (!gs.length) return;
    const v = s.get(), h = 1e-7 * Math.max(1, Math.abs(v));
    s.set(v + h); const r1 = gs.map(g => g.f()); s.set(v - h); const r2 = gs.map(g => g.f()); s.set(v);
    gs.forEach((g, gi) => { for (let i = 0; i < r1[gi].length; i++) J[g.off + i][c] = (r1[gi][i] - r2[gi][i]) / (2 * h); });
  });
  return J;
}
const pieceRes = pc => { const r = []; for (const g of pc.groups) r.push(...g.f()); return r; };

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
// FreeCAD's PlaneGCS solves first (when loaded and the sketch is one it can take); its answer is checked against
// these equations, and on any doubt the sketch goes back as it was and the built-in solver below does the work
let lastConflict = [];
export const conflictIds = () => lastConflict;
export function solve(sk, opts = {}) {
  // only the independent pieces an edit or drag disturbed are solved, each on its own: a big sketch is mostly pieces
  // already satisfied, and handing all of it to the solver on every drag step made it lag
  if (!opts._sub && !opts._locked) {
    const coin = opts.coin || coincidences(sk), pins = opts.pins || [], S = slots(sk), G = groups(sk, { coin, pins }), P = pieces(S, G);
    if (P.length > 1) {
      const nrm = v => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      const need = P.filter(pc => pc.slots.length && nrm(pieceRes(pc)) > 1e-12);
      let ok = true, residual = 0, by = null; const conflict = [];
      for (const pc of need) {
        const ids = new Set(pc.slots.map(j => S[j].e.id)); for (const g of pc.groups) g.ids.forEach(id => ids.add(id));
        const refs = d => [d.A?.e, d.B?.e, d.P?.e, d.l, d.la, d.lb, d.e];
        const sub = { ...sk, ents: sk.ents.filter(e => ids.has(e.id) || (e.t === 'dim' && refs(e).some(id => ids.has(id)))), cons: (sk.cons || []).filter(c => ids.has(c.a)) };
        const r = solve(sub, { ...opts, _sub: true, coin: { pairs: coin.pairs.filter(([A]) => ids.has(A.e)), origin: coin.origin.filter(A => ids.has(A.e)) }, pins: pins.filter(q => ids.has(q.ref ? q.ref.e : q.slot.e.id)) });
        ok = ok && r.ok; residual = Math.max(residual, r.residual || 0); by = by || r.by; conflict.push(...lastConflict);
      }
      lastConflict = conflict;
      return { ok, residual, by: by || 'planegcs', pieces: need.length };
    }
  }
  if (!opts._locked && gcsReady()) {
    const snap = JSON.stringify(sk.ents), coin = opts.coin || coincidences(sk);
    const g = gcsSolve(sk, { coin, pins: opts.pins || [], heavy: opts.heavy });
    if (g) {
      lastConflict = g.conflict || [];
      if (g.ok) {
        const r = residuals(sk, { coin, pins: [] }), nr = Math.sqrt(r.reduce((a, x) => a + x * x, 0));
        if (nr < 1e-7) {
          for (const e of sk.ents) { if (e.t === 'rect') { if (e.w < 0) { e.x += e.w; e.w = -e.w; } if (e.h < 0) { e.y += e.h; e.h = -e.h; } } if (e.r != null && e.r < 0) e.r = -e.r; }
          return { ok: true, residual: nr, by: 'planegcs' };
        }
      }
      const fresh = JSON.parse(snap); sk.ents.forEach((e, i) => Object.assign(e, fresh[i]));
    }
  }
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
  const G = groups(sk, ctx), wOf = s => (opts.heavy && opts.heavy.has(s.key) ? 1e6 : s.len ? 1 : 100); // angles: radians are "bigger"
  const norm = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // each independent piece is solved on its own; pieces already satisfied are left alone
  for (const pc of pieces(S, G)) {
    if (!pc.slots.length) continue;
    const PS = pc.slots.map(j => S[j]), W = PS.map(wOf);
    let r = pieceRes(pc);
    for (let it = 0; it < 60 && norm(r) > 1e-12; it++) {
      const J = pieceJacobian(pc, S);
      const m = r.length, n = PS.length;
      const A = Array.from({ length: m }, () => new Array(m).fill(0));
      for (let i = 0; i < m; i++) for (let k = i; k < m; k++) { let s = 0; const Ji = J[i], Jk = J[k]; for (let j = 0; j < n; j++) if (Ji[j] && Jk[j]) s += Ji[j] * Jk[j] / W[j]; A[i][k] = A[k][i] = s; }
      for (let i = 0; i < m; i++) A[i][i] += 1e-12 + A[i][i] * 1e-12;
      const y = solveSPD(A, r);
      const before = norm(r), x0 = PS.map(s => s.get());
      let step = 1;
      for (let ls = 0; ls < 12; ls++) {
        PS.forEach((s, j) => { let d = 0; for (let i = 0; i < m; i++) if (J[i][j]) d += J[i][j] * y[i]; s.set(x0[j] - step * d / W[j]); });
        r = pieceRes(pc);
        if (norm(r) < before) break;
        step /= 2;
      }
      if (norm(r) >= before) { PS.forEach((s, j) => s.set(x0[j])); r = pieceRes(pc); break; }
    }
  }
  const r = residuals(sk, ctx);
  // snap converged values to the nanometre grid when they are already within 1e-11 of it
  if (norm(r) < 1e-9) for (const s of S) { const v = s.get(), q = Math.round(v * 1e9) / 1e9; if (Math.abs(v - q) < 1e-11) s.set(q === 0 ? 0 : q); }
  // keep rect sizes and radii positive
  for (const e of sk.ents) {
    if (e.t === 'rect') { if (e.w < 0) { e.x += e.w; e.w = -e.w; } if (e.h < 0) { e.y += e.h; e.h = -e.h; } }
    if (e.r != null && e.r < 0) e.r = -e.r;
  }
  return { ok: norm(r) < 1e-7, residual: norm(r) };
}

// The constraint analysis: degrees of freedom left (0 = fully constrained; drag pins ignored) and the entities whose
// every parameter is pinned down (null-space test). Each piece's Jacobian is kept sparse (a row reads a few entities)
// and reduced in place: one big connected sketch (a grid of 480 lines) took 13 s for its DOF count with dense rows.
function sparseJacobian(pc, S) {
  const byEnt = new Map(), rows = [];
  for (const g of pc.groups) { g.off = rows.length; for (let i = g.f().length; i > 0; i--) rows.push(new Map()); for (const id of g.ids) { if (!byEnt.has(id)) byEnt.set(id, []); byEnt.get(id).push(g); } }
  pc.slots.forEach((j, c) => {
    const s = S[j], gs = byEnt.get(s.e.id) || []; if (!gs.length) return;
    const v = s.get(), h = 1e-7 * Math.max(1, Math.abs(v));
    s.set(v + h); const r1 = gs.map(g => g.f()); s.set(v - h); const r2 = gs.map(g => g.f()); s.set(v);
    gs.forEach((g, gi) => { for (let i = 0; i < r1[gi].length; i++) { const d = (r1[gi][i] - r2[gi][i]) / (2 * h); if (Math.abs(d) > 1e-12) rows[g.off + i].set(c, d); } });
  });
  return rows;
}
// Gauss–Jordan on sparse rows with partial pivoting; returns the pivot row of each pivot column
function reduce(rows, n, tol = 1e-7) {
  const colRows = Array.from({ length: n }, () => new Set());
  rows.forEach((r, i) => { for (const k of r.keys()) colRows[k].add(i); });
  const used = new Set(), pivRow = new Map();
  for (let c = 0; c < n; c++) {
    let p = -1, best = tol;
    for (const i of colRows[c]) if (!used.has(i)) { const v = Math.abs(rows[i].get(c)); if (v > best) { best = v; p = i; } }
    if (p < 0) continue;
    used.add(p); pivRow.set(c, p);
    const R = rows[p], d = R.get(c); for (const [k, v] of R) R.set(k, v / d);
    for (const i of [...colRows[c]]) {
      if (i === p) continue;
      const Ri = rows[i], f = Ri.get(c); if (!f) continue;
      for (const [k, v] of R) {
        const nv = (Ri.get(k) || 0) - f * v;
        if (Math.abs(nv) < 1e-12 || k === c) { if (Ri.delete(k)) colRows[k].delete(i); }
        else { if (!Ri.has(k)) colRows[k].add(i); Ri.set(k, nv); }
      }
    }
  }
  return { pivRow, colRows };
}
export function analyze(sk) {
  const S = slots(sk), fixed = new Set();
  if (!S.length) return { dof: 0, fixed };
  const G = groups(sk, { coin: coincidences(sk), pins: [] });
  const free = new Set(); let rk = 0;
  for (const pc of pieces(S, G)) {
    if (!pc.groups.length) { pc.slots.forEach(j => free.add(j)); continue; }
    const n = pc.slots.length, rows = sparseJacobian(pc, S), { pivRow, colRows } = reduce(rows, n);
    rk += pivRow.size;
    const pivOf = new Map([...pivRow].map(([c, r]) => [r, c]));
    // a variable is determined iff it has zero component in every null-space vector
    for (let fc = 0; fc < n; fc++) {
      if (pivRow.has(fc)) continue;
      free.add(pc.slots[fc]);
      for (const i of colRows[fc]) { const pcol = pivOf.get(i); if (pcol != null && Math.abs(rows[i].get(fc)) > 1e-7) free.add(pc.slots[pcol]); }
    }
  }
  const byEnt = new Map();
  S.forEach((s, j) => { const k = s.e.id; if (!byEnt.has(k)) byEnt.set(k, true); if (free.has(j)) byEnt.set(k, false); });
  for (const [id, ok] of byEnt) if (ok) fixed.add(id);
  return { dof: S.length - rk, fixed };
}
export const dof = sk => analyze(sk).dof;
export const constrainedEntities = sk => analyze(sk).fixed;

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
  const at0 = new Map(S0.map((q, i) => [q.key, i]));
  S1.forEach(s => { const i = at0.get(s.key); if (i != null && Math.abs(before[i] - s.get()) > 1e-12) heavy.add(s.key); });
  for (const ref of heavyRefs) for (const s of S1) if (s.e.id === ref.e && keyParamOf(s, ref.k)) heavy.add(s.key);
  const res = solve(sk, { coin, pins, heavy });
  if (!res.ok) {
    // (PlaneGCS names the constraints that fight: say which)
    const NAME = { h: 'Horizontal', v: 'Vertical', par: 'Parallel', perp: 'Perpendicular', eq: 'Equal', tan: 'Tangent', conc: 'Concentric', fix: 'Fix', mid: 'Midpoint', on: 'On curve', sym: 'Symmetric' };
    const names = lastConflict.map(id => { const c = (sk.cons || []).find(q => q.id === id); if (c) return NAME[c.t] || 'a constraint'; const d = sk.ents.find(q => q.id === id && q.t === 'dim'); return d ? 'a dimension' : null; }).filter(Boolean);
    return names.length ? `Conflicting constraints: ${[...new Set(names)].join(', ')} cannot all hold — delete one in Constrain` : `Conflicting constraints (residual ${res.residual.toExponential(1)})`;
  }
}
function keyParamOf(s, k) {
  const key = s.key.split(':')[1];
  if (s.e.t === 'line') return key.startsWith(k + '.');
  if (k === 'c') return key.startsWith('c.');
  return true;
}

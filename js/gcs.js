// FreeCAD's sketch solver (PlaneGCS, LGPL — vendor/planegcs) driving StreamLine's sketches.
// The sketch is handed over as PlaneGCS geometry: every group of touching points becomes one point (the origin and
// projected geometry fixed), lines, circles, arcs and rectangles (four lines kept square) on them, and the sketch's
// constraints and driving dimensions as PlaneGCS constraints. A drag or an edited value goes in as "temporary"
// constraints — met as nearly as the others allow, as FreeCAD drags. The answer is written back to the sketch.
// What it cannot take (ellipses or splines tied into constraints, a pin on a bare parameter) returns null, and the
// app's own solver does the work, as it did before.
import { keyPoints, sweep } from './sketch.js';

let wrapper = null, loading = null, failed = false;
export const gcsReady = () => !!wrapper;
export function initGcs() {
  if (wrapper || loading || failed) return loading;
  loading = import('../vendor/planegcs/index.js')
    .then(m => m.make_gcs_wrapper(new URL('../vendor/planegcs/planegcs_dist/planegcs.wasm', import.meta.url).href))
    .then(w => { wrapper = w; w.set_max_iterations(200); w.set_convergence_threshold(1e-12); return w; })
    .catch(e => { failed = true; console.warn('PlaneGCS unavailable — the built-in solver is used', e); return null; })
    .finally(() => { loading = null; });
  return loading;
}

const SUPPORTED = new Set(['line', 'circle', 'arc', 'rect']);
const IGNORED = new Set(['dim', 'text', 'hatch']);

// sk: the sketch (changed in place on success). opts: { coin, pins: [{ ref, p }], heavy: Set(slot keys) }
// returns { ok, conflict: [our constraint / dimension ids] } — or null: not for PlaneGCS (use the built-in solver)
export function gcsSolve(sk, { coin, pins = [], heavy = null } = {}) {
  if (!wrapper) return null;
  if (pins.some(p => !p.ref)) return null;
  const ent = id => sk.ents.find(e => e.id === id);
  // ---- points: union-find over every joinable point
  const parent = new Map(), pos = new Map();
  const key = r => (r.e === 0 ? 'O' : r.e + ':' + r.k);
  const find = k => { let p = parent.get(k); if (p === undefined) return null; while (p !== k) { const g = parent.get(p); parent.set(k, g); k = p; p = g; } return k; };
  const add = (k, p) => { if (!parent.has(k)) { parent.set(k, k); pos.set(k, p); } };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra == null || rb == null) return false; if (ra !== rb) parent.set(rb, ra); return true; };
  add('O', [0, 0]);
  const others = [];
  for (const e of sk.ents) {
    if (IGNORED.has(e.t)) continue;
    if (!SUPPORTED.has(e.t)) { others.push(e.id); continue; }
    for (const kp of keyPoints(e)) if (kp.m) add(e.id + ':' + kp.k, kp.p);
  }
  const refOk = r => r && (r.e === 0 || parent.has(key(r)));
  // a constraint, dimension or join touching an ellipse / spline: not for PlaneGCS
  const touchesOther = ids => ids.some(id => others.includes(id));
  for (const [A, B] of coin.pairs) { if (!refOk(A) || !refOk(B)) return null; union(key(A), key(B)); }
  for (const A of coin.origin) { if (!refOk(A)) return null; union('O', key(A)); }
  for (const c of sk.cons || []) {
    if (touchesOther([c.a, c.b].filter(x => x != null)) || (c.p && !refOk(c.p))) return null;
    if (c.t === 'conc') { const a = ent(c.a), b = ent(c.b); if (a?.c && b?.c) union(a.id + ':c', b.id + ':c'); }
  }
  for (const d of sk.ents) if (d.t === 'dim' && d.value != null) {
    const ids = d.kind === 'lin' || d.kind === 'hor' || d.kind === 'ver' ? [d.A.e, d.B.e] : d.kind === 'pl' ? [d.P.e, d.l] : d.kind === 'ang' ? [d.la, d.lb] : [d.e];
    if (touchesOther(ids)) return null;
    for (const r of [d.A, d.B, d.P]) if (r && !refOk(r)) return null;
  }
  for (const p of pins) if (!refOk(p.ref)) return null;
  // ---- fixed points: the origin, projected geometry, Fix
  const fixedAt = new Map(); // root → [x, y]
  fixedAt.set(find('O'), [0, 0]);
  for (const e of sk.ents) if (e.proj && SUPPORTED.has(e.t)) for (const kp of keyPoints(e)) if (kp.m) fixedAt.set(find(e.id + ':' + kp.k), kp.p.slice());
  const fixR = new Map(); // circle / arc id → radius held
  for (const c of sk.cons || []) if (c.t === 'fix') {
    const e = ent(c.a); if (!e || !SUPPORTED.has(e.t)) continue;
    const v = c.v || {}, g = (f, i) => v[i == null ? f : f + '.' + i];
    if (e.t === 'line') { fixedAt.set(find(e.id + ':a'), [g('a', 0), g('a', 1)]); fixedAt.set(find(e.id + ':b'), [g('b', 0), g('b', 1)]); }
    else if (e.t === 'rect') { const x = g('x'), y = g('y'), w = g('w'), h = g('h'); [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach((q, i) => fixedAt.set(find(e.id + ':p' + i), q)); }
    else { fixedAt.set(find(e.id + ':c'), [g('c', 0), g('c', 1)]); fixR.set(e.id, g('r')); }
  }
  for (const e of sk.ents) if (e.proj && e.r != null) fixR.set(e.id, e.r);
  // ---- primitives
  const prims = [], pid = new Map();
  let n = 0;
  const P = r => pid.get(find(key(r)));
  for (const k of parent.keys()) {
    const root = find(k); if (pid.has(root)) continue;
    const id = 'p' + (++n); pid.set(root, id);
    const f = fixedAt.get(root), at = f || pos.get(root);
    prims.push({ id, type: 'point', x: at[0], y: at[1], fixed: !!f });
  }
  const gid = e => (e.t === 'line' ? 'l' : e.t === 'circle' ? 'c' : e.t === 'arc' ? 'a' : 'r') + e.id;
  const cons = [];
  for (const e of sk.ents) {
    if (!SUPPORTED.has(e.t)) continue;
    if (e.t === 'line') prims.push({ id: gid(e), type: 'line', p1_id: P({ e: e.id, k: 'a' }), p2_id: P({ e: e.id, k: 'b' }) });
    else if (e.t === 'circle') prims.push({ id: gid(e), type: 'circle', c_id: P({ e: e.id, k: 'c' }), radius: e.r });
    else if (e.t === 'arc') {
      prims.push({ id: gid(e), type: 'arc', c_id: P({ e: e.id, k: 'c' }), start_id: P({ e: e.id, k: 's' }), end_id: P({ e: e.id, k: 'e' }), radius: e.r, start_angle: e.a0, end_angle: e.a0 + sweep(e) });
      cons.push({ id: 'ar' + e.id, type: 'arc_rules', a_id: gid(e) });
    } else { // a rectangle: four lines kept square
      const c = [0, 1, 2, 3].map(i => P({ e: e.id, k: 'p' + i }));
      [0, 1, 2, 3].forEach(i => prims.push({ id: gid(e) + 's' + i, type: 'line', p1_id: c[i], p2_id: c[(i + 1) % 4] }));
      cons.push({ id: 'rh0' + e.id, type: 'horizontal_l', l_id: gid(e) + 's0' }, { id: 'rv1' + e.id, type: 'vertical_l', l_id: gid(e) + 's1' },
        { id: 'rh2' + e.id, type: 'horizontal_l', l_id: gid(e) + 's2' }, { id: 'rv3' + e.id, type: 'vertical_l', l_id: gid(e) + 's3' });
    }
  }
  for (const [id, r] of fixR) { const e = ent(id); if (e) cons.push({ id: 'fr' + id, type: e.t === 'arc' ? 'arc_radius' : 'circle_radius', [e.t === 'arc' ? 'a_id' : 'c_id']: gid(e), radius: r }); }
  // ---- the sketch's constraints
  const round = e => e && (e.t === 'circle' || e.t === 'arc');
  for (const c of sk.cons || []) {
    const a = ent(c.a), b = c.b != null ? ent(c.b) : null, id = 'k' + c.id;
    if (!a) continue;
    const lineOf = e => (e.t === 'line' ? gid(e) : null);
    switch (c.t) {
      case 'h': if (a.t === 'line') cons.push({ id, type: 'horizontal_l', l_id: gid(a) }); break;
      case 'v': if (a.t === 'line') cons.push({ id, type: 'vertical_l', l_id: gid(a) }); break;
      case 'par': if (b && lineOf(a) && lineOf(b)) cons.push({ id, type: 'parallel', l1_id: gid(a), l2_id: gid(b) }); break;
      case 'perp': if (b && lineOf(a) && lineOf(b)) cons.push({ id, type: 'perpendicular_ll', l1_id: gid(a), l2_id: gid(b) }); break;
      case 'eq':
        if (!b) break;
        if (a.t === 'line' && b.t === 'line') cons.push({ id, type: 'equal_length', l1_id: gid(a), l2_id: gid(b) });
        else if (round(a) && round(b)) {
          if (a.t === 'circle' && b.t === 'circle') cons.push({ id, type: 'equal_radius_cc', c1_id: gid(a), c2_id: gid(b) });
          else if (a.t === 'arc' && b.t === 'arc') cons.push({ id, type: 'equal_radius_aa', a1_id: gid(a), a2_id: gid(b) });
          else { const [ci, ar] = a.t === 'circle' ? [a, b] : [b, a]; cons.push({ id, type: 'equal_radius_ca', c1_id: gid(ci), a2_id: gid(ar) }); }
        }
        break;
      case 'tan': {
        if (!b) break;
        const L = a.t === 'line' ? a : b.t === 'line' ? b : null, C = L === a ? b : a;
        if (L && round(C)) cons.push(C.t === 'circle' ? { id, type: 'tangent_lc', l_id: gid(L), c_id: gid(C) } : { id, type: 'tangent_la', l_id: gid(L), a_id: gid(C) });
        else if (round(a) && round(b)) return null; // (circle-to-circle tangency: inside or outside is the built-in solver's choice)
        break;
      }
      case 'on': {
        const p = c.p && P(c.p); if (!p) return null;
        if (a.t === 'line') cons.push({ id, type: 'point_on_line_pl', p_id: p, l_id: gid(a) });
        else if (a.t === 'circle') cons.push({ id, type: 'point_on_circle', p_id: p, c_id: gid(a) });
        else if (a.t === 'arc') cons.push({ id, type: 'point_on_arc', p_id: p, a_id: gid(a) });
        break;
      }
      case 'mid': { const p = c.p && P(c.p); if (!p || a.t !== 'line') return null; cons.push({ id, type: 'p2p_symmetric_ppp', p1_id: P({ e: a.id, k: 'a' }), p2_id: P({ e: a.id, k: 'b' }), p_id: p }); break; }
      case 'conc': case 'fix': break; // (joined centres / fixed points above)
      default: return null;
    }
  }
  // ---- driving dimensions
  for (const d of sk.ents) {
    if (d.t !== 'dim' || d.value == null) continue;
    const id = 'd' + d.id;
    if (d.kind === 'lin') cons.push({ id, type: 'p2p_distance', p1_id: P(d.A), p2_id: P(d.B), distance: d.value });
    else if (d.kind === 'hor' || d.kind === 'ver') { const pr = d.kind === 'hor' ? 'x' : 'y'; cons.push({ id, type: 'difference', param1: { o_id: P(d.A), prop: pr }, param2: { o_id: P(d.B), prop: pr }, difference: d.value }); }
    else if (d.kind === 'pl') { const l = ent(d.l); if (l?.t !== 'line') return null; cons.push({ id, type: 'p2l_distance', p_id: P(d.P), l_id: gid(l), distance: Math.abs(d.value) }); }
    else if (d.kind === 'ang') { const la = ent(d.la), lb = ent(d.lb); if (la?.t !== 'line' || lb?.t !== 'line') return null; cons.push({ id, type: 'l2l_angle_ll', l1_id: gid(la), l2_id: gid(lb), angle: d.value * Math.PI / 180 }); }
    else if (d.kind === 'dia' || d.kind === 'rad') {
      const e = ent(d.e); if (!round(e)) return null;
      const dia = d.kind === 'dia';
      cons.push(e.t === 'circle' ? { id, type: dia ? 'circle_diameter' : 'circle_radius', c_id: gid(e), [dia ? 'diameter' : 'radius']: d.value }
        : { id, type: dia ? 'arc_diameter' : 'arc_radius', a_id: gid(e), [dia ? 'diameter' : 'radius']: d.value });
    } else return null;
  }
  // ---- what is being dragged or edited: held as nearly as the rest allows (temporary)
  let t = 0;
  for (const pin of pins) { const p = P(pin.ref); cons.push({ id: 't' + (++t), type: 'coordinate_x', p_id: p, x: pin.p[0], temporary: true }, { id: 't' + (++t), type: 'coordinate_y', p_id: p, y: pin.p[1], temporary: true }); }
  if (heavy && heavy.size) {
    const held = new Set();
    for (const k of heavy) {
      const [eid, f] = k.split(':'), e = ent(+eid); if (!e || !SUPPORTED.has(e.t)) continue;
      const ptKey = e.t === 'line' ? (f.startsWith('a.') ? 'a' : f.startsWith('b.') ? 'b' : null) : e.t === 'rect' ? null : f.startsWith('c.') ? 'c' : null;
      const refs = ptKey ? [{ e: e.id, k: ptKey }] : e.t === 'rect' ? [0, 1, 2, 3].map(i => ({ e: e.id, k: 'p' + i })) : [];
      for (const r of refs) { const p = P(r); if (!p || held.has(p)) continue; held.add(p); const q = keyPoints(e).find(x => x.k === r.k).p; cons.push({ id: 't' + (++t), type: 'coordinate_x', p_id: p, x: q[0], temporary: true }, { id: 't' + (++t), type: 'coordinate_y', p_id: p, y: q[1], temporary: true }); }
      if (f === 'r' && round(e)) cons.push({ id: 't' + (++t), type: e.t === 'arc' ? 'arc_radius' : 'circle_radius', [e.t === 'arc' ? 'a_id' : 'c_id']: gid(e), radius: e.r, temporary: true });
    }
  }
  // ---- solve
  let status;
  try {
    wrapper.clear_data();
    wrapper.push_primitives_and_params([...prims, ...cons]);
    status = wrapper.solve();
    if (status === 0 || status === 1) wrapper.apply_solution();
  } catch (e) { console.warn('PlaneGCS failed — the built-in solver is used', e); return null; }
  const conflict = () => { try { return wrapper.get_gcs_conflicting_constraints().filter(s => /^[kd]\d+$/.test(s)).map(s => +s.slice(1)); } catch (e) { return []; } };
  if (status !== 0 && status !== 1) return { ok: false, conflict: conflict() };
  // ---- write back
  const out = new Map(wrapper.sketch_index.get_primitives().map(p => [p.id, p]));
  const at = r => { const q = out.get(P(r)); return [q.x, q.y]; };
  for (const e of sk.ents) {
    if (!SUPPORTED.has(e.t) || e.proj) continue;
    if (e.t === 'line') { e.a = at({ e: e.id, k: 'a' }); e.b = at({ e: e.id, k: 'b' }); }
    else if (e.t === 'circle') { e.c = at({ e: e.id, k: 'c' }); e.r = Math.abs(out.get(gid(e)).radius); }
    else if (e.t === 'arc') { const g = out.get(gid(e)); e.c = at({ e: e.id, k: 'c' }); e.r = Math.abs(g.radius); e.a0 = g.start_angle; e.a1 = g.end_angle; }
    else { const p0 = at({ e: e.id, k: 'p0' }), p2 = at({ e: e.id, k: 'p2' }); e.x = p0[0]; e.y = p0[1]; e.w = p2[0] - p0[0]; e.h = p2[1] - p0[1]; }
  }
  return { ok: true, conflict: [] };
}

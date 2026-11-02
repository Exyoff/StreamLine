// Unit tests for the geometry core: run with `npm test` (Node 18+).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBox, makeCylinder, meshVolume } from '../js/mesh.js';
import * as M from '../js/mesh.js';
import { toPolys, boolean, polysToMesh, extrudeRegions, revolveRegions } from '../js/csg.js';
import { PLANES, regions, intersections, trimAt, cornerOp, setDimValue, movePoint } from '../js/sketch.js';
import { solve, dof, editAndSolve } from '../js/constraints.js';
import { edgeBlend, featureEdges, straightRun } from '../js/edges.js';
import { evalExpr } from '../js/units.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const watertight = m => { const c = new Map(); for (const f of m.f) f.forEach((a, i) => { const b = f[(i + 1) % f.length]; const k = a < b ? a + '_' + b : b + '_' + a; c.set(k, (c.get(k) || 0) + 1); }); return [...c.values()].every(n => n === 2); };
const ngonArea = (r, n) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);
const sk = ents => ({ ents: ents.map((e, i) => ({ id: i + 1, ...e })), cons: [], nextEnt: 100 });

test('expressions with units', () => {
  near(evalExpr('3/8 in'), 9.525, 1e-12);
  near(evalExpr('10mm + 1in'), 35.4, 1e-12);
  near(evalExpr('2*pi*5'), 10 * Math.PI, 1e-12);
  near(evalExpr('0.5 rad', 'ang'), 28.64788975654116, 1e-9);
  assert.throws(() => evalExpr('1/0'));
});

test('sketch: exact intersections', () => {
  const s = sk([{ t: 'line', a: [-10, 0], b: [10, 0] }, { t: 'circle', c: [0, 0], r: 5 }, { t: 'circle', c: [6, 0], r: 5 }]);
  const pts = intersections(s).map(p => p.map(v => +v.toFixed(12)));
  for (const q of [[-5, 0], [5, 0], [1, 0], [3, 4], [3, -4]]) assert.ok(pts.some(p => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9), `missing ${q}`);
});

test('sketch: regions with holes, splits and dangling lines', () => {
  const plate = regions(sk([{ t: 'rect', x: 0, y: 0, w: 20, h: 10 }, { t: 'circle', c: [10, 5], r: 3 }]));
  assert.equal(plate.length, 2);
  assert.equal(plate.find(r => r.holes.length === 1).area, 200);
  const split = regions(sk([{ t: 'rect', x: 0, y: 0, w: 20, h: 10 }, { t: 'line', a: [10, -5], b: [10, 15] }]));
  assert.deepEqual(split.map(r => r.area).sort(), [100, 100]);
  const tri = regions(sk([{ t: 'line', a: [0, 0], b: [10, 0] }, { t: 'line', a: [10, 0], b: [0, 10] }, { t: 'line', a: [0, 10], b: [0, 0] }, { t: 'line', a: [10, 0], b: [20, 0] }]));
  assert.equal(tri.length, 1); near(tri[0].area, 50, 1e-9);
});

test('sketch: trim', () => {
  const s = sk([{ t: 'line', a: [-10, 0], b: [10, 0] }, { t: 'circle', c: [0, 0], r: 5 }]);
  trimAt(s, s.ents[0], [0, 0.1]);
  const lines = s.ents.filter(e => e.t === 'line').map(e => [e.a, e.b]);
  assert.deepEqual(lines, [[[-10, 0], [-5, 0]], [[5, 0], [10, 0]]]);
  s.ents = [...s.ents];
  trimAt(s, s.ents.find(e => e.t === 'circle'), [0, -5]);
  const arc = s.ents.find(e => e.t === 'arc');
  near(arc.a0, 0, 1e-12); near(arc.a1, Math.PI, 1e-12);
});

test('sketch: 2D fillet and chamfer', () => {
  const s = sk([{ t: 'rect', x: 0, y: 0, w: 20, h: 10 }]);
  const f = cornerOp(s, [20, 10], 0.5, 3, 'fillet').ent;
  assert.deepEqual([f.t, f.c, f.r], ['arc', [17, 7], 3]);
  near(f.a1 - f.a0, Math.PI / 2, 1e-12);
  const c = cornerOp(s, [0, 0], 0.5, 2, 'chamfer').ent;
  assert.deepEqual([c.a, c.b], [[2, 0], [0, 2]]);
  assert.equal(regions(s).length, 1);
  assert.equal(typeof cornerOp(s, [5, 5], 0.5, 1, 'fillet'), 'string', 'no corner there');
  assert.match(cornerOp(sk([{ t: 'rect', x: 0, y: 0, w: 4, h: 4 }]), [4, 4], 0.5, 10, 'fillet'), /Too large/);
});

test('constraints: sloppy quad becomes exact 30×20 rectangle, then follows a dimension', () => {
  const s = { ents: [
    { id: 1, t: 'line', a: [0, 0], b: [29, 1] }, { id: 2, t: 'line', a: [29, 1], b: [31, 19] },
    { id: 3, t: 'line', a: [31, 19], b: [1, 21] }, { id: 4, t: 'line', a: [1, 21], b: [0, 0] },
    { id: 5, t: 'dim', kind: 'lin', A: { e: 1, k: 'a' }, B: { e: 1, k: 'b' }, value: 30 },
    { id: 6, t: 'dim', kind: 'lin', A: { e: 2, k: 'a' }, B: { e: 2, k: 'b' }, value: 20 },
  ], cons: [{ t: 'h', a: 1 }, { t: 'v', a: 2 }, { t: 'h', a: 3 }, { t: 'v', a: 4 }] };
  assert.ok(solve(s).ok);
  assert.deepEqual(s.ents.slice(0, 4).map(e => [e.a, e.b]), [[[0, 0], [30, 0]], [[30, 0], [30, 20]], [[30, 20], [0, 20]], [[0, 20], [0, 0]]]);
  assert.equal(dof(s), 0, 'fully constrained (origin is fixed)');
  setDimValue(s, s.ents[4], 42.5);
  assert.deepEqual(s.ents.slice(0, 4).map(e => [e.a, e.b]), [[[0, 0], [42.5, 0]], [[42.5, 0], [42.5, 20]], [[42.5, 20], [0, 20]], [[0, 20], [0, 0]]]);
});

test('constraints: parallel, perpendicular, equal, tangent, conflict', () => {
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 1] }, { id: 2, t: 'line', a: [0, 5], b: [7, 9] }, { id: 3, t: 'line', a: [20, 0], b: [21, 8] }], cons: [{ t: 'par', a: 1, b: 2 }, { t: 'perp', a: 1, b: 3 }, { t: 'eq', a: 2, b: 3 }] };
  assert.ok(solve(s).ok);
  const d = l => [l.b[0] - l.a[0], l.b[1] - l.a[1]], [A, B, C] = s.ents.map(d);
  near(A[0] * B[1] - A[1] * B[0], 0, 1e-9, 'parallel');
  near(A[0] * C[0] + A[1] * C[1], 0, 1e-9, 'perpendicular');
  near(Math.hypot(...B), Math.hypot(...C), 1e-9, 'equal');
  const t = { ents: [{ id: 1, t: 'line', a: [-10, 5], b: [10, 6] }, { id: 2, t: 'circle', c: [0, 0], r: 3 }], cons: [{ t: 'tan', a: 1, b: 2 }, { t: 'h', a: 1 }] };
  assert.ok(solve(t).ok);
  near(Math.abs(t.ents[0].a[1] - t.ents[1].c[1]), t.ents[1].r, 1e-9, 'tangent');
  const bad = { ents: [{ id: 1, t: 'line', a: [1, 1], b: [5, 5] }, { id: 2, t: 'dim', kind: 'lin', A: { e: 1, k: 'a' }, B: { e: 1, k: 'b' }, value: 4 }], cons: [{ t: 'h', a: 1 }, { t: 'v', a: 1 }] };
  assert.equal(solve(bad).ok, false, 'H + V + length is a conflict');
});

test('constraints: dragging a corner keeps connected lines joined and H/V', () => {
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 0] }, { id: 2, t: 'line', a: [10, 0], b: [10, 10] }], cons: [{ t: 'h', a: 1 }, { t: 'v', a: 2 }], nextEnt: 10 };
  movePoint(s, { e: 1, k: 'b' }, [15, 3]);
  assert.deepEqual(s.ents[0].b, s.ents[1].a, 'still coincident');
  near(s.ents[0].a[1] - s.ents[0].b[1], 0, 1e-9); near(s.ents[1].a[0] - s.ents[1].b[0], 0, 1e-9);
  near(s.ents[0].b[0], 15, 1e-5, 'drag lands on the finger within 10 µm');
});

test('constraints: typed edits are exact and connected geometry follows', () => {
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 0] }, { id: 2, t: 'line', a: [10, 0], b: [10, 10] }], cons: [{ t: 'h', a: 1 }, { t: 'v', a: 2 }], nextEnt: 10 };
  const err = editAndSolve(s, k => { const l = k.ents[0]; l.b = [12.345, 0]; });
  assert.equal(err, undefined);
  assert.deepEqual(s.ents[0].b, [12.345, 0]);
  assert.deepEqual(s.ents[1].a, [12.345, 0], 'joined line followed exactly');
  assert.equal(s.ents[1].b[0], 12.345, 'and stayed vertical');
});

test('csg: booleans are exact and watertight', () => {
  const box = makeBox(20, 20, 20), cyl = makeCylinder(5, 40, 32), A = ngonArea(5, 32);
  const run = k => polysToMesh(boolean(k, toPolys(box.v, box.f), toPolys(cyl.v, cyl.f)));
  for (const [k, v] of [['union', 8000 + A * 20], ['subtract', 8000 - A * 20], ['intersect', A * 20]]) {
    const m = run(k); near(meshVolume(m), v, 1e-6, k); assert.ok(watertight(m), k + ' watertight');
  }
  const small = makeBox(10, 10, 10); small.v = small.v.map(p => [p[0] + 10, p[1] + 10, p[2] + 10]);
  const notch = polysToMesh(boolean('subtract', toPolys(box.v, box.f), toPolys(small.v, small.f)));
  assert.equal(notch.v.length, 14); assert.equal(notch.f.length, 9); near(meshVolume(notch), 7875, 1e-9);
});

test('features: extrude with hole and revolve', () => {
  const R = regions(sk([{ t: 'rect', x: 0, y: 0, w: 30, h: 20 }, { t: 'circle', c: [15, 10], r: 4 }])).filter(r => r.holes.length);
  const m = extrudeRegions(R, PLANES.XY, 0, 5);
  near(meshVolume(m), (600 - ngonArea(4, 64)) * 5, 1e-9); assert.ok(watertight(m));
  const ring = revolveRegions(regions(sk([{ t: 'rect', x: 5, y: 0, w: 3, h: 10 }])), PLANES.XZ, 'y', 360, 64);
  assert.ok(watertight(ring)); near(meshVolume(ring), 30 * 2 * Math.PI * 6.5, 3, 'Pappus (faceted)');
  const quarter = revolveRegions(regions(sk([{ t: 'rect', x: 0, y: 0, w: 3, h: 10 }])), PLANES.XZ, 'y', 90, 64);
  assert.ok(watertight(quarter));
});

test('3D fillet and chamfer on convex and concave edges', () => {
  const box = makeBox(20, 20, 20);
  assert.equal(featureEdges(box.v, box.f).length, 12);
  const ch = edgeBlend(box.v, box.f, [-10, -10, 10], [10, -10, 10], 4, 'chamfer');
  near(meshVolume(ch), 8000 - 20 * 8, 1e-9); assert.ok(watertight(ch));
  const segs = 16, sector = (r, sweep, n) => 0.5 * r * r * n * Math.sin(sweep / n); // inscribed polygon
  const fl = edgeBlend(box.v, box.f, [-10, -10, 10], [10, -10, 10], 4, 'fillet', segs);
  const k = Math.round(segs * (Math.PI / 2) / (Math.PI / 2));
  near(meshVolume(fl), 8000 - 20 * (16 - sector(4, Math.PI / 2, k) - 0) , 2, 'fillet volume (faceted)');
  assert.ok(watertight(fl));
  // the result's straight edge between fillet and side is recognised as one run
  const fe = featureEdges(fl.v, fl.f); assert.ok(fe.length > 12);
  const blk = makeBox(10, 30, 10); blk.v = blk.v.map(p => [p[0] + 5, p[1], p[2] + 5]);
  const L = polysToMesh(boolean('subtract', toPolys(box.v, box.f), toPolys(blk.v, blk.f)));
  const cf = edgeBlend(L.v, L.f, [0, -10, 0], [0, 10, 0], 3, 'fillet', 16);
  assert.ok(meshVolume(cf) > 6000, 'concave fillet adds material'); assert.ok(watertight(cf));
  const two = edgeBlend(fl.v, fl.f, [10, -10, 10], [10, 10, 10], 4, 'fillet', 16);
  assert.equal(typeof two, 'object', 'second fillet on a shared corner'); assert.ok(watertight(two));
});

test('regression: chamfer after fillet on a holed, chamfered plate stays watertight', () => {
  const s = sk([{ t: 'rect', x: -20, y: -15, w: 40, h: 30 }, { t: 'circle', c: [0, 0], r: 5 }]);
  cornerOp(s, [20, 15], 0.5, 5, 'fillet'); cornerOp(s, [-20, -15], 0.5, 4, 'chamfer');
  const plate = extrudeRegions(regions(s).filter(r => r.holes.length), PLANES.XY, 0, 8);
  const f = edgeBlend(plate.v, plate.f, [-16, -15, 8], [20, -15, 8], 2, 'fillet', 8);
  assert.ok(watertight(f), 'after fillet');
  const fe = featureEdges(f.v, f.f);
  const e = fe.find(q => [f.v[q.a], f.v[q.b]].every(p => Math.abs(p[0] - 20) < 1e-9 && Math.abs(p[1] + 15) < 1e-9));
  const [a, b] = straightRun(f.v, fe, e.a, e.b);
  near(Math.abs(a[2] - b[2]), 6, 1e-9, 'vertical edge shortened by the fillet');
  const c = edgeBlend(f.v, f.f, a, b, 1.5, 'chamfer');
  assert.ok(watertight(c), 'after chamfer');
  near(meshVolume(f) - meshVolume(c), 1.5 * 1.5 / 2 * 6, 1e-6, 'chamfer volume');
});

test('constraints: angle dimension drives the angle between two lines', async () => {
  const { setDimValue: setDim, lineAngle } = await import('../js/sketch.js');
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 0] }, { id: 2, t: 'line', a: [0, 0], b: [5, 7] }], cons: [{ t: 'h', a: 1 }], nextEnt: 10 };
  const d = { id: 3, t: 'dim', kind: 'ang', la: 1, lb: 2, value: lineAngle(s, { la: 1, lb: 2 }) };
  s.ents.push(d);
  setDim(s, d, 30);
  near(lineAngle(s, d), 30, 1e-9, 'angle');
  near(s.ents[0].b[1], 0, 1e-12, 'reference line stays horizontal');
  near(Math.hypot(...s.ents[1].b), Math.hypot(5, 7), 1e-6, 'driven line keeps its length');
});

test('constraints: fully-constrained detection', async () => {
  const { constrainedEntities } = await import('../js/constraints.js');
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 0] }, { id: 2, t: 'line', a: [10, 0], b: [10, 5] }], cons: [{ t: 'h', a: 1 }], nextEnt: 10 };
  assert.deepEqual([...constrainedEntities(s)], [], 'nothing fully fixed yet');
  s.ents.push({ id: 3, t: 'dim', kind: 'lin', A: { e: 1, k: 'a' }, B: { e: 1, k: 'b' }, value: 10 });
  assert.deepEqual([...constrainedEntities(s)], [1], 'origin + H + length fix line 1 only');
  s.cons.push({ t: 'v', a: 2 }); s.ents.push({ id: 4, t: 'dim', kind: 'lin', A: { e: 2, k: 'a' }, B: { e: 2, k: 'b' }, value: 5 });
  assert.deepEqual([...constrainedEntities(s)].sort(), [1, 2]);
  assert.equal(dof(s), 0);
});

test('3D two-distance chamfer', () => {
  const box = makeBox(20, 20, 20);
  const c = edgeBlend(box.v, box.f, [-10, -10, 10], [10, -10, 10], 2, 'chamfer', 16, 5);
  near(meshVolume(c), 8000 - 20 * (2 * 5 / 2), 1e-9); assert.ok(watertight(c));
  const s = edgeBlend(box.v, box.f, [-10, -10, 10], [10, -10, 10], 2, 'chamfer', 16, 5, true);
  near(meshVolume(s), 8000 - 20 * 5, 1e-9, 'swap keeps the same volume');
  assert.notDeepEqual(c.v.map(p => p.join()).sort(), s.v.map(p => p.join()).sort(), 'but mirrors the bevel');
});

test('AutoCAD edits: move, copy, rotate, scale, mirror', async () => {
  const { transformEntities } = await import('../js/sketch.js');
  const s = sk([{ t: 'line', a: [0, 0], b: [10, 0] }, { t: 'arc', c: [0, 0], r: 5, a0: 0, a1: Math.PI / 2 }, { t: 'rect', x: 0, y: 0, w: 4, h: 2 }]);
  transformEntities(s, [1, 2, 3], { kind: 'move', d: [1, 2] });
  assert.deepEqual([s.ents[0].a, s.ents[0].b, s.ents[1].c, [s.ents[2].x, s.ents[2].y]], [[1, 2], [11, 2], [1, 2], [1, 2]]);
  const ids = transformEntities(s, [1], { kind: 'move', d: [0, 5] }, true);
  assert.equal(s.ents.length, 4); assert.deepEqual(s.ents.find(e => e.id === ids[0]).a, [1, 7]);
  transformEntities(s, [1], { kind: 'rotate', c: [1, 2], deg: 90 });
  assert.deepEqual(s.ents[0].b, [1, 12], 'exact 90° rotation');
  transformEntities(s, [2], { kind: 'scale', c: [1, 2], f: 2.5 });
  assert.equal(s.ents[1].r, 12.5);
  transformEntities(s, [3], { kind: 'rotate', c: [0, 0], deg: 30 });
  assert.equal(s.ents.filter(e => e.t === 'rect').length, 0, 'rect rotated by 30° becomes lines');
  const m = sk([{ t: 'arc', c: [5, 0], r: 2, a0: 0, a1: Math.PI / 2 }]);
  transformEntities(m, [1], { kind: 'mirror', a: [0, -1], b: [0, 1] });
  near(m.ents[0].c[0], -5, 1e-12); near(Math.cos(m.ents[0].a0), -0, 1e-12); near(Math.sin(m.ents[0].a0), 1, 1e-12, 'mirrored arc starts at 90°');
});

test('AutoCAD edits: offset, extend, polygon', async () => {
  const { offsetEntity, extendLine, addPolygon } = await import('../js/sketch.js');
  const s = sk([{ t: 'line', a: [0, 0], b: [10, 0] }, { t: 'circle', c: [0, 0], r: 5 }, { t: 'line', a: [20, -5], b: [20, 5] }]);
  const o = offsetEntity(s, s.ents[0], 2.5, [3, -1]);
  assert.deepEqual([o.a, o.b], [[0, -2.5], [10, -2.5]]);
  assert.equal(offsetEntity(s, s.ents[1], 1, [0, 1]).r, 4, 'inside the circle shrinks it');
  assert.equal(offsetEntity(s, s.ents[1], 1, [0, 9]).r, 6);
  assert.equal(extendLine(s, s.ents[0], [9, 0]), true);
  assert.deepEqual(s.ents[0].b, [20, 0], 'extended to the vertical boundary');
  const ids = addPolygon(s, [0, 0], [10, 0], 6);
  assert.equal(ids.length, 6);
  const pg = s.ents.filter(e => ids.includes(e.id));
  for (const e of pg) near(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 10, 1e-9, 'hexagon side = circumradius');
});

test('Plasticity modifiers: push/pull, shell, mirror', async () => {
  const { faceRegion, findRegion, pushPull, shell, mirrorMesh } = await import('../js/modifiers.js');
  const box = makeBox(20, 20, 20);
  const top = box.f.findIndex(f => f.every(i => box.v[i][2] === 10));
  const reg = faceRegion(box.v, box.f, top);
  assert.deepEqual(reg.n, [0, 0, 1]);
  const up = pushPull(box.v, box.f, reg, 5);
  near(meshVolume(up), 8000 + 400 * 5, 1e-9); assert.ok(watertight(up)); assert.equal(up.f.length, 6, 'still a clean box');
  const down = pushPull(box.v, box.f, reg, -7.5);
  near(meshVolume(down), 8000 - 400 * 7.5, 1e-9); assert.ok(watertight(down));
  const again = findRegion(up.v, up.f, [0, 0, 1], 15, [0, 0, 15]);
  assert.ok(again && again.faces.length >= 1, 'region re-found after the operation');
  const hollow = shell(box.v, box.f, [reg], 2);
  near(meshVolume(hollow), 8000 - 16 * 16 * 18, 1e-6, 'open-top shell volume'); assert.ok(watertight(hollow));
  const closed = shell(box.v, box.f, [], 2);
  near(meshVolume(closed), 8000 - 16 ** 3, 1e-6, 'closed hollow');
  assert.match(shell(box.v, box.f, [], 11), /too large/);
  // cylinder shell opened at the top keeps exact faceted walls
  const cyl = makeCylinder(10, 20, 32);
  const ctop = faceRegion(cyl.v, cyl.f, cyl.f.findIndex(f => f.length === 32 && cyl.v[f[0]][2] === 10));
  const cup = shell(cyl.v, cyl.f, [ctop], 1);
  const apo = r => r * Math.cos(Math.PI / 32); // inradius of the 32-gon
  near(meshVolume(cup), ngonArea(10, 32) * 20 - ngonArea((apo(10) - 1) / Math.cos(Math.PI / 32), 32) * 19, 1e-6, 'cup volume'); assert.ok(watertight(cup));
  const L = makeBox(10, 10, 10); L.v = L.v.map(p => [p[0] + 5, p[1], p[2]]);
  const mir = mirrorMesh(L.v, L.f, [1, 0, 0], 0, true);
  near(meshVolume(mir), 2000, 1e-9, 'mirrored across x=0 and fused'); assert.ok(watertight(mir));
});

test('AutoCAD inquiry: areas, angles, horizontal/vertical dimensions', async () => {
  const { polygonArea, regionArea, entityArea, angleAt, setDimValue: setDim, dimValue: dv } = await import('../js/sketch.js');
  assert.deepEqual(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), { area: 12, perimeter: 14 });
  const R = regions(sk([{ t: 'rect', x: 0, y: 0, w: 20, h: 10 }, { t: 'circle', c: [10, 5], r: 3 }])).find(r => r.holes.length);
  near(regionArea(R).area, 200 - ngonArea(3, 64), 1e-9);
  near(entityArea({ t: 'circle', r: 2 }).area, 4 * Math.PI, 1e-12);
  near(angleAt([0, 0], [1, 0], [1, 1]), 45, 1e-12);
  near(angleAt([0, 0], [1, 0], [-1, 0]), 180, 1e-12);
  const s = { ents: [{ id: 1, t: 'line', a: [0, 0], b: [10, 4] }], cons: [], nextEnt: 10 };
  const h = { id: 2, t: 'dim', kind: 'hor', A: { e: 1, k: 'a' }, B: { e: 1, k: 'b' }, value: 10 };
  const v = { id: 3, t: 'dim', kind: 'ver', A: { e: 1, k: 'a' }, B: { e: 1, k: 'b' }, value: 4 };
  s.ents.push(h, v);
  assert.equal(dv(s, h), 10); assert.equal(dv(s, v), 4);
  setDim(s, h, 25);
  assert.deepEqual(s.ents[0].b, [25, 4], 'horizontal dimension drives only X');
  setDim(s, v, 7.5);
  assert.deepEqual(s.ents[0].b, [25, 7.5], 'vertical dimension drives only Y');
});

test('CAD: revolve about an arbitrary line, sketch arrays, slice, polar body array', async () => {
  const { arrayRect, arrayPolar } = await import('../js/sketch.js');
  const { slice, rotateMesh } = await import('../js/modifiers.js');
  // a 2×10 rectangle 3..5 from a vertical axis at x=10 → tube between radii 5 and 7? revolve about line x=10
  const R = regions(sk([{ t: 'rect', x: 3, y: 0, w: 2, h: 10 }]));
  const tube = revolveRegions(R, PLANES.XZ, { p: [10, 0], d: [0, 1] }, 360, 64);
  assert.ok(watertight(tube));
  near(meshVolume(tube), 20 * 2 * Math.PI * 6, 4, 'Pappus about x=10 (centroid distance 6)');
  const s = sk([{ t: 'circle', c: [0, 0], r: 1 }]);
  assert.equal(arrayRect(s, [1], 3, 2, 5, 4).length, 5);
  assert.deepEqual(s.ents.at(-1).c, [10, 4]);
  const p = sk([{ t: 'circle', c: [10, 0], r: 1 }]);
  arrayPolar(p, [1], [0, 0], 4, 360);
  assert.deepEqual(p.ents.map(e => e.c), [[10, 0], [0, 10], [-10, 0], [0, -10]], 'exact quarter turns');
  const box = makeBox(20, 20, 20);
  const { pos, neg } = slice(box.v, box.f, [0, 0, 1], 2.5);
  near(meshVolume(pos), 400 * 7.5, 1e-6); near(meshVolume(neg), 400 * 12.5, 1e-6);
  assert.ok(watertight(pos) && watertight(neg));
  const r = rotateMesh([[10, 0, 0]], [0, 0, 0], [0, 0, 1], 90);
  near(r[0][0], 0, 1e-12); near(r[0][1], 10, 1e-12);
});

test('3D: thicken a plane into a solid', async () => {
  const { thicken } = await import('../js/modifiers.js');
  const { makePlane } = await import('../js/mesh.js');
  const pl = makePlane(10, 20);
  const t = thicken(pl.v, pl.f, 2);
  near(meshVolume(t), 400, 1e-9); assert.ok(watertight(t));
  assert.match(thicken(makeBox(2, 2, 2).v, makeBox(2, 2, 2).f, 1), /already closed/);
});

test('2D: ellipse and spline entities', async () => {
  const { entityArea, transformEntities, toDXF, ellPt, splinePoints } = await import('../js/sketch.js');
  const e = { id: 1, t: 'ellipse', c: [0, 0], rx: 10, ry: 5, rot: 0 };
  const s = { ents: [e], cons: [], nextEnt: 10 };
  near(entityArea(e).area, 50 * Math.PI, 1e-12);
  const R = regions(s); assert.equal(R.length, 1); near(R[0].area, 50 * Math.PI, 0.3, 'faceted ellipse region');
  assert.deepEqual(ellPt(e, Math.PI / 2), [0, 5]);
  transformEntities(s, [1], { kind: 'rotate', c: [0, 0], deg: 90 });
  const q = ellPt(s.ents[0], 0); near(q[0], 0, 1e-12); near(q[1], 10, 1e-12);
  assert.match(toDXF(s), /ELLIPSE/);
  const sp = splinePoints([[0, 0], [10, 10], [20, 0]], false, 8);
  assert.deepEqual(sp[0], [0, 0]); assert.deepEqual(sp.at(-1), [20, 0]);
  assert.ok(sp.some(p => Math.abs(p[0] - 10) < 1e-12 && Math.abs(p[1] - 10) < 1e-12), 'passes through fit points');
  const cl = { ents: [{ id: 1, t: 'spline', pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true }], cons: [] };
  assert.equal(regions(cl).length, 1, 'closed spline forms a region');
});

test('2D: associative hatch and text', async () => {
  const { hatchLines, toDXF, transformEntities, textBox } = await import('../js/sketch.js');
  const s = { ents: [{ id: 1, t: 'rect', x: 0, y: 0, w: 20, h: 10 }, { id: 2, t: 'circle', c: [10, 5], r: 3 }, { id: 3, t: 'hatch', seed: [2, 2], pattern: 'LINE', scale: 1, angle: 0 }], cons: [], nextEnt: 10 };
  const hl = hatchLines(s, s.ents[2]);
  assert.ok(hl.lines.length > 0);
  for (const [a, b] of hl.lines) { assert.ok(a[1] === b[1], 'horizontal lines'); const mid = [(a[0] + b[0]) / 2, a[1]]; assert.ok(Math.hypot(mid[0] - 10, mid[1] - 5) > 2.9 || Math.abs(a[0] - b[0]) < 20, 'gaps over the hole'); }
  assert.ok(hl.lines.some(([a, b]) => Math.abs(a[1] - 6.35) < 1e-9 && Math.abs(b[0] - a[0]) < 20), 'scanline through the hole is split');
  s.ents[0].w = 40; s.ents = [...s.ents];
  assert.ok(hatchLines(s, s.ents[2]).lines.some(([, b]) => b[0] > 39), 'associative: follows the boundary');
  const t = { id: 4, t: 'text', p: [0, 0], h: 2.5, str: 'A-1', rot: 0 }; s.ents.push(t);
  assert.match(toDXF(s), /TEXT[\s\S]*A-1/);
  assert.deepEqual(textBox(t)[0], [0, 0]);
  transformEntities(s, [4], { kind: 'move', d: [5, 5] }); assert.deepEqual(s.ents.at(-1).p, [5, 5]);
});

test('3D: fillet and chamfer round edges (boss rim, hole rim)', async () => {
  const { edgeLoop, circleBlend, featureEdges } = await import('../js/edges.js');
  const cyl = makeCylinder(10, 20, 32);
  const fe = featureEdges(cyl.v, cyl.f);
  const rim = fe.find(e => cyl.v[e.a][2] === 10 && cyl.v[e.b][2] === 10);
  const circ = edgeLoop(cyl.v, fe, rim.a, rim.b);
  assert.ok(circ && circ.loop.length === 32 && Math.abs(circ.R - 10) < 1e-9, 'top rim recognised as a 32-segment circle');
  const f = circleBlend(cyl.v, cyl.f, circ, 2, 'fillet', 16);
  assert.ok(typeof f === 'object' && watertight(f), 'filleted boss is watertight');
  // a faceted revolution (n segments) of a region sweeps n·sin(2π/n)·area·(centroid radius)
  const K = 32 * Math.sin(2 * Math.PI / 32);
  const removed = meshVolume(cyl) - meshVolume(f);
  assert.ok(removed > K * 4 * (1 - Math.PI / 4) * 9 && removed < K * 4 * (1 - Math.PI / 4) * 10, `fillet removes the swept corner (${removed.toFixed(3)})`);
  const ch = circleBlend(cyl.v, cyl.f, circ, 2, 'chamfer');
  near(meshVolume(cyl) - meshVolume(ch), K * 2 * (10 - 2 / 3), 1e-6, 'chamfer volume (Pappus, faceted)');
  assert.ok(watertight(ch), 'chamfered boss watertight');
  // hole rim in a plate
  const plate = makeBox(40, 40, 10), hole = makeCylinder(6, 30, 32);
  const P = polysToMesh(boolean('subtract', toPolys(plate.v, plate.f), toPolys(hole.v, hole.f)));
  const fe2 = featureEdges(P.v, P.f);
  const hr = fe2.find(e => [P.v[e.a], P.v[e.b]].every(q => q[2] === 5 && Math.abs(Math.hypot(q[0], q[1]) - 6) < 1e-6));
  const hc = edgeLoop(P.v, fe2, hr.a, hr.b);
  assert.ok(hc && Math.abs(hc.R - 6) < 1e-6, 'hole rim recognised');
  const hf = circleBlend(P.v, P.f, hc, 1.5, 'chamfer');
  assert.ok(typeof hf === 'object' && watertight(hf) && meshVolume(hf) < meshVolume(P), 'countersunk hole (chamfered rim) is watertight');
});

test('3D: sweep (mitred) and loft', async () => {
  const { sweepRegion, pathFrames, loftSections } = await import('../js/sweep.js');
  const sq = { outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]], holes: [] };
  const straight = sweepRegion(sq, pathFrames([[0, 0, 0], [0, 0, 10]], { u: [1, 0, 0], v: [0, 1, 0] }));
  near(meshVolume(straight), 40, 1e-9); assert.ok(watertight(straight));
  const bent = sweepRegion(sq, pathFrames([[0, 0, 0], [0, 0, 10], [10, 0, 10]], { u: [1, 0, 0], v: [0, 1, 0] }));
  near(meshVolume(bent), 80, 1e-9, 'mitred L-sweep keeps the exact section'); assert.ok(watertight(bent));
  const tube = sweepRegion({ outer: sq.outer.map(p => p.map(c => c * 2)), holes: [sq.outer.slice().reverse()] }, pathFrames([[0, 0, 0], [0, 0, 5]], { u: [1, 0, 0], v: [0, 1, 0] }));
  near(meshVolume(tube), (16 - 4) * 5, 1e-9, 'section with a hole'); assert.ok(watertight(tube));
  const s10 = z => [[-5, -5, z], [5, -5, z], [5, 5, z], [-5, 5, z]], s5 = z => [[-2.5, -2.5, z], [2.5, -2.5, z], [2.5, 2.5, z], [-2.5, 2.5, z]];
  const prism = loftSections([s10(0), s10(10)], 64);
  near(meshVolume(prism), 1000, 1e-6); assert.ok(watertight(prism));
  const frustum = loftSections([s10(0), s5(10)], 64);
  near(meshVolume(frustum), 10 / 3 * (100 + 25 + 50), 1e-6, 'square frustum'); assert.ok(watertight(frustum));
});

test('3D: draft side faces about a neutral plane', async () => {
  const { draft, faceRegion } = await import('../js/modifiers.js');
  const box = makeBox(20, 20, 20);
  const side = faceRegion(box.v, box.f, box.f.findIndex(f => f.every(i => box.v[i][0] === 10)));
  const th = 5, r = draft(box.v, box.f, [side], [0, 0, 1], -10, th);
  near(meshVolume(r), 8000 - 4000 * Math.tan(th * Math.PI / 180), 1e-9, 'one drafted face');
  assert.ok(watertight(r));
  const top = Math.max(...r.v.filter(p => p[2] > 9.99).map(p => p[0]));
  near(top, 10 - 20 * Math.tan(th * Math.PI / 180), 1e-9, 'top edge moves inward by h·tanθ');
  const all = [0, 1, 2, 3].map(k => faceRegion(box.v, box.f, box.f.findIndex(f => { const n = M.faceNormal(f.map(i => box.v[i])); return Math.abs(n[2]) < 0.5 && Math.abs(Math.atan2(n[1], n[0]) - k * Math.PI / 2 + (k > 2 ? 2 * Math.PI : 0)) < 1e-6; })));
  const tp = draft(box.v, box.f, all, [0, 0, 1], -10, th);
  const s = 20 - 40 * Math.tan(th * Math.PI / 180);
  near(meshVolume(tp), 20 / 3 * (400 + s * s + 20 * s), 1e-6, 'all four sides → frustum'); assert.ok(watertight(tp));
});

test('2D: fillet and chamfer where a line meets an arc', () => {
  const a225 = 225 * Math.PI / 180, P = [10 * Math.cos(a225), 10 + 10 * Math.sin(a225)];
  const mk = () => ({ ents: [{ id: 1, t: 'line', a: P.slice(), b: [P[0] + 15, P[1]] }, { id: 2, t: 'arc', c: [0, 10], r: 10, a0: Math.PI, a1: a225 }], cons: [], nextEnt: 10 });
  const s = mk();
  const f = cornerOp(s, P, 0.5, 2, 'fillet').ent;
  assert.equal(f.t, 'arc');
  near(Math.abs(f.c[1] - P[1]), 2, 1e-9, 'fillet tangent to the line');
  const dO = Math.hypot(f.c[0], f.c[1] - 10);
  assert.ok(Math.abs(dO - 12) < 1e-9 || Math.abs(dO - 8) < 1e-9, 'fillet tangent to the arc');
  near(s.ents[0].a[1], P[1], 1e-12); assert.ok(s.ents[0].a[0] > P[0], 'line trimmed back');
  const end = [10 * Math.cos(s.ents[1].a1), 10 + 10 * Math.sin(s.ents[1].a1)];
  near(Math.hypot(end[0] - f.c[0], end[1] - f.c[1]), 2, 1e-9, 'arc trimmed to the tangent point');
  const s2 = mk();
  const ch = cornerOp(s2, P, 0.5, 2, 'chamfer').ent;
  near(Math.hypot(ch.a[0] - P[0], ch.a[1] - P[1]), 2, 1e-9); near(Math.hypot(ch.b[0] - P[0], ch.b[1] - P[1]), 2, 1e-9, 'chamfer: both ends 2 from the corner');
});

test('2D: fillet where two arcs meet', () => {
  // two R10 arcs meeting at the origin: centres (-10,0) and (10,0) would be tangent, so tilt them
  const c1 = [-8, 6], c2 = [8, 6], R = 10;
  const a1 = Math.atan2(-c1[1], -c1[0]), a2 = Math.atan2(-c2[1], -c2[0]);
  const s = { ents: [{ id: 1, t: 'arc', c: c1, r: R, a0: a1 - 1, a1 }, { id: 2, t: 'arc', c: c2, r: R, a0: a2, a1: a2 + 1 }], cons: [], nextEnt: 10 };
  const f = cornerOp(s, [0, 0], 0.5, 2, 'fillet').ent;
  assert.equal(f.t, 'arc');
  for (const c of [c1, c2]) { const d = Math.hypot(f.c[0] - c[0], f.c[1] - c[1]); assert.ok(Math.abs(d - 12) < 1e-9 || Math.abs(d - 8) < 1e-9, 'tangent to both arcs'); }
  assert.equal(s.cons.filter(c => c.t === 'tan').length, 2);
});

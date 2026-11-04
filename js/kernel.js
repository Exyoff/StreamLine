// B-rep geometry kernel: OpenCascade (via replicad), compiled to WebAssembly.
// Solids are exact boundary representations — true planes, cylinders, cones, spheres, tori and
// rolling-ball fillets. Triangles exist only for display and picking (a cached tessellation).
// Shapes are treated as immutable values: every operation returns a new shape, so undo snapshots,
// history checkpoints and duplicates can share them freely.
import initOC from '../vendor/occ/replicad_single.js';
import * as R from '../vendor/occ/replicad.js';
import { PolyMesh } from './mesh.js';
import * as SK from './sketch.js';
export { R };

let oc = null;
export const ready = () => !!oc;
export async function initKernel() {
  if (oc) return;
  const url = new URL('../vendor/occ/replicad_single.wasm', import.meta.url).href;
  oc = await initOC({ locateFile: () => url });
  R.setOC(oc);
}
export const getOC = () => oc;

// ---------- transforms (object placement ↔ shape) ----------
const isIdentity = o => o.loc.every(v => v === 0) && o.rot.every(v => v === 0) && o.scl.every(v => v === 1);
// THREE.Matrix4 (column-major elements) → new shape
export function transformShape(shape, m) {
  const e = m.elements;
  const t = new oc.gp_Trsf();
  try { t.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]); }
  catch (err) { t.delete(); throw new Error('Solids can only be scaled uniformly'); }
  const b = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true);
  const r = R.cast(b.Shape());
  b.delete(); t.delete();
  return r;
}
let objMatrixFn = null;
export function setMatrixFn(fn) { objMatrixFn = fn; }
export function worldShape(o) { return isIdentity(o) ? o.shape : transformShape(o.shape, objMatrixFn(o)); }
export function toLocal(shape, o) { return isIdentity(o) ? shape : transformShape(shape, objMatrixFn(o).clone().invert()); }
export const translated = (shape, v) => shape.clone().translate(v);
export const rotated = (shape, deg, c, axis) => shape.clone().rotate(deg, c, axis);

// ---------- tessellation (cached per shape) ----------
const tessCache = new WeakMap();
const bbOf = s => { const b = s.boundingBox.bounds; return { min: b[0], max: b[1], diag: Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]) }; };
// { mesh: PolyMesh (triangles, per-vertex normals in mesh.n), faceOf: triangle → face index,
//   faces: [{ type }], edges: [{ pts, seam, closed, type, len }] }
export function tess(shape) {
  let t = tessCache.get(shape); if (t) return t;
  const { diag } = bbOf(shape);
  const tol = Math.max(5e-4, diag * 2.5e-4), ang = 0.1; // fine enough that curved faces read as smooth
  const m = shape.mesh({ tolerance: tol, angularTolerance: ang });
  const faces = shape.faces, idx = new Map(faces.map((f, i) => [f.hashCode, i]));
  const v = []; for (let i = 0; i < m.vertices.length; i += 3) v.push([m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]]);
  const n = []; for (let i = 0; i < m.normals.length; i += 3) n.push([m.normals[i], m.normals[i + 1], m.normals[i + 2]]);
  const f = []; for (let i = 0; i < m.triangles.length; i += 3) f.push([m.triangles[i], m.triangles[i + 1], m.triangles[i + 2]]);
  const faceOf = new Int32Array(f.length).fill(-1);
  for (const g of m.faceGroups) { const fi = idx.get(g.faceId) ?? -1; for (let k = g.start / 3; k < (g.start + g.count) / 3; k++) faceOf[k] = fi; }
  const mesh = new PolyMesh(v, f); mesh.n = n;
  // seams (an edge used twice by the same face, e.g. the line closing a cylinder) are not drawn
  // a seam belongs to a single face (the cylinder it closes); every real edge of a solid joins two
  const faceCount = new Map();
  for (const fc of faces) for (const hc of new Set(fc.edges.map(e => e.hashCode))) faceCount.set(hc, (faceCount.get(hc) || 0) + 1);
  const solid = shape.solids && shape.solids.length > 0;
  const seams = new Set(solid ? [...faceCount].filter(([, c]) => c === 1).map(([hc]) => hc) : []);
  const em = shape.meshEdges({ tolerance: tol, angularTolerance: ang });
  const edgeList = shape.edges, eidx = new Map(edgeList.map((e, i) => [e.hashCode, i]));
  const edges = [];
  for (const g of em.edgeGroups) {
    const pts = []; for (let k = g.start; k < g.start + g.count; k++) pts.push([em.lines[k * 3], em.lines[k * 3 + 1], em.lines[k * 3 + 2]]);
    // the extractor gives segment pairs; collapse to a polyline
    const poly = [pts[0]]; for (let k = 1; k < pts.length; k++) { const q = pts[k], p = poly[poly.length - 1]; if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > 1e-9) poly.push(q); }
    let len = 0; for (let k = 1; k < poly.length; k++) len += Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1], poly[k][2] - poly[k - 1][2]);
    const ei = eidx.get(g.edgeId) ?? -1, E = edgeList[ei];
    edges.push({ i: ei, pts: poly, len, seam: seams.has(g.edgeId), closed: poly.length > 2 && Math.hypot(...[0, 1, 2].map(k => poly[0][k] - poly[poly.length - 1][k])) < tol * 2, type: E ? E.geomType : '' });
  }
  t = { mesh, faceOf, faces: faces.map(fc => ({ type: fc.geomType })), edges, tol, diag };
  tessCache.set(shape, t);
  return t;
}
// attach a shape to a scene object: display mesh + picking tables (local coordinates)
export function setShape(o, shape) {
  o.shape = shape;
  const t = tess(shape);
  o.mesh = t.mesh; o.faceOf = t.faceOf; o.brep = t;
  return o;
}

// ---------- serialization (cached) ----------
const serCache = new WeakMap();
export function serialize(shape) { let s = serCache.get(shape); if (!s) { s = shape.serialize(); serCache.set(shape, s); } return s; }
export function deserialize(str) { const s = R.deserializeShape(str); serCache.set(s, str); return s; }

// ---------- measures ----------
export const volume = s => R.measureVolume(s);
export const area = s => R.measureArea(s);

// ---------- exact sketch regions → faces ----------
// All closed regions of a sketch, as exact planar faces: the sketch curves split a large face on the
// sketch plane (OpenCascade's splitter), and each piece is one region. Cached per entity list.
const regionCache = new WeakMap();
function curveEdges(sk) {
  const W = p => SK.toW(sk.plane, p), n = sk.plane.n, out = [];
  const line = (a, b) => { if (SK.d2(a, b) > 1e-9) out.push(R.makeLine(W(a), W(b))); };
  for (const e of sk.ents) {
    if (e.construction || e.t === 'dim' || e.t === 'text' || e.t === 'hatch') continue;
    if (e.t === 'line') line(e.a, e.b);
    else if (e.t === 'rect') { const c = SK.rectCorners(e); for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4]); }
    else if (e.t === 'circle') out.push(R.makeCircle(e.r, W(e.c), n));
    else if (e.t === 'arc') {
      const sw = SK.sweep(e), at = a => [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
      if (sw >= 2 * Math.PI - 1e-12) out.push(R.makeCircle(e.r, W(e.c), n));
      else out.push(R.makeThreePointArc(W(at(e.a0)), W(at(e.a0 + sw / 2)), W(at(e.a0 + sw))));
    } else {
      // ellipse / spline: a smooth B-spline through densely sampled points
      const pl = SK.entPolyline(e); if (!pl || pl.pts.length < 2) continue;
      const pts = pl.pts.slice(); if (pl.closed && SK.d2(pts[0], pts[pts.length - 1]) > 1e-9) pts.push(pts[0]);
      try { out.push(R.makeBSplineApproximation(pts.map(W), { tolerance: 1e-4, degMax: 3, degMin: 3 })); }
      catch (err) { for (let i = 1; i < pts.length; i++) line(pts[i - 1], pts[i]); }
    }
  }
  return out;
}
export function sketchFaces(sk) {
  const key = JSON.stringify(sk.plane);
  const c = regionCache.get(sk.ents); if (c && c.key === key) return c.faces;
  const edges = curveEdges(sk);
  let faces = [];
  if (edges.length) {
    const kp = sk.ents.flatMap(e => SK.keyPoints(e).map(k => k.p).concat(e.r ? [[e.c[0] - e.r, e.c[1] - e.r], [e.c[0] + e.r, e.c[1] + e.r]] : []));
    const xs = kp.map(p => p[0]), ys = kp.map(p => p[1]);
    const m = Math.max(10, (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)));
    const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
    const W = p => SK.toW(sk.plane, p);
    const big = R.makeFace(R.assembleWire([R.makeLine(W([x0, y0]), W([x1, y0])), R.makeLine(W([x1, y0]), W([x1, y1])), R.makeLine(W([x1, y1]), W([x0, y1])), R.makeLine(W([x0, y1]), W([x0, y0]))]));
    const sp = new oc.BRepAlgoAPI_Splitter();
    const args = new oc.NCollection_List_TopoDS_Shape(); args.Append(big.wrapped);
    const tools = new oc.NCollection_List_TopoDS_Shape(); for (const e of edges) tools.Append(e.wrapped);
    sp.SetArguments(args); sp.SetTools(tools);
    const pr = new oc.Message_ProgressRange(); sp.Build(pr); pr.delete();
    const res = R.cast(sp.Shape());
    sp.delete(); args.delete(); tools.delete();
    // drop the outer piece (it touches the big frame)
    const frame = [[x0, y0], [x1, y1]];
    faces = res.faces.filter(f => { const b = f.boundingBox.bounds, q = [SK.toP(sk.plane, b[0]), SK.toP(sk.plane, b[1])]; const lo = [Math.min(q[0][0], q[1][0]), Math.min(q[0][1], q[1][1])], hi = [Math.max(q[0][0], q[1][0]), Math.max(q[0][1], q[1][1])]; return !(lo[0] <= frame[0][0] + 1e-6 && lo[1] <= frame[0][1] + 1e-6 && hi[0] >= frame[1][0] - 1e-6 && hi[1] >= frame[1][1] - 1e-6); });
  }
  regionCache.set(sk.ents, { key, faces });
  return faces;
}
// the exact face of the region containing a 2D point of the sketch
export function regionFace(sk, pt) {
  const faces = sketchFaces(sk); if (!faces.length) return null;
  const v = R.makeVertex(SK.toW(sk.plane, pt));
  let best = null;
  for (const f of faces) { const d = R.measureDistanceBetween(f, v); if (d < 1e-6 && (!best || R.measureArea(f) < best.a)) best = { f, a: R.measureArea(f) }; }
  return best ? best.f : null;
}

// ---------- building blocks ----------
export const vec = v => new R.Vector(v);
export function prism(face, v) { return R.basicFaceExtrusion(face, vec(v)); }
export function revolve(face, c, dir, deg) { return R.revolution(face, c, dir, deg); }
export function fuseAll(shapes) { let s = shapes[0]; for (let i = 1; i < shapes.length; i++) s = s.fuse(shapes[i]); return s; }
export function boolean(kind, a, b) { return kind === 'union' || kind === 'join' ? a.fuse(b) : kind === 'subtract' || kind === 'cut' ? a.cut(b) : a.intersect(b); }
export const isEmpty = s => !s || s.isNull || (typeof s.isNull === 'function' && s.isNull()) || !s.faces.length;

// ---------- finding faces / edges again (for picks and history replay) ----------
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function ptSegDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2)) : 0;
  return dist3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}
// the point halfway along a polyline (by length) — a stable reference that no other edge shares
export function polyMid(pts) {
  let L = 0; for (let k = 1; k < pts.length; k++) L += dist3(pts[k - 1], pts[k]);
  let acc = 0;
  for (let k = 1; k < pts.length; k++) { const s = dist3(pts[k - 1], pts[k]); if (acc + s >= L / 2) { const t = s ? (L / 2 - acc) / s : 0; return pts[k - 1].map((c, j) => c + (pts[k][j] - c) * t); } acc += s; }
  return pts[0].slice();
}
export function polyDist(p, pts) { let d = Infinity; for (let k = 1; k < pts.length; k++) d = Math.min(d, ptSegDist(p, pts[k - 1], pts[k])); return pts.length === 1 ? dist3(p, pts[0]) : d; }
// face of `shape` under a local point (and roughly facing n, when given)
export function faceAt(shape, p, n = null) {
  const v = R.makeVertex(p), faces = shape.faces;
  let best = null;
  faces.forEach((f, i) => {
    const d = R.measureDistanceBetween(f, v);
    if (n) { try { const fn = f.normalAt(p); const k = fn.x * n[0] + fn.y * n[1] + fn.z * n[2]; if (k < 0.9) return; } catch (e) {} }
    if (!best || d < best.d) best = { d, i, f };
  });
  const t = tess(shape);
  return best && best.d < t.tol * 4 + 1e-6 ? best : null;
}
// edge of `shape` nearest a local point; falls back to the same kind/length when it moved
export function edgeAt(shape, ref) {
  const t = tess(shape), list = shape.edges;
  let best = null;
  for (const e of t.edges) { if (e.seam || e.i < 0) continue; const d = polyDist(ref.p, e.pts); if (!best || d < best.d) best = { d, e }; }
  if (best && best.d < t.tol * 4 + 1e-6) return { edge: list[best.e.i], info: best.e };
  if (ref.len == null) return null;
  best = null;
  for (const e of t.edges) {
    if (e.seam || e.i < 0 || e.type !== ref.type || Math.abs(e.len - ref.len) > 1e-4 * Math.max(1, ref.len) + t.tol) continue;
    const d = polyDist(ref.p, e.pts); if (!best || d < best.d) best = { d, e };
  }
  return best ? { edge: list[best.e.i], info: best.e } : null;
}

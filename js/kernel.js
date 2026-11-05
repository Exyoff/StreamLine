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
  patchBooleans();
}
// OCCT's booleans may change their input shapes in place (tolerances, split edges) unless told not to. Shapes here are
// shared values (undo snapshots, history checkpoints, duplicates), so a union that touched a torus once could leave
// it broken for the next one: every boolean runs non-destructively.
function patchBooleans() {
  let proto = R.Solid.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'fuse')) proto = Object.getPrototypeOf(proto);
  if (!proto || proto._nonDestructive) return;
  const run = (Kind, verb, a, b, { optimisation = 'none', simplify = true } = {}) => {
    const bl = new oc[Kind](), la = new oc.NCollection_List_TopoDS_Shape(), lb = new oc.NCollection_List_TopoDS_Shape();
    try {
      la.Append(a.wrapped); lb.Append(b.wrapped); bl.SetArguments(la); bl.SetTools(lb);
      bl.SetNonDestructive(true);
      if (optimisation === 'commonFace') bl.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
      if (optimisation === 'sameFace') bl.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
      bl.Build(new oc.Message_ProgressRange());
      if (bl.HasErrors()) throw new Error(`Could not ${verb}`);
      const r = R.cast(bl.Shape());
      if (!R.isShape3D(r)) throw new Error(`Could not ${verb} as a 3d shape`);
      return simplify ? unifyFaces(r) : r;
    } finally { for (const x of [bl, la, lb]) try { x.delete(); } catch (e) { /* freed */ } }
  };
  // merge the faces and edges a boolean split on one surface (a box on a box: one top face). OCCT's own SimplifyResult
  // edits the result in place, and the result shares faces with the inputs: on a torus it turned the result and the
  // stored body inside out. Here the inputs are kept safe, and the merge is used only if the volume stays the same.
  const unifyFaces = sh => {
    let u = null;
    try {
      u = new oc.ShapeUpgrade_UnifySameDomain(sh.wrapped, true, true, false);
      u.SetSafeInputMode(true); u.SetAngularTolerance(1e-3);
      u.Build();
      const r = R.cast(u.Shape()), v0 = volume(sh), v1 = volume(r);
      if (Math.abs(v1 - v0) <= 1e-6 * Math.max(1, Math.abs(v0))) return r;
    } catch (e) { /* keep the result as built */ } finally { try { u && u.delete(); } catch (e) { /* freed */ } }
    return sh;
  };
  proto._occ = { fuse: proto.fuse, cut: proto.cut, intersect: proto.intersect }; // (replicad's own, for comparison)
  proto.fuse = function (other, opts) { return run('BRepAlgoAPI_Fuse', 'fuse', this, other, opts); };
  proto.cut = function (tool, opts) { return run('BRepAlgoAPI_Cut', 'cut', this, tool, opts); };
  proto.intersect = function (tool, opts) { return run('BRepAlgoAPI_Common', 'intersect', this, tool, opts); };
  proto._nonDestructive = true;
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
// a part's exact world bounds, kept per shape and placement: the gizmo asks for its pivot every frame, and moving a
// copy of a big part (threads, an inserted assembly) for each ask made it crawl
const worldBoxMemo = new WeakMap();
export function worldBounds(o) {
  const key = isIdentity(o) ? '' : objMatrixFn(o).elements.join(',');
  const m = worldBoxMemo.get(o.shape);
  if (m && m.key === key) return m.b;
  const b = worldShape(o).boundingBox.bounds;
  worldBoxMemo.set(o.shape, { key, b });
  return b;
}
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
// STEP export with exact colours. OpenCascade's writer takes linear RGB (it writes sRGB in the file), but replicad
// hands it the 8-bit sRGB values as they are (the file came out lighter); an 8-bit linear hex rounded dark colours
// off instead (#6f7782 came back #707782). For the length of the export the colour gets its exact linear values.
const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function exportSTEP(parts, opts) {
  const Orig = oc.Quantity_ColorRGBA;
  oc.Quantity_ColorRGBA = function (...a) { return a.length === 4 ? new Orig(linear(a[0]), linear(a[1]), linear(a[2]), a[3]) : new Orig(...a); };
  try { return R.exportSTEP(parts, opts); } finally { oc.Quantity_ColorRGBA = Orig; }
}
// an sRGB colour as the linear-RGB hex OpenCascade's STEP writer expects (8-bit: K.exportSTEP is exact)
export function stepColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex;
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return '#' + [0, 2, 4].map(i => Math.round(lin(parseInt(m[1].slice(i, i + 2), 16) / 255) * 255).toString(16).padStart(2, '0')).join('');
}
export const area = s => R.measureArea(s);
// ---------- STEP import: one body per solid, with the file's part names and colours ----------
// (this OpenCascade build has no XCAF reader, so names and colours are read from the STEP text: PRODUCT names in
// order, and each STYLED_ITEM's colour traced back to its product)
export function stepParts(shape, text) {
  const solids = shape.solids || [];
  if (!solids.length) return [{ shape, name: null, color: null }];
  const ent = new Map(), re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([\s\S]*?)\)\s*;/g;
  let m; while ((m = re.exec(text))) ent.set(+m[1], { t: m[2], a: m[3] });
  const refs = a => [...a.matchAll(/#(\d+)/g)].map(x => +x[1]);
  const products = [...ent].filter(([, e]) => e.t === 'PRODUCT').map(([id, e]) => ({ id, name: (e.a.match(/^\s*'((?:[^']|'')*)'/) || [])[1]?.replace(/''/g, "'") || null }));
  const colorOf = new Map();
  // (STEP stores sRGB, the same as the app's colours: the export hands OpenCascade linear values, which it writes as sRGB)
  const hex = rgb => '#' + rgb.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
  const bfs = (start, stop, maxDepth) => { let level = [start]; const seen = new Set(level); for (let d = 0; d < maxDepth && level.length; d++) { const next = []; for (const id of level) { const e = ent.get(id); if (!e) continue; if (d > 0 && stop(e, id)) return id; for (const r of refs(e.a)) if (!seen.has(r)) { seen.add(r); next.push(r); } } level = next; for (const id of level) { const e = ent.get(id); if (e && stop(e, id)) return id; } } return null; };
  const repOf = new Map(), sdrOf = new Map();
  for (const [id, x] of ent) {
    if (/REPRESENTATION$/.test(x.t) && !/DEFINITION/.test(x.t)) for (const r of refs(x.a)) if (!repOf.has(r)) repOf.set(r, id);
    if (x.t === 'SHAPE_DEFINITION_REPRESENTATION') for (const r of refs(x.a)) sdrOf.set(r, id);
  }
  for (const [, e] of ent) {
    if (e.t !== 'STYLED_ITEM') continue;
    const r = refs(e.a), item = r[r.length - 1];
    const rgbId = bfs(r[0], x => x.t === 'COLOUR_RGB', 8); if (rgbId == null) continue;
    const rgb = ent.get(rgbId).a.split(',').slice(1).map(Number);
    // the representation holding the item, then the product it describes
    const rep = repOf.get(item), sdr = rep != null ? sdrOf.get(rep) : null;
    const prod = sdr != null ? bfs(sdr, x => x.t === 'PRODUCT', 6) : null;
    if (rgb.length === 3) { colorOf.set(item, hex(rgb)); if (prod != null && !colorOf.has(prod)) colorOf.set(prod, hex(rgb)); }
  }
  if (solids.length === 1) solids[0] = shape; // (one part: keep the shape as read)
  // each solid's own entity (in file order, which is the order they are read), traced to the product whose
  // representation holds it — so a part made of two solids gives both its name, and the other parts keep theirs
  const solidIds = [...ent].filter(([, e]) => e.t === 'MANIFOLD_SOLID_BREP' || e.t === 'BREP_WITH_VOIDS').map(([id]) => id);
  if (solidIds.length === solids.length) {
    const prodName = new Map(products.map(p => [p.id, p.name])), seen = new Map();
    return solids.map((sh, i) => {
      const sid = solidIds[i], rep = repOf.get(sid), sdr = rep != null ? sdrOf.get(rep) : null;
      const prod = sdr != null ? bfs(sdr, x => x.t === 'PRODUCT', 6) : null;
      let name = prod != null ? prodName.get(prod) : null;
      if (name) { const k = (seen.get(name) || 0) + 1; seen.set(name, k); if (k > 1) name = `${name} (${k})`; }
      return { shape: sh, name: name || null, color: colorOf.get(sid) || (prod != null ? colorOf.get(prod) : null) || null };
    });
  }
  const named = products.length === solids.length;
  return solids.map((sh, i) => ({ shape: sh, name: named ? products[i].name : null, color: named ? colorOf.get(products[i].id) || null : null }));
}

// ---------- text outlines (engrave / emboss) ----------
// Liberation Sans Bold (SIL OFL 1.1), loaded the first time text is outlined
let fontP = null;
export const textFont = () => (fontP ??= R.loadFont(new URL('../vendor/fonts/LiberationSans-Bold.ttf', import.meta.url).href, 'streamline'));
// the glyph contours of a string as closed 2D polylines (y up, origin at the baseline start); h = capital height
export function textContours(font, str, h) {
  const capEm = (font.tables?.os2?.sCapHeight || 0.72 * font.unitsPerEm) / font.unitsPerEm, size = h / capEm;
  const cmds = font.getPath(str, 0, 0, size).commands, out = [], N = 8;
  let cur = null, last = null;
  const P = (x, y) => [x, -y], push = p => { if (!cur.length || SK.d2(cur[cur.length - 1], p) > 1e-6 * h) cur.push(p); };
  const close = () => { if (cur && cur.length > 2) { if (SK.d2(cur[0], cur[cur.length - 1]) < 1e-6 * h) cur.pop(); if (cur.length > 2) out.push(cur); } cur = null; };
  for (const c of cmds) {
    if (c.type === 'M') { close(); cur = []; last = [c.x, c.y]; push(P(c.x, c.y)); }
    else if (c.type === 'L') { last = [c.x, c.y]; push(P(c.x, c.y)); }
    else if (c.type === 'Q') { const [x0, y0] = last; for (let i = 1; i <= N; i++) { const t = i / N, a = (1 - t) ** 2, b = 2 * t * (1 - t), d = t * t; push(P(a * x0 + b * c.x1 + d * c.x, a * y0 + b * c.y1 + d * c.y)); } last = [c.x, c.y]; }
    else if (c.type === 'C') { const [x0, y0] = last; for (let i = 1; i <= N; i++) { const t = i / N, a = (1 - t) ** 3, b = 3 * t * (1 - t) ** 2, e = 3 * t * t * (1 - t), d = t ** 3; push(P(a * x0 + b * c.x1 + e * c.x2 + d * c.x, a * y0 + b * c.y1 + e * c.y2 + d * c.y)); } last = [c.x, c.y]; }
    else if (c.type === 'Z') close();
  }
  close();
  return out;
}

/* volume, area and both centroids: a geometric fingerprint that changes when a feature moves even if size doesn't */
export const massSig = s => { const v = R.measureShapeVolumeProperties(s), a = R.measureShapeSurfaceProperties(s); const out = [v.volume, ...v.centerOfMass, a.area, ...a.centerOfMass]; try { v.delete(); a.delete(); } catch (e) {} return out; };

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
// Union / Subtract / Intersect, with the volumes checked: a result that lost material (OCCT can hand back just one of
// the bodies) is an error, not a silent wrong part
export function boolean(kind, a, b) {
  const op = kind === 'union' || kind === 'join' ? 'fuse' : kind === 'subtract' || kind === 'cut' ? 'cut' : 'intersect';
  const r = a[op](b);
  checkBoolean(op, a, b, r);
  return r;
}
export function checkBoolean(op, a, b, r) {
  let va, vb, v;
  try { va = Math.abs(volume(a)); vb = Math.abs(volume(b)); v = volume(r); } catch (e) { return; }
  const tol = 1e-6 * Math.max(1, va + vb);
  const ok = op === 'fuse' ? v >= Math.max(va, vb) - tol && v <= va + vb + tol : op === 'cut' ? v >= Math.max(0, va - vb) - tol && v <= va + tol : v >= -tol && v <= Math.min(va, vb) + tol;
  if (!ok) throw new Error(`${op === 'fuse' ? 'Union' : op === 'cut' ? 'Subtract' : 'Intersect'} failed — the kernel gave a broken result (${v.toFixed(3)} mm³)`);
}
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
// the area and centre of a face (local), remembered with a face pick so a moved face is found again by its size
// a flat face's two biggest box extents (its length and width, for an axis-aligned face): tells the tongue's side
// face from a slot wall of about the same area
function faceDims(f) { try { const b = f.boundingBox.bounds, e = [0, 1, 2].map(k => b[1][k] - b[0][k]).sort((x, y) => y - x); return [e[0], e[1]]; } catch (e) { return null; } }
export function faceHint(f) { try { const c0 = f.center, c = typeof c0 === 'function' ? c0() : c0; return { a: R.measureArea(f), c: [c.x, c.y, c.z], dims: faceDims(f) }; } catch (e) { return null; } }
// (only: { f0, f1 } — look at those faces alone: one part of an inserted assembly)
export function faceAt(shape, p, n = null, hint = null, only = null) {
  const v = R.makeVertex(p), faces = shape.faces, skip = i => only && (i < only.f0 || i >= only.f1);
  let best = null;
  faces.forEach((f, i) => {
    if (skip(i)) return;
    const d = R.measureDistanceBetween(f, v);
    if (n) { try { const fn = f.normalAt(p); const k = (fn.x * n[0] + fn.y * n[1] + fn.z * n[2]) / (Math.hypot(fn.x, fn.y, fn.z) || 1); if (k < 0.9) return; } catch (e) {} }
    if (!best || d < best.d) best = { d, i, f };
  });
  const t = tess(shape);
  if (best && best.d < t.tol * 4 + 1e-6) return best;
  // the face moved (an earlier step changed the body): the flat face with the same normal that is nearest in
  // offset — scored by offset plus how far the old point (slid onto its plane) lies outside it, so a rim that got
  // narrower still beats a floor far below that happens to contain the point
  if (!n) return null;
  let alt = null;
  faces.forEach((f, i) => {
    if (skip(i) || f.geomType !== 'PLANE') return;
    let fn, c;
    try { fn = f.normalAt(); c = f.center; c = typeof c === 'function' ? c() : c; } catch (e) { return; }
    const nn = [fn.x, fn.y, fn.z]; if (nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 1 - 1e-6) return;
    const dw = (c.x - p[0]) * n[0] + (c.y - p[1]) * n[1] + (c.z - p[2]) * n[2];
    let q = [p[0] + n[0] * dw, p[1] + n[1] * dw, p[2] + n[2] * dw];
    const out = R.measureDistanceBetween(f, R.makeVertex(q));
    let score = Math.abs(dw) + 4 * out;
    // known size: a face of about the same area wins over a big one that merely contains the point (a block that
    // moved along a long wall), and the point keeps its place on the face (a hole stays 9 mm up, not at the centre)
    let a = 0; if (hint && hint.a > 0) { try { a = R.measureArea(f); } catch (e) {} if (a > 0) score += 4 * Math.sqrt(hint.a) * Math.abs(Math.log(a / hint.a)); }
    // and its length and width: exactly the same face, slid along with its feature (the tongue at the end of an arm
    // that got longer), is scored by its offset with only a light charge for the slide; another shape (a slot
    // wall of about the same area) pays for the difference
    if (hint && hint.dims && hint.dims[1] > 1e-6) {
      const dd = faceDims(f);
      if (dd && dd[1] > 1e-6) {
        const lr = Math.abs(Math.log(dd[0] / hint.dims[0])) + Math.abs(Math.log(dd[1] / hint.dims[1]));
        if (lr < 1e-4 && a > 0 && Math.abs(a / hint.a - 1) < 0.1) score = Math.abs(dw) + 0.25 * out; // (a hole or recess on it changes its area a little)
        else score += 8 * Math.sqrt(hint.a || hint.dims[0] * hint.dims[1]) * lr;
      }
    }
    if (hint && hint.c) { const qs = [p[0] + c.x - hint.c[0], p[1] + c.y - hint.c[1], p[2] + c.z - hint.c[2]]; if (R.measureDistanceBetween(f, R.makeVertex(qs)) <= t.tol * 4 + 1e-6) q = qs; }
    if (R.measureDistanceBetween(f, R.makeVertex(q)) > t.tol * 4 + 1e-6) q = [c.x, c.y, c.z]; // (the point is off the face: follow its centre instead)
    if (!alt || score < alt.score) alt = { d: 0, i, f, dw, q, score };
  });
  return alt;
}
// An edge's signature, so it can be found again after earlier steps resize the body: its centre and
// axis (a circle's centre and normal, or a line's midpoint and direction), radius, and how the faces
// on either side sit relative to it (outer rim vs inner rim, top vs bottom). All in local coordinates.
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export function edgeSig(shape, info) {
  const pts = info.pts, mid = polyMid(pts);
  let c, ax, r = 0;
  if (info.closed) {
    const q = pts.slice(0, -1); c = [0, 1, 2].map(k => q.reduce((s, v) => s + v[k], 0) / q.length);
    let nx = 0, ny = 0, nz = 0; for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    ax = unit3([nx, ny, nz]); r = q.reduce((s, v) => s + Math.hypot(...sub3(v, c)), 0) / q.length;
  } else { c = mid; ax = unit3(sub3(pts[pts.length - 1], pts[0])); }
  if (ax[0] < -1e-9 || (Math.abs(ax[0]) < 1e-9 && (ax[1] < -1e-9 || (Math.abs(ax[1]) < 1e-9 && ax[2] < 0)))) ax = ax.map(v => -v); // direction-free
  const E = shape.edges[info.i], hc = E && E.hashCode, fn = [];
  const radial = info.closed ? unit3(sub3(mid, c)) : null;
  if (hc != null) for (const f of shape.faces) {
    if (!f.edges.some(e => e.hashCode === hc)) continue;
    let n; try { const v = f.normalAt(mid); n = unit3([v.x, v.y, v.z]); } catch (e) { continue; }
    fn.push(info.closed ? [dot3(n, radial), Math.abs(dot3(n, ax)) < 1e-9 ? 0 : dot3(n, ax)] : n);
  }
  fn.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] || 0) - (b[2] || 0));
  return { c, ax, r, fn };
}
const sigFacesMatch = (a, b) => !a || !b || (a.length === b.length && a.every((v, k) => v.every((x, j) => Math.abs(x - b[k][j]) < 0.25)));
// edge of `shape` nearest a local point; when it moved, the same kind of edge whose signature matches
export function edgeAt(shape, ref) {
  const t = tess(shape), list = shape.edges;
  let best = null;
  for (const e of t.edges) { if (e.seam || e.i < 0) continue; const d = polyDist(ref.p, e.pts); if (!best || d < best.d) best = { d, e }; }
  if (best && best.d < t.tol * 4 + 1e-6 && (!ref.sig || sigFacesMatch(edgeSig(shape, best.e).fn, ref.sig.fn))) return { edge: list[best.e.i], info: best.e };
  if (ref.sig) {
    const g = ref.sig; best = null;
    for (const e of t.edges) {
      if (e.seam || e.i < 0 || (ref.type && e.type !== ref.type) || !!e.closed !== !!ref.closed) continue;
      const q = edgeSig(shape, e);
      if (Math.abs(dot3(q.ax, g.ax)) < 0.995 || !sigFacesMatch(q.fn, g.fn)) continue;
      // circles: distance between centres plus the change in radius; lines: how far the line moved
      const d = e.closed ? Math.hypot(...sub3(q.c, g.c)) + Math.abs(q.r - g.r) : polyDist(ref.p, e.pts) + 0.1 * Math.abs(e.len - ref.len);
      if (!best || d < best.d) best = { d, e };
    }
    if (best) return { edge: list[best.e.i], info: best.e };
  }
  if (ref.len == null) return null;
  best = null;
  for (const e of t.edges) {
    if (e.seam || e.i < 0 || e.type !== ref.type || Math.abs(e.len - ref.len) > 1e-4 * Math.max(1, ref.len) + t.tol) continue;
    const d = polyDist(ref.p, e.pts); if (!best || d < best.d) best = { d, e };
  }
  return best ? { edge: list[best.e.i], info: best.e } : null;
}

// ---------- cylinders, helices, revolved tools (threads and holes) ----------
// axis and radius of a cylindrical face (local coordinates), or null (no extent: cheap enough to ask every face)
export function cylinderAxis(face) {
  if (face.geomType !== 'CYLINDRE') return null;
  let ad = null;
  try {
    ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
    const cy = ad.Cylinder(), ax = cy.Axis(), L = ax.Location(), D = ax.Direction();
    return { c: [L.X(), L.Y(), L.Z()], d: [D.X(), D.Y(), D.Z()], R: cy.Radius() };
  } catch (e) { return null; } finally { try { ad && ad.delete(); } catch (e) {} }
}
// axis, radius and extent of a cylindrical face (local coordinates), or null
export function cylinderOf(face) {
  if (face.geomType !== 'CYLINDRE') return null;
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  const cy = ad.Cylinder(), ax = cy.Axis(), L = ax.Location(), D = ax.Direction();
  const c = [L.X(), L.Y(), L.Z()], d = [D.X(), D.Y(), D.Z()], R0 = cy.Radius();
  ad.delete();
  // extent along the axis from the face's tessellation
  let t0 = Infinity, t1 = -Infinity;
  const m = face.mesh({ tolerance: 0.01, angularTolerance: 0.3 });
  for (let i = 0; i < m.vertices.length; i += 3) { const t = (m.vertices[i] - c[0]) * d[0] + (m.vertices[i + 1] - c[1]) * d[1] + (m.vertices[i + 2] - c[2]) * d[2]; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
  return { c, d, R: R0, t0, t1 };
}
// a valid closed solid (fillets that overrun a thin wall can give self-intersecting junk)
export function isValid(shape) {
  let a = null;
  try { a = new oc.BRepCheck_Analyzer(shape.wrapped, true, false); return a.IsValid_2 ? a.IsValid_2() : a.IsValid_1 ? a.IsValid_1() : a.IsValid(); }
  catch (e) { return true; } finally { try { a && a.delete(); } catch (e) {} }
}
// Draft (taper) faces about a neutral plane through `origin`, pulling along the unit `dir`. OCCT tilts planes and
// turns a cylinder whose axis runs along the pull into a cone; faces tangent to a picked one (a fillet) go with it.
export function draft(shape, faces, deg, origin, dir) {
  let b = null, p0 = null, d = null, pln = null;
  try {
    b = new oc.BRepOffsetAPI_DraftAngle(shape.wrapped);
    p0 = new oc.gp_Pnt(origin[0], origin[1], origin[2]); d = new oc.gp_Dir(dir[0], dir[1], dir[2]); pln = new oc.gp_Pln(p0, d);
    for (const f of faces) { b.Add(f.wrapped, d, deg * Math.PI / 180, pln, true); if (!b.AddDone()) throw new Error('A picked face cannot be drafted along this pull'); }
    b.Build();
    if (!b.IsDone()) throw new Error('Draft failed');
    const r = R.cast(b.Shape());
    if (isEmpty(r) || !isValid(r)) throw new Error('Draft gave a broken solid');
    return r;
  } finally { for (const x of [b, pln, d, p0]) try { x && x.delete(); } catch (e) { /* freed */ } }
}
// Shell (hollow a solid, removing `faces`, wall `t` inward). OCCT's thick-solid builder is picky on some
// surfaces (lofted cones, swept tubes), so try its join variants, then fall back to cutting an inward
// offset of the whole body (open faces get the cavity pushed out through them).
export function shell(shape, faces, t) {
  const tries = [[false, oc.GeomAbs_JoinType.GeomAbs_Arc], [true, oc.GeomAbs_JoinType.GeomAbs_Intersection], [false, oc.GeomAbs_JoinType.GeomAbs_Intersection], [true, oc.GeomAbs_JoinType.GeomAbs_Arc]];
  const v0 = Math.abs(volume(shape));
  const sane = r => { if (!r || isEmpty(r)) return false; const v = volume(r); return v > 1e-9 && v < v0 - 1e-9 && isValid(r); };
  for (const [inter, join] of tries) {
    let b = null, list = null;
    try {
      list = new oc.NCollection_List_TopoDS_Shape(); for (const f of faces) list.Append(f.wrapped);
      b = new oc.BRepOffsetAPI_MakeThickSolid();
      b.MakeThickSolidByJoin(shape.wrapped, list, -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, inter, false, join, false, new oc.Message_ProgressRange());
      if (b.IsDone()) { const r = R.cast(b.Shape()); if (sane(r)) return r; }
    } catch (e) { /* next variant */ } finally { try { b && b.delete(); list && list.delete(); } catch (e) {} }
  }
  // fallback: body minus its inward offset; each open face lets the cavity out through it
  const inner = R.cast((() => { const m = new oc.BRepOffsetAPI_MakeOffsetShape(); m.PerformByJoin(shape.wrapped, -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, new oc.Message_ProgressRange()); const sh = m.Shape(); return sh; })());
  if (isEmpty(inner)) throw new Error('offset failed');
  let cavity = inner;
  for (const f of faces) {
    const n = f.normalAt(); const d = [n.x * t * 1.5, n.y * t * 1.5, n.z * t * 1.5];
    cavity = cavity.fuse(inner.clone().translate(d));
  }
  const r = shape.cut(cavity);
  if (!sane(r)) throw new Error('shell fallback failed');
  return r;
}
// axis of a cone face (chamfered hole or boss): { c, d } in local coordinates, or null. (This OCCT build has
// no gp_Cone binding, so the axis comes from one of the cone's circular edges: centre and normal.)
export function coneAxis(face) {
  if (face.geomType !== 'CONE') return null;
  return circleAxisOf(face);
}
// axis of a surface of revolution (a revolved jug wall), or null when this build cannot tell
export function revolutionAxis(face) {
  if (face.geomType !== 'REVOLUTION_SURFACE') return null;
  let ad = null;
  try {
    ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
    const ax = ad.AxeOfRevolution(), L = ax.Location(), D = ax.Direction();
    return { c: [L.X(), L.Y(), L.Z()], d: [D.X(), D.Y(), D.Z()] };
  } catch (e) { return circleAxisOf(face); } finally { try { ad && ad.delete(); } catch (e) {} }
}
// centre, normal and radius of the largest circular edge of a face (a boss's rim, not a hole in it)
// (.whole: the face is a plain disc — every edge is the same circle — e.g. a boss's end face)
export function circleAxisOf(face) {
  let best = null, all = true; const cs = [];
  for (const e of face.edges) {
    if (e.geomType !== 'CIRCLE') { all = false; continue; }
    try {
      const P = [0.05, 0.38, 0.71].map(t => { const v = e.pointAt(t); return [v.x, v.y, v.z]; });
      const u = sub3(P[1], P[0]), v = sub3(P[2], P[0]), w = cross3(u, v), w2 = dot3(w, w);
      if (w2 < 1e-18) continue;
      const c = P[0].map((x, k) => x + (dot3(u, u) * cross3(v, w)[k] + dot3(v, v) * cross3(w, u)[k]) / (2 * w2));
      const R0 = Math.hypot(...sub3(P[0], c)); cs.push([c, R0]);
      if (!best || R0 > best.R) best = { c, d: unit3(w), R: R0 };
    } catch (err) { all = false; }
  }
  if (best) best.whole = all && cs.every(([c, r]) => Math.hypot(...sub3(c, best.c)) < 1e-6 * Math.max(1, best.R) && Math.abs(r - best.R) < 1e-6 * Math.max(1, best.R));
  return best;
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// a solid of revolution from a closed (radial, axial) profile around the axis through c along d
export function revolveProfile(c, d, u, prof) {
  const P = prof.map(([r, t]) => [c[0] + u[0] * r + d[0] * t, c[1] + u[1] * r + d[1] * t, c[2] + u[2] * r + d[2] * t]);
  const es = []; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-9) es.push(R.makeLine(a, b)); }
  return R.revolution(R.makeFace(R.assembleWire(es)), c, d, 360);
}
// a closed polygon (3D points in one plane) extruded along v
export function polyPrism(P, v) {
  const es = []; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-9) es.push(R.makeLine(a, b)); }
  return R.basicFaceExtrusion(R.makeFace(R.assembleWire(es)), vec(v));
}
export const compound = shapes => shapes.length === 1 ? shapes[0] : R.makeCompound(shapes);
// a helical thread ridge: the triangular profile swept along a helix (binormal fixed to the axis)
export function threadRidge(c, d, radius, pitch, length, prof, lefthand = false) {
  const helix = R.makeHelix(pitch, length, radius, c, d, lefthand);
  const sp = helix.startPoint || (helix.edges && helix.edges[0].startPoint);
  const S0 = [sp.x, sp.y, sp.z];
  const radial = [S0[0] - c[0], S0[1] - c[1], S0[2] - c[2]], k = radial[0] * d[0] + radial[1] * d[1] + radial[2] * d[2];
  const ur = [radial[0] - d[0] * k, radial[1] - d[1] * k, radial[2] - d[2] * k], ul = Math.hypot(...ur), u = ur.map(v => v / ul);
  const base = [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k];
  const P = prof.map(([r, t]) => [base[0] + u[0] * r + d[0] * t, base[1] + u[1] * r + d[1] * t, base[2] + u[2] * r + d[2] * t]);
  const es = []; for (let i = 0; i < P.length; i++) es.push(R.makeLine(P[i], P[(i + 1) % P.length]));
  const dir = new oc.gp_Dir(d[0], d[1], d[2]);
  const s = R.genericSweep(R.assembleWire(es), helix, { support: dir });
  dir.delete();
  return s;
}

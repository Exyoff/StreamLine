// Draw workspace: 2D drafting tools on the active sketch plane + sketch/profile rendering.
import * as THREE from 'three';
import { S, emit, objById, isShown } from './state.js';
import { view, camera } from './viewport.js';
import * as SK from './sketch.js';
const ecos = d => { const k = Math.round(d / 90); return Math.abs(d / 90 - k) < 1e-12 ? [1, 0, -1, 0][((k % 4) + 4) % 4] : Math.cos(d * Math.PI / 180); };
const esin = d => ecos(d - 90);
import * as F from './features.js';
import { runOp, updateOp, commit, cancelOp, getLast } from './ops.js';
import { fmtLen, fmtAng, fmtArea } from './units.js';
import { h, field, choice, toast, openKeypad, $ } from './ui.js';
import { xfFor } from './scene.js';
import { Line2 } from '../vendor/lines/Line2.js';
import { LineGeometry } from '../vendor/lines/LineGeometry.js';
import { LineSegments2 } from '../vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/lines/LineSegmentsGeometry.js';
import { editAndSolve, dof as sketchDof, analyze as analyzeSketch } from './constraints.js';
import { defSize } from './operators.js';
import { I } from './icons.js';
import * as H from './history.js';
import * as K from './kernel.js';

const D = Math.PI / 180;
export const corner = { kind: 'fillet', size: null };
let propsOpen = false; // compact entity card by default (AutoCAD-style quick properties)
export const st = { start: null, chain: [], preview: null, snap: null, stage: 0, arc: null, dimA: null, typed: {}, press: null, grip: null };
// drawing modes (Fusion / Plasticity style variants of the same tool)
export const MODES = {
  rect: [['corner', 'Two corners', '2 corners'], ['center', 'Centre + corner', 'centre'], ['3pt', 'Three points (rotated)', '3 points']],
  circle: [['center', 'Centre + radius', 'centre'], ['2pt', 'Two points (diameter)', '2 points'], ['3pt', 'Three points', '3 points']],
  arc: [['center', 'Centre, start, end', 'centre'], ['3pt', 'Start, end, through', '3 points']],
};
export const drawMode = { rect: 'corner', circle: 'center', arc: 'center' };
export function setDrawMode(t, m) { if (!MODES[t] || !MODES[t].some(x => x[0] === m)) return; drawMode[t] = m; resetTool(); }
const mode = t => drawMode[t] || (MODES[t] && MODES[t][0][0]);
const modeName = t => (MODES[t] || []).find(x => x[0] === mode(t))?.[1] || '';
export function resetTool() { result = null; st.p2 = null; st.pressed = false; st.arcMode = false; st.lastDir = null; if (tool() !== 'line') lineOpts.construction = false; Object.assign(st, { onPend: null, cmd: null, last: null, dimLine: null, dimPend: null, start: null, chain: [], preview: null, snap: null, stage: 0, arc: null, dimA: null, typed: {}, press: null, grip: null }); view.render(); emit('drawcard'); }
// Undo with a shape half drawn (a first corner, a centre, the start of a line chain) takes back only that: it used to
// cancel the shape finished before it as well, or in a new sketch the whole sketch
export function dropPending() {
  if (!(st.start || st.p2 || st.arc || st.dimA || st.dimPend)) return false;
  Object.assign(st, { start: null, p2: null, arc: null, dimA: null, dimPend: null, chain: [], preview: null, typed: {} });
  view.render(); emit('drawcard'); return true;
}
// In the studio (unified 3D workspace) each stroke draws on the plane under the finger: a body face,
// or the construction plane (ground). Curves on the same plane share one sketch, created on demand.
export const studio = () => S.ed.workspace === 'model';
let target = null; // { skId } | { plane, face } (pending: the sketch is created with the first curve)
const samePlane = (a, b) => a.n.every((c, i) => Math.abs(c - b.n[i]) < 1e-9) && Math.abs(a.n.reduce((s, c, i) => s + c * (a.o[i] - b.o[i]), 0)) < 1e-6;
export function cplane() { return S.ed.cplane || SK.PLANES.XY; }
// typed first points (tool card / command line) refer to the construction plane, like Plasticity
function setPlaneTarget(plane, face = null) {
  // reuse the plane's sketch only while no feature has used it — a new part gets its own sketch
  const ex = (S.doc.sketches || []).find(k => isShown(k) && samePlane(k.plane, plane) && H.firstUsing([k.id]) < 0);
  if (ex) { target = { skId: ex.id }; S.ed.sketch = ex.id; }
  else target = { plane: { o: plane.o.slice(), u: plane.u.slice(), v: plane.v.slice(), n: plane.n.slice() }, face };
}
const editTarget = () => { const e = S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch); if (e) { target = { skId: e.id }; S.ed.sketch = e.id; } return !!e; };
function typedTarget() { if (editTarget()) return; if (studio() && DRAW_PRIMARY.has(tool()) && waitingFirstPoint() && !st.pressed) setPlaneTarget(cplane(), cplane().face || null); }
export function clearTarget() { target = null; }
export function chooseTarget(x, y) {
  if (editTarget()) return;
  const hit = view.pickObject(x, y);
  let plane = null, face = null;
  if (hit && hit.face >= 0) {
    const o = objById(hit.id), c = view.cam;
    plane = F.facePlane(o, hit.face, [-Math.sin(c.yaw), Math.cos(c.yaw), 0]);
    if (plane) face = { obj: o.id };
  }
  if (!plane) { plane = cplane(); face = plane.face || null; }
  setPlaneTarget(plane, face);
}
const sk = () => {
  if (!studio()) return SK.activeSketch();
  // the sketch being edited always wins; picked curves (select / edit commands) live in the active sketch
  if (S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch)) return SK.sketchById(S.ed.editingSketch);
  if (!DRAW_PRIMARY.has(tool()) && S.ed.sketch != null && SK.activeSketch()) return SK.activeSketch();
  if (target && target.skId) return SK.sketchById(target.skId) || SK.activeSketch();
  if (target) return { id: null, pending: true, plane: target.plane, face: target.face, ents: [], cons: [] };
  return SK.activeSketch() || { id: null, pending: true, plane: cplane(), face: cplane().face || null, ents: [], cons: [] };
};
export const drawTarget = sk;
const DRAW_PRIMARY = new Set(['line', 'rect', 'circle', 'arc', 'ellipse', 'spline', 'polygon', 'text']);
const waitingFirstPoint = () => !st.start && !st.arc && !st.dimA && !st.dimPend && !(st.cmd && (st.cmd.center || st.cmd.base || (st.cmd.pts && st.cmd.pts.length)));
// run a sketch edit, creating the sketch first if the target plane has none yet (one undo step)
function editSketch(label, fn, fields) {
  const s = sk();
  if (s.pending) { const ok = runOp(F.sketchOpNew(label, s.plane, s.face, fn, fields)); if (ok) target = { skId: S.ed.sketch }; return ok; }
  return runOp(F.sketchOp(label, s.id, fn, fields));
}
const tool = () => S.ed.tool;

// ---------- geometry helpers ----------
function planePt(x, y, s = sk()) {
  const r = view.ray(x, y).ray;
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...s.plane.n), new THREE.Vector3(...s.plane.o));
  // looking along the plane (e.g. the Top plane from the Front view): the hit would be miles away, so take the
  // ray's point nearest the view centre and drop it onto the plane
  const w = Math.abs(r.direction.dot(pl.normal)) > 0.02 ? r.intersectPlane(pl, new THREE.Vector3()) : null;
  if (!w) { const tc = view.cam.target.clone().sub(r.origin).dot(r.direction); return SK.toP(s.plane, r.origin.clone().addScaledVector(r.direction, tc).toArray()); }
  return SK.toP(s.plane, w.toArray());
}
let refCache = { key: null, pts: [] };
function refPts(s) {
  if (refCache.key === S.doc.objects && refCache.sk === s.id && refCache.pl === s.plane) return refCache.pts;
  const pts = [];
  for (const o of S.doc.objects) {
    if (!isShown(o)) continue;
    const xf = xfFor(o);
    for (const v of o.mesh.v) {
      const w = xf.toW(v), d = [w[0] - s.plane.o[0], w[1] - s.plane.o[1], w[2] - s.plane.o[2]];
      if (Math.abs(d[0] * s.plane.n[0] + d[1] * s.plane.n[1] + d[2] * s.plane.n[2]) < 1e-6) pts.push(SK.toP(s.plane, w));
    }
  }
  refCache = { key: S.doc.objects, sk: s.id, pl: s.plane, pts };
  return pts;
}
function snapAt(x, y, from = st.start, exclude = null) {
  const s = sk(), raw = planePt(x, y);
  const wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  // rectangles snap both corners to the grid (polar tracking would give off-grid corners);
  // circles and 2-point modes snap the size (radius / diameter) to the step along the finger's direction
  const t = tool(), rectLike = t === 'rect' && !(mode('rect') === '3pt' && st.start && !st.p2);
  const sizing = from && t === 'circle' && mode('circle') !== '3pt';
  let r = SK.snapPoint(s, raw, { pxTol: sizing ? 8 : 20, wpp, from, refPts: refPts(s), exclude, osnap: S.settings.osnap !== false, polar: !rectLike && S.settings.polar !== false, ortho: !!S.settings.ortho });
  if (from && t === 'circle' && mode('circle') !== '3pt' && S.settings.snap && (r.kind === 'Grid' || /°$/.test(r.kind))) {
    const dx = raw[0] - from[0], dy = raw[1] - from[1], L = Math.hypot(dx, dy), stp = S.settings.snapStep * (mode('circle') === '2pt' ? 1 : 1);
    if (L > 1e-9) { const l = Math.max(stp, Math.round(L / stp) * stp); r = { p: [from[0] + dx / L * l, from[1] + dy / L * l], kind: 'Size' }; }
  }
  st.snap = r; st.preview = r.p;
  return r;
}
const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

// ---------- entity creation ----------
function add(label, ent, post) {
  let made = null;
  editSketch(label, s => { made = F.addEntity(s, JSON.parse(JSON.stringify(ent))); if (post) post(s, made); });
  if (made) emit('sketchgrew', made); // (a typed circle bigger than the view: the app frames the sketch again)
  return made;
}
const autoHV = (s, e) => {
  s.cons = s.cons || [];
  if (Math.abs(e.a[1] - e.b[1]) < 1e-12) s.cons.push({ id: ++s.nextEnt, t: 'h', a: e.id });
  else if (Math.abs(e.a[0] - e.b[0]) < 1e-12) s.cons.push({ id: ++s.nextEnt, t: 'v', a: e.id });
};
function placeLine(a, b) {
  if (SK.d2(a, b) < 1e-9) return;
  if (st.arcMode) return placeTangentArc(a, b);
  const L = SK.d2(a, b); st.lastDir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  add(lineOpts.construction ? 'Construction line' : 'Line', { t: 'line', a, b, ...(lineOpts.construction ? { construction: true } : {}) }, autoHV);
  if (!st.chain.length) st.chain.push(a);
  st.chain.push(b);
  // closed the loop?
  if (st.chain.length > 2 && SK.d2(b, st.chain[0]) < 1e-9) { st.start = null; st.chain = []; }
  else st.start = b;
  st.typed = {};
}
function placeRect(a, b) {
  const w = Math.abs(b[0] - a[0]), hh = Math.abs(b[1] - a[1]);
  if (w < 1e-9 || hh < 1e-9) { toast('Rectangle needs width and height'); return; }
  add('Rectangle', { t: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h: hh });
  st.start = null; st.typed = {};
}
// rectangle from a side (a→b, any angle) and a signed height: 4 lines
function placeRect3(a, b, hgt) {
  const L = SK.d2(a, b);
  if (L < 1e-9 || Math.abs(hgt) < 1e-9) { toast('Rectangle needs a side and a height'); return; }
  const n = [-(b[1] - a[1]) / L * hgt, (b[0] - a[0]) / L * hgt];
  const P = [a, b, [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]];
  if (Math.abs(n[0]) < 1e-12 || Math.abs(n[1]) < 1e-12) { placeRect(a, P[2]); return; } // axis aligned: a real rectangle entity
  // four lines held as a rectangle (opposite sides parallel, a right angle), so editing one side keeps the shape
  editSketch('Rectangle', s => {
    const L4 = P.map((q, i) => F.addEntity(s, { t: 'line', a: q.slice(), b: P[(i + 1) % 4].slice() }).id);
    s.cons = s.cons || [];
    for (const [t, a, b] of [['par', L4[0], L4[2]], ['par', L4[1], L4[3]], ['perp', L4[0], L4[1]]]) s.cons.push({ id: ++s.nextEnt, t, a, b });
  });
  st.start = null; st.p2 = null; st.typed = {};
}
const rectHeight = (a, b, p) => { const L = SK.d2(a, b); return L < 1e-12 ? 0 : ((p[0] - a[0]) * -(b[1] - a[1]) + (p[1] - a[1]) * (b[0] - a[0])) / L; };
// circle through three points (null if collinear)
export function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const s = q => q[0] * q[0] + q[1] * q[1];
  const cx = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d, cy = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d;
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
}
// arc from start to end passing through a third point
function arc3(a, b, m) {
  const C = circle3(a, b, m); if (!C) return null;
  const A = ang(C.c, a), B = ang(C.c, b), Mm = ang(C.c, m), T = 2 * Math.PI, ccw = (x, y) => ((y - x) % T + T) % T;
  return ccw(A, Mm) < ccw(A, B) ? { c: C.c, r: C.r, a0: A, sw: ccw(A, B) } : { c: C.c, r: C.r, a0: B, sw: ccw(B, A) };
}
function placeCircle(c, r) {
  if (!(r > 1e-9)) return;
  add('Circle', { t: 'circle', c, r }); st.start = null; st.typed = {};
}
function placeArc(c, r, a0, swDeg) {
  if (!(r > 1e-9) || Math.abs(swDeg) < 1e-9) return;
  let s0 = a0, sw = swDeg * D;
  if (sw < 0) { s0 = a0 + sw; sw = -sw; }
  add('Arc', { t: 'arc', c, r, a0: s0, a1: s0 + Math.min(sw, 2 * Math.PI) });
  st.start = null; st.arc = null; st.stage = 0; st.typed = {};
}

// ---------- pointer handling (called from app) ----------
export function down(x, y) {
  tapXY = [x, y]; // (inquiry points on bodies need the screen position)
  const t = tool();
  if (studio() && DRAW_PRIMARY.has(t) && waitingFirstPoint()) { chooseTarget(x, y); st.pressed = true; }
  const s = sk(); if (!s) return false;
  if (t === 'select') return gripDown(x, y);
  if (t === 'trim' || t === 'dim' || t === 'corner' || t === 'extend' || t === 'project') return false; // handled as taps
  if (EDIT_TOOLS.has(t)) { ensureCmd(); if (!pointStage()) return false; }
  st.press = { x, y, moved: false };
  snapAt(x, y); st.press.p = st.preview;
  view.render(); emit('drawcard');
  return true;
}
export function move(x, y) {
  if (st.grip) return gripMove(x, y);
  if (!st.press) return;
  if (Math.hypot(x - st.press.x, y - st.press.y) > 6) st.press.moved = true;
  tapXY = [x, y];
  if (!st.start && !(tool() === 'arc' && st.arc) && st.press.moved && !st.pressAnchor) st.pressAnchor = st.press.p || st.preview; // drag-to-draw from press point
  snapAt(x, y, fromPt() || st.pressAnchor);
  view.render(); emit('drawcard');
}
export function hover(x, y) {
  if ((S.ed.workspace !== 'draw' && !studio()) || (['select', 'move', 'rotate', 'scale', 'measure', 'edge', 'trim', 'dim', 'corner', 'extend', 'project'].includes(tool()) && !curveCmd())) return;
  if (studio() && !DRAW_PRIMARY.has(tool()) && !EDIT_TOOLS.has(tool())) return;
  if (studio() && DRAW_PRIMARY.has(tool()) && waitingFirstPoint()) chooseTarget(x, y);
  if (!sk()) return;
  if (EDIT_TOOLS.has(tool()) && !pointStage()) return;
  snapAt(x, y, fromPt()); view.render(); emit('drawcard');
}
export function up() {
  if (st.grip) return gripUp(); // ('tap': the press never dragged)
  if (!st.press) return;
  const p = st.preview, anchor = st.pressAnchor;
  st.press = null; st.pressAnchor = null;
  if (!p) return;
  commitPoint(p, anchor);
  if (!st.start && !st.p2) { st.snap = null; view.render(); }
}
// A point from a tap, a drag release, or typed in the command line.
export function commitPoint(p, anchor = null) {
  const t = tool();
  typedTarget();
  st.last = p.slice();
  if (EDIT_TOOLS.has(t)) { cmdPoint(p); view.render(); emit('drawcard'); return; }
  if (t === 'line') {
    if (!st.start && anchor) { st.start = anchor; placeLine(anchor, p); }
    else if (!st.start) { st.start = p; }
    else placeLine(st.start, p);
  } else if (t === 'rect') {
    const m = mode('rect');
    if (m === '3pt') {
      if (!st.start && anchor) { st.start = anchor; st.p2 = p; }
      else if (!st.start) st.start = p;
      else if (!st.p2) { if (SK.d2(st.start, p) > 1e-9) st.p2 = p; }
      else placeRect3(st.start, st.p2, rectHeight(st.start, st.p2, p));
    } else {
      const a = !st.start && anchor ? anchor : st.start;
      if (!a) st.start = p;
      else if (m === 'center') placeRect([2 * a[0] - p[0], 2 * a[1] - p[1]], p);
      else placeRect(a, p);
    }
  } else if (t === 'circle') {
    const m = mode('circle');
    if (m === '3pt') {
      if (!st.start && anchor) { st.start = anchor; st.p2 = p; }
      else if (!st.start) st.start = p;
      else if (!st.p2) { if (SK.d2(st.start, p) > 1e-9) st.p2 = p; }
      else { const C = circle3(st.start, st.p2, p); if (!C) toast('The three points are in a line'); else { placeCircle(C.c, C.r); st.p2 = null; } }
    } else {
      const a = !st.start && anchor ? anchor : st.start;
      if (!a) st.start = p;
      else if (m === '2pt') placeCircle([(a[0] + p[0]) / 2, (a[1] + p[1]) / 2], SK.d2(a, p) / 2);
      else placeCircle(a, SK.d2(a, p));
    }
  } else if (t === 'arc' && mode('arc') === '3pt') {
    if (!st.start && anchor) { st.start = anchor; st.p2 = p; }
    else if (!st.start) st.start = p;
    else if (!st.p2) { if (SK.d2(st.start, p) > 1e-9) st.p2 = p; }
    else { const A = arc3(st.start, st.p2, p); if (!A) toast('The three points are in a line'); else { placeArc(A.c, A.r, A.a0, A.sw / D); st.start = null; st.p2 = null; } }
  } else if (t === 'arc') {
    if (!st.arc) { st.arc = { c: anchor || p }; if (anchor) { st.arc.r = SK.d2(anchor, p); st.arc.a0 = ang(anchor, p); } }
    else if (st.arc.r == null) { st.arc.r = SK.d2(st.arc.c, p); st.arc.a0 = ang(st.arc.c, p); if (st.arc.r < 1e-9) st.arc.r = null; }
    else { let sw = (ang(st.arc.c, p) - st.arc.a0) / D; sw = ((sw % 360) + 360) % 360; if (sw < 1e-9) sw = 360; placeArc(st.arc.c, st.arc.r, st.arc.a0, sw); }
  }
  view.render(); emit('drawcard');
}
export function cancelPress() { st.press = null; st.pressAnchor = null; if (st.grip) { cancelOp(); st.grip = null; } view.render(); }

// ---------- select tool: grips ----------
function gripDown(x, y) {
  if (studio() && S.ed.editingSketch == null) return false; // curves are changed inside their sketch (Edit sketch)
  const s = sk();
  // while a sketch is being edited every point can be dragged directly; otherwise only the selection's
  const ids = S.ed.drawSel.size || S.ed.editingSketch == null ? [...S.ed.drawSel] : s.ents.filter(e => e.t !== 'dim').map(e => e.id);
  for (const id of ids) {
    const e = SK.entById(s, id); if (!e || e.proj) continue; // (projected geometry is reference: it stays put)
    for (const kp of SK.keyPoints(e)) {
      if (!kp.m) continue;
      const q = view.project(SK.toW(s.plane, kp.p));
      if (Math.hypot(q.x - x, q.y - y) < 22) {
        const ref = { e: e.id, k: kp.k }, orig = kp.p.slice(), skId = s.id;
        const [AU, AV] = axisNames(s.plane); // (on an XZ sketch the point's coordinates are X and Z)
        const def = F.sketchOp('Move point', skId, (sk2, p) => { SK.movePoint(sk2, ref, [p.x, p.y]); }, [{ key: 'x', label: AU, kind: 'len' }, { key: 'y', label: AV, kind: 'len' }]);
        if (!runOp(def, { x: orig[0], y: orig[1] }, { interactive: true })) return false;
        // snap against the sketch as it was, without the entity being dragged (its own moving points would fight the finger)
        st.grip = { orig, x0: x, y0: y, moved: false, still: { ...s, ents: s.ents.filter(q => q.id !== e.id).map(q => JSON.parse(JSON.stringify(q))) } };
        return true;
      }
    }
  }
  return false;
}
function gripMove(x, y) {
  if (!st.grip.moved && Math.hypot(x - st.grip.x0, y - st.grip.y0) < 6) return; // (not a drag yet)
  st.grip.moved = true;
  const s = sk(), raw = planePt(x, y), wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  const r = SK.snapPoint(st.grip.still, raw, { pxTol: 20, wpp, from: null, refPts: [], exclude: st.grip.orig, osnap: S.settings.osnap !== false, polar: false, ortho: false });
  st.snap = r; st.preview = r.p;
  updateOp({ x: r.p[0], y: r.p[1] });
  view.render();
}
// a press on a point that never dragged is a tap (it picks the curve or label there): no "Move point" step
function gripUp() {
  const moved = st.grip?.moved;
  if (moved) commit(); else cancelOp();
  st.grip = null; st.preview = null; st.snap = null; view.render(); emit('drawcard');
  return moved ? undefined : 'tap';
}

// ---------- taps (select / trim / dim) ----------
// tapping a dimension label edits it; tapping a constraint glyph removes it
// a constraint glyph needs two taps to go: the first names it, the second (within 3 s) removes it
let armed = null;
// a constraint glyph is picked like anything else: it lights up with the curves it ties, and Delete removes it
let consSel = null; // { sk, cid, t }
const CONS_NAMES = { h: 'Horizontal', v: 'Vertical', par: 'Parallel', perp: 'Perpendicular', eq: 'Equal', tan: 'Tangent', conc: 'Concentric', fix: 'Fix', mid: 'Midpoint', on: 'Point on curve' };
export const consSelected = () => consSel;
export const consName = t => CONS_NAMES[t] || 'Constraint';
export function clearConsSel() { if (consSel) { consSel = null; renderKey = ''; } }
// the constraints and dimensions on these curves (the open sketch): a list with a Delete on each
const DIM_NAMES = { lin: 'Distance', hor: 'Horizontal distance', ver: 'Vertical distance', pl: 'Distance to line', ang: 'Angle', dia: 'Diameter', rad: 'Radius' };
export function consOn(ids) {
  const s = sk(); if (!s || s.pending) return [];
  const set = new Set(ids), out = [];
  for (const c of s.cons || []) if (set.has(c.a) || (c.b != null && set.has(c.b)) || (c.p && set.has(c.p.e))) out.push({ type: 'cons', id: c.id, name: consName(c.t), tag: SK.CONS_LABEL[c.t] });
  for (const d of s.ents) if (d.t === 'dim' && SK.dimEnts(d).some(id => set.has(id))) out.push({ type: 'dim', id: d.id, name: (d.value == null ? 'Driven ' + (DIM_NAMES[d.kind] || 'dimension').toLowerCase() : DIM_NAMES[d.kind] || 'Dimension'), tag: dimText(s, d) || '' });
  return out;
}
export function removeCons(list) {
  const s = sk(); if (!s || !list.length) return;
  const cids = new Set(list.filter(q => q.type === 'cons').map(q => q.id)), dids = new Set(list.filter(q => q.type === 'dim').map(q => q.id));
  runOp(F.sketchOp(list.length > 1 ? 'Remove constraints' : list[0].type === 'dim' ? 'Delete dimension' : 'Remove constraint', s.id, k => { k.cons = (k.cons || []).filter(c => !cids.has(c.id)); k.ents = k.ents.filter(e => !dids.has(e.id)); }));
  if (consSel && cids.has(consSel.cid)) consSel = null;
  if (dimSel && dids.has(dimSel.id)) dimSel = null;
  toast(`${list.length === 1 ? list[0].name : list.length + ' constraints'} removed · ${dofText()}`);
}
export function deleteConsSel() {
  if (!consSel) return;
  const { sk: id, cid, t } = consSel; consSel = null; S.ed.drawSel = new Set();
  runOp(F.sketchOp('Remove constraint', id, k => { k.cons = (k.cons || []).filter(c => c.id !== cid); }));
  toast(`${consName(t)} constraint removed · ${dofText()}`);
}
// the glyph under a tap — but a tap right on a curve stays with the curve unless it is right on the glyph too (glyphs
// are pushed aside to clear dimensions, sometimes back toward their curve)
function glyphAt(x, y) {
  const G = (st.consLabels || []).map(g => ({ g, d: Math.hypot(g.x - x, g.y - y) })).filter(q => q.d < GLYPH_R).sort((a, b) => a.d - b.d)[0];
  if (!G) return null;
  if (G.d > 9) { const s = sk(); if (s && !s.pending) { const raw = planePt(x, y, s); if (SK.pickEntity(s, raw, 6 * view.worldPerPixel(SK.toW(s.plane, raw)))) return null; } }
  return G.g;
}
function glyphTap(s, x, y) {
  const G = glyphAt(x, y);
  if (!G) return false;
  consSel = { sk: s.id, cid: G.c.id, t: G.c.t };
  S.ed.sketch = s.id; S.ed.drawSel = new Set([G.c.a, G.c.b].filter(v => v != null && SK.entById(s, v)));
  emit('selection');
  return true;
}
export const entName = e => entTitle(e);
// a press on a dimension label or a constraint glyph is a tap on it, held or not (no precision cursor there)
// (not while a shape is being drawn: its next point may well be under one)
export const labelHit = (x, y) => waitingFirstPoint() && (!!dimLabelAt(x, y) || !!glyphAt(x, y));
const GLYPH_R = 15; // (a glyph chip is 21 px across)
// the dimension label nearest a tap (within 28 px), or null — a glyph nearer than it wins
// (its chip, a few px around it: a round 28 px zone took taps meant for a curve beside a dimension)
const dimLabelAt = (x, y) => { const L = (st.dimLabels || []).filter(L => Math.abs(L.x - x) <= (L.w || 70) / 2 + 6 && Math.abs(L.y - y) <= (L.h || 24) / 2 + 6).map(L => ({ L, d: Math.hypot(L.x - x, L.y - y) })).sort((a, b) => a.d - b.d)[0]; if (!L) return null;
  const G = (st.consLabels || []).some(g => Math.hypot(g.x - x, g.y - y) < Math.min(GLYPH_R, L.d)); return G ? null : L.L; };
export function tapLabel(x, y, glyphs = true) {
  const s = sk(); if (!s || s.pending) return false;
  const L = dimLabelAt(x, y); if (L) { editDim(L.dim); return true; }
  return glyphs && glyphTap(s, x, y);
}
// the app supplies a picker for round edges of exact solids (Inquiry → Radius on a hole rim)
let solidCircleAt = null, tapXY = null;
export function setSolidCirclePicker(fn) { solidCircleAt = fn; }
// and a 3D point on a body under the finger (snapped to its exact vertices / edge midpoints / centres)
let solidPointAt = null;
export function setSolidPointPicker(fn) { solidPointAt = fn; }
export function tap(x, y) {
  tapXY = [x, y];
  const s = sk(); if (!s) return;
  const t = tool();
  const raw = planePt(x, y);
  const wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  if (t === 'select') {
    // dimension labels, then constraint glyphs
    const L = dimLabelAt(x, y); if (L) { editDim(L.dim); return; }
    dimSel = null;
    if (glyphTap(s, x, y)) return;
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (e) { if (S.ed.multi) { S.ed.drawSel.has(e.id) ? S.ed.drawSel.delete(e.id) : S.ed.drawSel.add(e.id); } else S.ed.drawSel = new Set([e.id]); }
    else if (!S.ed.multi) S.ed.drawSel = new Set();
    emit('selection');
  } else if (EDIT_TOOLS.has(t)) {
    cmdTap(s, raw, wpp);
  } else if (t === 'extend') {
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (!e) { toast('Tap a line near the end to extend'); return; }
    const eid = e.id;
    runOp(F.sketchOp('Extend', s.id, sk2 => { const ee = SK.entById(sk2, eid); const r = SK.extendLine(sk2, ee, raw); return r === true ? undefined : r; }));
  } else if (t === 'trim') {
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (!e) { toast('Tap the piece of a line, arc or circle to remove'); return; }
    const skId = s.id, eid = e.id;
    runOp(F.sketchOp('Trim', skId, sk2 => { const ee = SK.entById(sk2, eid); if (!ee) return 'Gone'; SK.trimAt(sk2, ee, raw); SK.pruneCons(sk2); }));
  } else if (t === 'corner') {
    const size = corner.size ?? defSize() / 10, kind = corner.kind, skId = s.id;
    runOp(F.sketchOp(kind === 'fillet' ? 'Sketch fillet' : 'Sketch chamfer', skId, sk2 => { const r = SK.cornerOp(sk2, raw, 18 * wpp, size, kind); if (typeof r === 'string') return r; SK.pruneCons(sk2); }));
  } else if (t === 'dim') {
    // (with nothing picked yet, a tap on a dimension's value edits it and a glyph picks its constraint)
    if (!st.dimPend) { const L = dimLabelAt(x, y); if (L) { editDim(L.dim); return; } if (glyphTap(s, x, y)) return; }
    dimTap(s, raw, wpp);
  }
  view.render(); emit('drawcard');
}
// ---------- dimensions (Fusion-style) ----------
// Sketch Dimension: tap what to measure — a line (its length), a circle or arc (Ø / R), a rectangle's side, or a
// point — then: another line → the angle between them · a point → point to point (or point to line) · anywhere else
// → the dimension goes there. For two points, where it goes decides its kind: above or below them → horizontal, to
// their left or right → vertical, off to a side → aligned. Then the value is typed (Done keeps it as measured). A
// size the sketch already fixes is added driven: in brackets, it shows the size and does not set it.
// Each dimension is drawn on screen every frame (lines and arrows keep their size at any zoom): extension lines out
// to a dimension line with arrows and the value on it; Ø and R as leaders; an angle as an arc. d.at (sketch
// coordinates) is where its value sits: where it was placed, or dragged to.
let dimSel = null; // { sk, id }: the dimension picked
export const dimSelected = () => { if (!dimSel) return null; const s = SK.sketchById(dimSel.sk), d = s && SK.entById(s, dimSel.id); return d ? { ...dimSel, d, driven: d.value == null } : null; };
export function clearDimSel() { if (dimSel) { dimSel = null; view.render(); emit('selection'); } }
const v2 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1]], add: (a, b) => [a[0] + b[0], a[1] + b[1]], mul: (a, k) => [a[0] * k, a[1] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1], len: a => Math.hypot(a[0], a[1]) };
const unit2 = a => { const L = v2.len(a); return L > 1e-12 ? [a[0] / L, a[1] / L] : null; };
const dimText = (s, d) => {
  const v = SK.dimValue(s, d); if (v == null) return null;
  const t = d.kind === 'ang' ? fmtAng(v) : (d.kind === 'dia' ? 'Ø' : d.kind === 'rad' ? 'R' : '') + fmtLen(v, false);
  return d.value == null ? `(${t})` : t;
};
// the two lines' crossing (sketch coordinates), or null when they are parallel
function crossing(a, b) {
  const r = v2.sub(a.b, a.a), q = v2.sub(b.b, b.a), den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12 * v2.len(r) * v2.len(q)) return null;
  const t = ((b.a[0] - a.a[0]) * q[1] - (b.a[1] - a.a[1]) * q[0]) / den;
  return v2.add(a.a, v2.mul(r, t));
}
// what a linear dimension measures between: its two points (a point to line: the point and its foot on the line)
function dimEnds(s, d) {
  if (d.kind === 'pl') {
    const P = SK.refPoint(s, d.P), l = SK.entById(s, d.l); if (!P || !l || l.t !== 'line') return null;
    const u = unit2(v2.sub(l.b, l.a)); if (!u) return null;
    return [P, v2.add(l.a, v2.mul(u, v2.dot(v2.sub(P, l.a), u)))];
  }
  const A = SK.refPoint(s, d.A), B = SK.refPoint(s, d.B); return A && B ? [A, B] : null;
}
// where a dimension's value goes when it has not been placed (made before placing, or by the API): a little way out
// from what it measures, away from the middle of the sketch
function defaultAt(s, d) {
  const P = s.ents.filter(e => e.t !== 'dim').flatMap(e => SK.keyPoints(e).map(k => k.p));
  const lo = [Math.min(...P.map(q => q[0])), Math.min(...P.map(q => q[1]))], hi = [Math.max(...P.map(q => q[0])), Math.max(...P.map(q => q[1]))];
  const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], span = Math.max(1e-6, hi[0] - lo[0], hi[1] - lo[1]);
  if (['lin', 'hor', 'ver', 'pl'].includes(d.kind)) {
    const E = dimEnds(s, d); if (!E) return null;
    const u = d.kind === 'hor' ? [1, 0] : d.kind === 'ver' ? [0, 1] : unit2(v2.sub(E[1], E[0])) || [1, 0], n = [-u[1], u[0]];
    const m = v2.mul(v2.add(E[0], E[1]), 0.5), side = v2.dot(v2.sub(m, mid), n) >= 0 ? 1 : -1;
    // (for H / V the dimension line clears both points)
    const far = side > 0 ? Math.max(v2.dot(E[0], n), v2.dot(E[1], n)) : Math.min(v2.dot(E[0], n), v2.dot(E[1], n));
    return v2.add(v2.add(m, v2.mul(n, far - v2.dot(m, n))), v2.mul(n, side * span * 0.12));
  }
  if (d.kind === 'ang') {
    const a = SK.entById(s, d.la), b = SK.entById(s, d.lb); if (!a || !b) return null;
    const X = crossing(a, b); if (!X) return v2.mul(v2.add(v2.add(a.a, a.b), v2.add(b.a, b.b)), 0.25);
    const ua = unit2(v2.sub(a.b, a.a)), ub = unit2(v2.sub(b.b, b.a)), bis = unit2(v2.add(ua, ub)) || [-ua[1], ua[0]];
    return v2.add(X, v2.mul(bis, Math.max(span * 0.12, Math.min(v2.len(v2.sub(a.b, a.a)), v2.len(v2.sub(b.b, b.a))) * 0.45)));
  }
  const e = SK.entById(s, d.e); if (!e || !e.c) return null;
  const dir = e.t === 'arc' ? e.a0 + SK.sweep(e) / 2 : Math.PI / 4;
  return [e.c[0] + Math.cos(dir) * (e.r + span * 0.12), e.c[1] + Math.sin(dir) * (e.r + span * 0.12)];
}
// the dimension on screen: { lines, arrows, text, tx, ty } (screen pixels) — or null
function dimLayout(s, d) {
  const text = dimText(s, d); if (text == null) return null;
  const at = SK.dimAt(s, d) || defaultAt(s, d); if (!at) return null;
  const W = p => view.project(SK.toW(s.plane, p)), lines = [], arrows = [];
  const arrow = (tip, from) => { // a filled arrowhead at tip, pointing away from from (screen points)
    const dx = tip.x - from.x, dy = tip.y - from.y, L = Math.hypot(dx, dy); if (L < 1e-6) return;
    const ux = dx / L, uy = dy / L, a = 8, w = 3;
    arrows.push([[tip.x, tip.y], [tip.x - ux * a - uy * w, tip.y - uy * a + ux * w], [tip.x - ux * a + uy * w, tip.y - uy * a - ux * w]]);
  };
  // a line from p to q (screen), starting gap px after p and running over px past q
  const seg = (p, q, gap = 0, over = 0) => { const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy); if (L < 0.5) return; const ux = dx / L, uy = dy / L; lines.push([[p.x + ux * gap, p.y + uy * gap], [q.x + ux * over, q.y + uy * over]]); };
  let T;
  if (['lin', 'hor', 'ver', 'pl'].includes(d.kind)) {
    const E = dimEnds(s, d); if (!E) return null;
    const [A, B] = E, u = d.kind === 'hor' ? [1, 0] : d.kind === 'ver' ? [0, 1] : unit2(v2.sub(B, A)) || [1, 0], n = [-u[1], u[0]];
    const c = v2.dot(at, n), A2 = v2.add(A, v2.mul(n, c - v2.dot(A, n))), B2 = v2.add(B, v2.mul(n, c - v2.dot(B, n)));
    const tp = v2.add(A2, v2.mul(u, v2.dot(v2.sub(at, A2), u))); // (the value sits on the dimension line, under where it was put)
    const a = W(A), b = W(B), a2 = W(A2), b2 = W(B2); T = W(tp);
    if (!a.front || !b.front || !a2.front || !b2.front || !T.front) return null;
    seg(a, a2, 4, 6); seg(b, b2, 4, 6);
    seg(a2, b2); arrow(a2, b2); arrow(b2, a2);
    // (a value put beyond the arrows: the dimension line runs on out to it)
    const sa = v2.dot(A2, u), sb = v2.dot(B2, u), st0 = v2.dot(tp, u);
    if (st0 < Math.min(sa, sb) || st0 > Math.max(sa, sb)) seg(Math.abs(st0 - sa) < Math.abs(st0 - sb) ? a2 : b2, T);
  } else if (d.kind === 'dia' || d.kind === 'rad') {
    const e = SK.entById(s, d.e); if (!e || !e.c) return null;
    const dir = unit2(v2.sub(at, e.c)) || [Math.SQRT1_2, Math.SQRT1_2];
    const P = v2.add(e.c, v2.mul(dir, e.r)), Q = d.kind === 'dia' ? v2.add(e.c, v2.mul(dir, -e.r)) : e.c;
    const p = W(P), q = W(Q), cc = W(e.c); T = W(at);
    if (!p.front || !q.front || !T.front) return null;
    seg(q, T); arrow(p, cc); if (d.kind === 'dia') arrow(q, cc);
  } else if (d.kind === 'ang') {
    const a = SK.entById(s, d.la), b = SK.entById(s, d.lb); if (!a || !b) return null;
    const X = crossing(a, b); T = W(at); if (!T.front) return null;
    if (X) {
      const ua = unit2(v2.sub(a.b, a.a)), ub = unit2(v2.sub(b.b, b.a)), r = Math.max(1e-9, v2.len(v2.sub(at, X)));
      // the arc between the two lines' directions, on the side its value was put (the opposite pair of rays has the
      // same angle)
      const w = unit2(v2.sub(at, X)) || ua, sgn = v2.dot(v2.add(ua, ub), w) >= 0 ? 1 : -1, r1 = v2.mul(ua, sgn), r2 = v2.mul(ub, sgn);
      const a1 = Math.atan2(r1[1], r1[0]); let sw = Math.atan2(r2[1], r2[0]) - a1; sw = Math.atan2(Math.sin(sw), Math.cos(sw));
      const N = 24, pts = []; for (let i = 0; i <= N; i++) { const t = a1 + sw * i / N; pts.push(W(v2.add(X, [Math.cos(t) * r, Math.sin(t) * r]))); }
      if (pts.some(q => !q.front)) return null;
      lines.push(pts.map(q => [q.x, q.y])); arrow(pts[0], pts[1]); arrow(pts[N], pts[N - 1]);
      // extension lines when a line stops short of the arc
      for (const [L, ray] of [[a, r1], [b, r2]]) {
        const reach = Math.max(v2.dot(v2.sub(L.a, X), ray), v2.dot(v2.sub(L.b, X), ray));
        if (reach < r) seg(W(v2.add(X, v2.mul(ray, Math.max(0, reach)))), W(v2.add(X, v2.mul(ray, r))), 4, 6);
      }
    } else seg(W(v2.mul(v2.add(a.a, a.b), 0.5)), W(v2.mul(v2.add(b.a, b.b), 0.5)));
  } else return null;
  return { lines, arrows, text, tx: T.x, ty: T.y };
}
// the pending pick (dimension tool) as a dimension to show while it waits to be placed
function pendDim(s, P) {
  if (!P || P.kind === 'pt') return null;
  if (P.kind === 'pp') { const A = SK.refPoint(s, P.A), B = SK.refPoint(s, P.B); return A && B ? { t: 'dim', kind: 'lin', A: P.A, B: P.B, value: SK.d2(A, B) } : null; }
  return { t: 'dim', ...P, value: 1 };
}
// would this dimension fix something the sketch already fixes? (then it goes in driven)
function dimRedundant(s, d) {
  try {
    const k = JSON.parse(JSON.stringify(s)); k.ents.push({ ...JSON.parse(JSON.stringify(d)), id: -7 });
    return sketchDof(k) >= sketchDof(s);
  } catch (e) { return false; }
}
function dimPend(P, hint) { st.dimPend = P; if (hint) toast(hint, 1600); view.render(); emit('drawcard'); }
function dimTap(s, raw, wpp) {
  const r = SK.snapPoint(s, raw, { pxTol: 14, wpp, refPts: [] });
  // (the origin can be measured from: a sketch can be fully dimensioned without Fix)
  let pt = r.ref && r.kind !== 'Mid' && SK.refPoint(s, r.ref) ? r.ref : r.kind === 'Origin' ? { e: 0, k: 'o' } : null;
  const e = SK.pickEntity(s, raw, 12 * wpp), P = st.dimPend;
  // (a short line zoomed out: its ends' snap zones met in the middle and the line itself could not be picked — the
  // middle third of a line picks the line)
  if (pt && e && e.t === 'line' && pt.e === e.id && (pt.k === 'a' || pt.k === 'b') && SK.d2(raw, SK.refPoint(s, pt)) > SK.d2(e.a, e.b) / 3) pt = null;
  // (a circle or arc when the tap is nearer its rim than its centre: on a small one the centre's snap would win)
  const round = e && (e.t === 'circle' || e.t === 'arc') && Math.abs(SK.d2(raw, e.c) - e.r) < SK.d2(raw, e.c) ? e : null;
  if (!P) {
    if (round) return dimPend({ kind: round.t === 'circle' ? 'dia' : 'rad', e: round.id });
    if (e && e.t === 'rect' && SK.rectCorners(e).every(c => SK.d2(c, raw) > 14 * wpp)) {
      const cs = SK.rectCorners(e), segD = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / L2)); return Math.hypot(a[0] + dx * t - raw[0], a[1] + dy * t - raw[1]); };
      let best = 0; for (let i = 1; i < 4; i++) if (segD(cs[i], cs[(i + 1) % 4]) < segD(cs[best], cs[(best + 1) % 4])) best = i;
      const [ka, kb] = [['p0', 'p1'], ['p1', 'p2'], ['p3', 'p2'], ['p0', 'p3']][best];
      return dimPend({ kind: best % 2 === 0 ? 'hor' : 'ver', A: { e: e.id, k: ka }, B: { e: e.id, k: kb }, rect: e.id, at: raw.slice() }, 'Tap where it goes · a point → its distance to this side');
    }
    if (pt && !(e && e.t === 'line' && !['a', 'b'].includes(pt.k) && pt.e === e.id)) return dimPend({ kind: 'pt', A: pt }, 'Now a second point, or a line');
    if (e && e.t === 'line') return dimPend({ kind: 'lin', A: { e: e.id, k: 'a' }, B: { e: e.id, k: 'b' }, line: e.id });
    toast('Tap a line, a circle or arc, or a point'); return;
  }
  // a second pick changes what is measured
  if (P.kind === 'pt') {
    if (pt && !(pt.e === P.A.e && pt.k === P.A.k)) return dimPend({ kind: 'pp', A: P.A, B: pt });
    if (e && e.t === 'line' && e.id !== P.A.e) { const Pp = SK.refPoint(s, P.A); if (Pp && Math.abs(SK.lineSide(e, Pp)) > 1e-9) return dimPend({ kind: 'pl', P: P.A, l: e.id }); }
    // a rectangle's side: the rectangle becomes four square lines (a rectangle is one shape, with no line to measure to)
    if (e && e.t === 'rect') {
      const A0 = { ...P.A }, rid = e.id, got = rectToLinesAt(rid, raw);
      if (got) { const k2 = sk(), A1 = A0.e === rid && /^p\d$/.test(A0.k) ? { e: got.ids[+A0.k[1]], k: 'a' } : A0, Pp = SK.refPoint(k2, A1), l = SK.entById(k2, got.side);
        if (Pp && l && Math.abs(SK.lineSide(l, Pp)) > 1e-9) return dimPend({ kind: 'pl', P: A1, l: got.side }); }
    }
    toast('Tap a second point, or a line'); return;
  }
  // a rectangle's side, then a point (not one of its own corners): the point's distance to that side — the
  // rectangle becomes four square lines to measure to
  if (P.rect != null && pt && pt.e !== P.rect) {
    const got = rectToLinesAt(P.rect, P.at);
    if (got) { const k2 = sk(), Pp = SK.refPoint(k2, pt), l = SK.entById(k2, got.side); if (Pp && l && Math.abs(SK.lineSide(l, Pp)) > 1e-9) return dimPend({ kind: 'pl', P: pt, l: got.side }); }
  }
  if (P.line != null && !round) {
    if (e && e.t === 'line' && e.id !== P.line && !pt) {
      const a = SK.entById(s, P.line);
      if (a && crossing(a, e)) return dimPend({ kind: 'ang', la: P.line, lb: e.id });
      // parallel lines: the distance between them
      if (a) return dimPend({ kind: 'pl', P: { e: e.id, k: 'a' }, l: P.line });
    }
    if (pt && pt.e !== P.line) { const a = SK.entById(s, P.line), Pp = SK.refPoint(s, pt); if (a && Pp && Math.abs(SK.lineSide(a, Pp)) > 1e-9) return dimPend({ kind: 'pl', P: pt, l: P.line }); }
  }
  placeDim(s, P, raw);
}
// put the pending dimension where the finger is, then type its value
function placeDim(s, P, at) {
  let d;
  if (P.kind === 'pp') {
    const A = SK.refPoint(s, P.A), B = SK.refPoint(s, P.B); if (!A || !B) { st.dimPend = null; return; }
    const m = Math.max(Math.abs(B[0] - A[0]), Math.abs(B[1] - A[1])) * 0.04;
    const inX = at[0] > Math.min(A[0], B[0]) - m && at[0] < Math.max(A[0], B[0]) + m, inY = at[1] > Math.min(A[1], B[1]) - m && at[1] < Math.max(A[1], B[1]) + m;
    let kind = inX && !inY ? 'hor' : inY && !inX ? 'ver' : 'lin';
    if ((kind === 'hor' && Math.abs(B[0] - A[0]) < 1e-9) || (kind === 'ver' && Math.abs(B[1] - A[1]) < 1e-9)) kind = 'lin';
    d = { t: 'dim', kind, A: P.A, B: P.B, value: kind === 'hor' ? B[0] - A[0] : kind === 'ver' ? B[1] - A[1] : SK.d2(A, B) };
  } else if (P.kind === 'pl') {
    const Pp = SK.refPoint(s, P.P), l = SK.entById(s, P.l); if (!Pp || !l) { st.dimPend = null; return; }
    const sd = SK.lineSide(l, Pp); d = { t: 'dim', kind: 'pl', P: P.P, l: P.l, side: sd < 0 ? -1 : 1, value: Math.abs(sd) };
  } else if (P.kind === 'ang') d = { t: 'dim', kind: 'ang', la: P.la, lb: P.lb, value: SK.lineAngle(s, P) };
  else if (P.kind === 'hor' || P.kind === 'ver') { const A = SK.refPoint(s, P.A), B = SK.refPoint(s, P.B); d = { t: 'dim', kind: P.kind, A: P.A, B: P.B, value: P.kind === 'hor' ? B[0] - A[0] : B[1] - A[1] }; }
  else if (P.kind === 'lin') d = { t: 'dim', kind: 'lin', A: P.A, B: P.B, value: SK.d2(SK.refPoint(s, P.A), SK.refPoint(s, P.B)) };
  else { const e = SK.entById(s, P.e); if (!e) { st.dimPend = null; return; } d = { t: 'dim', kind: P.kind, e: P.e, value: P.kind === 'dia' ? 2 * e.r : e.r }; }
  st.dimPend = null;
  if (d.value == null || !isFinite(d.value) || (d.kind !== 'ang' && Math.abs(d.value) < 1e-9)) { toast('Nothing to measure there'); view.render(); emit('drawcard'); return; }
  SK.setDimAt(s, d, at); // (kept with what it measures: it travels with them)
  // (on projected geometry only: it follows the body, so the size is shown, never driven — a Ø150 rim went to Ø130)
  const proj = SK.dimEnts(d).every(id => SK.entById(s, id)?.proj);
  const driven = proj || dimRedundant(s, d); if (driven) d.value = null;
  const made = add('Dimension', d);
  if (!made) return;
  if (driven) { toast(`Driven dimension ${dimText(SK.sketchById(s.id) || s, made) || ''} — ${proj ? 'projected geometry follows the body' : 'the sketch already fixes this size'}`, 2600); return; }
  editDim(made);
}
function editDim(d) {
  const s = sk(), skId = s.id, did = d.id;
  const v = SK.dimValue(s, d);
  if (v == null) return;
  dimSel = { sk: skId, id: did }; emit('selection'); view.render();
  if (d.value == null) return; // (a driven one: picked — Driving and Delete are offered)
  const kind = d.kind === 'ang' ? 'ang' : 'len';
  openKeypad({ label: d.kind === 'dia' ? 'Diameter' : d.kind === 'rad' ? 'Radius' : d.kind === 'ang' ? 'Angle' : 'Distance', kind, value: v, min: 1e-9, max: d.kind === 'ang' ? 180 : null,
    extra: [{ label: 'Driven', onClick: () => { dimSel = { sk: skId, id: did }; toggleDrivenSel(); dimSel = null; } }, { label: 'Delete', cls: 'danger', onClick: () => deleteDim(skId, did) }],
    onClose: () => { if (dimSel && dimSel.id === did) { dimSel = null; view.render(); emit('selection'); } }, // (typed, or left: no longer picked)
    onCommit: nv => runOp(F.sketchOp('Set dimension', skId, (sk2, p) => SK.setDimValue(sk2, SK.entById(sk2, did), p.value), [{ key: 'value', label: 'Value', kind }]), { value: nv }) });
}
export function editDimSel() { const ds = dimSelected(); if (ds) editDim(ds.d); }
function deleteDim(skId, did) {
  if (dimSel && dimSel.id === did) dimSel = null;
  runOp(F.sketchOp('Delete dimension', skId, k => { k.ents = k.ents.filter(e => e.id !== did); }));
  toast(`Dimension removed · ${dofText()}`);
}
export function deleteDimSel() { const ds = dimSelected(); if (ds) deleteDim(ds.sk, ds.id); }
// driven ↔ driving (a driving one that the sketch already fixes would over-constrain it: refused)
export function toggleDrivenSel() {
  const ds = dimSelected(); if (!ds) return;
  const s = SK.sketchById(ds.sk), d = ds.d;
  if (d.value != null) { runOp(F.sketchOp('Driven dimension', ds.sk, k => { const dd = SK.entById(k, ds.id); if (dd) dd.value = null; })); toast('Driven: it shows the size, and no longer sets it'); return; }
  const E = d.kind === 'hor' || d.kind === 'ver' ? dimEnds(s, d) : null;
  const val = d.kind === 'ang' ? SK.lineAngle(s, d) : E ? (d.kind === 'hor' ? E[1][0] - E[0][0] : E[1][1] - E[0][1]) : SK.dimValue(s, d);
  if (SK.dimEnts(d).every(id => SK.entById(s, id)?.proj)) { toast('Projected geometry follows the body — this dimension can only show its size'); return; }
  if (dimRedundant(s, { ...d, value: val })) { toast('The sketch already fixes this size — as a driving dimension it would over-constrain it'); return; }
  runOp(F.sketchOp('Driving dimension', ds.sk, k => { const dd = SK.entById(k, ds.id); if (dd) dd.value = val; }));
  toast(`Driving: it sets the size · ${dofText()}`);
}
// a press that slides on a dimension's value moves it (the dimension line follows); one step on release
let dimDrag = null;
export function dimDragAt(phase, x, y) {
  if (phase === 'start') {
    const L = dimLabelAt(x, y); if (!L) return false;
    const s = sk(); if (!s || s.pending) return false;
    const at0 = L.dim.at ? { at: L.dim.at.slice(), ref: L.dim.atRef?.slice() } : null, cur = SK.dimAt(s, L.dim) || defaultAt(s, L.dim); if (!cur) return false;
    dimDrag = { sk: s.id, id: L.dim.id, at0, grab: v2.sub(planePt(x, y, s), cur) };
    dimSel = { sk: s.id, id: L.dim.id }; emit('selection');
    return true;
  }
  if (!dimDrag) return false;
  const s = SK.sketchById(dimDrag.sk), d = s && SK.entById(s, dimDrag.id);
  if (!d) { dimDrag = null; return false; }
  if (phase === 'move') { SK.setDimAt(s, d, v2.sub(planePt(x, y, s), dimDrag.grab)); view.render(); return true; }
  const at = d.at, k = dimDrag; if (k.at0) { d.at = k.at0.at; if (k.at0.ref) d.atRef = k.at0.ref; else delete d.atRef; } else { delete d.at; delete d.atRef; } dimDrag = null;
  if (phase === 'end' && at) runOp(F.sketchOp('Move dimension', k.sk, kk => { const dd = SK.entById(kk, k.id); if (dd) SK.setDimAt(kk, dd, at); }));
  view.render(); emit('selection');
  return true;
}

// ---------- constraints ----------
export function constrain(t) {
  const s = sk(); if (!s) return;
  const ents = [...S.ed.drawSel].map(id => SK.entById(s, id)).filter(Boolean);
  const lines = ents.filter(e => e.t === 'line'), curves = ents.filter(e => e.t === 'circle' || e.t === 'arc');
  let add = [];
  if (['h', 'v', 'par', 'perp', 'eq'].includes(t) && ents.some(e => e.t === 'rect') && lines.length < (t === 'h' || t === 'v' ? 1 : 2)) return toast(`A rectangle is one shape: use the ${CONS_NAMES[t]} tool in Constrain and tap the rectangle's side — it becomes four lines`, 3600);
  if (t === 'h' || t === 'v') { if (!lines.length) return toast('Select one or more lines'); add = lines.map(l => ({ t, a: l.id })); }
  else if (t === 'par' || t === 'perp') { if (lines.length !== 2) return toast('Select exactly 2 lines'); add = [{ t, a: lines[0].id, b: lines[1].id }]; }
  else if (t === 'eq') { const g = lines.length === 2 ? lines : curves.length === 2 ? curves : null; if (!g) return toast('Select 2 lines or 2 circles/arcs'); add = [{ t, a: g[0].id, b: g[1].id }]; }
  else if (t === 'tan') { const pair = lines.length === 1 && curves.length === 1 ? [lines[0], curves[0]] : curves.length === 2 ? curves : null; if (!pair) return toast('Select a line and a circle/arc, or 2 circles/arcs'); add = [{ t, a: pair[0].id, b: pair[1].id }]; }
  else if (t === 'conc') { if (curves.length !== 2) return toast('Select 2 circles/arcs'); add = [{ t, a: curves[0].id, b: curves[1].id }]; }
  else if (t === 'fix') { if (!ents.length) return toast('Select entities to fix'); add = ents.filter(e => e.t !== 'dim').map(e => ({ t, a: e.id, v: fixValuesOf(e) })); }
  commitCons(t, add);
}
function commitCons(t, ids, opts = {}) {
  const s = sk(); if (!s) return false;
  // (a constraint the others contradict — Vertical on a Horizontal line, Parallel across a right angle — is met by
  // shrinking a curve to nothing: the solver calls that solved. Refused, and the sketch is left as it was)
  const size = k => new Map(k.ents.filter(e => e.t !== 'dim').map(e => [e.id, e.t === 'line' ? SK.d2(e.a, e.b) : e.r != null ? e.r : e.t === 'rect' ? Math.min(Math.abs(e.w), Math.abs(e.h)) : 1]));
  const ok = runOp(F.sketchOp(`Constrain ${SK.CONS_LABEL[t]}`, s.id, k => {
    const before = size(k);
    const err = editAndSolve(k, kk => { kk.cons = kk.cons || []; for (const c of ids) kk.cons.push({ id: ++kk.nextEnt, ...c }); }, opts);
    if (err) return err;
    for (const [id, v] of size(k)) { const v0 = before.get(id); if (v0 > 1e-6 && v < Math.max(1e-6, v0 * 1e-4)) return `${CONS_NAMES[t] || 'This constraint'} contradicts the sketch's other constraints (it would shrink ${entName(SK.entById(k, id)) || 'a curve'} to nothing) — delete the one it fights in Constrain first`; }
  }));
  if (ok) toast(`${CONS_NAMES[t] || 'Constraint'} applied · ${dofText()}`);
  return ok;
}
// Point on curve (Fusion's coincident to a line, circle or arc): tap the point — a line's end, a corner, a centre or
// the origin — then the curve it is to stay on
export const onPending = () => st.onPend;
export function coincidentTap(x, y) {
  const s = sk(); if (!s) return;
  const raw = planePt(x, y), wpp = view.worldPerPixel(SK.toW(s.plane, raw));
  if (!st.onPend) {
    const r = SK.snapPoint(s, raw, { pxTol: 18, wpp, refPts: [] });
    const ref = r.ref && r.kind !== 'Mid' && SK.refPoint(s, r.ref) ? r.ref : r.kind === 'Origin' ? { e: 0, k: 'o' } : null;
    if (!ref) { toast('Tap a point first: a line\'s end, a corner, a centre or the origin'); return; }
    st.onPend = ref; view.render(); emit('drawcard'); toast('Now the line, circle or arc it goes on'); return;
  }
  const e = SK.pickEntity(s, raw, 14 * wpp), P = st.onPend;
  if (!e || !['line', 'circle', 'arc'].includes(e.t)) { toast('Tap a line, circle or arc'); return; }
  if (e.id === P.e) { toast('A point is already on its own curve — tap another one'); return; }
  st.onPend = null;
  // (the curve holds still and the point goes onto it — not the line tilting to reach the point)
  commitCons('on', [{ t: 'on', a: e.id, p: P }], { heavyRefs: e.t === 'line' ? [{ e: e.id, k: 'a' }, { e: e.id, k: 'b' }] : [{ e: e.id, k: 'c' }] });
  view.render(); emit('drawcard');
}
// a rectangle's side for a line constraint (Parallel, Perpendicular, Equal…): the rectangle becomes four lines that
// stay square (Horizontal / Vertical), and the side under the finger is the one picked — the whole rectangle
// could not be made parallel to anything
export function rectSideAt(rid, x, y) { return rectToLinesAt(rid, planePt(x, y))?.side ?? null; }
// (the same from a point in the sketch: the side nearest it)
function rectToLinesAt(rid, raw) {
  const s = sk(), e = s && SK.entById(s, rid); if (!e || e.t !== 'rect') return null;
  const cs = SK.rectCorners(e);
  const segD = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-300, t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / L2)); return Math.hypot(a[0] + dx * t - raw[0], a[1] + dy * t - raw[1]); };
  let side = 0; for (let i = 1; i < 4; i++) if (segD(cs[i], cs[(i + 1) % 4]) < segD(cs[side], cs[(side + 1) % 4])) side = i;
  let got = null;
  runOp(F.sketchOp('Rectangle to lines', s.id, k => {
    const r = SK.entById(k, rid); if (!r) return 'Rectangle missing';
    const lines = SK.explodeRect(k, r); k.cons = k.cons || [];
    lines.forEach((l, i) => k.cons.push({ id: ++k.nextEnt, t: i % 2 === 0 ? 'h' : 'v', a: l.id }));
    got = { side: lines[side].id, ids: lines.map(l => l.id) };
  }));
  return got;
}
// Fill region: the picked curves, repeated over a closed area tapped next
export const fillPending = () => !!st.fillPend;
export function fillRegionStart() {
  const s = sk(); if (!s) { toast('Open a sketch first'); return; }
  const ids = [...S.ed.drawSel].filter(id => SK.entById(s, id) && SK.entById(s, id).t !== 'dim');
  if (!ids.length) { toast('Pick the curves to repeat first (a hole, a slot, a shape), then Fill region'); return; }
  st.fillPend = { ids }; toast('Now tap inside the closed area to fill', 2600); emit('drawcard'); view.render();
}
export function fillTap(x, y) {
  const s = sk(), f = st.fillPend; if (!s || !f) return;
  const at = planePt(x, y), r = SK.regionAt(s, at);
  if (!r) { toast('Tap inside a closed area (its outline must be closed)'); return; }
  st.fillPend = null;
  const P = f.ids.map(id => SK.entById(s, id)).filter(Boolean).flatMap(e => SK.entPolyline(e).pts), xs = P.map(q => q[0]), ys = P.map(q => q[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys), gap = Math.max(w, h) * 0.5 || 2;
  const ids = f.ids;
  runOp(F.sketchOp('Fill region', s.id, (k, p) => { const res = SK.fillRegion(k, ids, at, p.dx, p.dy, p.stagger, p.keep); if (typeof res === 'string') return res; },
    [{ key: 'dx', label: 'Spacing X', kind: 'len' }, { key: 'dy', label: 'Spacing Y', kind: 'len' }, { key: 'stagger', label: 'Stagger rows', kind: 'bool' }, { key: 'keep', label: 'Keep copies', kind: 'choice', options: [['whole', 'Wholly inside'], ['centre', 'Centre inside']], wide: true }]),
  { dx: +(w + gap).toFixed(3), dy: +(h + gap).toFixed(3), stagger: false, keep: 'whole' });
  emit('drawcard'); view.render();
}
import { fixValues as fixValuesOf } from './constraints.js';
// the constraint analysis (DOF left, which curves are fully constrained) re-runs only when the sketch's content changes
const skKey = s => JSON.stringify(s.ents) + JSON.stringify(s.cons || []);
// (while a finger drags, a slow analysis keeps its last answer and runs once the sketch rests)
const anCache = new Map(); let anT = 0, anForce = false;
function analysisOf(s) {
  const k = skKey(s), c = anCache.get(s.id);
  if (c && c.k === k) return c.v;
  const dragging = !!st.grip || !!(getLast() && !getLast().committed);
  if (c && c.ms > 15 && dragging && !anForce) { clearTimeout(anT); anT = setTimeout(() => { anForce = true; view.render(); emit('drawcard'); }, 250); return c.v; }
  anForce = false;
  const t = performance.now(), v = analyzeSketch(s); anCache.set(s.id, { k, v, ms: performance.now() - t });
  return v;
}
const fixedOf = s => analysisOf(s).fixed;
export function dofText() {
  const s = sk(); if (!s || !s.ents || !s.ents.length) return '';
  const v = analysisOf(s).dof;
  return v === 0 ? 'fully constrained' : `${v} DOF free`;
}

export function toggleConstruction() {
  const s = sk(), ids = selIds();
  if (!ids.length) { toast('Select sketch entities first'); return; }
  runOp(F.sketchOp('Construction', s.id, k => { const on = !ids.every(id => SK.entById(k, id)?.construction); for (const id of ids) { const e = SK.entById(k, id); if (e && e.t !== 'dim') { if (on) e.construction = true; else delete e.construction; } } }));
}

export function deleteSelected() {
  const s = sk(); if (!s || !S.ed.drawSel.size) { toast('Select sketch entities first'); return; }
  const ids = new Set(S.ed.drawSel);
  runOp(F.sketchOp('Delete', s.id, sk2 => {
    sk2.ents = sk2.ents.filter(e => !ids.has(e.id));
    SK.pruneCons(sk2);
    S.ed.drawSel = new Set();
  }));
}

// ---------- dynamic-input card ----------
const pv = () => st.preview;
export function cardContent() {
  const s = sk(); if (!s) return null;
  const t = tool();
  const title = (txt, hint) => h('div', { class: 'head' }, h('div', { class: 'title' }, txt, hint ? h('small', {}, hint) : null),
    (st.start || st.arc || st.dimA || st.dimPend) ? h('button', { class: 'ib', 'aria-label': 'Cancel', html: I.close, onclick: () => resetTool() }) : null);
  // before the first point the typed values go on the construction plane (see typedTarget)
  if (t === 'text' && st.cmd && st.cmd.stage === 'string') {
    const inp = h('input', { class: 'textin', placeholder: 'Text, e.g. 1.7 L', enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false' });
    const place = () => { const v = inp.value.trim(); if (v) typed(v); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); place(); } });
    setTimeout(() => inp.focus(), 60);
    return h('div', {}, title('Text', 'type it, set the height, Place'), inp,
      h('div', { class: 'fields' }, field({ label: 'Height', kind: 'len', value: acad.textH ?? defSize() / 8, onCommit: v => { acad.textH = Math.max(1e-6, v); } })),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => resetTool() }, 'Cancel'), h('button', { class: 'btn primary', onclick: place }, 'Place')));
  }
  const [AU, AV] = axisNames(studio() && DRAW_PRIMARY.has(t) && waitingFirstPoint() && !target && S.ed.editingSketch == null ? cplane() : s.plane);
  // (on a face seen from behind the sketch's X runs along the model's −X: the fields take and show the model's
  // coordinate — 27 means x = 27 — and are labelled plain X)
  const su = /^−/.test(AU) ? -1 : 1, sv = /^−/.test(AV) ? -1 : 1, AU1 = AU.replace(/^−/, ''), AV1 = AV.replace(/^−/, '');
  const xyFields = (lab, cb) => h('div', { class: 'fields' },
    field({ label: lab + ' ' + AU1, kind: 'len', value: su * (pv() ? pv()[0] : 0), cls: axCls(AU1), onCommit: v => cb([su * v, pv() ? pv()[1] : 0], 0) }),
    field({ label: lab + ' ' + AV1, kind: 'len', value: sv * (pv() ? pv()[1] : 0), cls: axCls(AV1), onCommit: v => cb([st.typed.x ?? (pv() ? pv()[0] : 0), sv * v], 1) }));
  // Text: tap where it starts, or type the start point here (X then Y)
  if (t === 'text' && (!st.cmd || st.cmd.stage === 'base')) return h('div', {}, title('Text', 'tap where it starts, or type X and Y'),
    xyFields('Start', (p, k) => { typedTarget(); if (k === 0) { st.typed.x = p[0]; st.preview = p; emit('drawcard'); view.render(); return; } st.typed = {}; cmdPoint(p); emit('drawcard'); view.render(); }));
  const setStart = (p, k) => { typedTarget(); if (k === 0) { st.typed.x = p[0]; st.preview = p; emit('drawcard'); view.render(); return; } st.start = p; st.preview = p; st.typed = {}; emit('drawcard'); view.render(); };
  if (t === 'select') {
    const ents = [...S.ed.drawSel].map(id => SK.entById(s, id)).filter(Boolean);
    if (!ents.length) return null;
    if (ents.length > 1) return h('div', {}, title(`${ents.length} entities selected`));
    const e0 = ents[0];
    const summary = e0.t === 'line' ? `${fmtLen(SK.d2(e0.a, e0.b))} ∠ ${fmtAng(((ang(e0.a, e0.b) / D) + 360) % 360)}` : e0.t === 'rect' ? `${fmtLen(e0.w, false)} × ${fmtLen(e0.h)}` : e0.r != null ? `R ${fmtLen(e0.r)}` : '';
    const head = h('div', { class: 'head' }, h('div', { class: 'title' }, entTitle(e0), h('small', {}, summary)),
      h('button', { class: 'ib', 'aria-label': propsOpen ? 'Collapse' : 'Properties', html: propsOpen ? '▴' : '▾', onclick: () => { propsOpen = !propsOpen; emit('drawcard'); } }));
    return h('div', {}, head, propsOpen ? entFields(s, e0) : null);
  }
  if (t === 'trim') return title('Trim', 'tap pieces to remove');
  if (t === 'corner') {
    const size = corner.size ?? defSize() / 10;
    return h('div', {}, title(corner.kind === 'fillet' ? 'Fillet' : 'Chamfer', 'tap a corner of two lines'),
      h('div', { class: 'fields' },
        h('div', { class: 'field' }, h('label', {}, 'Type'), h('div', { class: 'seg' }, ...[['fillet', 'Fillet'], ['chamfer', 'Chamfer']].map(([k, l]) => h('button', { class: corner.kind === k ? 'on' : '', onclick: () => { corner.kind = k; emit('drawcard'); } }, l)))),
        field({ label: corner.kind === 'fillet' ? 'Radius' : 'Distance', kind: 'len', value: size, min: 1e-6, onCommit: v => { corner.size = v; emit('drawcard'); } })));
  }
  if (t === 'dim') { const P = st.dimPend; return title('Dimension', !P ? 'tap a line, a circle or arc, or a point' : P.kind === 'pt' ? 'now a second point, or a line' : P.line != null ? 'tap where it goes · another line → angle · a point → distance' : 'tap where it goes'); }
  if (t === 'line') {
    if (!st.start) return h('div', {}, title('Line', 'tap or drag · or type the start'), xyFields('Start', (p, k) => setStart(p, k)));
    const L = pv() ? SK.d2(st.start, pv()) : 0, A = st.typed.ang ?? (pv() && L > 1e-9 ? ang(st.start, pv()) / D : 0);
    const placeTyped = (len, a) => placeLine(st.start, [st.start[0] + len * ecos(a), st.start[1] + len * esin(a)]);
    // after the first segment the next one can be a tangent arc (PLINE's Arc option, on the card)
    const segBar = st.chain.length >= 2 ? h('div', { class: 'seg modebar' }, ...[['line', 'Line'], ['arc', 'Tangent arc']].map(([k, l]) => h('button', { class: (st.arcMode ? 'arc' : 'line') === k ? 'on' : '', onclick: () => { st.arcMode = k === 'arc'; emit('drawcard'); view.render(); } }, l))) : null;
    return h('div', {}, title(st.arcMode ? 'Tangent arc' : 'Line', st.chain.length ? `${st.chain.length - 1} segment${st.chain.length > 2 ? 's' : ''}` : 'next point'), segBar,
      h('div', { class: 'fields' },
        field({ label: 'Length', kind: 'len', value: L, min: 0, onCommit: v => { placeTyped(v, st.typed.ang ?? A); emit('drawcard'); view.render(); } }),
        field({ label: 'Angle', kind: 'ang', value: A, onCommit: v => { st.typed.ang = v; emit('drawcard'); } })),
      h('div', { class: 'btnrow' },
        st.chain.length > 2 ? h('button', { class: 'btn', onclick: () => { placeLine(st.start, st.chain[0]); emit('drawcard'); view.render(); } }, 'Close') : null,
        h('button', { class: 'btn', onclick: () => resetTool() }, 'Finish')));
  }
  if (t === 'rect') {
    const m = mode('rect'), bar = modeBar('rect');
    if (!st.start) return h('div', {}, title('Rectangle', m === 'center' ? 'tap the centre · or type it' : m === '3pt' ? 'first corner of the base side' : 'two corners · or type the first'), bar, xyFields(m === 'center' ? 'Centre' : 'Corner', (p, k) => setStart(p, k)));
    if (m === '3pt') {
      if (!st.p2) {
        const L = pv() ? SK.d2(st.start, pv()) : 0, A = st.typed.ang ?? (pv() && L > 1e-9 ? ang(st.start, pv()) / D : 0);
        return h('div', {}, title('Rectangle', 'end of the base side'), bar, h('div', { class: 'fields' },
          field({ label: 'Side length', kind: 'len', value: L, min: 0, onCommit: v => { const a2 = (st.typed.ang ?? A) * D; st.p2 = [st.start[0] + v * Math.cos(a2), st.start[1] + v * Math.sin(a2)]; emit('drawcard'); view.render(); } }),
          field({ label: 'Angle', kind: 'ang', value: A, onCommit: v => { st.typed.ang = v; emit('drawcard'); } })));
      }
      const H = pv() ? rectHeight(st.start, st.p2, pv()) : 0;
      return h('div', {}, title('Rectangle', 'height'), bar, h('div', { class: 'fields' },
        field({ label: 'Height', kind: 'len', value: H, onCommit: v => { placeRect3(st.start, st.p2, v); emit('drawcard'); view.render(); } })));
    }
    const k = m === 'center' ? 2 : 1;
    const W = st.typed.w ?? (pv() ? (pv()[0] - st.start[0]) * k : 0), H = st.typed.h ?? (pv() ? (pv()[1] - st.start[1]) * k : 0);
    const go = () => { const w = st.typed.w ?? W, hh = st.typed.h ?? H; if (m === 'center') placeRect([st.start[0] - w / 2, st.start[1] - hh / 2], [st.start[0] + w / 2, st.start[1] + hh / 2]); else placeRect(st.start, [st.start[0] + w, st.start[1] + hh]); };
    return h('div', {}, title('Rectangle', m === 'center' ? 'a corner' : 'second corner'), bar,
      h('div', { class: 'fields' },
        field({ label: 'Width', kind: 'len', value: W, cls: 'ax-x', onCommit: v => { st.typed.w = v; if (st.typed.h != null) go(); emit('drawcard'); view.render(); } }),
        field({ label: 'Height', kind: 'len', value: H, cls: 'ax-y', onCommit: v => { st.typed.h = v; if (st.typed.w != null) go(); emit('drawcard'); view.render(); } })),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { go(); emit('drawcard'); view.render(); } }, 'Place')));
  }
  if (t === 'circle') {
    const m = mode('circle'), bar = modeBar('circle');
    if (!st.start) return h('div', {}, title('Circle', m === 'center' ? 'centre, then radius · or type' : m === '2pt' ? 'one end of the diameter' : 'first point on the circle'), bar, m === 'center' ? xyFields('Centre', (p, k) => setStart(p, k)) : xyFields('Point', (p, k) => setStart(p, k)));
    if (m === '3pt') return h('div', {}, title('Circle', st.p2 ? 'third point' : 'second point'), bar);
    if (m === '2pt') {
      const Dm = pv() ? SK.d2(st.start, pv()) : 0, A = st.typed.ang ?? (pv() && Dm > 1e-9 ? ang(st.start, pv()) / D : 0);
      return h('div', {}, title('Circle', 'other end of the diameter'), bar, h('div', { class: 'fields' },
        field({ label: 'Diameter', kind: 'len', value: Dm, min: 0, onCommit: v => { const a2 = (st.typed.ang ?? A) * D; placeCircle([st.start[0] + v / 2 * Math.cos(a2), st.start[1] + v / 2 * Math.sin(a2)], v / 2); emit('drawcard'); view.render(); } }),
        field({ label: 'Angle', kind: 'ang', value: A, onCommit: v => { st.typed.ang = v; emit('drawcard'); } })));
    }
    const R = pv() ? SK.d2(st.start, pv()) : 0;
    return h('div', {}, title('Circle', 'radius point'), bar,
      h('div', { class: 'fields' },
        field({ label: 'Radius', kind: 'len', value: R, min: 0, onCommit: v => { placeCircle(st.start, v); emit('drawcard'); view.render(); } }),
        field({ label: 'Diameter', kind: 'len', value: 2 * R, min: 0, onCommit: v => { placeCircle(st.start, v / 2); emit('drawcard'); view.render(); } })));
  }
  if (t === 'arc' && mode('arc') === '3pt') {
    const bar = modeBar('arc');
    if (!st.start) return h('div', {}, title('Arc', 'start point'), bar, xyFields('Start', (p, k) => setStart(p, k)));
    return h('div', {}, title('Arc', st.p2 ? 'a point the arc passes through' : 'end point'), bar);
  }
  if (t === 'arc') {
    if (!st.arc) return h('div', {}, title('Arc', 'centre → start → end (CCW)'), modeBar('arc'), xyFields('Centre', (p, k) => { if (k === 0) { st.typed.x = p[0]; st.preview = p; } else { st.arc = { c: p }; st.typed = {}; } emit('drawcard'); view.render(); }));
    const c = st.arc.c;
    if (st.arc.r == null) {
      const R = st.typed.r ?? (pv() ? SK.d2(c, pv()) : 0), A0 = st.typed.a0 ?? (pv() ? ang(c, pv()) / D : 0);
      return h('div', {}, title('Arc', 'start point'),
        h('div', { class: 'fields' },
          field({ label: 'Radius', kind: 'len', value: R, min: 0, onCommit: v => { st.typed.r = v; emit('drawcard'); } }),
          field({ label: 'Start angle', kind: 'ang', value: A0, onCommit: v => { st.typed.a0 = v; emit('drawcard'); } })),
        h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { st.arc.r = st.typed.r ?? R; st.arc.a0 = (st.typed.a0 ?? A0) * D; st.typed = {}; emit('drawcard'); view.render(); } }, 'Next')));
    }
    let SW = pv() ? (ang(c, pv()) - st.arc.a0) / D : 90; SW = ((SW % 360) + 360) % 360;
    return h('div', {}, title('Arc', `R ${fmtLen(st.arc.r)} · end point`),
      h('div', { class: 'fields' }, field({ label: 'Sweep (CCW)', kind: 'ang', value: SW, onCommit: v => { placeArc(c, st.arc.r, st.arc.a0, v); emit('drawcard'); view.render(); } })));
  }
  const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: () => { fn(); emit('drawcard'); view.render(); } }, label);
  if (t === 'spline') {
    const c = ensureCmd(), n = c.pts.length;
    return h('div', {}, title('Spline', n ? `${n} point${n > 1 ? 's' : ''} · tap the next one` : 'tap the points it passes through'),
      h('div', { class: 'btnrow' },
        n ? btn('Undo point', () => { c.pts.pop(); }) : null,
        n >= 3 ? btn('Close', () => placeSpline(c, true)) : null,
        btn('Finish', () => { if (n >= 2) placeSpline(c, false); else toast('Tap at least 2 points'); }, 'primary')));
  }
  if (t === 'polygon') {
    const c = ensureCmd(), n = acad.polySides, flats = acad.polyBy === 'flats';
    const place = size => { const ctr = c.center; const v = flats ? polyCorner(ctr, size, acad.polyRot, n) : [ctr[0] + size * Math.cos(acad.polyRot * D), ctr[1] + size * Math.sin(acad.polyRot * D)]; editSketch(`Polygon (${n})`, k => { const r = SK.addPolygon(k, ctr, v, n); if (typeof r === 'string') return r; }); c.stage = 'center'; emit('drawcard'); view.render(); };
    const cur = c.stage === 'vertex' && pv() ? SK.d2(c.center, pv()) * (flats ? 2 * Math.cos(Math.PI / n) : 1) : 0;
    // the centre can be typed too (X then Y), like a circle's
    const typedCentre = c.stage === 'vertex' ? null : xyFields('Centre', (p, k) => { if (k === 0) { st.typed.x = p[0]; st.preview = p; emit('drawcard'); view.render(); return; } c.center = p; c.stage = 'vertex'; st.typed = {}; st.preview = p; emit('drawcard'); view.render(); });
    return h('div', {}, title(`Polygon · ${n} sides`, c.stage === 'vertex' ? (flats ? 'tap the middle of a flat, or type the size' : 'tap a corner, or type the size') : 'tap the centre, or type it'),
      h('div', { class: 'seg modebar' }, ...[['flats', 'Across flats'], ['corner', 'To corner']].map(([k, l]) => h('button', { class: acad.polyBy === k ? 'on' : '', onclick: () => { acad.polyBy = k; emit('drawcard'); } }, l))),
      typedCentre,
      h('div', { class: 'fields' },
        field({ label: 'Sides', kind: 'int', value: n, min: 3, max: 64, onCommit: v => { acad.polySides = Math.max(3, Math.min(64, Math.round(v))); emit('drawcard'); } }),
        field({ label: 'Rotation', kind: 'ang', value: acad.polyRot, onCommit: v => { acad.polyRot = v; emit('drawcard'); } }),
        c.stage === 'vertex' ? field({ label: flats ? 'Across flats' : 'Radius to corner', kind: 'len', value: cur, min: 0, cls: 'wide', onCommit: v => { if (v > 0) place(flats ? v : v); } }) : null));
  }
  // Scale: its two fields — where it scales from, and by how much (negative flips through the origin)
  if (t === 'scale' && scaleLive(st.cmd)) {
    const p = st.cmd.op.params, end = ok => { if (ok) commit(); else cancelOp(); st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); };
    return h('div', {}, title('Scale', 'tap the canvas to scale about that point'),
      h('div', { class: 'fields' },
        choice({ label: 'Origin', options: SCALE_ORIGINS, value: p.origin, onChange: v => { updateOp({ origin: v }); emit('lastop', getLast()); emit('drawcard'); view.render(); } }),
        field({ label: 'Scale', kind: 'num', value: p.f, cls: 'wide', onCommit: v => { if (!(Math.abs(v) > 1e-12)) return toast('The scale cannot be 0'); updateOp({ f: v }); emit('lastop', getLast()); emit('drawcard'); view.render(); } })),
      h('div', { class: 'btnrow' }, btn('Cancel', () => end(false)), btn('Done', () => end(true), 'primary')));
  }
  // remaining command tools (ellipse, text, hatch, edit commands, inquiry): show the prompt and a way out
  if (EDIT_TOOLS.has(t)) {
    const pr = prompt(), name = { ellipse: 'Ellipse', text: 'Text', hatch: 'Hatch', move: 'Move', copy: 'Copy', rotate: 'Rotate', scale: 'Scale', mirror: 'Mirror', offset: 'Offset', erase: 'Erase', explode: 'Explode', arrayrect: 'Array', arraypolar: 'Polar array', dist: 'Distance', id: 'Point', angle: 'Angle', area: 'Area', radius: 'Radius', list: 'List' }[t] || t;
    const c = st.cmd, quit = () => { resetTool(); S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); };
    // Offset: its distance is a field (it asked for a typed value with nowhere to type it on a phone)
    const offF = t === 'offset' ? h('div', { class: 'fields' }, field({ label: 'Distance', kind: 'len', value: acad.offsetDist ?? 5, min: 1e-9, cls: 'wide', onCommit: v => { if (v > 0) { acad.offsetDist = v; if (st.cmd) st.cmd.stage = 'pick'; emit('drawcard'); } } })) : null;
    if (t === 'offset' && acad.offsetDist == null) acad.offsetDist = 5;
    // Area by points: Total ends it with the result (Done threw the points away), as does tapping the first point again
    const total = t === 'area' && c?.stage === 'collect' && c.pts.length >= 3 ? btn('Total', () => { reportArea(c.pts, c.ptsW); endInquiry(); }, 'primary') : null;
    const discards = INQUIRY.has(t) && c && (c.pts?.length || c.base);
    return h('div', {}, title(name, (t === 'move' && S.ed.drawSel.size && c?.stage === 'base' ? 'drag an arrow (X or Y) from their middle, or tap a base point' : t === 'offset' ? (c?.stage === 'side' ? 'tap the side to offset to' : 'tap a curve to offset') : t === 'area' && c?.stage === 'collect' ? (c.pts.length >= 3 ? 'tap more corners, or Total' : 'tap the corners') : pr.text.replace(/:$/, '').replace(/ or$/, ''))),
      offF,
      pr.options && pr.options.length ? h('div', { class: 'btnrow', style: 'justify-content:flex-start;flex-wrap:wrap' }, ...pr.options.map(([l, k]) => btn(l, () => typed(k)))) : null,
      h('div', { class: 'btnrow' }, total, btn(discards ? 'Cancel' : 'Done', quit, total ? '' : 'primary')));
  }
  return null;
}
// mode switch shown at the top of the draw card (two corners / centre / 3 points …)
function modeBar(t) {
  const list = MODES[t]; if (!list) return null;
  return h('div', { class: 'seg modebar' }, ...list.map(([k, , short]) => h('button', { class: mode(t) === k ? 'on' : '', onclick: () => { setDrawMode(t, k); emit('drawcard'); view.render(); } }, short)));
}
// name the sketch axes after the world axes they run along (on the XZ plane the second one is Z)
const axN = (d, f) => { const k = d.findIndex(c => Math.abs(Math.abs(c) - 1) < 1e-9); return k < 0 ? f : (d[k] < 0 ? '−' : '') + 'XYZ'[k]; };
const axisNames = pl => [axN(pl.u, 'U'), axN(pl.v, 'V')];
const axCls = a => 'ax-' + ({ x: 'x', y: 'y', z: 'z' }[a.replace('−', '').toLowerCase()] || 'x');
function entTitle(e) { return { line: 'Line', rect: 'Rectangle', circle: 'Circle', arc: 'Arc', dim: 'Dimension' }[e.t] || e.t; }
function entFields(s, e) {
  const [AU, AV] = axisNames(s.plane);
  const skId = s.id, id = e.id;
  const edit = (label, fn) => v => runOp(F.sketchOp(label, skId, sk2 => editAndSolve(sk2, k => { const ee = SK.entById(k, id); if (!ee) return 'Gone'; return fn(k, ee, v); })));
  const fs = [];
  if (e.t === 'line') {
    const L = SK.d2(e.a, e.b), A = ang(e.a, e.b) / D;
    fs.push(
      field({ label: 'Length', kind: 'len', value: L, min: 1e-9, onCommit: edit('Line length', (k, ee, v) => { const L0 = SK.d2(ee.a, ee.b); ee.b = [ee.a[0] + (ee.b[0] - ee.a[0]) * v / L0, ee.a[1] + (ee.b[1] - ee.a[1]) * v / L0]; }) }),
      field({ label: 'Angle', kind: 'ang', value: A, onCommit: edit('Line angle', (k, ee, v) => { const l = SK.d2(ee.a, ee.b); ee.b = [ee.a[0] + l * ecos(v), ee.a[1] + l * esin(v)]; }) }),
      field({ label: 'Start ' + AU, kind: 'len', value: e.a[0], cls: axCls(AU), onCommit: edit('Line start', (k, ee, v) => { ee.a = [v, ee.a[1]]; }) }),
      field({ label: 'Start ' + AV, kind: 'len', value: e.a[1], cls: axCls(AV), onCommit: edit('Line start', (k, ee, v) => { ee.a = [ee.a[0], v]; }) }),
      field({ label: 'End ' + AU, kind: 'len', value: e.b[0], cls: axCls(AU), onCommit: edit('Line end', (k, ee, v) => { ee.b = [v, ee.b[1]]; }) }),
      field({ label: 'End ' + AV, kind: 'len', value: e.b[1], cls: axCls(AV), onCommit: edit('Line end', (k, ee, v) => { ee.b = [ee.b[0], v]; }) }));
  } else if (e.t === 'rect') {
    fs.push(
      field({ label: AU, kind: 'len', value: e.x, cls: axCls(AU), onCommit: edit('Rect X', (k, ee, v) => { ee.x = v; }) }),
      field({ label: AV, kind: 'len', value: e.y, cls: axCls(AV), onCommit: edit('Rect Y', (k, ee, v) => { ee.y = v; }) }),
      field({ label: 'Width', kind: 'len', value: e.w, min: 1e-9, onCommit: edit('Rect width', (k, ee, v) => { ee.w = v; }) }),
      field({ label: 'Height', kind: 'len', value: e.h, min: 1e-9, onCommit: edit('Rect height', (k, ee, v) => { ee.h = v; }) }));
  } else if (e.t === 'circle' || e.t === 'arc') {
    fs.push(
      field({ label: 'Centre ' + AU, kind: 'len', value: e.c[0], cls: axCls(AU), onCommit: edit('Centre', (k, ee, v) => { ee.c = [v, ee.c[1]]; }) }),
      field({ label: 'Centre ' + AV, kind: 'len', value: e.c[1], cls: axCls(AV), onCommit: edit('Centre', (k, ee, v) => { ee.c = [ee.c[0], v]; }) }),
      field({ label: 'Radius', kind: 'len', value: e.r, min: 1e-9, onCommit: edit('Radius', (k, ee, v) => { ee.r = v; }) }),
      field({ label: 'Diameter', kind: 'len', value: 2 * e.r, min: 1e-9, onCommit: edit('Diameter', (k, ee, v) => { ee.r = v / 2; }) }));
    if (e.t === 'arc') fs.push(
      field({ label: 'Start°', kind: 'ang', value: e.a0 / D, onCommit: edit('Arc start', (k, ee, v) => { const sw = SK.sweep(ee); ee.a0 = v * D; ee.a1 = ee.a0 + sw; }) }),
      field({ label: 'Sweep°', kind: 'ang', value: SK.sweep(e) / D, min: 0.001, max: 360, onCommit: edit('Arc sweep', (k, ee, v) => { ee.a1 = ee.a0 + v * D; }) }));
  }
  return h('div', { class: 'fields' }, fs);
}

// ---------- rendering ----------
let sketchGroup, previewGroup, renderKey = '';
const C = { proj: new THREE.Color('#c27cff'), constr: new THREE.Color('#ff9b3d'), fixed: new THREE.Color('#9fe39a'), line: new THREE.Color('#f2f2f2'), dim: new THREE.Color('#9aa3b3'), sel: new THREE.Color('#6fb4ff'), other: new THREE.Color('#8d93a0'), prev: new THREE.Color('#4fd1ff') };
const matL = (col, top, op = 1) => new THREE.LineBasicMaterial({ color: col, depthTest: !top, transparent: true, opacity: op });
export function initDraw() {
  sketchGroup = new THREE.Group(); view.scene.add(sketchGroup);
  previewGroup = new THREE.Group(); view.overlayScene.add(previewGroup);
  view.renderHooks.push(renderSketches);
}
// highlight line: hidden parts are drawn faint, visible parts strong (depth tested, pulled forward)
export function fatLine(pts3, color, width, closed) {
  const pts = closed ? [...pts3, pts3[0]] : pts3;
  const grp = new THREE.Group();
  const g = new LineGeometry(); g.setPositions(pts.flat());
  const back = new Line2(g, view.fatMat({ color, depthTest: false, width: width * 0.6, opacity: 0.28 })); back.renderOrder = 5;
  const fm = view.fatMat({ color, depthTest: true, width }); fm.polygonOffset = true; fm.polygonOffsetFactor = -6; fm.polygonOffsetUnits = -20;
  const front = new Line2(g, fm); front.renderOrder = 6;
  grp.add(back, front); return grp;
}
// a sketch curve, Fusion-style: a crisp line in its state colour (dashed for construction) over a soft dark halo,
// so it reads on light faces as well as on the dark backdrop; it lies on its plane and wins over the face under it
function skCurve(pts3, { color, width = 1.8, dashed = false, halo = view.theme.halo, closed = false }) {
  const pts = closed ? [...pts3, pts3[0]] : pts3;
  const grp = new THREE.Group(), g = new LineGeometry(); g.setPositions(pts.flat());
  if (halo && !dashed) {
    // (opaque: a translucent halo darkens where its short segments overlap — dotted rings round circles)
    // (and it writes no depth: the line drawn after it always wins, with no stripes where segments meet)
    const hm = view.fatMat({ color: halo, width: width + 1.6 }); hm.depthWrite = false; hm.transparent = true; hm.polygonOffset = true; hm.polygonOffsetFactor = -3; hm.polygonOffsetUnits = -10;
    const hl = new Line2(g, hm); hl.renderOrder = 1; grp.add(hl);
  }
  // (drawn in the transparent pass, after the profile shading under it: renderOrder fill 0 → halo 1 → line 2 → points 4)
  const fm = view.fatMat({ color, width, dashed, dashSize: 1, gapSize: 0.6 }); fm.transparent = true; fm.polygonOffset = true; fm.polygonOffsetFactor = -5; fm.polygonOffsetUnits = -16;
  const ln = new Line2(g, fm); ln.renderOrder = 2;
  if (dashed) { ln.computeLineDistances(); ln.userData.fatDash = true; }
  grp.add(ln);
  return grp;
}
// many sketch curves of one look drawn as one object (segment pairs): one draw call per colour and width instead of
// two per curve — a sketch of hundreds of lines made every frame hundreds of draws
function skCurves(segs, { color, width = 1.8, dashed = false, halo = view.theme.halo }) {
  const grp = new THREE.Group(), g = new LineSegmentsGeometry(); g.setPositions(segs);
  if (halo && !dashed) {
    const hm = view.fatMat({ color: halo, width: width + 1.6 }); hm.depthWrite = false; hm.transparent = true; hm.polygonOffset = true; hm.polygonOffsetFactor = -3; hm.polygonOffsetUnits = -10;
    const hl = new LineSegments2(g, hm); hl.renderOrder = 1; grp.add(hl);
  }
  const fm = view.fatMat({ color, width, dashed, dashSize: 1, gapSize: 0.6 }); fm.transparent = true; fm.polygonOffset = true; fm.polygonOffsetFactor = -5; fm.polygonOffsetUnits = -16;
  const ln = new LineSegments2(g, fm); ln.renderOrder = 2;
  if (dashed) { ln.computeLineDistances(); ln.userData.fatDash = true; }
  grp.add(ln);
  return grp;
}
function lineObj(pts3, mat, closed) {
  if (mat && mat.isLineBasicMaterial && !mat.isLineDashedMaterial) {
    // crisp screen-space line, same colour / opacity / depth behaviour
    const pts = closed ? [...pts3, pts3[0]] : pts3;
    const g = new LineGeometry(); g.setPositions(pts.flat());
    const fm = view.fatMat({ color: mat.color.getHex(), opacity: mat.opacity, depthTest: mat.depthTest, width: 1.5 });
    // sketch curves win over the body edges and faces they lie on (no flicker where they coincide)
    fm.polygonOffset = true; fm.polygonOffsetFactor = -4; fm.polygonOffsetUnits = -12;
    mat.dispose();
    const l = new Line2(g, fm); l.renderOrder = mat.depthTest ? 0 : 5;
    return l;
  }
  const g = new THREE.BufferGeometry().setFromPoints(pts3.map(p => new THREE.Vector3(...p)));
  return closed ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
}
function fillObj(s, r, color, opacity) {
  const shape = new THREE.Shape(r.outer.map(p => new THREE.Vector2(p[0], p[1])));
  r.holes.forEach(hh => shape.holes.push(new THREE.Path(hh.map(p => new THREE.Vector2(p[0], p[1])))));
  const g = new THREE.ShapeGeometry(shape);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) { const w = SK.toW(s.plane, [pos.getX(i), pos.getY(i)]); pos.setXYZ(i, w[0] + s.plane.n[0] * 0.002, w[1] + s.plane.n[1] * 0.002, w[2] + s.plane.n[2] * 0.002); }
  g.computeBoundingSphere();
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
}
function renderSketches() {
  const ws = S.ed.workspace, act = studio() ? sk() : SK.activeSketch(), stu = studio();
  const key = [ws, S.ed.sketch, S.ed.editingSketch, H.hist().length, H.markerIndex(), (S.doc.sketches || []).map(s => isShown(s)).join(), [...S.ed.drawSel].join(), JSON.stringify(S.ed.profiles), S.settings.showSketches, view.theme.name].join('|');
  C.line.set(view.theme.sketch); C.fixed.set(view.theme.skFixed || '#9fe39a'); C.sel.set(view.theme.skSel || '#ffd23f'); // (picked curves amber: free curves are already blue, so a lighter blue did not show the pick)
  const sketches = S.doc.sketches || [];
  const entsArr = sketches.map(s => s.ents), prevEnts = sketchGroup.userData.ents || [];
  const changed = key !== renderKey || entsArr.length !== prevEnts.length || entsArr.some((e, i) => e !== prevEnts[i]);
  {
    if (changed) {
      renderKey = key; sketchGroup.userData.ents = entsArr;
      clearGroup(sketchGroup);
      for (const s of sketches) {
        if (!isShown(s)) continue;
        // (each sketch in its own group, lifted a couple of pixels off its plane every frame: thick screen-space
        // lines lying exactly on a tilted face would be partly hidden by it)
        const sg = new THREE.Group(); sg.userData.lift = { n: s.plane.n, o: s.plane.o }; sketchGroup.add(sg);
        // sketches a feature has used draw muted (their curves now sit on body edges) unless being edited
        const used = stu && S.ed.editingSketch !== s.id && H.firstUsing([s.id]) >= 0;
        const usedRegs = used ? new Set(H.hist().flatMap(r => (r.params?.pts || []).filter(it => it.sk === s.id).map(it => SK.regionAt(s, it.pt))).filter(Boolean)) : null;
        const isAct = !used && (stu ? (S.ed.editingSketch == null || s.id === S.ed.editingSketch) : (ws === 'draw' && s.id === S.ed.sketch)); // other sketches dim while one is edited
        const top = isAct && !stu;
        const mine = s.id === S.ed.sketch;
        const fixedSet = isAct ? fixedOf(s) : null;
        const batches = new Map();
        for (const e of s.ents) {
          if (e.t === 'dim') continue;
          if (e.t === 'text') { sg.add(textMesh(s, e, mine && S.ed.drawSel.has(e.id) ? '#6fb4ff' : isAct ? view.theme.sketch : '#8d93a0')); continue; }
          if (e.t === 'hatch') {
            const hl = SK.hatchLines(s, e); if (!hl) continue;
            const col = mine && S.ed.drawSel.has(e.id) ? C.sel : isAct ? new THREE.Color('#b9c3cf') : C.other;
            if (e.pattern === 'SOLID') sg.add(fillObj(s, hl.region, col, 0.75));
            else if (hl.lines.length) { const pos = hl.lines.flatMap(([a, b]) => [...SK.toW(s.plane, a), ...SK.toW(s.plane, b)]); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); sg.add(new THREE.LineSegments(g, matL(col, top, 0.7))); }
            continue;
          }
          const pl = SK.entPolyline(e);
          const sel = isAct && mine && S.ed.drawSel.has(e.id);
          // Fusion's colours: blue while free to move, white (black on the light theme) once fully constrained,
          // dashed orange construction, purple projected geometry; the picked curve brighter and thicker
          const col = isAct ? (sel ? C.sel : e.construction ? C.constr : e.proj ? C.proj : fixedSet.has(e.id) ? C.fixed : C.line) : C.other;
          const W3 = pl.pts.map(p => SK.toW(s.plane, p));
          if (top) { sg.add(lineObj(W3, matL(col, top, 1), pl.closed)); continue; } // (2D drafting view)
          const o = { color: col, width: sel ? 2.8 : isAct ? 1.8 : 1.2, dashed: !!e.construction, halo: isAct ? view.theme.halo : null };
          const bk = `${col.getHexString()}|${o.width}|${o.dashed}|${o.halo}`, B = batches.get(bk) || (batches.set(bk, { o, segs: [] }), batches.get(bk));
          for (let i = 1; i < W3.length; i++) B.segs.push(...W3[i - 1], ...W3[i]);
          if (pl.closed && W3.length > 2) B.segs.push(...W3[W3.length - 1], ...W3[0]);
        }
        for (const { o, segs } of batches.values()) if (segs.length) sg.add(skCurves(segs, o));
        // Fusion's sketch points: a small square at every curve end while the sketch is being edited
        if (stu && S.ed.editingSketch === s.id) {
          const pf = [], pc = [];
          for (const e of s.ents) {
            if (e.t === 'dim' || e.t === 'text' || e.t === 'hatch' || e.construction || e.glyph || e.proj) continue; // (projected corners cannot be dragged: no squares)
            const fixed = fixedSet.has(e.id), c3 = fixed ? C.fixed : C.line;
            for (const kp of SK.keyPoints(e)) if (kp.m || kp.center) { pf.push(...SK.toW(s.plane, kp.p)); pc.push(c3.r, c3.g, c3.b); }
          }
          if (pf.length) {
            const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pf, 3)); pg.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
            const pm = new THREE.Points(pg, new THREE.PointsMaterial({ vertexColors: true, size: 6 * Math.min(devicePixelRatio, 2.5), sizeAttenuation: false, depthTest: false, transparent: true }));
            pm.renderOrder = 4; sg.add(pm);
          }
        }
        if (isAct && mine && (!stu || S.ed.editingSketch === s.id)) {
          // endpoints (only while the sketch is open: outside it a picked curve is just highlighted)
          const pts = [];
          for (const e of s.ents) if (S.ed.drawSel.has(e.id)) for (const kp of SK.keyPoints(e)) if (kp.m || kp.center || kp.k === 'mid') pts.push(...SK.toW(s.plane, kp.p));
          const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const pm = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x2f7dff, size: 9 * Math.min(devicePixelRatio, 2.5), sizeAttenuation: false, depthTest: false }));
          pm.renderOrder = 5; sg.add(pm);
        }
        if (ws === 'draw' && isAct || ws === 'cad' || stu) {
          const selRegs = new Set(S.ed.profiles.filter(q => q.sk === s.id).map(q => SK.regionAt(s, q.pt)).filter(Boolean));
          const prof = new THREE.Color(view.theme.profile).getHex();
          for (const r of SK.regions(s)) if (!usedRegs || !usedRegs.has(r) || selRegs.has(r)) sg.add(fillObj(s, r, selRegs.has(r) ? view.selHex() : prof, selRegs.has(r) ? 0.5 : stu ? view.theme.profA * (S.ed.editingSketch === s.id ? 1 : 0.55) : 0.1)); // (a finished sketch's profiles stay a faint hint)
        }
      }
    }
  }
  for (const sg of sketchGroup.children) { const L = sg.userData.lift; if (!L) continue; const k = view.worldPerPixel(L.o) * 2; sg.position.set(L.n[0] * k, L.n[1] * k, L.n[2] * k); }
  // keep selection dashes a constant size on screen
  const dash = act ? view.worldPerPixel(act.plane.o) * 6 : 1;
  sketchGroup.traverse(o => { if ((o.userData.dashed || o.userData.fatDash) && Math.abs(o.material.dashSize - dash) > dash * 0.05) { o.material.dashSize = dash; o.material.gapSize = dash * 0.6; } });
  // per-frame labels for dims + preview
  st.dimLabels = []; st.consLabels = []; // (a hidden sketch keeps no tappable labels)
  // (in the studio a sketch's dimensions and constraints show only while it is open, as in Fusion)
  if ((ws === 'draw' || (stu && S.ed.editingSketch === act?.id)) && act && !act.pending && isShown(act)) {
    // dimension values and constraint glyphs, laid out on screen so none sits on another (dimensions of a long part
    // came out in one row on top of each other, and glyphs piled up where curves' middles meet)
    const labs = [], ds = dimSelected();
    for (const d of act.ents) if (d.t === 'dim') {
      const g = dimLayout(act, d); if (!g) continue;
      const cls = ds && ds.id === d.id && ds.sk === act.id ? 'on' : d.value == null ? 'ref' : '';
      view.dimPaths(g.lines, g.arrows, cls);
      labs.push({ dim: d, text: g.text, cls: 'dim' + (cls ? ' ' + cls : ''), x: g.tx, y: g.ty, w: g.text.length * 7.3 + 16, h: 24, fixed: true });
    }
    // the dimension tool's pick, waiting to be placed
    const pd = tool() === 'dim' && pendDim(act, st.dimPend), pg = pd && dimLayout(act, pd);
    if (pg) { view.dimPaths(pg.lines, pg.arrows, 'pend'); view.labelAt(pg.tx, pg.ty, pg.text, 'dim pend'); }
    // a constraint's glyph stands off its curve (a line's: square to it, 24 px out), so a tap on the curve itself is
    // never taken by the glyph
    const seen = new Map();
    for (const c of act.cons || []) {
      if (c.t === 'on') { const q0 = SK.refPoint(act, c.p); const q = q0 && view.project(SK.toW(act.plane, q0)); if (q && q.front) labs.push({ c, text: SK.CONS_LABEL.on, cls: 'cons' + (consSel && consSel.cid === c.id && consSel.sk === act.id ? ' on' : ''), x: q.x + 16, y: q.y - 18, w: 22, h: 20 }); continue; }
      const e = SK.entById(act, c.a); if (!e) continue;
      const n = seen.get(e.id) || 0; seen.set(e.id, n + 1);
      let x, y;
      if (e.t === 'line') {
        const A = view.project(SK.toW(act.plane, e.a)), B = view.project(SK.toW(act.plane, e.b)); if (!A.front || !B.front) continue;
        let dx = B.x - A.x, dy = B.y - A.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        let nx = -dy, ny = dx; if (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) { nx = -nx; ny = -ny; } // (below it, or to its right)
        x = (A.x + B.x) / 2 + nx * 24 + dx * n * 24; y = (A.y + B.y) / 2 + ny * 24 + dy * n * 24;
      } else {
        const kp = SK.keyPoints(e), anchor = (kp.find(q => q.k === 'mid' || q.k === 'c' || q.k === 'ctr') || kp[0]).p;
        const q = view.project(SK.toW(act.plane, anchor)); if (!q.front) continue;
        x = q.x + 18 + n * 24; y = q.y + 18;
      }
      labs.push({ c, text: SK.CONS_LABEL[c.t], cls: 'cons' + (consSel && consSel.cid === c.id && consSel.sk === act.id ? ' on' : ''), x, y, w: 22, h: 20 });
    }
    spreadLabels(labs);
    for (const L of labs) {
      view.labelAt(L.x, L.y, L.text, L.cls);
      if (L.dim) st.dimLabels.push({ dim: L.dim, x: L.x, y: L.y, w: L.w, h: L.h }); else st.consLabels.push({ c: L.c, x: L.x, y: L.y });
    }
    if (stu) clearGroup(previewGroup); else drawAxes(act);
  } else clearGroup(previewGroup);
  drawPreview(act);
}
// nudge screen labels apart (each at most 64 px from where it belongs): pairs that overlap are pushed apart along
// the direction they overlap least in, a few rounds
function spreadLabels(labs) {
  const home = labs.map(L => [L.x, L.y]), pad = 3;
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    // only labels in neighbouring cells can overlap: bucket them (every pair, every pass, was ~9 million checks a
    // frame on a sketch of 600 constrained lines)
    const cs = Math.max(48, ...labs.map(L => Math.max(L.w, L.h) + pad)), grid = new Map(), cellOf = L => [Math.floor(L.x / cs), Math.floor(L.y / cs)];
    labs.forEach((L, i) => { const [cx, cy] = cellOf(L), k = cx + ',' + cy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const pairs = [];
    labs.forEach((L, i) => { const [cx, cy] = cellOf(L); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get((cx + dx) + ',' + (cy + dy)) || []) if (j > i) pairs.push(i, j); });
    for (let q = 0; q < pairs.length; q += 2) {
      const i = pairs[q], j = pairs[q + 1], A = labs[i], B = labs[j];
      const ox = (A.w + B.w) / 2 + pad - Math.abs(A.x - B.x), oy = (A.h + B.h) / 2 + pad - Math.abs(A.y - B.y);
      if (ox <= 0 || oy <= 0 || (A.fixed && B.fixed)) continue;
      moved = true;
      const ka = A.fixed ? 0 : B.fixed ? 2 : 1, kb = 2 - ka; // (a dimension stays put: the glyph moves the whole way)
      if (oy <= ox) { const s = (A.y < B.y || (A.y === B.y && i < j) ? -1 : 1) * oy / 2; A.y += s * ka; B.y -= s * kb; }
      else { const s = (A.x < B.x ? -1 : 1) * ox / 2; A.x += s * ka; B.x -= s * kb; }
    }
    labs.forEach((L, k) => { const dx = L.x - home[k][0], dy = L.y - home[k][1], d = Math.hypot(dx, dy); if (d > 64) { L.x = home[k][0] + dx * 64 / d; L.y = home[k][1] + dy * 64 / d; } });
    if (!moved) break;
  }
}
const clearGroup = g => view.disposeLater(g);
function drawAxes(s) {
  const L = view.worldPerPixel(s.plane.o) * 60;
  clearGroup(previewGroup);
  previewGroup.add(lineObj([SK.toW(s.plane, [0, 0]), SK.toW(s.plane, [L, 0])], matL(0xf2545b, true, 0.9)));
  previewGroup.add(lineObj([SK.toW(s.plane, [0, 0]), SK.toW(s.plane, [0, L])], matL(0x7cc243, true, 0.9)));
}
function drawPreview(s) {
  if ((S.ed.workspace !== 'draw' && !studio()) || !s) return;
  const t = tool(), p = st.preview, W = q => SK.toW(s.plane, q);
  const m = matL(C.prev, true);
  const from = st.start || st.pressAnchor;
  if (p && from && t === 'line') { previewGroup.add(lineObj([W(from), W(p)], m)); const L = SK.d2(from, p); if (L > 1e-9) view.label(W([(from[0] + p[0]) / 2, (from[1] + p[1]) / 2]), `${fmtLen(L)} ∠ ${fmtAng(((ang(from, p) / D) + 360) % 360)}`, 'readout'); }
  if (p && from && t === 'rect' && mode('rect') === 'center') {
    const q = [2 * from[0] - p[0], 2 * from[1] - p[1]];
    previewGroup.add(lineObj([q, [p[0], q[1]], p, [q[0], p[1]]].map(W), m, true), lineObj([W(from), W(p)], matL(C.prev, true, 0.4)));
    view.label(W(p), `${fmtLen(2 * Math.abs(p[0] - from[0]), false)} × ${fmtLen(2 * Math.abs(p[1] - from[1]))}`, 'readout');
  } else if (p && from && t === 'rect' && mode('rect') === '3pt') {
    if (!st.p2) { previewGroup.add(lineObj([W(from), W(p)], m)); view.label(W(p), `${fmtLen(SK.d2(from, p))} ∠ ${fmtAng(((ang(from, p) / D) + 360) % 360)}`, 'readout'); }
    else { const hg = rectHeight(from, st.p2, p), L = SK.d2(from, st.p2), n = [-(st.p2[1] - from[1]) / L * hg, (st.p2[0] - from[0]) / L * hg];
      previewGroup.add(lineObj([from, st.p2, [st.p2[0] + n[0], st.p2[1] + n[1]], [from[0] + n[0], from[1] + n[1]]].map(W), m, true)); view.label(W(p), `${fmtLen(L, false)} × ${fmtLen(Math.abs(hg))}`, 'readout'); }
  } else if (p && from && t === 'rect') { previewGroup.add(lineObj([from, [p[0], from[1]], p, [from[0], p[1]]].map(W), m, true)); view.label(W(p), `${fmtLen(Math.abs(p[0] - from[0]), false)} × ${fmtLen(Math.abs(p[1] - from[1]))}`, 'readout'); }
  if (p && from && t === 'circle' && mode('circle') === '2pt') { const c = [(from[0] + p[0]) / 2, (from[1] + p[1]) / 2], r = SK.d2(from, p) / 2; const pl = SK.entPolyline({ t: 'circle', c, r }); previewGroup.add(lineObj(pl.pts.map(W), m, true), lineObj([W(from), W(p)], matL(C.prev, true, 0.5))); view.label(W(p), `Ø ${fmtLen(2 * r)}`, 'readout'); }
  else if (p && from && (t === 'circle' || t === 'arc') && mode(t) === '3pt') {
    if (!st.p2) { previewGroup.add(lineObj([W(from), W(p)], m)); view.label(W(p), fmtLen(SK.d2(from, p)), 'readout'); }
    else if (t === 'circle') { const Cc = circle3(from, st.p2, p); if (Cc) { previewGroup.add(lineObj(SK.entPolyline({ t: 'circle', c: Cc.c, r: Cc.r }).pts.map(W), m, true)); view.label(W(p), `R ${fmtLen(Cc.r)}`, 'readout'); } }
    else { const A = arc3(from, st.p2, p); if (A) { previewGroup.add(lineObj(SK.entPolyline({ t: 'arc', c: A.c, r: A.r, a0: A.a0, a1: A.a0 + A.sw }).pts.map(W), m)); view.label(W(p), `R ${fmtLen(A.r)}`, 'readout'); } }
  }
  else if (p && from && t === 'circle') { const r = SK.d2(from, p); const pl = SK.entPolyline({ t: 'circle', c: from, r }); previewGroup.add(lineObj(pl.pts.map(W), m, true), lineObj([W(from), W(p)], matL(C.prev, true, 0.5))); view.label(W(p), `R ${fmtLen(r)}`, 'readout'); }
  if (t === 'arc' && mode('arc') !== '3pt' && (st.arc || st.pressAnchor) && p) {
    const c = st.arc ? st.arc.c : st.pressAnchor;
    if (!st.arc || st.arc.r == null) { previewGroup.add(lineObj([W(c), W(p)], m)); view.label(W(p), `R ${fmtLen(SK.d2(c, p))}`, 'readout'); }
    else { let sw = ang(c, p) - st.arc.a0; sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI; const pl = SK.entPolyline({ t: 'arc', c, r: st.arc.r, a0: st.arc.a0, a1: st.arc.a0 + sw }); previewGroup.add(lineObj(pl.pts.map(W), m)); view.label(W(p), fmtAng(sw / D), 'readout'); }
  }
  if (result) drawResult(s, W);
  const c = st.cmd;
  if (c && INQUIRY.has(c.tool) && p) {
    const f = fromPt();
    // (the corners picked so far drawn where they were tapped, on a body in 3D; the running label is the side's length,
    // or the angle — never an area in mm)
    const fW = c.tool === 'area' ? c.ptsW?.at(-1) : c.tool === 'angle' ? (c.stage === 'p2' ? c.baseW : c.baseW) : null;
    if (f) { previewGroup.add(lineObj([fW || W(f), W(p)], m)); if (c.tool !== 'angle' || c.stage !== 'p2') view.label(W(p), fmtLen(fW ? Math.hypot(...W(p).map((v, i) => v - fW[i])) : SK.d2(f, p)), 'readout'); }
    if (c.tool === 'angle' && c.stage === 'p2') previewGroup.add(lineObj([c.baseW || W(c.base), c.p1W || W(c.p1)], m));
    if (c.tool === 'area' && c.pts.length > 1) previewGroup.add(lineObj([...(c.ptsW || c.pts.map(W)), W(p)], matL(C.prev, true, 0.6), true));
  }
  if (c && c.stage === 'second' && p && c.base && ['move', 'copy', 'rotate', 'scale', 'mirror'].includes(c.tool)) {
    const b = c.base, ids = selIds();
    const ghost = { ents: JSON.parse(JSON.stringify(s.ents.filter(e => ids.includes(e.id)))), cons: [], nextEnt: 1e6 };
    const op = c.tool === 'move' || c.tool === 'copy' ? { kind: 'move', d: [p[0] - b[0], p[1] - b[1]] } : c.tool === 'rotate' ? { kind: 'rotate', c: b, deg: ang(b, p) / D } : c.tool === 'scale' ? { kind: 'scale', c: b, f: Math.max(1e-6, SK.d2(b, p)) } : { kind: 'mirror', a: b, b: p };
    if (!(c.tool === 'mirror' && SK.d2(b, p) < 1e-9)) {
      SK.transformEntities(ghost, ghost.ents.map(e => e.id), op);
      for (const e of ghost.ents) { const pl = SK.entPolyline(e); if (pl) previewGroup.add(lineObj(pl.pts.map(W), m, pl.closed)); }
    }
    previewGroup.add(lineObj([W(b), W(p)], matL(C.prev, true, 0.5)));
    const txt = c.tool === 'rotate' ? fmtAng(((ang(b, p) / D) + 360) % 360) : c.tool === 'scale' ? `× ${SK.d2(b, p).toFixed(4)}` : fmtLen(SK.d2(b, p));
    view.label(W(p), txt, 'readout');
  }
  if (c && c.tool === 'ellipse' && p && c.center) {
    const g = c.stage === 'axis' ? { t: 'ellipse', c: c.center, rx: Math.max(1e-6, SK.d2(c.center, p)), ry: Math.max(1e-6, SK.d2(c.center, p)) / 2, rot: ang(c.center, p) } : c.stage === 'other' ? { t: 'ellipse', c: c.center, rx: SK.d2(c.center, c.axis), ry: Math.max(1e-6, perpDist(c, p)), rot: ang(c.center, c.axis) } : null;
    if (g) { const pl = SK.entPolyline(g); previewGroup.add(lineObj(pl.pts.map(W), m, true)); }
  }
  if (c && c.tool === 'spline' && c.pts.length) {
    const pts = p ? [...c.pts, p] : c.pts;
    previewGroup.add(lineObj(SK.splinePoints(pts, false).map(W), m));
    for (const q of c.pts) previewGroup.add(osnapMarker(W(q), 'End', s));
  }
  if (t === 'line' && st.arcMode && st.start && p && SK.d2(st.start, p) > 1e-9) {
    const g = tangentArc(st.start, p); if (g) previewGroup.add(lineObj(SK.entPolyline(g).pts.map(W), m));
  }
  if (c && c.tool === 'polygon' && c.stage === 'vertex' && p) {
    const ghost = { ents: [], nextEnt: 1e6 }; SK.addPolygon(ghost, c.center, p, acad.polySides);
    for (const e of ghost.ents) previewGroup.add(lineObj([W(e.a), W(e.b)], m));
  }
  if (st.dimPend?.kind === 'pt' && tool() === 'dim') { const q = SK.refPoint(s, st.dimPend.A); if (q) previewGroup.add(marker(W(q), 0x4f8ff7)); }
  if (st.onPend) { const q = SK.refPoint(s, st.onPend); if (q) previewGroup.add(marker(W(q), 0x4f8ff7)); } // (Point on curve: the point picked)
  if (scaleLive(c)) previewGroup.add(marker(W(scaleOrigin(c.op.params)), 0xffd23f)); // (the Scale origin)
  if (p && st.snap && !['select', 'trim', 'dim', 'extend'].includes(t) && (!EDIT_TOOLS.has(t) || pointStage())) {
    crosshair(s, p);
    const k = st.snap.kind || '';
    const f = fromPt();
    if (/^\d/.test(k) && f) { // polar tracking ray
      const L = view.worldPerPixel(W(p)) * 4000, d = [p[0] - f[0], p[1] - f[1]], l = Math.hypot(d[0], d[1]) || 1;
      const ray = lineObj([W(f), W([f[0] + d[0] / l * L, f[1] + d[1] / l * L])], new THREE.LineDashedMaterial({ color: 0x8fd2ff, depthTest: false, dashSize: view.worldPerPixel(W(p)) * 5, gapSize: view.worldPerPixel(W(p)) * 4 }));
      ray.computeLineDistances(); previewGroup.add(ray);
    }
    const name = OSNAP_NAME[k] || (/^\d/.test(k) && f ? `Polar: ${fmtLen(SK.d2(f, p))} < ${k}` : k === 'Ortho' ? 'Ortho' : '');
    if (OSNAP_NAME[k]) previewGroup.add(osnapMarker(W(p), k, s));
    if (name && (!f || OSNAP_NAME[k])) view.label(W(p), name, 'osnap');
  }
  if (st.grip && p) { previewGroup.add(osnapMarker(W(p), st.snap && OSNAP_NAME[st.snap.kind] ? st.snap.kind : 'End', s)); crosshair(s, p); }
}
const OSNAP_NAME = { End: 'Endpoint', Vertex: 'Endpoint', Mid: 'Midpoint', Center: 'Center', Int: 'Intersection', Quad: 'Quadrant', Origin: 'Origin' };
// AutoCAD-style crosshair through the cursor, along the sketch axes
function crosshair(s, p) {
  const W = q => SK.toW(s.plane, q), L = view.worldPerPixel(W(p)) * 3000, b = view.worldPerPixel(W(p)) * 5;
  const m = matL(0xffffff, true, 0.45);
  previewGroup.add(lineObj([W([p[0] - L, p[1]]), W([p[0] + L, p[1]])], m), lineObj([W([p[0], p[1] - L]), W([p[0], p[1] + L])], m));
  previewGroup.add(lineObj([W([p[0] - b, p[1] - b]), W([p[0] + b, p[1] - b]), W([p[0] + b, p[1] + b]), W([p[0] - b, p[1] + b])], matL(0xffffff, true, 0.9), true));
}
// marker glyphs: □ endpoint, △ midpoint, ○ center, ✕ intersection, ◇ quadrant
function osnapMarker(w, kind, s) {
  const k = view.worldPerPixel(w) * 9, u = s.plane.u, v = s.plane.v;
  const P = (x, y) => new THREE.Vector3(w[0] + (u[0] * x + v[0] * y) * k, w[1] + (u[1] * x + v[1] * y) * k, w[2] + (u[2] * x + v[2] * y) * k);
  let pts, segs = false;
  if (kind === 'Mid') pts = [P(-1, -0.8), P(1, -0.8), P(0, 1)];
  else if (kind === 'Center') { pts = []; for (let i = 0; i < 24; i++) pts.push(P(Math.cos(i / 24 * Math.PI * 2), Math.sin(i / 24 * Math.PI * 2))); }
  else if (kind === 'Int') { pts = [P(-1, -1), P(1, 1), P(-1, 1), P(1, -1)]; segs = true; }
  else if (kind === 'Quad') pts = [P(0, -1), P(1, 0), P(0, 1), P(-1, 0)];
  else pts = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)];
  const g = new THREE.BufferGeometry().setFromPoints(pts), mat = new THREE.LineBasicMaterial({ color: 0xf2d50f, depthTest: false });
  const o = segs ? new THREE.LineSegments(g, mat) : new THREE.LineLoop(g, mat);
  o.renderOrder = 20; return o;
}
function marker(w, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 20), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
  m.position.set(...w); m.quaternion.copy(camera().quaternion); m.scale.setScalar(view.worldPerPixel(w) * 9); m.renderOrder = 20;
  return m;
}


// =====================================================================
// AutoCAD-style commands: edit-command state machines, prompts, typed input
// =====================================================================
export const EDIT_TOOLS = new Set(['text', 'hatch', 'ellipse', 'spline', 'move', 'copy', 'rotate', 'scale', 'mirror', 'offset', 'erase', 'explode', 'polygon', 'arrayrect', 'arraypolar', 'dist', 'id', 'angle', 'area', 'radius', 'list']);
const INQUIRY = new Set(['dist', 'id', 'angle', 'area', 'radius', 'list']);
export const lineOpts = { construction: false };
export const dimOpts = { mode: 'aligned' };
let result = null; // last measurement drawn in the viewport
const SELECT_FIRST = new Set(['move', 'copy', 'rotate', 'scale', 'mirror', 'erase', 'explode', 'list', 'arrayrect', 'arraypolar']);
export const acad = { polyBy: 'flats', polyRot: 0, offsetDist: null, polySides: 6, mirrorErase: false, textH: null, hatch: { pattern: 'ANSI31', scale: 1, angle: 0 } };
export const acceptsSpaces = () => st.cmd && st.cmd.tool === 'text' && st.cmd.stage === 'string';
function ensureCmd() {
  if (st.cmd && st.cmd.tool === tool()) return st.cmd;
  const t = tool();
  st.cmd = { tool: t, pts: [], stage: SELECT_FIRST.has(t) ? (S.ed.drawSel.size ? 'base' : 'select') : t === 'offset' ? 'distance' : t === 'polygon' ? 'center' : t === 'area' || t === 'spline' ? 'collect' : t === 'radius' || t === 'hatch' ? 'pick' : t === 'ellipse' ? 'center' : 'base' };
  if ((t === 'erase' || t === 'explode' || t === 'list' || t === 'arrayrect') && S.ed.drawSel.size) { runSelectionCommand(t); }
  if (t === 'scale' && S.ed.drawSel.size) st.cmd.op = startScale();
  return st.cmd;
}
// Outline: selected text becomes closed glyph curves (lines) that Extrude / Cut can emboss or engrave; the
// letters' filled regions come back selected, ready for Extrude
export async function outlineText() {
  const s = sk(); if (!s) return;
  const texts = [...S.ed.drawSel].map(id => SK.entById(s, id)).filter(e => e && e.t === 'text');
  if (!texts.length) return toast('Select some text first');
  let font; try { font = await K.textFont(); } catch (err) { return toast('Could not load the outline font'); }
  const inks = [], plan = texts.map(e => {
    const a = (e.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const T = q => [e.p[0] + q[0] * c - q[1] * sn, e.p[1] + q[0] * sn + q[1] * c];
    const loops = K.textContours(font, e.str, e.h).map(L => L.map(T));
    // filled areas: contours nested an even number of levels deep; a point just inside one edge, outside its holes
    const depth = L => loops.filter(M => M !== L && SK.pointInPoly(L[0], M)).length;
    loops.forEach(L => {
      const d = depth(L); if (d % 2) return;
      const holes = loops.filter(M => M !== L && depth(M) === d + 1 && SK.pointInPoly(M[0], L)), eps = e.h * 0.01;
      for (let i = 0; i < L.length; i++) {
        const A = L[i], B = L[(i + 1) % L.length], len = SK.d2(A, B); if (len < eps * 2) continue;
        const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], nrm = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
        const pt = [1, -1].map(sg => [m[0] + nrm[0] * eps * sg, m[1] + nrm[1] * eps * sg]).find(q => SK.pointInPoly(q, L) && !holes.some(hh => SK.pointInPoly(q, hh)));
        if (pt) { inks.push(pt); break; }
      }
    });
    return { e, loops };
  });
  if (!plan.some(p => p.loops.length)) return toast('That text has no letters to outline');
  runOp(F.sketchOp('Outline text', s.id, k => {
    for (const { e, loops } of plan) {
      k.ents = k.ents.filter(x => x.id !== e.id);
      // (marked as letter outlines: hundreds of short lines get no end-point squares, which made the letters a blob)
      for (const L of loops) for (let i = 0; i < L.length; i++) F.addEntity(k, { t: 'line', a: L[i].slice(), b: L[(i + 1) % L.length].slice(), glyph: true });
    }
  }));
  S.ed.drawSel = new Set(); S.ed.faces = []; S.ed.edges = [];
  S.ed.profiles = inks.map(pt => ({ sk: s.id, pt }));
  toast(`${inks.length} letter areas selected — Extrude to emboss, or Extrude into the body to engrave`);
  emit('selection');
}
/* a 2D Move/Rotate/Scale on selected curves (same tool names as the 3D gizmo) */
export const curveCmd = () => !!(st.cmd && st.cmd.tool === tool() && ['move', 'rotate', 'scale'].includes(tool()) && S.ed.drawSel.size);
export function startCommand() { st.cmd = null; if (EDIT_TOOLS.has(tool())) ensureCmd(); emit('drawcard'); view.render(); }
function pointStage() { const c = st.cmd; return c && ['base', 'second', 'center', 'vertex', 'first', 'side', 'p1', 'p2', 'collect', 'axis', 'other'].includes(c.stage); }
function fromPt() {
  if (st.start) return st.start;
  if (tool() === 'arc' && st.arc) return st.arc.c;
  const c = st.cmd; if (!c) return null;
  if (c.stage === 'second') return c.base;
  if (c.stage === 'vertex' || c.stage === 'axis' || c.stage === 'other') return c.center;
  if (c.stage === 'p1' || c.stage === 'p2') return c.base;
  if (c.stage === 'collect' && c.pts.length) return c.pts[c.pts.length - 1];
  return null;
}
export function lastPoint() { return fromPt() || st.last || [0, 0]; }
const selIds = () => [...S.ed.drawSel];
// Scale: the picked curves scale live about an origin — the middle of the pick (as Move goes from it), the sketch origin,
// or a point tapped on the canvas — by a factor that may be negative (then they also turn half a turn about the
// origin). Two fields on the card: Origin and Scale; a tap on the canvas sets the origin there.
const SCALE_ORIGINS = [['centre', 'Middle'], ['zero', 'Origin'], ['point', 'Tapped']]; // (the middle of the pick, the sketch's 0,0, a tapped point)
export const scaleOrigin = p => (p.origin === 'zero' ? [0, 0] : p.origin === 'point' ? [p.px, p.py] : [p.cx, p.cy]);
function startScale() {
  const s = sk(), ids = selIds(); if (!s || !ids.length) return null;
  const P = ids.flatMap(id => { const e = SK.entById(s, id); return e ? (SK.entPolyline(e)?.pts || SK.keyPoints(e).map(k => k.p)) : []; }); if (!P.length) return null;
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]), c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const def = F.sketchOp('Scale', s.id, (k, p) => {
    if (!(Math.abs(p.f) > 1e-12) || !isFinite(p.f)) return 'The scale cannot be 0';
    const r = SK.transformEntities(k, ids, { kind: 'scale', c: scaleOrigin(p), f: p.f }); if (typeof r === 'string') return r;
  }, [{ key: 'origin', label: 'Origin', kind: 'choice', options: SCALE_ORIGINS, wide: true }, { key: 'f', label: 'Scale', kind: 'num' }]);
  if (!runOp(def, { origin: 'centre', f: 1, cx: c[0], cy: c[1], px: c[0], py: c[1] }, { interactive: true })) return null;
  return getLast();
}
const scaleLive = c => c && c.tool === 'scale' && c.op && getLast() === c.op && !c.op.committed;
function xform(label, op, copy = false) {
  const s = sk(), ids = selIds();
  if (!ids.length) { toast('Nothing selected'); return; }
  runOp(F.sketchOp(label, s.id, k => { const r = SK.transformEntities(k, ids, op, copy); if (typeof r === 'string') return r; if (!copy) S.ed.drawSel = new Set(r); }));
}
function runSelectionCommand(t) {
  if (t === 'arrayrect') {
    const s = sk(), ids = selIds();
    const bb = ids.flatMap(id => SK.keyPoints(SK.entById(s, id)).map(k => k.p));
    const w = Math.max(...bb.map(p => p[0])) - Math.min(...bb.map(p => p[0])), hh = Math.max(...bb.map(p => p[1])) - Math.min(...bb.map(p => p[1]));
    const st0 = S.settings.snapStep, dx = Math.ceil((w * 1.5 || 10) / st0) * st0, dy = Math.ceil((hh * 1.5 || 10) / st0) * st0;
    S.ed.drawSel = new Set();
    const DIRS = [['pos', '+'], ['neg', '−'], ['both', 'Both ways']];
    runOp(F.sketchOp('ArrayRect', s.id, (k, p) => { const r = SK.arrayRect(k, ids, p.cols, p.rows, p.dx, p.dy, p.cdir, p.rdir); if (typeof r === 'string') return r; },
      [{ key: 'cols', label: 'Columns', kind: 'int', min: 1, max: 200 }, { key: 'rows', label: 'Rows', kind: 'int', min: 1, max: 200 }, { key: 'dx', label: 'Column spacing', kind: 'len' }, { key: 'dy', label: 'Row spacing', kind: 'len' },
        { key: 'cdir', label: 'Columns go (X)', kind: 'choice', options: DIRS, wide: true }, { key: 'rdir', label: 'Rows go (Y)', kind: 'choice', options: DIRS, wide: true }]),
    { cols: 3, rows: 2, dx, dy, cdir: 'pos', rdir: 'pos' });
    st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('cmd'); return;
  }
  if (t === 'list') { listSelection(); st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); return; }
  if (t === 'erase') { deleteSelected(); }
  else {
    const s = sk(), ids = selIds();
    runOp(F.sketchOp('Explode', s.id, k => { let n = 0; for (const e of k.ents.filter(x => ids.includes(x.id) && x.t === 'rect')) { SK.explodeRect(k, e); n++; } if (!n) return 'Nothing to explode (rectangles become lines)'; S.ed.drawSel = new Set(); }));
  }
  st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection');
}
function cmdPoint(p) {
  const c = ensureCmd(), t = c.tool;
  if (INQUIRY.has(t)) return inquiryPoint(c, p);
  if (t === 'text') {
    // (on a phone: tap where it starts, then type the text and its height on the card)
    if (c.stage === 'base') { c.base = p; c.stage = 'string'; acad.textH ??= defSize() / 8; emit('drawcard'); return; }
    if (c.stage === 'height') { acad.textH = Math.max(1e-6, SK.d2(c.base, p)); c.stage = 'string'; return; }
    return;
  }
  if (t === 'ellipse') {
    if (c.stage === 'center') { c.center = p; c.stage = 'axis'; return; }
    if (c.stage === 'axis') { if (SK.d2(p, c.center) < 1e-9) return; c.axis = p; c.stage = 'other'; return; }
    return placeEllipse(c, perpDist(c, p));
  }
  if (t === 'spline') {
    if (c.pts.length >= 3 && SK.d2(p, c.pts[0]) < 1e-9) return placeSpline(c, true);
    c.pts.push(p); return;
  }
  if (t === 'polygon') {
    if (c.stage === 'center') { c.center = p; c.stage = 'vertex'; }
    else if (c.stage === 'vertex') {
      const center = c.center, n = acad.polySides;
      const v = acad.polyBy === 'flats' ? polyCorner(center, SK.d2(center, p) * 2, Math.atan2(p[1] - center[1], p[0] - center[0]) * 180 / Math.PI, n) : p;
      editSketch(`Polygon (${n})`, k => { const r = SK.addPolygon(k, center, v, n); if (typeof r === 'string') return r; });
      c.stage = 'center';
    }
    return;
  }
  if (t === 'offset') {
    if (c.stage !== 'side') return;
    const eid = c.ent, d = acad.offsetDist;
    runOp(F.sketchOp('Offset', sk().id, k => { const e = SK.entById(k, eid); const r = SK.offsetEntity(k, e, d, p); if (typeof r === 'string') return r; }));
    c.stage = 'pick';
    return;
  }
  if (t === 'arraypolar' && c.stage === 'base') {
    const s = sk(), ids = selIds();
    S.ed.drawSel = new Set();
    runOp(F.sketchOp('ArrayPolar', s.id, (k, q) => { const r = SK.arrayPolar(k, ids, [q.cx, q.cy], q.count, q.angle); if (typeof r === 'string') return r; },
      [{ key: 'count', label: 'Items', kind: 'int', min: 2, max: 2000 }, { key: 'angle', label: 'Angle to fill', kind: 'ang' }, { key: 'cx', label: 'Centre X', kind: 'len' }, { key: 'cy', label: 'Centre Y', kind: 'len' }]),
    { count: 6, angle: 360, cx: p[0], cy: p[1] });
    st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('cmd'); return;
  }
  if (t === 'scale' && c.op) { // (the live Scale: a tap on the canvas puts its origin there)
    if (!scaleLive(c)) { st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); return; }
    updateOp({ origin: 'point', px: p[0], py: p[1] }); emit('lastop', getLast()); return;
  }
  if (c.stage === 'base') { c.base = p; c.stage = 'second'; return; }
  if (c.stage === 'second') {
    const b = c.base;
    if (t === 'move') { xform('Move', { kind: 'move', d: [p[0] - b[0], p[1] - b[1]] }); st.cmd = null; }
    else if (t === 'copy') { xform('Copy', { kind: 'move', d: [p[0] - b[0], p[1] - b[1]] }, true); /* multiple copies until Enter */ }
    else if (t === 'rotate') { xform('Rotate', { kind: 'rotate', c: b, deg: ang(b, p) / D }); st.cmd = null; }
    else if (t === 'scale') { const f = SK.d2(b, p); if (f < 1e-9) return toast('Scale factor must be > 0'); xform('Scale', { kind: 'scale', c: b, f }); st.cmd = null; }
    else if (t === 'mirror') { if (SK.d2(b, p) < 1e-9) return; xform('Mirror', { kind: 'mirror', a: b, b: p }, !acad.mirrorErase); st.cmd = null; }
    if (!st.cmd) { S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); }
  }
}
function cmdTap(s, raw, wpp) {
  const c = ensureCmd();
  if (c.tool === 'radius' || (c.tool === 'area' && c.stage === 'object')) return inquiryTap(c, s, raw, wpp);
  if (c.tool === 'hatch') {
    if (!SK.regionAt(s, raw)) return toast('Tap inside a closed area');
    const seed = raw.slice(), h = acad.hatch;
    runOp(F.sketchOp('Hatch', s.id, (k, q) => { Object.assign(acad.hatch, { pattern: q.pattern, scale: q.scale, angle: q.angle }); F.addEntity(k, { t: 'hatch', seed, pattern: q.pattern, scale: q.scale, angle: q.angle }); },
      [{ key: 'pattern', label: 'Pattern', kind: 'choice', options: [['ANSI31', 'ANSI31'], ['ANSI37', 'ANSI37'], ['NET', 'NET'], ['SOLID', 'SOLID']] }, { key: 'scale', label: 'Scale', kind: 'num' }, { key: 'angle', label: 'Angle', kind: 'ang' }]),
    { pattern: h.pattern, scale: h.scale, angle: h.angle });
    st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('cmd'); return;
  }
  if (c.stage === 'select') {
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (e) { S.ed.drawSel.has(e.id) ? S.ed.drawSel.delete(e.id) : S.ed.drawSel.add(e.id); emit('selection'); }
    return;
  }
  if (c.tool === 'offset' && (c.stage === 'pick' || c.stage === 'distance')) {
    if (acad.offsetDist == null) { toast('Type the offset distance first'); return; }
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if (!e) return toast('Tap a line, circle, arc or rectangle');
    c.ent = e.id; c.stage = 'side';
    S.ed.drawSel = new Set([e.id]); emit('selection');
  }
}
// Enter / Space in the command line, or the ⏎ button.
export function enter() {
  const t = tool(), c = st.cmd;
  if (['line', 'rect', 'circle', 'arc', 'dim', 'trim', 'extend', 'corner'].includes(t)) { resetTool(); S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); return true; } // Enter ends the command
  if (c && c.tool === 'area' && c.stage === 'collect' && c.pts.length >= 3) { reportArea(c.pts, c.ptsW); endInquiry(); return true; }
  if (c && c.tool === 'spline' && c.pts.length >= 2) { placeSpline(c, false); return true; }
  if (c && c.tool === 'text' && c.stage === 'height') { acad.textH ??= defSize() / 8; c.stage = 'string'; emit('drawcard'); return true; }
  if (c && c.stage === 'select') {
    if (!S.ed.drawSel.size) { toast('Select objects first'); return true; }
    if (t === 'erase' || t === 'explode') { runSelectionCommand(t); return true; }
    c.stage = 'base'; if (t === 'scale') c.op = startScale(); emit('drawcard'); return true;
  }
  if (c && (t === 'copy' || t === 'offset' || t === 'polygon') && ['second', 'pick', 'center'].includes(c.stage)) { resetTool(); S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); return true; }
  if (st.start || st.arc || st.dimA || st.dimPend || c) { resetTool(); return true; }
  return false;
}

// ---------- typed input: x,y · @dx,dy · @d<a · d<a · a bare number ----------
import { evalExpr } from './units.js';
export function typed(raw) {
  const str = raw.trim(); if (!str) return false;
  tapXY = null; // (a typed point is exactly what was typed: DIST / ID must not snap it to a body under an old tap)
  typedTarget();
  const t = tool(), c = st.cmd;
  const num = (x, kind = 'len') => evalExpr(x, kind);
  // options
  const up = str.toUpperCase();
  if (t === 'line' && (up === 'C' || up === 'CLOSE') && st.chain.length > 2) { placeLine(st.start, st.chain[0]); emit('drawcard'); view.render(); return true; }
  if (t === 'line' && st.start && (up === 'A' || up === 'ARC')) { st.arcMode = true; emit('drawcard'); return true; }
  if (t === 'line' && st.start && (up === 'L' || up === 'LINE') && st.arcMode) { st.arcMode = false; emit('drawcard'); return true; }
  if (t === 'spline' && c && (up === 'C' || up === 'CLOSE') && c.pts.length >= 3) { placeSpline(c, true); return true; }
  if (t === 'text' && c && c.stage === 'string') {
    const base = c.base, h = acad.textH ?? defSize() / 8;
    add('Text', { t: 'text', p: base, h, str: raw.trim(), rot: 0 });
    st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); return true;
  }
  if (t === 'text' && c && c.stage === 'height' && /^[\d.(]/.test(str)) { try { acad.textH = num(str); c.stage = 'string'; emit('drawcard'); } catch (err) { toast(err.message); } return true; }
  if (t === 'hatch' && ['ANSI31', 'ANSI37', 'NET', 'SOLID'].includes(up)) { acad.hatch.pattern = up; emit('drawcard'); return true; }
  if (t === 'ellipse' && c && c.stage === 'other' && /^[\d.(]/.test(str)) { try { placeEllipse(c, num(str)); } catch (err) { toast(err.message); } return true; }
  if (t === 'line' && (up === 'U' || up === 'UNDO') && st.chain.length > 1) { emit('undoRequest'); st.chain.pop(); st.start = st.chain[st.chain.length - 1]; if (st.chain.length < 2) st.chain = []; return true; }
  if (t === 'mirror' && c && (up === 'Y' || up === 'N' || up === 'YES' || up === 'NO')) { acad.mirrorErase = up[0] === 'Y'; toast(`Erase source: ${acad.mirrorErase ? 'Yes' : 'No'}`); return true; }
  if (t === 'corner' && (up === 'R' || up === 'RADIUS')) { return 'radius'; }
  if (t === 'area' && (up === 'O' || up === 'OBJECT')) { areaObjectMode(); return true; }
  if (t === 'circle' && st.start && (up === 'D' || up === 'DIAMETER')) { st.typed.dia = true; toast('Type the diameter'); return true; }
  try {
    // coordinates
    const m = str.match(/^(@)?\s*([^,<]+?)\s*([,<])\s*(.+)$/);
    if (m) {
      const rel = !!m[1], a = num(m[2]), base = rel ? lastPoint() : [0, 0];
      const p = m[3] === ',' ? [base[0] + a, base[1] + num(m[4])] : [base[0] + a * ecos(num(m[4], 'ang')), base[1] + a * esin(num(m[4], 'ang'))];
      st.preview = p; st.snap = { p, kind: '' };
      commitPoint(p);
      return true;
    }
    // a single value: meaning depends on the prompt
    if (t === 'polygon' && c && (c.stage === 'sides' || (c.stage === 'center' && /^\s*\d+\s*$/.test(str)))) { acad.polySides = Math.round(num(str, 'num')); c.stage = 'center'; emit('drawcard'); return true; }
    if (t === 'offset' && c && (c.stage === 'distance' || c.stage === 'pick')) { acad.offsetDist = num(str); c.stage = 'pick'; emit('drawcard'); return true; }
    if (t === 'corner') { corner.size = num(str); emit('drawcard'); return true; }
    if (c && c.stage === 'second' && t === 'rotate') { xform('Rotate', { kind: 'rotate', c: c.base, deg: num(str, 'ang') }); st.cmd = null; S.ed.tool = 'select'; emit('selection'); return true; }
    if (scaleLive(c)) { const f = num(str, 'num'); if (!(Math.abs(f) > 1e-12)) { toast('The scale cannot be 0'); return true; } updateOp({ f }); emit('lastop', getLast()); return true; }
    if (c && c.stage === 'second' && t === 'scale') { xform('Scale', { kind: 'scale', c: c.base, f: num(str, 'num') }); st.cmd = null; S.ed.tool = 'select'; emit('selection'); return true; }
    if (t === 'circle' && st.start) { const v = num(str); placeCircle(st.start, st.typed.dia ? v / 2 : v); st.typed = {}; emit('drawcard'); view.render(); return true; }
    if (t === 'arc' && st.arc && st.arc.r != null) { placeArc(st.arc.c, st.arc.r, st.arc.a0, num(str, 'ang')); emit('drawcard'); view.render(); return true; }
    if (t === 'arc' && st.arc && st.arc.r == null) { st.arc.r = num(str); st.arc.a0 = st.preview ? ang(st.arc.c, st.preview) : 0; emit('drawcard'); view.render(); return true; }
    // direct distance entry along the rubber band
    const from = fromPt();
    if (from) {
      const d = num(str), pv = st.preview && SK.d2(st.preview, from) > 1e-12 ? st.preview : [from[0] + 1, from[1]];
      const L = SK.d2(pv, from), p = [from[0] + (pv[0] - from[0]) / L * d, from[1] + (pv[1] - from[1]) / L * d];
      const rp = [Math.round(p[0] * 1e9) / 1e9, Math.round(p[1] * 1e9) / 1e9];
      st.preview = rp; commitPoint(rp);
      return true;
    }
  } catch (err) { toast(err.message || 'Invalid input'); return true; }
  return false;
}

// ---------- prompts (AutoCAD wording) ----------
export function prompt() {
  const t = tool(), c = st.cmd, o = [];
  const name = { text: 'TEXT', hatch: 'HATCH', ellipse: 'ELLIPSE', spline: 'SPLINE', arrayrect: 'ARRAYRECT', arraypolar: 'ARRAYPOLAR', dist: 'DIST', id: 'ID', angle: 'MEASUREGEOM', area: 'AREA', radius: 'MEASUREGEOM', list: 'LIST', line: 'LINE', rect: 'RECTANG', circle: 'CIRCLE', arc: 'ARC', trim: 'TRIM', extend: 'EXTEND', dim: dimOpts.mode === 'linear' ? 'DIMLINEAR' : 'DIM', corner: corner.kind === 'fillet' ? 'FILLET' : 'CHAMFER', move: 'MOVE', copy: 'COPY', rotate: 'ROTATE', scale: 'SCALE', mirror: 'MIRROR', offset: 'OFFSET', erase: 'ERASE', explode: 'EXPLODE', polygon: 'POLYGON' }[t];
  let txt;
  if (!name) return { text: 'Command:', options: [] };
  if (t === 'line') { txt = st.start ? (st.arcMode ? 'Specify end point of arc (tangent) or' : 'Specify next point or') : 'Specify first point:'; if (st.start) { o.push(st.arcMode ? ['Line', 'L'] : ['Arc', 'A']); if (st.chain.length > 2) o.push(['Close', 'C']); if (st.chain.length > 1) o.push(['Undo', 'U']); } }
  else if (t === 'text') { const cc = c || { stage: 'base' }; txt = cc.stage === 'base' ? 'Specify start point of text:' : cc.stage === 'height' ? `Specify height <${fmtLen(acad.textH ?? defSize() / 8)}>:` : 'Enter text, then Enter:'; }
  else if (t === 'hatch') { txt = `Pick internal point (pattern ${acad.hatch.pattern}) or`; for (const p of ['ANSI31', 'ANSI37', 'NET', 'SOLID']) if (p !== acad.hatch.pattern) o.push([p, p]); }
  else if (t === 'ellipse') { const cc = c || { stage: 'center' }; txt = cc.stage === 'center' ? 'Specify center of ellipse:' : cc.stage === 'axis' ? 'Specify endpoint of axis:' : 'Specify distance to other axis:'; }
  else if (t === 'spline') { const n = c ? c.pts.length : 0; txt = n ? 'Enter next point or Enter to finish, or' : 'Specify first point:'; if (n >= 3) o.push(['Close', 'C']); }
  else if (t === 'rect') txt = st.start ? 'Specify other corner point (or @width,height):' : 'Specify first corner point:';
  else if (t === 'circle') { txt = st.start ? 'Specify radius of circle or' : 'Specify center point for circle:'; if (st.start) o.push(['Diameter', 'D']); }
  else if (t === 'arc') txt = !st.arc ? 'Specify center point of arc:' : st.arc.r == null ? 'Specify start point of arc:' : 'Specify end point of arc (CCW) or angle:';
  else if (t === 'trim') txt = 'Select object to trim:';
  else if (t === 'extend') txt = 'Select object to extend:';
  else if (t === 'dim') { txt = !st.dimPend ? 'Select a line, circle, arc or point:' : st.dimPend.kind === 'pt' ? 'Select a second point or a line:' : 'Specify dimension location (or select a line or point):'; }
  else if (t === 'corner') { txt = `Select corner (${corner.kind === 'fillet' ? 'radius' : 'distance'} = ${fmtLen(corner.size ?? defSize() / 10)}) or`; o.push([corner.kind === 'fillet' ? 'Radius' : 'Distance', 'R']); }
  else if (INQUIRY.has(t)) {
    const cc = c || { stage: t === 'area' ? 'collect' : t === 'radius' ? 'pick' : t === 'list' ? 'select' : 'base', pts: [] };
    if (t === 'dist') txt = cc.stage === 'base' ? 'Specify first point:' : 'Specify second point:';
    else if (t === 'id') txt = 'Specify point:';
    else if (t === 'angle') txt = cc.stage === 'base' ? 'Specify angle vertex:' : cc.stage === 'p1' ? 'Specify first angle endpoint:' : 'Specify second angle endpoint:';
    else if (t === 'radius') txt = 'Select arc or circle:';
    else if (t === 'list') txt = `Select objects (${S.ed.drawSel.size} found), then Enter:`;
    else if (cc.stage === 'object') txt = 'Select a circle, rectangle or tap inside a region:';
    else { txt = cc.pts.length < 3 ? `Specify ${cc.pts.length ? 'next' : 'first'} corner point or` : 'Specify next point or Enter for total, or'; o.push(['Object', 'O']); }
    if (['dist', 'angle', 'area', 'radius'].includes(t)) for (const [l, v] of [['Distance', 'MD'], ['Radius', 'MR'], ['Angle', 'MA'], ['Area', 'MAR']]) if (v !== { dist: 'MD', radius: 'MR', angle: 'MA', area: 'MAR' }[t]) o.push([l, v]);
  }
  else {
    const cc = c || { stage: SELECT_FIRST.has(t) ? (S.ed.drawSel.size ? 'base' : 'select') : t === 'offset' ? 'distance' : 'sides' };
    if (cc.stage === 'select') txt = `Select objects (${S.ed.drawSel.size} found), then Enter:`;
    else if (t === 'polygon') txt = cc.stage === 'sides' ? `Enter number of sides <${acad.polySides}>:` : cc.stage === 'center' ? `Specify center of polygon (or type sides <${acad.polySides}>):` : 'Specify radius (vertex point):';
    else if (t === 'offset') txt = cc.stage === 'distance' ? `Specify offset distance${acad.offsetDist != null ? ` <${fmtLen(acad.offsetDist)}>` : ''}:` : cc.stage === 'pick' ? 'Select object to offset or Enter to exit:' : 'Specify point on side to offset:';
    else if (t === 'mirror') { txt = cc.stage === 'base' ? 'Specify first point of mirror line:' : 'Specify second point of mirror line:'; o.push([`Erase source: ${acad.mirrorErase ? 'Yes' : 'No'}`, acad.mirrorErase ? 'N' : 'Y']); }
    else if (t === 'arraypolar' && cc.stage === 'base') txt = 'Specify center point of array:';
    else if (cc.stage === 'base') txt = 'Specify base point:';
    else txt = t === 'rotate' ? 'Specify rotation angle:' : t === 'scale' ? 'Specify scale factor:' : t === 'copy' ? 'Specify second point or Enter to exit:' : 'Specify second point:';
  }
  if (!o.length) txt = txt.replace(/ or$/, ':');
  return { text: `${name} ${txt}`, options: o };
}


// ---------- inquiry commands: DIST, ID, MEASUREGEOM (angle, area, radius), LIST ----------
let lastLog = '';
const log = t => { lastLog = t; emit('cmdlog', t); };
const f4 = v => fmtLen(v, false);
function endInquiry() {
  // (the result shows in the HUD, which keeps it until the next tap: a toast with the same numbers covered the view tools)
  S.ed.inquiry = lastLog || null; // (and it stays in the HUD until the next tap or tool)
  st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection'); }
function inquiryPoint(c, p) {
  const t = c.tool, s = sk();
  // on a body, ID and DIST use the 3D point on it (not the drawing plane under it)
  const w3 = (t === 'id' || t === 'dist' || t === 'angle' || t === 'area') && solidPointAt && tapXY ? solidPointAt(...tapXY) : null;
  const W = w3 || SK.toW(s.plane, p), P2 = w3 ? SK.toP(s.plane, w3) : p;
  if (t === 'id') {
    log(`ID  X = ${f4(W[0])}  Y = ${f4(W[1])}  Z = ${f4(W[2])}${w3 ? '   (on a body)' : `   (sketch ${f4(p[0])}, ${f4(p[1])})`}`);
    result = { type: 'pt', pts: [P2], text: `${f4(W[0])}, ${f4(W[1])}, ${f4(W[2])}` };
    return endInquiry();
  }
  if (t === 'dist') {
    if (c.stage === 'base') { c.base = P2; c.baseW = W; c.stage = 'second'; return; }
    const d = [W[0] - c.baseW[0], W[1] - c.baseW[1], W[2] - c.baseW[2]], L = Math.hypot(...d);
    const a = ((Math.atan2(d[1], d[0]) * 180 / Math.PI) + 360) % 360;
    log(`DIST  Distance = ${fmtLen(L)},  Angle in XY plane = ${fmtAng(a)},  ΔX = ${f4(d[0])},  ΔY = ${f4(d[1])},  ΔZ = ${f4(d[2])}`);
    result = { type: 'dist', pts: [c.base, P2], text: fmtLen(L) };
    return endInquiry();
  }
  // (Angle and Area take the 3D points tapped on a body, like Distance: flattened onto the drawing plane, a 90° corner
  // on a wall read 131.19°)
  if (t === 'angle') {
    if (c.stage === 'base') { c.base = P2; c.baseW = W; c.stage = 'p1'; return; }
    if (c.stage === 'p1') { c.p1 = P2; c.p1W = W; c.stage = 'p2'; return; }
    const a = c.p1W.map((v, i) => v - c.baseW[i]), b = W.map((v, i) => v - c.baseW[i]);
    const la = Math.hypot(...a), lb = Math.hypot(...b); if (la < 1e-12 || lb < 1e-12) return toast('Tap three different points');
    const ang = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)))) * 180 / Math.PI;
    log(`MEASUREGEOM  Angle = ${fmtAng(ang)}   (supplement ${fmtAng(180 - ang)})`);
    result = { type: 'angle', pts: [c.base, c.p1, P2], w: [c.baseW, c.p1W, W], text: fmtAng(ang) };
    return endInquiry();
  }
  if (t === 'area') {
    c.ptsW ??= [];
    // the first corner tapped again closes the outline
    if (c.pts.length >= 3 && Math.hypot(...W.map((v, i) => v - c.ptsW[0][i])) < view.worldPerPixel(W) * 14) { reportArea(c.pts, c.ptsW); return endInquiry(); }
    c.pts.push(P2); c.ptsW.push(W); emit('drawcard'); return;
  }
}
// a polygon's area and perimeter from its 3D corners (Newell's normal), or the drawing plane's 2D ones
function reportArea(pts, ptsW) {
  let area, perimeter;
  if (ptsW && ptsW.length === pts.length) {
    const n = [0, 0, 0]; perimeter = 0;
    for (let i = 0; i < ptsW.length; i++) { const a = ptsW[i], b = ptsW[(i + 1) % ptsW.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); perimeter += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
    area = Math.hypot(...n) / 2;
  } else ({ area, perimeter } = SK.polygonArea(pts));
  log(`AREA  Area = ${fmtArea(area)},  Perimeter = ${fmtLen(perimeter)}`);
  result = { type: 'area', pts, w: ptsW, text: fmtArea(area) };
}
function inquiryTap(c, s, raw, wpp) {
  if (c.tool === 'radius') {
    const e = SK.pickEntity(s, raw, 16 * wpp);
    if ((!e || (e.t !== 'circle' && e.t !== 'arc')) && solidCircleAt && tapXY) {
      const sc = solidCircleAt(...tapXY);
      if (sc) {
        log(`MEASUREGEOM  Radius = ${fmtLen(sc.r)},  Diameter = ${fmtLen(2 * sc.r)}${sc.closed ? `,  Circumference = ${fmtLen(2 * Math.PI * sc.r)}` : `,  Arc length = ${fmtLen(sc.len)}`}  (body edge)`);
        result = { type: 'pt', pts: [SK.toP(s.plane, sc.c)], text: `R ${fmtLen(sc.r)}` };
        return endInquiry();
      }
    }
    if (!e || (e.t !== 'circle' && e.t !== 'arc')) return toast('Tap a circle or arc (a sketch curve or a round body edge)');
    log(`MEASUREGEOM  Radius = ${fmtLen(e.r)},  Diameter = ${fmtLen(2 * e.r)}${e.t === 'arc' ? `,  Arc length = ${fmtLen(e.r * SK.sweep(e))}` : `,  Circumference = ${fmtLen(2 * Math.PI * e.r)}`}`);
    result = { type: 'pt', pts: [e.c], text: `R ${fmtLen(e.r)}` };
    return endInquiry();
  }
  // AREA Object: an exact closed entity under the finger, else the region containing the tap
  const e = SK.pickEntity(s, raw, 12 * wpp), ea = e && (e.t === 'circle' || e.t === 'rect') ? SK.entityArea(e) : null;
  if (ea) { log(`AREA  Area = ${fmtArea(ea.area)},  ${e.t === 'circle' ? 'Circumference' : 'Perimeter'} = ${fmtLen(ea.perimeter)}`); result = { type: 'pt', pts: [raw], text: fmtArea(ea.area) }; return endInquiry(); }
  const r = SK.regionAt(s, raw);
  if (!r) return toast('Tap inside a closed region');
  const { area, perimeter } = SK.regionArea(r);
  log(`AREA  Region area = ${fmtArea(area)},  Perimeter = ${fmtLen(perimeter)}${r.holes.length ? `  (${r.holes.length} hole${r.holes.length > 1 ? 's' : ''} subtracted)` : ''}`);
  result = { type: 'area', pts: r.outer, text: fmtArea(area) };
  endInquiry();
}
export function areaObjectMode() { const c = ensureCmd(); if (c.tool === 'area') { c.stage = 'object'; emit('drawcard'); } }
function listSelection() {
  const s = sk();
  for (const id of S.ed.drawSel) {
    const e = SK.entById(s, id); if (!e) continue;
    if (e.t === 'line') log(`LIST  LINE  from ${f4(e.a[0])},${f4(e.a[1])}  to ${f4(e.b[0])},${f4(e.b[1])}  Length = ${fmtLen(SK.d2(e.a, e.b))}  Angle = ${fmtAng(((Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180 / Math.PI) + 360) % 360)}`);
    else if (e.t === 'circle') log(`LIST  CIRCLE  center ${f4(e.c[0])},${f4(e.c[1])}  Radius = ${fmtLen(e.r)}  Circumference = ${fmtLen(2 * Math.PI * e.r)}  Area = ${fmtArea(Math.PI * e.r * e.r)}`);
    else if (e.t === 'arc') log(`LIST  ARC  center ${f4(e.c[0])},${f4(e.c[1])}  Radius = ${fmtLen(e.r)}  Start = ${fmtAng(e.a0 * 180 / Math.PI)}  Sweep = ${fmtAng(SK.sweep(e) * 180 / Math.PI)}  Length = ${fmtLen(e.r * SK.sweep(e))}`);
    else if (e.t === 'rect') log(`LIST  RECTANGLE  corner ${f4(e.x)},${f4(e.y)}  ${fmtLen(e.w)} × ${fmtLen(e.h)}  Area = ${fmtArea(e.w * e.h)}  Perimeter = ${fmtLen(2 * (e.w + e.h))}`);
  }
}
function drawResult(s, W) {
  const m = matL(0x6fe0a0, true, 0.95);
  const P = result.pts, Q = result.w && result.w.length === P.length ? result.w : P.map(W); // (the 3D points, when tapped on a body)
  if (result.type === 'dist') previewGroup.add(lineObj(P.map(W), m));
  if (result.type === 'angle') previewGroup.add(lineObj([Q[1], Q[0], Q[2]], m));
  if (result.type === 'area') previewGroup.add(lineObj(Q, m, true));
  const at = result.type === 'area' ? [0, 1, 2].map(k => Q.reduce((a, q) => a + q[k], 0) / Q.length) : result.type === 'dist' ? W([(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2]) : Q[0];
  view.label(at, result.text, 'measure');
}


// ---------- ELLIPSE, SPLINE, PLINE arcs ----------
function perpDist(c, p) {
  const L = SK.d2(c.center, c.axis), u = [(c.axis[0] - c.center[0]) / L, (c.axis[1] - c.center[1]) / L];
  return Math.abs((p[0] - c.center[0]) * -u[1] + (p[1] - c.center[1]) * u[0]);
}
function placeEllipse(c, ry) {
  const rx = SK.d2(c.center, c.axis);
  if (!(ry > 1e-9)) return toast('Other axis must be > 0');
  add('Ellipse', { t: 'ellipse', c: c.center, rx, ry, rot: ang(c.center, c.axis) });
  st.cmd = null; ensureCmd(); emit('drawcard'); view.render();
}
function placeSpline(c, closed) {
  add('Spline', { t: 'spline', pts: c.pts.map(q => q.slice()), ...(closed ? { closed: true } : {}) });
  st.cmd = null; S.ed.tool = 'select'; S.ed.tools.draw = 'select'; emit('selection');
}
// arc from S to E tangent to the previous segment (AutoCAD PLINE arc mode)
function tangentArc(S0, E) {
  const t = st.lastDir || [1, 0], n = [-t[1], t[0]], d = [E[0] - S0[0], E[1] - S0[1]];
  const den = 2 * (n[0] * d[0] + n[1] * d[1]);
  if (Math.abs(den) < 1e-12) return null;
  const r = (d[0] * d[0] + d[1] * d[1]) / den, C = [S0[0] + n[0] * r, S0[1] + n[1] * r];
  const as = ang(C, S0), ae = ang(C, E);
  return r > 0 ? { t: 'arc', c: C, r, a0: as, a1: ae, ccw: true } : { t: 'arc', c: C, r: -r, a0: ae, a1: as, ccw: false };
}
function placeTangentArc(a, b) {
  const g = tangentArc(a, b);
  if (!g) { st.arcMode = false; placeLine(a, b); st.arcMode = true; return; }
  const ccw = g.ccw; delete g.ccw;
  add('Arc', g);
  const v = [b[0] - g.c[0], b[1] - g.c[1]], L = Math.hypot(v[0], v[1]);
  st.lastDir = ccw ? [-v[1] / L, v[0] / L] : [v[1] / L, -v[0] / L];
  if (!st.chain.length) st.chain.push(a);
  st.chain.push(b); st.start = b; st.typed = {};
}


// text rendered as a textured quad in the sketch plane (scales with the drawing, like AutoCAD text)
function textMesh(s, e, color) {
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d'), fs = 96;
  ctx.font = `${fs}px ui-monospace, Menlo, monospace`;
  const w = Math.max(8, Math.ceil(ctx.measureText(e.str || ' ').width));
  cv.width = w; cv.height = Math.ceil(fs * 1.25);
  ctx.font = `${fs}px ui-monospace, Menlo, monospace`; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic';
  ctx.fillText(e.str, 0, fs);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const H = e.h * 1.25 / 0.72, Wd = H * cv.width / cv.height; // cap height ≈ 0.72 em
  const a = (e.rot || 0) * Math.PI / 180, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]], down = e.h * (fs * 1.25 - fs) / (fs * 0.72);
  const P = (x, y) => SK.toW(s.plane, [e.p[0] + u[0] * x + v[0] * (y - down), e.p[1] + u[1] * x + v[1] * (y - down)]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...P(0, 0), ...P(Wd, 0), ...P(Wd, H), ...P(0, H)], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide }));
}

// polygon corner for a size measured across the flats; the first flat faces direction `rotDeg`
function polyCorner(c, acrossFlats, rotDeg, n) {
  const R = acrossFlats / 2 / Math.cos(Math.PI / n), a = (rotDeg + 180 / n) * Math.PI / 180;
  return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
}

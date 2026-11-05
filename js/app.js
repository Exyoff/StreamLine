// StreamLine — app wiring: selection, modes, panels, menus, persistence.
import * as THREE from 'three';
import { S, on, emit, activeObj, selectedObjs, objById, loadSettings, saveSettings, isShown } from './state.js';
import * as H from './history.js';
import * as K from './kernel.js';
import * as PJ from './projects.js';
import * as LIB from './library.js';
import * as BR from './browser.js';
import { view, camera } from './viewport.js';
import { initGizmo, gizmoActive, valueTap, valueHit, typeKey, gizmoPartAt } from './gizmo.js';
import * as OPS from './operators.js';
import { runOp, undo, redo, canUndo, canRedo, getLast, clearLast, updateOp, resetHistory, mergeLastUndo } from './ops.js';
import { serialize, deserialize, newObject, xfFor, worldVerts, objMatrix } from './scene.js';
import * as M from './mesh.js';
import { fmtLen, fmtAng, fmtArea, fmtNum, unitFactor, evalExpr } from './units.js';
import { I } from './icons.js';
import { $, h, toast, field, choice, toggle, stepper, popover, closePopover, menuItem, closeKeypad, keypadOpen, keypadKey } from './ui.js';
import * as IO from './io.js';
import * as SK from './sketch.js';
import * as F from './features.js';
import * as Draw from './draw.js';
import * as Cmd from './cmdline.js';
import { findRegion, faceRegion, faceLoops } from './modifiers.js';
import { featureEdges, straightRun, edgeLoop } from './edges.js';
H.registerOps('F.', F); H.setPostSolve(recs => F.solveMates(recs)); H.registerOps('O.', OPS); H.registerFactory('setMedianOp', OPS.setMedianOp);

const DOC_KEY = 'streamline.doc.v1';

// iOS Safari: its bottom toolbar can cover the bottom of the page (the layout viewport runs underneath it). Measure
// the part of the window that is really visible and lift the bottom controls by what is hidden (--vvb, added to
// the safe-area inset). Not while typing: the on-screen keyboard is not a bar to dodge.
// Installed on the Home Screen (standalone), iOS can lay the page out shorter than the screen (by about the status
// bar's height) and leave a black bar below it: size the page to the whole screen there (--fullH).
const standalone = () => !!navigator.standalone || matchMedia('(display-mode: standalone)').matches;
function fitStandalone() {
  const de = document.documentElement;
  if (!standalone()) { de.style.removeProperty('--fullH'); return; }
  const portrait = innerHeight >= innerWidth, sh = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const gap = sh - innerHeight;
  if (gap > 0 && gap < 140) de.style.setProperty('--fullH', sh + 'px'); else de.style.removeProperty('--fullH');
}
function fitVisibleViewport() {
  fitStandalone();
  const vv = window.visualViewport; if (!vv) return;
  if (standalone()) { document.documentElement.style.setProperty('--vvb', '0px'); return; } // (no Safari toolbar there)
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  const hidden = typing || vv.scale > 1.01 ? 0 : Math.max(0, Math.round(document.documentElement.clientHeight - vv.height - vv.offsetTop));
  document.documentElement.style.setProperty('--vvb', Math.min(hidden, 140) + 'px');
}
window.visualViewport?.addEventListener('resize', fitVisibleViewport);
window.visualViewport?.addEventListener('scroll', fitVisibleViewport);
window.addEventListener('orientationchange', () => setTimeout(fitVisibleViewport, 300));
window.addEventListener('resize', fitVisibleViewport);
fitVisibleViewport();
const AXC = ['ax-x', 'ax-y', 'ax-z'];

// =====================================================================
// boot
// =====================================================================
async function boot() {
  loadSettings(); applyTheme();
  // the exact-geometry kernel (OpenCascade, WebAssembly) loads first; it is cached for offline use
  try { await K.initKernel(); K.setMatrixFn(objMatrix); }
  catch (err) { console.error(err); $('#boot').querySelector('p').textContent = 'Could not load the CAD kernel — check your connection and reload.'; return; }
  $('#boot').classList.add('done'); setTimeout(() => $('#boot').remove(), 400);
  view.init($('#viewport'));
  view.initNav($('#nav'));
  initGizmo();
  Draw.initDraw();
  routeDrag();
  Cmd.initCmdline({ setTool: cmdSetTool, setWorkspace, runOp, undo, redo, F, refresh: () => refresh(), zoomAll: () => view.frame(S.doc.objects.flatMap(worldVerts).concat(sketchPoints())), exportDXF: () => exportDXF() });
  initMeasureOverlay();
  buildStatic();
  if (!(await loadAutosave())) defaultScene();
  S.ed.workspace = 'model'; // the studio: one 3D space for curves, regions and solids
  resetHistory();
  bindEvents();
  // what Frame should keep clear: the tool rail on the left, the top bar, and the controls along the bottom
  view.insets = () => {
    const vr = $('#viewport').getBoundingClientRect(), vis = el => el && !el.hidden && el.offsetParent !== null && el.getBoundingClientRect();
    const rail = vis($('#toolrail')), top = vis($('#topbar')), tl = vis($('#timeline')) || vis($('#skbar')), zb = vis($('#zoombar'));
    const l = rail && rail.left < vr.width / 2 ? rail.right - vr.left : 0;
    // (the top bar and the history timeline under it; the draw card shifts the picture itself, see renderLastOp)
    const hudEl = $('#hud'), hud = vis(hudEl), hb = hud && hudEl.textContent.trim() ? hud.bottom - vr.top : 0; // (and the HUD's lines under them)
    const t = Math.max(top ? top.bottom - vr.top : 0, tl ? tl.bottom - vr.top : 0, hb);
    const r = zb && zb.left > vr.width / 2 ? vr.right - zb.left : 0; // the zoom bar on the right
    // (the cube and view tools ride up above the command line when it is open: they still keep the model clear)
    const bottoms = ['#stationbar', '#vtools-r', '#nav', '#lastop', '#cmdbar'].map(q => vis($(q))).filter(Boolean).map(r => r.top - vr.top).filter(y => y > vr.height * 0.3);
    const b = bottoms.length ? vr.bottom - vr.top - Math.min(...bottoms) : 0;
    return { l: Math.max(0, l), r: Math.max(0, r), t: Math.max(0, t), b: Math.max(0, b) };
  };
  PJ.initProjects({
    view, refresh: () => refresh(), renderSheet: () => { if (sheetOpen) renderSheet(); },
    newScene: () => newScene(), closeSheet: () => toggleSheet(false), saveLocal: () => saveLocalNow(),
    afterLoad: () => { S.ed.cplane = null; S.ed.planePick = null; S.ed.drawSel = new Set(); S.ed.edges = []; S.ed.faces = []; S.ed.profiles = []; S.ed.isolate = null; S.ed.mateFrom = null; S.ed.editingSketch = null; Draw.clearTarget(); Draw.resetTool(); S.ed.workspace = 'model'; S.ed.tool = 'select'; view.markSelDirty(); refresh(); view.cam.lock2D = false; view.frame(S.doc.objects.flatMap(worldVerts).concat(allSketchPoints())); if (sheetOpen) renderSheet(); scheduleSave(); },
  });
  PJ.ensureProject();
  // in iOS Safari (not installed) its toolbar takes the bottom of the screen: say once how to get it full screen
  try {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches && !localStorage.getItem('streamline.tip.a2hs')) {
      localStorage.setItem('streamline.tip.a2hs', '1');
      setTimeout(() => toast('Tip: Share → Add to Home Screen opens StreamLine full screen, without Safari’s bar', 4500), 2500);
    }
  } catch (e) {}
  on('library', () => refreshSoon());
  BR.initBrowser({
    closePanel() { if (sheetOpen && !document.body.classList.contains('sheet-docked')) toggleSheet(false); },
    editingStepId: () => getLast()?.def?.stepId,
    activateSketch,
    selectionChanged,
    selectObj(id) { if (S.ed.mode === 'edit') setMode('object'); setPickKind('solid'); if (S.ed.multi) S.ed.selected.add(id); else S.ed.selected = new Set([id]); S.ed.active = id; selectionChanged(); },
    refresh: () => refresh(),
    planeKey: () => planeLabel(),
    // a tap on an origin plane starts a sketch on it (Fusion's Create Sketch from the browser)
    setPlane(k) { if (S.ed.planePick == null) S.ed.planePick = { tool: null }; createSketchOn({ plane: k }); },
    deleteObj(id) { setPickKind('solid'); S.ed.selected = new Set([id]); S.ed.active = id; runOp(OPS.deleteObjs); },
    isolateObj(id) { setPickKind('solid'); S.ed.selected = new Set([id]); S.ed.active = id; isolate(true); },
    setSetting(k, v) { S.settings[k] = v; saveSettings(); view.render(); refresh(); },
  });
  S.ed.tool = S.ed.tool && TOOLS.model.some(t => t[0] === S.ed.tool) ? S.ed.tool : 'select';
  refresh();
  view.cam.ortho = false; view.cam.lock2D = false;
  view.frame(S.doc.objects.flatMap(worldVerts).concat(allSketchPoints()));
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/localhost|127\.0\.0\.1/.test(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
function defaultScene() {
  S.doc.objects = []; S.doc.sketches = []; S.doc.nextId = 1;
  S.doc.history = []; S.doc.marker = null; S.doc.gonePres = {}; S.doc.components = {}; S.doc.layers = [{ id: 1, name: 'Default', visible: true }]; S.doc.layer = 1;
  S.ed.tools = { draw: 'line', cad: 'select', model: 'select' };
  S.ed.workspace = 'model'; S.ed.tool = 'select'; S.ed.sketch = null;
}
function allSketchPoints() { return (S.doc.sketches || []).filter(isShown).flatMap(k => k.ents.flatMap(e => SK.keyPoints(e).map(q => SK.toW(k.plane, q.p)))); }
const GIZMO_TOOLS = new Set(['move', 'rotate', 'scale', 'measure', 'edge']);
const isGizmoTool = t => GIZMO_TOOLS.has(t) && !Draw.curveCmd();
const studioDraws = () => S.ed.workspace === 'model' && S.ed.mode === 'object' && !isGizmoTool(S.ed.tool);

// ---------- drag routing: gizmo first, then drawing tools ----------
function routeDrag() {
  const gz = { start: view.handlers.dragStart, move: view.handlers.dragMove, end: view.handlers.dragEnd, cancel: view.handlers.dragCancel };
  let owner = null;
  view.handlers.dragStart = (x, y, e) => {
    if (keypadOpen()) closeKeypad(false);
    if (gz.start(x, y, e)) { owner = gz; return true; }
    if ((S.ed.workspace === 'draw' || studioDraws()) && !S.ed.pickFace && Draw.down(x, y, e)) { owner = 'draw'; return true; }
    return false;
  };
  view.handlers.dragMove = (x, y, e) => (owner === 'draw' ? Draw.move(x, y) : owner && owner.move(x, y, e));
  view.handlers.dragEnd = () => { let r; if (owner === 'draw') Draw.up(); else if (owner) r = owner.end(); owner = null; return r; };
  view.handlers.dragCancel = () => { if (owner === 'draw') Draw.cancelPress(); else if (owner) owner.cancel(); owner = null; };
  view.handlers.hover = (x, y) => Draw.hover(x, y);
}

// ---------- workspaces ----------
function enterSketchView(sk, instant) {
  view.cam.lock2D = true;
  // look straight at the sketch, framing what is drawn on it
  const pts = sk.ents.filter(e => e.t !== 'dim').flatMap(e => SK.keyPoints(e).map(k => SK.toW(sk.plane, k.p)));
  if (!pts.length) { view.lookAlong(sk.plane.n, sk.plane.o); return; }
  const b = new THREE.Box3(); pts.forEach(q => b.expandByPoint(new THREE.Vector3(...q)));
  const rad = Math.max(5, b.getSize(new THREE.Vector3()).length() / 2);
  const { w, h: hh } = view.size(), fitW = Math.max(1, hh / Math.max(1, w - 170)); // narrow screens: fit the width beside the rail
  view.lookAlong(sk.plane.n, b.getCenter(new THREE.Vector3()).toArray(), rad * (S.ed.editingSketch != null ? 3.4 : 3.2) * fitW);
}
function setWorkspace(ws, pick) {
  if (ws === 'draw' || ws === 'cad') ws = 'model'; // the studio replaces the separate workspaces
  if (pick) { S.ed.pick = pick; S.ed.faces = []; S.ed.edges = []; }
  if (ws === S.ed.workspace && !(ws === 'draw' && !SK.activeSketch())) { if (pick) selectionChanged(); return; }
  const prev = S.ed.workspace;
  if (S.ed.mode === 'edit') { S.ed.mode = 'object'; S.ed.editSel = new Set(); }
  S.ed.tools[prev] = S.ed.tool;
  S.ed.workspace = ws;
  S.ed.tool = S.ed.tools[ws] || 'select';
  S.ed.pickFace = false;
  Draw.resetTool(); clearLast();
  if (ws === 'draw') {
    let sk = SK.activeSketch() || (S.doc.sketches || []).filter(isShown).slice(-1)[0];
    if (!sk) { runOp(F.newSketch, { plane: 'XY' }); sk = SK.activeSketch(); }
    S.ed.sketch = sk.id; sk.hidden = false;
    enterSketchView(sk);
  } else {
    view.cam.lock2D = false;
    if (prev === 'draw') view.setView('iso');
  }
  selectionChanged();
}
function startFacePick() {
  return startCreateSketch();
  S.ed.pickFace = true;
  toast('Tap a flat face of a body to sketch on it', 2600);
  if (S.ed.workspace === 'draw') { S.ed.workspace = 'cad'; S.ed.tool = 'select'; view.cam.lock2D = false; view.setView('iso'); }
  refresh();
}
function facePickTap(x, y) {
  const hit = view.pickObject(x, y);
  S.ed.pickFace = false;
  if (!hit || hit.face < 0) { toast('No face there — cancelled'); refresh(); return; }
  const o = objById(hit.id), c = view.cam;
  const plane = F.facePlane(o, hit.face, [-Math.sin(c.yaw), Math.cos(c.yaw), 0]);
  if (!plane) { toast('That face is degenerate'); return; }
  // project the face boundary (outer edge + holes) into the sketch, like Fusion's projected geometry
  if (o.shape && o.brep && o.brep.faces[o.faceOf[hit.face]]?.type !== 'PLANE') { toast('Sketches go on flat faces — tap a flat face'); refresh(); return; }
  const W = worldVerts(o), reg = regionOf(o, hit.face), loops = faceLoops(W, o.mesh.f, reg);
  S.ed.tools[S.ed.workspace] = S.ed.tool;
  if (S.ed.mode === 'edit') { S.ed.mode = 'object'; S.ed.editSel = new Set(); }
  runOp(F.newSketch, { face: { obj: o.id, plane, loops } });
  S.ed.tool = S.ed.tools.draw && S.ed.tools.draw !== 'select' ? S.ed.tools.draw : 'line';
  Draw.resetTool();
  // frame the face, looking straight at it
  const pts = loops.flat(), b = new THREE.Box3(); pts.forEach(q => b.expandByPoint(new THREE.Vector3(...q)));
  const ctr = b.getCenter(new THREE.Vector3()).toArray(), rad = Math.max(1, b.getSize(new THREE.Vector3()).length() / 2);
  view.cam.lock2D = S.ed.workspace !== 'model';
  view.lookAlong(plane.n, ctr, rad * 4.2);
  toast(`Sketching on the face · ${loops.length} edge loop${loops.length === 1 ? '' : 's'} projected`);
  refresh();
}
// ---------- Create Sketch (Fusion): pick an origin plane, a construction plane or a flat face; the sketch opens ----------
// (a sketch tool chosen outside a sketch — Line, Rectangle… — asks for the plane first, then starts that tool)
function startCreateSketch(tool = null) {
  if (sketching()) finishSketchEdit();
  if (S.ed.mode === 'edit') setMode('object');
  clearPicks(); S.ed.consTool = null; S.ed.mateFrom = null; S.ed.pickFace = false;
  S.ed.tool = 'select'; Draw.resetTool(); clearLast();
  S.ed.planePick = { tool };
  refresh();
}
const ORIGIN = { XY: SK.PLANES.XY, XZ: SK.PLANES.XZ, YZ: SK.PLANES.YZ };
// the origin plane square under a screen point (they are drawn ~90 px wide round the origin), nearest first
// where each origin plane's name sits while Create Sketch waits: in its quadrant that faces the camera, so the three
// names spread apart and none hides behind another plane
function originLabelSpots() {
  const s = view.worldPerPixel([0, 0, 0]) * 90 * 0.62, c = camera().position, q = v => (v < -1e-9 ? -s : s);
  return { XY: [q(c.x), q(c.y), 0], XZ: [q(c.x), 0, q(c.z)], YZ: [0, q(c.y), q(c.z)] };
}
function originPlaneAt(x, y) {
  // a tap on a plane's name picks it (the names sit just above their spots)
  for (const [k, w] of Object.entries(originLabelSpots())) { const q = view.project(w); if (q.front && Math.hypot(q.x - x, q.y - 20 - y) < 30) return k; }
  const r = view.ray(x, y).ray, s = view.worldPerPixel([0, 0, 0]) * 90; let best = null;
  const planes = { ...ORIGIN, ...(S.ed.cplane ? { CP: S.ed.cplane } : {}) };
  for (const [k, pl] of Object.entries(planes)) {
    const P = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...pl.n), new THREE.Vector3(...pl.o));
    const w = r.intersectPlane(P, new THREE.Vector3()); if (!w) continue;
    const d = M.sub(w.toArray(), pl.o), size = k === 'CP' ? s * 1.4 : s;
    if (Math.abs(M.dot(d, pl.u)) <= size && Math.abs(M.dot(d, pl.v)) <= size) { const t = w.distanceTo(r.origin); if (!best || t < best.t) best = { k, t }; }
  }
  return best && best.k;
}
function planePickTap(x, y) {
  // a flat face under the finger wins (it sits in front of the origin planes)
  const hit = view.pickObject(x, y);
  if (hit && hit.face >= 0) {
    const o = objById(hit.id);
    if (o && !(o.shape && o.brep && o.brep.faces[o.faceOf[hit.face]]?.type !== 'PLANE')) return sketchOnFace(o, hit.face);
  }
  const k = originPlaneAt(x, y);
  if (k) return createSketchOn(k === 'CP' ? { planeDef: { ...S.ed.cplane } } : { plane: k });
  toast(hit ? 'Sketches go on flat faces — tap a flat face, or a plane' : 'Tap one of the planes, or a flat face of a body');
}
function createSketchOn(params) {
  const tool = S.ed.planePick?.tool || null;
  S.ed.planePick = null;
  if (!runOp(F.newSketch, params)) { refresh(); return; }
  activateSketch(S.ed.sketch, true);
  if (tool) setTool(tool);
  toast('Sketch open — draw with the Create tools, then Finish Sketch');
}
function sketchOnFace(o, tri) {
  const c = view.cam, plane = F.facePlane(o, tri, [-Math.sin(c.yaw), Math.cos(c.yaw), 0]);
  if (!plane) { toast('That face is degenerate'); return; }
  const W = worldVerts(o), reg = regionOf(o, tri), loops = faceLoops(W, o.mesh.f, reg);
  createSketchOn({ face: { obj: o.id, plane, loops } });
}
let camBeforeEdit = null, pickBeforeEdit = null;
// Extrude / Revolve / … picked inside a sketch finish it first (as in Fusion), keeping the picked profiles and path
function outOfSketch(run) {
  return e => {
    if (sketching()) { const keep = { profiles: S.ed.profiles.slice(), drawSel: new Set(S.ed.drawSel), sketch: S.ed.sketch }; finishSketchEdit(); Object.assign(S.ed, keep); }
    run(e);
  };
}
function finishSketchEdit() {
  const id = S.ed.editingSketch, sk = SK.sketchById(id);
  S.ed.editingSketch = null; S.ed.drawSel = new Set(); S.ed.profiles = []; S.ed.sketch = null;
  if (sk && sk._wasHidden) { sk.hidden = true; delete sk._wasHidden; }
  if (S.ed.tool !== 'select') setTool('select');
  view.cam.lock2D = false;
  if (camBeforeEdit) view.restoreCam(camBeforeEdit); else view.setView('iso');
  camBeforeEdit = null;
  // (back to free picking: nothing is held to a kind once the sketch is done)
  setPickKind(pickBeforeEdit || 'face'); S.ed.pickLock = null; S.ed.pendingRun = null; pickBeforeEdit = null;
  selectionChanged();
}
function activateSketch(id, isNew = false) {
  const sk = SK.sketchById(id); if (!sk) return;
  if (S.ed.editingSketch != null && S.ed.editingSketch !== id) { const o = SK.sketchById(S.ed.editingSketch); if (o && o._wasHidden) { o.hidden = true; delete o._wasHidden; } }
  if (sk.hidden) sk._wasHidden = true;
  if (S.ed.editingSketch == null) camBeforeEdit = view.saveCam();
  if (S.ed.editingSketch == null) pickBeforeEdit = S.ed.pick;
  S.ed.editingSketch = id; S.ed.pick = 'edge'; S.ed.faces = []; S.ed.edges = []; S.ed.selected = new Set();
  S.ed.planePick = null; S.ed.pickFace = false;
  if (isNew) { S.settings.sketchToolset = 'create'; saveSettings(); } // (a new sketch opens on the Create tools)
  S.ed.sketch = id; sk.hidden = false; Draw.clearTarget();
  if (S.ed.workspace !== 'model') setWorkspace('model');
  enterSketchView(sk); selectionChanged();
}

// ---------- CAD taps: profiles & bodies ----------
// a body edge as a selection item (world coordinates)
function solidEdgeItem(o, e) {
  const xf = xfFor(o), P = e.pts.map(xf.toW), mid = K.polyMid(P);
  let circle;
  if (e.type === 'CIRCLE' && e.closed) { const c = M.centroid(P.slice(0, -1)); circle = { loop: P, c, R: M.dist(P[0], c) }; }
  return { obj: o.id, p: mid, a: P[0], b: P[P.length - 1], len: e.len, type: e.type, pts: P, ...(circle ? { circle } : {}) };
}
const edgeOfItem = (o, q) => o.brep.edges.find(e => !e.seam && e.i >= 0 && K.polyDist(xfFor(o).toL(q.p), e.pts) < 1e-6 * Math.max(1, e.len) + o.brep.tol);
// grow the edge selection along edges that continue smoothly (tangent chains), or take every edge of the body
function growEdges(all) {
  const o = objById(S.ed.edges[0]?.obj); if (!o || !o.brep) return;
  const E = o.brep.edges.filter(e => !e.seam && e.i >= 0);
  let pick;
  if (all === 'loop') {
    // the closed boundary of the flat face along the picked edge (a hex head's six edges)
    // (the shape's edge and face lists are built anew on every access, and slowly: read them once)
    const e0 = edgeOfItem(o, S.ed.edges[0]); if (!e0) return;
    const SE = o.shape.edges, hc = SE[e0.i].hashCode, ehc = E.map(e => SE[e.i].hashCode);
    const faces = o.shape.faces.filter(f => f.edges.some(x => x.hashCode === hc));
    // the flat faces along the edge, the one facing the viewer first; Loop again on its loop gives the next one
    const xf = xfFor(o), vd = view.viewDir(), vl = M.norm(M.sub(xf.toL(vd), xf.toL([0, 0, 0])));
    const facing = f => { try { const n = f.normalAt(); return M.dot([n.x, n.y, n.z], vl); } catch (e) { return -2; } };
    const cands = faces.filter(x => x.geomType === 'PLANE').sort((a, b) => facing(b) - facing(a));
    if (!cands.length && faces[0]) cands.push(faces[0]);
    if (!cands.length) return;
    const loopOf = f => {
      let wire; try { wire = f.clone().outerWire(); } catch (e) { wire = null; }
      let hs = new Set((wire ? wire.edges : f.edges).map(x => x.hashCode));
      if (!hs.has(hc)) hs = new Set(f.edges.map(x => x.hashCode)); // the edge is on an inner loop (a hole rim)
      return E.filter((e, k) => hs.has(ehc[k]));
    };
    const cur = new Set(S.ed.edges.filter(q => q.obj === o.id).map(q => edgeOfItem(o, q)));
    let k = 0;
    if (cur.size > 1) { const at = cands.findIndex(f => { const l = loopOf(f); return l.length === cur.size && l.every(e => cur.has(e)); }); if (at >= 0) k = (at + 1) % cands.length; }
    pick = loopOf(cands[k]);
    pick.sort((a, b) => (a === e0 ? -1 : b === e0 ? 1 : 0)); // the tapped edge stays first (Loop again cycles from it)
  } else if (all) pick = E;
  else {
    const tol = Math.max(o.brep.tol * 4, 1e-6), d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const ends = e => { const p = e.pts, n = p.length; return [{ q: p[0], t: M.norm(M.sub(p[1], p[0])) }, { q: p[n - 1], t: M.norm(M.sub(p[n - 1], p[n - 2])) }]; };
    pick = S.ed.edges.filter(q => q.obj === o.id).map(q => edgeOfItem(o, q)).filter(Boolean);
    for (let k = 0; k < pick.length; k++) {
      if (pick[k].closed) continue;
      for (const A of ends(pick[k])) for (const e of E) {
        if (pick.includes(e) || e.closed) continue;
        if (ends(e).some(B => d(A.q, B.q) < tol && Math.abs(M.dot(A.t, B.t)) > Math.cos(8 * Math.PI / 180))) pick.push(e);
      }
    }
  }
  const before = S.ed.edges.length;
  S.ed.edges = pick.map(e => solidEdgeItem(o, e));
  toast(all === 'loop' ? `Loop: ${S.ed.edges.length} edges` : all ? `All ${S.ed.edges.length} edges of the body` : S.ed.edges.length > before ? `Chain: ${S.ed.edges.length} edges` : 'No smooth continuation — Chain follows edges that meet tangentially (e.g. around a fillet)');
  selectionChanged();
}
// the nearest visible body edge to a screen point ({ d px, o, solid | W fe e, Q }), or null
function edgeCandidate(x, y) {
  let best = null;
  const hit = view.pickObject(x, y), cands = [];
  for (const o of S.doc.objects) {
    if (!isShown(o)) continue;
    if (o.shape && o.brep) { // solids: the exact B-rep edges
      const xf = xfFor(o);
      for (const e of o.brep.edges) {
        if (e.seam || e.i < 0) continue;
        const P = e.pts.map(xf.toW);
        for (let k = 1; k < P.length; k++) {
          const A = view.project(P[k - 1]), B = view.project(P[k]);
          if (!A.front || !B.front) continue;
          const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
          let t = L2 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(A.x + dx * t - x, A.y + dy * t - y);
          if (d > 24) continue;
          const Q = P[k - 1].map((c, j) => c + (P[k][j] - c) * t);
          if (hit && view.project(hit.point).depth < view.project(Q).depth - Math.max(1e-3, view.worldPerPixel(Q) * 3) && hit.id !== o.id) continue; // behind another body
          cands.push({ d, o, Q, solid: { e, P, Q } });
        }
      }
      continue;
    }
    const W = worldVerts(o), fe = featureEdges(W, o.mesh.f);
    for (const e of fe) {
      const A = view.project(W[e.a]), B = view.project(W[e.b]);
      if (!A.front || !B.front) continue;
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      let t = L2 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(A.x + dx * t - x, A.y + dy * t - y);
      if (d > 24) continue;
      const P = W[e.a].map((c, k) => c + (W[e.b][k] - c) * t);
      const depth = view.project(P).depth;
      if (hit && hit.id !== o.id && view.project(hit.point).depth < depth - 1e-3) continue; // hidden behind another body
      cands.push({ d, o, W, fe, e, Q: P });
    }
  }
  // the nearest edge that can be seen: a back edge behind the part's own faces is not under the finger
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands.slice(0, 16)) if (!view.occluded(c.Q)) { best = c; break; }
  return best;
}
function edgeTap(x, y, probe = false) { // probe: only report how close the nearest body edge is (px)
  const best = edgeCandidate(x, y);
  if (probe) return best ? best.d : Infinity;
  if (!best) { if (!S.ed.multi) S.ed.edges = []; return selectionChanged(); }
  if (best.solid) {
    const { e, P } = best.solid;
    const item = solidEdgeItem(best.o, e);
    const sameS = q => q.obj === best.o.id && q.p && K.polyDist(q.p, P) < 1e-6 * Math.max(1, e.len);
    const i = S.ed.edges.findIndex(sameS);
    if (i >= 0) { if (S.ed.multi) S.ed.edges.splice(i, 1); } // a second tap keeps the pick (multi-select toggles)
    else if (S.ed.multi) S.ed.edges.push(item); // without Multi a tap replaces the pick
    else S.ed.edges = [item];
    return selectionChanged();
  }
  // a round edge (rim of a hole or boss) is picked as one circular loop
  const circ = edgeLoop(best.W, best.fe, best.e.a, best.e.b);
  const [a, b] = circ ? [circ.loop[0], circ.loop[1]] : straightRun(best.W, best.fe, best.e.a, best.e.b);
  const same = q => q.obj === best.o.id && (circ ? q.circle && M.dist(q.circle.c, circ.c) < 1e-6 && Math.abs(q.circle.R - circ.R) < 1e-6 : !q.circle && ((M.dist(q.a, a) < 1e-6 && M.dist(q.b, b) < 1e-6) || (M.dist(q.a, b) < 1e-6 && M.dist(q.b, a) < 1e-6)));
  const item = circ ? { obj: best.o.id, a, b, circle: circ } : { obj: best.o.id, a, b };
  const i = S.ed.edges.findIndex(same);
  if (i >= 0) { if (S.ed.multi) S.ed.edges.splice(i, 1); } // a second tap keeps the pick (multi-select toggles)
  else if (S.ed.multi) S.ed.edges.push(item);
  else S.ed.edges = [item];
  selectionChanged();
}
// Plasticity-style face pick: a tap selects the whole planar face (all coplanar connected polygons)
// faces of solids: every triangle of the B-rep face under a triangle; meshes: the coplanar region
function regionOf(o, tri) {
  if (o.shape && o.faceOf) {
    const fi = o.faceOf[tri], faces = [];
    o.faceOf.forEach((x, i) => { if (x === fi) faces.push(i); });
    const W = worldVerts(o), P = o.mesh.f[tri].map(i => W[i]), n = M.faceNormal(P);
    return { faces, n, w: M.dot(n, P[0]), fi };
  }
  return faceRegion(worldVerts(o), o.mesh.f, tri);
}
// a picked face { n, w, p } → its triangles now (after rebuilds)
function findRegionObj(o, f) {
  if (o.shape && o.faceOf) {
    const xf = xfFor(o), nl = M.norm(M.sub(xf.toL(M.add(f.p, f.n)), xf.toL(f.p)));
    const hit = K.faceAt(o.shape, xf.toL(f.p), nl); if (!hit) return null;
    const faces = []; o.faceOf.forEach((x, i) => { if (x === hit.i) faces.push(i); });
    return { faces, n: f.n, w: f.w };
  }
  return findRegion(worldVerts(o), o.mesh.f, f.n, f.w, f.p);
}
function faceTap(x, y) {
  const hit = view.pickObject(x, y);
  if (!hit || hit.face < 0) { if (!S.ed.multi) S.ed.faces = []; return selectionChanged(); }
  const o = objById(hit.id), reg = regionOf(o, hit.face);
  const same = q => q.obj === o.id && (() => { const r2 = findRegionObj(o, q); return r2 && r2.faces.includes(hit.face); })();
  const i = S.ed.faces.findIndex(same);
  if (i >= 0) { if (S.ed.multi) S.ed.faces.splice(i, 1); } // a second tap keeps the pick (multi-select toggles)
  else { const item = { obj: o.id, n: reg.n, w: reg.w, p: hit.point, ...(o.brep && reg.fi != null ? { planar: o.brep.faces[reg.fi]?.type === 'PLANE' } : {}) }; if (S.ed.multi) S.ed.faces.push(item); else S.ed.faces = [item]; }
  S.ed.selected = new Set([o.id]); S.ed.active = o.id;
  selectionChanged();
}
// while a sketch is being edited only its own curves and regions are pickable
function tapSketches() { const e = S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch); return e ? [e] : (S.doc.sketches || []).filter(isShown); }
function cadTap(x, y) {
  if (S.ed.tool === 'edge') return edgeTap(x, y);
  const ray = view.ray(x, y).ray;
  let best = null;
  for (const sk of tapSketches()) {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...sk.plane.n), new THREE.Vector3(...sk.plane.o));
    const w = ray.intersectPlane(pl, new THREE.Vector3()); if (!w) continue;
    const t = w.distanceTo(ray.origin);
    const p2 = SK.toP(sk.plane, w.toArray());
    const r = SK.regionAt(sk, p2);
    if (r && (!best || t < best.t)) best = { sk, p2, t, r };
  }
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y); // bodies are ghosted while a sketch is edited
  if (best && (!hit || best.t <= hit.distance + Math.max(1e-3, hit.distance * 1e-4))) {
    const i = S.ed.profiles.findIndex(q => q.sk === best.sk.id && SK.regionAt(best.sk, q.pt) === best.r);
    if (i >= 0) { if (S.ed.multi) S.ed.profiles.splice(i, 1); } // a second tap keeps the pick (multi-select toggles)
    else if (S.ed.multi) S.ed.profiles.push({ sk: best.sk.id, pt: best.p2 });
    else S.ed.profiles = [{ sk: best.sk.id, pt: best.p2 }];
  } else if (hit) {
    if (S.ed.multi) { if (S.ed.selected.has(hit.id)) S.ed.selected.delete(hit.id); else S.ed.selected.add(hit.id); S.ed.active = hit.id; }
    else { S.ed.selected = new Set([hit.id]); S.ed.active = hit.id; }
  } else if (!S.ed.multi) { S.ed.profiles = []; S.ed.selected = new Set(); }
  selectionChanged();
}
async function loadAutosave() {
  try {
    let s = localStorage.getItem(DOC_KEY); if (!s) return false;
    // too big for localStorage (e.g. an imported STEP): only a pointer was kept, the project is in the device library
    const ref = s.length < 200 && JSON.parse(s).ref;
    if (ref) { const rec = await LIB.get(ref); if (!rec) return false; s = rec.data; }
    deserialize(s);
    if (ref && !S.doc.project) S.doc.project = { id: ref, name: 'Untitled', created: Date.now() };
    // linked components' solids are kept in the device library, not in localStorage
    const miss = Object.entries(S.doc.components || {}).filter(([, c]) => !c.brep);
    if (miss.length) {
      let saved = {}; try { const rec = S.doc.project && await LIB.get(S.doc.project.id); saved = rec ? JSON.parse(rec.data).doc.components || {} : {}; } catch (e) {}
      for (const [pid, c] of miss) {
        let brep = saved[pid]?.version === c.version ? saved[pid].brep : null, parts = brep ? saved[pid].parts || null : null;
        if (!brep) { try { const src = await LIB.get(pid); if (src && src.version === c.version) { brep = src.exportBrep; parts = src.parts || null; } } catch (e) {} }
        if (brep) S.doc.components[pid] = { name: c.name, version: c.version, brep, parts };
      }
    }
    if (S.doc.objects.some(o => o.regen)) { H.resetCache(); H.regenerate(0); for (const o of S.doc.objects) delete o.regen; }
    return true;
  } catch (e) { console.warn(e); return false; }
}
let saveT = 0;
function saveLocalNow() {
  clearTimeout(saveT);
  try { localStorage.setItem(DOC_KEY, JSON.stringify(serialize(true, true))); }
  catch (e) {
    // too big (imported solids live in the history): keep a pointer and let the device library hold the project
    try { localStorage.setItem(DOC_KEY, JSON.stringify({ ref: PJ.ensureProject().id })); PJ.saveNow(); } catch (e2) { toast('Autosave failed (storage full?)'); }
  }
}
function scheduleSave() {
  clearTimeout(saveT);
  PJ.scheduleLibrarySave();
  saveT = setTimeout(saveLocalNow, 400);
}
// leaving the app (switching away on iOS, closing the tab): write everything now
const flushSaves = () => { saveLocalNow(); PJ.saveNow(); };
addEventListener('pagehide', flushSaves);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });

// =====================================================================
// selection & modes
// =====================================================================
function selectionChanged() {
  clearLast(); view.markSelDirty(); refresh();
  // a command that was waiting for a face (Hole, Mate…) goes ahead once one is tapped
  if (S.ed.pendingRun && S.ed.pickLock === 'face' && S.ed.faces.length) { const fn = S.ed.pendingRun; S.ed.pendingRun = null; S.ed.pickLock = null; fn(); }
}

let lastViewportTap = 0;
// iOS fires a click ~300 ms after a tap; if a panel appeared under the finger it must not receive it
document.addEventListener('click', e => {
  if (performance.now() - lastViewportTap < 450 && e.target.closest && e.target.closest('#draw-card, #lastop, #measure-card, #popover, #sheet, #actions, #tools')) { e.stopPropagation(); e.preventDefault(); }
}, true);
// the sketch curve a tap lands on (nearest along the ray), or null — a sketch a feature already used (its lines run
// along the body's edges) yields to a body edge under the finger, and a curve behind a body is not pickable
function probeCurve(x, y, px = 16) {
  const ray = view.ray(x, y).ray;
  let best = null;
  for (const k of tapSketches()) {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...k.plane.n), new THREE.Vector3(...k.plane.o));
    const w = ray.intersectPlane(pl, new THREE.Vector3()); if (!w) continue;
    // (a face's projected outline is the sketch's reference: outside the sketch a tap there means the body's edge)
    const kk = sketching() || !k.ents.some(e => e.proj) ? k : { ...k, ents: k.ents.filter(e => !e.proj) };
    const p2 = SK.toP(k.plane, w.toArray()), e = SK.pickEntity(kk, p2, px * view.worldPerPixel(w.toArray()));
    if (e && e.t !== 'hatch' && (!best || w.distanceTo(ray.origin) < best.t)) best = { k, e, t: w.distanceTo(ray.origin) };
  }
  if (!best) return null;
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y); // bodies are ghosted while a sketch is edited
  if (!S.settings.xray && S.ed.editingSketch == null && H.firstUsing([best.k.id]) >= 0 && edgeTap(x, y, true) <= 16) return null;
  return !hit || S.settings.xray || best.t <= hit.distance + view.worldPerPixel(hit.point) * 8 ? best : null;
}
// curves and edges: sketch curves first, else body edges
function curveOrEdgeTap(x, y) {
  const best = probeCurve(x, y);
  if (best) {
    if (S.ed.sketch !== best.k.id || !S.ed.multi) S.ed.drawSel = new Set();
    S.ed.sketch = best.k.id; Draw.clearTarget();
    if (S.ed.drawSel.has(best.e.id) && S.ed.multi) S.ed.drawSel.delete(best.e.id); else S.ed.drawSel.add(best.e.id);
    if (!S.ed.multi) { S.ed.edges = []; S.ed.profiles = []; S.ed.faces = []; }
    return selectionChanged();
  }
  if (!S.ed.multi) S.ed.drawSel = new Set();
  if (S.ed.editingSketch != null) return selectionChanged();
  return edgeTap(x, y);
}
// a face sketch's region outlined by the face's own projected boundary is, in the part, the face itself: like a region
// already built from, it yields to the face's edges and to the face (inside the open sketch it is a profile as usual)
const projRegionMemo = new WeakMap();
function projRegion(k, r) {
  if (!k.face || !k.ents.some(e => e.proj)) return false;
  if (projRegionMemo.has(r)) return projRegionMemo.get(r);
  const P = k.ents.filter(e => e.proj).map(e => SK.entPolyline(e)), tol = 1e-6 * Math.max(1, ...r.outer.map(p => Math.abs(p[0]) + Math.abs(p[1])));
  const onP = p => P.some(pl => { const n = pl.pts.length; for (let i = 0; i < (pl.closed ? n : n - 1); i++) if (SK.segDist(p, pl.pts[i], pl.pts[(i + 1) % n]) <= tol) return true; return false; });
  const v = r.outer.every(onP); projRegionMemo.set(r, v); return v;
}
// the closed sketch region a tap lands on ({ k, p2, r, t, used }), or null — with the same rules as a region pick
function probeRegion(x, y) {
  const ray = view.ray(x, y).ray;
  let best = null;
  for (const k of tapSketches()) {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...k.plane.n), new THREE.Vector3(...k.plane.o));
    const w = ray.intersectPlane(pl, new THREE.Vector3()); if (!w) continue;
    const p2 = SK.toP(k.plane, w.toArray()), r = SK.regionAt(k, p2);
    if (r && (!best || w.distanceTo(ray.origin) < best.t)) best = { k, p2, r, t: w.distanceTo(ray.origin) };
  }
  if (!best) return null;
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y);
  const used = H.hist().some(r => (r.params?.pts || []).some(it => it.sk === best.k.id && SK.regionAt(best.k, it.pt) === best.r)) || projRegion(best.k, best.r);
  if (used && !S.settings.xray && S.ed.editingSketch == null && edgeTap(x, y, true) <= 16) return null;
  if (hit && S.ed.editingSketch == null && !S.settings.xray) {
    const again = !S.ed.multi && S.ed.profiles.length === 1 && S.ed.profiles[0].sk === best.k.id && SK.regionAt(best.k, S.ed.profiles[0].pt) === best.r;
    if ((used && Math.abs(best.t - hit.distance) < view.worldPerPixel(hit.point) * 8) || again) return null;
  }
  return !hit || S.settings.xray || best.t <= hit.distance + view.worldPerPixel(hit.point) * 8 ? { ...best, used } : null;
}
// regions and faces: sketch regions first (nearest along the ray), else body faces
function regionOrFaceTap(x, y) {
  const ray = view.ray(x, y).ray;
  let best = null;
  for (const k of tapSketches()) {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...k.plane.n), new THREE.Vector3(...k.plane.o));
    const w = ray.intersectPlane(pl, new THREE.Vector3()); if (!w) continue;
    const p2 = SK.toP(k.plane, w.toArray()), r = SK.regionAt(k, p2);
    if (r && (!best || w.distanceTo(ray.origin) < best.t)) best = { k, p2, r, t: w.distanceTo(ray.origin) };
  }
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y); // bodies are ghosted while a sketch is edited
  // a region a feature already built from yields to a body edge under the finger, and (lying on the body's face) to
  // that face; a region not used yet stays pickable however narrow (a 5 mm ring); tapping the picked region again
  // (without Multi) goes through to the face under it. X-ray: sketch regions always win.
  const used = best && (H.hist().some(r => (r.params?.pts || []).some(it => it.sk === best.k.id && SK.regionAt(best.k, it.pt) === best.r)) || projRegion(best.k, best.r));
  if (best && used && !S.settings.xray && S.ed.editingSketch == null && edgeTap(x, y, true) <= 16) best = null;
  if (best && hit && S.ed.editingSketch == null && !S.settings.xray) {
    const again = !S.ed.multi && S.ed.profiles.length === 1 && S.ed.profiles[0].sk === best.k.id && SK.regionAt(best.k, S.ed.profiles[0].pt) === best.r;
    if ((used && Math.abs(best.t - hit.distance) < view.worldPerPixel(hit.point) * 8) || again) best = null;
  }
  if (best && (!hit || S.settings.xray || best.t <= hit.distance + view.worldPerPixel(hit.point) * 8)) {
    const i = S.ed.profiles.findIndex(q => q.sk === best.k.id && SK.regionAt(best.k, q.pt) === best.r);
    if (i >= 0) { if (S.ed.multi) S.ed.profiles.splice(i, 1); } // a second tap keeps the pick (multi-select toggles)
    else if (S.ed.multi) S.ed.profiles.push({ sk: best.k.id, pt: best.p2 });
    else { S.ed.profiles = [{ sk: best.k.id, pt: best.p2 }]; S.ed.faces = []; S.ed.drawSel = new Set(); S.ed.edges = []; }
    return selectionChanged();
  }
  if (!S.ed.multi) S.ed.profiles = [];
  if (S.ed.editingSketch != null) return selectionChanged();
  return faceTap(x, y);
}
function onTap(x, y) {
  lastViewportTap = performance.now();
  if (keypadOpen()) { closeKeypad(false); return; }
  if (sheetOpen && !document.body.classList.contains('sheet-docked')) { toggleSheet(false); return; }
  if (S.ed.planePick) return planePickTap(x, y);
  if (S.ed.pickFace) return facePickTap(x, y);
  if (S.ed.tool === 'measure') return measureTap(x, y);
  if (S.ed.workspace === 'draw') return Draw.tap(x, y);
  if (S.ed.workspace === 'cad') return cadTap(x, y);
  if (S.ed.mode === 'object' && (Draw.EDIT_TOOLS.has(S.ed.tool) || ['trim', 'dim', 'corner', 'extend'].includes(S.ed.tool))) return Draw.tap(x, y);
  if (S.ed.mode === 'object' && S.ed.mateFrom) return mateTap(x, y);
  if (S.ed.mode === 'object' && S.ed.consTool) return consTap(x, y);
  // a gizmo's value bubble (tap to type the value), dimension labels and constraint glyphs first — small targets
  // drawn on top — then what is under the finger
  if (valueTap(x, y)) return;
  if (S.ed.mode === 'object' && Draw.tapLabel(x, y, true)) return;
  if (S.ed.mode === 'object') { Draw.clearConsSel(); return smartTap(x, y); }
  const o = activeObj(); if (!o) return;
  let verts = null;
  if (S.ed.selectMode === 'vert') { const v = view.pickVertex(x, y, { objs: [o] }); if (v) verts = [v.index]; }
  else if (S.ed.selectMode === 'edge') verts = view.pickEdge(x, y, o);
  else { const f = view.pickFace(x, y, o); if (f >= 0) verts = o.mesh.f[f].slice(); }
  if (verts) {
    if (S.ed.multi) {
      if (verts.every(i => S.ed.editSel.has(i))) { verts.forEach(i => S.ed.editSel.delete(i)); S.ed.selOrder = S.ed.selOrder.filter(i => !verts.includes(i)); }
      else verts.forEach(i => { S.ed.editSel.add(i); S.ed.selOrder.push(i); });
    } else { S.ed.editSel = new Set(verts); S.ed.selOrder = verts.slice(); }
  } else if (!S.ed.multi) { S.ed.editSel = new Set(); S.ed.selOrder = []; }
  selectionChanged();
}

// ---------- picking: what is under the finger (no Edge / Face / Solid switch) ----------
// curves (and regions not used yet) of the sketches, then body edges within EDGE_PX, then faces; a face tapped
// again selects its whole body (and the body tapped again goes back to the face). A command waiting for one kind
// (Fillet → edges) holds picking to it, and so does Multi-select while it is adding to a pick.
const EDGE_PX = 8;
function setPickKind(kind) {
  if (S.ed.pick === kind) return;
  S.ed.pick = kind; S.ed.faces = []; S.ed.edges = []; S.ed.profiles = []; S.ed.drawSel = new Set();
  if (kind !== 'solid' && kind !== 'face') { S.ed.selected = new Set(); }
}
function lockPick(kind, msg, then = null) {
  if (S.ed.mode === 'edit') setMode('object');
  S.ed.pickLock = kind; S.ed.pendingRun = then; setPickKind(kind);
  if (msg) toast(msg);
  selectionChanged();
}
function clearPicks() {
  S.ed.faces = []; S.ed.edges = []; S.ed.profiles = []; S.ed.drawSel = new Set(); S.ed.selected = new Set(); S.ed.active = null; S.ed.pickLock = null; S.ed.pendingRun = null;
}
const hasPicks = () => S.ed.faces.length || S.ed.edges.length || S.ed.profiles.length || S.ed.drawSel.size || (S.ed.pick === 'solid' && S.ed.selected.size);
function sameFaceHit(f, hit) { const o = objById(hit.id); if (!o || f.obj !== o.id) return false; const r2 = findRegionObj(o, f); return !!r2 && r2.faces.includes(hit.face); }
function bodyTap(x, y) {
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y);
  if (hit) {
    if (S.ed.multi) {
      if (S.ed.selected.has(hit.id) && S.ed.active === hit.id) { S.ed.selected.delete(hit.id); S.ed.active = [...S.ed.selected].pop() ?? null; }
      else { S.ed.selected.add(hit.id); S.ed.active = hit.id; }
    } else { S.ed.selected = new Set([hit.id]); S.ed.active = hit.id; }
  } else if (!S.ed.multi) { S.ed.selected = new Set(); }
  return selectionChanged();
}
// (the pick as it stands: a tap counts as "the same spot again" only if nothing else changed the pick since)
// (and the view as it stands: after a turn or a frame the same pixel is somewhere else on the model)
const pickSig = () => JSON.stringify([S.ed.pick, S.ed.faces.map(f => [f.obj, f.p]), S.ed.edges.map(e => [e.obj, e.p || e.a]), [...S.ed.selected], [...S.ed.drawSel], S.ed.profiles,
  ((c) => [c.yaw, c.pitch, c.dist, c.target.x, c.target.y, c.target.z].map(v => +v.toFixed(5)).concat(c.ortho))(view.cam)]);
let lastTap = null;
function smartTap(x, y) {
  smartTapInner(x, y);
  lastTap = { x, y, sig: pickSig() };
}
function smartTapInner(x, y) {
  const lock = S.ed.pickLock || (S.ed.multi && hasPicks() ? S.ed.pick : null);
  if (lock === 'edge') return curveOrEdgeTap(x, y);
  if (lock === 'face') return regionOrFaceTap(x, y);
  if (lock === 'solid') return bodyTap(x, y);
  // the same spot tapped again: the next thing under the finger — edge → face → body → edge
  const again = lastTap && Math.hypot(x - lastTap.x, y - lastTap.y) < 12 && !S.ed.multi && hasPicks() && lastTap.sig === pickSig();
  if (again && S.ed.editingSketch == null && !S.ed.drawSel.size && !S.ed.profiles.length) {
    const hit = view.pickObject(x, y);
    if (S.ed.pick === 'edge' && S.ed.edges.length && hit) { setPickKind('face'); return faceTap(x, y); }
    if (S.ed.pick === 'edge' && S.ed.edges.length && !hit) return selectionChanged();
    if (S.ed.pick === 'face' && S.ed.faces.length && hit) { setPickKind('solid'); return bodyTap(x, y); }
    if (S.ed.pick === 'solid' && hit && edgeTap(x, y, true) <= EDGE_PX) { setPickKind('edge'); return edgeTap(x, y); }
    if (S.ed.pick === 'solid' && hit && hit.face >= 0) { setPickKind('face'); return faceTap(x, y); }
  }
  // right on a curve (a few px) → the curve; inside a closed region → the region; near a body edge → the edge;
  // near a curve outside any region (an open line) → the curve; else the face under the finger
  if (probeCurve(x, y, 7)) { setPickKind('edge'); return curveOrEdgeTap(x, y); }
  const reg = probeRegion(x, y);
  if (reg && !reg.used) { setPickKind('face'); return regionOrFaceTap(x, y); }
  if (S.ed.editingSketch == null && edgeTap(x, y, true) <= EDGE_PX) { setPickKind('edge'); return edgeTap(x, y); }
  if (reg) { setPickKind('face'); return regionOrFaceTap(x, y); }
  if (probeCurve(x, y)) { setPickKind('edge'); return curveOrEdgeTap(x, y); }
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y);
  if (!hit) { clearPicks(); return selectionChanged(); }
  if (!S.ed.multi && S.ed.pick === 'face' && S.ed.faces.length === 1 && !S.ed.profiles.length && hit.face >= 0 && sameFaceHit(S.ed.faces[0], hit)) { setPickKind('solid'); return bodyTap(x, y); }
  if (hit.face < 0) { setPickKind('solid'); return bodyTap(x, y); } // (an imported mesh without faces)
  setPickKind('face'); return faceTap(x, y);
}

// ---------- precision cursor: hold (or drag) a finger on the view ----------
// a cursor rides 72 px above the finger with a magnifier over it and a label of what is under it; letting go picks
// that (the same as a tap there). Lets a finger pick a 1 mm edge or a small hole rim exactly.
const CUR_DY = -72;
let cur = null, hoverGroup = null, hoverKey = '';
function describeAt(x, y) {
  const lab = (kind, text, prev) => ({ kind, text, prev });
  if (S.ed.consTool) { const c = probeCurve(x, y); return c ? lab('curve', `${CONS_NAME[S.ed.consTool]} → ${Draw.entName?.(c.e) || 'curve'}`, { k: c.k, e: c.e }) : lab(null, `Tap a curve for ${CONS_NAME[S.ed.consTool]}`); }
  const c7 = probeCurve(x, y, 7); if (c7) return lab('curve', `Curve · ${Draw.entName?.(c7.e) || c7.e.t}`, { k: c7.k, e: c7.e });
  const reg = probeRegion(x, y); if (reg && !reg.used) return lab('region', 'Profile', { k: reg.k, r: reg.r });
  const ed = S.ed.editingSketch == null ? edgeCandidate(x, y) : null;
  if (ed && ed.d <= EDGE_PX) {
    const pts = ed.solid ? ed.solid.P : [ed.W[ed.e.a], ed.W[ed.e.b]];
    const len = ed.solid ? ed.solid.e.len : M.dist(pts[0], pts[1]);
    return lab('edge', `Edge${ed.solid?.e.type === 'CIRCLE' ? ' · rim' : ''} · ${fmtLen(len)}`, { pts });
  }
  if (reg) return lab('region', 'Profile', { k: reg.k, r: reg.r });
  const c16 = probeCurve(x, y); if (c16) return lab('curve', `Curve · ${Draw.entName?.(c16.e) || c16.e.t}`, { k: c16.k, e: c16.e });
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y);
  if (hit && hit.face >= 0) { const o = objById(hit.id); return lab('face', `Face · ${o?.name || ''}`, { o, tri: hit.face }); }
  if (hit) return lab('body', objById(hit.id)?.name || 'Body', null);
  return lab(null, 'Nothing here');
}
// a light highlight of what the cursor would pick
function showHover(d) {
  if (!hoverGroup) { hoverGroup = new THREE.Group(); view.overlayScene.add(hoverGroup); }
  const key = d ? d.kind + JSON.stringify(d.prev ? [d.prev.pts?.[0], d.prev.e?.id, d.prev.tri, d.prev.k?.id, d.prev.r?.outer?.[0]] : null) : '';
  if (key === hoverKey) return; hoverKey = key;
  hoverGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); hoverGroup.clear();
  if (!d || !d.prev) { view.render(); return; }
  const col = new THREE.Color(view.theme.act || '#8cc4ff').getHex(), p = d.prev;
  if (p.pts) hoverGroup.add(Draw.fatLine(p.pts, col, 3.4, false));
  else if (p.e) { const pl = SK.entPolyline(p.e); if (pl) hoverGroup.add(Draw.fatLine(pl.pts.map(q => SK.toW(p.k.plane, q)), col, 3.4, pl.closed)); }
  else if (p.r) hoverGroup.add(Draw.fatLine(p.r.outer.map(q => SK.toW(p.k.plane, q)), col, 3, true));
  else if (p.o && p.tri != null) {
    const reg = regionOf(p.o, p.tri), W = worldVerts(p.o), pos = [];
    for (const t of reg.faces) for (const i of p.o.mesh.f[t]) pos.push(...W[i]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    hoverGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false, depthWrite: false })));
  }
  view.render();
}
function placeCursor() {
  const { x, y } = cur, vp = $('#viewport').getBoundingClientRect(), pc = $('#pcursor'), lp = $('#loupe');
  pc.style.transform = `translate(${x}px, ${y}px)`;
  // the magnifier sits above the cursor, or beside it near the top of the screen
  let lx = x - 62, ly = y - 124 - 40 - 30;
  if (ly < 8) { ly = y - 62; lx = x + 34; if (lx + 124 > vp.width - 8) lx = x - 34 - 124; }
  lx = Math.max(8, Math.min(vp.width - 132, lx));
  lp.style.transform = `translate(${lx}px, ${ly}px)`;
  const d = describeAt(x, y); cur.d = d;
  const lab = lp.querySelector('.lp-label'); lab.textContent = d.text; lab.classList.toggle('none', !d.kind);
  showHover(d);
  view.magnify(lp.querySelector('canvas'), x, y, 2.4);
}
function initCursor() {
  const cv = $('#loupe canvas'), dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.width = 124 * dpr; cv.height = 124 * dpr;
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (cur) placeCursor(); }); };
  view.handlers.cursorStart = (fx, fy) => {
    if (keypadOpen()) closeKeypad(false);
    cur = { fx, fy, x: fx, y: fy + CUR_DY };
    $('#pcursor').hidden = false; $('#loupe').hidden = false; document.body.classList.add('has-cursor');
    placeCursor();
  };
  view.handlers.cursorMove = (fx, fy) => { if (!cur) return; cur.x = fx; cur.y = fy + CUR_DY; schedule(); };
  const close = () => { cur = null; $('#pcursor').hidden = true; $('#loupe').hidden = true; document.body.classList.remove('has-cursor'); showHover(null); };
  view.handlers.cursorEnd = () => { if (!cur) return; const { x, y } = cur; close(); onTap(x, y); };
  view.handlers.cursorCancel = () => close();
}
// ---------- zoom bar (right side): push the handle up to zoom in, down to zoom out; it springs back ----------
function initZoomBar() {
  const bar = $('#zoombar'), track = bar.querySelector('.zb-track'), thumb = bar.querySelector('.zb-thumb');
  let active = null;
  const maxOff = () => Math.max(10, track.clientHeight / 2 - thumb.clientHeight / 2 - 2);
  const tick = t => {
    if (!active) return;
    const dt = Math.min(0.05, (t - active.t) / 1000), k = active.off / maxOff(); active.t = t;
    // (gentle near the middle, faster at the ends: up to ~3× per second)
    if (Math.abs(k) > 0.03) view.zoom(Math.exp(Math.sign(k) * k * k * 1.15 * dt));
    requestAnimationFrame(tick);
  };
  const move = e => { if (!active) return; const r = track.getBoundingClientRect(), m = maxOff(); active.off = Math.max(-m, Math.min(m, e.clientY - (r.top + r.height / 2))); thumb.style.transform = `translateY(${active.off}px)`; };
  track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); e.stopPropagation(); thumb.classList.add('held'); active = { off: 0, t: performance.now() }; move(e); requestAnimationFrame(tick); });
  track.addEventListener('pointermove', move);
  const up = () => { active = null; thumb.classList.remove('held'); thumb.style.transform = ''; };
  track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
  bar.querySelectorAll('.zb-btn').forEach(b => { b.onclick = () => view.zoom(b.dataset.z === 'in' ? 0.8 : 1.25); });
}

function setMode(mode) {
  if (mode === S.ed.mode) return;
  if (mode === 'edit') {
    let o = activeObj();
    if (!o || !S.ed.selected.has(o.id)) { const s = selectedObjs()[0]; o = s || null; }
    if (!o) { toast('Select an object to edit'); return; }
    if (o.shape) { toast('Exact solids are edited with Push/Pull, Fillet, sketches… — Edit mesh is for imported meshes'); return; }
    S.ed.active = o.id; S.ed.selected = new Set([o.id]);
    S.ed.mode = 'edit';
    S.ed.editSel = new Set(o.mesh.v.map((_, i) => i)); S.ed.selOrder = [];
  } else {
    S.ed.mode = 'object'; S.ed.editSel = new Set(); S.ed.selOrder = [];
  }
  selectionChanged();
}
function setSelectMode(sm) {
  S.ed.selectMode = sm;
  if (sm === 'face') { const o = activeObj(); if (o) { const fs = M.selectedFaces(o.mesh, S.ed.editSel); const n = new Set(); fs.forEach(fi => o.mesh.f[fi].forEach(i => n.add(i))); S.ed.editSel = n; } }
  selectionChanged();
}
function selectAllToggle() {
  if (S.ed.workspace === 'draw') {
    const sk = SK.activeSketch(); if (!sk) return;
    const all = sk.ents.filter(e => e.t !== 'dim').map(e => e.id);
    S.ed.drawSel = S.ed.drawSel.size >= all.length && all.length ? new Set() : new Set(all);
    return selectionChanged();
  }
  if (S.ed.mode === 'object' && (S.ed.edges.length || S.ed.faces.length || S.ed.profiles.length || S.ed.drawSel.size)) {
    // sub-picks (edges, faces, regions, curves) clear first
    S.ed.edges = []; S.ed.faces = []; S.ed.profiles = []; S.ed.drawSel = new Set(); clearLast();
    return selectionChanged();
  }
  if (S.ed.mode === 'object') {
    const all = S.doc.objects.filter(isShown);
    if (S.ed.selected.size >= all.length && all.length) S.ed.selected = new Set();
    else { setPickKind('solid'); S.ed.selected = new Set(all.map(o => o.id)); if (!S.ed.selected.has(S.ed.active)) S.ed.active = all[0]?.id ?? null; } // (bodies: Boolean, Pattern … offered)
  } else {
    const o = activeObj(); if (!o) return;
    if (S.ed.editSel.size >= o.mesh.v.length) S.ed.editSel = new Set(); else S.ed.editSel = new Set(o.mesh.v.map((_, i) => i));
    S.ed.selOrder = [];
  }
  selectionChanged();
}
function acadTool(t) { setTool(t); Draw.startCommand(); refresh(); }
const SKETCH_TOOLS = new Set(['line', 'rect', 'circle', 'arc', 'spline', 'polygon', 'ellipse', 'text', 'hatch', 'corner', 'trim', 'dim', 'extend', 'offset', 'erase', 'explode', 'arrayrect', 'arraypolar', 'mirror', 'copy']);
// a drawing command typed on the command line outside a sketch opens one on the current construction plane (AutoCAD's
// UCS), so typed coordinates keep working; the rail and the palette ask for the plane instead (Create Sketch)
function cmdSetTool(t, m) {
  if (SKETCH_TOOLS.has(t) && S.ed.workspace === 'model' && !sketching()) { S.ed.planePick = null; createSketchOn(S.ed.cplane ? { planeDef: { ...S.ed.cplane } } : { plane: 'XY' }); }
  setTool(t, m);
}
function setTool(t, m) {
  if (SKETCH_TOOLS.has(t) && S.ed.workspace === 'model' && !sketching()) { if (m) Draw.drawMode[t] = m; startCreateSketch(t); return; }
  // (tapping the active tool again just starts it over; its mode is chosen on the tool card)
  if (m) Draw.drawMode[t] = m;
  S.ed.tool = t; S.ed.tools[S.ed.workspace] = t; S.ed.consTool = null; S.ed.pickLock = null; S.ed.pendingRun = null;
  Draw.resetTool();
  if (Draw.EDIT_TOOLS.has(t)) Draw.startCommand();
  if (t === 'measure') S.ed.measure = [];
  if (getLast() && getLast().handle) clearLast();
  refresh(); view.render();
}

// =====================================================================
// measure tool
// =====================================================================
let measureGroup, measureKey = '', edgeGroup, faceGroup, faceKey = '';
function drawFaceHighlights() {
  const key = S.ed.workspace === 'model' ? JSON.stringify(S.ed.faces) + '|' + S.doc.objects.map(o => o.mesh.f.length).join() + view.theme.sel : '';
  if (key === faceKey && faceGroup.userData.objs === S.doc.objects) return;
  faceKey = key; faceGroup.userData.objs = S.doc.objects;
  faceGroup.traverse(o => o.geometry && o.geometry.dispose()); faceGroup.clear();
  if (S.ed.workspace !== 'model') return;
  for (const f of S.ed.faces) {
    const o = objById(f.obj); if (!o) continue;
    const W = worldVerts(o), reg = findRegionObj(o, f); if (!reg) continue;
    const pos = [];
    for (const fi of reg.faces) { const P = o.mesh.f[fi].map(i => M.add(W[i], M.mul(f.n, 0.004))); for (const t of M.triangulateFace(P)) for (const k of t) pos.push(...P[k]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    faceGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: view.selHex(), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })));
  }
}
let originGroup = null, originKey = '';
function drawOrigin() {
  const show = (S.settings.showOrigin === true || !!S.ed.planePick) && S.ed.workspace === 'model' && !sketching();
  if (!originGroup) { originGroup = new THREE.Group(); originGroup.renderOrder = 1; view.scene.add(originGroup); }
  originGroup.visible = show; if (!show) return;
  const cur = planeLabel(), key = cur + '|' + view.theme.name;
  if (key !== originKey) {
    originKey = key; originGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); originGroup.clear();
    const P = { XY: [[1, 0, 0], [0, 1, 0], 0x4f8ff7], XZ: [[1, 0, 0], [0, 0, 1], 0x7cc243], YZ: [[0, 1, 0], [0, 0, 1], 0xf2545b] };
    for (const [k, [u, v, col]] of Object.entries(P)) {
      const on = k === cur, q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => u.map((c, i) => c * a + v[i] * b));
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]], 3));
      const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: on ? 0.16 : 0.07, side: THREE.DoubleSide, depthWrite: false }));
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute([...q[0], ...q[1], ...q[1], ...q[2], ...q[2], ...q[3], ...q[3], ...q[0]], 3));
      const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: on ? 0.9 : 0.45 }));
      originGroup.add(fill, line);
    }
  }
  // a fixed size on screen (like the axis triad): about 90 px from the origin to an edge
  originGroup.scale.setScalar(view.worldPerPixel([0, 0, 0]) * 90);
  if (S.ed.planePick) for (const [k, w] of Object.entries(originLabelSpots())) view.label(w, k, 'plane');
}
function initMeasureOverlay() {
  view.renderHooks.push(drawOrigin);
  measureGroup = new THREE.Group(); view.overlayScene.add(measureGroup);
  edgeGroup = new THREE.Group(); view.overlayScene.add(edgeGroup);
  faceGroup = new THREE.Group(); view.scene.add(faceGroup);
  view.renderHooks.push(drawOverlays);
}
// tessellation points are float32: 37.79999923706055 → 37.8 when a short decimal is that close
const clean32 = v => { for (let d = 0; d <= 6; d++) { const q = Math.round(v * 10 ** d) / 10 ** d; if (Math.abs(q - v) <= Math.abs(v) * 2e-7 + 1e-9) return q; } return v; };
// snap points of exact solids: edge ends, edge midpoints and circle centres (never tessellation vertices)
function brepSnap(x, y, tol = 26) {
  const hit = view.pickObject(x, y); let best = null;
  for (const o of S.doc.objects) {
    if (!isShown(o) || !o.brep) continue;
    const xf = xfFor(o);
    for (const e of o.brep.edges) {
      if (e.seam || e.i < 0) continue;
      const pts = [e.pts[0], e.pts.at(-1), K.polyMid(e.pts)];
      if (e.closed && e.type === 'CIRCLE') { const q = e.pts.slice(0, -1); pts.push([0, 1, 2].map(k => q.reduce((s, v) => s + v[k], 0) / q.length)); }
      for (const L of pts) {
        const w = xf.toW(L.map(clean32)), sp = view.project(w); if (!sp.front) continue;
        const d = Math.hypot(sp.x - x, sp.y - y); if (d > tol) continue;
        // hidden behind the surface under the finger (another body, or this body's own face: the far rim of a hole)
        if (hit && view.project(hit.point).depth < sp.depth - view.worldPerPixel(w) * 3) continue;
        // equal on screen (coaxial rims seen end-on): the nearer one wins
        if (!best || d < best.d - 1.5 || (Math.abs(d - best.d) <= 1.5 && sp.depth < best.depth)) best = { d, world: w, depth: sp.depth };
      }
    }
  }
  return best;
}
// a point on a body under the finger: an exact snap point if one is near, else the surface point
Draw.setSolidPointPicker((x, y) => { const b = brepSnap(x, y, 20); if (b) return b.world; const hit = view.pickObject(x, y); return hit ? hit.point : null; });
// a round body edge under the finger: { r, c (world), closed, len }
Draw.setSolidCirclePicker((x, y) => {
  let best = null;
  for (const o of S.doc.objects) {
    if (!isShown(o) || !o.brep) continue;
    const xf = xfFor(o);
    for (const e of o.brep.edges) {
      if (e.seam || e.i < 0 || e.type !== 'CIRCLE') continue;
      const P = e.pts.map(xf.toW);
      for (let k = 1; k < P.length; k++) {
        const A = view.project(P[k - 1]), B = view.project(P[k]); if (!A.front || !B.front) continue;
        const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy; let t = L2 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(A.x + dx * t - x, A.y + dy * t - y), dep = A.depth + (B.depth - A.depth) * t;
        if (d < 24 && (!best || d < best.d - 1.5 || (Math.abs(d - best.d) <= 1.5 && dep < best.dep))) best = { d, e, P, dep }; // coaxial rims end-on: the nearer
      }
    }
  }
  if (!best) return null;
  const { e, P } = best, a = P[0], m = K.polyMid(P), b = P[P.length - 1];
  let c;
  if (e.closed) { const q = P.slice(0, -1); c = [0, 1, 2].map(k => q.reduce((s, v) => s + v[k], 0) / q.length); }
  else { // circumcentre of the start, middle and end points
    const ab = M.sub(b, a), am = M.sub(m, a), n = M.cross(ab, am), n2 = M.dot(n, n);
    c = M.add(a, M.mul(M.add(M.mul(M.cross(n, ab), M.dot(am, am)), M.mul(M.cross(am, n), M.dot(ab, ab))), 1 / (2 * n2)));
  }
  return { r: clean32(M.dist(a, c)), c: c.map(clean32), closed: !!e.closed, len: e.len };
});
// ---------- assembly helpers ----------
// Mate: the first face's body moves so that face lands on the second one — flat faces become coplanar
// (face to face, or flush), round faces become coaxial (a pin in its hole). It is a normal Move step.
const faceGeom = f => F.mateGeom(f);
function startMate() {
  const f = S.ed.faces[0]; if (!f) return;
  const g = faceGeom(f); if (!g) return toast('Mate works with flat and round (cylindrical) faces');
  S.ed.mateFrom = f; S.ed.pick = 'face';
  const others = S.doc.objects.some(o => o.shape && o.id !== g.o.id && isShown(o));
  toast(others ? `Now tap the face to put “${g.o.name}” against` : `Now show the other part (eye in Items, or Show all) and tap the face to put “${g.o.name}” against`); refresh();
}
function mateTap(x, y) {
  const from = S.ed.mateFrom; S.ed.mateFrom = null;
  const prev = S.ed.faces; S.ed.faces = []; faceTap(x, y);
  const to = S.ed.faces[0];
  if (!to) { S.ed.faces = prev; S.ed.mateFrom = from; toast('Tap a face on the other part (or Cancel mate)'); return refresh(); } // a missed tap keeps Mate armed
  if (to.obj === from.obj) { S.ed.faces = prev; S.ed.mateFrom = from; toast('Pick a face on the other body'); return refresh(); }
  const retry = m => { S.ed.mateFrom = from; S.ed.faces = prev; toast(m + ' — tap another face, or Cancel mate'); refresh(); };
  const gA = F.mateGeom(from), gB = F.mateGeom(to);
  if (!gA || !gB) return retry('Mate works with flat and round faces');
  if (gA.kind !== gB.kind) {
    // flat + round: a tap on the flat face beside a hole's rim means that hole's axis (a Ø6 bore is hard to hit)
    const flatRef = gA.kind === 'plane' ? from : to, o = objById(flatRef.obj), xf = xfFor(o);
    const near = F.circleAxisNear(o, xf.toL(flatRef.p), 24 * view.worldPerPixel(flatRef.p));
    if (!near) return retry('Mate a flat face to a flat face, or a round face to a round face');
    flatRef.edgeAxis = true; flatRef.planar = false;
  }
  const err = { kind: F.mateGeom(from)?.kind || gA.kind }; // (not parallel is fine: the Mate step turns the part to line them up)
  const A = objById(from.obj);
  if (F.mateLoop(H.hist().filter(r => r.op === 'F.mateOp' && !r.off && !r.err).map(r => r.params), { a: from, b: to }))
  { const B = objById(to.obj), direct = H.hist().some(r => r.op === 'F.mateOp' && !r.off && !r.err && r.params.a.obj === to.obj && r.params.b.obj === from.obj);
    return retry(direct ? `${B.name} is already mated onto ${A.name} — mate them the other way round (tap ${B.name}'s face first)` : `${B.name} already hangs off ${A.name} through other mates — mating it back would make a loop`); }
  S.ed.faces = []; S.ed.selected = new Set([A.id]); S.ed.active = A.id; // (stays in Face mode for the next mate)
  // a Mate step in the history: it is solved again whenever the parts change (e.g. after Sync)
  // two faces pointing the same way on a part that is already mated: Flush (turning it round would undo its other mates)
  const GA = F.mateGeom(from), GB = F.mateGeom(to), held = H.hist().some(r => r.op === 'F.mateOp' && !r.off && !r.err && r.params.a.obj === A.id);
  const align = GA?.kind === 'plane' && GB?.kind === 'plane' && M.dot(GA.n, GB.n) > 0.9999 && held ? 'flush' : 'face';
  if (!runOp(F.mateOp, { a: JSON.parse(JSON.stringify(from)), b: JSON.parse(JSON.stringify(to)), gap: 0, align })) return retry('Could not mate those faces');
  const rec = H.hist().find(r => r.params === getLast()?.params);
  if (rec?.err) toast(`${A.name} → ${objById(to.obj).name}: ${rec.err}`);
  else toast(`${A.name} mated to ${objById(to.obj).name}${err.kind === 'axis' ? ' (same axis — slide it along with Move)' : ' — set a Gap on the card'}`);
  view.markSelDirty(); refresh(); // (the Mate card stays open: a flat mate's Gap can be typed right away)
}
// show only the selected bodies (a view setting, not saved) until Show all
function isolate(on) {
  if (on) { const ids = selectedObjs().map(o => o.id); if (!ids.length) return toast('Select the bodies to isolate'); S.ed.isolate = new Set(ids); toast(`Isolated ${ids.length} bod${ids.length === 1 ? 'y' : 'ies'} — Show all brings the rest back`); }
  else S.ed.isolate = null;
  view.markSelDirty(); refresh(); view.render();
}
// overlapping solids (parts that would collide): exact intersection volumes, pair by pair
// Check interference: each part's solids get a box, and only solids whose boxes overlap are intersected (the exact,
// slow test); between tests the UI gets a frame, with a progress toast, so a big assembly does not freeze the app
let interfRun = 0, lastInterference = null;
async function checkInterference(objs) {
  const list = (objs && objs.length >= 2 ? objs : S.doc.objects.filter(isShown)).filter(o => o.shape);
  if (list.length < 2) return toast('Interference needs at least two solids');
  const run = ++interfRun;
  const box = s => s.boundingBox.bounds, apart = (a, b) => [0, 1, 2].some(k => a[1][k] < b[0][k] - 1e-9 || b[1][k] < a[0][k] - 1e-9);
  const W = list.map(o => { const w = K.worldShape(o), so = w.solids?.length > 1 ? w.solids : [w]; return { o, b: box(w), parts: so.map(s => ({ s, b: box(s) })) }; });
  const pairs = [];
  for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) {
    if (apart(W[i].b, W[j].b)) continue;
    const sp = [];
    for (const a of W[i].parts) for (const b of W[j].parts) if (!apart(a.b, b.b)) sp.push([a.s, b.s]);
    if (sp.length) pairs.push({ A: W[i], B: W[j], sp });
  }
  const total = pairs.reduce((n, q) => n + q.sp.length, 0), hits = [];
  let done = 0, t0 = performance.now();
  for (const q of pairs) {
    let v = 0;
    for (const [a, b] of q.sp) {
      try { const x = a.intersect(b); v += K.isEmpty(x) ? 0 : K.volume(x); } catch (e) { /* (a pair the kernel cannot intersect is skipped) */ }
      done++;
      if (performance.now() - t0 > 150 && done < total) { toast(`Checking interference… ${done} / ${total}`, 5000); await new Promise(r => setTimeout(r, 0)); t0 = performance.now(); if (run !== interfRun) return; }
    }
    if (v > 5e-3) hits.push({ a: q.A.o, b: q.B.o, v }); // (rounding-level overlaps are touching, not clashing)
  }
  if (run !== interfRun) return;
  lastInterference = hits.map(x => ({ a: x.a.id, b: x.b.id, v: x.v }));
  if (!hits.length) { toast(`No interference between ${list.length} solids`); return; }
  S.ed.selected = new Set(hits.flatMap(x => [x.a.id, x.b.id])); S.ed.active = hits[0].a.id; S.ed.pick = 'solid';
  popover($('#btn-menu'), h('div', {}, h('div', { class: 'mtitle' }, `Interference · ${hits.length} pair${hits.length > 1 ? 's' : ''}`),
    ...hits.map(x => { const small = x.v < 0.005 * Math.min(Math.abs(K.volume(x.a.shape)), Math.abs(K.volume(x.b.shape))); /* (under 0.5 % of the smaller part: mating threads, not a real clash — M8 threads overlap ~100 mm³) */ return h('div', { class: 'mnote', style: 'padding:6px 12px' }, `${x.a.name} ↔ ${x.b.name}: ${fmtVol(x.v)} overlap${small ? ' (slight — mating threads or a press fit overlap a little by design)' : ''}`); }),
    h('div', { class: 'mnote', style: 'padding:6px 12px;opacity:.75' }, 'The overlapping bodies are selected. Move one (or Mate it), or change its size in its own project.')));
  selectionChanged();
}
function measureTap(x, y) {
  let p = null;
  const v = brepSnap(x, y) || view.pickVertex(x, y, { tol: 30, objs: S.doc.objects.filter(o => isShown(o) && !o.brep) });
  if (v) p = v.world;
  else {
    const hit = view.pickObject(x, y);
    if (hit) p = hit.point;
    else { const g = view.groundPoint(x, y); if (g) p = S.settings.snap ? g.map(c => Math.round(c / S.settings.snapStep) * S.settings.snapStep) : g; }
  }
  if (!p) return;
  if (S.ed.measure.length >= 2) S.ed.measure = [];
  S.ed.measure.push({ p, snapped: !!v });
  refresh(); view.render();
}
function drawOverlays() {
  // measurement
  const pts = S.ed.tool === 'measure' ? S.ed.measure : [];
  const key = JSON.stringify(pts.map(q => q.p));
  if (key !== measureKey) {
    measureKey = key; measureGroup.clear();
    const mat = new THREE.LineBasicMaterial({ color: 0x4f8ff7, depthTest: false, transparent: true });
    if (pts.length === 2) {
      measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(q => new THREE.Vector3(...q.p))), mat));
      const [a, b] = [pts[0].p, pts[1].p];
      const c1 = [b[0], a[1], a[2]], c2 = [b[0], b[1], a[2]];
      const dash = new THREE.LineDashedMaterial({ color: 0x9aa4b5, depthTest: false, transparent: true, opacity: 0.6, dashSize: 1, gapSize: 1 });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, c1, c2, b].map(q => new THREE.Vector3(...q))), dash);
      l.userData.dashed = true; measureGroup.add(l);
    }
    for (const q of pts) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 20), new THREE.MeshBasicMaterial({ color: q.snapped ? 0xffe066 : 0x4f8ff7, depthTest: false, transparent: true }));
      m.userData.world = q.p; measureGroup.add(m);
    }
  }
  for (const c of measureGroup.children) {
    if (c.userData.world) { c.position.set(...c.userData.world); c.quaternion.copy(camera().quaternion); c.scale.setScalar(view.worldPerPixel(c.userData.world) * 7); }
    if (c.userData.dashed) { const s = view.worldPerPixel(pts[0].p) * 5; c.material.dashSize = s; c.material.gapSize = s; c.computeLineDistances(); }
  }
  if (pts.length === 2) view.label(M.mul(M.add(pts[0].p, pts[1].p), 0.5), fmtLen(M.dist(pts[0].p, pts[1].p)), 'dim');

  // selected body edges (CAD)
  drawFaceHighlights();
  edgeGroup.clear();
  // while a fillet / chamfer dialog is open, keep showing the edges it works on
  const lop = getLast(), opEdges = !S.ed.edges.length && lop && lop.committed && lop.def === F.edgeBlendOp && !$('#lastop').hidden ? (lop.sel?.edges || []).filter(e => e.pts) : [];
  for (const e of opEdges) edgeGroup.add(Draw.fatLine(e.pts, view.selHex(), 1.8, false));
  if ((S.ed.workspace === 'cad' || S.ed.workspace === 'model') && S.ed.edges.length) {
    for (const e of S.ed.edges) {
      const pts = e.pts || (e.circle ? e.circle.loop : [e.a, e.b]);
      edgeGroup.add(Draw.fatLine(pts, view.selHex(), 2.6, !e.pts && !!e.circle));
      const mk = new THREE.Mesh(new THREE.RingGeometry(0.5, 1, 16), new THREE.MeshBasicMaterial({ color: view.selHex(), depthTest: false }));
      const mid = e.p || (e.circle ? e.circle.loop[0] : M.mul(M.add(e.a, e.b), 0.5));
      mk.position.set(...mid); mk.quaternion.copy(camera().quaternion); mk.scale.setScalar(view.worldPerPixel(mid) * 6); edgeGroup.add(mk);
      view.label(mid, e.circle ? `Ø ${fmtLen(2 * e.circle.R)}` : fmtLen(e.len ?? M.dist(e.a, e.b)), 'edge');
    }
  }
  // edge lengths of selected edges (edit mode)
  if (S.ed.mode === 'edit' && S.settings.edgeLengths !== false && !gizmoActive()) {
    const o = activeObj(); if (!o) return;
    const xf = xfFor(o); let n = 0;
    for (const [a, b] of M.meshEdges(o.mesh)) {
      if (!S.ed.editSel.has(a) || !S.ed.editSel.has(b)) continue;
      const A = xf.toW(o.mesh.v[a]), B = xf.toW(o.mesh.v[b]);
      view.label(M.mul(M.add(A, B), 0.5), fmtLen(M.dist(A, B), S.settings.unit !== 'mm'), 'edge');
      if (++n >= 40) break;
    }
  }
}

// =====================================================================
// static UI
// =====================================================================
const TOOLS = {
  draw: [['select', 'Select', I.select], ['line', 'Line', I.line], ['rect', 'Rect', I.rect], ['circle', 'Circle', I.circle], ['arc', 'Arc', I.arc], ['corner', 'Corner', I.corner], ['trim', 'Trim', I.trim], ['dim', 'Dim', I.dim]],
  cad: [['select', 'Select', I.select], ['edge', 'Edge', I.edgeSel], ['measure', 'Measure', I.measure]],
  model: [['select', 'Select', I.select], ['move', 'Move', I.move], ['rotate', 'Rotate', I.rotate], ['scale', 'Scale', I.scale],
    ['line', 'Line', I.line], ['rect', 'Rect', I.rect], ['circle', 'Circle', I.circle], ['arc', 'Arc', I.arc], ['spline', 'Spline', I.spline], ['polygon', 'Polygon', I.polygon],
    ['corner', 'Corner', I.corner], ['trim', 'Trim', I.trim], ['dim', 'Dim', I.dim], ['measure', 'Measure', I.measure]],
};
// ---------- tool sets (Fusion's toolbar tabs, along the bottom) → their tools down the left rail ----------
// an entry is a modal tool (t: the S.ed.tool it sets), a constraint (c: its kind) or a command (run)
const CONS_NEED = { h: 1, v: 1, fix: 1, par: 2, perp: 2, eq: 2, tan: 2, conc: 2 };
const CONS_ICON = { h: 'cH', v: 'cV', par: 'cPar', perp: 'cPerp', eq: 'cEq', tan: 'cTan', conc: 'cConc', fix: 'cFix' };
const CONS_NAME = { h: 'Horizontal', v: 'Vertical', par: 'Parallel', perp: 'Perpendicular', eq: 'Equal', tan: 'Tangent', conc: 'Concentric', fix: 'Fix' };
// Fusion's two modes: designing the part (Solid · Modify · Assemble · Construct · Inspect, with Create Sketch first),
// and a sketch being edited (Create · Modify · Constrain · Inspect, with Finish Sketch) — the drawing tools only exist
// inside a sketch
function toolsetDefs() {
  const T = (t, label, icon) => ({ id: t, t, label, icon }), A = (id, label, icon, run) => ({ id, label, icon, run });
  const sel = T('select', 'Select', I.select);
  const model = [
    { id: 'solid', label: 'Solid', icon: I.cube, tools: [sel, A('newsketch', 'Sketch', I.sketch, () => startCreateSketch()), A('extrude', 'Extrude', I.extrude, () => startExtrude()), A('revolve', 'Revolve', I.revolve, () => runOp(F.revolve)), A('loft', 'Loft', I.loft, () => runOp(F.loftOp)), A('sweep', 'Sweep', I.sweep, () => runOp(F.sweepOp)),
      A('box', 'Box', I.cube, () => addSketchedPrim('cube')), A('cyl', 'Cylinder', I.cylinder, () => addSketchedPrim('cylinder')), A('sphere', 'Sphere', I.sphere, () => addSketchedPrim('sphere')), A('cone', 'Cone', I.cone, () => addSketchedPrim('cone')), A('torus', 'Torus', I.torus, () => addSketchedPrim('torus')),
      A('hole', 'Hole', I.hole, () => needFaces('Hole', () => runOp(F.holeOp), 1)), A('thread', 'Thread', I.thread, () => needFaces('Thread', () => runOp(F.threadOp), 1)), A('pattern', 'Pattern', I.array, e => openPatternMenu(e.currentTarget)), A('mirror', 'Mirror', I.flip, () => modifier('mirror')), A('thicken', 'Thicken', I.plane, () => runOp(F.thickenOp))] },
    { id: 'modify', label: 'Modify', icon: I.fillet, tools: [sel, A('pushpull', 'Push/Pull', I.extrude, () => modifier('pushpull')), A('fillet', 'Fillet', I.fillet, () => modifier('fillet')), A('chamfer', 'Chamfer', I.chamfer, () => modifier('chamfer')), A('shell', 'Shell', I.inset, () => modifier('shell')),
      A('draft', 'Draft', I.draft, () => needFaces('Draft', () => runOp(F.draftOp))), A('split', 'Split', I.split, () => runOp(F.sliceOp)), A('combine', 'Combine', I.union, e => openBoolMenu(e.currentTarget)), T('move', 'Move', I.move), T('rotate', 'Rotate', I.rotate), T('scale', 'Scale', I.scale),
      A('recess', 'Recess', I.recess, () => needFaces('Recess', () => runOp(F.recessOp), 1)), A('dup', 'Copy', I.dup, () => { if (runOp(OPS.duplicate)) { S.ed.tool = 'move'; refresh(); } }), A('delete', 'Delete', I.trash, () => deleteSelection())] },
    { id: 'assemble', label: 'Assemble', icon: I.joint, tools: [sel, A('insert', 'Insert', I.insert, () => openPanelTab('projects')), A('mate', 'Mate', I.joint, () => needFaces('Mate', () => startMate(), 1)), T('rotate', 'Rotate', I.rotate), T('move', 'Move', I.move),
      A('interf', 'Interfere', I.intersect, () => checkInterference()), A('isolate', 'Isolate', I.eye, () => isolate(!S.ed.isolate)), A('sync', 'Sync', I.history, () => syncSelected())] },
    { id: 'construct', label: 'Construct', icon: I.plane, tools: [sel, A('poffset', 'Offset', I.offset, e => openPlaneMenu(e.currentTarget)), A('pface', 'On face', I.face, () => needFaces('Plane on a face', () => planeHere(), 1))] },
    { id: 'inspect', label: 'Inspect', icon: I.measure, tools: [sel, T('measure', 'Measure', I.measure), A('dist', 'Distance', I.measure, () => acadTool('dist')), A('angle', 'Angle', I.angle, () => acadTool('angle')), A('area', 'Area', I.area, () => acadTool('area')),
      A('radius', 'Radius', I.radius, () => acadTool('radius')), A('id', 'Point', I.point, () => acadTool('id')), A('list', 'List', I.list, () => acadTool('list')), A('interf2', 'Interfere', I.intersect, () => checkInterference()), A('props', 'Properties', I.info, () => openPanelTab('item'))] },
  ];
  const sketch = [
    { id: 'create', label: 'Create', icon: I.draw, tools: [sel, T('line', 'Line', I.line), T('rect', 'Rect', I.rect), T('circle', 'Circle', I.circle), T('arc', 'Arc', I.arc), T('spline', 'Spline', I.spline), T('polygon', 'Polygon', I.polygon),
      A('text', 'Text', I.text, () => acadTool('text')), A('ellipse', 'Ellipse', I.circle, () => acadTool('ellipse')), T('dim', 'Dimension', I.dim)] },
    { id: 'skmodify', label: 'Modify', icon: I.trim, tools: [sel, T('corner', 'Fillet', I.corner), T('trim', 'Trim', I.trim), A('extend', 'Extend', I.extend, () => acadTool('extend')), A('offset', 'Offset', I.offset, () => acadTool('offset')),
      A('skmirror', 'Mirror', I.flip, () => acadTool('mirror')), A('skmove', 'Move', I.move, () => acadTool('move')), A('skcopy', 'Copy', I.dup, () => acadTool('copy')), A('skrotate', 'Rotate', I.rotate, () => acadTool('rotate')), A('skscale', 'Scale', I.scale, () => acadTool('scale')),
      A('skpattern', 'Pattern', I.array, () => acadTool('arrayrect')), A('cons', 'Construction', I.construction, () => Draw.toggleConstruction()), A('skdelete', 'Delete', I.trash, () => Draw.deleteSelected())] },
    { id: 'constrain', label: 'Constrain', icon: I.constrain, tools: [sel, ...Object.keys(CONS_NEED).map(k => ({ id: 'c-' + k, c: k, label: k === 'perp' ? 'Perpend.' : CONS_NAME[k], icon: I[CONS_ICON[k]] })),
      T('dim', 'Dimension', I.dim), A('cons2', 'Construction', I.construction, () => Draw.toggleConstruction())] },
    { id: 'skinspect', label: 'Inspect', icon: I.measure, tools: [sel, A('dist', 'Distance', I.measure, () => acadTool('dist')), A('angle', 'Angle', I.angle, () => acadTool('angle')), A('area', 'Area', I.area, () => acadTool('area')), A('radius', 'Radius', I.radius, () => acadTool('radius'))] },
  ];
  return { model, sketch };
}
let TSETS = null;
const sketching = () => S.ed.editingSketch != null && !!SK.sketchById(S.ed.editingSketch);
const setsNow = () => { TSETS ??= toolsetDefs(); return sketching() ? TSETS.sketch : TSETS.model; };
const setKey = () => (sketching() ? 'sketchToolset' : 'toolset');
const curSet = () => { const list = setsNow(); return list.find(t => t.id === S.settings[setKey()]) || list[0]; };
function setToolset(id) {
  const k = setKey();
  if (S.settings[k] === id) return;
  S.settings[k] = id; saveSettings();
  if (S.ed.consTool && id !== 'constrain') S.ed.consTool = null;
  $('#tools').scrollTop = 0; refresh();
}
function renderToolsets() {
  const nav = $('#toolsets'), list = setsNow(), mode = sketching() ? 'sketch' : 'model';
  if (nav.dataset.mode !== mode) { nav.dataset.mode = mode; nav.replaceChildren(...list.map(t => h('button', { class: 'tset', 'data-set': t.id, role: 'tab', onclick: () => setToolset(t.id) }, h('span', { html: t.icon }), h('span', {}, t.label)))); nav.scrollLeft = 0; }
  const cur = curSet().id;
  nav.querySelectorAll('.tset').forEach(b => { const on = b.dataset.set === cur; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  // sketch mode: the sketch bar (name, plane, Finish Sketch) takes the timeline's place
  const bar = $('#skbar'), k = mode === 'sketch' && SK.sketchById(S.ed.editingSketch);
  bar.hidden = !k;
  if (k) { const t = `${esc(k.name)} <small>· ${k.face ? 'on a face' : esc(planeName(k))}</small>`; if (bar._t !== t) { bar._t = t; bar.querySelector('.sk-nm').innerHTML = t; } }
}
function runRailItem(it, e) {
  if (it.t) return setTool(it.t);
  if (it.c) return startConstraint(it.c);
  S.ed.consTool = null;
  if (S.ed.tool !== 'select' && !isGizmoTool(S.ed.tool)) { S.ed.tool = 'select'; Draw.resetTool(); }
  it.run(e);
}
function renderTools() {
  const row = $('#tools');
  if (S.ed.workspace !== 'model') {
    if (row.dataset.k !== S.ed.workspace) {
      row.dataset.k = S.ed.workspace;
      row.replaceChildren(...TOOLS[S.ed.workspace].map(([id, label, icon]) => h('button', { class: 'tool', 'data-tool': id, onclick: () => setTool(id) }, h('span', { html: icon }), h('span', {}, label))));
    }
  } else {
    const set = curSet(), rk = (sketching() ? 'sk:' : 'set:') + set.id;
    if (row.dataset.k !== rk) {
      row.dataset.k = rk;
      row.replaceChildren(...set.tools.map(it => h('button', { class: 'tool', 'data-tool': it.t || '', 'data-cons': it.c || '', 'data-id': it.id, onclick: e => runRailItem(it, e) }, h('span', { html: it.icon }), h('span', {}, it.label))));
    }
  }
  document.querySelectorAll('#tools .tool').forEach(b => b.classList.toggle('on', b.dataset.cons ? S.ed.consTool === b.dataset.cons : !!b.dataset.tool && b.dataset.tool === S.ed.tool && !(S.ed.consTool && b.dataset.tool === 'select')));
}
// a command that works on faces, tapped with none picked: picking is held to faces until some are tapped
function needFaces(what, run, n) {
  if (S.ed.faces.length && (!n || S.ed.faces.length === n)) return run();
  lockPick('face', n === 1 ? `${what}: tap a face` : `${what}: tap the face(s), then ${what} again`, n === 1 ? run : null);
}
function syncSelected() {
  const linked = selectedObjs().filter(o => o.link);
  if (!linked.length) { toast('Select an inserted component to sync it'); return; }
  for (const pid of new Set(linked.map(o => o.link.pid))) PJ.syncComponent(pid);
}
// ---------- constraints as tools (Fusion): pick the constraint, then tap the curves it applies to ----------
function startConstraint(kind) {
  S.ed.tool = 'select'; Draw.resetTool();
  // curves already picked: apply straight away
  if (S.ed.drawSel.size >= CONS_NEED[kind] || (kind === 'fix' && S.ed.drawSel.size)) { Draw.constrain(kind); S.ed.consTool = kind; S.ed.drawSel = new Set(); refresh(); return; }
  S.ed.consTool = kind; S.ed.drawSel = new Set(); setPickKind('edge');
  toast(`${CONS_NAME[kind]}: tap ${CONS_NEED[kind] === 1 ? 'a curve' : 'two curves'}`);
  refresh();
}
function consTap(x, y) {
  const kind = S.ed.consTool, multi = S.ed.multi;
  S.ed.multi = true; // (picks build up until the constraint has what it needs)
  try { curveOrEdgeTap(x, y); } finally { S.ed.multi = multi; }
  if (S.ed.drawSel.size >= CONS_NEED[kind]) { Draw.constrain(kind); S.ed.drawSel = new Set(); refresh(); }
}
function buildStatic() {
  $('#btn-cmd').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>';
  $('#btn-menu').innerHTML = I.menu; $('#btn-undo').innerHTML = I.undo; $('#btn-redo').innerHTML = I.redo; $('#btn-props').innerHTML = I.gear; $('#btn-history').innerHTML = I.history; $('#btn-look').innerHTML = I.look;
  $('#sheet-close').innerHTML = I.close;
  $('#btn-frame').innerHTML = I.frame; $('#btn-snap').innerHTML = I.magnet; $('#btn-xray').innerHTML = I.xray;
  $('#btn-multi').innerHTML = I.multi; $('#btn-all').innerHTML = I.all;
  $('#btn-browser').innerHTML = I.tree; $('#browser-close').innerHTML = I.close; $('#btn-home').innerHTML = I.home;
  $('#btn-finish').innerHTML = I.check + '<span>Finish Sketch</span>'; $('#skbar .sk-ic').innerHTML = I.sketch;
}

function bindEvents() {
  view.handlers.tap = onTap;
  view.handlers.pressTarget = (x, y) => valueHit(x, y) || (S.ed.mode === 'object' && Draw.labelHit(x, y));
  $('#btn-cmd').onclick = () => openPalette();
  $('#btn-undo').onclick = () => undo();
  $('#btn-redo').onclick = () => redo();
  // right-hand slide-over: History · Items (layers, sketches, bodies) · Info · Settings
  const openPanel = tab => { if (sheetOpen && sheetTab === tab) return toggleSheet(false); if (sheetTab !== tab) $('#sheet-body').scrollTop = 0; sheetTab = tab; toggleSheet(true); renderSheet(); };
  $('#btn-props').onclick = () => openPanel('settings');
  $('#btn-look').onclick = () => openLook();
  $('#btn-history').onclick = () => openPanel('history');
  $('#btn-browser').onclick = () => toggleBrowser();
  $('#btn-finish').onclick = () => finishSketchEdit();
  $('#btn-home').onclick = () => { view.setView('iso'); setTimeout(() => view.frame(S.doc.objects.filter(isShown).flatMap(worldVerts).concat(allSketchPoints())), 240); };
  initZoomBar(); initCursor();
  $('#browser-close').onclick = () => toggleBrowser(false);
  $('#sheet-close').onclick = () => toggleSheet(false);
  $('#sheet-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { sheetTab = b.dataset.tab; $('#sheet-body').scrollTop = 0; renderSheet(); } });
  $('#btn-menu').onclick = () => openMainMenu();
  $('#btn-persp').onclick = () => view.toggleOrtho();
  let lastFrame = 0;
  $('#btn-frame').onclick = () => {
    const p = OPS.selectedWorldPoints(), again = performance.now() - lastFrame < 4000; lastFrame = performance.now();
    // first tap frames the selection, a second tap everything (right after Insert, the whole assembly)
    if (p.length && !again) return view.frame(S.ed.mode === 'object' ? selectedObjs().flatMap(worldVerts) : p);
    // nothing selected: every shown body and sketch
    view.frame(S.doc.objects.filter(isShown).flatMap(worldVerts).concat(allSketchPoints()));
  };
  $('#btn-snap').onclick = () => { S.settings.snap = !S.settings.snap; saveSettings(); toast(S.settings.snap ? `Snap on · ${fmtLen(S.settings.snapStep)} · ${S.settings.angleStep}°` : 'Snap off'); refresh(); };
  $('#btn-xray').onclick = () => { S.settings.xray = !S.settings.xray; saveSettings(); view.applyXray(); refresh(); };
  $('#btn-multi').onclick = () => { S.ed.multi = !S.ed.multi; toast(S.ed.multi ? 'Multi-select: taps add / remove' : 'Multi-select off'); refresh(); };
  $('#btn-all').onclick = selectAllToggle;
  $('#file-input').addEventListener('change', onFile);
  $('#viewport').addEventListener('pointerdown', () => { if (keypadOpen()) closeKeypad(false); }, true);
  // the slide-over closes on any tap outside it (phones), and that tap does nothing else
  let sheetClosedAt = 0;
  document.addEventListener('pointerdown', e => {
    if (!sheetOpen || document.body.classList.contains('sheet-docked') || !e.target.closest) return;
    if (e.target.closest('#sheet, #popover, #scrim, #keypad, #btn-history, #btn-props, #btn-look, #browser, #btn-browser')) return;
    toggleSheet(false); sheetClosedAt = performance.now(); e.stopPropagation(); e.preventDefault();
  }, true);
  document.addEventListener('click', e => { if (performance.now() - sheetClosedAt < 500) { e.stopPropagation(); e.preventDefault(); } }, true);

  on('change', () => { view.markSelDirty(); refreshSoon(); });
  on('lastop', () => refreshSoon());
  on('history', () => refreshSoon());
  on('dirty', scheduleSave);
  on('timeline', () => refreshSoon());
  on('toast', m => toast(m));
  on('viewchange', () => renderViewButtons());
  on('drawcard', () => { renderDrawCard(); Cmd.render(); });
  on('cmd', () => refresh());
  on('undoRequest', () => undo());
  on('selection', () => selectionChanged());
  on('change', ({ reason } = {}) => { if (reason === 'undo' || reason === 'redo') { Draw.resetTool(); if (S.ed.workspace === 'draw') view.cam.lock2D = true; } });
  on('gestureUndo', () => { undo(); toast('Undo'); });
  on('gestureRedo', () => { redo(); toast('Redo'); });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { closePopover(); if (sheetOpen) toggleSheet(true); });
}

let refreshQueued = false;
function refreshSoon() { if (!refreshQueued) { refreshQueued = true; requestAnimationFrame(() => { refreshQueued = false; refresh(); }); } }
let inRefreshFix = false;
function refresh() {
  if ([...S.ed.selected].some(id => !isShown(objById(id)))) { S.ed.selected = new Set([...S.ed.selected].filter(id => isShown(objById(id)))); if (!S.ed.selected.has(S.ed.active) && S.ed.mode !== 'edit') S.ed.active = [...S.ed.selected].pop() ?? null; }
  if (S.ed.faces.some(f => !isShown(objById(f.obj)))) S.ed.faces = S.ed.faces.filter(f => isShown(objById(f.obj)));
  if (S.ed.edges.some(e => !isShown(objById(e.obj)))) S.ed.edges = S.ed.edges.filter(e => isShown(objById(e.obj)));
  // picked curves only count while their sketch is there and shown
  if (S.ed.drawSel.size) { const k = SK.sketchById(S.ed.sketch); if (!k || !isShown(k)) S.ed.drawSel = new Set(); else if ([...S.ed.drawSel].some(id => !SK.entById(k, id))) S.ed.drawSel = new Set([...S.ed.drawSel].filter(id => SK.entById(k, id))); }
  // drawing lives inside a sketch: when the open one is gone (undone, deleted, rolled back) it is finished, and
  // with no sketch open a drawing tool goes back to Select
  if (S.ed.workspace === 'model' && !sketching() && !inRefreshFix) {
    inRefreshFix = true;
    try { if (S.ed.editingSketch != null) finishSketchEdit(); if (SKETCH_TOOLS.has(S.ed.tool)) { S.ed.tool = 'select'; Draw.resetTool(); } } finally { inRefreshFix = false; }
  }
  document.body.classList.toggle('editing-sketch', S.ed.editingSketch != null); document.body.classList.toggle('sketching', sketching());
  // editing a sketch: on a face the part stays solid with the sketch drawn on it (Fusion); a sketch on a free plane
  // ghosts the bodies so it shows through them. The grid moves onto the sketch's plane (or the drawing plane).
  const eds0 = S.ed.editingSketch != null ? SK.sketchById(S.ed.editingSketch) : null;
  const ghost = !!eds0 && !eds0.face;
  if (view.xrayFor !== ghost) { view.xrayFor = ghost; view.applyXray(); }
  view.gridPlane = eds0 ? eds0.plane : S.ed.cplane || null; view.gridDark = !!eds0?.face;
  document.body.classList.toggle('ws-model', S.ed.workspace === 'model');
  document.body.classList.toggle('ws-draw', S.ed.workspace === 'draw');
  document.body.classList.toggle('ws-cad', S.ed.workspace === 'cad');
  Cmd.render();
  renderTop(); renderToolsets(); renderTools(); renderActions(); renderHud(); renderDrawCard(); renderLastOp(); renderMeasureCard(); renderViewButtons(); BR.renderTimeline(); BR.renderHistoryBadge();
  if (browserOpen) renderBrowser();
  if (sheetOpen && !gizmoActive()) renderSheet();
  view.render();
}

function renderTop() {
  $('#btn-browser').classList.toggle('on', browserOpen);
  $('#btn-undo').disabled = !canUndo(); $('#btn-redo').disabled = !canRedo();
  $('#btn-snap').classList.toggle('on', S.settings.snap);
  $('#btn-xray').classList.toggle('on', S.settings.xray);
  $('#btn-multi').classList.toggle('on', S.ed.multi);
}
function renderViewButtons() {
  const b = $('#btn-persp');
  const want = view.cam.ortho ? 'ortho' : 'persp';
  if (b.dataset.v !== want) { b.dataset.v = want; b.innerHTML = I[want] + `<span class="tag">${view.cam.ortho ? 'ORTH' : 'PERSP'}</span>`; }
  renderHud();
}

function act(icon, label, fn, cls = '') { return h('button', { class: 'act ' + cls, onclick: fn }, h('span', { html: icon }), h('span', {}, label)); }
function renderActions() {
  const row = $('#actions');
  const key = (S.ed.planePick ? 'pp' + !!S.ed.cplane : '') + (sketching() ? 'SK' : '') + (Draw.consSelected()?.cid ?? '') + '|' + (S.ed.pickLock || '') + (S.ed.consTool || '') + (S.ed.pendingRun ? 'pend' : '') + (S.ed.mateFrom ? 'mate' : '') + (S.ed.isolate ? 'iso' : '') + S.ed.workspace + S.ed.mode + S.ed.selectMode + S.ed.pick + (S.ed.editingSketch ?? '') + (getLast() && getLast().committed && !$('#lastop').hidden ? 'op' : '') + selectedObjs().map(o => o.id + (o.link ? (PJ.outOfDate(o.link.pid) ? 'L!' : 'L') : '')).join(':') + S.ed.faces.map(f => f.planar === false ? 'c' : 'f').join('') + [S.ed.drawSel.size, S.ed.profiles.length, S.ed.faces.length, S.ed.edges.length, S.ed.pick === 'solid' ? S.ed.selected.size : 0].join();
  if (row.dataset.k === key) return;
  row.dataset.k = key;
  if (S.ed.workspace === 'draw') {
    row.replaceChildren(
      act(I.constrain, 'Constrain', e => openConstrainMenu(e.currentTarget)),
      act(I.sketch, 'Sketch', e => openSketchMenu(e.currentTarget)),
      act(I.measure, 'Inquiry', e => openInquiryMenu(e.currentTarget)),
      act(I.move, 'Move', () => acadTool('move')),
      act(I.dup, 'Copy', () => acadTool('copy')),
      act(I.rotate, 'Rotate', () => acadTool('rotate')),
      act(I.flip, 'Mirror', () => acadTool('mirror')),
      act(I.scale, 'Scale', () => acadTool('scale')),
      act(I.inset, 'Offset', () => acadTool('offset')),
      act(I.next, 'Extend', () => acadTool('extend')),
      act(I.file, 'Text', () => acadTool('text')),
      act(I.fill, 'Hatch', () => acadTool('hatch')),
      act(I.circle, 'Ellipse', () => acadTool('ellipse')),
      act(I.arc, 'Spline', () => acadTool('spline')),
      act(I.polygon, 'Polygon', () => acadTool('polygon')),
      act(I.array, 'Array', () => acadTool('arrayrect')),
      act(I.revolve, 'Polar array', () => acadTool('arraypolar')),
      act(I.array, 'Explode', () => acadTool('explode')),
      act(I.trash, 'Erase', () => acadTool('erase'), 'danger'),
      act(I.face, 'On face', () => startFacePick()),
      act(I.save, 'DXF', () => exportDXF()),
      act(I.next, 'To CAD', () => setWorkspace('cad')),
    );
    return;
  }
  if (S.ed.workspace === 'cad') {
    row.replaceChildren(
      act(I.extrude, 'Extrude', () => startExtrude(), 'primary'),
      act(I.revolve, 'Revolve', () => runOp(F.revolve)),
      act(I.cone, 'Loft', () => runOp(F.loftOp)),
      act(I.arc, 'Sweep', () => runOp(F.sweepOp)),
      act(I.fillet, 'Fillet', () => runOp(F.edgeBlendOp, { kind: 'fillet' })),
      act(I.chamfer, 'Chamfer', () => runOp(F.edgeBlendOp, { kind: 'chamfer' })),
      act(I.union, 'Union', () => runOp(F.bodyBoolean, { kind: 'union' })),
      act(I.subtract, 'Subtract', () => runOp(F.bodyBoolean, { kind: 'subtract' })),
      act(I.intersect, 'Intersect', () => runOp(F.bodyBoolean, { kind: 'intersect' })),
      act(I.subdiv, 'Slice', () => runOp(F.sliceOp)),
      act(I.revolve, 'Pattern', e => openPatternMenu(e.currentTarget)),
      act(I.face, 'On face', () => startFacePick()),
      act(I.sketch, 'Sketch', e => openSketchMenu(e.currentTarget)),
      act(I.trash, 'Delete', () => runOp(OPS.deleteObjs), 'danger'),
    );
    return;
  }
  const modeSeg = S.ed.mode === 'edit' ? h('div', { class: 'ctxseg' },
    h('div', { class: 'seg icons' }, ...['vert', 'edge', 'face'].map(sm => h('button', { class: S.ed.selectMode === sm ? 'on' : '', 'aria-label': sm, html: I[sm], onclick: () => setSelectMode(sm) }))),
    h('button', { class: 'act', onclick: () => setPick('solid') }, h('span', { html: I.check }), h('span', {}, 'Done'))) : null;
  if (S.ed.mode === 'object') {
    // Plasticity-style: the bar shows the commands that apply to what is selected
    const curves = S.ed.drawSel.size, prof = S.ed.profiles.length, faces = S.ed.faces.length, edges = S.ed.edges.length;
    const solids = S.ed.pick === 'solid' ? S.ed.selected.size : 0;
    const c = [];
    // an operation's dialog is open: the bar offers finishing it instead of unrelated commands
    const lop = getLast();
    // Create Sketch waiting for its plane: the origin planes as buttons too
    if (S.ed.planePick) {
      const pb = (k, label) => act(I.plane, label, () => createSketchOn({ plane: k }));
      row.replaceChildren(pb('XY', 'XY · Top'), pb('XZ', 'XZ · Front'), pb('YZ', 'YZ · Right'), ...(S.ed.cplane ? [act(I.plane, S.ed.cplane.label || 'Plane', () => createSketchOn({ planeDef: { ...S.ed.cplane } }))] : []), act(I.close, 'Cancel', () => { S.ed.planePick = null; refresh(); }));
      return;
    }
    // a picked constraint glyph: remove it, or put it down
    if (Draw.consSelected()) { const cs = Draw.consSelected(); row.replaceChildren(act(I.trash, `Delete ${Draw.consName(cs.t)}`, () => Draw.deleteConsSel(), 'danger'), act(I.check, 'Done', () => { Draw.clearConsSel(); S.ed.drawSel = new Set(); selectionChanged(); })); return; }
    // a command or constraint waiting for picks: a way out
    if (S.ed.consTool) { row.replaceChildren(act(I.check, 'Done', () => { S.ed.consTool = null; S.ed.drawSel = new Set(); refresh(); }, 'primary')); return; }
    if (S.ed.pickLock && !curves && !prof && !faces && !edges && !solids) { row.replaceChildren(act(I.close, 'Cancel', () => { S.ed.pickLock = null; S.ed.pendingRun = null; refresh(); }, 'primary')); return; }
    if (lop && lop.committed && (lop.def.fields || lop.info) && !$('#lastop').hidden && !curves && !prof && !faces && !edges) {
      row.replaceChildren(act(I.check, 'Done', () => { clearLast(); selectionChanged(); }, 'primary'), act(I.undo, 'Cancel', () => undo()));
      return;
    }
    if (prof) c.push(act(I.extrude, 'Extrude', outOfSketch(() => startExtrude()), 'primary'), act(I.revolve, 'Revolve', outOfSketch(() => runOp(F.revolve))), ...(prof >= 2 ? [act(I.cone, 'Loft', outOfSketch(() => runOp(F.loftOp)))] : []), act(I.arc, 'Sweep', outOfSketch(() => runOp(F.sweepOp))));
    const flat = S.ed.faces.every(f => f.planar !== false); // push/pull and draft work on flat faces
    // Thread only on round, straight faces (cylinders), not cones
    const cyl = !flat && S.ed.faces.every(f => { if (f.planar !== false) return false; try { const o = objById(f.obj), h = K.faceAt(o.shape, xfFor(o).toL(f.p)); return !h || h.f.geomType === 'CYLINDRE'; } catch (e) { return true; } });
    if (S.ed.mateFrom) { row.replaceChildren(act(I.close, 'Cancel mate', () => { S.ed.mateFrom = null; refresh(); }, 'primary')); return; }
    if (faces === 1 && S.doc.objects.filter(o => o.shape).length > 1) /* (also while isolated, or with the other parts hidden to reach a covered face: show them again once Mate is armed) */ c.push(act(I.join, 'Mate', () => startMate()));
    const faceLinked = faces && S.ed.faces.some(f => objById(f.obj)?.link);
    if (faces === 1) c.push(act(I.plane, 'Plane here', () => planeHere()));
    if (faces && faceLinked) { if (!c.length) c.push(act(I.measure, 'Inquiry', e => openInquiryMenu(e.currentTarget))); }
    else if (faces) c.push(...(!cyl ? [] : [act(I.thread, 'Thread', () => runOp(F.threadOp), 'primary')]), ...(flat ? [act(I.extrude, 'Push/Pull', () => modifier('pushpull'), prof ? '' : 'primary'), act(I.hole, 'Hole', () => runOp(F.holeOp)), act(I.recess, 'Recess', () => runOp(F.recessOp))] : []), act(I.inset, 'Shell', () => modifier('shell'), flat || prof ? '' : 'primary'), ...(flat || cyl ? [act(I.cone, 'Draft', () => runOp(F.draftOp))] : []), act(I.flip, 'Mirror', () => modifier('mirror')), act(I.subdiv, 'Slice', () => runOp(F.sliceOp)));
    if (edges) c.push(act(I.fillet, 'Fillet', () => modifier('fillet'), 'primary'), act(I.chamfer, 'Chamfer', () => modifier('chamfer')),
      ...(S.ed.edges.some(q => q.pts) ? [act(I.next, 'Chain', () => growEdges(false)), act(I.select, 'Loop', () => growEdges('loop')), act(I.all, 'All edges', () => growEdges(true))] : []));
    const textSel = curves && [...S.ed.drawSel].some(id => SK.sketchById(S.ed.sketch)?.ents.find(e => e.id === id)?.t === 'text');
    if (textSel) c.push(act(I.extrude, 'Outline', () => Draw.outlineText(), 'primary'));
    if (curves && !sketching()) c.push(act(I.sketch, 'Edit sketch', () => activateSketch(S.ed.sketch), 'primary'), act(I.next, 'Chain', () => chainCurves()));
    else if (curves) c.push(act(I.next, 'Chain', () => chainCurves()), act(I.move, 'Move', () => acadTool('move')), act(I.dup, 'Copy', () => acadTool('copy')), act(I.rotate, 'Rotate', () => acadTool('rotate')), act(I.flip, 'Mirror', () => acadTool('mirror')), act(I.scale, 'Scale', () => acadTool('scale')), act(I.inset, 'Offset', () => acadTool('offset')), act(I.array, 'Array', () => acadTool('arrayrect')), act(I.constrain, 'Constrain', e => openConstrainMenu(e.currentTarget)), act(I.line, 'Construction', () => Draw.toggleConstruction()), act(I.trash, 'Delete', () => Draw.deleteSelected(), 'danger'));
    if (S.ed.isolate) c.push(act(I.eye, 'Show all', () => isolate(false), 'primary'));
    if (solids >= 2) c.push(act(I.intersect, 'Interference', () => checkInterference(selectedObjs())));
    if (solids && !S.ed.isolate) c.push(act(I.eye, 'Isolate', () => isolate(true)));
    const linked = solids === 1 ? selectedObjs().find(o => o.link) : null;
    if (linked) c.push(act(I.history, PJ.outOfDate(linked.link.pid) ? 'Sync ●' : 'Sync', () => PJ.syncComponent(linked.link.pid), PJ.outOfDate(linked.link.pid) ? 'primary' : ''), act(I.folder, 'Open source', () => PJ.openSource(linked.link.pid)));
    if (linked) c.push(act(I.dup, 'Duplicate', () => { if (runOp(OPS.duplicate)) { S.ed.tool = 'move'; refresh(); } }), act(I.revolve, 'Pattern', e => openPatternMenu(e.currentTarget)), act(I.array, 'Array', () => runOp(OPS.arrayOp)), act(I.trash, 'Delete', () => runOp(OPS.deleteObjs), 'danger'));
    else if (solids && selectedObjs().some(o => o.link)) c.push(act(I.dup, 'Duplicate', () => { if (runOp(OPS.duplicate)) { S.ed.tool = 'move'; refresh(); } }), act(I.trash, 'Delete', () => runOp(OPS.deleteObjs), 'danger')); // linked parts are read-only
    else if (solids) c.push(act(I.union, 'Boolean', e => openBoolMenu(e.currentTarget), c.length ? '' : 'primary'), act(I.flip, 'Mirror', () => modifier('mirror')), act(I.inset, 'Shell', () => runOp(F.shellOp)), act(I.subdiv, 'Slice', () => runOp(F.sliceOp)), act(I.revolve, 'Pattern', e => openPatternMenu(e.currentTarget)), act(I.plane, 'Thicken', () => runOp(F.thickenOp)),
      act(I.dup, 'Duplicate', () => { if (runOp(OPS.duplicate)) { S.ed.tool = 'move'; toast('Duplicated — drag the gizmo or type an offset'); refresh(); } }), act(I.array, 'Array', () => runOp(OPS.arrayOp)), act(I.join, 'Join', () => runOp(OPS.joinObjs)), act(I.apply, 'Apply', () => runOp(OPS.applyXf)), act(I.origin, 'Origin', () => runOp(OPS.setOrigin)), ...(selectedObjs().some(o => !o.shape) ? [act(I.subdiv, 'Edit mesh', () => setPick('mesh'))] : []), act(I.trash, 'Delete', () => runOp(OPS.deleteObjs), 'danger'));
    // (nothing selected: the row goes away — the tool sets along the bottom have every command)
    row.replaceChildren(...c);
  } else {
    row.replaceChildren(modeSeg,
      act(I.extrude, 'Extrude', () => runOp(OPS.extrude), 'primary'),
      act(I.inset, 'Inset', () => runOp(OPS.inset)),
      act(I.subdiv, 'Subdivide', () => runOp(OPS.subdivide)),
      act(I.merge, 'Merge', () => runOp(OPS.merge)),
      act(I.fill, 'Fill', () => runFill()),
      act(I.flip, 'Flip', () => runOp(OPS.flip)),
      act(I.recalc, 'Normals', () => runOp(OPS.recalc)),
      act(I.weld, 'Weld', () => runOp(OPS.weldOp)),
      act(I.trash, 'Delete', () => runOp(OPS.deleteGeom), 'danger'),
    );
  }
  row.scrollLeft = 0;
}
function setPick(m) {
  if (m === 'mesh') { S.ed.faces = []; S.ed.edges = []; setMode('edit'); return; }
  if (S.ed.mode === 'edit') { setMode('object'); if (m === 'solid') return; }
  lockPick(m);
}
// Plasticity-style modifiers: if the needed selection is missing, switch to that selection mode
function modifier(kind) {
  if (kind === 'fillet' || kind === 'chamfer') {
    if (!S.ed.edges.length) { setPick('edge'); toast(`Tap edges, then ${kind === 'fillet' ? 'Fillet' : 'Chamfer'}`); return; }
    return runOp(F.edgeBlendOp, { kind });
  }
  if (kind === 'pushpull') { if (!S.ed.faces.length) { setPick('face'); toast('Tap a face, then Push/Pull'); return; } const ok = runOp(F.pushPullOp); if (ok) toast('Drag the arrow or type a distance'); return ok; }
  if (kind === 'shell') { if (!S.ed.faces.length && !S.ed.selected.size) { setPick('face'); toast('Tap the face(s) to open, then Shell'); return; } return runOp(F.shellOp); }
  if (kind === 'mirror') return runOp(F.mirrorOp);
}
function openBoolMenu(anchor) {
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Boolean · first selected is the target'),
    menuItem(I.union, 'Union', () => runOp(F.bodyBoolean, { kind: 'union' })),
    menuItem(I.subtract, 'Subtract', () => runOp(F.bodyBoolean, { kind: 'subtract' })),
    menuItem(I.intersect, 'Intersect', () => runOp(F.bodyBoolean, { kind: 'intersect' }))), { above: true });
}
function sketchPoints() { const sk = SK.activeSketch(); return sk && S.ed.workspace === 'draw' ? sk.ents.flatMap(e => SK.keyPoints(e).map(k => SK.toW(sk.plane, k.p))) : []; }
function runFill() {
  const o = activeObj(); if (!o) return;
  const xf = xfFor(o), vd = view.viewDir();
  const l = M.sub(xf.toL(vd), xf.toL([0, 0, 0]));
  runOp(OPS.fill, { _view: M.norm(l) });
}

function renderHud() {
  const o = activeObj();
  const parts = [];
  const step = `Snap ${S.settings.snap ? fmtLen(S.settings.snapStep) : 'off'}`;
  if (S.ed.workspace === 'draw') {
    const sk = SK.activeSketch();
    if (sk) parts.push(`<b>${esc(sk.name)}</b> · ${sk.face ? 'on face' : esc(planeName(sk))}`, `${sk.ents.filter(e => e.t !== 'dim').length} entities · ${SK.regions(sk).length} closed region${SK.regions(sk).length === 1 ? '' : 's'} · ${Draw.dofText()}`);
    parts.push(`Grid ${fmtLen(view.gridStep)} · ${step} · ${S.settings.angleStep}°`);
    $('#hud').innerHTML = parts.join('<br>');
    return;
  }
  if (S.ed.workspace === 'cad') {
    const t = selectedObjs();
    parts.push(`<b>CAD</b> · ${S.ed.profiles.length} profile${S.ed.profiles.length === 1 ? '' : 's'} · ${S.ed.edges.length} edge${S.ed.edges.length === 1 ? '' : 's'} · ${t.length ? esc(t.map(x => x.name).join(', ')) : 'no body'}`);
    parts.push(S.ed.pickFace ? '<b>Tap a face…</b>' : S.ed.tool === 'edge' ? 'Tap edges, then Fillet or Chamfer' : 'Tap regions to pick profiles, bodies to target');
    $('#hud').innerHTML = parts.join('<br>');
    return;
  }
  if (S.ed.planePick) { $('#hud').innerHTML = `<b>Create Sketch</b> · tap a plane (XY · XZ · YZ${S.ed.cplane ? ' · ' + esc(S.ed.cplane.label || 'construction') : ''}) or a flat face`; return; }
  if (S.ed.pickFace) { $('#hud').innerHTML = '<b>Sketch on face</b><br>Tap a flat face of a body'; return; }
  const eds = S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch);
  const rolled = H.hist().length - H.markerIndex();
  const rb = rolled > 0 ? `<span class="rbwarn">⏪ Rolled back · ${rolled} later step${rolled === 1 ? '' : 's'} not applied — new work is inserted here</span><br>` : '';
  if (rb && !eds) { const prev = $('#hud'); queueMicrotask(() => { if (!prev.innerHTML.startsWith('<span class="rbwarn">')) prev.innerHTML = rb + prev.innerHTML; }); }
  if (eds && S.ed.mode === 'object') {
    const used = H.firstUsing([eds.id]) >= 0;
    const dof = Draw.dofText ? Draw.dofText() : '';
    const nc = eds.ents.filter(e => e.t !== 'dim').length, nr = SK.regions(eds).length;
    $('#hud').innerHTML = `<b>${nc} curve${nc === 1 ? '' : 's'} · ${nr} profile${nr === 1 ? '' : 's'}</b>${dof ? ' · ' + esc(dof) : ''}<br>${used ? 'Features built from it update as you change it' : nc ? 'Tap <b>Finish Sketch</b>, then tap a profile to extrude it' : 'Pick a tool on the left and draw'}`;
    return;
  }
  if (S.ed.workspace === 'model' && S.ed.mode === 'object') {
    const drawing = !isGizmoTool(S.ed.tool) && S.ed.tool !== 'select';
    const plural = (n, w) => `${n} ${n === 1 ? w : w === 'body' ? 'bodies' : w + 's'}`;
    const sel = [[S.ed.drawSel.size, 'curve'], [S.ed.profiles.length, 'profile'], [S.ed.faces.length, 'face'], [S.ed.edges.length, 'edge'], [S.ed.pick === 'solid' ? S.ed.selected.size : 0, 'body']].filter(q => q[0]).map(([n, w]) => plural(n, w));
    const bodyName = S.ed.pick === 'solid' && S.ed.selected.size === 1 ? objById([...S.ed.selected][0])?.name : null;
    if (Draw.consSelected()) parts.push(`<b>${Draw.consName(Draw.consSelected().t)} constraint</b>`, 'Delete removes it · the curves it ties are shown picked');
    else if (S.ed.consTool) parts.push(`<b>${CONS_NAME[S.ed.consTool]}</b> · tap ${CONS_NEED[S.ed.consTool] === 1 ? 'a curve' : `two curves (${S.ed.drawSel.size}/2)`}`, 'Pick another constraint, or Select to stop');
    else if (S.ed.pickLock && !hasPicks()) parts.push(`<b>Tap ${S.ed.pickLock === 'edge' ? 'edges' : S.ed.pickLock === 'face' ? 'a face' : 'a body'}</b>`, S.ed.pendingRun ? 'The command goes on once you tap it' : 'Then choose the command again');
    else if (drawing) parts.push(`<b>${{ dist: 'Distance', id: 'Point', list: 'List' }[S.ed.tool] || S.ed.tool[0].toUpperCase() + S.ed.tool.slice(1)}</b> · tap points on the model or the grid`);
    else if (bodyName) parts.push(`<b>${esc(bodyName)}</b> · whole body selected`, 'Tap it again for the face under your finger');
    else if (sel.length) parts.push(`<b>${sel.join(', ')}</b>`, S.ed.faces.length === 1 && !S.ed.multi ? 'Tap the face again for its whole body' : S.ed.multi ? 'Multi-select: taps add or remove' : '');
    else if (!S.doc.objects.length && !(S.doc.sketches || []).length) parts.push('<b>Sketch</b> to start: tap a plane, draw, then <b>Finish Sketch</b>', '<span class="kbhint">Space or 🔍 for commands</span>');
    else parts.push('<b>Tap</b> a face, edge or profile · <b>Sketch</b> for a new sketch', '<span class="kbhint">Space or 🔍 for commands</span>');
    $('#hud').innerHTML = parts.filter(Boolean).join('<br>');
    return;
  }
  if (S.ed.workspace === 'model' && S.ed.mode === 'object' && S.ed.pick !== 'solid') {
    parts.push(`<b>${S.ed.pick === 'face' ? 'Face' : 'Edge'} select</b> · ${S.ed.pick === 'face' ? S.ed.faces.length + ' face' + (S.ed.faces.length === 1 ? '' : 's') : S.ed.edges.length + ' edge' + (S.ed.edges.length === 1 ? '' : 's')}`);
    parts.push(S.ed.pick === 'face' ? 'Push/Pull · Shell · Mirror · Move/Rotate/Scale the face' : 'Fillet · Chamfer · Move the edge');
    $('#hud').innerHTML = parts.join('<br>');
    return;
  }
  if (S.ed.mode === 'edit' && o) {
    const fs = M.selectedFaces(o.mesh, S.ed.editSel).length;
    parts.push(`<b>${esc(o.name)}</b> · Edit`, `V ${S.ed.editSel.size}/${o.mesh.v.length} · F ${fs}/${o.mesh.f.length}`);
  } else {
    parts.push(o && S.ed.selected.has(o.id) ? `<b>${esc(o.name)}</b>${S.ed.selected.size > 1 ? ` +${S.ed.selected.size - 1}` : ''}` : `<b>${S.doc.objects.length}</b> object${S.doc.objects.length === 1 ? '' : 's'}`);
  }
  parts.push(`${view.cam.ortho ? 'Ortho' : 'Persp'} · Grid ${fmtLen(view.gridStep)} · ${step}`);
  $('#hud').innerHTML = parts.join('<br>');
}
function planeName(sk) {
  for (const p of Object.values(SK.PLANES)) if (p.n.every((c, i) => Math.abs(Math.abs(c) - Math.abs(sk.plane.n[i])) < 1e-9)) {
    // an offset plane is named by where it sits (Front (XZ) · Y 40 is y = 40), not by a distance along its normal
    const k = p.n.findIndex(c => Math.abs(c) > 0.5), at = sk.plane.o[k];
    return p.label + (Math.abs(at) > 1e-9 ? ` · ${'XYZ'[k]} ${fmtLen(at)}` : '');
  }
  return sk.plane.label || 'custom plane';
}
function renderDrawCard() {
  const el = $('#draw-card');
  const INQ = ['dist', 'id', 'angle', 'area', 'radius', 'list'];
  const content = (S.ed.workspace === 'draw' || (S.ed.workspace === 'model' && S.ed.mode === 'object' && (sketching() || INQ.includes(S.ed.tool)) && (!isGizmoTool(S.ed.tool) && (S.ed.tool !== 'select' || S.ed.drawSel.size)))) && !gizmoActive() ? Draw.cardContent() : null;
  el.hidden = !content; document.body.classList.toggle('has-drawcard', !!content);
  if (content) el.replaceChildren(content);
  renderLastOp();
}
// ---------- Plasticity-style command palette ----------
function commands() {
  const C = (name, keys, run, words = '') => ({ name, keys, run, words });
  const tool = t => () => setTool(t);
  return [
    C('Create sketch', 'K', () => startCreateSketch(), 'new sketch plane draw 2d'), C('Finish sketch', '', () => (sketching() ? finishSketchEdit() : toast('No sketch is open')), 'exit stop done close sketch'),
    ...['XY', 'XZ', 'YZ'].map(k => C(`Sketch on ${SK.PLANES[k].label}`, '', () => { S.ed.planePick = { tool: null }; createSketchOn({ plane: k }); }, 'new sketch plane')),
    C('Line', 'L', tool('line'), 'polyline pline draw'), C('Rectangle', '⇧R', tool('rect'), 'rect box draw'), C('Circle', 'C', tool('circle'), 'draw'), C('Arc', '', tool('arc'), 'draw'),
    ...Object.entries(Draw.MODES).flatMap(([t, L]) => L.map(([m, label]) => C(`${({ rect: 'Rectangle', circle: 'Circle', arc: 'Arc' })[t]} · ${label}`, '', () => setTool(t, m), 'draw mode ' + m))),
    C('Spline', '', tool('spline'), 'curve'), C('Polygon', '', tool('polygon'), 'hexagon'), C('Ellipse', '', () => acadTool('ellipse')), C('Text', '', () => acadTool('text')), C('Hatch', '', () => acadTool('hatch')),
    C('Curve fillet / chamfer', '', tool('corner'), 'corner round'), C('Trim curve', '', tool('trim')), C('Extend curve', '', () => setTool('extend')), C('Offset curve', '', () => acadTool('offset')), C('Dimension', '', tool('dim'), 'dim measure constraint'),
    C('Extrude', 'E', () => (S.ed.profiles.length ? startExtrude() : modifier('pushpull')), 'push pull'), C('Revolve', '', () => runOp(F.revolve)), C('Loft', '', () => runOp(F.loftOp)), C('Sweep', '', () => runOp(F.sweepOp)),
    C('Fillet edges', 'F', () => modifier('fillet'), 'round'), C('Chamfer edges', '⇧C', () => modifier('chamfer'), 'bevel'), C('Push / pull face (offset face)', 'O', () => modifier('pushpull'), 'offset face move face'),
    C('Shell', 'H', () => modifier('shell'), 'hollow'), C('Draft', '', () => runOp(F.draftOp), 'taper'), C('Thicken', '', () => runOp(F.thickenOp)), C('Mirror', 'M', () => modifier('mirror')), C('Slice', '', () => runOp(F.sliceOp), 'cut split'),
    C('Pattern (polar)', '', () => runOp(F.polarPattern), 'array circular'), C('Pattern (linear)', '', () => runOp(F.linearPattern), 'array row grid repeat vents slots'), C('Union', '', () => runOp(F.bodyBoolean, { kind: 'union' }), 'boolean join add'), C('Subtract', '', () => runOp(F.bodyBoolean, { kind: 'subtract' }), 'boolean difference cut'), C('Intersect', '', () => runOp(F.bodyBoolean, { kind: 'intersect' }), 'boolean'),
    C('Move', 'G', tool('move'), 'grab translate'), C('Rotate', 'R', tool('rotate')), C('Scale', 'S', tool('scale')), C('Duplicate', '⇧D', () => runOp(OPS.duplicate), 'copy'), C('Delete', 'X', () => deleteSelection(), 'erase remove'),
    ...OPS.PRIM_TYPES.map(([t, l]) => C(`Add ${l}`, '', () => addSketchedPrim(t), 'primitive solid box')),
    C('Select: Edge mode', '2', () => setPick('edge'), 'curve'), C('Select: Face mode', '3', () => setPick('face'), 'region'), C('Select: Solid mode', '4', () => setPick('solid'), 'body'), C('Edit mesh (polygons)', 'Tab', () => setPick('mesh')),
    C('Measure distance', '', () => acadTool('dist'), 'dist inquiry'), C('Check interference', '', () => checkInterference(), 'clash overlap collision assembly fit'), C('Isolate selection', '', () => isolate(true), 'hide others focus'), C('Show all', '', () => isolate(false), 'unhide isolate'), C('Measure angle', '', () => acadTool('angle')), C('Measure radius', '', () => acadTool('radius'), 'diameter circle hole'), C('Point coordinates (ID)', '', () => acadTool('id'), 'id point xyz'), C('Measure area', '', () => acadTool('area')), C('Measure (3D)', '', tool('measure')),
    C('Construction plane: Top (XY)', '', () => { S.ed.cplane = null; toast('Drawing plane: XY'); }, 'cplane'), C('Construction plane: Front (XZ)', '', () => { S.ed.cplane = SK.PLANES.XZ; toast('Drawing plane: XZ'); }, 'cplane'), C('Construction plane: Right (YZ)', '', () => { S.ed.cplane = SK.PLANES.YZ; toast('Drawing plane: YZ'); }, 'cplane'),
    C('Toggle construction curves', '', () => Draw.toggleConstruction()), C('Toggle snapping', '', () => $('#btn-snap').click(), 'snap'), C('Toggle X-ray', '', () => $('#btn-xray').click()), C('Toggle perspective / ortho', '5', () => view.toggleOrtho()),
    C('View: Top', '7', () => view.setView('top')), C('View: Front', '1', () => view.setView('front')), C('View: Right', '3', () => view.setView('right')), C('View: Isometric', '0', () => view.setView('iso')), C('Frame all', 'Home', () => view.frame(S.doc.objects.flatMap(worldVerts).concat(allSketchPoints()))),
    C('AutoCAD command line', '', () => { S.settings.cmdline = !S.settings.cmdline; saveSettings(); refresh(); }, 'acad typed coordinates'),
    C('Look: theme, lighting, edges…', '', () => openLook(), 'appearance colours colors dark light'),
    ...Object.entries(view.LIGHTING).map(([k, L]) => C(`Lighting: ${L.name}`, '', () => setLook('lighting', k), 'light render shade')),
    ...Object.entries(view.THEMES).map(([k, t]) => C(`Theme: ${t.name}`, '', () => setLook('theme', k), 'appearance colours colors dark light')),
    ...Object.entries(view.FINISH).map(([k, f]) => C(`Surface: ${f.name}`, '', () => setLook('finish', k), 'material finish shiny')),
    C('Edges: scale with zoom', '', () => setLook('edgeScale', 'zoom'), 'line width thickness'), C('Edges: same width at any zoom', '', () => setLook('edgeScale', 'screen'), 'line width thickness pixel'),
    C('Undo', '⌘Z', () => undo()), C('Redo', '⇧⌘Z', () => redo()), C('Save project', '⌘S', () => saveProject()), C('Open / import', '', () => $('#file-input').click(), 'step stl obj'), C('Thread', '', () => (S.ed.faces.length ? runOp(F.threadOp) : (setPick('face'), toast('Tap a shaft or hole face, then Thread'))), 'screw bolt nut helix tap'), C('Hole', '', () => (S.ed.faces.length ? runOp(F.holeOp) : (setPick('face'), toast('Tap a flat face where the hole goes, then Hole'))), 'drill counterbore countersink pattern bolt circle'), C('Recess', '', () => (S.ed.faces.length ? runOp(F.recessOp) : (setPick('face'), toast('Tap a flat face (a screw head), then Recess'))), 'drive socket hex allen phillips cross slot screwdriver'), C('Export STEP (exact)', '', () => exportAs('step'), 'step stp cad'), C('Export STL', '', () => exportAs('stl')), C('Export OBJ', '', () => exportAs('obj')), C('Export DXF', '', () => exportDXF()), C('New scene', '', () => { if (confirm('Start a new scene?')) newScene(); }),
  ];
}
function deleteSelection() {
  if (Draw.consSelected()) return Draw.deleteConsSel();
  if (S.ed.mode === 'edit') return runOp(OPS.deleteGeom);
  if (S.ed.drawSel.size) return Draw.deleteSelected();
  if (S.ed.selected.size) return runOp(OPS.deleteObjs);
  toast('Nothing selected');
}
function openPalette() {
  const list = h('div', { class: 'pal-list' }), inp = h('input', { class: 'textin pal-in', placeholder: 'Search commands…', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  const all = commands();
  let shown = all, idx = 0;
  const score = (c, q) => { const n = (c.name + ' ' + c.words).toLowerCase(); if (!q) return 1; if (n.startsWith(q)) return 3; if (n.split(/\s+/).some(w => w.startsWith(q))) return 2; let i = 0; for (const ch of q) { i = n.indexOf(ch, i); if (i < 0) return 0; i++; } return 1; };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    shown = all.map(c => [c, score(c, q)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 40);
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((c, i) => h('button', { class: 'mi' + (i === idx ? ' hot' : ''), onclick: () => run(c) }, c.name, c.keys ? h('span', { class: 'k' }, c.keys) : null)));
  };
  const run = c => { closePopover(); c.run(); refresh(); };
  inp.addEventListener('input', () => { idx = 0; draw(); });
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { idx = Math.min(shown.length - 1, idx + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[idx]) { e.preventDefault(); run(shown[idx]); }
    else if (e.key === 'Escape') closePopover();
  });
  draw();
  popover($('#btn-cmd'), h('div', { class: 'palette' }, inp, list), { align: 'right' });
  setTimeout(() => inp.focus(), 30);
}
function openInquiryMenu(anchor) {
  const it = (icon, l, t, k, pre) => menuItem(icon, l, () => { if (pre) pre(); acadTool(t); }, k);
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Inquiry · Dimensions'),
    it(I.measure, 'Distance', 'dist', 'DI'), it(I.rotate, 'Angle', 'angle', 'MA'), it(I.rect, 'Area', 'area', 'AA'),
    it(I.circle, 'Radius', 'radius', 'MR'), it(I.origin, 'ID point', 'id', 'ID'), it(I.file, 'List', 'list', 'LI'),
    h('div', { class: 'msep' }),
    it(I.dim, 'Linear (H/V) dimension', 'dim', 'DLI', () => { Draw.dimOpts.mode = 'linear'; }),
    it(I.dim, 'Aligned / angular / radial dimension', 'dim', 'DIM', () => { Draw.dimOpts.mode = 'aligned'; })), { above: true });
}
function openConstrainMenu(anchor) {
  const C = [['h', 'Horizontal', 'H'], ['v', 'Vertical', 'V'], ['par', 'Parallel', '∥'], ['perp', 'Perpendicular', '⊥'], ['eq', 'Equal', '='], ['tan', 'Tangent', 'T'], ['conc', 'Concentric', '◎'], ['fix', 'Fix', '⚓']];
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, `Constrain selection · ${S.ed.drawSel.size}`),
    ...C.map(([t, l, g]) => menuItem('', l, () => Draw.constrain(t), g)),
    h('div', { class: 'msep' }),
    menuItem('', 'Construction (toggle)', () => Draw.toggleConstruction(), 'CONS'),
    h('div', { class: 'msep' }),
    h('div', { class: 'note', style: 'padding:6px 12px 8px;max-width:260px' }, 'Touching points stay joined automatically. Tap a glyph (Select tool) to remove a constraint.')), { above: true });
}
function openSketchMenu(anchor) {
  const sks = S.doc.sketches || [];
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, 'New sketch on'),
    ...Object.entries(SK.PLANES).map(([k, p]) => menuItem(I.sketch, p.label, () => { runOp(F.newSketch, { plane: k }); S.ed.tool = S.ed.tools.draw || 'line'; Draw.resetTool(); enterSketchView(SK.activeSketch()); refresh(); })),
    menuItem(I.face, 'Face of a body…', () => startFacePick()),
    sks.length ? h('div', { class: 'msep' }) : null,
    sks.length ? h('div', { class: 'mtitle' }, 'Edit sketch') : null,
    ...sks.map(sk => menuItem(sk.id === S.ed.sketch ? I.check : '', sk.name, () => activateSketch(sk.id), `${sk.ents.length}`))), { above: true });
}
async function exportDXF() {
  const sk = SK.activeSketch(); if (!sk) { toast('No active sketch'); return; }
  const r = await IO.deliver(new Blob([SK.toDXF(sk)], { type: 'application/dxf' }), `${sk.name.replace(/\s+/g, '_')}.dxf`);
  if (r !== 'cancelled') toast('DXF exported (mm, sketch coordinates)');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- adjust-last-operation card ----------
let lastCollapsed = false;
function renderLastOp() {
  const el = $('#lastop'), op = getLast();
  const show = op && op.committed && (op.def.fields || op.info) && $('#draw-card').hidden;
  el.hidden = !show || gizmoActive(); document.body.classList.toggle('has-lastop', !el.hidden);
  document.body.classList.toggle('has-handle', !!(op && op.handle));
  const more = () => el.classList.toggle('more', el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  el.onscroll = more; requestAnimationFrame(more);
  requestAnimationFrame(() => {
    const docked = !el.hidden && matchMedia('(max-width: 500px)').matches;
    const side = !el.hidden && matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    // a draw card across the top (phone) pushes the picture down by half its height instead
    const dc = $('#draw-card'), dcTop = !dc.hidden && S.ed.tool !== 'select' && matchMedia('(max-width: 500px)').matches && dc.getBoundingClientRect().top < innerHeight / 3;
    const dcOff = dcTop ? -Math.max(0, dc.getBoundingClientRect().bottom - $('#topbar').getBoundingClientRect().bottom) / 2 : 0;
    // move the model out from under the dialog: centred in the room left between the timeline and the card (half the
    // card's height pushed it up under the timeline and the HUD)
    const ins = view.insets?.() || { t: 0, b: 0 };
    const off = docked ? Math.max(0, (ins.b - ins.t) / 2) : dcOff, offX = side ? -(el.offsetWidth + 40) / 2 : 0;
    if (Math.abs((view.offsetY || 0) - off) > 1 || Math.abs((view.offsetX || 0) - offX) > 1) { view.offsetY = off; view.offsetX = offX; view.render(); }
  });
  if (!show) return;
  const fields = op.def.fields ? op.def.fields(op.params) : [];
  const fieldEls = fields.map(f => {
    const cls = f.label.length === 1 ? AXC['XYZ'.indexOf(f.label)] || '' : '';
    if (f.kind === 'choice') return choice({ label: f.label, options: f.options, value: op.params[f.key], onChange: v => updateOp({ [f.key]: v }), cls: 'wide' });
    if (f.kind === 'int' && f.key === 'segs') return field({ label: f.label, kind: 'int', value: op.params[f.key], min: f.min, max: f.max, onCommit: v => updateOp({ [f.key]: v }) });
    if (f.kind === 'bool') return choice({ label: f.label, options: [[true, 'Yes'], [false, 'No']], value: !!op.params[f.key], onChange: v => updateOp({ [f.key]: v }), cls: 'half' });
    return field({ label: f.label, kind: f.kind, value: op.params[f.key], min: f.min, max: f.max, cls, onCommit: v => updateOp({ [f.key]: v }) });
  });
  el.classList.toggle('collapsed', lastCollapsed);
  const recErr = H.hist().find(r => r.params === op.params)?.err || ''; // (e.g. a mate that conflicts with another: red in History too)
  el.replaceChildren(
    h('div', { class: 'head' },
      h('div', { class: 'title' }, op.def.label(op.params), op.info ? h('small', {}, op.info) : null),
      fields.length ? h('button', { class: 'ib', 'aria-label': 'Collapse', onclick: () => { lastCollapsed = !lastCollapsed; renderLastOp(); }, html: lastCollapsed ? '▴' : '▾' }) : null,
      h('button', { class: 'ib', 'aria-label': 'Done', onclick: () => clearLast(), html: I.check })),
    ...(recErr ? [h('div', { class: 'cardwarn' }, recErr)] : []),
    ...(fields.length ? [h('div', { class: 'fields' }, fieldEls)] : [])); // (replaceChildren would print a null)
}

function renderMeasureCard() {
  const el = $('#measure-card');
  const pts = S.ed.measure;
  el.hidden = S.ed.tool !== 'measure';
  if (el.hidden) return;
  if (pts.length < 2) { el.replaceChildren(h('div', {}, pts.length ? 'Tap the second point' : 'Tap two points to measure'), h('div', { style: 'color:var(--muted);font-size:11px' }, 'Snaps to vertices, surfaces and grid')); return; }
  const [a, b] = [pts[0].p, pts[1].p], d = M.sub(b, a);
  el.replaceChildren(
    h('div', { class: 'big' }, fmtLen(M.len(d))),
    h('div', {}, h('span', { style: 'color:var(--x)' }, 'ΔX '), fmtLen(d[0])),
    h('div', {}, h('span', { style: 'color:var(--y)' }, 'ΔY '), fmtLen(d[1])),
    h('div', {}, h('span', { style: 'color:var(--z)' }, 'ΔZ '), fmtLen(d[2])));
}

// =====================================================================
// properties sheet
// =====================================================================
let sheetOpen = false, sheetTab = 'item';
// the Browser rises from the bottom bar (and stays open while you work in the view)
let browserOpen = false;
function toggleBrowser(force) {
  browserOpen = force ?? !browserOpen;
  if (browserOpen && sheetOpen && !document.body.classList.contains('sheet-docked')) toggleSheet(false);
  $('#browser').classList.toggle('open', browserOpen); $('#browser').setAttribute('aria-hidden', String(!browserOpen));
  document.body.classList.toggle('has-browser', browserOpen);
  if (browserOpen) renderBrowser();
  refresh();
}
function renderBrowser() {
  const body = $('#browser-body'), keep = body.scrollTop;
  body.replaceChildren(...BR.browserTree());
  body.scrollTop = keep;
}
function toggleSheet(force) {
  sheetOpen = force ?? !sheetOpen;
  if (sheetOpen && browserOpen && !matchMedia('(min-width: 768px), (orientation: landscape) and (min-width: 560px)').matches) toggleBrowser(false); // (phones: one panel at a time)
  $('#sheet').classList.toggle('open', sheetOpen);
  $('#sheet').setAttribute('aria-hidden', String(!sheetOpen));
  document.body.classList.toggle('sheet-docked', sheetOpen && matchMedia('(min-width: 768px), (orientation: landscape) and (min-width: 560px)').matches);
  if (sheetOpen) renderSheet();
}
function group(title, ...kids) { return h('div', { class: 'group' }, h('h3', {}, title), ...kids); }
function stat(k, v) { return h('div', { class: 'stat' }, h('span', {}, k), h('span', {}, v)); }
function setProp(label, id, fn, mesh = false, pres = false) { runOp(OPS.setPropOp(label, [id], () => { const o = objById(id); if (o) return fn(o); }, mesh, pres)); }

function renderSheet() {
  document.querySelectorAll('#sheet-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === sheetTab));
  const body = $('#sheet-body');
  const st = body.scrollTop;
  body.replaceChildren(...(sheetTab === 'item' ? itemTab() : sheetTab === 'objects' ? BR.browserTab(group) : sheetTab === 'history' ? BR.historyTab(group) : sheetTab === 'projects' ? PJ.projectsTab(group) : settingsTab()));
  body.scrollTop = st;
}

function itemTab() {
  const o = activeObj();
  if (S.ed.mode === 'edit' && o) return editItemTab(o);
  if (!o || !S.ed.selected.has(o.id)) return [h('p', { class: 'note' }, 'Nothing selected. Tap an object in the viewport, or add one with ', h('b', {}, '+ Add'), '.')];
  const id = o.id;
  const xyzFields = (key, kind, label, ro = false) => h('div', { class: 'fields' }, [0, 1, 2].map(k => field({
    label: 'XYZ'[k], kind, value: o[key][k], cls: AXC[k], readonly: ro,
    onCommit: v => { if (!ro) setProp(`${o.name} · ${label} ${'XYZ'[k]}`, id, ob => { ob[key][k] = v; }); },
  })));
  const linked = !!o.link; // a linked part can be placed (location, rotation) but not resized
  // exact solids: the B-rep bounding box (the display mesh is a few µm inside curved faces)
  const local = o.shape ? (() => { const b = o.shape.boundingBox.bounds; return { min: b[0], max: b[1] }; })() : M.bbox(o.mesh.v);
  const size = [0, 1, 2].map(k => (o.shape || o.mesh.v.length ? local.max[k] - local.min[k] : 0));
  const dims = size.map((s, k) => s * Math.abs(o.scl[k]));
  const edges = M.meshEdges(o.mesh);
  const closed = !!o.shape || isClosed(o.mesh);
  const sv = Math.abs(o.scl[0] * o.scl[1] * o.scl[2]);
  const area = o.mesh.f.reduce((a, f) => a + M.faceArea(f.map(i => xfFor(o).toW(o.mesh.v[i]))), 0);
  const nameIn = h('input', { class: 'textin', value: o.name, enterkeyhint: 'done', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
  nameIn.addEventListener('change', () => { const n = nameIn.value.trim(); if (n && n !== o.name) setProp('Rename', id, ob => { ob.name = n; }, false, true); });
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') nameIn.blur(); e.stopPropagation(); });
  const colorIn = h('input', { type: 'color', class: 'colorin', value: o.color });
  colorIn.addEventListener('change', () => setProp('Color', id, ob => { ob.color = colorIn.value; }, false, true));
  return [
    S.ed.selected.size > 1 ? h('p', { class: 'note' }, `${S.ed.selected.size} objects selected — editing the active one.`) : null,
    group('Object', h('div', { style: 'display:flex;gap:8px;align-items:center' }, nameIn, colorIn)),
    group('Location', xyzFields('loc', 'len', 'Location')),
    group('Rotation', xyzFields('rot', 'ang', 'Rotation')),
    group('Scale', xyzFields('scl', 'num', 'Scale', linked)),
    group('Dimensions', h('div', { class: 'fields' }, [0, 1, 2].map(k => field({
      label: 'XYZ'[k], kind: 'len', value: dims[k], cls: AXC[k], readonly: size[k] === 0 || linked,
      onCommit: v => { if (size[k] > 0 && !linked) setProp(`${o.name} · Dimension ${'XYZ'[k]}`, id, ob => { ob.scl[k] = (v / size[k]) * (Math.sign(ob.scl[k]) || 1); }); },
    })))),
    linked ? h('p', { class: 'note' }, 'A linked part keeps its size — change it in its own project, then Sync.') : null,
    group('Mesh',
      stat('Vertices', String(o.mesh.v.length)), stat('Edges', String(edges.length)), stat('Faces', String(o.mesh.f.length)),
      stat('Surface area', fmtArea(area)),
      stat('Volume', o.shape ? fmtVol(Math.abs(K.volume(o.shape)) * sv) : closed ? fmtVol(Math.abs(M.meshVolume(o.mesh)) * sv) : 'open mesh'),
      o.link ? stat('Linked from', `${S.doc.components?.[o.link.pid]?.name || 'project'}${PJ.outOfDate(o.link.pid) ? ' · update available' : ' · up to date'}`) : null,
      stat('Geometry', o.shape ? `exact solid · ${o.brep.faces.length} faces · ${o.brep.edges.filter(e => !e.seam).length} edges` : 'triangle mesh'),
      stat('Watertight', closed ? 'yes' : 'no')),
  ].filter(Boolean);
}
function fmtVol(v) { const f = unitFactor(); return `${(v / (f * f * f)).toFixed(S.settings.precision)} ${S.settings.unit}³`; }
function isClosed(m) {
  const c = new Map();
  for (const f of m.f) f.forEach((a, i) => { const k = M.edgeKey(a, f[(i + 1) % f.length]); c.set(k, (c.get(k) || 0) + 1); });
  if (!c.size) return false;
  for (const n of c.values()) if (n !== 2) return false;
  return true;
}

function editItemTab(o) {
  const xf = xfFor(o);
  const ids = [...S.ed.editSel].filter(i => i < o.mesh.v.length);
  const faces = M.selectedFaces(o.mesh, S.ed.editSel);
  const out = [group('Selection', stat('Vertices', `${ids.length} / ${o.mesh.v.length}`), stat('Faces', `${faces.length} / ${o.mesh.f.length}`))];
  if (!ids.length) { out.push(h('p', { class: 'note' }, 'Tap vertices, edges or faces to select. Turn on multi-select (left) to add to the selection.')); return out; }
  const W = ids.map(i => xf.toW(o.mesh.v[i]));
  const c = M.centroid(W);
  out.push(group(ids.length === 1 ? 'Vertex (global)' : 'Median (global)', h('div', { class: 'fields' }, [0, 1, 2].map(k => field({
    label: 'XYZ'[k], kind: 'len', value: c[k], cls: AXC[k],
    onCommit: v => runOp(OPS.setMedianOp('xyz'[k], v)),
  })))));
  if (ids.length === 2) {
    const ord = S.ed.selOrder.filter(i => S.ed.editSel.has(i));
    const b = ord.length ? ord[ord.length - 1] : ids[1], a = ids.find(i => i !== b);
    const A = xf.toW(o.mesh.v[a]), B = xf.toW(o.mesh.v[b]), d = M.sub(B, A);
    out.push(group('Distance',
      h('div', { class: 'fields two' }, field({ label: 'Length (moves last selected)', kind: 'len', value: M.len(d), cls: 'wide', min: 0, onCommit: v => runOp(OPS.setLength, { length: v }) })),
      stat('ΔX', fmtLen(d[0])), stat('ΔY', fmtLen(d[1])), stat('ΔZ', fmtLen(d[2])),
      stat('Angle to XY plane', fmtAng(Math.asin(Math.min(1, Math.abs(d[2]) / (M.len(d) || 1))) * 180 / Math.PI))));
  }
  if (faces.length) {
    const area = faces.reduce((s, fi) => s + M.faceArea(o.mesh.f[fi].map(i => xf.toW(o.mesh.v[i]))), 0);
    const kids = [stat('Area', fmtArea(area))];
    if (faces.length === 1) {
      const n = M.faceNormal(o.mesh.f[faces[0]].map(i => xf.toW(o.mesh.v[i])));
      kids.push(stat('Normal', n.map(v => v.toFixed(4)).join(', ')), stat('Sides', String(o.mesh.f[faces[0]].length)));
    }
    out.push(group(faces.length === 1 ? 'Face' : `Faces (${faces.length})`, ...kids));
  }
  if (ids.length > 1) {
    const bb = M.bbox(W);
    out.push(group('Selection bounds', stat('X', fmtLen(bb.max[0] - bb.min[0])), stat('Y', fmtLen(bb.max[1] - bb.min[1])), stat('Z', fmtLen(bb.max[2] - bb.min[2]))));
  }
  return out;
}

// ---------- look: theme, lighting, finish, edges ----------
function applyTheme() {
  const t = view.THEMES[S.settings.theme] ? S.settings.theme : 'midnight';
  if (t === 'midnight') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', view.THEMES[t].meta);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t === 'daylight' ? 'light' : 'dark');
}
// a lit ball for each lighting preset (CSS only: how the part will read)
const LIGHT_BALL = {
  studio: 'radial-gradient(circle at 36% 30%, #ffffff 0%, #d5ddea 16%, #8592ab 52%, #2c3344 88%, #4a5670 100%)',
  soft: 'radial-gradient(circle at 42% 36%, #f6f8fb 0%, #d3d9e3 40%, #a4adbd 80%, #8f99aa 100%)',
  daylight: 'radial-gradient(circle at 62% 24%, #fff7e2 0%, #ecdcc0 20%, #9bb0cf 62%, #4a5874 100%)',
  dramatic: 'radial-gradient(circle at 84% 46%, #ffffff 0%, #e2cfb3 10%, #3b404c 40%, #0c0e13 72%, #7d97c9 100%)',
  flat: 'radial-gradient(circle at 50% 50%, #bdc6d5 0%, #b3bccb 70%, #a7b1c1 100%)',
  showroom: 'radial-gradient(circle at 34% 28%, #ffffff 0%, #eef2f8 8%, #75829a 34%, #1f242e 62%, #9fb0cc 92%, #dfe6f2 100%)',
};
function lookGroups(rerender) {
  const set = (k, v) => { S.settings[k] = v; saveSettings(); if (k === 'theme') applyTheme(); view.setLook(); refresh(); rerender(); };
  const st = S.settings, cur = (k, d) => st[k] || d;
  const sw = (on, label, note, pv, onClick) => h('button', { class: 'swatch' + (on ? ' on' : ''), onclick: onClick }, pv, h('span', {}, label), note ? h('small', {}, note) : null);
  return [
    group('Theme', h('div', { class: 'swatches' }, Object.entries(view.THEMES).map(([k, t]) => sw(cur('theme', 'midnight') === k, t.name, t.note,
      h('div', { class: 'pv', style: `background: ${t.chip[0]}` }, h('b', {}), h('i', { style: `background: ${t.chip[1]}` })), () => set('theme', k))))),
    group('Lighting', h('div', { class: 'swatches three' }, Object.entries(view.LIGHTING).map(([k, L]) => sw(cur('lighting', 'studio') === k, L.name, null,
      h('div', { class: 'ball' }, h('span', { style: `background: ${LIGHT_BALL[k]}` })), () => set('lighting', k)))),
      h('p', { class: 'note' }, view.LIGHTING[cur('lighting', 'studio')].note + '.')),
    group('Surface',
      choice({ options: Object.entries(view.FINISH).map(([k, f]) => [k, f.name]), value: cur('finish', 'satin'), onChange: v => set('finish', v), cls: 'wide row4' })),
    group('Edges',
      choice({ label: 'Width', options: [['thin', 'Thin'], ['normal', 'Normal'], ['bold', 'Bold']], value: cur('edgeWidth', 'normal'), onChange: v => set('edgeWidth', v), cls: 'wide' }),
      choice({ label: 'When you zoom', options: [['screen', 'Stay the same'], ['zoom', 'Scale with zoom']], value: cur('edgeScale', 'screen'), onChange: v => set('edgeScale', v), cls: 'wide' }),
      h('p', { class: 'note' }, cur('edgeScale', 'screen') === 'zoom' ? 'Edges thicken as you zoom in and thin out as you zoom out, like ink on the part.' : 'Edges stay the same number of pixels wide at any zoom.')),
  ];
}
function setLook(k, v) { S.settings[k] = v; saveSettings(); if (k === 'theme') applyTheme(); view.setLook(); refresh(); }
function openLook() {
  const body = h('div', { class: 'lookpop' });
  const fill = () => body.replaceChildren(h('div', { class: 'mtitle' }, 'Look'), ...lookGroups(fill));
  fill();
  popover($('#btn-look'), body, { align: 'right' });
}
function settingsTab() {
  const set = (k, v) => { S.settings[k] = v; saveSettings(); if (k === 'xray') view.applyXray(); refresh(); renderSheet(); };
  return [
    ...lookGroups(() => renderSheet()),
    group('Units',
      choice({ options: [['mm', 'mm'], ['cm', 'cm'], ['m', 'm'], ['in', 'in'], ['ft', 'ft']], value: S.settings.unit, onChange: v => set('unit', v) }),
      stepper({ label: 'Decimal places', value: S.settings.precision, min: 0, max: 6, onChange: v => set('precision', v) }),
      h('p', { class: 'note' }, 'Geometry is stored in millimetres at double precision. Type expressions such as ', h('kbd', {}, '3/8 in'), ' ', h('kbd', {}, '25.4*2'), ' ', h('kbd', {}, '10mm + 1in'), '.')),
    group('Snapping',
      toggle({ label: 'Snap while dragging', value: S.settings.snap, onChange: v => set('snap', v) }),
      h('div', { class: 'fields two' },
        field({ label: 'Distance step', kind: 'len', value: S.settings.snapStep, min: 1e-6, onCommit: v => set('snapStep', v) }),
        field({ label: 'Angle step', kind: 'ang', value: S.settings.angleStep, min: 0.001, onCommit: v => set('angleStep', v) })),
      choice({ label: 'Distance snapping', options: [[false, 'Increment'], [true, 'Absolute grid']], value: !!S.settings.snapAbs, onChange: v => set('snapAbs', v), cls: 'wide' }),
      toggle({ label: 'Snap to vertices', value: S.settings.vertexSnap, onChange: v => set('vertexSnap', v) })),
    group('Curves',
      h('div', { class: 'fields two' }, field({ label: 'Segments per circle', kind: 'int', value: S.settings.curveSegs || 64, min: 8, max: 1024, onCommit: v => set('curveSegs', v) })),
      h('p', { class: 'note' }, 'Sketch circles and arcs are exact; solids facet them with this many segments per 360°.')),
    group('Display',
      toggle({ label: 'Grid', value: S.settings.grid, onChange: v => set('grid', v) }),
      toggle({ label: 'X-ray', value: S.settings.xray, onChange: v => set('xray', v) }),
      toggle({ label: 'Origin planes', value: S.settings.showOrigin === true, onChange: v => set('showOrigin', v) }),
      toggle({ label: 'Show sketches in Model', value: S.settings.showSketches !== false, onChange: v => set('showSketches', v) }),
      toggle({ label: 'Edge lengths (Edit mode)', value: S.settings.edgeLengths !== false, onChange: v => set('edgeLengths', v) })),
    group('About', h('p', { class: 'note' }, 'StreamLine — precise polygon modelling for the browser. Works offline once loaded; on iPhone use Share → Add to Home Screen for full-screen use.')),
  ];
}

// =====================================================================
// menus
// =====================================================================
function openAddMenu(anchor) {
  const grid = h('div', { class: 'addgrid' }, OPS.PRIM_TYPES.map(([t, label]) => h('button', {
    onclick: () => { closePopover(); if (S.ed.mode === 'edit') setMode('object'); addSketchedPrim(t); },
  }, h('span', { html: I[t] }), label)));
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Add solid'), grid), { above: true });
}
function openMainMenu() {
  popover($('#btn-menu'), h('div', {},
    h('div', { class: 'mtitle' }, PJ.projectName()),
    menuItem(I.folder, 'Projects & assemblies…', () => openPanelTab('projects'), 'on this device'),
    menuItem(I.file, 'New project', () => PJ.newProject()),
    menuItem(I.folder, 'Open / Import…', () => $('#file-input').click(), 'json step stl obj'),
    menuItem(I.save, 'Save project', () => saveProject()),
    menuItem(I.intersect, 'Check interference', () => checkInterference()),
    h('div', { class: 'msep' }),
    menuItem(I.save, 'Export STEP (exact)', () => exportAs('step'), selLabel()),
    menuItem(I.save, 'Export STL', () => exportAs('stl'), selLabel()),
    menuItem(I.save, 'Export OBJ', () => exportAs('obj'), selLabel()),
    menuItem(I.save, 'Export DXF (sketch)', () => exportDXF()),
    h('div', { class: 'msep' }),
    menuItem(I.frame, 'Frame all', () => view.frame(S.doc.objects.flatMap(worldVerts))),
    menuItem(I.persp, 'Views…', () => openViewsMenu()),
    menuItem(I.help, 'Gestures & shortcuts', () => openHelp()),
    menuItem(I.phone, 'Install on iPhone', () => openInstall()),
  ));
}
// only a selection you can see counts (in Face / Edge mode a part stays selected underneath, e.g. after a Mate)
const exportSel = () => S.ed.mode === 'object' && S.ed.pick === 'solid' && S.ed.selected.size > 0;
const selLabel = () => (exportSel() ? `${S.ed.selected.size} selected` : 'all');
function openViewsMenu() {
  const v = (n, l, k) => menuItem('', l, () => view.setView(n), k);
  popover($('#btn-menu'), h('div', {}, h('div', { class: 'mtitle' }, 'Viewpoint'),
    v('top', 'Top', 'Num7'), v('front', 'Front', 'Num1'), v('right', 'Right', 'Num3'),
    v('bottom', 'Bottom', '^Num7'), v('back', 'Back', '^Num1'), v('left', 'Left', '^Num3'), v('iso', 'Isometric', 'Num0')));
}
function openHelp() {
  popover($('#btn-menu'), h('div', { class: 'note', style: 'padding:10px 12px;max-width:360px' },
    h('div', { class: 'mtitle', style: 'padding:0 0 6px' }, 'Touch'),
    h('div', {}, '1 finger drag — orbit · 2 fingers — pan & pinch zoom'),
    h('div', {}, 'Tap — select · 2-finger tap — undo · 3-finger tap — redo'),
    h('div', {}, 'Tap axis bubbles (top-right) for exact Top/Front/Right ortho views; drag them to orbit.'),
    h('div', {}, 'Drag gizmo arrows to move along an axis, squares for a plane, rings to rotate. Snapping follows the magnet button.'),
    h('div', {}, 'After any operation, the card at the bottom lets you type exact values — tap a number to open the calculator keypad.'),
    h('div', { class: 'mtitle', style: 'padding:10px 0 6px' }, 'Keyboard (iPad / desktop)'),
    h('div', {}, h('kbd', {}, 'Tab'), ' mode · ', h('kbd', {}, '1 2 3'), ' vert/edge/face · ', h('kbd', {}, 'G R S'), ' move/rotate/scale · ', h('kbd', {}, 'Q'), ' select · ', h('kbd', {}, 'M'), ' measure'),
    h('div', {}, h('kbd', {}, 'E'), ' extrude · ', h('kbd', {}, 'I'), ' inset · ', h('kbd', {}, 'F'), ' fill · ', h('kbd', {}, 'X'), ' delete · ', h('kbd', {}, 'A'), ' select all · ', h('kbd', {}, '⇧D'), ' duplicate'),
    h('div', {}, h('kbd', {}, '⌘Z'), ' undo · ', h('kbd', {}, '⇧⌘Z'), ' redo · ', h('kbd', {}, 'N'), ' properties · ', h('kbd', {}, '.'), ' frame · ', h('kbd', {}, 'Num 1/3/7/5'), ' views/ortho')));
}
function openInstall() {
  popover($('#btn-menu'), h('div', { class: 'note', style: 'padding:10px 12px;max-width:320px' },
    h('div', { class: 'mtitle', style: 'padding:0 0 6px' }, 'Add to Home Screen'),
    h('div', {}, '1. Open this page in Safari.'), h('div', {}, '2. Tap the Share button.'), h('div', {}, '3. Choose “Add to Home Screen”.'),
    h('div', { style: 'margin-top:8px' }, 'StreamLine then launches full-screen and works offline. Your scene autosaves on this device.')));
}

function newScene() {
  S.doc.objects = []; S.doc.nextId = 1; S.doc.gonePres = {};
  S.ed.mode = 'object'; S.ed.selected = new Set(); S.ed.active = null; S.ed.editSel = new Set(); S.ed.measure = []; S.ed.profiles = []; S.ed.drawSel = new Set();
  S.ed.isolate = null; S.ed.mateFrom = null; S.ed.editingSketch = null; S.ed.cplane = null; S.ed.planePick = null; // (a construction plane belongs to its project)
  defaultScene(); resetHistory(); Draw.clearTarget(); Draw.resetTool(); scheduleSave(); refresh();
  const sk0 = SK.activeSketch(); if (sk0) enterSketchView(sk0); else view.frameAll?.();
}
function exportTargets() {
  const objs = exportSel() ? selectedObjs() : S.doc.objects.filter(isShown);
  return objs.filter(o => o.mesh.f.length);
}
async function exportAs(kind) {
  const objs = exportTargets();
  if (!objs.length) { toast('Nothing to export'); return; }
  const name = (objs.length === 1 ? objs[0].name : PJ.projectName() || 'streamline').replace(/[^\w.-]+/g, '_');
  let blob;
  if (kind === 'step') {
    const solids = objs.filter(o => o.shape);
    if (!solids.length) { toast('STEP needs exact solids (imported meshes have none)'); return; }
    // an assembly STEP: one named, coloured part per body (so CAD apps show the part names)
    // (a linked sub-assembly exports its own parts, named "Seat / Slat")
    try { blob = K.exportSTEP(solids.flatMap(o => PJ.partsOf(o)).map(pt => ({ shape: pt.shape(), name: pt.name, color: pt.color })), { unit: 'MM' }); }
    catch (err) {
      console.warn('assembly STEP failed, writing a plain compound', err);
      try { const shapes = solids.map(o => K.worldShape(o).clone()); blob = (shapes.length === 1 ? shapes[0] : K.R.makeCompound(shapes)).blobSTEP(); }
      catch (err2) { console.error(err2); toast('STEP export failed'); return; }
    }
  } else blob = kind === 'stl' ? IO.exportSTL(objs) : IO.exportOBJ(objs);
  const r = await IO.deliver(blob, `${name}.${kind}`);
  if (r !== 'cancelled') toast(exportSel() && objs.length < S.doc.objects.filter(isShown).length ? `Exported only the ${objs.length} selected (mm) — tap empty space first to export everything` : `Exported ${objs.length} object${objs.length > 1 ? 's' : ''} (mm)`);
}
async function saveProject() {
  // the history rebuilds the solids on open, so the file only needs the light document
  const blob = new Blob([JSON.stringify(serialize(true))], { type: 'application/json' });
  const nm = (PJ.projectName() || 'project').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'project';
  const r = await IO.deliver(blob, `${nm}.streamline.json`);
  if (r !== 'cancelled') toast('Project saved');
}
async function onFile(e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const ext = file.name.toLowerCase().split('.').pop();
  try {
    if (ext === 'json') {
      const txt = await file.text();
      const before = JSON.stringify(serialize());
      try { deserialize(txt); } catch (err) { deserialize(before); throw err; }
      if (S.doc.objects.some(o => o.regen)) { H.resetCache(); H.regenerate(0); for (const o of S.doc.objects) delete o.regen; }
      // an opened file becomes its own project on this device (it never overwrites the one it came from)
      S.doc.project = { id: LIB.newId(), name: S.doc.project?.name || file.name.replace(/\.streamline\.json$|\.json$/i, ''), created: Date.now() };
      resetHistory(); scheduleSave(); refresh(); view.markSelDirty();
      S.ed.tool = S.ed.tools[S.ed.workspace] || 'select'; Draw.resetTool();
      if (S.ed.workspace === 'draw' && SK.activeSketch()) enterSketchView(SK.activeSketch()); else { view.cam.lock2D = false; view.frame(S.doc.objects.flatMap(worldVerts)); }
      toast(`Opened ${file.name}`);
      return;
    }
    if (ext === 'step' || ext === 'stp') {
      const shape = await K.R.importSTEP(file);
      const baseId = S.doc.nextId, nm = file.name.replace(/\.(step|stp)$/i, '');
      let parts; try { parts = K.stepParts(shape, await file.text()); } catch (e) { parts = [{ shape }]; }
      runOp({
        label: () => `Import ${file.name}`, touch: () => ({ ids: [] }),
        apply() {
          const ids = parts.map((pt, k) => { const o = newObject(pt.name || (parts.length > 1 ? `${nm} ${k + 1}` : nm), null, [0, 0, 0], baseId + k); K.setShape(o, pt.shape); if (pt.color) o.color = pt.color; S.doc.objects.push(o); return o.id; });
          S.ed.selected = new Set(ids); S.ed.active = ids[0];
        },
      });
      view.frame(selectedObjs().flatMap(worldVerts));
      toast(parts.length > 1 ? `Imported ${nm} · ${parts.length} exact solids` : `Imported ${nm} · exact solid`);
      return;
    }
    let items;
    if (ext === 'stl') items = [{ name: file.name.replace(/\.stl$/i, ''), mesh: IO.parseSTL(await file.arrayBuffer()) }];
    else if (ext === 'obj') items = IO.parseOBJ(await file.text());
    else throw new Error('Unsupported file type');
    if (!items.length) throw new Error('No geometry found');
    const baseId = S.doc.nextId;
    runOp({
      label: () => `Import ${file.name}`, touch: () => ({ ids: [] }),
      apply() {
        if (S.ed.mode === 'edit') S.ed.mode = 'object';
        const ids = items.map((it, k) => { const o = newObject(it.name || 'Import', it.mesh.clone(), [0, 0, 0], baseId + k); S.doc.objects.push(o); return o.id; });
        S.ed.selected = new Set(ids); S.ed.active = ids[ids.length - 1];
      },
    });
    view.frame(selectedObjs().flatMap(worldVerts));
    const nf = items.reduce((s, it) => s + it.mesh.f.length, 0);
    toast(`Imported ${items.length} object${items.length > 1 ? 's' : ''} · ${nf} faces`);
  } catch (err) { console.error(err); toast('Could not open file: ' + err.message, 3000); }
}

// =====================================================================
// keyboard (iPad keyboards & desktop)
// =====================================================================
function onKey(e) {
  if (keypadKey(e)) return;
  if (e.target.closest && e.target.closest('input, textarea')) return;
  // Plasticity's number typing: with a handle up (Extrude, Push/Pull, Fillet…), digits type its value
  if (!e.metaKey && !e.ctrlKey && typeKey(e)) { e.preventDefault(); return; }
  const k = e.key.toLowerCase(), cmd = e.metaKey || e.ctrlKey;
  if (cmd && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (cmd && k === 'y') { e.preventDefault(); redo(); return; }
  if (cmd && k === 's') { e.preventDefault(); saveProject(); return; }
  if (cmd && k === 'a') { e.preventDefault(); runOp(OPS.applyXf); return; }
  if (cmd) return;
  const code = e.code;
  if (code.startsWith('Numpad')) {
    const n = code.slice(6);
    const m = { '1': e.ctrlKey ? 'back' : 'front', '3': e.ctrlKey ? 'left' : 'right', '7': e.ctrlKey ? 'bottom' : 'top', '0': 'iso' };
    if (m[n]) { view.setView(m[n]); e.preventDefault(); return; }
    if (n === '5') { view.toggleOrtho(); return; }
    if (n === 'Decimal') { $('#btn-frame').click(); return; }
  }
  if (S.ed.workspace === 'draw' || S.ed.workspace === 'cad') {
    // AutoCAD: typing anywhere goes to the command line
    if ((k === 'delete' || k === 'backspace') && S.ed.workspace === 'draw') { Draw.deleteSelected(); return; }
    if (Cmd.key(e)) return;
  }
  if (S.ed.workspace === 'model' && k === ' ' && !S.settings.cmdline) { e.preventDefault(); openPalette(); return; }
  if (S.ed.workspace === 'model' && S.settings.cmdline && Cmd.key(e)) return;
  if (S.ed.workspace === 'model' && S.ed.mode === 'object') {
    const dk = { l: 'line', c: 'circle' };
    if (!e.shiftKey && dk[k]) { setTool(dk[k]); return; }
    if (e.shiftKey && k === 'r') { setTool('rect'); return; }
    if (e.shiftKey && k === 'c') { modifier('chamfer'); return; }
    if (k === 'e' && !e.shiftKey) { if (S.ed.profiles.length) startExtrude(); else modifier('pushpull'); return; }
    if (k === 'k' && !e.shiftKey) { if (!sketching()) startCreateSketch(); return; }
    if ((k === 'escape') && (S.ed.tool !== 'select')) { Draw.resetTool(); setTool('select'); return; }
    if (k === 'escape' && (S.ed.consTool || S.ed.pickLock)) { S.ed.consTool = null; S.ed.pickLock = null; S.ed.pendingRun = null; refresh(); return; }
    if ((k === 'x' || k === 'delete' || k === 'backspace') && !e.shiftKey) { deleteSelection(); return; }
    if (k === 'enter' && Draw.enter()) { refresh(); return; }
    const pm = { '2': 'edge', '3': 'face', '4': 'solid' };
    if (pm[k]) { setPick(pm[k]); return; }
    const gk = { g: 'move', r: 'rotate', s: 'scale' }; // (as the command palette lists them)
    if (!e.shiftKey && gk[k]) { setTool(gk[k]); return; }
    const mm = { f: 'fillet', o: 'pushpull', h: 'shell', m: 'mirror' };
    if (mm[k] && !e.shiftKey) { modifier(mm[k]); return; }
  }
  if (k === 'tab') { e.preventDefault(); if (S.ed.workspace !== 'model') setWorkspace('model'); setMode(S.ed.mode === 'edit' ? 'object' : 'edit'); return; }
  if (S.ed.mode === 'edit' && ['1', '2', '3'].includes(k)) { setSelectMode(['vert', 'edge', 'face'][+k - 1]); return; }
  if (k === 'escape' && (S.ed.consTool || S.ed.pickLock || S.ed.planePick)) { S.ed.consTool = null; S.ed.pickLock = null; S.ed.pendingRun = null; S.ed.planePick = null; refresh(); return; }
  if (k === 'escape') { if (getLast() && getLast().handle) clearLast(); closePopover(); toggleSheet(false); if (browserOpen) toggleBrowser(false); return; }
  const map = {
    g: () => setTool('move'), r: () => setTool('rotate'), s: () => setTool('scale'), q: () => setTool('select'), m: () => setTool('measure'),
    a: () => (e.altKey ? (S.ed.mode === 'edit' ? (S.ed.editSel = new Set()) : (S.ed.selected = new Set()), selectionChanged()) : selectAllToggle()),
    n: () => toggleSheet(),
    '.': () => $('#btn-frame').click(),
    home: () => view.frame(S.doc.objects.flatMap(worldVerts)),
    x: () => runOp(S.ed.mode === 'edit' ? OPS.deleteGeom : OPS.deleteObjs),
    delete: () => runOp(S.ed.mode === 'edit' ? OPS.deleteGeom : OPS.deleteObjs),
    backspace: () => runOp(S.ed.mode === 'edit' ? OPS.deleteGeom : OPS.deleteObjs),
    e: () => S.ed.mode === 'edit' && runOp(OPS.extrude),
    i: () => S.ed.mode === 'edit' && runOp(OPS.inset),
    f: () => S.ed.mode === 'edit' && runFill(),
    d: () => e.shiftKey && S.ed.mode === 'object' && runOp(OPS.duplicate),
  };
  if (map[k]) { e.preventDefault(); map[k](); }
}

boot();
// console/debug access
OPS.setPivotHook(o => {
  const r = H.hist().slice(0, H.markerIndex()).find(x => x.op === 'F.mateOp' && !x.off && x.params?.a?.obj === o.id && x.params.b && F.mateGeom(x.params.b)?.kind === 'axis');
  if (!r) return null;
  const g = F.mateGeom(r.params.b), b = K.worldBounds(o), mid = [0, 1, 2].map(k => (b[0][k] + b[1][k]) / 2);
  return M.add(g.c, M.mul(g.d, M.dot(M.sub(mid, g.c), g.d)));
}, o => {
  const r = H.hist().slice(0, H.markerIndex()).filter(x => x.op === 'F.mateOp' && !x.off && !x.err && x.params?.a?.obj === o.id).map(x => F.mateGeom(x.params.b)).find(g => g?.kind === 'axis');
  if (!r) return null;
  // (a stored axis can point either way: turn it toward its main +X / +Y / +Z so +20° is anticlockwise seen from there)
  const k = [0, 1, 2].reduce((a, i) => (Math.abs(r.d[i]) > Math.abs(r.d[a]) ? i : a), 0);
  return { c: r.c, d: r.d[k] < 0 ? M.mul(r.d, -1) : r.d };
});
window.StreamLine = { gizmoPartAt, K, S, view, OPS, F, SK, Draw, Cmd, runOp, undo, redo, getLast, M, serialize, setWorkspace, H, BR, isShown, addSketchedPrim, refresh: () => selectionChanged(),
  checkInterference: async objs => { await checkInterference(objs); return lastInterference; },
  sketching, startCreateSketch, finishSketchEdit, activateSketch, sketchOn: params => { S.ed.planePick = null; createSketchOn(params); return S.ed.editingSketch; } };

// Primitives are built the parametric way: a sketch on a base plane plus an Extrude / Revolve,
// so they appear in the timeline and can be resized by editing the sketch or the feature.
function addSketchedPrim(type) {
  if (type === 'plane') return runOp(OPS.addPrim, { type });
  const s = OPS.defSize(), r = s / 2;
  const { label, ...base } = SK.PLANES[type === 'cube' || type === 'cylinder' ? 'XY' : 'XZ'];
  const P = {
    cube: { ents: [{ t: 'rect', x: -r, y: -r, w: s, h: s }], seed: [0, 0], op: F.extrude, params: { distance: s } },
    cylinder: { ents: [{ t: 'circle', c: [0, 0], r }], seed: [0, 0], op: F.extrude, params: { distance: s } },
    cone: { ents: [{ t: 'line', a: [0, 0], b: [r, 0] }, { t: 'line', a: [r, 0], b: [0, s] }, { t: 'line', a: [0, s], b: [0, 0] }], seed: [r / 4, s / 4], op: F.revolve, params: { axis: 'y', angle: 360 } },
    sphere: { ents: [{ t: 'arc', c: [0, r], r, a0: -Math.PI / 2, a1: Math.PI / 2 }, { t: 'line', a: [0, s], b: [0, 0] }], seed: [r / 2, r], op: F.revolve, params: { axis: 'y', angle: 360 } },
    torus: { ents: [{ t: 'circle', c: [r, s / 8], r: s / 8 }], seed: [r, s / 8], op: F.revolve, params: { axis: 'y', angle: 360 } },
  }[type];
  if (!P) return;
  const name = OPS.PRIM_TYPES.find(x => x[0] === type)?.[1] || 'Shape';
  if (S.ed.mode === 'edit') setMode('object');
  if (!runOp(F.sketchOpNew(`${name} profile`, base, null, sk => { for (const e of P.ents) F.addEntity(sk, e); }))) return;
  const skId = S.ed.sketch;
  if (runOp(P.op, { pts: [{ sk: skId, pt: P.seed }], mode: 'new', target: null, ...P.params })) mergeLastUndo(); // one Undo takes both away
  S.ed.pick = 'solid'; S.ed.drawSel = new Set(); refresh();
}

// Extrude starts at 0 (nothing built yet): drag the arrow or type the distance
function startExtrude() {
  const ok = runOp(F.extrude);
  if (ok) toast('Drag the arrow or type a distance');
  return ok;
}

// the construction plane new curves go on when not drawn on a face
function planeLabel() {
  const c = S.ed.cplane; if (!c || c === SK.PLANES.XY) return 'XY'; if (c === SK.PLANES.XZ) return 'XZ'; if (c === SK.PLANES.YZ) return 'YZ';
  return c.label || 'custom';
}
// a drawing plane through point o with normal n (u: a world axis projected into it, so typed X/Y read naturally)
function planeAt(o, n, label) {
  n = M.norm(n);
  const ref = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = M.norm(M.sub(ref, M.mul(n, M.dot(ref, n)))), v = M.cross(n, u);
  if (v[2] < -1e-9) { u = M.mul(u, -1); v = M.cross(n, u); } // the sketch's Y points up where it can
  const cl = x => { const q = Math.round(x * 1e9) / 1e9; return Math.abs(q - x) < 1e-9 ? (q === 0 ? 0 : q) : x; };
  return { o: o.map(cl), u: u.map(cl), v: v.map(cl), n: n.map(cl), label };
}
function setDrawPlane(pl, msg) { S.ed.cplane = pl; Draw.resetTool(); Draw.clearTarget(); toast(msg); renderActionsForce(); }
// "Plane here": the plane touching the picked face at the tapped point (tangent to a curved wall), to sketch a
// spout or a handle right where it goes
function planeHere() {
  const f = S.ed.faces[0]; if (!f) return;
  const o = objById(f.obj); let n = f.n, pt = f.p;
  try { const xf = xfFor(o), hit = K.faceAt(o.shape, xf.toL(f.p)); if (hit) { const v = hit.f.normalAt(xf.toL(f.p)), nl = M.norm([v.x, v.y, v.z]); n = M.norm(M.sub(xf.toW(M.add(xf.toL(f.p), nl)), f.p)); if (M.dot(n, f.n) < 0) n = M.mul(n, -1);
    // on a cylinder the touch point goes exactly onto its radius (the tap point is float32: a few µm inside)
    const cy = K.cylinderOf(hit.f); if (cy && cy.R) { const q = xf.toL(f.p), dc = M.sub(q, cy.c), ax = M.mul(cy.d, M.dot(dc, cy.d)), rad = M.sub(dc, ax), rl = M.len(rad); if (rl > 1e-9) { pt = xf.toW(M.add(M.add(cy.c, ax), M.mul(rad, cy.R / rl))); n = M.norm(M.sub(xf.toW(M.add(xf.toL(pt), M.mul(rad, (M.dot(nl, rad) >= 0 ? 1 : -1) / rl))), pt)); if (M.dot(n, f.n) < 0) n = M.mul(n, -1); } } } } catch (e) {}
  // the origin goes where the plane passes nearest the world origin, so typed X / Y / Z are the model's own
  // coordinates (the tapped point is only where the plane touches)
  n = M.norm(n); pt = M.mul(n, M.dot(n, pt));
  const pl = planeAt(pt, n, 'on face'); pl.face = { obj: o.id }; // sketches on it belong to that part (Join / Cut, follow it)
  // (a face looking down is seen from below: one of its axes has to run against the model's)
  const flip = ['X', 'Y', 'Z'].flatMap((A, k) => { const e = [0, 0, 0]; e[k] = 1; return M.dot(pl.u, e) < -0.999 ? [`its X is the model's −${A}`] : M.dot(pl.v, e) < -0.999 ? [`its Y is the model's −${A}`] : []; });
  setDrawPlane(pl, 'Drawing plane set on that face — draw on it, or offset it from the Plane menu' + (flip.length ? ' (seen from outside; typed X and Y are still the model’s own)' : ''));
}
// pick every sketch curve joined end to end with the picked ones (a slot's two lines and two arcs)
function chainCurves() {
  const sk = SK.sketchById(S.ed.sketch); if (!sk) return;
  const ends = e => { const pl = SK.entPolyline(e); return pl && !pl.closed ? [pl.pts[0], pl.pts[pl.pts.length - 1]] : null; };
  const sel = new Set(S.ed.drawSel), list = sk.ents.filter(e => e.t !== 'dim' && ends(e));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of list) {
      if (sel.has(e.id)) continue;
      const E = ends(e);
      if ([...sel].some(id => { const o = SK.entById(sk, id), O = o && ends(o); return O && O.some(a => E.some(b => SK.d2(a, b) < 1e-6)); })) { sel.add(e.id); grew = true; }
    }
  }
  const added = sel.size - S.ed.drawSel.size; S.ed.drawSel = sel;
  toast(added ? `Chain: ${sel.size} curves` : 'Nothing else joins these curves end to end');
  selectionChanged();
}
function openPatternMenu(anchor) {
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Pattern'),
    menuItem(I.array, 'Linear (rows / grid)', () => runOp(F.linearPattern)),
    menuItem(I.revolve, 'Polar (around an axis)', () => runOp(F.polarPattern))), { above: true });
}
function openPlaneMenu(anchor) {
  // turn to look straight at the plane (orthographic), so what is drawn lands where the finger is
  const set = (pl, name) => () => { S.ed.cplane = pl; Draw.resetTool(); view.setView(name.toLowerCase()); toast(`New curves go on the ${name} plane (or on any face you draw on) — rotate the view any time`); renderActionsForce(); };
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Drawing plane'),
    menuItem(I.plane, 'Top (XY)', set(null, 'Top'), planeLabel() === 'XY' ? '✓' : ''),
    menuItem(I.plane, 'Front (XZ)', set(SK.PLANES.XZ, 'Front'), planeLabel() === 'XZ' ? '✓' : ''),
    menuItem(I.plane, 'Right (YZ)', set(SK.PLANES.YZ, 'Right'), planeLabel() === 'YZ' ? '✓' : ''),
    h('div', { class: 'msep' }),
    menuItem(I.plane, 'Offset this plane…', () => setTimeout(() => BR.askText(anchor, 'Offset distance (mm, − goes the other way)', '10', v => {
      let d; try { d = evalExpr(v, 'len'); } catch (e) { return toast(e.message || 'Type a distance'); }
      // (named by where it sits — "XZ · Y 40" is the plane y = 40 — since the Front plane's normal runs along −Y)
      const c = S.ed.cplane || SK.PLANES.XY, o2 = M.add(c.o, M.mul(c.n, d)), k = [0, 1, 2].find(i => Math.abs(Math.abs(c.n[i]) - 1) < 1e-9);
      const pl = planeAt(o2, c.n, k != null ? `${['YZ', 'XZ', 'XY'][k]} · ${'XYZ'[k]} ${+o2[k].toFixed(4)}` : `${planeLabel()} ${d >= 0 ? '+' : ''}${+d.toFixed(4)}`);
      pl.u = c.u.slice(); pl.v = c.v.slice();
      setDrawPlane(pl, `Drawing plane offset ${fmtLen(d)}`);
    }), 0)),
    // tilt about the plane's horizontal (X) direction through its origin: a 15° slot, a sloped face
    menuItem(I.rotate, 'Tilt this plane…', () => setTimeout(() => BR.askText(anchor, 'Tilt angle about the plane\'s X direction (°)', '15', v => {
      let a; try { a = evalExpr(v, 'ang'); } catch (e) { return toast(e.message || 'Type an angle'); }
      const c = S.ed.cplane || SK.PLANES.XY, r = a * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
      const n = M.add(M.mul(c.n, cs), M.mul(c.v, -sn)), vv = M.add(M.mul(c.v, cs), M.mul(c.n, sn));
      const cl = x => Math.abs(x - Math.round(x * 1e9) / 1e9) < 1e-9 ? Math.round(x * 1e9) / 1e9 || 0 : x;
      const pl = { o: c.o.slice(), u: c.u.slice(), v: vv.map(cl), n: n.map(cl), label: `${planeLabel()} ∠${+a.toFixed(3)}°` };
      setDrawPlane(pl, `Drawing plane tilted ${fmtAng(a)}`);
    }), 0))), { above: true });
}
function renderActionsForce() { $('#actions').dataset.k = ''; refresh(); }

function openPanelTab(tab) { if (tab === 'objects') return toggleBrowser(true); if (sheetTab !== tab) $('#sheet-body').scrollTop = 0; sheetTab = tab; toggleSheet(true); renderSheet(); }

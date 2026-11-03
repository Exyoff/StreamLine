// StreamLine — app wiring: selection, modes, panels, menus, persistence.
import * as THREE from 'three';
import { S, on, emit, activeObj, selectedObjs, objById, loadSettings, saveSettings, isShown } from './state.js';
import * as H from './history.js';
import * as BR from './browser.js';
import { view, camera } from './viewport.js';
import { initGizmo, gizmoActive } from './gizmo.js';
import * as OPS from './operators.js';
import { runOp, undo, redo, canUndo, canRedo, getLast, clearLast, updateOp, resetHistory } from './ops.js';
import { serialize, deserialize, newObject, xfFor, worldVerts } from './scene.js';
import * as M from './mesh.js';
import { fmtLen, fmtAng, fmtArea, fmtNum, unitFactor } from './units.js';
import { I } from './icons.js';
import { $, h, toast, field, choice, toggle, stepper, popover, closePopover, menuItem, closeKeypad, keypadOpen, keypadKey } from './ui.js';
import * as IO from './io.js';
import * as SK from './sketch.js';
import * as F from './features.js';
import * as Draw from './draw.js';
import * as Cmd from './cmdline.js';
import { findRegion, faceRegion, faceLoops } from './modifiers.js';
import { featureEdges, straightRun, edgeLoop } from './edges.js';
H.registerOps('F.', F); H.registerOps('O.', OPS); H.registerFactory('setMedianOp', OPS.setMedianOp);

const DOC_KEY = 'streamline.doc.v1';
const AXC = ['ax-x', 'ax-y', 'ax-z'];

// =====================================================================
// boot
// =====================================================================
function boot() {
  loadSettings();
  view.init($('#viewport'));
  view.initNav($('#nav'));
  initGizmo();
  Draw.initDraw();
  routeDrag();
  Cmd.initCmdline({ setTool, setWorkspace, runOp, undo, redo, F, refresh: () => refresh(), zoomAll: () => view.frame(S.doc.objects.flatMap(worldVerts).concat(sketchPoints())), exportDXF: () => exportDXF() });
  initMeasureOverlay();
  buildStatic();
  if (!loadAutosave()) defaultScene();
  S.ed.workspace = 'model'; // the studio: one 3D space for curves, regions and solids
  resetHistory();
  bindEvents();
  BR.initBrowser({
    activateSketch,
    selectionChanged,
    selectObj(id) { if (S.ed.mode === 'edit') setMode('object'); if (S.ed.multi) S.ed.selected.add(id); else S.ed.selected = new Set([id]); S.ed.active = id; if (S.ed.pick !== 'solid') S.ed.pick = 'solid'; selectionChanged(); },
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
  S.doc.history = []; S.doc.marker = null; S.doc.layers = [{ id: 1, name: 'Default', visible: true }]; S.doc.layer = 1;
  S.ed.tools = { draw: 'line', cad: 'select', model: 'select' };
  S.ed.workspace = 'model'; S.ed.tool = 'select'; S.ed.sketch = null;
}
function allSketchPoints() { return (S.doc.sketches || []).filter(isShown).flatMap(k => k.ents.flatMap(e => SK.keyPoints(e).map(q => SK.toW(k.plane, q.p)))); }
const GIZMO_TOOLS = new Set(['move', 'rotate', 'scale', 'measure', 'edge']);
const studioDraws = () => S.ed.workspace === 'model' && S.ed.mode === 'object' && !GIZMO_TOOLS.has(S.ed.tool);

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
  view.handlers.dragEnd = () => { if (owner === 'draw') Draw.up(); else if (owner) owner.end(); owner = null; };
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
  view.lookAlong(sk.plane.n, b.getCenter(new THREE.Vector3()).toArray(), rad * (S.ed.editingSketch != null ? 4.4 : 3.2));
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
  if (!S.doc.objects.some(isShown)) { toast('Make a body first — then you can sketch on its faces'); return; }
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
  const W = worldVerts(o), reg = faceRegion(W, o.mesh.f, hit.face), loops = faceLoops(W, o.mesh.f, reg);
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
let camBeforeEdit = null, pickBeforeEdit = null;
function finishSketchEdit() {
  const id = S.ed.editingSketch, sk = SK.sketchById(id);
  S.ed.editingSketch = null; S.ed.drawSel = new Set(); S.ed.profiles = [];
  if (sk && sk._wasHidden) { sk.hidden = true; delete sk._wasHidden; }
  if (S.ed.tool !== 'select') setTool('select');
  view.cam.lock2D = false;
  if (camBeforeEdit) view.restoreCam(camBeforeEdit); else view.setView('iso');
  camBeforeEdit = null;
  setPick(pickBeforeEdit || 'solid'); pickBeforeEdit = null;
}
function activateSketch(id) {
  const sk = SK.sketchById(id); if (!sk) return;
  if (S.ed.editingSketch != null && S.ed.editingSketch !== id) { const o = SK.sketchById(S.ed.editingSketch); if (o && o._wasHidden) { o.hidden = true; delete o._wasHidden; } }
  if (sk.hidden) sk._wasHidden = true;
  if (S.ed.editingSketch == null) camBeforeEdit = view.saveCam();
  if (S.ed.editingSketch == null) pickBeforeEdit = S.ed.pick;
  S.ed.editingSketch = id; S.ed.pick = 'edge'; S.ed.faces = []; S.ed.edges = []; S.ed.selected = new Set();
  S.ed.sketch = id; sk.hidden = false; Draw.clearTarget();
  if (S.ed.workspace !== 'model') setWorkspace('model');
  enterSketchView(sk); selectionChanged();
}

// ---------- CAD taps: profiles & bodies ----------
function edgeTap(x, y) {
  let best = null;
  const hit = view.pickObject(x, y);
  for (const o of S.doc.objects) {
    if (!isShown(o)) continue;
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
      if (!best || d < best.d) best = { d, o, W, fe, e };
    }
  }
  if (!best) { if (!S.ed.multi) S.ed.edges = []; return selectionChanged(); }
  // a round edge (rim of a hole or boss) is picked as one circular loop
  const circ = edgeLoop(best.W, best.fe, best.e.a, best.e.b);
  const [a, b] = circ ? [circ.loop[0], circ.loop[1]] : straightRun(best.W, best.fe, best.e.a, best.e.b);
  const same = q => q.obj === best.o.id && (circ ? q.circle && M.dist(q.circle.c, circ.c) < 1e-6 && Math.abs(q.circle.R - circ.R) < 1e-6 : !q.circle && ((M.dist(q.a, a) < 1e-6 && M.dist(q.b, b) < 1e-6) || (M.dist(q.a, b) < 1e-6 && M.dist(q.b, a) < 1e-6)));
  const item = circ ? { obj: best.o.id, a, b, circle: circ } : { obj: best.o.id, a, b };
  const i = S.ed.edges.findIndex(same);
  if (i >= 0) S.ed.edges.splice(i, 1);
  else if (S.ed.multi || (S.ed.edges.length && S.ed.edges.every(q => q.obj === best.o.id))) S.ed.edges.push(item);
  else S.ed.edges = [item];
  selectionChanged();
}
// Plasticity-style face pick: a tap selects the whole planar face (all coplanar connected polygons)
function faceTap(x, y) {
  const hit = view.pickObject(x, y);
  if (!hit || hit.face < 0) { if (!S.ed.multi) S.ed.faces = []; return selectionChanged(); }
  const o = objById(hit.id), W = worldVerts(o), reg = faceRegion(W, o.mesh.f, hit.face);
  const same = q => q.obj === o.id && M.dot(q.n, reg.n) > 1 - 1e-9 && Math.abs(q.w - reg.w) < 1e-6 && (() => { const r2 = findRegion(W, o.mesh.f, q.n, q.w, q.p); return r2 && r2.faces.includes(hit.face); })();
  const i = S.ed.faces.findIndex(same);
  if (i >= 0) S.ed.faces.splice(i, 1);
  else { const item = { obj: o.id, n: reg.n, w: reg.w, p: hit.point }; if (S.ed.multi) S.ed.faces.push(item); else S.ed.faces = [item]; }
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
    if (i >= 0) S.ed.profiles.splice(i, 1);
    else if (S.ed.multi) S.ed.profiles.push({ sk: best.sk.id, pt: best.p2 });
    else S.ed.profiles = [{ sk: best.sk.id, pt: best.p2 }];
  } else if (hit) {
    if (S.ed.multi) { if (S.ed.selected.has(hit.id)) S.ed.selected.delete(hit.id); else S.ed.selected.add(hit.id); S.ed.active = hit.id; }
    else { S.ed.selected = new Set([hit.id]); S.ed.active = hit.id; }
  } else if (!S.ed.multi) { S.ed.profiles = []; S.ed.selected = new Set(); }
  selectionChanged();
}
function loadAutosave() {
  try { const s = localStorage.getItem(DOC_KEY); if (!s) return false; deserialize(s); return true; } catch (e) { console.warn(e); return false; }
}
let saveT = 0;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(DOC_KEY, JSON.stringify(serialize())); } catch (e) { toast('Autosave failed (storage full?)'); } }, 400);
}

// =====================================================================
// selection & modes
// =====================================================================
function selectionChanged() { clearLast(); view.markSelDirty(); refresh(); }

let lastViewportTap = 0;
// iOS fires a click ~300 ms after a tap; if a panel appeared under the finger it must not receive it
document.addEventListener('click', e => {
  if (performance.now() - lastViewportTap < 450 && e.target.closest && e.target.closest('#draw-card, #lastop, #measure-card, #popover, #sheet, #actions, #tools')) { e.stopPropagation(); e.preventDefault(); }
}, true);
// Edge mode: sketch curves first (nearest along the ray), else body edges
function curveOrEdgeTap(x, y) {
  const ray = view.ray(x, y).ray;
  let best = null;
  for (const k of tapSketches()) {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...k.plane.n), new THREE.Vector3(...k.plane.o));
    const w = ray.intersectPlane(pl, new THREE.Vector3()); if (!w) continue;
    const p2 = SK.toP(k.plane, w.toArray()), e = SK.pickEntity(k, p2, 16 * view.worldPerPixel(w.toArray()));
    if (e && e.t !== 'hatch' && (!best || w.distanceTo(ray.origin) < best.t)) best = { k, e, t: w.distanceTo(ray.origin) };
  }
  const hit = S.ed.editingSketch != null ? null : view.pickObject(x, y); // bodies are ghosted while a sketch is edited
  if (best && (!hit || best.t <= hit.distance + view.worldPerPixel(hit.point) * 8)) {
    if (S.ed.sketch !== best.k.id || !S.ed.multi) S.ed.drawSel = new Set();
    S.ed.sketch = best.k.id; Draw.clearTarget();
    S.ed.drawSel.has(best.e.id) ? S.ed.drawSel.delete(best.e.id) : S.ed.drawSel.add(best.e.id);
    if (!S.ed.multi) { S.ed.edges = []; S.ed.profiles = []; S.ed.faces = []; }
    return selectionChanged();
  }
  if (!S.ed.multi) S.ed.drawSel = new Set();
  if (S.ed.editingSketch != null) return selectionChanged();
  return edgeTap(x, y);
}
// Face mode: sketch regions first (nearest along the ray), else body faces
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
  if (best && (!hit || best.t <= hit.distance + view.worldPerPixel(hit.point) * 8)) {
    const i = S.ed.profiles.findIndex(q => q.sk === best.k.id && SK.regionAt(best.k, q.pt) === best.r);
    if (i >= 0) S.ed.profiles.splice(i, 1);
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
  if (S.ed.pickFace) return facePickTap(x, y);
  if (S.ed.tool === 'measure') return measureTap(x, y);
  if (S.ed.workspace === 'draw') return Draw.tap(x, y);
  if (S.ed.workspace === 'cad') return cadTap(x, y);
  if (S.ed.mode === 'object' && (Draw.EDIT_TOOLS.has(S.ed.tool) || ['trim', 'dim', 'corner', 'extend'].includes(S.ed.tool))) return Draw.tap(x, y);
  if (S.ed.mode === 'object' && Draw.tapLabel(x, y)) return;
  if (S.ed.mode === 'object' && S.ed.pick === 'edge') return curveOrEdgeTap(x, y);
  if (S.ed.mode === 'object' && S.ed.pick === 'face') return regionOrFaceTap(x, y);
  if (S.ed.mode === 'object') {
    const hit = view.pickObject(x, y);
    if (hit) {
      if (S.ed.multi) {
        if (S.ed.selected.has(hit.id) && S.ed.active === hit.id) { S.ed.selected.delete(hit.id); S.ed.active = [...S.ed.selected].pop() ?? null; }
        else { S.ed.selected.add(hit.id); S.ed.active = hit.id; }
      } else { S.ed.selected = new Set([hit.id]); S.ed.active = hit.id; }
    } else if (!S.ed.multi) { S.ed.selected = new Set(); }
    return selectionChanged();
  }
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

function setMode(mode) {
  if (mode === S.ed.mode) return;
  if (mode === 'edit') {
    let o = activeObj();
    if (!o || !S.ed.selected.has(o.id)) { const s = selectedObjs()[0]; o = s || null; }
    if (!o) { toast('Select an object to edit'); return; }
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
  if (S.ed.mode === 'object') {
    const all = S.doc.objects.filter(isShown);
    if (S.ed.selected.size >= all.length && all.length) S.ed.selected = new Set();
    else { S.ed.selected = new Set(all.map(o => o.id)); if (!S.ed.selected.has(S.ed.active)) S.ed.active = all[0]?.id ?? null; }
  } else {
    const o = activeObj(); if (!o) return;
    if (S.ed.editSel.size >= o.mesh.v.length) S.ed.editSel = new Set(); else S.ed.editSel = new Set(o.mesh.v.map((_, i) => i));
    S.ed.selOrder = [];
  }
  selectionChanged();
}
function acadTool(t) { setTool(t); Draw.startCommand(); refresh(); }
function setTool(t) {
  S.ed.tool = t; S.ed.tools[S.ed.workspace] = t;
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
  const key = S.ed.workspace === 'model' ? JSON.stringify(S.ed.faces) + '|' + S.doc.objects.map(o => o.mesh.f.length).join() : '';
  if (key === faceKey && faceGroup.userData.objs === S.doc.objects) return;
  faceKey = key; faceGroup.userData.objs = S.doc.objects;
  faceGroup.traverse(o => o.geometry && o.geometry.dispose()); faceGroup.clear();
  if (S.ed.workspace !== 'model') return;
  for (const f of S.ed.faces) {
    const o = objById(f.obj); if (!o) continue;
    const W = worldVerts(o), reg = findRegion(W, o.mesh.f, f.n, f.w, f.p); if (!reg) continue;
    const pos = [];
    for (const fi of reg.faces) { const P = o.mesh.f[fi].map(i => M.add(W[i], M.mul(f.n, 0.004))); for (const t of M.triangulateFace(P)) for (const k of t) pos.push(...P[k]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    faceGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffa230, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })));
  }
}
function initMeasureOverlay() {
  measureGroup = new THREE.Group(); view.overlayScene.add(measureGroup);
  edgeGroup = new THREE.Group(); view.overlayScene.add(edgeGroup);
  faceGroup = new THREE.Group(); view.scene.add(faceGroup);
  view.renderHooks.push(drawOverlays);
}
function measureTap(x, y) {
  let p = null;
  const v = view.pickVertex(x, y, { tol: 30 });
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
  if ((S.ed.workspace === 'cad' || S.ed.workspace === 'model') && S.ed.edges.length) {
    for (const e of S.ed.edges) {
      const pts = e.circle ? e.circle.loop : [e.a, e.b];
      edgeGroup.add(Draw.fatLine(pts, 0xff9a1f, 4, !!e.circle));
      const mk = new THREE.Mesh(new THREE.RingGeometry(0.5, 1, 16), new THREE.MeshBasicMaterial({ color: 0xff9a1f, depthTest: false }));
      const mid = e.circle ? e.circle.loop[0] : M.mul(M.add(e.a, e.b), 0.5);
      mk.position.set(...mid); mk.quaternion.copy(camera().quaternion); mk.scale.setScalar(view.worldPerPixel(mid) * 6); edgeGroup.add(mk);
      view.label(mid, e.circle ? `Ø ${fmtLen(2 * e.circle.R)}` : fmtLen(M.dist(e.a, e.b)), 'edge');
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
  draw: [['select', 'Select', I.select], ['line', 'Line', I.line], ['rect', 'Rect', I.rect], ['circle', 'Circle', I.circle], ['arc', 'Arc', I.arc], ['corner', 'Fillet', I.corner], ['trim', 'Trim', I.trim], ['dim', 'Dim', I.dim]],
  cad: [['select', 'Select', I.select], ['edge', 'Edge', I.edgeSel], ['measure', 'Measure', I.measure]],
  model: [['select', 'Select', I.select], ['move', 'Move', I.move], ['rotate', 'Rotate', I.rotate], ['scale', 'Scale', I.scale],
    ['line', 'Line', I.line], ['rect', 'Rect', I.rect], ['circle', 'Circle', I.circle], ['arc', 'Arc', I.arc], ['spline', 'Spline', I.spline], ['polygon', 'Polygon', I.polygon],
    ['corner', 'Fillet', I.corner], ['trim', 'Trim', I.trim], ['dim', 'Dim', I.dim], ['measure', 'Measure', I.measure]],
};
function renderTools() {
  const row = $('#tools');
  if (row.dataset.k !== S.ed.workspace) {
    row.dataset.k = S.ed.workspace;
    row.replaceChildren(...TOOLS[S.ed.workspace].map(([id, label, icon]) => h('button', { class: 'tool', 'data-tool': id, onclick: () => setTool(id) }, h('span', { html: icon }), h('span', {}, label))));
  }
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === S.ed.tool));
}
function buildStatic() {
  $('#btn-cmd').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>';
  $('#btn-menu').innerHTML = I.menu; $('#btn-undo').innerHTML = I.undo; $('#btn-redo').innerHTML = I.redo; $('#btn-props').innerHTML = I.sliders;
  $('#sheet-close').innerHTML = I.close;
  $('#btn-frame').innerHTML = I.frame; $('#btn-snap').innerHTML = I.magnet; $('#btn-xray').innerHTML = I.xray;
  $('#btn-multi').innerHTML = I.multi; $('#btn-all').innerHTML = I.all;
}

function bindEvents() {
  view.handlers.tap = onTap;
  $('#ws-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPick(b.dataset.pick); });
  $('#btn-cmd').onclick = () => openPalette();
  $('#btn-undo').onclick = () => undo();
  $('#btn-redo').onclick = () => redo();
  $('#btn-props').onclick = () => toggleSheet();
  $('#sheet-close').onclick = () => toggleSheet(false);
  $('#sheet-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { sheetTab = b.dataset.tab; renderSheet(); } });
  $('#btn-menu').onclick = () => openMainMenu();
  $('#btn-persp').onclick = () => view.toggleOrtho();
  $('#btn-frame').onclick = () => { const p = OPS.selectedWorldPoints(); view.frame(p.length ? (S.ed.mode === 'object' ? selectedObjs().flatMap(worldVerts) : p) : S.doc.objects.flatMap(worldVerts)); };
  $('#btn-snap').onclick = () => { S.settings.snap = !S.settings.snap; saveSettings(); toast(S.settings.snap ? `Snap on · ${fmtLen(S.settings.snapStep)} · ${S.settings.angleStep}°` : 'Snap off'); refresh(); };
  $('#btn-xray').onclick = () => { S.settings.xray = !S.settings.xray; saveSettings(); view.applyXray(); refresh(); };
  $('#btn-multi').onclick = () => { S.ed.multi = !S.ed.multi; toast(S.ed.multi ? 'Multi-select: taps add / remove' : 'Multi-select off'); refresh(); };
  $('#btn-all').onclick = selectAllToggle;
  $('#file-input').addEventListener('change', onFile);
  $('#viewport').addEventListener('pointerdown', () => { if (keypadOpen()) closeKeypad(false); }, true);

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
function refresh() {
  if ([...S.ed.selected].some(id => !isShown(objById(id)))) { S.ed.selected = new Set([...S.ed.selected].filter(id => isShown(objById(id)))); if (!S.ed.selected.has(S.ed.active) && S.ed.mode !== 'edit') S.ed.active = [...S.ed.selected].pop() ?? null; }
  if (S.ed.faces.some(f => !isShown(objById(f.obj)))) S.ed.faces = S.ed.faces.filter(f => isShown(objById(f.obj)));
  if (S.ed.edges.some(e => !isShown(objById(e.obj)))) S.ed.edges = S.ed.edges.filter(e => isShown(objById(e.obj)));
  document.body.classList.toggle('editing-sketch', S.ed.editingSketch != null);
  if (view.xrayFor !== (S.ed.editingSketch != null)) { view.xrayFor = S.ed.editingSketch != null; view.applyXray(); }
  document.body.classList.toggle('ws-model', S.ed.workspace === 'model');
  document.body.classList.toggle('ws-draw', S.ed.workspace === 'draw');
  document.body.classList.toggle('ws-cad', S.ed.workspace === 'cad');
  view.bg = S.ed.workspace === 'model' ? 0x2b2c30 : 0x212830; // Plasticity-grey studio vs AutoCAD model space
  Cmd.render();
  renderTop(); renderTools(); renderActions(); renderHud(); renderDrawCard(); renderLastOp(); renderMeasureCard(); renderViewButtons(); BR.renderTimeline();
  if (sheetOpen && !gizmoActive()) renderSheet();
  view.render();
}

function renderTop() {
  document.querySelectorAll('#ws-seg button').forEach(b => b.classList.toggle('on', S.ed.mode === 'edit' ? b.dataset.pick === 'mesh' : b.dataset.pick === S.ed.pick));
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
  const key = S.ed.workspace + S.ed.mode + S.ed.selectMode + S.ed.pick + (S.ed.editingSketch ?? '') + [S.ed.drawSel.size, S.ed.profiles.length, S.ed.faces.length, S.ed.edges.length, S.ed.pick === 'solid' ? S.ed.selected.size : 0].join();
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
      act(I.extrude, 'Extrude', () => runOp(F.extrude), 'primary'),
      act(I.revolve, 'Revolve', () => runOp(F.revolve)),
      act(I.cone, 'Loft', () => runOp(F.loftOp)),
      act(I.arc, 'Sweep', () => runOp(F.sweepOp)),
      act(I.fillet, 'Fillet', () => runOp(F.edgeBlendOp, { kind: 'fillet' })),
      act(I.chamfer, 'Chamfer', () => runOp(F.edgeBlendOp, { kind: 'chamfer' })),
      act(I.union, 'Union', () => runOp(F.bodyBoolean, { kind: 'union' })),
      act(I.subtract, 'Subtract', () => runOp(F.bodyBoolean, { kind: 'subtract' })),
      act(I.intersect, 'Intersect', () => runOp(F.bodyBoolean, { kind: 'intersect' })),
      act(I.subdiv, 'Slice', () => runOp(F.sliceOp)),
      act(I.revolve, 'Pattern', () => runOp(F.polarPattern)),
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
    if (S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch)) c.push(act(I.check, 'Finish', () => finishSketchEdit(), 'primary'));
    if (prof) c.push(act(I.extrude, 'Extrude', () => runOp(F.extrude), 'primary'), act(I.revolve, 'Revolve', () => runOp(F.revolve)), ...(prof >= 2 ? [act(I.cone, 'Loft', () => runOp(F.loftOp))] : []), act(I.arc, 'Sweep', () => runOp(F.sweepOp)));
    if (faces) c.push(act(I.extrude, 'Push/Pull', () => modifier('pushpull'), prof ? '' : 'primary'), act(I.inset, 'Shell', () => modifier('shell')), act(I.cone, 'Draft', () => runOp(F.draftOp)), act(I.flip, 'Mirror', () => modifier('mirror')), act(I.subdiv, 'Slice', () => runOp(F.sliceOp)));
    if (edges) c.push(act(I.fillet, 'Fillet', () => modifier('fillet'), 'primary'), act(I.chamfer, 'Chamfer', () => modifier('chamfer')));
    if (curves) c.push(act(I.move, 'Move', () => acadTool('move')), act(I.dup, 'Copy', () => acadTool('copy')), act(I.rotate, 'Rotate', () => acadTool('rotate')), act(I.flip, 'Mirror', () => acadTool('mirror')), act(I.scale, 'Scale', () => acadTool('scale')), act(I.inset, 'Offset', () => acadTool('offset')), act(I.array, 'Array', () => acadTool('arrayrect')), act(I.constrain, 'Constrain', e => openConstrainMenu(e.currentTarget)), act(I.line, 'Construction', () => Draw.toggleConstruction()), act(I.trash, 'Delete', () => Draw.deleteSelected(), 'danger'));
    if (solids) c.push(act(I.union, 'Boolean', e => openBoolMenu(e.currentTarget), c.length ? '' : 'primary'), act(I.flip, 'Mirror', () => modifier('mirror')), act(I.inset, 'Shell', () => runOp(F.shellOp)), act(I.subdiv, 'Slice', () => runOp(F.sliceOp)), act(I.revolve, 'Pattern', () => runOp(F.polarPattern)), act(I.plane, 'Thicken', () => runOp(F.thickenOp)),
      act(I.dup, 'Duplicate', () => { if (runOp(OPS.duplicate)) { S.ed.tool = 'move'; toast('Duplicated — drag the gizmo or type an offset'); refresh(); } }), act(I.array, 'Array', () => runOp(OPS.arrayOp)), act(I.join, 'Join', () => runOp(OPS.joinObjs)), act(I.apply, 'Apply', () => runOp(OPS.applyXf)), act(I.origin, 'Origin', () => runOp(OPS.setOrigin)), act(I.subdiv, 'Edit mesh', () => setPick('mesh')), act(I.trash, 'Delete', () => runOp(OPS.deleteObjs), 'danger'));
    if (!c.length) c.push(act(I.plus, 'Add solid', e => openAddMenu(e.currentTarget), 'primary'), act(I.line, 'Line', () => setTool('line')), act(I.rect, 'Rectangle', () => setTool('rect')), act(I.circle, 'Circle', () => setTool('circle')), act(I.measure, 'Inquiry', e => openInquiryMenu(e.currentTarget)), act(I.help, 'Commands', () => openPalette()));
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
  if (S.ed.mode === 'edit') setMode('object');
  S.ed.pick = m; S.ed.faces = []; S.ed.edges = []; S.ed.profiles = []; S.ed.drawSel = new Set();
  selectionChanged();
}
// Plasticity-style modifiers: if the needed selection is missing, switch to that selection mode
function modifier(kind) {
  if (kind === 'fillet' || kind === 'chamfer') {
    if (!S.ed.edges.length) { setPick('edge'); toast(`Tap edges, then ${kind === 'fillet' ? 'Fillet' : 'Chamfer'}`); return; }
    return runOp(F.edgeBlendOp, { kind });
  }
  if (kind === 'pushpull') { if (!S.ed.faces.length) { setPick('face'); toast('Tap a face, then Push/Pull'); return; } return runOp(F.pushPullOp); }
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
  if (S.ed.pickFace) { $('#hud').innerHTML = '<b>Sketch on face</b><br>Tap a flat face of a body'; return; }
  const eds = S.ed.editingSketch != null && SK.sketchById(S.ed.editingSketch);
  const rolled = H.hist().length - H.markerIndex();
  const rb = rolled > 0 ? `<span class="rbwarn">⏪ Rolled back · ${rolled} later step${rolled === 1 ? '' : 's'} not applied — new work is inserted here</span><br>` : '';
  if (rb && !eds) { const prev = $('#hud'); queueMicrotask(() => { if (!prev.innerHTML.startsWith('<span class="rbwarn">')) prev.innerHTML = rb + prev.innerHTML; }); }
  if (eds && S.ed.mode === 'object') {
    const used = H.firstUsing([eds.id]) >= 0;
    $('#hud').innerHTML = `<b>Editing ${esc(eds.name)}</b> · ${((n, r) => `${n} curve${n === 1 ? '' : 's'} · ${r} region${r === 1 ? '' : 's'}`)(eds.ents.filter(e => e.t !== 'dim').length, SK.regions(eds).length)}<br>${used ? 'Features built from it update as you change it' : 'Draw or edit curves'} · tap <b>Finish</b> when done`;
    return;
  }
  if (S.ed.workspace === 'model' && S.ed.mode === 'object') {
    const drawing = !GIZMO_TOOLS.has(S.ed.tool) && S.ed.tool !== 'select';
    const sel = [[S.ed.drawSel.size, 'curve'], [S.ed.profiles.length, 'region'], [S.ed.faces.length, 'face'], [S.ed.edges.length, 'edge'], [S.ed.pick === 'solid' ? S.ed.selected.size : 0, 'solid']].filter(q => q[0]).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
    parts.push(drawing ? `<b>${S.ed.tool[0].toUpperCase() + S.ed.tool.slice(1)}</b> · draw on the grid or on any face` : `<b>${{ edge: 'Edge', face: 'Face', solid: 'Solid' }[S.ed.pick]} select</b>${sel.length ? ' · ' + sel.join(', ') : ''}`);
    parts.push(drawing ? `${S.ed.sketch && SK.activeSketch() ? esc(SK.activeSketch().name) + ' · ' : ''}${Draw.dofText ? Draw.dofText() : ''}` : '<span class="kbhint">Space or 🔍 for commands · 2 Edge · 3 Face · 4 Solid</span>');
    $('#hud').innerHTML = parts.join('<br>');
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
function planeName(sk) { for (const [k, p] of Object.entries(SK.PLANES)) if (p.n.every((c, i) => Math.abs(c - sk.plane.n[i]) < 1e-9)) { const off = M.dot(sk.plane.o, p.n); return p.label + (Math.abs(off) > 1e-9 ? ` +${fmtLen(off)}` : ''); } return 'custom plane'; }
function renderDrawCard() {
  const el = $('#draw-card');
  const content = (S.ed.workspace === 'draw' || (S.ed.workspace === 'model' && S.ed.mode === 'object' && (!GIZMO_TOOLS.has(S.ed.tool) && (S.ed.tool !== 'select' || S.ed.drawSel.size)))) && !gizmoActive() ? Draw.cardContent() : null;
  el.hidden = !content;
  if (content) el.replaceChildren(content);
  renderLastOp();
}
// ---------- Plasticity-style command palette ----------
function commands() {
  const C = (name, keys, run, words = '') => ({ name, keys, run, words });
  const tool = t => () => setTool(t);
  return [
    C('Line', 'L', tool('line'), 'polyline pline draw'), C('Rectangle', '⇧R', tool('rect'), 'rect box draw'), C('Circle', 'C', tool('circle'), 'draw'), C('Arc', '', tool('arc'), 'draw'),
    C('Spline', '', tool('spline'), 'curve'), C('Polygon', '', tool('polygon'), 'hexagon'), C('Ellipse', '', () => acadTool('ellipse')), C('Text', '', () => acadTool('text')), C('Hatch', '', () => acadTool('hatch')),
    C('Curve fillet / chamfer', '', tool('corner'), 'corner round'), C('Trim curve', '', tool('trim')), C('Extend curve', '', () => setTool('extend')), C('Offset curve', '', () => acadTool('offset')), C('Dimension', '', tool('dim'), 'dim measure constraint'),
    C('Extrude', 'E', () => (S.ed.profiles.length ? runOp(F.extrude) : modifier('pushpull')), 'push pull'), C('Revolve', '', () => runOp(F.revolve)), C('Loft', '', () => runOp(F.loftOp)), C('Sweep', '', () => runOp(F.sweepOp)),
    C('Fillet edges', 'F', () => modifier('fillet'), 'round'), C('Chamfer edges', '⇧C', () => modifier('chamfer'), 'bevel'), C('Push / pull face (offset face)', 'O', () => modifier('pushpull'), 'offset face move face'),
    C('Shell', 'H', () => modifier('shell'), 'hollow'), C('Draft', '', () => runOp(F.draftOp), 'taper'), C('Thicken', '', () => runOp(F.thickenOp)), C('Mirror', 'M', () => modifier('mirror')), C('Slice', '', () => runOp(F.sliceOp), 'cut split'),
    C('Pattern (polar)', '', () => runOp(F.polarPattern), 'array circular'), C('Union', '', () => runOp(F.bodyBoolean, { kind: 'union' }), 'boolean join add'), C('Subtract', '', () => runOp(F.bodyBoolean, { kind: 'subtract' }), 'boolean difference cut'), C('Intersect', '', () => runOp(F.bodyBoolean, { kind: 'intersect' }), 'boolean'),
    C('Move', 'G', tool('move'), 'grab translate'), C('Rotate', 'R', tool('rotate')), C('Scale', 'S', tool('scale')), C('Duplicate', '⇧D', () => runOp(OPS.duplicate), 'copy'), C('Delete', 'X', () => deleteSelection(), 'erase remove'),
    ...OPS.PRIM_TYPES.map(([t, l]) => C(`Add ${l}`, '', () => addSketchedPrim(t), 'primitive solid box')),
    C('Select: Edge mode', '2', () => setPick('edge'), 'curve'), C('Select: Face mode', '3', () => setPick('face'), 'region'), C('Select: Solid mode', '4', () => setPick('solid'), 'body'), C('Edit mesh (polygons)', 'Tab', () => setPick('mesh')),
    C('Measure distance', '', () => acadTool('dist'), 'dist inquiry'), C('Measure angle', '', () => acadTool('angle')), C('Measure area', '', () => acadTool('area')), C('Measure (3D)', '', tool('measure')),
    C('Construction plane: Top (XY)', '', () => { S.ed.cplane = null; toast('Drawing plane: XY'); }, 'cplane'), C('Construction plane: Front (XZ)', '', () => { S.ed.cplane = SK.PLANES.XZ; toast('Drawing plane: XZ'); }, 'cplane'), C('Construction plane: Right (YZ)', '', () => { S.ed.cplane = SK.PLANES.YZ; toast('Drawing plane: YZ'); }, 'cplane'),
    C('Toggle construction curves', '', () => Draw.toggleConstruction()), C('Toggle snapping', '', () => $('#btn-snap').click(), 'snap'), C('Toggle X-ray', '', () => $('#btn-xray').click()), C('Toggle perspective / ortho', '5', () => view.toggleOrtho()),
    C('View: Top', '7', () => view.setView('top')), C('View: Front', '1', () => view.setView('front')), C('View: Right', '3', () => view.setView('right')), C('View: Isometric', '0', () => view.setView('iso')), C('Frame all', 'Home', () => view.frame(S.doc.objects.flatMap(worldVerts).concat(allSketchPoints()))),
    C('AutoCAD command line', '', () => { S.settings.cmdline = !S.settings.cmdline; saveSettings(); refresh(); }, 'acad typed coordinates'),
    C('Undo', '⌘Z', () => undo()), C('Redo', '⇧⌘Z', () => redo()), C('Save project', '⌘S', () => saveProject()), C('Open / import', '', () => $('#file-input').click(), 'stl obj'), C('Export STL', '', () => exportAs('stl')), C('Export OBJ', '', () => exportAs('obj')), C('Export DXF', '', () => exportDXF()), C('New scene', '', () => { if (confirm('Start a new scene?')) newScene(); }),
  ];
}
function deleteSelection() {
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
  const more = () => el.classList.toggle('more', el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  el.onscroll = more; requestAnimationFrame(more);
  requestAnimationFrame(() => {
    const docked = !el.hidden && matchMedia('(max-width: 500px)').matches;
    const off = docked ? el.offsetHeight / 2 : 0;
    if (Math.abs((view.offsetY || 0) - off) > 1) { view.offsetY = off; view.render(); }
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
  el.replaceChildren(
    h('div', { class: 'head' },
      h('div', { class: 'title' }, op.def.label(op.params), op.info ? h('small', {}, op.info) : null),
      fields.length ? h('button', { class: 'ib', 'aria-label': 'Collapse', onclick: () => { lastCollapsed = !lastCollapsed; renderLastOp(); }, html: lastCollapsed ? '▴' : '▾' }) : null,
      h('button', { class: 'ib', 'aria-label': 'Done', onclick: () => clearLast(), html: I.check })),
    fields.length ? h('div', { class: 'fields' }, fieldEls) : null);
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
function toggleSheet(force) {
  sheetOpen = force ?? !sheetOpen;
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
  body.replaceChildren(...(sheetTab === 'item' ? itemTab() : sheetTab === 'objects' ? BR.browserTab(group) : settingsTab()));
  body.scrollTop = st;
}

function itemTab() {
  const o = activeObj();
  if (S.ed.mode === 'edit' && o) return editItemTab(o);
  if (!o || !S.ed.selected.has(o.id)) return [h('p', { class: 'note' }, 'Nothing selected. Tap an object in the viewport, or add one with ', h('b', {}, '+ Add'), '.')];
  const id = o.id;
  const xyzFields = (key, kind, label) => h('div', { class: 'fields' }, [0, 1, 2].map(k => field({
    label: 'XYZ'[k], kind, value: o[key][k], cls: AXC[k],
    onCommit: v => setProp(`${label} ${'XYZ'[k]}`, id, ob => { ob[key][k] = v; }),
  })));
  const local = M.bbox(o.mesh.v);
  const size = [0, 1, 2].map(k => (o.mesh.v.length ? local.max[k] - local.min[k] : 0));
  const dims = size.map((s, k) => s * Math.abs(o.scl[k]));
  const edges = M.meshEdges(o.mesh);
  const closed = isClosed(o.mesh);
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
    group('Scale', xyzFields('scl', 'num', 'Scale')),
    group('Dimensions', h('div', { class: 'fields' }, [0, 1, 2].map(k => field({
      label: 'XYZ'[k], kind: 'len', value: dims[k], cls: AXC[k], readonly: size[k] === 0,
      onCommit: v => { if (size[k] > 0) setProp(`Dimension ${'XYZ'[k]}`, id, ob => { ob.scl[k] = (v / size[k]) * (Math.sign(ob.scl[k]) || 1); }); },
    })))),
    group('Mesh',
      stat('Vertices', String(o.mesh.v.length)), stat('Edges', String(edges.length)), stat('Faces', String(o.mesh.f.length)),
      stat('Surface area', fmtArea(area)),
      stat('Volume', closed ? fmtVol(Math.abs(M.meshVolume(o.mesh)) * sv) : 'open mesh'),
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

function settingsTab() {
  const set = (k, v) => { S.settings[k] = v; saveSettings(); if (k === 'xray') view.applyXray(); refresh(); renderSheet(); };
  return [
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
  popover(anchor, h('div', {}, h('div', { class: 'mtitle' }, 'Add mesh'), grid), { above: true });
}
function openMainMenu() {
  popover($('#btn-menu'), h('div', {},
    menuItem(I.file, 'New scene', () => { if (confirm('Start a new scene? Unsaved changes will be lost (undo is available).')) newScene(); }),
    menuItem(I.folder, 'Open / Import…', () => $('#file-input').click(), 'json stl obj'),
    menuItem(I.save, 'Save project', () => saveProject()),
    h('div', { class: 'msep' }),
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
const selLabel = () => (S.ed.mode === 'object' && S.ed.selected.size ? 'selected' : 'all');
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
  S.doc.objects = []; S.doc.nextId = 1;
  S.ed.mode = 'object'; S.ed.selected = new Set(); S.ed.active = null; S.ed.editSel = new Set(); S.ed.measure = []; S.ed.profiles = []; S.ed.drawSel = new Set();
  defaultScene(); resetHistory(); Draw.resetTool(); scheduleSave(); refresh();
  enterSketchView(SK.activeSketch());
}
function exportTargets() {
  const objs = S.ed.mode === 'object' && S.ed.selected.size ? selectedObjs() : S.doc.objects.filter(isShown);
  return objs.filter(o => o.mesh.f.length);
}
async function exportAs(kind) {
  const objs = exportTargets();
  if (!objs.length) { toast('Nothing to export'); return; }
  const name = (objs.length === 1 ? objs[0].name : 'streamline').replace(/[^\w.-]+/g, '_');
  const blob = kind === 'stl' ? IO.exportSTL(objs) : IO.exportOBJ(objs);
  const r = await IO.deliver(blob, `${name}.${kind}`);
  if (r !== 'cancelled') toast(`Exported ${objs.length} object${objs.length > 1 ? 's' : ''} (mm)`);
}
async function saveProject() {
  const blob = new Blob([JSON.stringify(serialize())], { type: 'application/json' });
  const r = await IO.deliver(blob, `scene-${new Date().toISOString().slice(0, 10)}.streamline.json`);
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
      resetHistory(); scheduleSave(); refresh(); view.markSelDirty();
      S.ed.tool = S.ed.tools[S.ed.workspace] || 'select'; Draw.resetTool();
      if (S.ed.workspace === 'draw' && SK.activeSketch()) enterSketchView(SK.activeSketch()); else { view.cam.lock2D = false; view.frame(S.doc.objects.flatMap(worldVerts)); }
      toast(`Opened ${file.name}`);
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
    if (k === 'e' && !e.shiftKey) { if (S.ed.profiles.length) runOp(F.extrude); else modifier('pushpull'); return; }
    if ((k === 'escape') && (S.ed.tool !== 'select')) { Draw.resetTool(); setTool('select'); return; }
    if ((k === 'x' || k === 'delete' || k === 'backspace') && !e.shiftKey) { deleteSelection(); return; }
    if (k === 'enter' && Draw.enter()) { refresh(); return; }
    const pm = { '2': 'edge', '3': 'face', '4': 'solid' };
    if (pm[k]) { setPick(pm[k]); return; }
    const mm = { f: 'fillet', o: 'pushpull', h: 'shell', m: 'mirror' };
    if (mm[k] && !e.shiftKey) { modifier(mm[k]); return; }
  }
  if (k === 'tab') { e.preventDefault(); if (S.ed.workspace !== 'model') setWorkspace('model'); setMode(S.ed.mode === 'edit' ? 'object' : 'edit'); return; }
  if (S.ed.mode === 'edit' && ['1', '2', '3'].includes(k)) { setSelectMode(['vert', 'edge', 'face'][+k - 1]); return; }
  if (k === 'escape') { if (getLast() && getLast().handle) clearLast(); closePopover(); toggleSheet(false); return; }
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
window.StreamLine = { S, view, OPS, F, SK, Draw, Cmd, runOp, undo, redo, getLast, M, serialize, setWorkspace, H, BR, isShown, addSketchedPrim };

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
  runOp(P.op, { pts: [{ sk: skId, pt: P.seed }], mode: 'new', target: null, ...P.params });
  S.ed.pick = 'solid'; S.ed.drawSel = new Set(); refresh();
}

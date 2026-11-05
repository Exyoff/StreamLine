// 3D viewport: renderer, Z-up turntable camera (persp/ortho), touch gestures, grid, picking.
import * as THREE from 'three';
import { S, emit, activeObj, isShown } from './state.js';
import { triangulateFace, meshEdges, selectedFaces, newell, norm } from './mesh.js';
import { objMatrix, xfFor } from './scene.js';
import { featureEdges } from './edges.js';
import { LineSegments2 } from '../vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/lines/LineMaterial.js';
// screen-space fat lines (crisp edges on Retina screens); width in CSS px
export const fatMat = (o) => new LineMaterial({ linewidth: o.width ?? 1.4, color: o.color ?? 0xffffff, transparent: o.opacity != null && o.opacity < 1, opacity: o.opacity ?? 1, vertexColors: !!o.vertexColors, depthTest: o.depthTest ?? true, dashed: !!o.dashed, dashSize: o.dashSize ?? 1, gapSize: o.gapSize ?? 1 });
import { unitFactor } from './units.js';
import { defSize } from './operators.js';

const D2R = Math.PI / 180;
const COL = {
  sel: new THREE.Color('#ffb547'), active: new THREE.Color('#ffe08a'),
  vert: new THREE.Color('#111214'), edge: new THREE.Color('#15161a'), faceSel: new THREE.Color('#ffb547'),
};

// ---------- look: theme colours, lighting, surface finish, edge width ----------
// (lights ride with the camera unless noted, so a part is lit the same from every side as you orbit)
export const LIGHTING = {
  studio: { name: 'Studio', note: 'Key, fill and sky', key: [1.9, [0.4, 0.6, 1.8], '#fffaf2'], fill: [0.35, [-0.9, -0.1, 0.4], '#cfe0ff'], rim: [0.45, [-0.2, 0.9, -0.8], '#ffffff'], hemi: [0.75, '#dfe6f0', '#3a3d44'], amb: 0, env: 0 },
  soft: { name: 'Soft', note: 'Even, low contrast', key: [0.7, [0.2, 0.5, 1], '#ffffff'], fill: [0.55, [-0.7, 0.1, 0.6], '#ffffff'], rim: [0, [0, 0, -1], '#ffffff'], hemi: [0.6, '#ffffff', '#8a909c'], amb: 0.45, env: 0.2 },
  daylight: { name: 'Daylight', note: 'Sun from above, sky fill', sun: [1.25, [0.45, -0.35, 1], '#fff1d6'], key: [0.45, [0.3, 0.4, 1], '#ffffff'], fill: [0, [0, 0, 1], '#ffffff'], rim: [0, [0, 0, -1], '#ffffff'], hemi: [0.6, '#b8d4ff', '#6e5d48'], amb: 0, env: 0.08 },
  dramatic: { name: 'Dramatic', note: 'Hard side light, cool rim', key: [2.4, [1, 0.25, 0.15], '#fff3e0'], fill: [0.08, [-1, -0.2, 0.3], '#8fb0ff'], rim: [1.8, [-0.6, 0.7, -1], '#bcd3ff'], hemi: [0.12, '#ffffff', '#000000'], amb: 0, env: 0 },
  flat: { name: 'Flat', note: 'Technical, true colours', key: [0.45, [0, 0, 1], '#ffffff'], fill: [0, [0, 0, 1], '#ffffff'], rim: [0, [0, 0, -1], '#ffffff'], hemi: [0, '#ffffff', '#ffffff'], amb: 2.6, env: 0 },
  showroom: { name: 'Showroom', note: 'Soft boxes and reflections', key: [0.9, [0.3, 0.6, 1], '#ffffff'], fill: [0.2, [-0.8, 0, 0.5], '#ffffff'], rim: [0.9, [-0.3, 0.8, -1], '#ffffff'], hemi: [0.2, '#ffffff', '#30343c'], amb: 0, env: 0.5 },
};
export const FINISH = {
  matte: { name: 'Matte', r: 0.88, m: 0 },
  satin: { name: 'Satin', r: 0.55, m: 0.05 },
  gloss: { name: 'Gloss', r: 0.18, m: 0, env: 0.35 },
  metal: { name: 'Metal', r: 0.3, m: 0.85, env: 2.2 },
};
export const THEMES = {
  midnight: { name: 'Midnight', note: 'Navy, blue', bg: ['#1a2130', '#0b0e14'], glow: 'rgba(120,150,220,0.10)', edge: 0x141925, soft: 0x3c4660, sel: '#2f8bff', act: '#8cc4ff', grid: [0.78, 0.84, 1], gridA: 1, sketch: '#4ea1ff', skFixed: '#f3f6fb', profile: '#ff9a2e', profA: 0.3, halo: '#101828', meta: '#0a0d13', nav: 'rgba(255,255,255,0.06)', chip: ['#1a2130', '#3d8bfd'] },
  graphite: { name: 'Graphite', note: 'Neutral grey, blue', bg: ['#2e3034', '#141517'], glow: 'rgba(255,255,255,0.05)', edge: 0x17181b, soft: 0x4f535b, sel: '#3a8dff', act: '#9cc8ff', grid: [1, 1, 1], gridA: 1, sketch: '#4ea1ff', skFixed: '#f3f3f3', profile: '#ff9a2e', profA: 0.3, halo: '#141619', meta: '#111213', nav: 'rgba(255,255,255,0.06)', chip: ['#2e3034', '#4a90f2'] },
  ember: { name: 'Ember', note: 'The original orange', bg: ['#2f3034', '#25262a'], glow: 'rgba(255,255,255,0.03)', edge: 0x3a4250, soft: 0x55606f, sel: '#ff9a1f', act: '#ffd27a', grid: [1, 1, 1], gridA: 1, sketch: '#5aa9ff', skFixed: '#f2f2f2', profile: '#ff9a2e', profA: 0.3, halo: '#18191c', meta: '#16171a', nav: 'rgba(255,255,255,0.06)', chip: ['#2b2c30', '#ff9f0a'] },
  daylight: { name: 'Daylight', note: 'Light studio', bg: ['#f8fafd', '#d2d8e3'], glow: 'rgba(255,255,255,0.6)', edge: 0x283042, soft: 0x707a8e, sel: '#1f6feb', act: '#5ea0ff', grid: [0.12, 0.16, 0.28], gridA: 1.7, sketch: '#1662e0', skFixed: '#121722', profile: '#ff8a1f', profA: 0.32, halo: null, meta: '#e9edf3', nav: 'rgba(12,18,32,0.07)', chip: ['#eef1f6', '#1f6feb'] },
};

export const view = {
  handlers: {},       // dragStart(x,y,e)->bool, dragMove, dragEnd, dragCancel, tap(x,y,e), hover
  overlayScene: null,
  renderHooks: [],
  cam: { target: new THREE.Vector3(0, 0, 0), dist: 140, yaw: -55 * D2R, pitch: 28 * D2R, ortho: false, autoOrtho: false },
};

view.fatMat = fatMat;
view.THEMES = THEMES; view.LIGHTING = LIGHTING; view.FINISH = FINISH;
view.theme = THEMES.midnight;
// the selection colour as a number (overlays in app.js / draw.js use it)
view.selHex = () => new THREE.Color(view.theme.sel).getHex();
let renderer, scene, overlay, persp, ortho, container, canvas, labelsEl;
let gridLines, gridKey = '';
let needsRender = true, tween = null;
const visuals = new Map(); // id -> { group, mesh, edges, points, meshRef }
let selDirty = true;
let matMesh, matMeshX, matEdgeObj, matEdgeSoft, matEdgeSel, matEdgeAct, matEdgeEdit, matPoints;
const camLights = []; let hemi, amb, sun, envTex = null, bgTex = null, lookKey = '';

// a soft-box studio, blurred into an environment map: reflections for Gloss / Metal and the Soft / Showroom light
function studioEnv() {
  if (envTex) return envTex;
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3a3f4a, side: THREE.BackSide }));
  room.scale.set(30, 30, 20); env.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshBasicMaterial({ color: 0x454a54 })); floor.position.z = -9.9; env.add(floor);
  const panel = (w, h, pos, look, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(...pos); m.lookAt(...look); env.add(m); };
  panel(14, 8, [0, 0, 9.8], [0, 0, 0], 1.6);       // overhead soft box
  panel(4, 14, [-14.8, 2, 2], [0, 0, 0], 2);     // left strip
  panel(4, 14, [14.8, -2, 2], [0, 0, 0], 1.5);     // right strip
  panel(10, 5, [6, 14.8, 4], [0, 0, 0], 1.2);    // back panel
  panel(8, 4, [-5, -14.8, 3], [0, 0, 0], 0.9);   // front fill
  const pm = new THREE.PMREMGenerator(renderer);
  envTex = pm.fromScene(env, 0.035).texture; pm.dispose();
  env.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  return envTex;
}
// the viewport backdrop: a vertical gradient with a soft glow behind the model
function backdrop(t) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const g = c.getContext('2d'), lg = g.createLinearGradient(0, 0, 0, 256);
  lg.addColorStop(0, t.bg[0]); lg.addColorStop(1, t.bg[1]); g.fillStyle = lg; g.fillRect(0, 0, 16, 256);
  const rg = g.createLinearGradient(0, 40, 0, 200); rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, t.glow); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter;
  return tex;
}
// apply the theme / lighting / finish settings (cheap when nothing changed)
view.setLook = () => {
  const st = S.settings, t = THEMES[st.theme] || THEMES.midnight, L = LIGHTING[st.lighting] || LIGHTING.studio, F = FINISH[st.finish] || FINISH.satin;
  const key = [st.theme, st.lighting, st.finish].join('|');
  if (key === lookKey || !renderer) return;
  const themeChanged = view.theme !== t || !bgTex;
  lookKey = key; view.theme = t;
  if (themeChanged) {
    COL.sel.set(t.sel); COL.faceSel.set(t.sel); COL.active.set(t.act);
    matEdgeObj.color.set(t.edge); matEdgeSoft.color.set(t.soft); matEdgeSel.color.set(t.sel); matEdgeAct.color.set(t.act);
    bgTex?.dispose(); bgTex = backdrop(t); scene.background = bgTex;
    gridKey = ''; // grid lines take the theme's ink
    for (const v of visuals.values()) disposeVisual(v); visuals.clear(); // (selection tints are baked into the mesh colours)
  }
  for (const set of camLights) for (const k of ['key', 'fill', 'rim']) { const [i, p, c] = L[k]; set[k].intensity = i; set[k].color.set(c); set[k].position.set(...p); }
  const [hi, sky, gnd] = L.hemi; hemi.intensity = hi; hemi.color.set(sky); hemi.groundColor.set(gnd);
  amb.intensity = L.amb || 0;
  if (L.sun) { sun.intensity = L.sun[0]; sun.color.set(L.sun[2]); sun.position.set(...L.sun[1]).multiplyScalar(1000); } else sun.intensity = 0;
  const envI = Math.max(L.env || 0, F.env ? F.env * (L.env > 0 ? 1 : 0.6) : 0);
  scene.environment = envI > 0 ? studioEnv() : null;
  matMesh.envMapIntensity = envI; matMesh.roughness = F.r; matMesh.metalness = F.m; matMesh.needsUpdate = true;
  view.render();
};
// edge width: a multiple of the CSS pixel width, either fixed on screen or growing as you zoom in
const EDGE_W = { thin: 0.65, normal: 1, bold: 1.7 };
function edgeScale() {
  const st = S.settings, w = EDGE_W[st.edgeWidth] || 1;
  if (st.edgeScale !== 'zoom') return w;
  // the size the visible parts would fill the view at; zooming in past it thickens the lines, out thins them
  let R = 0; const c = new THREE.Vector3(), box = new THREE.Box3();
  for (const v of visuals.values()) { if (!v.group.visible) continue; const g = v.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox(); box.union(g.boundingBox.clone().applyMatrix4(v.group.matrix)); }
  if (box.isEmpty()) return w;
  box.getCenter(c); R = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const fit = fitDist(R); // (framed with Frame all: the normal width)
  return w * Math.min(5, Math.max(0.3, fit / Math.max(view.cam.dist, 1e-9)));
}

export function camera() { return view.cam.ortho ? ortho : persp; }

view.init = function (el) {
  container = el;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  renderer.autoClear = false;
  canvas = renderer.domElement;
  canvas.id = 'gl';
  container.appendChild(canvas);
  labelsEl = document.createElement('div'); labelsEl.id = 'labels'; container.appendChild(labelsEl);

  scene = new THREE.Scene();
  overlay = new THREE.Scene(); view.overlayScene = overlay; view.scene = scene;
  persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e6);
  for (const c of [persp, ortho]) {
    c.up.set(0, 0, 1);
    const set = {};
    for (const k of ['key', 'fill', 'rim']) { const l = new THREE.DirectionalLight(0xffffff, 0); l.target.position.set(0, 0, 0); c.add(l, l.target); set[k] = l; } // (position = direction toward the light, in view space: +z is toward the viewer)
    camLights.push(set); scene.add(c);
  }
  hemi = new THREE.HemisphereLight(0xdfe6f0, 0x3a3d44, 1.4); hemi.position.set(0, 0, 1); scene.add(hemi);
  amb = new THREE.AmbientLight(0xffffff, 0); scene.add(amb);
  sun = new THREE.DirectionalLight(0xffffff, 0); scene.add(sun, sun.target);

  matMesh = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  // opaque (overlapping joints of a translucent line darken unevenly) and pulled toward the camera so the
  // edge never fights with the faces it lies on — no speckled rims on holes and bosses
  matEdgeObj = fatMat({ color: 0x3a4250, width: 1.2 });
  matEdgeSoft = fatMat({ color: 0x55606f, width: 0.8, opacity: 0.45 }); matEdgeSoft.polygonOffset = true; matEdgeSoft.polygonOffsetFactor = -2; matEdgeSoft.polygonOffsetUnits = -6;
  matEdgeSel = fatMat({ color: COL.sel, width: 2 });
  matEdgeAct = fatMat({ color: COL.active, width: 2.2 });
  for (const m of [matEdgeObj, matEdgeSel, matEdgeAct]) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -6; }
  matEdgeEdit = fatMat({ vertexColors: true, width: 1.6 });
  for (const m of [matEdgeObj, matEdgeSoft, matEdgeSel, matEdgeAct, matEdgeEdit]) m.userData.model = true; // (width follows the Edges setting)
  matPoints = new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false });
  applyXray();
  view.setLook();

  bindPointer();
  new ResizeObserver(resize).observe(container);
  resize();
  loop();
};

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  matPoints.size = 7 * renderer.getPixelRatio();
  updateCamera(); view.render();
}
view.size = () => ({ w: container.clientWidth, h: container.clientHeight });
view.render = () => { needsRender = true; };

export function applyXray() {
  const x = S.settings.xray || !!view.xrayFor; // sketch editing ghosts the bodies so the sketch shows through
  matMesh.transparent = x; matMesh.opacity = x ? 0.3 : 1; matMesh.depthWrite = !x;
  for (const m of [matEdgeEdit, matPoints]) m.depthTest = !x;
  matMesh.needsUpdate = true;
  view.render();
}
view.applyXray = applyXray;

// ---------- camera ----------
function sceneRadius() {
  let r = 100 * unitFactor();
  for (const o of S.doc.objects) r = Math.max(r, Math.hypot(...o.loc) + 1000);
  return r + view.cam.target.length();
}
function updateCamera() {
  const c = view.cam, { w, h } = view.size();
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const dir = new THREE.Vector3(cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), sp);
  const r = new THREE.Vector3(-Math.sin(c.yaw), Math.cos(c.yaw), 0);
  const u = new THREE.Vector3().crossVectors(dir, r);
  const basis = new THREE.Matrix4().makeBasis(r, u, dir);
  const aspect = Math.max(w, 1) / Math.max(h, 1);
  const R = sceneRadius();
  persp.aspect = aspect;
  persp.near = Math.max(c.dist * 0.005, 1e-4); persp.far = c.dist * 50 + R * 4;
  persp.position.copy(c.target).addScaledVector(dir, c.dist);
  persp.quaternion.setFromRotationMatrix(basis);
  // a panel docked over the lower view (phone op dialog) shifts the picture up so the model stays visible
  const oy = Math.round(view.offsetY || 0), ox = Math.round(view.offsetX || 0);
  if (oy || ox) persp.setViewOffset(w, h, ox, oy, w, h); else persp.clearViewOffset();
  persp.updateProjectionMatrix(); persp.updateMatrixWorld();
  const hh = c.dist * Math.tan(persp.fov * D2R / 2);
  ortho.left = -hh * aspect; ortho.right = hh * aspect; ortho.top = hh; ortho.bottom = -hh;
  const D = c.dist + R * 2;
  ortho.position.copy(c.target).addScaledVector(dir, D);
  ortho.near = D * 0.001; ortho.far = D + R * 2;
  ortho.quaternion.setFromRotationMatrix(basis);
  if (oy || ox) ortho.setViewOffset(w, h, ox, oy, w, h); else ortho.clearViewOffset();
  ortho.updateProjectionMatrix(); ortho.updateMatrixWorld();
}
view.viewDir = () => { const c = view.cam, cp = Math.cos(c.pitch); return [cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), Math.sin(c.pitch)]; }; // toward viewer

view.orbit = (dx, dy) => {
  const c = view.cam;
  if (c.autoOrtho) { c.ortho = false; c.autoOrtho = false; emit('viewchange'); }
  c.yaw -= dx * 0.45 * D2R;
  c.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, c.pitch + dy * 0.45 * D2R));
  tween = null; view.render(); emit('viewchange');
};
view.pan = (dx, dy) => {
  const c = view.cam, wpp = view.worldPerPixel(c.target);
  const cp = Math.cos(c.pitch);
  const r = new THREE.Vector3(-Math.sin(c.yaw), Math.cos(c.yaw), 0);
  const dir = new THREE.Vector3(cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), Math.sin(c.pitch));
  const u = new THREE.Vector3().crossVectors(dir, r);
  c.target.addScaledVector(r, -dx * wpp).addScaledVector(u, dy * wpp);
  view.render();
};
view.zoom = (f, sx, sy) => {
  const c = view.cam;
  const nd = Math.min(Math.max(c.dist * f, 0.01), 1e6);
  // zoom toward the cursor point on the focus plane
  if (sx != null) {
    const { w, h } = view.size();
    const k = (1 - nd / c.dist);
    // the picture's centre moves with a docked dialog's view offset; zoom about the point under the fingers
    const cx = w / 2 - (view.offsetX || 0), cy = h / 2 - (view.offsetY || 0);
    view.pan((cx - sx) * k, (cy - sy) * k);
  }
  c.dist = nd; view.render(); emit('viewchange');
};
const VIEWS = { front: [-90, 0], back: [90, 0], right: [0, 0], left: [180, 0], top: [-90, 90], bottom: [-90, -90], iso: [-45, 35.264] };
view.setView = (name, keepOrtho = false) => {
  const [y, p] = VIEWS[name];
  const c = view.cam;
  if (name !== 'iso' && !keepOrtho && !c.ortho) { c.ortho = true; c.autoOrtho = true; }
  if (name === 'iso' && c.autoOrtho) { c.ortho = false; c.autoOrtho = false; }
  animateTo(y * D2R, p * D2R);
  emit('viewchange');
};
view.alignAxis = (axis, sign) => {
  const map = { x: sign > 0 ? 'right' : 'left', y: sign > 0 ? 'back' : 'front', z: sign > 0 ? 'top' : 'bottom' };
  view.setView(map[axis]);
};
function animateTo(yaw, pitch, target = null, dist = null) {
  const c = view.cam;
  let dy = yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  tween = { t0: performance.now(), dur: 220, y0: c.yaw, y1: c.yaw + dy, p0: c.pitch, p1: pitch, tg0: c.target.clone(), tg1: target, d0: c.dist, d1: dist };
  view.render();
}
function stepTween(now) {
  if (!tween) return;
  const c = view.cam, t = Math.min(1, (now - tween.t0) / tween.dur), e = 1 - Math.pow(1 - t, 3);
  c.yaw = tween.y0 + (tween.y1 - tween.y0) * e;
  c.pitch = tween.p0 + (tween.p1 - tween.p0) * e;
  if (tween.tg1) c.target.lerpVectors(tween.tg0, tween.tg1, e);
  if (tween.d1) c.dist = tween.d0 + (tween.d1 - tween.d0) * e;
  if (t >= 1) tween = null;
  needsRender = true; emit('viewchange');
}
// Look straight at a plane (normal toward viewer), centred on target
view.lookAlong = (n, target, dist = null) => {
  const c = view.cam;
  const pitch = Math.asin(Math.max(-1, Math.min(1, n[2])));
  let yaw = Math.abs(Math.cos(pitch)) < 1e-6 ? -Math.PI / 2 : Math.atan2(n[1], n[0]);
  if (!c.ortho) { c.ortho = true; c.autoOrtho = true; }
  animateTo(yaw, pitch, target ? new THREE.Vector3(...target) : null, dist);
  emit('viewchange');
};
view.saveCam = () => { const c = view.cam; return { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.toArray(), ortho: c.ortho, autoOrtho: c.autoOrtho }; };
view.restoreCam = s => { const c = view.cam; c.ortho = s.ortho; c.autoOrtho = s.autoOrtho; animateTo(s.yaw, s.pitch, new THREE.Vector3(...s.target), s.dist); emit('viewchange'); };
view.toggleOrtho = () => { view.cam.ortho = !view.cam.ortho; view.cam.autoOrtho = false; view.render(); emit('viewchange'); };
// screen space the floating controls cover ({ l, r, t, b } in px); set by the app
view.insets = () => ({ l: 0, r: 0, t: 0, b: 0 });
// how far back the camera sits to fit a sphere of radius rad in the part of the screen the controls leave free
function fitDist(rad) {
  const { w, h } = view.size();
  let ins = { l: 0, r: 0, t: 0, b: 0 }; try { ins = view.insets() || ins; } catch (e) {}
  const fw = Math.max(w * 0.4, w - ins.l - ins.r), fh = Math.max(h * 0.4, h - ins.t - ins.b);
  return rad / Math.sin(persp.fov * D2R / 2) * h / Math.min(fw, fh) * 1.15;
}
view.frame = (points) => {
  const c = view.cam;
  if (!points.length) { animateTo(c.yaw, c.pitch, new THREE.Vector3(0, 0, 0), 7 * defSize()); return; }
  const b = new THREE.Box3(); points.forEach(p => b.expandByPoint(new THREE.Vector3(...p)));
  const ctr = b.getCenter(new THREE.Vector3());
  const rad = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1 * unitFactor());
  const { w, h } = view.size();
  let ins = { l: 0, r: 0, t: 0, b: 0 }; try { ins = view.insets() || ins; } catch (e) {}
  const fov = persp.fov * D2R / 2;
  const dist = fitDist(rad);
  const wpp = 2 * dist * Math.tan(fov) / h;
  const cp = Math.cos(c.pitch), dir = new THREE.Vector3(cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), Math.sin(c.pitch));
  const r = new THREE.Vector3(-Math.sin(c.yaw), Math.cos(c.yaw), 0), u = new THREE.Vector3().crossVectors(dir, r);
  const dx = (Math.min(ins.l, w * 0.3) - Math.min(ins.r, w * 0.3)) / 2, dy = (Math.min(ins.t, h * 0.3) - Math.min(ins.b, h * 0.3)) / 2;
  const tgt = ctr.clone().addScaledVector(r, -dx * wpp).addScaledVector(u, dy * wpp);
  animateTo(c.yaw, c.pitch, tgt, dist);
};

view.project = (p) => {
  const cam = camera(), v = new THREE.Vector3(p[0], p[1], p[2]);
  const vc = v.clone().applyMatrix4(cam.matrixWorldInverse);
  v.project(cam);
  const { w, h } = view.size();
  return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, front: vc.z < 0, depth: -vc.z };
};
view.ray = (x, y) => {
  const { w, h } = view.size(), rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(x / w * 2 - 1, -(y / h) * 2 + 1), camera());
  return rc;
};
view.worldPerPixel = (p) => {
  const { h } = view.size(), c = view.cam;
  if (c.ortho) return (ortho.top - ortho.bottom) / h;
  const P = p.isVector3 ? p : new THREE.Vector3(...p);
  const depth = -P.clone().applyMatrix4(persp.matrixWorldInverse).z;
  return 2 * Math.max(depth, 1e-6) * Math.tan(persp.fov * D2R / 2) / h;
};

// ---------- grid (adaptive, fading) ----------
const gridMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uCenter: { value: new THREE.Vector3() }, uRadius: { value: 100 } },
  // (faded by the distance in the grid's own plane, so the same grid can lie on a sketch plane)
  vertexShader: `attribute vec4 color4; varying vec4 vC; varying vec2 vL;
    void main(){ vC = color4; vL = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uCenter; uniform float uRadius; varying vec4 vC; varying vec2 vL;
    void main(){ float d = length(vL-uCenter.xy)/uRadius; float a = vC.a*(1.0-smoothstep(0.45,1.0,d)); if(a<0.003) discard; gl_FragColor = vec4(vC.rgb,a); }`,
});
// the grid lies on view.gridPlane ({ o, u, v, n }: the sketch being edited, like Fusion's sketch grid, or the
// drawing plane) — else on the ground (XY)
function updateGrid() {
  const c = view.cam;
  if (!S.settings.grid) { if (gridLines) gridLines.visible = false; return; }
  const f = unitFactor(), pl = view.gridPlane || null;
  const T = c.target.toArray(), rel = pl ? [T[0] - pl.o[0], T[1] - pl.o[1], T[2] - pl.o[2]] : T;
  const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tx = pl ? dt(rel, pl.u) : T[0], ty = pl ? dt(rel, pl.v) : T[1], tz = pl ? dt(rel, pl.n) : T[2];
  let H = 2 * c.dist * Math.tan(persp.fov * D2R / 2);
  // when looking at the grid edge-on, base the size on the target's height above it too
  H = Math.max(H, Math.abs(tz) * 0.5);
  const step = f * Math.pow(10, Math.floor(Math.log10(H / f / 25)));
  const major = step * 10, N = 120;
  const cx = Math.round(tx / major) * major, cy = Math.round(ty / major) * major;
  const key = `${step}|${cx}|${cy}|${pl ? [...pl.o, ...pl.u, ...pl.n].map(v => (+v).toFixed(6)).join() : 'xy'}|${view.gridDark ? 'd' : ''}`;
  gridMat.uniforms.uCenter.value.set(tx, ty, 0); gridMat.uniforms.uRadius.value = N * step * 0.95;
  if (gridLines) {
    gridLines.visible = true;
    // on a face the grid floats a fraction of a pixel above it (lines get no polygon offset)
    gridLines.matrixAutoUpdate = false;
    if (pl) { const lift = view.worldPerPixel(c.target) * 0.4; gridLines.matrix.makeBasis(new THREE.Vector3(...pl.u), new THREE.Vector3(...pl.v), new THREE.Vector3(...pl.n)).setPosition(pl.o[0] + pl.n[0] * lift, pl.o[1] + pl.n[1] * lift, pl.o[2] + pl.n[2] * lift); }
    else gridLines.matrix.identity();
    gridLines.matrixWorldNeedsUpdate = true;
  }
  if (key === gridKey) return;
  gridKey = key;
  const pos = [], col = [];
  const ext = N * step;
  const line = (a, b, r, g, bl, al) => { pos.push(...a, ...b); col.push(r, g, bl, al, r, g, bl, al); };
  // (on a face — a sketch being edited there — the grid is drawn in dark ink so it shows on the light part)
  const gc = view.gridDark ? [0.05, 0.07, 0.12] : view.theme.grid, ga = view.gridDark ? 2.2 : view.theme.gridA;
  for (let i = -N; i <= N; i++) {
    const x = cx + i * step, y = cy + i * step;
    const mx = Math.abs(Math.round(x / major) * major - x) < step * 1e-3, my = Math.abs(Math.round(y / major) * major - y) < step * 1e-3;
    if (Math.abs(x) > step * 1e-3) line([x, cy - ext, 0], [x, cy + ext, 0], ...gc, (mx ? 0.13 : 0.05) * ga);
    if (Math.abs(y) > step * 1e-3) line([cx - ext, y, 0], [cx + ext, y, 0], ...gc, (my ? 0.13 : 0.05) * ga);
  }
  if (Math.abs(cy) <= ext) line([cx - ext, 0, 0], [cx + ext, 0, 0], 0.95, 0.3, 0.33, 0.85);
  if (Math.abs(cx) <= ext) line([0, cy - ext, 0], [0, cy + ext, 0], 0.48, 0.75, 0.2, 0.85);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color4', new THREE.Float32BufferAttribute(col, 4));
  if (gridLines) { gridLines.geometry.dispose(); gridLines.geometry = g; }
  else { gridLines = new THREE.LineSegments(g, gridMat); gridLines.renderOrder = -1; gridLines.frustumCulled = false; scene.add(gridLines); }
  view.gridStep = step;
}
view.gridStep = 1;

// ---------- object visuals ----------
// a solid: its tessellation with smooth normals, drawn with the true B-rep edges (no triangle edges)
function buildSolidVisual(o) {
  const t = o.brep, m = o.mesh, base = new THREE.Color(o.color);
  const pos = new Float32Array(m.v.length * 3), nor = new Float32Array(m.v.length * 3), col = new Float32Array(m.v.length * 3);
  m.v.forEach((q, i) => { pos.set(q, i * 3); nor.set(m.n[i] || [0, 0, 1], i * 3); col.set([base.r, base.g, base.b], i * 3); });
  // an inserted assembly: each part in its own colour (the app maps each B-rep face to its part)
  const fcol = view.faceColorsOf?.(o);
  if (fcol && o.faceOf) { const cc = new Map(); m.f.forEach((f, fi) => { const hex = fcol[o.faceOf[fi]]; if (!hex) return; let c = cc.get(hex); if (!c) cc.set(hex, c = new THREE.Color(hex)); for (const vi of f) col.set([c.r, c.g, c.b], vi * 3); }); }
  const idx = new Uint32Array(m.f.length * 3); m.f.forEach((f, i) => idx.set(f, i * 3));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.triFace = null; // triangle index == mesh face index
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, matMesh); mesh.userData.objId = o.id;
  // straight and round edges in full strength; free-form edges (thread crests, sweeps) lighter so dense
  // helices read as surface detail instead of a black mass
  const ep = [], fp = [];
  for (const e of t.edges) { if (e.seam) continue; const dst = /LINE|CIRCLE|ELLIPSE/.test(e.type) ? ep : fp; for (let k = 1; k < e.pts.length; k++) dst.push(...e.pts[k - 1], ...e.pts[k]); }
  const eg = new LineSegmentsGeometry(); eg.setPositions(ep.length ? ep : [0, 0, 0, 0, 0, 0]);
  const edges = new LineSegments2(eg, matEdgeObj); edges.visible = ep.length > 0;
  const group = new THREE.Group(); group.add(mesh, edges);
  if (fp.length) { const fg = new LineSegmentsGeometry(); fg.setPositions(fp); group.add(new LineSegments2(fg, matEdgeSoft)); }
  return { group, mesh, edges, points: null, meshRef: o.mesh, editing: false };
}
function buildVisual(o, editing) {
  if (o.shape && o.brep) return buildSolidVisual(o);
  const m = o.mesh;
  const pos = [], nor = [], col = [], triFace = [];
  const base = new THREE.Color(o.color);
  const selF = editing ? new Set(selectedFaces(m, S.ed.editSel)) : null;
  const tint = base.clone().lerp(COL.faceSel, 0.55);
  m.f.forEach((f, fi) => {
    const P = f.map(i => m.v[i]);
    const n = norm(newell(P));
    const c = selF && selF.has(fi) ? tint : base;
    for (const t of triangulateFace(P)) {
      for (const k of t) { pos.push(...P[k]); nor.push(...n); col.push(c.r, c.g, c.b); }
      triFace.push(fi);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.userData.triFace = triFace;
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, matMesh); mesh.userData.objId = o.id;

  // display only real creases (> 25°): smooth faceted surfaces show no edges, as in Plasticity
  const E = editing ? meshEdges(m) : featureEdges(m.v, m.f, 1 - Math.cos(25 * Math.PI / 180)).map(e => [e.a, e.b]), ep = [], ec = [];
  for (const [a, b] of E) {
    ep.push(...m.v[a], ...m.v[b]);
    if (editing) { const s = S.ed.editSel.has(a) && S.ed.editSel.has(b); const c = s ? COL.sel : COL.edge; ec.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  }
  const eg = new LineSegmentsGeometry(); eg.setPositions(ep);
  if (editing) eg.setColors(ec);
  const edges = new LineSegments2(eg, editing ? matEdgeEdit : matEdgeObj);

  const group = new THREE.Group(); group.add(mesh, edges);
  let points = null;
  if (editing) {
    const pc = [];
    m.v.forEach((_, i) => { const c = S.ed.editSel.has(i) ? COL.sel : COL.vert; pc.push(c.r, c.g, c.b); });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(m.v.flat(), 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
    points = new THREE.Points(pg, matPoints); points.renderOrder = 2;
    group.add(points);
  }
  return { group, mesh, edges, points, meshRef: m, editing };
}
function disposeVisual(v) { v.group.traverse(c => c.geometry && c.geometry.dispose()); scene.remove(v.group); }

view.markSelDirty = () => { selDirty = true; view.render(); };
function syncScene() {
  const ids = new Set();
  const editing = S.ed.mode === 'edit';
  for (const o of S.doc.objects) {
    ids.add(o.id);
    let v = visuals.get(o.id);
    const isEdit = editing && o.id === S.ed.active;
    if (!v || v.meshRef !== o.mesh || v.editing !== isEdit || (isEdit && selDirty) || v.color !== o.color) {
      if (v) disposeVisual(v);
      v = buildVisual(o, isEdit); v.color = o.color;
      visuals.set(o.id, v); scene.add(v.group);
    }
    v.group.visible = isShown(o);
    v.group.matrixAutoUpdate = false;
    v.group.matrix.copy(objMatrix(o)); v.group.matrixWorldNeedsUpdate = true;
    const showSel = S.ed.workspace !== 'model' || S.ed.pick === 'solid';
    if (!isEdit) v.edges.material = showSel && o.id === S.ed.active && S.ed.selected.has(o.id) ? matEdgeAct : showSel && S.ed.selected.has(o.id) ? matEdgeSel : matEdgeObj;
    // dim other objects while editing
    v.mesh.visible = true;
  }
  for (const [id, v] of visuals) if (!ids.has(id)) { disposeVisual(v); visuals.delete(id); }
  selDirty = false;
}

// ---------- picking ----------
view.pickObject = (x, y) => {
  const rc = view.ray(x, y);
  const meshes = [...visuals.values()].filter(v => v.group.visible).map(v => v.mesh);
  const hit = rc.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const tf = hit.object.geometry.userData.triFace;
  return { id: hit.object.userData.objId, face: tf ? tf[hit.faceIndex] : tf === null ? hit.faceIndex : -1, point: hit.point.toArray(), distance: hit.distance };
};
// a world point hidden behind a body (seen from the camera)? (always false in X-ray)
view.occluded = world => occluded(world, new THREE.Raycaster());
function occluded(world, rc) {
  if (S.settings.xray || view.xrayFor) return false;
  const cam = camera();
  const P = new THREE.Vector3(...world);
  let dir, origin;
  if (view.cam.ortho) { dir = new THREE.Vector3(); cam.getWorldDirection(dir); origin = P.clone().addScaledVector(dir, -1e5); }
  else { origin = cam.position.clone(); dir = P.clone().sub(origin).normalize(); }
  rc.set(origin, dir);
  const meshes = [...visuals.values()].filter(v => v.group.visible).map(v => v.mesh);
  const hit = rc.intersectObjects(meshes, false)[0];
  if (!hit) return false;
  const d = P.distanceTo(origin);
  return hit.distance < d - Math.max(d * 1e-4, view.worldPerPixel(P) * 2);
}
// nearest vertex in screen space. opts: { objs: [obj], exclude: (obj, i) => bool, tol }
view.pickVertex = (x, y, opts = {}) => {
  const tol = opts.tol ?? 28;
  const objs = opts.objs || S.doc.objects.filter(isShown);
  const cands = [];
  for (const o of objs) {
    const xf = xfFor(o);
    o.mesh.v.forEach((p, i) => {
      if (opts.exclude && opts.exclude(o, i)) return;
      const w = xf.toW(p), s = view.project(w);
      if (!s.front) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= tol) cands.push({ o, i, w, d, depth: s.depth });
    });
  }
  cands.sort((a, b) => a.d - b.d || a.depth - b.depth);
  const rc = new THREE.Raycaster();
  for (const c of cands.slice(0, 24)) if (opts.noOcclusion || !occluded(c.w, rc)) return { id: c.o.id, index: c.i, world: c.w };
  return null;
};
view.pickEdge = (x, y, o, tol = 22) => {
  const xf = xfFor(o), W = o.mesh.v.map(xf.toW), Sp = W.map(view.project);
  const cands = [];
  for (const [a, b] of meshEdges(o.mesh)) {
    const A = Sp[a], B = Sp[b];
    if (!A.front || !B.front) continue;
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(A.x + dx * t - x, A.y + dy * t - y);
    if (d <= tol) cands.push({ a, b, d, t });
  }
  cands.sort((p, q) => p.d - q.d);
  const rc = new THREE.Raycaster();
  for (const c of cands.slice(0, 12)) {
    const w = W[c.a].map((v, k) => v + (W[c.b][k] - v) * c.t);
    if (!occluded(w, rc)) return [c.a, c.b];
  }
  return null;
};
view.pickFace = (x, y, o) => {
  const v = visuals.get(o.id); if (!v) return -1;
  const hit = view.ray(x, y).intersectObject(v.mesh, false)[0];
  const tf = v.mesh.geometry.userData.triFace;
  return hit ? (tf ? tf[hit.faceIndex] : hit.faceIndex) : -1;
};
// world point on the ground plane (z=0) or along view plane through target
view.groundPoint = (x, y) => {
  const r = view.ray(x, y).ray;
  // looking along the ground (a side view): the point at the model's depth instead of a far-away intersection
  if (Math.abs(r.direction.z) < 0.05) {
    const tc = view.cam.target.clone().sub(r.origin).dot(r.direction), q = r.origin.clone().addScaledVector(r.direction, tc);
    if (Math.abs(q.z) < view.worldPerPixel(q) * 12) q.z = 0; // near the ground line: on it
    return q.toArray();
  }
  const t = r.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
  return t ? t.toArray() : null;
};

// ---------- labels ----------
const labelPool = [];
let labelIdx = 0;
view.label = (world, text, cls = '') => {
  const s = view.project(world);
  if (!s.front) return;
  let el = labelPool[labelIdx];
  if (!el) { el = document.createElement('div'); labelsEl.appendChild(el); labelPool.push(el); }
  labelIdx++;
  el.className = 'vlabel ' + cls; el.textContent = text; el.style.display = '';
  el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -130%)`;
};

view.labelAt = (x, y, text, cls = '') => {
  let el = labelPool[labelIdx];
  if (!el) { el = document.createElement('div'); labelsEl.appendChild(el); labelPool.push(el); }
  labelIdx++;
  el.className = 'vlabel ' + cls; el.textContent = text; el.style.display = '';
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
};

// a small picture of the current view (project thumbnails)
view.thumbnail = (w = 240, h = 160) => {
  try {
    renderFrame();
    const src = renderer.domElement, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), k = Math.max(w / src.width, h / src.height), sw = w / k, sh = h / k;
    g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.7);
  } catch (e) { return null; }
};
// ---------- render loop ----------
function loop(now) {
  requestAnimationFrame(loop);
  stepTween(now || performance.now());
  if (!needsRender) return;
  needsRender = false;
  renderFrame();
}
function renderFrame() {
  updateCamera();
  syncScene();
  updateGrid();
  labelIdx = 0;
  for (const h of view.renderHooks) h();
  for (let i = labelIdx; i < labelPool.length; i++) labelPool[i].style.display = 'none';
  // fat-line materials need the drawing-buffer size
  const res = renderer.getDrawingBufferSize(new THREE.Vector2());
  // (model edges also take the Edges width setting, fixed on screen or scaled with zoom)
  const pr = renderer.getPixelRatio(), ek = edgeScale();
  const fix = o => { const m = o.material; if (!m || !m.isLineMaterial) return;
    if (m.resolution.x !== res.x || m.resolution.y !== res.y) m.resolution.copy(res);
    m.userData.css ??= m.linewidth; const want = m.userData.css * pr * (m.userData.model ? ek : 1);
    if (Math.abs(m.linewidth - want) > 1e-3) m.linewidth = want; };
  scene.traverse(fix); overlay.traverse(fix);
  renderer.setClearColor(new THREE.Color(view.theme.bg[1]), 1);
  renderer.clear();
  renderer.render(scene, camera());
  renderer.clearDepth();
  renderer.render(overlay, camera());
  emit('rendered');
}

// ---------- pointer / gestures ----------
function bindPointer() {
  const pts = new Map();
  let mode = null, startT = 0, moved = false, pinch = null, multiTap = null;
  const rel = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // one finger never moves the view (the orientation cube turns it, the zoom bar zooms, two fingers pan / pinch):
  // a tap picks, a drag on a handle drags it, and a held (or dragged) finger brings up the precision cursor
  let holdT = 0;
  const cursorOn = () => !!view.handlers.cursorStart && !view.cam.lock2D;
  const startCursor = (x, y) => { clearTimeout(holdT); if (mode !== 'pending' || !cursorOn()) return; mode = 'cursor'; view.handlers.cursorStart(x, y); };
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const p = rel(e);
    pts.set(e.pointerId, { ...p, sx: p.x, sy: p.y, t: e.timeStamp || performance.now() });
    if (pts.size === 1) {
      moved = false; startT = performance.now(); multiTap = null;
      if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey)) mode = 'pan';
      // a small control drawn over the view (a value bubble, a dimension, a constraint glyph) comes first — it sits on
      // top of the curves' drag points — and held or slid a little it is still a tap on it
      else if (view.handlers.pressTarget?.(p.x, p.y)) mode = 'target';
      else if (view.handlers.dragStart && view.handlers.dragStart(p.x, p.y, e)) mode = 'gizmo';
      else { mode = 'pending'; if (e.pointerType !== 'mouse') holdT = setTimeout(() => startCursor(p.x, p.y), 320); }
    } else if (pts.size === 2) {
      clearTimeout(holdT);
      if (mode === 'cursor') view.handlers.cursorCancel && view.handlers.cursorCancel();
      if (mode === 'gizmo') view.handlers.dragCancel && view.handlers.dragCancel();
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      multiTap = performance.now() - startT < 300 && !moved ? { n: 2, t: performance.now() } : null;
      mode = 'pinch';
    } else if (pts.size === 3) {
      if (multiTap) multiTap.n = 3;
      mode = 'three';
    }
  });
  canvas.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId);
    if (!p) { view.handlers.hover && e.pointerType === 'mouse' && view.handlers.hover(rel(e).x, rel(e).y); return; }
    const q = rel(e), dx = q.x - p.x, dy = q.y - p.y;
    const thr = e.pointerType === 'mouse' ? 3 : 8;
    if (Math.hypot(q.x - p.sx, q.y - p.sy) > thr) { moved = true; if (multiTap && pts.size >= 2) multiTap = null; }
    p.x = q.x; p.y = q.y;
    if (mode === 'pending' && moved) { clearTimeout(holdT); if (cursorOn()) { mode = 'cursor'; view.handlers.cursorStart(p.sx, p.sy); } else mode = view.cam.lock2D ? 'pan' : 'none'; }
    if (mode === 'cursor') view.handlers.cursorMove(q.x, q.y);
    else if (mode === 'pan') view.pan(dx, dy);
    else if (mode === 'gizmo') view.handlers.dragMove(q.x, q.y, e);
    else if (mode === 'pinch' && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch.d > 0 && d > 0) view.zoom(pinch.d / d, mx, my);
      view.pan(mx - pinch.mx, my - pinch.my);
      pinch = { d, mx, my };
    }
  });
  const up = e => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId); clearTimeout(holdT);
    // a quick tap whose hold timer fired late (the phone was busy) is still a tap: the events' own times decide
    if (mode === 'cursor' && !moved && e.type === 'pointerup' && pts.size === 0 && (e.timeStamp || performance.now()) - p.t < 320) { view.handlers.cursorCancel && view.handlers.cursorCancel(); mode = 'pending'; }
    if (mode === 'cursor') { mode = null; if (e.type === 'pointerup') view.handlers.cursorEnd(); else view.handlers.cursorCancel(); }
    if (mode === 'gizmo') { const r = view.handlers.dragEnd(); mode = null; if (r === 'tap' && e.type === 'pointerup' && pts.size === 0) view.handlers.tap && view.handlers.tap(p.x, p.y, e); } // (a press on a gizmo that never dragged is a tap)
    else if (mode === 'pending' && pts.size === 0 && e.type === 'pointerup') { mode = null; view.handlers.tap && view.handlers.tap(p.x, p.y, e); }
    else if (mode === 'target' && pts.size === 0 && e.type === 'pointerup') { mode = null; view.handlers.tap && view.handlers.tap(p.sx, p.sy, e); }
    if (pts.size === 0) {
      if (multiTap && performance.now() - multiTap.t < 350) emit(multiTap.n === 3 ? 'gestureRedo' : 'gestureUndo');
      multiTap = null; mode = null;
    } else if (pts.size === 1 && mode === 'pinch') mode = 'none';
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const q = rel(e);
    view.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), q.x, q.y);
  }, { passive: false });
}

// ---------- orientation cube (Fusion's ViewCube): drag to turn the view; tap a face, edge or corner ----------
// faces: normal, the label's right and up directions (seen from outside)
const CUBE = [
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], label: 'TOP' }, { n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0], label: 'BOTTOM' },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], label: 'FRONT' }, { n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1], label: 'BACK' },
  { n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1], label: 'RIGHT' }, { n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1], label: 'LEFT' },
];
const NAMED = { '0,0,1': 'top', '0,0,-1': 'bottom', '0,-1,0': 'front', '0,1,0': 'back', '1,0,0': 'right', '-1,0,0': 'left' };
// look along a direction (toward the viewer): a named face gives its orthographic view, an edge or corner a 3D one
view.lookDir = d => {
  const key = d.map(v => Math.round(v)).join(), name = NAMED[key];
  if (name && Math.abs(Math.hypot(...d) - 1) < 1e-6) return view.setView(name);
  const c = view.cam, n = M3norm(d);
  if (c.autoOrtho) { c.ortho = false; c.autoOrtho = false; }
  animateTo(Math.atan2(n[1], n[0]), Math.asin(Math.max(-1, Math.min(1, n[2]))));
  emit('viewchange');
};
const M3norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
view.initNav = (cv) => {
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const SZ = 104, R = 27, C = SZ / 2;
  cv.width = SZ * dpr; cv.height = SZ * dpr; cv.style.width = SZ + 'px'; cv.style.height = SZ + 'px';
  let faces = [], press = null;
  const proj = (v, inv) => { const t = new THREE.Vector3(...v).transformDirection(inv); return { x: t.x * R, y: -t.y * R, z: t.z }; };
  function draw() {
    const inv = camera().matrixWorldInverse;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, SZ, SZ);
    const light = view.theme.name === 'Daylight';
    faces = CUBE.map(f => ({ ...f, N: proj(f.n, inv), U: proj(f.r, inv), V: proj(f.u, inv) })).filter(f => f.N.z > 1e-3).sort((a, b) => a.N.z - b.N.z);
    // the axis triad from the cube's back-left-bottom corner
    const O = proj([-1, -1, -1], inv);
    for (const [v, col] of [[[1, 0, 0], '#f2545b'], [[0, 1, 0], '#7cc243'], [[0, 0, 1], '#4f8ff7']]) {
      const e = proj(v, inv); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(C + O.x, C + O.y); ctx.lineTo(C + O.x + e.x * 2.6, C + O.y + e.y * 2.6); ctx.stroke();
    }
    for (const f of faces) {
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => ({ x: C + f.N.x + f.U.x * s + f.V.x * t, y: C + f.N.y + f.U.y * s + f.V.y * t }));
      const shade = 0.78 + 0.22 * f.N.z, hot = press && press.face === f.label;
      ctx.fillStyle = hot ? '#3d8bfd' : light ? `rgb(${Math.round(235 * shade)},${Math.round(239 * shade)},${Math.round(246 * shade)})` : `rgba(${Math.round(214 * shade)},${Math.round(222 * shade)},${Math.round(236 * shade)},0.94)`;
      ctx.strokeStyle = light ? 'rgba(20,30,50,0.45)' : 'rgba(10,14,24,0.65)'; ctx.lineWidth = 1;
      ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      // the label, painted on the face (an affine map of the face's own right / down directions)
      if (f.N.z > 0.25) {
        const k = 0.011;
        ctx.save();
        ctx.setTransform(f.U.x * dpr * k, f.U.y * dpr * k, -f.V.x * dpr * k, -f.V.y * dpr * k, (C + f.N.x) * dpr, (C + f.N.y) * dpr);
        ctx.fillStyle = hot ? '#ffffff' : '#1d2433'; ctx.font = `700 ${f.label.length > 4 ? 30 : 34}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = Math.min(1, (f.N.z - 0.25) * 3); ctx.fillText(f.label, 0, 2); ctx.restore();
      }
    }
  }
  view.renderHooks.push(draw);
  // what a point on the cube means: a face (its middle), an edge (its outer band) or a corner (both bands)
  const regionAt = (x, y) => {
    for (const f of faces.slice().reverse()) {
      const px = x - C - f.N.x, py = y - C - f.N.y, det = f.U.x * f.V.y - f.U.y * f.V.x; if (Math.abs(det) < 1e-6) continue;
      const s = (px * f.V.y - py * f.V.x) / det, t = (f.U.x * py - f.U.y * px) / det;
      if (Math.abs(s) > 1.02 || Math.abs(t) > 1.02) continue;
      const d = f.n.slice();
      if (Math.abs(s) > 0.6) for (let i = 0; i < 3; i++) d[i] += Math.sign(s) * f.r[i];
      if (Math.abs(t) > 0.6) for (let i = 0; i < 3; i++) d[i] += Math.sign(t) * f.u[i];
      return { face: f.label, dir: d };
    }
    return null;
  };
  let drag = null;
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY, moved: false }; press = regionAt(e.offsetX, e.offsetY); view.render(); e.stopPropagation(); });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y; drag.x = e.offsetX; drag.y = e.offsetY;
    if (Math.hypot(e.offsetX - drag.sx, e.offsetY - drag.sy) > 4) { drag.moved = true; press = null; }
    if (drag.moved) view.orbit(dx * 1.6, dy * 1.6);
  });
  const end = e => {
    if (drag && !drag.moved && e.type === 'pointerup') { const r = regionAt(e.offsetX, e.offsetY); if (r) view.lookDir(r.dir); }
    drag = null; press = null; view.render();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
};
// a magnified copy of the view around (x, y), for the precision cursor's loupe (drawn right after a render, so
// the drawing buffer is still there)
view.magnify = (dst, x, y, k = 2.4) => {
  renderFrame();
  const src = renderer.domElement, pr = src.width / Math.max(1, canvas.clientWidth);
  // (k is the magnification on screen: the source span is the loupe's CSS size / k, in the view's device pixels)
  const g = dst.getContext('2d'), w = dst.width, h = dst.height, sw = (dst.clientWidth || w) / k * pr, sh = (dst.clientHeight || h) / k * pr;
  g.imageSmoothingEnabled = true; g.clearRect(0, 0, w, h);
  g.drawImage(src, x * pr - sw / 2, y * pr - sh / 2, sw, sh, 0, 0, w, h);
};


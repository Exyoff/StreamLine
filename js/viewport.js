// 3D viewport: renderer, Z-up turntable camera (persp/ortho), touch gestures, grid, picking.
import * as THREE from 'three';
import { S, emit, activeObj } from './state.js';
import { triangulateFace, meshEdges, selectedFaces, newell, norm } from './mesh.js';
import { objMatrix, xfFor } from './scene.js';
import { featureEdges } from './edges.js';
import { unitFactor } from './units.js';
import { defSize } from './operators.js';

const D2R = Math.PI / 180;
const COL = {
  sel: new THREE.Color('#ff9a1f'), active: new THREE.Color('#ffd27a'),
  vert: new THREE.Color('#111214'), edge: new THREE.Color('#15161a'), faceSel: new THREE.Color('#ff9a1f'),
};

export const view = {
  handlers: {},       // dragStart(x,y,e)->bool, dragMove, dragEnd, dragCancel, tap(x,y,e), hover
  overlayScene: null,
  renderHooks: [],
  cam: { target: new THREE.Vector3(0, 0, 0), dist: 140, yaw: -55 * D2R, pitch: 28 * D2R, ortho: false, autoOrtho: false },
};

let renderer, scene, overlay, persp, ortho, container, canvas, labelsEl;
let gridLines, gridKey = '';
let needsRender = true, tween = null;
const visuals = new Map(); // id -> { group, mesh, edges, points, meshRef }
let selDirty = true;
let matMesh, matMeshX, matEdgeObj, matEdgeSel, matEdgeAct, matEdgeEdit, matPoints;

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
    const l = new THREE.DirectionalLight(0xffffff, 2.2);
    l.position.set(0.4, 0.6, 1); l.target.position.set(0, 0, -1);
    c.add(l, l.target); scene.add(c);
  }
  scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x3a3d44, 1.4));

  matMesh = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  matEdgeObj = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 });
  matEdgeSel = new THREE.LineBasicMaterial({ color: COL.sel });
  matEdgeAct = new THREE.LineBasicMaterial({ color: COL.active });
  matEdgeEdit = new THREE.LineBasicMaterial({ vertexColors: true });
  matPoints = new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false });
  applyXray();

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
  const x = S.settings.xray;
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
  persp.updateProjectionMatrix(); persp.updateMatrixWorld();
  const hh = c.dist * Math.tan(persp.fov * D2R / 2);
  ortho.left = -hh * aspect; ortho.right = hh * aspect; ortho.top = hh; ortho.bottom = -hh;
  const D = c.dist + R * 2;
  ortho.position.copy(c.target).addScaledVector(dir, D);
  ortho.near = D * 0.001; ortho.far = D + R * 2;
  ortho.quaternion.setFromRotationMatrix(basis);
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
    view.pan((w / 2 - sx) * k, (h / 2 - sy) * k);
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
view.lookAlong = (n, target) => {
  const c = view.cam;
  const pitch = Math.asin(Math.max(-1, Math.min(1, n[2])));
  let yaw = Math.abs(Math.cos(pitch)) < 1e-6 ? -Math.PI / 2 : Math.atan2(n[1], n[0]);
  if (!c.ortho) { c.ortho = true; c.autoOrtho = true; }
  animateTo(yaw, pitch, target ? new THREE.Vector3(...target) : null);
  emit('viewchange');
};
view.toggleOrtho = () => { view.cam.ortho = !view.cam.ortho; view.cam.autoOrtho = false; view.render(); emit('viewchange'); };
view.frame = (points) => {
  const c = view.cam;
  if (!points.length) { animateTo(c.yaw, c.pitch, new THREE.Vector3(0, 0, 0), 7 * defSize()); return; }
  const b = new THREE.Box3(); points.forEach(p => b.expandByPoint(new THREE.Vector3(...p)));
  const ctr = b.getCenter(new THREE.Vector3());
  const rad = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1 * unitFactor());
  const { w, h } = view.size();
  const fov = persp.fov * D2R / 2, fit = Math.min(1, w / h);
  animateTo(c.yaw, c.pitch, ctr, rad / Math.sin(fov) / fit * 1.5);
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
  vertexShader: `attribute vec4 color4; varying vec4 vC; varying vec3 vW;
    void main(){ vC = color4; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `uniform vec3 uCenter; uniform float uRadius; varying vec4 vC; varying vec3 vW;
    void main(){ float d = length(vW.xy-uCenter.xy)/uRadius; float a = vC.a*(1.0-smoothstep(0.45,1.0,d)); if(a<0.003) discard; gl_FragColor = vec4(vC.rgb,a); }`,
});
function updateGrid() {
  const c = view.cam;
  if (!S.settings.grid) { if (gridLines) gridLines.visible = false; return; }
  const f = unitFactor();
  let H = 2 * c.dist * Math.tan(persp.fov * D2R / 2);
  // when looking at the grid edge-on, base the size on the target height too
  H = Math.max(H, Math.abs(c.target.z) * 0.5);
  const step = f * Math.pow(10, Math.floor(Math.log10(H / f / 25)));
  const major = step * 10, N = 120;
  const cx = Math.round(c.target.x / major) * major, cy = Math.round(c.target.y / major) * major;
  const key = `${step}|${cx}|${cy}`;
  gridMat.uniforms.uCenter.value.copy(c.target); gridMat.uniforms.uRadius.value = N * step * 0.95;
  if (gridLines) gridLines.visible = true;
  if (key === gridKey) return;
  gridKey = key;
  const pos = [], col = [];
  const ext = N * step;
  const line = (a, b, r, g, bl, al) => { pos.push(...a, ...b); col.push(r, g, bl, al, r, g, bl, al); };
  for (let i = -N; i <= N; i++) {
    const x = cx + i * step, y = cy + i * step;
    const mx = Math.abs(Math.round(x / major) * major - x) < step * 1e-3, my = Math.abs(Math.round(y / major) * major - y) < step * 1e-3;
    if (Math.abs(x) > step * 1e-3) line([x, cy - ext, 0], [x, cy + ext, 0], 1, 1, 1, mx ? 0.13 : 0.05);
    if (Math.abs(y) > step * 1e-3) line([cx - ext, y, 0], [cx + ext, y, 0], 1, 1, 1, my ? 0.13 : 0.05);
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
function buildVisual(o, editing) {
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

  const E = editing ? meshEdges(m) : featureEdges(m.v, m.f).map(e => [e.a, e.b]), ep = [], ec = [];
  for (const [a, b] of E) {
    ep.push(...m.v[a], ...m.v[b]);
    if (editing) { const s = S.ed.editSel.has(a) && S.ed.editSel.has(b); const c = s ? COL.sel : COL.edge; ec.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  }
  const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  if (editing) eg.setAttribute('color', new THREE.Float32BufferAttribute(ec, 3));
  const edges = new THREE.LineSegments(eg, editing ? matEdgeEdit : matEdgeObj);

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
    v.group.visible = !o.hidden;
    v.group.matrixAutoUpdate = false;
    v.group.matrix.copy(objMatrix(o)); v.group.matrixWorldNeedsUpdate = true;
    if (!isEdit) v.edges.material = o.id === S.ed.active && S.ed.selected.has(o.id) ? matEdgeAct : S.ed.selected.has(o.id) ? matEdgeSel : matEdgeObj;
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
  return { id: hit.object.userData.objId, face: tf ? tf[hit.faceIndex] : -1, point: hit.point.toArray(), distance: hit.distance };
};
function occluded(world, rc) {
  if (S.settings.xray) return false;
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
  const objs = opts.objs || S.doc.objects.filter(o => !o.hidden);
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
  return hit ? v.mesh.geometry.userData.triFace[hit.faceIndex] : -1;
};
// world point on the ground plane (z=0) or along view plane through target
view.groundPoint = (x, y) => {
  const r = view.ray(x, y).ray;
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

// ---------- render loop ----------
function loop(now) {
  requestAnimationFrame(loop);
  stepTween(now || performance.now());
  if (!needsRender) return;
  needsRender = false;
  updateCamera();
  syncScene();
  updateGrid();
  labelIdx = 0;
  for (const h of view.renderHooks) h();
  for (let i = labelIdx; i < labelPool.length; i++) labelPool[i].style.display = 'none';
  renderer.setClearColor(view.bg ?? 0x2a2b2f, 1);
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

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const p = rel(e);
    pts.set(e.pointerId, { ...p, sx: p.x, sy: p.y, t: performance.now() });
    if (pts.size === 1) {
      moved = false; startT = performance.now(); multiTap = null;
      if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey)) mode = 'pan';
      else if (view.handlers.dragStart && view.handlers.dragStart(p.x, p.y, e)) mode = 'gizmo';
      else mode = 'pending';
    } else if (pts.size === 2) {
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
    if (mode === 'pending' && moved) mode = 'orbit';
    if (mode === 'orbit') (view.cam.lock2D ? view.pan(dx, dy) : view.orbit(dx, dy));
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
    pts.delete(e.pointerId);
    if (mode === 'gizmo') { view.handlers.dragEnd(); mode = null; }
    else if (mode === 'pending' && pts.size === 0 && e.type === 'pointerup') { mode = null; view.handlers.tap && view.handlers.tap(p.x, p.y, e); }
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

// ---------- navigation gizmo (axis bubbles) ----------
view.initNav = (cv) => {
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const SZ = 96; cv.width = SZ * dpr; cv.height = SZ * dpr; cv.style.width = SZ + 'px'; cv.style.height = SZ + 'px';
  let bubbles = [];
  const axes = [['x', 1, '#f2545b', 'X'], ['y', 1, '#7cc243', 'Y'], ['z', 1, '#4f8ff7', 'Z'], ['x', -1, '#f2545b', ''], ['y', -1, '#7cc243', ''], ['z', -1, '#4f8ff7', '']];
  function draw() {
    const cam = camera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, SZ, SZ);
    const inv = cam.matrixWorldInverse;
    const R = 34, c = SZ / 2;
    bubbles = axes.map(([a, s, col, lab]) => {
      const v = new THREE.Vector3(a === 'x' ? s : 0, a === 'y' ? s : 0, a === 'z' ? s : 0).transformDirection(inv);
      return { a, s, col, lab, x: c + v.x * R, y: c - v.y * R, z: v.z };
    }).sort((p, q) => p.z - q.z);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.arc(c, c, R + 12, 0, Math.PI * 2); ctx.fill();
    for (const b of bubbles) {
      if (b.s > 0) { ctx.strokeStyle = b.col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.s > 0 ? 10 : 8, 0, Math.PI * 2);
      if (b.s > 0) { ctx.fillStyle = b.col; ctx.fill(); }
      else { ctx.fillStyle = b.col + '55'; ctx.fill(); ctx.strokeStyle = b.col; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (b.lab) { ctx.fillStyle = '#111'; ctx.font = '700 11px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(b.lab, b.x, b.y + 0.5); }
    }
  }
  view.renderHooks.push(draw);
  let drag = null;
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY, moved: false }; e.stopPropagation(); });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y; drag.x = e.offsetX; drag.y = e.offsetY;
    if (Math.hypot(e.offsetX - drag.sx, e.offsetY - drag.sy) > 4) drag.moved = true;
    if (drag.moved) view.orbit(dx * 1.6, dy * 1.6);
  });
  cv.addEventListener('pointerup', e => {
    if (drag && !drag.moved) {
      const hit = bubbles.slice().reverse().find(b => Math.hypot(b.x - e.offsetX, b.y - e.offsetY) < 14);
      if (hit) view.alignAxis(hit.a, hit.s);
    }
    drag = null;
  });
};

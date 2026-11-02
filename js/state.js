// Shared application state + a tiny event bus.
export const S = {
  doc: { objects: [], sketches: [], nextId: 1 },
  ed: {
    workspace: 'draw',     // 'draw' | 'cad' | 'model'
    sketch: null,          // active sketch id
    drawSel: new Set(),    // selected sketch entity ids
    profiles: [],          // selected regions [{sk, pt:[x,y]}]
    pickFace: false,       // waiting for a tap on a face to start a sketch
    tools: { draw: 'line', cad: 'select', model: 'select' },
    mode: 'object',        // 'object' | 'edit'
    selectMode: 'vert',    // 'vert' | 'edge' | 'face'
    selected: new Set(),   // object ids (object mode)
    active: null,          // active object id
    editSel: new Set(),    // selected vertex indices of active object (edit mode)
    selOrder: [],          // vertex selection order (for "length" editing)
    tool: 'select',        // select | move | rotate | scale | measure
    multi: false,          // additive tap selection
    measure: [],           // measure tool points [{p:[x,y,z]}]
  },
  settings: {
    unit: 'mm',
    precision: 2,
    snap: true,
    snapStep: 1,           // mm
    angleStep: 15,         // degrees
    vertexSnap: false,
    xray: false,
    grid: true,
    curveSegs: 64,
  },
};

const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, data) { (listeners[ev] || []).forEach(fn => fn(data)); }

export function activeObj() {
  return S.doc.objects.find(o => o.id === S.ed.active) || null;
}
export function objById(id) { return S.doc.objects.find(o => o.id === id) || null; }
export function selectedObjs() { return S.doc.objects.filter(o => S.ed.selected.has(o.id)); }

const SETTINGS_KEY = 'streamline.settings.v1';
export function loadSettings() {
  try { Object.assign(S.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}
}
export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (e) {}
}

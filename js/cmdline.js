// AutoCAD-style command line for the Draw and CAD workspaces.
import { S, emit, on, saveSettings } from './state.js';
import { $, h, toast } from './ui.js';
import * as Draw from './draw.js';

let ctx = null;          // app callbacks
let last = null;         // last command, repeated by an empty Enter
let pending = null;      // 3D command waiting for a selection: { name, prompt, run }
let hist = '';
const logLines = [];
let logOpen = false;

// AutoCAD command names and aliases → actions
const DRAW_TOOLS = {
  L: 'line', LINE: 'line', PL: 'line', PLINE: 'line', REC: 'rect', RECTANG: 'rect', RECTANGLE: 'rect',
  C: 'circle', CIRCLE: 'circle', A: 'arc', ARC: 'arc', POL: 'polygon', POLYGON: 'polygon',
  TR: 'trim', TRIM: 'trim', EX: 'extend', EXTEND: 'extend', O: 'offset', OFFSET: 'offset',
  M: 'move', MOVE: 'move', CO: 'copy', CP: 'copy', COPY: 'copy', RO: 'rotate', ROTATE: 'rotate',
  SC: 'scale', SCALE: 'scale', MI: 'mirror', MIRROR: 'mirror', E: 'erase', ERASE: 'erase', X: 'explode', EXPLODE: 'explode',
  DI: 'dist', DIST: 'dist', ID: 'id', AA: 'area', AREA: 'area', LI: 'list', LS: 'list', LIST: 'list', MEA: 'dist', MEASUREGEOM: 'dist', MD: 'dist', MR: 'radius', MA: 'angle', MAR: 'area',
  DIM: 'dim', DLI: 'dim', DIMLINEAR: 'dim', DAL: 'dim', DIMALIGNED: 'dim', DRA: 'dim', DIMRADIUS: 'dim', DDI: 'dim', DIMDIAMETER: 'dim', DAN: 'dim', DIMANGULAR: 'dim',
  SELECT: 'select',
};
const CONSTRAINTS = { GCHORIZONTAL: 'h', GCH: 'h', GCVERTICAL: 'v', GCV: 'v', GCPARALLEL: 'par', GCPA: 'par', GCPERPENDICULAR: 'perp', GCPE: 'perp', GCEQUAL: 'eq', GCE: 'eq', GCTANGENT: 'tan', GCT: 'tan', GCCONCENTRIC: 'conc', GCCO: 'conc', GCFIX: 'fix', GCF: 'fix' };
const TOGGLES = { GRID: 'grid', SNAP: 'snap', ORTHO: 'ortho', POLAR: 'polar', OSNAP: 'osnap' };
const FKEYS = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap', F10: 'polar' };

export function initCmdline(c) {
  ctx = c;
  on('cmdlog', t => { logLines.push(t); if (logLines.length > 60) logLines.shift(); render(); });
  $('#cmdlog').addEventListener('click', () => { logOpen = !logOpen; render(); });
  const inp = $('#cmdin');
  inp.addEventListener('keydown', e => {
    if (FKEYS[e.key]) { e.preventDefault(); toggle(FKEYS[e.key]); return; }
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === ' ') { e.preventDefault(); submit(); return; } // AutoCAD: space = Enter
    if (e.key === 'Escape') { e.preventDefault(); cancel(); inp.blur(); return; }
    e.stopPropagation();
  });
  $('#cmd-enter').onclick = () => submit();
  $('#cmd-esc').onclick = () => { cancel(); inp.blur(); };
  $('#statusbar').addEventListener('click', e => { const b = e.target.closest('button'); if (b) toggle(b.dataset.st); });
  $('#cmdprompt').addEventListener('click', e => { const b = e.target.closest('.opt'); if (b) exec(b.dataset.v); });
}
function submit() { const inp = $('#cmdin'); const v = inp.value; inp.value = ''; exec(v); if (matchMedia('(pointer: coarse)').matches) inp.blur(); }
export function cancel() { pending = null; Draw.resetTool(); if (S.ed.workspace === 'draw' && S.ed.tool !== 'select') ctx.setTool('select'); emit('cmd'); }
export function toggle(k) {
  const on = !(S.settings[k] ?? (k === 'polar' || k === 'osnap'));
  S.settings[k] = on;
  if (k === 'ortho' && on) { S.settings._polarWas = S.settings.polar !== false; S.settings.polar = false; }
  if (k === 'ortho' && !on && S.settings._polarWas) S.settings.polar = true;
  if (k === 'polar' && on) S.settings.ortho = false;
  saveSettings(); ctx.refresh();
  toast(`${k.toUpperCase()} ${on ? 'on' : 'off'}`);
}
// Keys typed anywhere over the viewport go to the command line (AutoCAD behaviour).
export function key(e) {
  if (FKEYS[e.key]) { e.preventDefault(); toggle(FKEYS[e.key]); return true; }
  const inp = $('#cmdin');
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exec(''); return true; }
  if (e.key === 'Escape') { cancel(); return true; }
  if (e.key.length === 1 && /[\w@<,.\-+*/()'"°π]/.test(e.key)) { e.preventDefault(); inp.focus(); inp.value += e.key; return true; }
  return false;
}

export function exec(raw) {
  const str = (raw || '').trim(), up = str.toUpperCase();
  hist = str ? str.toUpperCase() : hist;
  // empty Enter: finish the current command, run a pending 3D command, or repeat the last one
  if (!str) {
    if (pending) { const p = pending; pending = null; p.run(); emit('cmd'); return; }
    if (S.ed.workspace === 'draw' && Draw.enter()) { emit('cmd'); return; }
    if (last) return exec(last);
    return;
  }
  // a value or option for the running command
  if (S.ed.workspace === 'draw' && S.ed.tool !== 'select') {
    const r = Draw.typed(str);
    if (r === 'radius') { toast('Type the radius / distance'); emit('cmd'); return; }
    if (r) { emit('cmd'); return; }
  }
  if (TOGGLES[up]) return toggle(TOGGLES[up]);
  if (up === 'U' || up === 'UNDO') { ctx.undo(); return; }
  if (up === 'REDO' || up === 'MREDO') { ctx.redo(); return; }
  if (up === 'Z' || up === 'ZOOM' || up === 'ZE' || up === 'ZOOM E') { ctx.zoomAll(); return; }
  if (up === 'DXFOUT') { ctx.exportDXF(); return; }
  if (up === 'CAD' || up === '3D') return ctx.setWorkspace('cad');
  if (up === 'DRAW' || up === '2D') return ctx.setWorkspace('draw');
  if (up === 'MODEL') return ctx.setWorkspace('model');
  if (DRAW_TOOLS[up] || up === 'F' || up === 'FILLET' || up === 'CHA' || up === 'CHAMFER') {
    if (S.ed.workspace !== 'draw') ctx.setWorkspace('draw');
    last = up;
    if (DRAW_TOOLS[up]) { if (DRAW_TOOLS[up] === 'dim') Draw.dimOpts.mode = up === 'DLI' || up === 'DIMLINEAR' ? 'linear' : 'aligned'; ctx.setTool(DRAW_TOOLS[up]); Draw.startCommand(); }
    else { Draw.corner.kind = up.startsWith('F') ? 'fillet' : 'chamfer'; ctx.setTool('corner'); }
    emit('cmd'); return;
  }
  if (CONSTRAINTS[up]) { if (S.ed.workspace !== 'draw') ctx.setWorkspace('draw'); Draw.constrain(CONSTRAINTS[up]); return; }
  const three = threeD(up);
  if (three) { last = up; if (S.ed.workspace !== 'cad') ctx.setWorkspace('cad'); three(); emit('cmd'); return; }
  toast(`Unknown command "${str}"`);
}
// 3D solid commands (CAD workspace)
function threeD(up) {
  const F = ctx.F;
  const need = (name, prompt, has, run, tool) => () => {
    if (has()) { run(); return; }
    if (tool) ctx.setTool(tool);
    pending = { name, prompt, run };
  };
  const prof = () => S.ed.profiles.length > 0, bodies = n => () => S.ed.selected.size >= n, edges = () => S.ed.edges.length > 0;
  const map = {
    EXTRUDE: need('EXTRUDE', 'Select regions to extrude, then Enter:', prof, () => ctx.runOp(F.extrude), 'select'),
    REVOLVE: need('REVOLVE', 'Select regions to revolve, then Enter:', prof, () => ctx.runOp(F.revolve), 'select'),
    UNION: need('UNION', 'Select bodies (multi-select on), then Enter:', bodies(2), () => ctx.runOp(F.bodyBoolean, { kind: 'union' }), 'select'),
    SUBTRACT: need('SUBTRACT', 'Select the body to keep first, then the ones to remove, then Enter:', bodies(2), () => ctx.runOp(F.bodyBoolean, { kind: 'subtract' }), 'select'),
    INTERSECT: need('INTERSECT', 'Select bodies, then Enter:', bodies(2), () => ctx.runOp(F.bodyBoolean, { kind: 'intersect' }), 'select'),
    FILLETEDGE: need('FILLETEDGE', 'Select edges, then Enter:', edges, () => ctx.runOp(F.edgeBlendOp, { kind: 'fillet' }), 'edge'),
    CHAMFEREDGE: need('CHAMFEREDGE', 'Select edges, then Enter:', edges, () => ctx.runOp(F.edgeBlendOp, { kind: 'chamfer' }), 'edge'),
    PRESSPULL: () => ctx.setWorkspace('model', 'face'),
  };
  const alias = { EXT: 'EXTRUDE', REV: 'REVOLVE', UNI: 'UNION', SU: 'SUBTRACT', IN: 'INTERSECT', FE: 'FILLETEDGE', CHAE: 'CHAMFEREDGE', PP: 'PRESSPULL' };
  return map[alias[up] || up] || null;
}

export function render() {
  const bar = $('#cmdbar');
  const show = S.ed.workspace === 'draw' || S.ed.workspace === 'cad';
  bar.hidden = !show;
  document.body.classList.toggle('has-cmd', show);
  if (!show) return;
  let text = 'Command:', options = [];
  if (pending) text = `${pending.name} ${pending.prompt}`;
  else if (S.ed.workspace === 'draw') ({ text, options } = Draw.prompt());
  else if (S.ed.tool === 'edge') text = 'Command: select edges, then FILLETEDGE or CHAMFEREDGE';
  const lg = $('#cmdlog');
  lg.textContent = logLines.length ? logLines[logLines.length - 1] : 'Command history — results of DIST, AREA, LIST… appear here';
  lg.classList.toggle('empty', !logLines.length);
  const pan = $('#cmdhistory');
  pan.hidden = !logOpen;
  if (logOpen) { pan.replaceChildren(...(logLines.length ? logLines : ['(empty)']).map(l => h('div', {}, l))); pan.scrollTop = 1e6; }
  const el = $('#cmdprompt');
  el.replaceChildren(hist ? h('span', { class: 'hist' }, hist) : '', h('span', {}, text), ...options.map(([l, v]) => h('button', { class: 'opt', 'data-v': v }, l)));
  el.scrollLeft = 1e6;
  for (const b of document.querySelectorAll('#statusbar button')) b.classList.toggle('on', !!(S.settings[b.dataset.st] ?? (b.dataset.st === 'polar' || b.dataset.st === 'osnap')));
}
export const hasPending = () => !!pending;

// Reusable UI pieces: toast, calculator keypad, value fields, popovers.
import { S } from './state.js';
import { evalExpr, fmt, fmtLen, fmtAng, fmtNum, unitFactor } from './units.js';
import { I } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

// ---------- toast ----------
let toastT = 0;
export function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- keypad ----------
let kp = null, openedAt = 0;
const rawNumber = (kind, v) => {
  if (kind === 'len') return trimNum(v / unitFactor());
  if (kind === 'int') return String(Math.round(v));
  return trimNum(v);
};
function trimNum(v) { let s = (+v.toPrecision(12)).toString(); if (s.includes('e')) s = v.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s; }

export function openKeypad({ label, kind = 'len', value = 0, min = null, max = null, onCommit, anchor = null }) {
  closeKeypad(false);
  openedAt = performance.now();
  const el = $('#keypad');
  kp = { kind, expr: rawNumber(kind, value), fresh: true, onCommit, min, max, anchor };
  anchor && anchor.classList.add('editing');
  const units = kind === 'len' ? ['mm', 'cm', 'm', 'in', 'ft'] : kind === 'ang' ? ['deg', 'rad', 'pi'] : [];
  const keys = [
    ['7', '8', '9', '÷', '⌫'],
    ['4', '5', '6', '×', '('],
    ['1', '2', '3', '−', ')'],
    ['0', '.', '±', '+', kind === 'ang' ? '°' : 'π'],
  ];
  const grid = h('div', { class: 'kg' });
  for (const row of keys) for (const k of row) {
    const op = '÷×−+()⌫±'.includes(k);
    grid.append(h('button', { class: op ? 'op' : '', 'data-k': k, html: k === '⌫' ? I.backspace : k }));
  }
  if (units.length) {
    for (const u of units) grid.append(h('button', { class: 'u', 'data-k': ' ' + u }, u));
    for (let i = units.length; i < 5; i++) grid.append(h('span'));
  }
  grid.append(h('button', { class: 'cancel', 'data-k': 'esc' }, 'Cancel'));
  grid.append(h('button', { class: 'ok', 'data-k': 'ok' }, 'Done'));
  el.replaceChildren(
    h('div', { class: 'kd' }, h('span', { class: 'kl' }, label || ''), h('div', { class: 'kexpr' })),
    h('div', { class: 'kprev' }), grid);
  el.hidden = false;
  grid.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); if (performance.now() - openedAt < 450) return; /* ghost click from the tap that opened us */ press(b.dataset.k); });
  renderKp();
}
function renderKp() {
  if (!kp) return;
  const ex = $('#keypad .kexpr');
  ex.classList.toggle('fresh', kp.fresh);
  ex.replaceChildren(kp.fresh ? h('span', {}, kp.expr) : kp.expr || ' ');
  ex.scrollLeft = 1e6;
  const pv = $('#keypad .kprev');
  try {
    const v = evalExpr(kp.expr, kp.kind === 'int' || kp.kind === 'num' ? 'num' : kp.kind);
    pv.textContent = '= ' + (kp.kind === 'len' ? fmtLen(v) + (S.settings.unit !== 'mm' ? `  (${trimNum(v)} mm)` : '') : kp.kind === 'ang' ? fmtAng(v) : kp.kind === 'int' ? Math.round(v) : fmtNum(v));
    pv.classList.remove('err'); kp.value = v;
  } catch (err) { pv.textContent = kp.expr ? err.message : ''; pv.classList.add('err'); kp.value = null; }
}
function press(k) {
  if (!kp) return;
  if (k === 'ok') return closeKeypad(true);
  if (k === 'esc') return closeKeypad(false);
  if (k === '⌫') { kp.expr = kp.fresh ? '' : kp.expr.slice(0, -1).replace(/\s+$/, ''); kp.fresh = false; return renderKp(); }
  if (k === '±') {
    if (kp.fresh) kp.fresh = false;
    kp.expr = kp.expr.startsWith('-(') && kp.expr.endsWith(')') ? kp.expr.slice(2, -1) : kp.expr.startsWith('-') && /^-[\d.]+$/.test(kp.expr) ? kp.expr.slice(1) : /^[\d.]+$/.test(kp.expr) ? '-' + kp.expr : `-(${kp.expr || '0'})`;
    return renderKp();
  }
  const isOp = '÷×−+'.includes(k) || (k.startsWith(' ') && k !== ' pi');
  if (kp.fresh) { kp.fresh = false; if (!isOp) kp.expr = ''; }
  const map = { '÷': ' ÷ ', '×': ' × ', '−': ' − ', '+': ' + ', 'π': 'π', '°': '°' };
  kp.expr += k === 'π' || k === ' pi' ? (/[\d)]$/.test(kp.expr) ? '×pi' : 'pi') : (map[k] ?? k);
  renderKp();
}
export function closeKeypad(commit) {
  if (!kp) return;
  const k = kp; kp = null;
  $('#keypad').hidden = true;
  k.anchor && k.anchor.classList.remove('editing');
  if (commit) {
    let v = k.value;
    if (v == null || !isFinite(v)) { toast('Invalid value'); return; }
    if (k.kind === 'int') v = Math.round(v);
    if (k.min != null && v < k.min) v = k.min;
    if (k.max != null && v > k.max) v = k.max;
    k.onCommit && k.onCommit(v);
  }
}
export const keypadOpen = () => !!kp;
export function keypadKey(e) {
  if (!kp) return false;
  const k = e.key;
  if (k === 'Enter') press('ok');
  else if (k === 'Escape') press('esc');
  else if (k === 'Backspace') press('⌫');
  else if (/^[0-9.]$/.test(k)) press(k);
  else if (k === '*') press('×'); else if (k === '/') press('÷'); else if (k === '-') press('−'); else if (k === '+') press('+');
  else if (k === '(' || k === ')') press(k);
  else if (/^[a-z"'°]$/i.test(k)) { if (kp.fresh) { kp.fresh = false; } kp.expr += k; renderKp(); }
  else return false;
  e.preventDefault();
  return true;
}

// ---------- fields ----------
export function field({ label, kind = 'len', value, onCommit, cls = '', min, max, readonly = false }) {
  const btn = h('button', { class: 'val' }, fmt(kind, value, kind !== 'num' && kind !== 'int'));
  if (!readonly) btn.addEventListener('click', () => openKeypad({ label, kind, value, min, max, onCommit, anchor: btn }));
  else btn.disabled = true;
  return h('div', { class: 'field ' + cls }, h('label', {}, label), btn);
}
export function choice({ label, options, value, onChange, cls = '' }) {
  const seg = h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { class: v === value ? 'on' : '', onclick: () => onChange(v) }, l)));
  return h('div', { class: 'field ' + cls }, label ? h('label', {}, label) : null, seg);
}
export function toggle({ label, value, onChange }) {
  const sw = h('button', { class: 'switch' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!value), 'aria-label': label });
  const row = h('div', { class: 'toggle' }, h('span', {}, label), sw);
  row.addEventListener('click', () => onChange(!value));
  return row;
}
export function stepper({ label, value, min, max, onChange }) {
  return h('div', { class: 'toggle' }, h('span', {}, label),
    h('div', { class: 'stepper' },
      h('button', { onclick: () => onChange(Math.max(min, value - 1)) }, '−'),
      h('b', { style: 'min-width:28px;text-align:center;font-family:var(--mono)' }, String(value)),
      h('button', { onclick: () => onChange(Math.min(max, value + 1)) }, '+')));
}
export const fmtField = { fmtLen, fmtAng, fmtNum };

// ---------- popover ----------
let popClose = null;
export function popover(anchor, content, { align = 'left', above = false } = {}) {
  closePopover();
  const pop = $('#popover'), scrim = $('#scrim');
  pop.replaceChildren(content); pop.hidden = false; scrim.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = align === 'right' ? r.right - pw : r.left;
  x = Math.max(10, Math.min(window.innerWidth - pw - 10, x));
  let y = above ? r.top - ph - 8 : r.bottom + 8;
  if (y + ph > window.innerHeight - 10) y = Math.max(10, r.top - ph - 8);
  if (y < 10) y = 10;
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  popClose = () => { pop.hidden = true; scrim.hidden = true; popClose = null; };
  scrim.onclick = closePopover;
}
export function closePopover() { popClose && popClose(); }
export function menuItem(icon, label, onClick, kbd = '') {
  return h('button', { class: 'mi', onclick: () => { closePopover(); onClick(); } }, h('span', { html: icon || '' }), label, kbd ? h('span', { class: 'k' }, kbd) : null);
}

// Unit formatting and a safe expression evaluator for exact numeric input.
// Internal length unit is the millimetre; angles are degrees.
import { S } from './state.js';

export const LEN_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const LEN_SUFFIX = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8, um: 0.001 };
const ANG_SUFFIX = { deg: 1, '°': 1, rad: 180 / Math.PI };

export function unitFactor() { return LEN_UNITS[S.settings.unit] || 1; }

function fix(v, p) {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) < 0.5 * Math.pow(10, -p)) v = 0;
  return v.toFixed(p);
}
export function fmtLen(mm, unit = true) {
  const s = fix(mm / unitFactor(), S.settings.precision);
  return unit ? `${s} ${S.settings.unit}` : s;
}
export function fmtArea(mm2) {
  const f = unitFactor();
  return `${fix(mm2 / (f * f), S.settings.precision)} ${S.settings.unit}²`;
}
export function fmtAng(deg, unit = true) {
  const s = fix(deg, Math.max(1, S.settings.precision));
  return unit ? s + '°' : s;
}
export function fmtNum(v) { return fix(v, Math.max(3, S.settings.precision)); }
export function fmt(kind, v, unit = true) {
  if (kind === 'len') return fmtLen(v, unit);
  if (kind === 'ang') return fmtAng(v, unit);
  if (kind === 'int') return String(Math.round(v));
  return fmtNum(v);
}

// --- expression evaluator -------------------------------------------------
// Supports + - * / ( ) pi, unicode × ÷ −, and unit suffixes (mm cm m in " ft ' deg rad).
// "3/8 in", "1in + 2mm", "2*pi*5", "45deg", "0.5 rad". Bare numbers use the display unit.
function tokenize(str) {
  const t = [];
  const s = str.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/,/g, '.').replace(/π/g, 'pi');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (s[j] === 'e' && /[-+0-9]/.test(s[j + 1] || '') && !/[a-z]/i.test(s[j + 1])) {
        j++; if (/[-+]/.test(s[j])) j++; while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      const v = parseFloat(s.slice(i, j));
      if (isNaN(v)) throw new Error('Bad number');
      t.push({ k: 'n', v }); i = j; continue;
    }
    if (/[a-zµ]/i.test(c)) {
      let j = i; while (j < s.length && /[a-zµ]/i.test(s[j])) j++;
      t.push({ k: 'id', v: s.slice(i, j).toLowerCase() }); i = j; continue;
    }
    if ('+-*/()'.includes(c)) { t.push({ k: c }); i++; continue; }
    if (c === '"' || c === "'" || c === '°') { t.push({ k: 'id', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return t;
}

export function evalExpr(str, kind = 'len') {
  const toks = tokenize(String(str));
  let p = 0;
  const suffix = kind === 'len' ? LEN_SUFFIX : kind === 'ang' ? ANG_SUFFIX : {};
  const peek = () => toks[p];
  // values are {v, d} where d=true means "already in base units"
  const conv = (a) => (a.d ? a.v : a.v * (kind === 'len' ? unitFactor() : 1));
  function expr() {
    let a = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) {
      const op = toks[p++].k; const b = term();
      if (a.d !== b.d) a = { v: conv(a), d: true }, b.v = conv(b), b.d = true;
      a = { v: op === '+' ? a.v + b.v : a.v - b.v, d: a.d };
    }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      const t = peek();
      if (t && t.k === 'id' && t.v in suffix) { p++; a = { v: a.v * suffix[t.v], d: true }; continue; }
      if (t && (t.k === '*' || t.k === '/')) {
        p++; const b = unary();
        if (t.k === '/' && b.v === 0) throw new Error('Divide by zero');
        a = { v: t.k === '*' ? a.v * b.v : a.v / b.v, d: a.d || b.d };
        continue;
      }
      // implicit multiplication: "2pi", "2(3+1)"
      if (t && (t.k === '(' || (t.k === 'id' && t.v === 'pi') || t.k === 'n')) {
        const b = unary(); a = { v: a.v * b.v, d: a.d || b.d }; continue;
      }
      return a;
    }
  }
  function unary() {
    const t = peek();
    if (!t) throw new Error('Incomplete');
    if (t.k === '-') { p++; const a = unary(); return { v: -a.v, d: a.d }; }
    if (t.k === '+') { p++; return unary(); }
    return primary();
  }
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error('Incomplete');
    if (t.k === 'n') return { v: t.v, d: false };
    if (t.k === 'id' && t.v === 'pi') return { v: Math.PI, d: false };
    if (t.k === '(') {
      const a = expr();
      if (!peek() || peek().k !== ')') throw new Error('Missing )');
      p++; return a;
    }
    throw new Error(t.k === 'id' ? `Unknown "${t.v}"` : 'Syntax error');
  }
  if (!toks.length) throw new Error('Empty');
  const r = expr();
  if (p < toks.length) throw new Error('Syntax error');
  const v = conv(r);
  if (!isFinite(v)) throw new Error('Not a number');
  return v;
}

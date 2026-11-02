// File I/O: binary STL, OBJ (Y-up on disk, Z-up in app), StreamLine project JSON.
import { PolyMesh, triangulateFace, faceNormal, weld, cross, sub, norm } from './mesh.js';
import { xfFor } from './scene.js';

export function exportSTL(objs) {
  const tris = [];
  for (const o of objs) {
    const xf = xfFor(o), W = o.mesh.v.map(xf.toW);
    const flip = o.scl.filter(s => s < 0).length % 2 === 1;
    for (const f of o.mesh.f) {
      const P = f.map(i => W[i]);
      for (const t of triangulateFace(P)) tris.push(flip ? [P[t[0]], P[t[2]], P[t[1]]] : [P[t[0]], P[t[1]], P[t[2]]]);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
  const head = 'StreamLine STL export, units: millimetres';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const n = norm(cross(sub(b, a), sub(c, a)));
    for (const v of [n, a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, v[k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

const r6 = v => { const s = (+v.toFixed(6)).toString(); return s === '-0' ? '0' : s; };
export function exportOBJ(objs) {
  const L = ['# StreamLine OBJ export — units: millimetres, Y-up'];
  let base = 1;
  for (const o of objs) {
    const xf = xfFor(o);
    const flip = o.scl.filter(s => s < 0).length % 2 === 1;
    L.push(`o ${o.name.replace(/\s+/g, '_')}`);
    for (const p of o.mesh.v) { const w = xf.toW(p); L.push(`v ${r6(w[0])} ${r6(w[2])} ${r6(-w[1])}`); }
    for (const f of o.mesh.f) { const g = flip ? f.slice().reverse() : f; L.push('f ' + g.map(i => i + base).join(' ')); }
    base += o.mesh.v.length;
  }
  return new Blob([L.join('\n') + '\n'], { type: 'model/obj' });
}

export function parseOBJ(text) {
  const out = [];
  const allV = [];
  let cur = null;
  const start = (name) => { cur = { name, faces: [], used: new Map() }; out.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const k = parts[0];
    if (k === 'v') { const [x, y, z] = parts.slice(1, 4).map(Number); allV.push([x, -z, y]); }
    else if (k === 'o' || k === 'g') { if (!cur || cur.faces.length) start(parts.slice(1).join(' ') || 'Object'); }
    else if (k === 'f') {
      if (!cur) start('Import');
      const idx = parts.slice(1).map(t => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? allV.length + i : i - 1; });
      if (idx.length >= 3) cur.faces.push(idx);
    }
  }
  return out.filter(g => g.faces.length).map(g => {
    const map = new Map(), v = [];
    const f = g.faces.map(face => face.map(i => { if (!map.has(i)) { map.set(i, v.length); v.push(allV[i].slice()); } return map.get(i); }));
    return { name: g.name, mesh: new PolyMesh(v, f) };
  });
}

export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const v = [], f = [];
  const isBinary = buffer.byteLength >= 84 && 84 + dv.getUint32(80, true) * 50 === buffer.byteLength;
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; const face = [];
      for (let k = 0; k < 3; k++) { face.push(v.length); v.push([dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]); }
      f.push(face);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m, face = [];
    while ((m = re.exec(text))) { face.push(v.length); v.push([+m[1], +m[2], +m[3]]); if (face.length === 3) { f.push(face); face = []; } }
  }
  const mesh = new PolyMesh(v, f);
  weld(mesh, 1e-4);
  return mesh;
}

// Deliver a file: iOS share sheet ("Save to Files") when available, else a download.
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

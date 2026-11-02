// End-to-end test in an emulated iPhone (touch input): `npm run test:e2e`
// Draw (rect, 2D fillet, 2D chamfer, circle, driving dimension, constraint) → CAD (extrude, edge fillet,
// edge chamfer) → Model, plus undo. Requires Playwright with Chromium.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const OUT = new URL('./output/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8000 + Math.floor(Math.random() * 900);
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failures++; };

const srv = await serve(PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(`http://localhost:${PORT}/`);
await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1200);
const cdp = await ctx.newCDPSession(p);
const top = await p.evaluate(() => document.querySelector('#gl').getBoundingClientRect().top);
const st = fn => p.evaluate(fn);
const shot = async n => { await p.waitForTimeout(300); await p.screenshot({ path: OUT + n + '.png' }); };
const tapV = async (x, y) => { await p.touchscreen.tap(x, y + top); await p.waitForTimeout(460); };
const keypad = async str => {
  await p.waitForTimeout(460);
  const neg = str.startsWith('-'); if (neg) str = str.slice(1);
  for (const ch of str) await p.tap(`#keypad [data-k="${ch}"]`);
  if (neg) await p.tap('#keypad [data-k="±"]');
  await p.tap('#keypad [data-k="ok"]'); await p.waitForTimeout(120);
};
const proj = xy => p.evaluate(([x, y]) => { const sk = StreamLine.SK.activeSketch(); return StreamLine.view.project(StreamLine.SK.toW(sk.plane, [x, y])); }, xy);
const projW = w => p.evaluate(w => StreamLine.view.project(w), w);
const drag = async pts => {
  const t = (x, y) => [{ x, y: y + top, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: t(...pts[0]) });
  for (let i = 1; i < pts.length; i++) for (let s = 1; s <= 10; s++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: t(x0 + (x1 - x0) * s / 10, y0 + (y1 - y0) * s / 10) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(120);
};
const ents = () => st(() => StreamLine.SK.activeSketch().ents);

try {
  check(await st(() => StreamLine.S.ed.workspace) === 'draw', 'opens in the Draw workspace with an XY sketch');

  // --- rectangle by typed values
  await p.tap('[data-tool=rect]');
  await p.tap('#draw-card .field.ax-x .val'); await keypad('-20');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('-15');
  await p.tap('#draw-card .field.ax-x .val'); await keypad('40');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('30');
  const rect = (await ents()).find(e => e.t === 'rect');
  check(rect && rect.x === -20 && rect.y === -15 && rect.w === 40 && rect.h === 30, 'typed rectangle is exactly 40 × 30 at (-20, -15)');
  // zoom out so the whole drawing sits clear of the cards and command line (as a user would pinch)
  await p.evaluate(() => { StreamLine.view.cam.dist *= 1.5; StreamLine.view.cam.target.set(5, 8, 0); StreamLine.view.render(); }); await p.waitForTimeout(250);

  // --- 2D fillet (R5) and chamfer (4) on corners
  await p.tap('[data-tool=corner]');
  await p.tap('#draw-card .field:nth-child(2) .val'); await keypad('5');
  let c = await proj([20, 15]); await tapV(c.x, c.y);
  const arc = (await ents()).find(e => e.t === 'arc');
  check(arc && arc.r === 5 && arc.c[0] === 15 && arc.c[1] === 10, `sketch fillet R5 centred at (15, 10) ${JSON.stringify(arc && arc.c)}`);
  await p.tap('#draw-card .seg button:nth-child(2)');
  await p.tap('#draw-card .field:nth-child(2) .val'); await keypad('4');
  c = await proj([-20, -15]); await tapV(c.x, c.y);
  const ch = (await ents()).find(e => e.t === 'line' && Math.abs(Math.abs(e.a[0] - e.b[0]) - 4) < 1e-12 && Math.abs(Math.abs(e.a[1] - e.b[1]) - 4) < 1e-12);
  check(!!ch, 'sketch chamfer 4 × 4 at the opposite corner');
  check(await st(() => (StreamLine.SK.activeSketch().cons || []).filter(c => c.t === 'tan').length) === 2, 'fillet arc carries two tangent constraints');

  // --- circle + driving diameter dimension
  await p.tap('[data-tool=circle]');
  await p.tap('#draw-card .field.ax-x .val'); await keypad('0');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('0');
  await p.tap('#draw-card .field .val', { timeout: 4000 }); await keypad('7');
  await p.tap('[data-tool=dim]');
  c = await proj([0, -7]); await tapV(c.x, c.y);
  await keypad('10');
  const circ = (await ents()).find(e => e.t === 'circle');
  check(circ && circ.r === 5, `diameter dimension drives the circle to Ø10 (r=${circ && circ.r})`);

  // --- constraint: a slanted line made vertical
  await p.tap('[data-tool=line]');
  const l0 = await proj([-30, -10]), l1 = await proj([-27, 10]);
  await drag([[l0.x, l0.y], [l1.x, l1.y]]);
  await p.tap('#draw-card .btn');
  const slant = (await ents()).find(e => e.t === 'line' && e.a[0] <= -24);
  await p.tap('[data-tool=select]');
  c = await proj([(slant.a[0] + slant.b[0]) / 2, (slant.a[1] + slant.b[1]) / 2]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.drawSel.size) === 1, 'tapping the line selects it');
  await p.locator('#actions .act', { hasText: 'Constrain' }).tap();
  await p.tap('#popover .mi:nth-of-type(2)'); // Vertical
  const v = (await ents()).find(e => e.id === slant.id);
  check(Math.abs(v.a[0] - v.b[0]) < 1e-9, `vertical constraint applied (dx=${(v.a[0] - v.b[0]).toExponential(1)})`);
  check(/DOF|constrained/.test(await p.textContent('#hud')), 'HUD reports degrees of freedom');
  // tap the same line twice with the Dim tool → length dimension, drive it to 15
  await p.tap('[data-tool=dim]');
  c = await proj([v.a[0], (v.a[1] + v.b[1]) / 2]); await tapV(c.x, c.y); await tapV(c.x, c.y);
  await keypad('15');
  const v2 = (await ents()).find(e => e.id === slant.id);
  check(Math.abs(Math.hypot(v2.b[0] - v2.a[0], v2.b[1] - v2.a[1]) - 15) < 1e-9 && Math.abs(v2.a[0] - v2.b[0]) < 1e-9, 'line-length dimension drives it to 15 and it stays vertical');
  await p.tap('[data-tool=select]');
  await shot('1-draw');

  // --- CAD: extrude the plate (tap inside, away from the hole)
  await p.tap('[data-ws=cad]'); await p.waitForTimeout(400);
  const areaPlate = await st(() => StreamLine.SK.regions(StreamLine.SK.activeSketch()).find(r => r.holes.length).area);
  c = await proj([-10, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.profiles.length) === 1, 'tapping a region picks a profile');
  await p.tap('#actions .act.primary');
  await p.tap('#lastop .field .val'); await keypad('8');
  const vol0 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  const holeArea = await st(() => { const r = StreamLine.SK.regions(StreamLine.SK.activeSketch()).find(r => r.holes.length); return r.holes.reduce((s, h) => { let a = 0; for (let i = 0; i < h.length; i++) { const p = h[i], q = h[(i + 1) % h.length]; a += p[0] * q[1] - q[0] * p[1]; } return s + Math.abs(a / 2); }, 0); });
  check(Math.abs(vol0 - (areaPlate - holeArea) * 8) < 1e-6, `extruded volume = region area × 8 (${vol0.toFixed(4)} mm³)`);
  await p.tap('#lastop .ib[aria-label=Done]');

  // --- edge fillet on the top front edge (y=-15 is chamfered at x=-20; use the long top edge at y=-15, z=8)
  await p.tap('[data-tool=edge]');
  c = await projW([5, -15, 8]); await tapV(c.x, c.y);
  const edges = await st(() => StreamLine.S.ed.edges);
  check(edges.length === 1, `edge tool picks an edge ${JSON.stringify(edges[0] && [edges[0].a, edges[0].b])}`);
  await p.locator('#actions .act', { hasText: 'Fillet' }).tap();
  await p.tap('#lastop .field .val'); await keypad('2');
  const res1 = await st(() => { const o = StreamLine.S.doc.objects[0]; return { vol: StreamLine.M.meshVolume(o.mesh), last: StreamLine.getLast() && StreamLine.getLast().def.label(StreamLine.getLast().params) }; });
  check(res1.vol < vol0 && res1.vol > vol0 - 40, `edge fillet R2 removes material (${(vol0 - res1.vol).toFixed(3)} mm³) — ${res1.last}`);
  await p.tap('#lastop .ib[aria-label=Done]');
  // chamfer the vertical edge at (20, -15)
  c = await projW([20, -15, 4]); await tapV(c.x, c.y);
  const e2 = (await st(() => StreamLine.S.ed.edges))[0];
  const runLen = e2 ? Math.hypot(e2.a[0] - e2.b[0], e2.a[1] - e2.b[1], e2.a[2] - e2.b[2]) : 0;
  check(Math.abs(runLen - 6) < 1e-9, `vertical edge is 6 mm after the R2 fillet (${runLen})`);
  await p.locator('#actions .act', { hasText: 'Chamfer' }).tap();
  await p.tap('#lastop .field .val'); await keypad('1.5');
  const vol2 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(Math.abs((res1.vol - vol2) - 1.5 * 1.5 / 2 * runLen) < 1e-6, `edge chamfer 1.5 removes exactly ${(1.5 * 1.5 / 2 * runLen).toFixed(4)} mm³ (got ${(res1.vol - vol2).toFixed(6)})`);
  const tight = await st(() => { const m = StreamLine.S.doc.objects[0].mesh, c = new Map(); for (const f of m.f) f.forEach((a, i) => { const b = f[(i + 1) % f.length], k = a < b ? a + '_' + b : b + '_' + a; c.set(k, (c.get(k) || 0) + 1); }); return [...c.values()].every(n => n === 2); });
  check(tight, 'body is still watertight after fillet + chamfer');
  await shot('2-cad');

  // --- AutoCAD command line: typed coordinates, edit commands
  await p.tap('[data-ws=draw]'); await p.waitForTimeout(300);
  const run = async c => { await p.fill('#cmdin', c); await p.press('#cmdin', 'Enter'); await p.waitForTimeout(120); };
  const n0 = (await ents()).length;
  await run('L'); await run('50,0'); await run('@20<0'); await run('@20<90'); await run('');
  const ln = (await ents()).slice(n0).filter(e => e.t === 'line');
  check(ln.length === 2 && ln[0].b[0] === 70 && ln[0].b[1] === 0 && ln[1].b[0] === 70 && ln[1].b[1] === 20, `LINE with absolute + polar input: ${JSON.stringify(ln.map(l => [l.a, l.b]))}`);
  check(/Command:/.test(await p.textContent('#cmdprompt')), 'prompt returns to Command:');
  await p.evaluate(ids => { StreamLine.S.ed.drawSel = new Set(ids); }, ln.map(l => l.id));
  await run('CO'); await run('50,0'); await run('@0,30'); await run('');
  const copies = (await ents()).filter(e => e.t === 'line' && e.a[1] >= 30 && e.a[0] >= 50);
  check(copies.length === 2, `COPY with @0,30 makes 2 copies (${copies.length})`);
  await p.evaluate(ids => { StreamLine.S.ed.drawSel = new Set(ids); }, ln.map(l => l.id));
  await run('RO'); await run('50,0'); await run('90');
  const rot = (await ents()).find(e => e.id === ln[0].id);
  check(rot.b[0] === 50 && rot.b[1] === 20, `ROTATE 90° about 50,0 (${JSON.stringify(rot.b)})`);
  await run('O'); await run('2.5');
  c = await proj([50, 10]); await tapV(c.x, c.y); // pick the rotated line
  c = await proj([45, 10]); await tapV(c.x, c.y); // side
  const off = (await ents()).find(e => e.t === 'line' && e.a[0] === 47.5);
  check(!!off, 'OFFSET 2.5 to the left');
  await run(''); // exit offset
  await run('ORTHO');
  check(await st(() => StreamLine.S.settings.ortho) === true && /on/.test(await p.locator('#statusbar [data-st=ortho]').getAttribute('class')), 'ORTHO toggled from the command line');
  await run('ORTHO');
  // inquiry: DIST, AREA (points), ID, MEASUREGEOM angle, horizontal/vertical dimension
  const logText = () => p.textContent('#cmdlog');
  await run('DI'); await run('0,0'); await run('3,4');
  check(/Distance = 5\.00 mm/.test(await logText()) && /ΔX = 3\.00/.test(await logText()), `DIST prints distance and deltas: "${await logText()}"`);
  await run('AREA'); await run('0,0'); await run('10,0'); await run('10,5'); await run('0,5'); await run('');
  check(/Area = 50\.00 mm²/.test(await logText()) && /Perimeter = 30\.00/.test(await logText()), `AREA by points: "${await logText()}"`);
  await run('MA'); await run('0,0'); await run('10,0'); await run('10,10');
  check(/Angle = 45\.00°/.test(await logText()), `MEASUREGEOM angle: "${await logText()}"`);
  await run('ID'); await run('12.5,-3');
  check(/X = 12\.50\s+Y = -3\.00/.test(await logText()), `ID point: "${await logText()}"`);
  await p.tap('#cmdlog');
  check((await p.locator('#cmdhistory div').count()) >= 4, 'command history panel lists the results');
  await p.tap('#cmdlog');
  await run('DLI');
  const hl = (await ents()).find(e => e.id === ln[0].id);
  c = await proj(hl.a); await tapV(c.x, c.y); c = await proj(hl.b); await tapV(c.x, c.y);
  await keypad('25');
  const dl = (await ents()).find(e => e.t === 'dim' && (e.kind === 'hor' || e.kind === 'ver'));
  check(!!dl, `DIMLINEAR creates a ${dl && dl.kind} dimension`);
  // construction line + ARRAYPOLAR on a circle
  const before = (await ents()).length;
  await run('XL'); await run('80,-10'); await run('@0,40'); await run('');
  const xl = (await ents()).slice(before).find(e => e.t === 'line');
  check(xl && xl.construction === true, 'XLINE draws a construction line');
  await run('C'); await run('100,0'); await run('2');
  const cc = (await ents()).at(-1);
  await p.evaluate(id => { StreamLine.S.ed.drawSel = new Set([id]); }, cc.id);
  await run('ARRAYPOLAR'); await run('80,0');
  const ring = (await ents()).filter(e => e.t === 'circle' && Math.abs(Math.hypot(e.c[0] - 80, e.c[1]) - 20) < 1e-9);
  check(ring.length === 6, `ARRAYPOLAR makes 6 items around 80,0 (${ring.length})`);
  check(/ArrayPolar/.test(await p.textContent('#lastop')), 'array parameters are editable in the operation card');
  // ELLIPSE, SPLINE, PLINE arc
  await run('EL'); await run('120,0'); await run('@10<0'); await run('4');
  const el = (await ents()).find(e => e.t === 'ellipse');
  check(el && el.rx === 10 && el.ry === 4 && el.rot === 0, `ELLIPSE center 120,0 axis 10, other 4 (${JSON.stringify(el)})`);
  await run('SPL'); await run('120,20'); await run('130,30'); await run('140,20'); await run('');
  const sp = (await ents()).find(e => e.t === 'spline');
  check(sp && sp.pts.length === 3, 'SPLINE through 3 fit points');
  await run('PL'); await run('150,0'); await run('@10,0'); await run('A'); await run('@0,10'); await run('L'); await run('@-10,0'); await run('');
  const ar = (await ents()).filter(e => e.t === 'arc').at(-1);
  check(ar && Math.abs(ar.r - 5) < 1e-9 && Math.abs(ar.c[0] - 160) < 1e-9 && Math.abs(ar.c[1] - 5) < 1e-9, `PLINE tangent arc R5 centred 160,5 (${ar && JSON.stringify([ar.c, ar.r])})`);
  // TEXT and HATCH
  await run('TEXT'); await run('-60,-20'); await run('5');
  await p.fill('#cmdin', 'Part A-1 rev B'); await p.press('#cmdin', 'Enter'); await p.waitForTimeout(150);
  const tx = (await ents()).find(e => e.t === 'text');
  check(tx && tx.str === 'Part A-1 rev B' && tx.h === 5, `TEXT keeps spaces and case (${tx && JSON.stringify(tx.str)}, h=${tx && tx.h})`);
  await run('H');
  c = await proj([-10, 8]); await tapV(c.x, c.y);
  const ht = (await ents()).find(e => e.t === 'hatch');
  check(ht && ht.pattern === 'ANSI31', 'HATCH fills the picked region');
  check(/Hatch/.test(await p.textContent('#lastop')), 'hatch pattern/scale/angle are editable');
  await shot('4-acad');

  // --- Plasticity-style Model: face push/pull with a live handle, edge fillet, shell
  await p.tap('[data-ws=model]'); await p.waitForTimeout(400);
  await p.locator('.ctxseg button', { hasText: 'Face' }).tap();
  c = await projW([0, 8, 8]); await tapV(c.x, c.y); // top face of the plate
  check(await st(() => StreamLine.S.ed.faces.length) === 1, 'Face mode selects the top face');
  const v0 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  await p.locator('#actions .act', { hasText: 'Push/Pull' }).tap();
  const pp = await st(() => StreamLine.getLast() && StreamLine.getLast().params.dist);
  const topArea = await st(() => { const o = StreamLine.S.doc.objects[0]; return null; });
  void topArea;
  await p.tap('#lastop .field .val'); await keypad('3');
  const v1 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(v1 > v0, `Push/Pull +3 adds material (${(v1 - v0).toFixed(3)} mm³; default was ${pp})`);
  // drag the live handle
  const hd = await st(() => { const L = StreamLine.getLast(), h = L.handle; return { a: h.origin.map((c, k) => c + h.dir[k] * L.params.dist), dir: h.dir }; });
  const ha = await projW(hd.a), hb = await projW(hd.a.map((c, k) => c + hd.dir[k] * 6));
  await drag([[ha.x, ha.y], [hb.x, hb.y]]);
  const dd = await st(() => StreamLine.getLast().params.dist);
  check(Math.abs(dd - 3) > 0.5 && Number.isInteger(+dd.toFixed(9)), `dragging the handle changes the distance live, snapped (${dd})`);
  check(/Push\/Pull/.test(await p.textContent('#lastop')) && await p.evaluate(() => getComputedStyle(document.querySelector('#lastop')).top !== 'auto'), 'Plasticity-style floating dialog');
  await p.tap('#lastop .ib[aria-label=Done]');
  await p.locator('.ctxseg button', { hasText: 'Edge' }).tap();
  const bb = await st(() => { const o = StreamLine.S.doc.objects[0], W = o.mesh.v.map(v => v.map((c, k) => c + o.loc[k])); const zs = W.map(p => p[2]); return Math.max(...zs); });
  c = await projW([0, 15, bb]); await tapV(c.x, c.y);
  const ne = await st(() => StreamLine.S.ed.edges.length);
  check(ne === 1, `Edge mode picks an edge (${ne})`);
  const vb = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  await p.locator('#actions .act', { hasText: 'Fillet' }).tap();
  const va = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(va < vb, `Model fillet removes material (${(vb - va).toFixed(3)})`);
  check(await st(() => !!(StreamLine.getLast() && StreamLine.getLast().handle)), 'fillet has a live radius handle');
  // round edge: the hole rim (Ø10 hole through the plate) → fillet the whole circle
  await p.tap('#lastop .ib[aria-label=Done]');
  const zt = await st(() => { const o = StreamLine.S.doc.objects[0]; return Math.max(...o.mesh.v.map(v => v[2] + o.loc[2])); });
  const holeR = await st(() => StreamLine.SK.sketchById(1).ents.find(e => e.t === 'circle').r);
  c = await projW([0, -holeR, zt]); await tapV(c.x, c.y);
  const rimSel = await st(() => StreamLine.S.ed.edges.at(-1));
  check(rimSel && rimSel.circle && Math.abs(rimSel.circle.R - holeR) < 1e-6, `tapping the hole rim selects the whole circle (R=${rimSel && rimSel.circle && rimSel.circle.R})`);
  await p.evaluate(() => { const L = StreamLine.S.ed.edges.at(-1); StreamLine.S.ed.edges = [L]; });
  const vr0 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  await p.locator('#actions .act', { hasText: 'Chamfer' }).tap();
  const vr1 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(vr1 < vr0, `round-edge chamfer (countersink) removes material (${(vr0 - vr1).toFixed(3)})`);
  await shot('5-plasticity');
  await p.tap('#lastop .ib[aria-label=Done]');
  await p.locator('.ctxseg button', { hasText: 'Solid' }).tap();
  c = await projW([0, 0, 4]); await tapV(c.x, c.y);
  const nb = await st(() => StreamLine.S.doc.objects.length);
  await p.locator('#actions .act', { hasText: 'Slice' }).tap();
  await p.tap('#lastop .field .val'); await keypad('4');
  check(await st(() => StreamLine.S.doc.objects.length) === nb + 1, 'Slice at z=4 splits the body in two');
  const vsum = await st(() => StreamLine.S.doc.objects.slice(-2).map(o => StreamLine.M.meshVolume(o.mesh)));
  check(vsum.every(v => v > 0), `both halves are solid (${vsum.map(v => v.toFixed(1)).join(' + ')})`);
  await p.tap('#lastop .ib[aria-label=Done]');
  await p.tap('#btn-undo'); await p.waitForTimeout(150);
  // direct modelling: select a face and drag it with the Move gizmo (Plasticity-style)
  await p.locator('.ctxseg button', { hasText: 'Face' }).tap();
  const zTop = await st(() => { const o = StreamLine.S.doc.objects[0]; return Math.max(...o.mesh.v.map(v => v[2] + o.loc[2])); });
  c = await projW([-8, 0, zTop]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.faces.length) === 1, 'top face selected for direct modelling');
  await p.tap('[data-tool=move]');
  const vF0 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  const piv = await st(() => StreamLine.OPS.computePivot());
  const sz = await p.evaluate(pv => StreamLine.view.worldPerPixel(pv) * 84, piv);
  const zA = await projW([piv[0], piv[1], piv[2] + sz * 0.8]), zB = await projW([piv[0], piv[1], piv[2] + sz * 0.8 + 4]);
  await drag([[zA.x, zA.y], [zB.x, zB.y]]);
  const mv = await st(() => { const L = StreamLine.getLast(); return L && [L.def.label(L.params), L.params.z]; });
  const vF1 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(mv && mv[0] === 'Move' && mv[1] > 0 && vF1 > vF0, `dragging the face up stretches the body (dz=${mv && mv[1]}, +${(vF1 - vF0).toFixed(2)} mm³)`);
  await p.tap('[data-tool=select]');
  // draft: tilt one side face of a fresh box by 5°
  await p.evaluate(() => StreamLine.runOp(StreamLine.OPS.addPrim, { type: 'cube', w: 20, d: 20, h: 20, x: -80, y: 0, z: 10 }));
  await p.locator('.ctxseg button', { hasText: 'Face' }).tap();
  await p.evaluate(() => { StreamLine.view.frame([[-90, -10, 0], [-70, 10, 20]]); }); await p.waitForTimeout(400);
  c = await projW([-70, 0, 10]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.faces.length === 1 && Math.abs(StreamLine.S.ed.faces[0].n[0] - 1) < 1e-9), 'side face of the box selected');
  await p.locator('#actions .act', { hasText: 'Draft' }).tap();
  await p.tap('#lastop .field .val'); await keypad('5');
  const dv = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects.at(-1).mesh));
  check(Math.abs(dv - (8000 - 4000 * Math.tan(5 * Math.PI / 180))) < 1e-6, `Draft 5° gives the exact volume (${dv.toFixed(4)})`);
  await p.tap('#lastop .ib[aria-label=Done]');
  await p.tap('#btn-undo'); await p.tap('#btn-undo'); await p.waitForTimeout(150);
  await p.locator('.ctxseg button', { hasText: 'Solid' }).tap();
  // thicken a plane
  await p.locator('.ctxseg button', { hasText: 'Solid' }).tap();
  await p.evaluate(() => StreamLine.runOp(StreamLine.OPS.addPrim, { type: 'plane', w: 10, d: 10, x: 80, y: 0, z: 0 }));
  await p.locator('#actions .act', { hasText: 'Thicken' }).tap();
  await p.tap('#lastop .field .val'); await keypad('3');
  const vt = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects.at(-1).mesh));
  check(Math.abs(vt - 300) < 1e-6, `Thicken turns a 10×10 plane into a 3 mm plate (${vt.toFixed(4)} mm³)`);
  await p.tap('#btn-undo'); await p.tap('#btn-undo'); await p.tap('#btn-undo'); await p.waitForTimeout(150);

  // --- LOFT and SWEEP (sketches built through the API, operations through the UI)
  await p.tap('[data-ws=cad]'); await p.waitForTimeout(300);
  const ids = await p.evaluate(() => {
    const { runOp, F, S } = StreamLine;
    const mk = (plane, offset, ents) => { runOp(F.newSketch, { plane, offset }); const id = S.ed.sketch; runOp(F.sketchOp('t', id, k => { for (const e of ents) F.addEntity(k, e); })); return id; };
    const a = mk('XY', 40, [{ t: 'rect', x: 100, y: -5, w: 10, h: 10 }]);
    const b = mk('XY', 50, [{ t: 'rect', x: 102.5, y: -2.5, w: 5, h: 5 }]);
    const pr = mk('XY', 70, [{ t: 'rect', x: 129, y: -1, w: 2, h: 2 }]);
    const path = mk('XZ', 0, [{ t: 'line', a: [130, 70], b: [130, 90] }, { t: 'line', a: [130, 90], b: [150, 90] }]);
    return { a, b, pr, path };
  });
  await p.tap('[data-ws=cad]'); await p.waitForTimeout(300);
  await p.evaluate(({ a, b }) => { StreamLine.S.ed.profiles = [{ sk: a, pt: [105, 0] }, { sk: b, pt: [105, 0] }]; StreamLine.S.ed.selected = new Set(); }, ids);
  const nObj = await st(() => StreamLine.S.doc.objects.length);
  await p.locator('#actions .act', { hasText: 'Loft' }).tap();
  const lv = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects.at(-1).mesh));
  check(await st(() => StreamLine.S.doc.objects.length) === nObj + 1 && Math.abs(lv - 10 / 3 * (100 + 25 + 50)) < 1e-6, `LOFT square → smaller square is an exact frustum (${lv.toFixed(4)})`);
  await p.tap('#lastop .ib[aria-label=Done]');
  await p.evaluate(({ pr }) => { StreamLine.S.ed.profiles = [{ sk: pr, pt: [130, 0] }]; StreamLine.S.ed.selected = new Set(); }, ids);
  await p.locator('#actions .act', { hasText: 'Sweep' }).tap();
  const sv = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects.at(-1).mesh));
  check(Math.abs(sv - 4 * 40) < 1e-6, `SWEEP a 2×2 section along a 20+20 L-path = 160 mm³ (${sv.toFixed(4)})`);
  await p.tap('#lastop .ib[aria-label=Done]');
  for (let i = 0; i < 10; i++) await p.tap('#btn-undo'); // sweep, loft and the 4 sketches (2 ops each)
  await p.waitForTimeout(150);

  // --- Model workspace + undo
  await p.tap('[data-ws=model]'); await p.waitForTimeout(400);
  check(await st(() => StreamLine.S.ed.workspace) === 'model', 'Model workspace opens');
  await p.tap('#btn-undo'); await p.waitForTimeout(150);
  const vu = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(Math.abs(vu - vr0) < 1e-9, 'undo reverts the last operation (the countersink) exactly');
  await shot('3-model');
} catch (e) {
  await p.screenshot({ path: OUT + 'crash.png' }).catch(() => {});
  check(false, 'test crashed: ' + e.message.split('\n').slice(0, 8).join(' / '));
}
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); srv.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);

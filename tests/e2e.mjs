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
const tapV = async (x, y) => { await p.touchscreen.tap(x, y + top); await p.waitForTimeout(120); };
const keypad = async str => {
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
  await p.tap('#draw-card .field .val', { timeout: 4000 }); await keypad('3');
  await p.tap('[data-tool=dim]');
  c = await proj([0, 3]); await tapV(c.x, c.y);
  await keypad('10');
  const circ = (await ents()).find(e => e.t === 'circle');
  check(circ && circ.r === 5, `diameter dimension drives the circle to Ø10 (r=${circ && circ.r})`);

  // --- constraint: a slanted line made vertical
  await p.tap('[data-tool=line]');
  const l0 = await proj([25, -10]), l1 = await proj([28, 10]);
  await drag([[l0.x, l0.y], [l1.x, l1.y]]);
  await p.tap('#draw-card .btn');
  const slant = (await ents()).find(e => e.t === 'line' && e.a[0] >= 24);
  await p.tap('[data-tool=select]');
  c = await proj([(slant.a[0] + slant.b[0]) / 2, (slant.a[1] + slant.b[1]) / 2]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.drawSel.size) === 1, 'tapping the line selects it');
  await p.tap('#actions .act:nth-child(2)'); // Constrain
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
  await p.tap('#actions .act:nth-child(3)'); // Fillet
  await p.tap('#lastop .field .val'); await keypad('2');
  const res1 = await st(() => { const o = StreamLine.S.doc.objects[0]; return { vol: StreamLine.M.meshVolume(o.mesh), last: StreamLine.getLast() && StreamLine.getLast().def.label(StreamLine.getLast().params) }; });
  check(res1.vol < vol0 && res1.vol > vol0 - 40, `edge fillet R2 removes material (${(vol0 - res1.vol).toFixed(3)} mm³) — ${res1.last}`);
  await p.tap('#lastop .ib[aria-label=Done]');
  // chamfer the vertical edge at (20, -15)
  c = await projW([20, -15, 4]); await tapV(c.x, c.y);
  const e2 = (await st(() => StreamLine.S.ed.edges))[0];
  const runLen = e2 ? Math.hypot(e2.a[0] - e2.b[0], e2.a[1] - e2.b[1], e2.a[2] - e2.b[2]) : 0;
  check(Math.abs(runLen - 6) < 1e-9, `vertical edge is 6 mm after the R2 fillet (${runLen})`);
  await p.tap('#actions .act:nth-child(4)'); // Chamfer
  await p.tap('#lastop .field .val'); await keypad('1.5');
  const vol2 = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(Math.abs((res1.vol - vol2) - 1.5 * 1.5 / 2 * runLen) < 1e-6, `edge chamfer 1.5 removes exactly ${(1.5 * 1.5 / 2 * runLen).toFixed(4)} mm³ (got ${(res1.vol - vol2).toFixed(6)})`);
  const tight = await st(() => { const m = StreamLine.S.doc.objects[0].mesh, c = new Map(); for (const f of m.f) f.forEach((a, i) => { const b = f[(i + 1) % f.length], k = a < b ? a + '_' + b : b + '_' + a; c.set(k, (c.get(k) || 0) + 1); }); return [...c.values()].every(n => n === 2); });
  check(tight, 'body is still watertight after fillet + chamfer');
  await shot('2-cad');

  // --- Model workspace + undo
  await p.tap('[data-ws=model]'); await p.waitForTimeout(400);
  check(await st(() => StreamLine.S.ed.workspace) === 'model', 'Model workspace opens');
  await p.tap('#btn-undo'); await p.waitForTimeout(150);
  const vu = await st(() => StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh));
  check(Math.abs(vu - res1.vol) < 1e-9, 'undo reverts the chamfer exactly');
  await shot('3-model');
} catch (e) {
  await p.screenshot({ path: OUT + 'crash.png' }).catch(() => {});
  check(false, 'test crashed: ' + e.message.split('\n').slice(0, 8).join(' / '));
}
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); srv.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);

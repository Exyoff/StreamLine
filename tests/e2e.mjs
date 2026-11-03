// End-to-end test of the Plasticity-style studio in an emulated iPhone (touch input): `npm run test:e2e`
// Draw curves on the grid → regions → extrude → draw directly on a face → extrude (auto-join) →
// fillet an edge → select curves / solids → command palette → optional AutoCAD command line → undo.
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
  await p.tap('#keypad [data-k="ok"]'); await p.waitForTimeout(150);
};
const projW = w => p.evaluate(w => StreamLine.view.project(w), w);
const drag = async pts => {
  const t = (x, y) => [{ x, y: y + top, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: t(...pts[0]) });
  for (let i = 1; i < pts.length; i++) for (let s = 1; s <= 10; s++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: t(x0 + (x1 - x0) * s / 10, y0 + (y1 - y0) * s / 10) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(160);
};
const vol = () => st(() => StreamLine.S.doc.objects.length ? StreamLine.M.meshVolume(StreamLine.S.doc.objects[0].mesh) : 0);
const ctxBar = async () => (await p.locator('#actions .act').allTextContents()).map(t => t.trim());
const closeCard = async () => { if (await p.locator('#lastop .ib[aria-label=Done]').isVisible()) await p.tap('#lastop .ib[aria-label=Done]'); };
const frame = (lo, hi) => p.evaluate(([lo, hi]) => { StreamLine.view.frame([lo, hi]); }, [lo, hi]).then(() => p.waitForTimeout(450));

try {
  // --- one studio, Plasticity selection modes
  check(await st(() => StreamLine.S.ed.workspace) === 'model' && await p.locator('#ws-seg [data-pick=solid]').isVisible(), 'opens in the single 3D studio with Edge / Face / Solid modes');
  check((await ctxBar()).includes('Add solid'), 'empty selection: the command bar offers Add solid and drawing tools');

  // --- command palette: search and run
  await p.tap('#btn-cmd'); await p.fill('.pal-in', 'rect'); await p.press('.pal-in', 'Enter'); await p.waitForTimeout(150);
  check(await st(() => StreamLine.S.ed.tool) === 'rect', 'command palette: "rect" ⏎ picks the Rectangle tool');

  // --- rectangle on the grid by typed values: creates its sketch on demand, one undo step
  await p.tap('#draw-card .field.ax-x .val'); await keypad('-20');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('-15');
  await p.tap('#draw-card .field.ax-x .val'); await keypad('40');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('30');
  const sk1 = await st(() => StreamLine.S.doc.sketches.map(k => ({ n: k.plane.n, ents: k.ents.map(e => e.t) })));
  check(sk1.length === 1 && sk1[0].n[2] === 1 && sk1[0].ents.includes('rect'), 'drawing on the grid creates the ground sketch automatically');
  await p.tap('#btn-undo'); await p.waitForTimeout(150);
  check(await st(() => StreamLine.S.doc.sketches.length) === 0, 'one undo removes both the rectangle and its new sketch');
  await p.tap('#btn-redo'); await p.waitForTimeout(150);
  // circle inside
  await p.evaluate(() => StreamLine.Draw.resetTool());
  await p.locator('.tool[data-tool=circle]').tap();
  await p.tap('#draw-card .field.ax-x .val'); await keypad('0');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('0');
  await p.tap('#draw-card .field .val'); await keypad('5');
  check(await st(() => StreamLine.S.doc.sketches.length === 1 && StreamLine.SK.regions(StreamLine.S.doc.sketches[0]).length === 2), 'circle joins the same ground sketch: 2 regions');
  await p.locator('.tool[data-tool=select]').tap();
  await frame([-25, -20, 0], [25, 20, 10]);

  // --- Face mode: pick the region, extrude
  await p.tap('#ws-seg [data-pick=face]');
  let c = await projW([-12, -8, 0]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.profiles.length) === 1, 'Face mode: tapping inside the outline picks the region');
  check((await ctxBar()).includes('Extrude'), 'region selected: the command bar shows Extrude / Revolve / Sweep');
  await p.locator('#actions .act', { hasText: 'Extrude' }).tap();
  await p.tap('#lastop .field .val'); await keypad('8');
  const area = 1200 - 0.5 * 64 * 25 * Math.sin(2 * Math.PI / 64);
  const v0 = await vol();
  check(Math.abs(v0 - area * 8) < 1e-6, `extruded plate is exactly area × 8 (${v0.toFixed(3)} mm³)`);
  await closeCard();
  await shot('1-extrude');

  // --- draw a circle directly on the top face (no sketch setup), extrude → auto-join
  await p.locator('.tool[data-tool=circle]').tap();
  const a = await projW([12, 6, 8]), b2 = await projW([15, 6, 8]);
  await drag([[a.x, a.y], [b2.x + 2, b2.y]]);
  const fs = await st(() => StreamLine.S.doc.sketches.map(k => ({ n: k.plane.n, z: k.plane.o[2], face: !!k.face, ents: k.ents.map(e => e.t + (e.r ? ':' + e.r : '')) })));
  check(fs.length === 2 && fs[1].face && fs[1].n[2] === 1 && Math.abs(fs[1].z - 8) < 1e-9 && fs[1].ents.some(e => e.startsWith('circle')), `pressing on the top face draws on that face (${JSON.stringify(fs[1] && fs[1].ents)})`);
  const r2 = await st(() => StreamLine.S.doc.sketches[1].ents.find(e => e.t === 'circle').r);
  await p.locator('.tool[data-tool=select]').tap();
  c = await projW([12, 6, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.profiles.length === 1 && StreamLine.S.ed.profiles[0].sk === StreamLine.S.doc.sketches[1].id), 'the circle on the face is a region you can pick');
  await p.locator('#actions .act', { hasText: 'Extrude' }).tap();
  await p.tap('#lastop .field .val'); await keypad('5');
  const mode = await st(() => StreamLine.getLast().params.mode);
  const v1 = await vol();
  check(mode === 'join' && await st(() => StreamLine.S.doc.objects.length) === 1, 'extrude from a face sketch joins the body automatically');
  check(Math.abs(v1 - v0 - 0.5 * 64 * r2 * r2 * Math.sin(2 * Math.PI / 64) * 5) < 1e-6, `boss adds exactly πr²·5 (faceted) (${(v1 - v0).toFixed(3)} mm³)`);
  await closeCard();
  await shot('2-face');

  // --- Edge mode: fillet a body edge
  await p.tap('#ws-seg [data-pick=edge]');
  c = await projW([0, -15, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.edges.length) === 1, 'Edge mode picks a body edge');
  check((await ctxBar()).includes('Fillet'), 'edge selected: Fillet / Chamfer offered');
  await p.locator('#actions .act', { hasText: 'Fillet' }).tap();
  const v2 = await vol();
  check(v2 < v1 && await st(() => !!StreamLine.getLast().handle), `fillet removes material with a live radius handle (${(v1 - v2).toFixed(3)} mm³)`);
  await closeCard();

  // --- Edge mode on a curve: curve editing commands
  await p.evaluate(() => StreamLine.S.doc.sketches.forEach(k => { k.hidden = false; }));
  // draw a free line on the grid in front of the body, then pick it in Edge mode
  await p.locator('.tool[data-tool=line]').tap();
  await p.tap('#draw-card .field.ax-x .val'); await keypad('-20');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('-30');
  await p.tap('#draw-card .field .val'); await keypad('40');
  await p.locator('#draw-card .btn', { hasText: 'Finish' }).tap();
  await p.locator('.tool[data-tool=select]').tap();
  c = await projW([0, -30, 0]);
  await tapV(c.x, c.y);
  const curveSel = await st(() => StreamLine.S.ed.drawSel.size);
  check(curveSel === 1 && (await ctxBar()).includes('Offset'), 'Edge mode on a sketch curve selects it; Move / Offset / Constrain offered');

  // --- Solid mode
  await p.tap('#ws-seg [data-pick=solid]');
  c = await projW([-10, 8, 4]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.selected.size) === 1 && (await ctxBar()).includes('Boolean'), 'Solid mode selects the body; Boolean / Mirror / Shell offered');
  await shot('3-solid');

  // --- optional AutoCAD command line, from the palette
  await p.tap('#btn-cmd'); await p.fill('.pal-in', 'autocad'); await p.press('.pal-in', 'Enter'); await p.waitForTimeout(200);
  check(await p.locator('#cmdbar').isVisible(), 'AutoCAD command line can be switched on from the palette');
  const run = async cmd => { await p.fill('#cmdin', cmd); await p.press('#cmdin', 'Enter'); await p.waitForTimeout(150); };
  await run('C'); await run('60,0'); await run('4');
  check(await st(() => StreamLine.S.doc.sketches.some(k => k.ents.some(e => e.t === 'circle' && e.c[0] === 60 && e.r === 4))), 'typed C 60,0 4 draws an exact circle in the studio');
  await run('DI'); await run('0,0'); await run('3,4');
  check(/Distance = 5\.00/.test(await p.textContent('#cmdlog')), 'DIST works from the command line');

  // --- undo the fillet etc.
  for (let i = 0; i < 3; i++) await p.tap('#btn-undo'); // the typed circle, the free line, then the fillet
  await p.waitForTimeout(200);
  check(Math.abs(await vol() - v1) < 1e-9, 'undo returns to the state before the fillet exactly');
  await shot('4-final');
} catch (e) {
  await p.screenshot({ path: OUT + 'crash.png' }).catch(() => {});
  check(false, 'test crashed: ' + e.message.split('\n').slice(0, 8).join(' / '));
}
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); srv.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);

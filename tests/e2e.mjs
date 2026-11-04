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
p.on('pageerror', e => { errors.push(e.message); console.log('PAGEERR', e.stack); });
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(`http://localhost:${PORT}/`);
await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('#boot', { state: 'detached', timeout: 60000 }); await p.waitForTimeout(400);
const cdp = await ctx.newCDPSession(p);
const top = await p.evaluate(() => document.querySelector('#gl').getBoundingClientRect().top);
const st = (fn, arg) => p.evaluate(fn, arg);
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
const vol = () => st(() => { const o = StreamLine.S.doc.objects[0]; return o ? (o.shape ? StreamLine.K.volume(o.shape) : StreamLine.K.volume(o.shape)) : 0; });
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
  await p.locator('#actions .act', { hasText: 'Extrude' }).tap(); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.doc.objects.length === 0 && StreamLine.getLast().params.distance === 0 && !!StreamLine.getLast().handle && !StreamLine.H.hist().some(r => r.op === 'F.extrude')),
    'Extrude starts at 0: no body and no timeline step until a distance is given, arrow shown');
  check(await p.locator('#layerpill').isVisible() && /Default/.test(await p.textContent('#layerpill')), 'the active layer is always shown in the view');
  await p.tap('#lastop .field .val'); await keypad('8');
  check(await st(() => StreamLine.H.hist().filter(r => r.op === 'F.extrude').length === 1), 'typing the distance builds the body and records one Extrude step');
  const area = 1200 - Math.PI * 25; // exact: the hole is a true cylinder
  const v0 = await vol();
  check(Math.abs(v0 - area * 8) < 1e-6, `extruded plate is exactly (1200 − 25π) × 8 (${v0.toFixed(6)} mm³)`);
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
  check(Math.abs(v1 - v0 - Math.PI * r2 * r2 * 5) < 1e-6, `boss adds exactly πr²·5 — a true cylinder (${(v1 - v0).toFixed(6)} mm³)`);
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

  // --- drawing modes: rectangle (2 corners / centre / 3 points), circle (centre / 2 points / 3 points), arc (3 points)
  const drawWith = (t, m, pts) => st(([t, m, pts]) => { const L = StreamLine; L.S.ed.tool = t; L.Draw.setDrawMode(t, m); for (const q of pts) L.Draw.commitPoint(q); const sk = L.S.doc.sketches.find(k => k.id === L.S.ed.sketch); return sk.ents.slice(-4); }, [t, m, pts]);
  let e4 = await drawWith('rect', 'center', [[100, 100], [105, 103]]);
  check(e4.at(-1).t === 'rect' && e4.at(-1).x === 95 && e4.at(-1).y === 97 && e4.at(-1).w === 10 && e4.at(-1).h === 6, 'Rectangle · centre + corner');
  e4 = await drawWith('rect', '3pt', [[200, 0], [210, 10], [200, 20]]);
  check(e4.every(e => e.t === 'line') && Math.abs(Math.hypot(e4[1].b[0] - e4[1].a[0], e4[1].b[1] - e4[1].a[1]) - Math.SQRT2 * 10) < 1e-9, 'Rectangle · three points makes a rotated rectangle (4 lines)');
  e4 = await drawWith('circle', '2pt', [[120, 0], [130, 0]]);
  check(e4.at(-1).t === 'circle' && e4.at(-1).c[0] === 125 && e4.at(-1).r === 5, 'Circle · two points (diameter)');
  e4 = await drawWith('circle', '3pt', [[310, 0], [300, 10], [290, 0]]);
  check(e4.at(-1).t === 'circle' && Math.abs(e4.at(-1).c[0] - 300) < 1e-9 && Math.abs(e4.at(-1).r - 10) < 1e-9, 'Circle · three points');
  e4 = await drawWith('arc', '3pt', [[410, 0], [390, 0], [400, 10]]);
  check(e4.at(-1).t === 'arc' && Math.abs(e4.at(-1).r - 10) < 1e-9 && Math.abs(e4.at(-1).a1 - e4.at(-1).a0 - Math.PI) < 1e-9, 'Arc · start, end, through');
  await st(() => { StreamLine.Draw.setDrawMode('rect', 'corner'); StreamLine.Draw.setDrawMode('circle', 'center'); StreamLine.Draw.setDrawMode('arc', 'center'); StreamLine.S.ed.tool = 'select'; });

  // --- parametric timeline: every step recorded; editing a sketch rebuilds later features
  const tl = await st(() => StreamLine.H.hist().map(r => r.kind === 'sketch' ? 'sketch' : r.op));
  check(tl[0] === 'sketch' && tl.includes('F.extrude'), `timeline records sketches and features in order (${tl.join(' → ')})`);
  await p.tap('#btn-history'); await p.waitForTimeout(450);
  check(await p.locator('#sheet.open').count() === 1 && await p.locator('#sheet-body .hcard').count() >= 2 && await p.locator('#sheet-body .hcard .skchip').count() >= 1 && /mm/.test(await p.textContent('#sheet-body .hlist')), 'History slides in from the right: one card per feature with its sketch chip and values');
  await p.tap('#btn-history'); await p.waitForTimeout(450);
  check(await p.locator('#sheet.open').count() === 0, 'tapping History again slides it away');
  // fresh part: rectangle 40×20 extruded 10, then grow the rectangle → the body follows
  await st(() => { StreamLine.S.doc.objects.forEach(o => (o.hidden = true)); });
  await st(() => StreamLine.addSketchedPrim('cube'));
  const box = await st(() => { const o = StreamLine.S.doc.objects.at(-1); return { id: o.id, v: StreamLine.K.volume(o.shape) }; });
  check(Math.abs(box.v - 20 * 20 * 20) < 1e-6, `Add Cube builds a sketch + Extrude (${box.v.toFixed(3)} mm³)`);
  const hcount = await st(() => StreamLine.H.hist().length);
  await st(() => { const sk = StreamLine.S.doc.sketches.at(-1); StreamLine.runOp(StreamLine.F.sketchOp('Widen', sk.id, k => { const r = k.ents.find(e => e.t === 'rect'); r.w = 40; })); });
  const boxV2 = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), box.id);
  check(Math.abs(boxV2 - 40 * 20 * 20) < 1e-6, `editing the sketch rebuilds the extrude after it (${boxV2.toFixed(3)} mm³)`);
  check(await st(() => StreamLine.H.hist().length) === hcount, 'a sketch edit is not a new timeline step');
  // edit the extrude's parameters from the timeline
  await st(() => { const r = StreamLine.H.hist().findLast(x => x.op === 'F.extrude'); StreamLine.BR.editStep(r.id); });
  await p.waitForTimeout(250);
  check(await p.locator('#lastop').isVisible() && /Edit/.test(await p.textContent('#lastop')), 'Edit parameters opens the step in the floating dialog');
  await p.evaluate(async () => { const m = await import('./js/ops.js'); m.updateOp({ distance: 5 }); });
  const boxV3 = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), box.id);
  check(Math.abs(boxV3 - 40 * 20 * 5) < 1e-6, `editing the Extrude step from the timeline rebuilds it (${boxV3.toFixed(3)} mm³)`);
  // rollback marker
  const nObj = await st(() => StreamLine.S.doc.objects.length);
  await st(() => { const i = StreamLine.H.hist().findLastIndex(x => x.op === 'F.extrude'); StreamLine.BR.rollTo(i); });
  check(await st(() => StreamLine.S.doc.objects.length) === nObj - 1, 'rolling the marker back before the extrude removes its body');
  await p.waitForTimeout(200);
  check(await p.locator('#btn-history.b-rb').count() === 1, 'the History button shows a rolled-back badge');
  await p.tap('#btn-history'); await p.waitForTimeout(450);
  check(await p.locator('#sheet-body .hmarker:not(.end)').count() === 1 && await p.locator('#sheet-body .hcard.dim').count() >= 1, 'History shows the rollback marker and greys the steps after it');
  await p.tap('#btn-history'); await p.waitForTimeout(400);
  await st(() => StreamLine.BR.rollTo(1e9));
  check(await st(id => !!StreamLine.S.doc.objects.find(o => o.id === id), box.id), 'rolling to the end brings it back');
  // suppress / failure display
  await st(() => { const r = StreamLine.H.hist().findLast(x => x.op === 'F.extrude'); StreamLine.BR.toggleStep(r.id); });
  check(await st(id => !StreamLine.S.doc.objects.find(o => o.id === id), box.id), 'suppressing a step removes its result');
  await st(() => { const r = StreamLine.H.hist().findLast(x => x.op === 'F.extrude'); StreamLine.BR.toggleStep(r.id); });
  // layers + visibility
  await p.tap('#layerpill'); await p.waitForTimeout(250);
  check(await p.locator('#sheet.open').count() === 1 && await p.locator('#sheet-tabs [data-tab=objects].on').count() === 1, 'the layer pill opens the Layers panel');
  check(await p.locator('#sheet-body h3', { hasText: 'Layers' }).count() === 1 && await p.locator('#sheet-body h3', { hasText: 'Bodies' }).count() === 1, 'Items shows Layers, Sketches and Bodies');
  await st(() => StreamLine.runOp({ label: () => 'Add layer', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.layers.push({ id: 2, name: 'Parts', visible: true }); StreamLine.S.doc.layer = 2; } }));
  await st(id => StreamLine.runOp({ label: () => 'mv', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.objects.find(o => o.id === id).layer = 2; } }), box.id);
  await st(() => StreamLine.runOp({ label: () => 'hide', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.layers.find(l => l.id === 2).visible = false; } }));
  check(await st(id => !StreamLine.isShown(StreamLine.S.doc.objects.find(o => o.id === id)), box.id), 'hiding a layer hides the bodies on it');
  await st(() => { const sk = StreamLine.S.doc.sketches.at(-1); sk.hidden = false; StreamLine.runOp(StreamLine.F.sketchOp('Widen', sk.id, k => { k.ents.find(e => e.t === 'rect').w = 30; })); });
  check(await st(id => StreamLine.S.doc.objects.find(o => o.id === id).layer === 2, box.id), 'layer and visibility survive a rebuild');
  await p.tap('#sheet-body button.btn.wide'); await p.waitForTimeout(250);
  await p.fill('.askform input', 'Fixtures'); await p.press('.askform input', 'Enter'); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.doc.layers.some(l => l.name === 'Fixtures' ) && StreamLine.S.doc.layers.find(l => l.id === StreamLine.S.doc.layer).name === 'Fixtures'), 'New layer uses an in-app name field and becomes active');
  await st(() => { const L = StreamLine.S.doc; L.layer = 1; });
  check(await p.locator('#sheet-body .objrow.act').count() === 0 && await p.locator('#sheet-body .objrow.cur').count() >= 1, 'Browser rows use their own "current" style (no clash with the command bar)');
  await tapV(24, 300);
  check(!(await p.locator('#sheet.open').count()), 'tapping the viewport closes the Browser sheet on a phone');
  // Plasticity-style hole: on a face, pushing the extrude into the body cuts automatically
  await st(() => StreamLine.addSketchedPrim('cube'));
  const cube = await st(() => { const o = StreamLine.S.doc.objects.at(-1); return { id: o.id, v: StreamLine.K.volume(o.shape) }; });
  await st(id => { const L = StreamLine; L.runOp(L.F.sketchOpNew('Hole', { o: [0, 0, 20], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, { obj: id }, k => { L.F.addEntity(k, { t: 'circle', c: [0, 0], r: 3 }); })); }, cube.id);
  await st(() => { const L = StreamLine; L.runOp(L.F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [0, 0] }], distance: -5 }); });
  const holeV = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), cube.id);
  check(holeV < cube.v - 100 && await st(() => StreamLine.getLast().params.mode) === 'cut', `negative extrude from a face sketch cuts a hole (${(cube.v - holeV).toFixed(2)} mm³ removed)`);
  // the hole's face sketch follows the top face when the cube's extrude is made taller
  const removed = cube.v - holeV;
  await st(id => { const L = StreamLine; const r = L.H.hist().filter(x => x.op === 'F.extrude').at(-2); L.BR.editStep(r.id); }, cube.id);
  await p.evaluate(async () => { const m = await import('./js/ops.js'); m.updateOp({ distance: 30 }); m.commit(); });
  const tall = await st(id => ({ v: StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), z: StreamLine.S.doc.sketches.at(-1).plane.o[2], err: StreamLine.H.hist().some(r => r.err) }), cube.id);
  check(tall.z === 30 && Math.abs(tall.v - (20 * 20 * 30 - removed)) < 1e-6 && !tall.err, `a sketch on a face follows the face when an earlier step moves it (z=${tall.z}, ${tall.v.toFixed(2)} mm³)`);
  // a fillet on the cube's top edge survives making the cube taller (its edge is re-found)
  await st(id => { const L = StreamLine; L.S.ed.edges = [{ obj: id, a: [-10, -10, 30], b: [10, -10, 30] }]; L.runOp(L.F.edgeBlendOp, { kind: 'fillet', size: 2 }); }, cube.id);
  const vF = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), cube.id);
  await st(() => { const L = StreamLine; const r = L.H.hist().filter(x => x.op === 'F.extrude').at(-2); L.BR.editStep(r.id); });
  await p.evaluate(async () => { const m = await import('./js/ops.js'); m.updateOp({ distance: 35 }); m.commit(); });
  const vF2 = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), cube.id);
  check(!(await st(() => StreamLine.H.hist().some(r => r.err))) && Math.abs(vF2 - vF - 20 * 20 * 5) < 1e-6, `a fillet follows its edge when an earlier extrude grows (+${(vF2 - vF).toFixed(3)} mm³)`);
  // moving the sketch sideways moves the filleted edge too; the fillet follows
  const cubeSk = await st(() => StreamLine.H.hist().filter(r => r.kind === 'sketch').at(-2).sk);
  await st(id => { const L = StreamLine; L.runOp(L.F.sketchOp('Shift', id, k => { const r = k.ents.find(e => e.t === 'rect'); r.y -= 5; r.h += 2; })); }, cubeSk);
  const vF3 = await st(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), cube.id);
  check(!(await st(() => StreamLine.H.hist().some(r => r.err))) && Math.abs(vF3 - vF2 - 20 * 2 * 35) < 1e-6, `a fillet follows its edge when the sketch moves it sideways (+${(vF3 - vF2).toFixed(3)} mm³)`);
  // edit a sketch from the timeline: editing mode with a Finish command
  await p.tap('#ws-seg [data-pick=edge]'); await p.waitForTimeout(150); // already in Edge mode: the bar must still switch
  await st(() => { const r = StreamLine.H.hist().find(x => x.kind === 'sketch'); StreamLine.BR.editStep(r.id); });
  await p.waitForTimeout(250);
  check(/Editing/.test(await p.textContent('#hud')) && (await ctxBar()).includes('Finish'), 'Edit sketch: HUD says Editing, Finish offered');
  check(await st(() => StreamLine.view.xrayFor === true), 'bodies are ghosted while a sketch is edited');
  await p.tap('#actions .act.primary'); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.ed.editingSketch) == null, 'Finish leaves sketch editing');
  // tapping a History card edits that step, and the panel steps aside on a phone
  await p.tap('#btn-history'); await p.waitForTimeout(450);
  await p.locator('#sheet-body .hcard').filter({ hasText: 'Extrude' }).first().tap(); await p.waitForTimeout(400);
  check(await p.locator('#sheet.open').count() === 0 && /Edit/.test(await p.textContent('#lastop')), 'tapping a History card opens its parameters and closes the panel');
  await closeCard();
  // delete asks first and names what depends on it
  await p.tap('#btn-history'); await p.waitForTimeout(450);
  await p.locator('#sheet-body .hcard .more').first().tap(); await p.waitForTimeout(250);
  await p.locator('.popover .mi', { hasText: 'Delete' }).tap(); await p.waitForTimeout(250);
  check(/Delete/.test(await p.textContent('.popover')) && /undo/i.test(await p.textContent('.popover')), 'Delete step asks for confirmation and explains the effect');
  await p.locator('.popover .btn', { hasText: 'Cancel' }).tap(); await p.waitForTimeout(200);
  await p.evaluate(() => document.querySelector('#sheet-close').click()); await p.waitForTimeout(300);
  // a fillet bigger than the faces it rolls on is refused instead of producing broken geometry
  const fBig = await st(() => { const L = StreamLine; L.addSketchedPrim('cube'); const id = L.S.doc.objects.at(-1).id; L.S.ed.edges = [{ obj: id, a: [-10, -10, 20], b: [10, -10, 20] }]; const ok = L.runOp(L.F.edgeBlendOp, { kind: 'fillet', size: 80 }); const ok2 = L.runOp(L.F.edgeBlendOp, { kind: 'fillet', size: 2, edges: [{ obj: id, a: [-10, -10, 20], b: [10, -10, 20] }] }); return [ok, ok2]; });
  check(fBig[0] === false && fBig[1] === true, 'an oversized fillet radius is refused (a fitting one still works)');
  // Dim on a rectangle side dimensions that side
  const dimOk = await st(() => { const L = StreamLine; L.runOp(L.F.sketchOpNew('r', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { L.F.addEntity(k, { t: 'rect', x: 500, y: 0, w: 30, h: 10 }); })); const sk = L.S.doc.sketches.at(-1); L.view.cam.ortho = true; L.view.lookAlong([0, 0, 1], [515, 5, 0], 80); return sk.id; });
  await p.waitForTimeout(700);
  const dimOk2 = await st(() => { const L = StreamLine; const sk = L.S.doc.sketches.at(-1); L.S.ed.tool = 'dim'; const q = L.view.project(L.SK.toW(sk.plane, [515, 0])); L.Draw.tap(q.x, q.y); const d = L.S.doc.sketches.find(k => k.id === sk.id).ents.find(e => e.t === 'dim'); L.Draw.resetTool && 0; L.S.ed.tool = 'select'; return d ? d.kind === 'hor' && d.value === 30 : JSON.stringify([L.S.ed.sketch, sk.id, q, L.SK.pickEntity(sk, [515, 0], 1)?.t, document.querySelector('#toast').textContent, L.Draw.st.dimA, L.Draw.st.dimLine]); });
  if (dimOk2 !== true) console.log('DBG dim', dimOk2);
  check(dimOk2 === true, 'Dim: tapping a rectangle side dimensions its width');
  await shot('5-timeline');
} catch (e) {
  await p.screenshot({ path: OUT + 'crash.png' }).catch(() => {});
  check(false, 'test crashed: ' + e.message.split('\n').slice(0, 8).join(' / '));
}
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); srv.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);

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
  // --- part mode: tool sets along the bottom, their tools down the left rail, no pick-mode switch; no drawing tools
  check(await st(() => StreamLine.S.ed.workspace) === 'model' && await p.locator('#ws-seg').count() === 0 && await p.locator('#toolsets .tset').count() === 5, 'opens in the single 3D studio: the part tool sets along the bottom, no Edge / Face / Solid switch');
  check((await ctxBar()).length === 0 && await p.locator('#tools .tool[data-id=newsketch]').isVisible() && await p.locator('#tools .tool[data-tool=line]').count() === 0 && await p.locator('#toolsets .tset[data-set=constrain]').count() === 0, 'part mode: Sketch, Extrude … down the rail; no Line or constraint tools outside a sketch');

  // --- command palette: "rect" outside a sketch asks for its plane first (Create Sketch)
  await p.tap('#btn-cmd'); await p.fill('.pal-in', 'rect'); await p.press('.pal-in', 'Enter'); await p.waitForTimeout(250);
  check(await st(() => !!StreamLine.S.ed.planePick && StreamLine.S.ed.editingSketch == null) && (await ctxBar()).join() === 'XY · Top,XZ · Front,YZ · Right,Cancel' && await p.locator('.vlabel.plane:visible').count() === 3 && /Create Sketch/.test(await p.textContent('#hud')),
    'palette "rect" ⏎ outside a sketch: Create Sketch shows the named origin planes and waits for one');
  const xyLab = await p.evaluate(() => { const e = [...document.querySelectorAll('.vlabel.plane')].find(x => x.textContent === 'XY' && x.style.display !== 'none'), r = e.getBoundingClientRect(), g = document.querySelector('#gl').getBoundingClientRect(); return { x: r.left + r.width / 2 - g.left, y: r.top + r.height / 2 - g.top }; });
  await tapV(xyLab.x, xyLab.y); await p.waitForTimeout(500);
  check(await st(() => StreamLine.S.ed.editingSketch != null && StreamLine.S.ed.tool === 'rect' && StreamLine.S.doc.sketches.length === 1 && StreamLine.S.doc.sketches[0].plane.n[2] === 1) && await p.locator('#skbar').isVisible() && !(await p.locator('#timeline').isVisible()) && /Top \(XY\)/.test(await p.textContent('#skbar')),
    'tapping the XY plane opens Sketch 1 on it with the Rectangle tool; the sketch bar with Finish Sketch takes the timeline\'s place');
  check(await p.locator('#toolsets .tset').count() === 4 && await p.locator('#tools .tool[data-tool=line]').isVisible() && await p.locator('#tools .tool[data-id=extrude]').count() === 0, 'sketch mode: Create / Modify / Constrain / Inspect tool sets, the drawing tools on the rail');
  await p.tap('#toolsets .tset[data-set=constrain]'); await p.waitForTimeout(150);
  check(await p.locator('#tools .tool[data-cons=h]').isVisible() && await p.locator('#tools .tool[data-cons=tan]').count() === 1, 'the Constrain tool set lists the constraints down the left rail');
  await p.tap('#toolsets .tset[data-set=create]'); await p.waitForTimeout(150);

  // --- rectangle by typed values, in the open sketch
  await p.tap('#draw-card .field.ax-x .val'); await keypad('-20');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('-15');
  await p.tap('#draw-card .field.ax-x .val'); await keypad('40');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('30');
  const sk1 = await st(() => StreamLine.S.doc.sketches.map(k => ({ n: k.plane.n, ents: k.ents.map(e => e.t) })));
  check(sk1.length === 1 && sk1[0].n[2] === 1 && sk1[0].ents.includes('rect'), 'the typed rectangle goes into the open sketch');
  await p.tap('#btn-undo'); await p.waitForTimeout(150);
  check(await st(() => StreamLine.S.doc.sketches.length === 1 && !StreamLine.S.doc.sketches[0].ents.length && StreamLine.sketching()), 'undo takes the rectangle back; the sketch stays open');
  await p.tap('#btn-redo'); await p.waitForTimeout(150);
  // circle inside
  await p.evaluate(() => StreamLine.Draw.resetTool());
  await p.locator('.tool[data-tool=circle]').tap();
  await p.tap('#draw-card .field.ax-x .val'); await keypad('0');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('0');
  await p.tap('#draw-card .field .val'); await keypad('5');
  check(await st(() => StreamLine.S.doc.sketches.length === 1 && StreamLine.SK.regions(StreamLine.S.doc.sketches[0]).length === 2), 'circle joins the same sketch: 2 profiles');
  await p.locator('.tool[data-tool=select]').tap();
  await shot('0-sketch');

  // --- Finish Sketch: back to the part; pick the region (a tap inside the outline), extrude
  await p.tap('#btn-finish'); await p.waitForTimeout(600);
  check(await st(() => StreamLine.S.ed.editingSketch == null) && await p.locator('#timeline').isVisible() && !(await p.locator('#skbar').isVisible()) && await p.locator('#tools .tool[data-tool=line]').count() === 0 && await p.locator('#tools .tool[data-id=extrude]').isVisible(),
    'Finish Sketch: back to the part tools and the timeline');
  await frame([-25, -20, 0], [25, 20, 10]);
  let c = await projW([-12, -8, 0]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.profiles.length) === 1, 'tapping inside the outline picks the profile');
  check((await ctxBar()).includes('Extrude'), 'profile selected: the command bar shows Extrude / Revolve / Sweep');
  await p.locator('#actions .act', { hasText: 'Extrude' }).tap(); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.doc.objects.length === 0 && StreamLine.getLast().params.distance === 0 && !!StreamLine.getLast().handle && !StreamLine.H.hist().some(r => r.op === 'F.extrude')),
    'Extrude starts at 0: no body and no timeline step until a distance is given, arrow shown');
  check(await p.locator('#timeline').isVisible() && (await p.locator('#timeline').boundingBox()).y < 140 && await p.locator('#timeline .tl-ctl').count() === 4, 'the history timeline is always shown along the top, with playback buttons');
  await p.tap('#lastop .field .val'); await keypad('8');
  check(await st(() => StreamLine.H.hist().filter(r => r.op === 'F.extrude').length === 1), 'typing the distance builds the body and records one Extrude step');
  const area = 1200 - Math.PI * 25; // exact: the hole is a true cylinder
  const v0 = await vol();
  check(Math.abs(v0 - area * 8) < 1e-6, `extruded plate is exactly (1200 − 25π) × 8 (${v0.toFixed(6)} mm³)`);
  await closeCard();
  await shot('1-extrude');

  // --- Create Sketch on the body's top face, a circle in it, Finish, extrude → auto-join
  await p.tap('#tools .tool[data-id=newsketch]'); await p.waitForTimeout(250);
  c = await projW([12, 6, 8]); await tapV(c.x, c.y); await p.waitForTimeout(600);
  const fs0 = await st(() => { const L = StreamLine, k = L.S.doc.sketches.at(-1); return { open: L.S.ed.editingSketch === k.id, n: L.S.doc.sketches.length, face: !!k.face, z: k.plane.o[2], nz: k.plane.n[2] }; });
  check(fs0.open && fs0.n === 2 && fs0.face && fs0.nz === 1 && Math.abs(fs0.z - 8) < 1e-9, `Create Sketch, then a tap on the top face: a sketch opens on that face (${JSON.stringify(fs0)})`);
  await p.locator('.tool[data-tool=circle]').tap(); await p.waitForTimeout(300); // the view settles below the draw card
  const a = await projW([12, 6, 8]), b2 = await projW([15, 6, 8]);
  await drag([[a.x, a.y], [b2.x + 2, b2.y]]);
  const fs = await st(() => StreamLine.S.doc.sketches.map(k => ({ n: k.plane.n, z: k.plane.o[2], face: !!k.face, ents: k.ents.map(e => e.t + (e.r ? ':' + e.r : '')) })));
  check(fs.length === 2 && fs[1].face && fs[1].ents.some(e => e.startsWith('circle')), `dragging out a circle draws it in the face sketch (${JSON.stringify(fs[1] && fs[1].ents)})`);
  const r2 = await st(() => StreamLine.S.doc.sketches[1].ents.find(e => e.t === 'circle' && !e.proj).r); // (the hole's rim comes in projected)
  await p.locator('.tool[data-tool=select]').tap(); await p.waitForTimeout(200);
  await p.tap('#btn-finish'); await p.waitForTimeout(600);
  c = await projW([12, 6, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.profiles.length === 1 && StreamLine.S.ed.profiles[0].sk === StreamLine.S.doc.sketches[1].id), 'after Finish Sketch the circle on the face is a profile you can pick');
  await p.locator('#actions .act', { hasText: 'Extrude' }).tap();
  await p.tap('#lastop .field .val'); await keypad('5');
  const mode = await st(() => StreamLine.getLast().params.mode);
  const v1 = await vol();
  check(mode === 'join' && await st(() => StreamLine.S.doc.objects.length) === 1, 'extrude from a face sketch joins the body automatically');
  check(Math.abs(v1 - v0 - Math.PI * r2 * r2 * 5) < 1e-6, `boss adds exactly πr²·5 — a true cylinder (${(v1 - v0).toFixed(6)} mm³)`);
  await closeCard();
  await shot('2-face');

  // --- a tap on an edge picks it: fillet it
  c = await projW([0, -15, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.edges.length) === 1, 'a tap on a body edge picks the edge');
  check((await ctxBar()).includes('Fillet'), 'edge selected: Fillet / Chamfer offered');
  await p.locator('#actions .act', { hasText: 'Fillet' }).tap();
  const v2 = await vol();
  check(v2 < v1 && await st(() => !!StreamLine.getLast().handle), `fillet removes material with a live radius handle (${(v1 - v2).toFixed(3)} mm³)`);
  await closeCard();

  // --- a curve in a sketch: curve editing commands
  await p.evaluate(() => StreamLine.S.doc.sketches.forEach(k => { k.hidden = false; }));
  // a new sketch on XY (from Create Sketch's plane buttons), a free line in front of the body, then pick it
  await p.tap('#tools .tool[data-id=newsketch]'); await p.waitForTimeout(250);
  await p.locator('#actions .act', { hasText: 'XY · Top' }).tap(); await p.waitForTimeout(500);
  check(await st(() => StreamLine.sketching() && StreamLine.S.doc.sketches.at(-1).plane.n[2] === 1 && !StreamLine.S.doc.sketches.at(-1).face), 'Create Sketch → the XY · Top button opens a sketch on XY');
  await p.locator('.tool[data-tool=line]').tap();
  await p.tap('#draw-card .field.ax-x .val'); await keypad('-20');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('-30');
  await p.tap('#draw-card .field .val'); await keypad('40');
  await p.locator('#draw-card .btn', { hasText: 'Finish' }).tap();
  await p.locator('.tool[data-tool=select]').tap(); await p.waitForTimeout(350); // (the view settles once the draw card closes)
  await frame([-25, -40, 0], [25, -20, 0]); // (the line sits low, under the view tools, in the sketch's opening view)
  c = await projW([0, -30, 0]);
  await tapV(c.x, c.y);
  const curveSel = await st(() => StreamLine.S.ed.drawSel.size);
  check(curveSel === 1 && (await ctxBar()).includes('Offset'), 'a tap on a sketch curve selects it; Move / Offset / Constrain offered');

  // --- a face, then the same spot again: the whole body (after Finish Sketch)
  await p.evaluate(() => { StreamLine.S.ed.drawSel = new Set(); StreamLine.refresh(); }); await p.waitForTimeout(150);
  await p.tap('#btn-finish'); await p.waitForTimeout(600);
  await frame([-25, -20, 0], [25, 20, 10]);
  c = await projW([0, -30, 0]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.drawSel.size === 1 && !StreamLine.sketching()) && (await ctxBar()).join() === 'Edit sketch,Chain', `outside the sketch a picked curve offers Edit sketch (no curve editing): ${(await ctxBar()).join()}`);
  check(await st(() => StreamLine.Draw.down(...Object.values(StreamLine.view.project(StreamLine.SK.toW(StreamLine.S.doc.sketches.at(-1).plane, [20, -30]))).slice(0, 2)) === false), 'outside the sketch its curve points cannot be dragged');
  await p.evaluate(() => { StreamLine.S.ed.drawSel = new Set(); StreamLine.refresh(); }); await p.waitForTimeout(300);
  c = await projW([-10, 8, 8]); await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.faces.length === 1 && StreamLine.S.ed.pick === 'face'), 'a tap on a face picks the face');
  await tapV(c.x, c.y);
  check(await st(() => StreamLine.S.ed.selected.size === 1 && StreamLine.S.ed.pick === 'solid' && !StreamLine.S.ed.faces.length) && (await ctxBar()).includes('Boolean'), 'tapping the face again selects the whole body; Boolean / Mirror / Shell offered');
  await shot('3-solid');

  // --- optional AutoCAD command line, from the palette
  await p.tap('#btn-cmd'); await p.fill('.pal-in', 'autocad'); await p.press('.pal-in', 'Enter'); await p.waitForTimeout(200);
  check(await p.locator('#cmdbar').isVisible(), 'AutoCAD command line can be switched on from the palette');
  const run = async cmd => { await p.fill('#cmdin', cmd); await p.press('#cmdin', 'Enter'); await p.waitForTimeout(150); };
  await run('C'); await run('60,0'); await run('4');
  check(await st(() => StreamLine.S.doc.sketches.some(k => k.ents.some(e => e.t === 'circle' && e.c[0] === 60 && e.r === 4))), 'typed C 60,0 4 draws an exact circle in the studio');
  await run('DI'); await run('0,0'); await run('3,4');
  check(/Distance = 5\.00/.test(await p.textContent('#cmdlog')), 'DIST works from the command line');

  check(await st(() => StreamLine.sketching()) && await p.locator('#skbar').isVisible(), 'a drawing command typed outside a sketch opens one on the construction plane');
  await p.tap('#btn-finish'); await p.waitForTimeout(400);
  // --- undo the fillet etc.
  for (let i = 0; i < 5; i++) await p.tap('#btn-undo'); // the typed circle and its sketch, the free line and its sketch, then the fillet
  await p.waitForTimeout(200);
  check(Math.abs(await vol() - v1) < 1e-9, 'undo returns to the state before the fillet exactly');
  await shot('4-final');

  // --- drawing modes: rectangle (2 corners / centre / 3 points), circle (centre / 2 points / 3 points), arc (3 points)
  await st(() => StreamLine.sketchOn({ plane: 'XY' }));
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
  await st(() => { StreamLine.Draw.setDrawMode('rect', 'corner'); StreamLine.Draw.setDrawMode('circle', 'center'); StreamLine.Draw.setDrawMode('arc', 'center'); StreamLine.S.ed.tool = 'select'; StreamLine.finishSketchEdit(); });

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
  await p.tap('#btn-browser'); await p.waitForTimeout(450);
  check(await p.locator('#browser.open').count() === 1, 'the Browser button opens the Browser from the bottom bar');
  check(await p.locator('#browser-body .trow.folder', { hasText: 'Origin' }).count() === 1 && await p.locator('#browser-body .trow.folder', { hasText: 'Bodies' }).count() === 1 && await p.locator('#browser-body .trow.folder', { hasText: 'Sketches' }).count() === 1 && await p.locator('#browser-body .trow.folder', { hasText: 'Layers' }).count() === 1, 'the Browser is a Fusion-style tree: Origin, Bodies, Sketches, Layers');
  await st(() => StreamLine.runOp({ label: () => 'Add layer', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.layers.push({ id: 2, name: 'Parts', visible: true }); StreamLine.S.doc.layer = 2; } }));
  await st(id => StreamLine.runOp({ label: () => 'mv', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.objects.find(o => o.id === id).layer = 2; } }), box.id);
  await st(() => StreamLine.runOp({ label: () => 'hide', presentation: true, touch: () => 'all', apply() { StreamLine.S.doc.layers.find(l => l.id === 2).visible = false; } }));
  check(await st(id => !StreamLine.isShown(StreamLine.S.doc.objects.find(o => o.id === id)), box.id), 'hiding a layer hides the bodies on it');
  await st(() => { const sk = StreamLine.S.doc.sketches.at(-1); sk.hidden = false; StreamLine.runOp(StreamLine.F.sketchOp('Widen', sk.id, k => { k.ents.find(e => e.t === 'rect').w = 30; })); });
  check(await st(id => StreamLine.S.doc.objects.find(o => o.id === id).layer === 2, box.id), 'layer and visibility survive a rebuild');
  await p.locator('#browser-body .trow.folder', { hasText: 'Layers' }).tap(); await p.waitForTimeout(200);
  await p.locator('#browser-body .trow', { hasText: 'New layer' }).tap(); await p.waitForTimeout(250);
  await p.fill('.askform input', 'Fixtures'); await p.press('.askform input', 'Enter'); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.doc.layers.some(l => l.name === 'Fixtures' ) && StreamLine.S.doc.layers.find(l => l.id === StreamLine.S.doc.layer).name === 'Fixtures'), 'New layer uses an in-app name field and becomes active');
  await st(() => { const L = StreamLine.S.doc; L.layer = 1; StreamLine.refresh(); });
  await p.waitForTimeout(200);
  check(await p.locator('#browser-body .trow.sel', { hasText: 'Default' }).count() === 1, 'the active layer is marked in the Browser');
  await p.tap('#btn-browser'); await p.waitForTimeout(450);
  check(!(await p.locator('#browser.open').count()), 'the Browser button closes it again');
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
  await st(() => { const r = StreamLine.H.hist().find(x => x.kind === 'sketch'); StreamLine.BR.editStep(r.id); });
  await p.waitForTimeout(250);
  check(await st(() => StreamLine.sketching()) && await p.locator('#skbar #btn-finish').isVisible() && /curve/.test(await p.textContent('#hud')), 'Edit sketch from the timeline opens it in sketch mode, Finish Sketch offered');
  check(await st(() => StreamLine.view.xrayFor === true), 'bodies are ghosted while a sketch is edited');
  await p.tap('#btn-finish'); await p.waitForTimeout(200);
  check(await st(() => StreamLine.S.ed.editingSketch) == null, 'Finish Sketch leaves sketch editing');
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
  // Push/Pull and Shell follow their faces when an earlier extrude changes
  const ppOk = await st(async () => {
    const L = StreamLine;
    L.runOp(L.F.sketchOpNew('pp', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { L.F.addEntity(k, { t: 'rect', x: 700, y: 0, w: 40, h: 30 }); }));
    L.runOp(L.F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [710, 10] }], distance: 20, mode: 'new', target: null });
    const id = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 20, p: [720, 15, 20] }]; L.runOp(L.F.pushPullOp, { dist: 5 });
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 25, p: [720, 15, 25] }]; L.runOp(L.F.shellOp, { t: 2 });
    const r = L.H.hist().filter(x => x.op === 'F.extrude').at(-1); L.BR.editStep(r.id);
    const m = await import('./js/ops.js'); m.updateOp({ distance: 30 }); m.commit();
    const o = L.S.doc.objects.find(q => q.id === id);
    return { errs: L.H.hist().filter(x => x.err).map(x => x.err), v: L.K.volume(o.shape), expect: 40 * 30 * 35 - 36 * 26 * 33 };
  });
  check(!ppOk.errs.length && Math.abs(ppOk.v - ppOk.expect) < 1e-6, `Push/Pull and Shell follow their faces when an earlier extrude grows (${ppOk.v.toFixed(3)} mm³${ppOk.errs.length ? ' · ' + ppOk.errs.join('; ') : ''})`);
  // fasteners: a real helical thread on a shaft and in a nut, and counterbore / countersink holes
  const fast = await st(() => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('shaft', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [900, 0], r: 4 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [900, 0] }], distance: 12, mode: 'new', target: null });
    const sid = L.S.doc.objects.at(-1).id, v0 = L.K.volume(L.S.doc.objects.at(-1).shape);
    L.S.ed.faces = [{ obj: sid, n: [1, 0, 0], w: 904, p: [904, 0, 6], planar: false }];
    const t = L.runOp(F.threadOp, {}), label = L.H.hist().at(-1).label, v1 = L.K.volume(L.S.doc.objects.find(o => o.id === sid).shape);
    L.runOp(F.sketchOpNew('plate', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 950, y: -15, w: 40, h: 30 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [960, 0] }], distance: 10, mode: 'new', target: null });
    const pid = L.S.doc.objects.at(-1).id, p0 = L.K.volume(L.S.doc.objects.at(-1).shape);
    L.S.ed.faces = [{ obj: pid, n: [0, 0, 1], w: 10, p: [960.2, 0.3, 10], planar: true }];
    const h = L.runOp(F.holeOp, { kind: 'cbore', dia: 5.5, cbDia: 9, cbDepth: 5 }), p1 = L.K.volume(L.S.doc.objects.find(o => o.id === pid).shape);
    return { t, label, thread: v0 - v1, h, removed: p0 - p1, expect: Math.PI * (4.5 ** 2 * 5 + 2.75 ** 2 * 5) };
  });
  check(fast.t && /M8×1\.25/.test(fast.label) && fast.thread > 10, `Thread: a helical M8×1.25 thread (${fast.thread.toFixed(1)} mm³ of material cut into the shaft)`);
  check(fast.h && Math.abs(fast.removed - fast.expect) < 1e-6, `Hole: an exact counterbored hole (${fast.removed.toFixed(3)} mm³)`);
  // hole patterns and drive recesses
  const pat = await st(() => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('flange', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 1100, y: -30, w: 60, h: 60 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [1130, 0] }], distance: 6, mode: 'new', target: null });
    const id = L.S.doc.objects.at(-1).id, v = () => L.K.volume(L.S.doc.objects.find(o => o.id === id).shape), v0 = v();
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 6, p: [1130, 0, 6], planar: true }];
    const ok1 = L.runOp(F.holeOp, { dia: 4, pattern: 'circle', count: 6, radius: 20, x: 1130, y: 0, z: 6 }), v1 = v(), label = L.H.hist().at(-1).label;
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 6, p: [1130, 0, 6], planar: true }];
    const ok2 = L.runOp(F.recessOp, { kind: 'hex', size: 5, depth: 3, tip: false, x: 1130, y: 0, z: 6 }), v2 = v();
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 6, p: [1110, -20, 6], planar: true }];
    const ok3 = L.runOp(F.recessOp, { kind: 'cross', size: 6, width: 1, depth: 2, tip: false, pattern: 'row', count: 2, spacing: 40, x: 1110, y: -20, z: 6 }), v3 = v();
    return { ok: ok1 && ok2 && ok3, holes: v0 - v1, hex: v1 - v2, cross: v2 - v3, label, eh: 6 * Math.PI * 4 * 6, ex: Math.sqrt(3) / 2 * 5 * 5 * 3, ec: 2 * 2 * (2 * 6 - 1) };
  });
  check(pat.ok && Math.abs(pat.holes - pat.eh) < 1e-6 && /×6 on Ø40/.test(pat.label), `Hole pattern: six exact holes on a Ø40 bolt circle (${pat.holes.toFixed(3)} mm³, “${pat.label}”)`);
  check(Math.abs(pat.hex - pat.ex) < 1e-6 && Math.abs(pat.cross - pat.ec) < 1e-6, `Recesses: an exact hex socket (${pat.hex.toFixed(3)}) and a row of two cross recesses (${pat.cross.toFixed(3)} mm³)`);
  // round edges keep their fillets when the sketch they came from changes size (outer vs inner rim)
  const mug = await st(() => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('mug', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [-400, 0], r: 40 }); }));
    const skId = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk: skId, pt: [-400, 0] }], distance: 95, mode: 'new', target: null });
    const id = L.S.doc.objects.at(-1).id, O = () => L.S.doc.objects.find(o => o.id === id);
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 95, p: [-390, 0, 95], planar: true }];
    L.runOp(F.shellOp, { t: 4 });
    const circ = (z, r) => { const e = O().brep.edges.find(e => e.closed && Math.abs(e.pts[0][2] - z) < 1e-6 && Math.abs(Math.hypot(e.pts[0][0] + 400, e.pts[0][1]) - r) < 0.01); return { obj: id, p: K.polyMid(e.pts), a: e.pts[0], b: e.pts.at(-1), len: e.len, type: e.type }; };
    for (const [z, r, f] of [[95, 40, 1], [95, 36, 1], [0, 40, 3], [4, 36, 2]]) { L.S.ed.edges = [circ(z, r)]; L.runOp(F.edgeBlendOp, { kind: 'fillet', size: f }); }
    L.runOp(F.sketchOp('radius', skId, sk => { sk.ents.find(e => e.t === 'circle').r = 42; }));
    const errs = L.H.hist().filter(r => r.err).map(r => r.err), tor = O().shape.faces.filter(f => f.geomType === 'TORUS').length;
    return { errs, tor };
  });
  check(!mug.errs.length && mug.tor === 4, `Fillets on round rims follow a sketch radius change (outer and inner rims kept apart; ${mug.tor} toroidal fillets${mug.errs.length ? ' · ' + mug.errs.join('; ') : ''})`);
  const shrink = await st(() => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('thin', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: -600, y: 0, w: 200, h: 1 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [-500, 0.5] }], distance: 200, mode: 'new', target: null });
    const o = L.S.doc.objects.at(-1), e = o.brep.edges.find(e => e.type === 'LINE' && Math.abs(e.pts[0][2] - 200) < 1e-6 && Math.abs(e.pts[0][1] - e.pts.at(-1)[1]) < 1e-9 && e.len > 100);
    L.S.ed.edges = [{ obj: o.id, p: L.K.polyMid(e.pts), a: e.pts[0], b: e.pts.at(-1), len: e.len, type: e.type }];
    const ok = L.runOp(F.edgeBlendOp, { kind: 'fillet' });
    return { ok, size: L.getLast()?.params.size };
  });
  check(shrink.ok && shrink.size < 1, `A default fillet too big for a 1 mm plate shrinks to fit (radius ${shrink.size})`);
  // fasteners follow their faces: a hex socket moves up with the head; a tap-drill hole is threaded at its nominal size and survives a hole edit
  const fol = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('h', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [3000, 0], r: 6 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [3000, 0] }], distance: 5, mode: 'new', target: null });
    const hid = L.S.doc.objects.at(-1).id, hv = () => K.volume(L.S.doc.objects.find(x => x.id === hid).shape);
    L.S.ed.faces = [{ obj: hid, n: [0, 0, 1], w: 5, p: [3000.5, 0.4, 5], planar: true }];
    L.runOp(F.recessOp, { kind: 'hex', size: 4, depth: 2, tip: false });
    const er = L.H.hist().filter(r => r.op === 'F.extrude').at(-1); L.BR.editStep(er.id); ops.updateOp({ distance: 8 }); ops.commit();
    const removed = Math.PI * 36 * 8 - hv(), rec = L.H.hist().find(r => r.op === 'F.recessOp' && r.params.obj === hid).params;
    L.runOp(F.sketchOpNew('n', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 3020, y: -7, w: 14, h: 14 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [3021, 0] }], distance: 6.5, mode: 'new', target: null });
    const nid = L.S.doc.objects.at(-1).id, nv = () => K.volume(L.S.doc.objects.find(x => x.id === nid).shape);
    L.S.ed.faces = [{ obj: nid, n: [0, 0, 1], w: 6.5, p: [3027.4, 0.3, 6.5], planar: true }];
    L.runOp(F.holeOp, { dia: 6.8 }); const v0 = nv();
    L.S.ed.faces = [{ obj: nid, n: [-1, 0, 0], w: -3030.4, p: [3030.4, 0, 3], planar: false }];
    L.runOp(F.threadOp, {}); const label = L.H.hist().at(-1).label, v1 = nv();
    const hr = L.H.hist().filter(r => r.op === 'F.holeOp').at(-1); L.BR.editStep(hr.id); ops.updateOp({ dia: 6.9 }); ops.commit();
    return { removed, cz: rec.z, cx: rec.x, label, cut: v0 - v1, errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(Math.abs(fol.removed - Math.sqrt(3) / 2 * 16 * 2) < 1e-6 && fol.cz === 8 && fol.cx === 3000, `A hex socket snaps to the head's centre and follows its face when the head grows (centre z ${fol.cz})`);
  check(/internal M8×1\.25/.test(fol.label) && fol.cut > 10 && !fol.errs.length, `A Ø6.8 tap-drill hole is threaded as M8 (opens to the major Ø, ${fol.cut.toFixed(1)} mm³ removed) and survives a hole edit${fol.errs.length ? ' · ' + fol.errs.join('; ') : ''}`);
  // curved features: a sweep along line + true arc + line is exact and follows path edits; a lofted cone shells
  const crv = await st(() => {
    const L = StreamLine, F = L.F, K = L.K;
    const XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }), XZ = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] };
    L.runOp(F.sketchOpNew('path', XZ, null, k => { F.addEntity(k, { t: 'line', a: [4000, 0], b: [4000, 50] }); F.addEntity(k, { t: 'arc', c: [4030, 50], r: 30, a0: Math.PI / 2, a1: Math.PI }); F.addEntity(k, { t: 'line', a: [4030, 80], b: [4080, 80] }); }));
    const ps = L.S.doc.sketches.at(-1);
    L.runOp(F.sketchOpNew('prof', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [4000, 0], r: 5 }); }));
    L.S.ed.profiles = [{ sk: L.S.ed.sketch, pt: [4000, 0] }];
    L.runOp(F.sweepOp, { path: ps.id }); const sid = L.S.doc.objects.at(-1).id, sv = () => K.volume(L.S.doc.objects.find(o => o.id === sid).shape);
    const v1 = sv();
    L.runOp(F.sketchOp('len', ps.id, k => { k.ents[2].b = [4100, 80]; })); const v2 = sv();
    L.runOp(F.sketchOpNew('c1', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [4300, 0], r: 20 }); })); const a = L.S.ed.sketch;
    L.runOp(F.sketchOpNew('c2', XY(70), null, k => { F.addEntity(k, { t: 'circle', c: [4300, 0], r: 55 }); })); const b = L.S.ed.sketch;
    L.S.ed.profiles = [{ sk: a, pt: [4300, 0] }, { sk: b, pt: [4300, 0] }];
    L.runOp(F.loftOp, {}); const lid = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: lid, n: [0, 0, 1], w: 70, p: [4300, 0, 70], planar: true }];
    const ok = L.runOp(F.shellOp, { t: 1.5 }), lv = K.volume(L.S.doc.objects.find(o => o.id === lid).shape);
    return { v1, v2, e1: Math.PI * 25 * (100 + 15 * Math.PI), e2: Math.PI * 25 * (120 + 15 * Math.PI), ok, lv };
  });
  check(Math.abs(crv.v1 - crv.e1) < 1e-3 && Math.abs(crv.v2 - crv.e2) < 1e-3, `Sweep along line + arc + line is exact (${crv.v1.toFixed(2)} mm³) and rebuilds when the path is edited`);
  check(crv.ok && crv.lv > 20000 && crv.lv < 35000, `A lofted cone shells to a 1.5 mm wall (${crv.lv.toFixed(0)} mm³)`);
  // enclosure features: a hole centred on a standoff follows it when its sketch circle moves; a port drills one wall
  const enc = await st(() => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('plate', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 5000, y: 0, w: 60, h: 40 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [5005, 5] }], distance: 4, mode: 'new', target: null });
    const pid = L.S.doc.objects.at(-1).id, v = () => K.volume(L.S.doc.objects.find(o => o.id === pid).shape);
    L.runOp(F.sketchOpNew('so', XY(4), null, k => { F.addEntity(k, { t: 'circle', c: [5015, 15], r: 2.5 }); })); const so = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk: so, pt: [5015, 15] }], distance: 6, mode: 'join', target: pid });
    L.S.ed.faces = [{ obj: pid, n: [0, 0, 1], w: 10, p: [5015.4, 14.8, 10], planar: true }];
    L.runOp(F.holeOp, { dia: 2.5, depth: 5 });
    L.runOp(F.sketchOp('shift', so, k => { k.ents.find(e => e.t === 'circle').c = [5018, 15]; }));
    const h = L.H.hist().filter(r => r.op === 'F.holeOp').at(-1).params, ok1 = h.x === 5018 && h.y === 15 && h.z === 10 && Math.abs(v() - (9600 + Math.PI * 6.25 * 6 - Math.PI * 1.5625 * 5)) < 1e-6;
    L.runOp(F.sketchOpNew('box', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 5100, y: 0, w: 50, h: 30 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [5110, 5] }], distance: 20, mode: 'new', target: null });
    const bid = L.S.doc.objects.at(-1).id, bv = () => K.volume(L.S.doc.objects.find(o => o.id === bid).shape);
    L.S.ed.faces = [{ obj: bid, n: [0, 0, 1], w: 20, p: [5120, 10, 20], planar: true }]; L.runOp(F.shellOp, { t: 2 });
    const b0 = bv(); L.S.ed.faces = [{ obj: bid, n: [-1, 0, 0], w: -5100, p: [5100, 12, 9], planar: true }];
    L.runOp(F.holeOp, { dia: 6 });
    return { ok1, h: [h.x, h.y, h.z], port: b0 - bv(), errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(enc.ok1 && !enc.errs.length, `A hole centred on a standoff follows it when the standoff moves in its sketch (now at ${enc.h.join(', ')})`);
  check(Math.abs(enc.port - Math.PI * 9 * 2) < 1e-6, `A "through" port drills only the wall it starts in (${enc.port.toFixed(3)} mm³)`);
  // repetition: a row of vent-slot cutters (Linear Pattern) subtracted from a plate in one step
  const vents = await st(() => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('base', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 6000, y: 0, w: 100, h: 40 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [6005, 5] }], distance: 5, mode: 'new', target: null }); const base = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('slot', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 6010, y: 10, w: 3, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [6011, 15] }], distance: 10, mode: 'new', target: null });
    L.S.ed.selected = new Set([L.S.doc.objects.at(-1).id]); L.runOp(F.linearPattern, { count: 5, spacing: 8 });
    L.S.ed.selected = new Set([base, ...L.S.ed.selected]); L.S.ed.active = base; L.runOp(F.bodyBoolean, { kind: 'subtract' });
    return K.volume(L.S.doc.objects.find(o => o.id === base).shape);
  });
  check(Math.abs(vents - (20000 - 1500)) < 1e-6, `Linear Pattern: five vent cutters subtracted in one step (${vents.toFixed(2)} mm³)`);
  // Mate turns a part to line up axes; Subtract follows a polar pattern whose count changes
  const turn = await st(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js');
    const XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }), XZ = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] };
    L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 7000, y: 0, w: 30, h: 20 }); F.addEntity(k, { t: 'circle', c: [7010, 10], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [7002, 2] }], distance: 10, mode: 'new', target: null }); const blk = L.S.doc.objects.at(-1).id;
    // a pin lying along Y (sketched on XZ, extruded along −Y)
    L.runOp(F.sketchOpNew('pin', XZ, null, k => { F.addEntity(k, { t: 'circle', c: [7060, 40], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [7060, 40] }], distance: 30, mode: 'new', target: null }); const pin = L.S.doc.objects.at(-1).id;
    const a = { obj: pin, n: [1, 0, 0], w: 7063, p: [7063, -15, 40], planar: false }, b = { obj: blk, n: [0, -1, 0], w: -13, p: [7010, 13, 5], planar: false };
    const ok = L.runOp(F.mateOp, { a, b });
    const o = L.S.doc.objects.find(x => x.id === pin), bb = K.worldShape(o).boundingBox.bounds;
    const axis = [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2], vertical = bb[1][2] - bb[0][2];
    // polar pattern of cutters → subtract → count 6 → 8
    L.runOp(F.sketchOpNew('disc', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [8000, 0], r: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [8000, 0] }], distance: 5, mode: 'new', target: null }); const disc = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('cut', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [8018, 0], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [8018, 0] }], distance: 5, mode: 'new', target: null });
    L.S.ed.selected = new Set([L.S.doc.objects.at(-1).id]); L.runOp(F.polarPattern, { count: 6, angle: 360, axis: 'z', cx: 8000, cy: 0, cz: 0 });
    L.S.ed.selected = new Set([...L.S.ed.selected, disc]); L.runOp(F.bodyBoolean, { kind: 'subtract' });
    const dv = () => K.volume(L.S.doc.objects.find(x => x.id === disc).shape), v6 = dv();
    const pr = L.H.hist().find(r => r.op === 'F.polarPattern'); L.BR.editStep(pr.id); ops.updateOp({ count: 8 }); ops.commit();
    return { ok, axis, vertical, rot: o.rot, v6, v8: dv(), left: L.S.doc.objects.filter(x => x.patternOf != null).length, errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(turn.ok && Math.abs(turn.axis[0] - 7010) < 1e-6 && Math.abs(turn.axis[1] - 10) < 1e-6 && Math.abs(turn.vertical - 30) < 1e-6, `Mate turns a pin lying on its side upright into the hole (axis at ${turn.axis.map(v => +v.toFixed(6)).join(', ')}, rotation ${turn.rot.join(', ')})`);
  const per6 = (Math.PI * 400 * 5 - turn.v6) / 6, per8 = (Math.PI * 400 * 5 - turn.v8) / 8; // each cutter removes the same amount
  check(per6 > 1 && Math.abs(per6 - per8) < 1e-6 && turn.left === 0 && !turn.errs.length, `Subtract follows its polar pattern: 6 → 8 cutters all cut, none left over (v6 ${turn.v6.toFixed(2)}, v8 ${turn.v8.toFixed(2)}, left ${turn.left})${turn.errs.length ? ' · ' + turn.errs.join('; ') : ''}`);
  // Mate: a pin's round face onto a hole's round face (same axis), by touch
  {
    const ids = await st(() => {
      const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
      L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 2000, y: 0, w: 30, h: 20 }); F.addEntity(k, { t: 'circle', c: [2010, 10], r: 3 }); }));
      L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [2002, 2] }], distance: 10, mode: 'new', target: null });
      L.runOp(F.sketchOpNew('pin', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [2060, 40], r: 3 }); }));
      L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [2060, 40] }], distance: 30, mode: 'new', target: null });
      L.S.settings.cmdline = false; // (the AutoCAD command line from an earlier check would lift the cube over the parts)
      L.S.ed.selected = new Set(); L.S.ed.pick = 'face'; L.S.ed.drawSel = new Set(); L.S.ed.profiles = []; L.S.ed.faces = []; L.S.ed.edges = []; L.refresh(); return L.S.doc.objects.at(-1).id;
    });
    await p.evaluate(() => { [...document.querySelectorAll('#keypad button')].find(b => b.textContent === 'Cancel')?.click(); document.querySelector('#lastop .ib[aria-label=Done]')?.click(); }); await p.waitForTimeout(200);
    await p.evaluate(() => StreamLine.view.setView('iso')); await p.waitForTimeout(400);
    await frame([1995, -5, 0], [2070, 50, 30]);
    let q = await projW([2063, 40, 15]); await tapV(q.x, q.y);
    await p.locator('#actions .act', { hasText: 'Mate' }).tap(); await p.waitForTimeout(300);
    q = await projW([2010, 13, 8]); await tapV(q.x, q.y);
    const loc = await st(id => StreamLine.S.doc.objects.find(o => o.id === id).loc, ids);
    // the mate is a step: when the hole moves (its sketch circle edited), the pin follows on the next rebuild
    const follow = await st(id => {
      const L = StreamLine, sk = L.S.doc.sketches.find(k => k.name.startsWith('Sketch') && k.ents.some(e => e.t === 'circle' && e.c[0] === 2010));
      L.runOp(L.F.sketchOp('move hole', sk.id, k => { k.ents.find(e => e.t === 'circle').c = [2015, 12]; }));
      return { loc: L.S.doc.objects.find(o => o.id === id).loc, hist: L.H.hist().some(r => r.op === 'F.mateOp'), errs: L.H.hist().filter(r => r.err).map(r => r.err) };
    }, ids);
    // moving the block afterwards carries the mated pin with it (mates are constraints)
    const carry = await st(id => {
      const L = StreamLine, blk = L.S.doc.objects.find(o => o.name.startsWith('Body') && o.id !== id && L.K.worldShape(o).boundingBox.bounds[0][0] > 1999 && L.K.worldShape(o).boundingBox.bounds[0][0] < 2001);
      L.S.ed.selected = new Set([blk.id]); L.runOp(L.OPS.transform, { mode: 'move', x: 7, y: 3, z: 2 });
      return L.S.doc.objects.find(o => o.id === id).loc;
    }, ids);
    check(Math.abs(carry[0] + 38) < 1e-6 && Math.abs(carry[1] + 25) < 1e-6, `Moving the fixed part carries the mated pin with it (${carry.map(v => +v.toFixed(6)).join(', ')})`);
    check(follow.hist && Math.abs(follow.loc[0] + 45) < 1e-6 && Math.abs(follow.loc[1] + 28) < 1e-6 && !follow.errs.length, `Mate is a history step: moving the hole moves the pin with it (${follow.loc.map(v => +v.toFixed(6)).join(', ')}${follow.errs.length ? ' · ' + follow.errs.join('; ') : ''})`);
    check(Math.abs(loc[0] + 50) < 1e-6 && Math.abs(loc[1] + 30) < 1e-6 && Math.abs(loc[2]) < 1e-9, `Mate: tapping a pin then a hole puts the pin on the hole's axis (moved ${loc.map(v => +v.toFixed(6)).join(', ')})`);
  }
  // assemblies: insert a saved project as a linked component, change its source, sync
  const asm = await p.evaluate(async () => {
    const L = StreamLine, PJ = await import('./js/projects.js'), ops = await import('./js/ops.js');
    const vol = () => L.S.doc.objects.filter(o => o.link).map(o => L.K.volume(L.K.worldShape(o)));
    await PJ.newProject(); L.addSketchedPrim('cube'); L.S.doc.project.name = 'Part A'; await PJ.saveNow(); const A = L.S.doc.project.id;
    await PJ.newProject(); L.addSketchedPrim('cylinder'); await PJ.saveNow(); const B = L.S.doc.project.id;
    await PJ.insertProject(A); const v0 = vol()[0];
    await PJ.saveNow(); await PJ.openProject(A);
    L.BR.editStep(L.H.hist().find(x => x.op === 'F.extrude').id); ops.updateOp({ distance: 35 }); ops.commit(); await PJ.saveNow();
    await PJ.openProject(B); await PJ.refreshKnown();
    const pid = L.S.doc.objects.find(o => o.link).link.pid, stale = PJ.outOfDate(pid);
    await PJ.syncComponent(pid); const v1 = vol()[0];
    const c = L.S.doc.objects.find(o => o.link); L.S.ed.faces = [{ obj: c.id, n: [0, 0, 1], w: 35, p: [0, 0, 35], planar: true }];
    const refused = !L.runOp(L.F.pushPullOp, { dist: 5 });
    return { v0, v1, stale, fresh: !PJ.outOfDate(pid), refused };
  });
  check(Math.abs(asm.v0 - 8000) < 1e-6 && Math.abs(asm.v1 - 14000) < 1e-6 && asm.stale && asm.fresh && asm.refused,
    `Assemblies: insert a saved project, see it go out of date, Sync to its new version, linked parts stay read-only (${asm.v0.toFixed(0)} → ${asm.v1.toFixed(0)} mm³)`);
  // round 10: a feature moved inside a part (same volume and area) still gives the part a new version
  const sigv = await p.evaluate(async () => {
    const L = StreamLine, PJ = await import('./js/projects.js'), LIB = await import('./js/library.js');
    await PJ.newProject(); L.addSketchedPrim('cube'); await PJ.saveNow(); const id = L.S.doc.project.id, v0 = (await LIB.get(id)).version;
    const o = L.S.doc.objects.find(q => q.shape); o.shape = L.K.translated(o.shape, [3, 0, 0]); await PJ.saveNow();
    return [v0, (await LIB.get(id)).version];
  });
  check(sigv[1] === sigv[0] + 1, `A part whose feature moved (same volume and area) gets a new version, so Sync sees it (${sigv.join(' → ')})`);
  // text → Outline → letters' filled areas selected → Extrude
  const txt = await p.evaluate(async () => {
    const L = StreamLine;
    L.runOp(L.F.newSketch, { plane: 'XY' }); const sk = L.SK.activeSketch();
    L.runOp(L.F.sketchOp('Text', sk.id, k => { L.F.addEntity(k, { t: 'text', p: [300, 0], h: 10, str: 'DOB', rot: 0 }); }));
    const id = L.SK.sketchById(sk.id).ents.find(e => e.t === 'text').id; L.S.ed.sketch = sk.id; L.S.ed.drawSel = new Set([id]); L.refresh();
    const btn = [...document.querySelectorAll('#actions button')].some(b => /Outline/.test(b.textContent));
    await L.Draw.outlineText();
    const prof = L.S.ed.profiles.slice(), before = L.S.doc.objects.length;
    L.runOp(L.F.extrude, { pts: prof, distance: 2, mode: 'new', target: null });
    const made = L.S.doc.objects.slice(before).filter(o => o.shape), vol = made.reduce((a, o) => a + L.K.volume(o.shape), 0);
    const top = Math.max(...made.map(o => L.K.worldShape(o).boundingBox.bounds[1][1]));
    return { btn, n: prof.length, vol, top, text: L.SK.sketchById(sk.id).ents.some(e => e.t === 'text') };
  });
  check(txt.btn && txt.n === 3 && !txt.text && txt.vol > 60 && txt.vol < 2 * 3 * 10 * 8 && Math.abs(txt.top - 10) < 0.3,
    `Text → Outline gives closed letters (D, O, B with their holes) that extrude (${txt.n} areas, ${txt.vol.toFixed(1)} mm³, cap height ${txt.top.toFixed(2)})`);
  // Plane here: typed coordinates are the model's own (the origin is not the tapped point)
  const ph = await p.evaluate(async () => {
    const L = StreamLine, PJ = await import('./js/projects.js');
    await PJ.newProject(); L.addSketchedPrim('cube'); const o = L.S.doc.objects.find(q => q.shape), z = L.K.worldShape(o).boundingBox.bounds[1][2];
    L.S.ed.pick = 'face'; L.S.ed.faces = [{ obj: o.id, n: [0, 0, 1], p: [3, 4, z], planar: true }]; L.refresh();
    [...document.querySelectorAll('#actions button')].find(b => /Plane here/.test(b.textContent))?.click();
    return { o: L.S.ed.cplane?.o, z };
  });
  check(ph.o && Math.abs(ph.o[0]) < 1e-6 && Math.abs(ph.o[1]) < 1e-6 && Math.abs(ph.o[2] - ph.z) < 1e-6, `Plane here: the plane's origin sits over the world origin, so typed X/Y match the model (${ph.o?.map(v => +v.toFixed(6)).join(', ')})`);
  // selected curves: Rotate starts the 2D command (not the 3D gizmo)
  const rot = await p.evaluate(async () => {
    const L = StreamLine;
    L.runOp(L.F.newSketch, { plane: 'XY' }); const sk = L.SK.activeSketch();
    L.runOp(L.F.sketchOp('Line', sk.id, k => { L.F.addEntity(k, { t: 'line', a: [500, 0], b: [510, 0] }); }));
    L.activateSketch(sk.id); // (curves are changed inside their sketch)
    const ents = () => L.SK.sketchById(sk.id).ents, id = ents()[ents().length - 1].id; L.S.ed.sketch = sk.id; L.S.ed.drawSel = new Set([id]); L.S.ed.pick = 'edge'; L.refresh();
    [...document.querySelectorAll('#actions button')].find(b => /^\s*Rotate\s*$/.test(b.textContent))?.click();
    const live = L.Draw.curveCmd(), card = !document.querySelector('#draw-card')?.hidden;
    L.Draw.typed('500,0'); L.Draw.typed('90');
    const e = ents().find(q => q.id === id);
    L.Draw.resetTool(); L.finishSketchEdit();
    return { live, card, b: e?.b };
  });
  check(rot.live && rot.card && rot.b && Math.abs(rot.b[0] - 500) < 1e-6 && Math.abs(rot.b[1] - 10) < 1e-6, `Selected curves: Rotate runs the 2D command and turns them (end at ${rot.b?.map(v => +v.toFixed(6)).join(', ')})`);
  // a flat-to-flat mate with a gap (drawer clearance)
  const gap = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('g1', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9000, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9005, 5] }], distance: 10, mode: 'new', target: null }); const a = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('g2', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9100, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9105, 5] }], distance: 5, mode: 'new', target: null }); const b = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: b, n: [0, 0, -1], p: [9105, 5, 0], planar: true }, b: { obj: a, n: [0, 0, 1], p: [9005, 5, 10], planar: true }, gap: 0 });
    const z0 = K.worldShape(L.S.doc.objects.find(o => o.id === b)).boundingBox.bounds[0][2];
    const fields = (L.F.mateOp.fields(L.getLast().params) || []).map(f => f.key);
    ops.updateOp({ gap: 0.5 }); ops.commit();
    return { z0, z1: K.worldShape(L.S.doc.objects.find(o => o.id === b)).boundingBox.bounds[0][2], fields };
  });
  check(Math.abs(gap.z0 - 10) < 1e-6 && Math.abs(gap.z1 - 10.5) < 1e-6 && gap.fields.includes('gap'), `Flat mates take a gap: 0 → face to face (z ${+gap.z0.toFixed(6)}), 0.5 mm → stood off (z ${+gap.z1.toFixed(6)})`);
  // round 11: a hand-picked Cut from a face sketch cuts into the body whichever sign is typed
  const cutv = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 0, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [5, 5] }], distance: 10, mode: 'new', target: null }); const b = L.S.doc.objects.at(-1);
    const out = [];
    for (const d of [-1, 1]) {
      const cx = d < 0 ? 5 : 15;
      L.runOp(F.sketchOpNew('top', XY(10), { obj: b.id }, k => { F.addEntity(k, { t: 'circle', c: [cx, 10], r: 2 }); }));
      const v0 = K.volume(L.S.doc.objects.find(o => o.id === b.id).shape);
      L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [cx, 10] }], distance: d, mode: 'cut', target: b.id });
      out.push(v0 - K.volume(L.S.doc.objects.find(o => o.id === b.id).shape));
    }
    return out;
  });
  check(cutv.every(v => Math.abs(v - Math.PI * 4) < 1e-6), `Cut from a face sketch goes into the body for −1 and +1 alike (${cutv.map(v => v.toFixed(3)).join(', ')} mm³)`);
  // a face sketch (and the body built from it) turns with its part when an earlier Rotate changes
  const folr = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    L.runOp(F.sketchOpNew('bar', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 0, y: -5, w: 100, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [50, 0] }], distance: 4, mode: 'new', target: null }); const bar = L.S.doc.objects.at(-1).id;
    L.S.ed.selected = new Set([bar]); L.S.ed.active = bar; L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'z', angle: 30, pivot: [0, 0, 0] });
        // a sketch on the bar's top face at its far end (bar-local x 90), drawn in world coordinates
    const c = 90 * Math.cos(Math.PI / 6), s = 90 * Math.sin(Math.PI / 6);
    L.runOp(F.sketchOpNew('btn', XY(4), { obj: bar }, k => { F.addEntity(k, { t: 'circle', c: [c, s], r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [c, s] }], distance: 3, mode: 'new', target: null }); const btn = L.S.doc.objects.at(-1).id;
    const rec = L.H.hist().find(r => /Rotate/.test(r.label || '')); L.BR.editStep(rec.id); ops.updateOp({ angle: 90 }); ops.commit();
    const bb = K.worldShape(L.S.doc.objects.find(q => q.id === btn)).boundingBox.bounds;
    return { ctr: [0, 1].map(k => (bb[0][k] + bb[1][k]) / 2), errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(Math.abs(folr.ctr[0]) < 1e-3 && Math.abs(folr.ctr[1] - 90) < 1e-3 && !folr.errs.length, `A face sketch and its body turn with the part when an earlier Rotate changes (button now at ${folr.ctr.map(v => +v.toFixed(4)).join(', ')}${folr.errs.length ? '; ' + folr.errs.join('; ') : ''})`);
  // conflicting mates are flagged on their step
  const conf = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('c1', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 3000, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [3005, 5] }], distance: 10, mode: 'new', target: null }); const a = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('c2', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 3100, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [3105, 5] }], distance: 5, mode: 'new', target: null }); const b = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: b, n: [0, 0, -1], p: [3105, 5, 0], planar: true }, b: { obj: a, n: [0, 0, 1], p: [3005, 5, 10], planar: true }, gap: 0 });
    // second: the same bottom face onto the block's bottom (z 0) — impossible together with the first
    L.runOp(F.mateOp, { a: { obj: b, n: [0, 0, -1], p: [3105, 5, 10], planar: true }, b: { obj: a, n: [0, 0, -1], p: [3005, 5, 0], planar: true }, gap: 0 });
    return L.H.hist().filter(r => r.op === 'F.mateOp').map(r => r.err || '');
  });
  check(conf.some(e => /Conflicts/.test(e)), `Two mates that can't both hold: one is flagged (“${conf.filter(Boolean)[0] || 'none'}”)`);
  // round 12: a hole on a hinge block keeps its place on the block's face when the block slides along a long wall
  const hb = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    L.runOp(F.sketchOpNew('base', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 0, y: 0, w: 160, h: 40 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [5, 5] }], distance: 15, mode: 'new', target: null }); const id = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('blk', XY(15), { obj: id }, k => { F.addEntity(k, { t: 'rect', x: 140, y: 10, w: 15, h: 20 }); })); const bs = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk: bs, pt: [145, 15] }], distance: 15, mode: 'join', target: id });
    L.S.ed.faces = [{ obj: id, n: [0, -1, 0], w: -10, p: [147.5, 10, 22.5], planar: true }];
    L.runOp(F.holeOp, { dia: 4, x: 147.5, y: 10, z: 24 });
    L.runOp(F.sketchOp('shift', bs, k => { k.ents.find(e => e.t === 'rect').x = 120; }));
    const h = L.H.hist().filter(r => r.op === 'F.holeOp').at(-1).params;
    // a centre typed off the face's plane is slid onto it (no buried hole)
    L.S.ed.faces = [{ obj: id, n: [0, 0, 1], w: 15, p: [50, 20, 15], planar: true }];
    L.runOp(F.holeOp, { dia: 4, depth: 3, x: 50, y: 20, z: 9 });
    const h2 = L.getLast().params;
    return { c: [h.x, h.y, h.z], c2: [h2.x, h2.y, h2.z], errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(Math.abs(hb.c[0] - 127.5) < 1e-6 && Math.abs(hb.c[1] - 10) < 1e-6 && Math.abs(hb.c[2] - 24) < 1e-6 && Math.abs(hb.c2[2] - 15) < 1e-9 && !hb.errs.length,
    `A hole on a block keeps its height when the block slides along a long wall (${hb.c.map(v => +v.toFixed(6)).join(', ')}); a centre typed off the face lands on it (z ${hb.c2[2]})`);
  // flat mates: face to face turns a part round when both faces point the same way; Flush keeps them level
  const al = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('a', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 400, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [405, 5] }], distance: 10, mode: 'new', target: null }); const a = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('b', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 500, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [505, 5] }], distance: 4, mode: 'new', target: null }); const b = L.S.doc.objects.at(-1).id;
    // both tops (+Z): face to face puts b upside down on a's top
    L.runOp(F.mateOp, { a: { obj: b, n: [0, 0, 1], p: [505, 5, 4], planar: true }, b: { obj: a, n: [0, 0, 1], p: [405, 5, 10], planar: true }, gap: 0, align: 'face' });
    const bb = () => K.worldShape(L.S.doc.objects.find(o => o.id === b)).boundingBox.bounds;
    const z1 = [bb()[0][2], bb()[1][2]], lab = L.H.hist().at(-1).label;
    ops.updateOp({ align: 'flush' }); ops.commit();
    return { z1, z2: [bb()[0][2], bb()[1][2]], lab, card: document.querySelector('#lastop')?.textContent.includes('null') };
  });
  check(Math.abs(al.z1[0] - 10) < 1e-6 && Math.abs(al.z1[1] - 14) < 1e-6 && Math.abs(al.z2[1] - 10) < 1e-6 && /flat/.test(al.lab) && !al.card,
    `Flat mate: face to face turns the part over (z ${al.z1.map(v => +v.toFixed(6)).join('..')}), Flush levels the tops (z ${al.z2.map(v => +v.toFixed(6)).join('..')}); “${al.lab}”`);
  // a body sketched on a hinged (mated) part follows it when an earlier Rotate changes
  const hp = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: -10, y: -10, w: 20, h: 20 }); F.addEntity(k, { t: 'circle', c: [0, 0], r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [-8, -8] }], distance: 10, mode: 'new', target: null }); const A = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('bar', XY(10), null, k => { F.addEntity(k, { t: 'rect', x: -5, y: -5, w: 105, h: 10 }); F.addEntity(k, { t: 'circle', c: [0, 0], r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [50, 0] }], distance: 4, mode: 'new', target: null }); const B = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: B, n: [1, 0, 0], p: [2, 0, 12], planar: false }, b: { obj: A, n: [1, 0, 0], p: [2, 0, 5], planar: false }, gap: 0 });
    L.S.ed.selected = new Set([B]); L.S.ed.active = B; L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'z', angle: 30, pivot: [50, 0, 0] });
    const at = a => [90 * Math.cos(a * Math.PI / 180), 90 * Math.sin(a * Math.PI / 180)], c30 = at(30);
    L.runOp(F.sketchOpNew('plate', XY(14), { obj: B }, k => { F.addEntity(k, { t: 'circle', c: c30, r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: c30 }], distance: 3, mode: 'new', target: null }); const P = L.S.doc.objects.at(-1).id;
    const rec = L.H.hist().find(r => /Rotate/.test(r.label || '')); L.BR.editStep(rec.id); ops.updateOp({ angle: 60 }); ops.commit();
    const bb = K.worldShape(L.S.doc.objects.find(o => o.id === P)).boundingBox.bounds;
    return { got: [0, 1].map(k => (bb[0][k] + bb[1][k]) / 2), want: at(60), errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(Math.hypot(hp.got[0] - hp.want[0], hp.got[1] - hp.want[1]) < 1e-3 && !hp.errs.length, `A plate sketched on a hinged part follows it when its Rotate changes (at ${hp.got.map(v => +v.toFixed(3)).join(', ')}, want ${hp.want.map(v => +v.toFixed(3)).join(', ')})`);
  // round 13: STEP round trip keeps the parts (names, colours); Thread button on a shaft; pattern unions keep the
  // original as target when the count drops; mate loops are refused
  const r13 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, ops = await import('./js/ops.js'), PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    const blob = K.R.exportSTEP([{ shape: K.R.makeBox([0, 0, 0], [10, 10, 10]), name: 'Cube', color: K.stepColor('#9fb6cf') }, { shape: K.R.makeBox([20, 0, 0], [24, 4, 4]), name: 'Small one', color: K.stepColor('#c9b79c') }], { unit: 'MM' });
    const txt = await blob.text(), back = await K.R.importSTEP(new Blob([txt])), parts = K.stepParts(back, txt);
    const imp = parts.map(pt => ({ name: pt.name, color: pt.color, v: +K.volume(pt.shape).toFixed(6) }));
    // a shaft: the face bar offers Thread
    L.runOp(F.sketchOpNew('sh', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [300, 0], r: 4 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [300, 0] }], distance: 20, mode: 'new', target: null }); const sh = L.S.doc.objects.at(-1).id;
    L.S.ed.pick = 'face'; L.S.ed.selected = new Set(); L.S.ed.faces = [{ obj: sh, n: [1, 0, 0], p: [304, 0, 10], planar: false }]; L.refresh();
    const thread = [...document.querySelectorAll('#actions button')].some(b => /Thread/.test(b.textContent));
    L.S.ed.faces = []; L.S.ed.pick = 'solid';
    // hub + blade → polar pattern 5 → union (copies tapped first) → count 3
    L.runOp(F.sketchOpNew('hub', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [600, 0], r: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [600, 0] }], distance: 5, mode: 'new', target: null }); const hub = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('bl', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 615, y: -2, w: 20, h: 4 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [620, 0] }], distance: 5, mode: 'new', target: null }); const bl = L.S.doc.objects.at(-1).id;
    L.S.ed.selected = new Set([bl]); L.runOp(F.polarPattern, { count: 5, angle: 360, axis: 'z', cx: 600, cy: 0, cz: 0 });
    const copies = L.S.doc.objects.filter(o => o.patternOf != null).map(o => o.id);
    L.S.ed.selected = new Set([...copies.slice().reverse(), bl]); const tie = (() => { const pp = {}; F.bodyBoolean.prepare(pp); return pp.ids[0]; })();
    L.S.ed.selected = new Set([...copies, bl, hub]); L.runOp(F.bodyBoolean, { kind: 'union' }); const target = L.getLast().params.ids[0];
    const pr = L.H.hist().find(r => r.op === 'F.polarPattern'); L.BR.editStep(pr.id); ops.updateOp({ count: 3 }); ops.commit();
    const u = L.H.hist().find(r => r.op === 'F.bodyBoolean'), hv = K.volume(L.S.doc.objects.find(o => o.id === hub).shape);
    return { imp, thread, target, hub, bl, tie, uerr: u.err || '', hv };
  });
  check(r13.imp.length === 2 && r13.imp[0].name === 'Cube' && r13.imp[1].name === 'Small one' && r13.imp[0].v === 1000 && r13.imp[1].v === 64 && r13.imp[0].color === '#9fb6cf' && r13.imp[1].color === '#c9b79c',
    `STEP import gives one body per part with its name and colour (${r13.imp.map(x => `${x.name} ${x.v} ${x.color}`).join('; ')})`);
  check(r13.thread, 'Face mode on a shaft offers Thread');
  check(r13.target === r13.hub && r13.tie === r13.bl && !r13.uerr && Math.abs(r13.hv - (Math.PI * 100 * 5 + 3 * 400)) < 1e-3,
    `Union of a pattern: the hub stays the target; equal copies leave the original as target; count 5 → 3 rebuilds (${JSON.stringify([r13.target, r13.hub, r13.tie, r13.bl])} ${r13.hv.toFixed(3)} mm³${r13.uerr ? '; ' + r13.uerr : ''})`);
  const loop = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('l1', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 900, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [905, 5] }], distance: 10, mode: 'new', target: null }); const a = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('l2', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 1000, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [1005, 5] }], distance: 5, mode: 'new', target: null }); const b = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: b, n: [0, 0, -1], p: [1005, 5, 0], planar: true }, b: { obj: a, n: [0, 0, 1], p: [905, 5, 10], planar: true }, gap: 0, align: 'face' });
    const pos = () => L.S.doc.objects.filter(o => o.id === a || o.id === b).map(o => o.loc.join()).join('|'), p0 = pos();
    L.runOp(F.mateOp, { a: { obj: a, n: [1, 0, 0], p: [920, 5, 5], planar: true }, b: { obj: b, n: [-1, 0, 0], p: [1000, 5, 12], planar: true }, gap: 0, align: 'face' });
    return { errs: L.H.hist().filter(r => r.op === 'F.mateOp').map(r => r.err || ''), first: L.H.hist().filter(r => r.op === 'F.mateOp').at(-2).err || '' };
  });
  check(/loop/.test(loop.errs.at(-1)) && !loop.first, `A mate that would make a loop is flagged on the new step, the first one stays (“${loop.errs.at(-1)}”)`);
  // Rotate about the mate axis: an exact turn about a hinge that isn't a world axis
  const ma = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, PJ = await import('./js/projects.js'), XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    await PJ.newProject();
    L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: -10, y: -10, w: 20, h: 20 }); F.addEntity(k, { t: 'circle', c: [0, 0], r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [-8, -8] }], distance: 10, mode: 'new', target: null }); const A = L.S.doc.objects.at(-1).id;
    L.S.ed.selected = new Set([A]); L.S.ed.active = A; L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'y', angle: 45, pivot: [0, 0, 0] });
    L.runOp(F.sketchOpNew('bar', XY(30), null, k => { F.addEntity(k, { t: 'rect', x: 95, y: -5, w: 105, h: 10 }); F.addEntity(k, { t: 'circle', c: [100, 0], r: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [150, 0] }], distance: 4, mode: 'new', target: null }); const B = L.S.doc.objects.at(-1).id;
    const s2 = Math.SQRT1_2;
    L.runOp(F.mateOp, { a: { obj: B, n: [1, 0, 0], p: [102, 0, 32], planar: false }, b: { obj: A, n: [s2, 0, -s2], p: [2 * s2 + 5 * s2, 0, -2 * s2 + 5 * s2], planar: false }, gap: 0 });
    L.S.ed.selected = new Set([B]); L.S.ed.active = B;
    L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'm', angle: 30 });
    const last = L.getLast(), fields = L.OPS.transform.fields(last.params).find(f => f.key === 'axis').options.map(o => o[0]);
    return { fields, held: !!last.heldByMate, errs: L.H.hist().filter(r => r.err).map(r => r.err), ax: last.params._mateAx };
  });
  check(ma.fields.includes('m') && !ma.held && ma.ax && !ma.errs.length, `Rotate offers the mate axis and turns about it without the mate pulling back (axis ${ma.ax?.d.map(v => +v.toFixed(4)).join(', ')})`);
  // round 14: a multi-part STEP import keeps every part's solid in its history step; an axis mate on a threaded
  // bore follows the bore when its sketch moves; Loop takes the face toward the viewer and cycles; hole grids on
  // a bottom face run toward +Y; a hole row across two bosses is all on the part
  const stepTxt = await p.evaluate(async () => { const K = StreamLine.K; return K.R.exportSTEP([0, 1, 2].map(i => ({ shape: K.R.makeBox([i * 20, 0, 0], [i * 20 + 10, 10, 10 + i]), name: 'P' + i, color: '#9fb6cf' })), { unit: 'MM' }).text(); });
  await p.evaluate(async () => { const PJ = await import('./js/projects.js'); await PJ.newProject(); });
  await p.setInputFiles('#file-input', { name: 'three.step', mimeType: 'application/octet-stream', buffer: Buffer.from(stepTxt) });
  await p.waitForFunction(() => StreamLine.S.doc.objects.length >= 3, null, { timeout: 120000 });
  const r14 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    const add = L.H.hist().at(-1).params.add, baked = add.filter(j => j.brepData).length;
    const back = JSON.parse(JSON.stringify(L.serialize(false))).doc.history.at(-1).params.add.map(j => j.brepData ? +K.volume(K.deserialize(j.brepData)).toFixed(3) : 0);
    const vol = id => K.volume(L.S.doc.objects.find(o => o.id === id).shape);
    // threaded bore + pin mated to it, then the bore moves in its sketch
    L.runOp(F.sketchOpNew('blk', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9500, y: 0, w: 20, h: 20 }); F.addEntity(k, { t: 'circle', c: [9510, 10], r: 3.4 }); }));
    const sk = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk, pt: [9501, 1] }], distance: 10, mode: 'new', target: null }); const blk = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: blk, n: [-1, 0, 0], w: -9513.4, p: [9513.4, 10, 5], planar: false }];
    L.runOp(F.threadOp, {});
    const t = L.S.doc.objects.find(x => x.id === blk).brep; let pt = null;
    for (let k = 0; k < t.faceOf.length && !pt; k++) { const ty = t.faces[t.faceOf[k]]?.type; if (ty && ty !== 'PLANE' && ty !== 'CYLINDRE') pt = [0, 1, 2].map(j => t.mesh.v[t.mesh.f[k][0]][j]); }
    L.runOp(F.sketchOpNew('pin', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [9600, 0], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9600, 0] }], distance: 30, mode: 'new', target: null }); const pin = L.S.doc.objects.at(-1).id;
    const rad = [pt[0] - 9510, pt[1] - 10, 0], rl = Math.hypot(...rad);
    L.runOp(F.mateOp, { a: { obj: pin, n: [1, 0, 0], p: [9603, 0, 15], planar: false }, b: { obj: blk, n: rad.map(v => -v / rl), p: pt, planar: false } });
    const ax = () => { const bb = K.worldShape(L.S.doc.objects.find(x => x.id === pin)).boundingBox.bounds; return [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2].map(v => +v.toFixed(3)); };
    const a1 = ax(); L.runOp(F.sketchOp('move bore', sk, k => { k.ents.find(e => e.t === 'circle').c = [9512, 10]; })); const a2 = ax();
    const terrs = L.H.hist().filter(r => r.err).map(r => r.err);
    // Loop on a plate's top edge, seen from above: the top outline first, then the side face's loop
    L.runOp(F.sketchOpNew('pl', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9700, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9701, 1] }], distance: 4, mode: 'new', target: null }); const pl = L.S.doc.objects.at(-1).id;
    const cam = { p: L.view.cam.pitch, y: L.view.cam.yaw }; L.view.cam.pitch = 1.2; L.view.cam.yaw = -1.2;
    L.S.ed.pick = 'edge'; L.S.ed.selected = new Set(); L.S.ed.edges = [{ obj: pl, p: [9710, 0, 4], pts: [[9700, 0, 4], [9720, 0, 4]] }]; L.refresh();
    const loop = () => { [...document.querySelectorAll('#actions button')].find(b => /Loop/.test(b.textContent)).click(); return L.S.ed.edges.map(q => +q.p[2].toFixed(3)); };
    const l1 = loop(), l2 = loop();
    L.view.cam.pitch = cam.p; L.view.cam.yaw = cam.y; L.S.ed.edges = []; L.S.ed.pick = 'solid';
    // hole grid on a bottom face; a hole row across two bosses
    L.runOp(F.sketchOpNew('bt', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9800, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9801, 1] }], distance: 5, mode: 'new', target: null }); const bt = L.S.doc.objects.at(-1).id;
    const v0 = vol(bt); L.S.ed.faces = [{ obj: bt, n: [0, 0, -1], w: 0, p: [9805, 2, 0], planar: true }];
    L.runOp(F.holeOp, { dia: 2, depth: 3, pattern: 'grid', count: 1, rows: 2, rowSpacing: 6 }); const cut1 = v0 - vol(bt);
    L.runOp(F.sketchOpNew('bb', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 9900, y: 0, w: 30, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9901, 1] }], distance: 5, mode: 'new', target: null }); const bb = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('bs', XY(5), null, k => { F.addEntity(k, { t: 'circle', c: [9905, 5], r: 3 }); F.addEntity(k, { t: 'circle', c: [9925, 5], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [9905, 5] }, { sk: L.S.ed.sketch, pt: [9925, 5] }], distance: 5, mode: 'join', target: bb });
    const v1 = vol(bb); document.querySelector('#toast').textContent = '';
    L.S.ed.faces = [{ obj: bb, n: [0, 0, 1], w: 10, p: [9905, 5, 10], planar: true }];
    L.runOp(F.holeOp, { dia: 2, depth: 3, pattern: 'row', count: 2, spacing: 20 }); L.S.ed.faces = [];
    const cut2 = v1 - vol(bb), toast2 = document.querySelector('#toast').textContent;
    return { baked, n: add.length, back, a1, a2, terrs, l1, l2, cut1, cut2, toast2, hole: Math.PI * 3 };
  });
  check(r14.baked === 3 && r14.n === 3 && r14.back.join() === '1000,1100,1200', `A 3-part STEP import keeps every part's exact solid in its history step (survives save / reload: ${r14.back.join(', ')})`);
  check(r14.a1.join() === '9510,10' && r14.a2.join() === '9512,10' && !r14.terrs.length, `A pin mated into a threaded bore follows the bore when it moves (${r14.a1} → ${r14.a2})${r14.terrs.length ? ' · ' + r14.terrs.join('; ') : ''}`);
  check(r14.l1.length === 4 && r14.l1.every(z => z === 4) && r14.l2.length === 4 && r14.l2.some(z => z !== 4), `Loop takes the face toward the viewer (top outline), Loop again the side face (${r14.l1} / ${r14.l2})`);
  check(Math.abs(r14.cut1 - 2 * r14.hole) < 1e-6, `A hole grid on a bottom face runs toward +Y (both holes cut: ${r14.cut1.toFixed(3)} mm³)`);
  check(Math.abs(r14.cut2 - 2 * r14.hole) < 1e-6 && !/outside/.test(r14.toast2), `A hole row across two bosses' tops counts both as on the part (${r14.toast2 || 'no warning'})`);
  // round 15: when an arm gets longer, a mate and a hole on its tongue's side face follow the tongue (not a slot
  // wall of about the same size nearer the old spot); Text's start point can be typed on its card
  const r15 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('arm', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 12000, y: -10, w: 100, h: 20 }); F.addEntity(k, { t: 'rect', x: 12100, y: -7.5, w: 25, h: 15 }); F.addEntity(k, { t: 'rect', x: 12070, y: 4, w: 25, h: 4 }); }));
    const sk = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk, pt: [12005, 0] }, { sk, pt: [12110, 0] }], distance: 10, mode: 'new', target: null }); const arm = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('pl', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 12300, y: 0, w: 10, h: 2 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [12301, 1] }], distance: 10, mode: 'new', target: null }); const pl = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: pl, n: [0, 1, 0], p: [12305, 2, 5], planar: true }, b: { obj: arm, n: [0, -1, 0], p: [12112, -7.5, 5], planar: true }, gap: 0.5 });
    L.S.ed.faces = [{ obj: arm, n: [0, -1, 0], w: 7.5, p: [12112.5, -7.5, 5], planar: true }]; L.runOp(F.holeOp, { dia: 3, depth: 3 }); L.S.ed.faces = [];
    const y = () => +K.worldShape(L.S.doc.objects.find(o => o.id === pl)).boundingBox.bounds[1][1].toFixed(4), hx = () => L.H.hist().filter(r => r.op === 'F.holeOp').at(-1).params.x;
    const before = [y(), hx()];
    L.runOp(F.sketchOp('longer', sk, k => { const rs = k.ents.filter(e => e.t === 'rect'); rs[0].w = 140; rs[1].x = 12140; }));
    return { before, after: [y(), hx()], errs: L.H.hist().filter(r => r.err).map(r => r.err) };
  });
  check(r15.before.join() === '-8,12112.5' && r15.after.join() === '-8,12152.5' && !r15.errs.length, `A longer arm: the mate and the hole on its tongue's side face slide with the tongue (y ${r15.after[0]}, hole x ${r15.before[1]} → ${r15.after[1]})${r15.errs.length ? ' · ' + r15.errs.join('; ') : ''}`);
  await p.evaluate(() => { const L = StreamLine; L.S.ed.pick = 'solid'; L.S.ed.faces = []; L.sketchOn({ plane: 'XY' }); L.S.ed.tool = 'text'; L.refresh(); });
  await p.waitForTimeout(500);
  const txtKey = async str => { await p.waitForTimeout(500); for (const ch of str) await p.tap(`#keypad [data-k="${ch}"]`); await p.tap('#keypad [data-k="ok"]'); await p.waitForTimeout(300); };
  await (await p.$$('#draw-card .field button.val'))[0].tap(); await txtKey('12500');
  await (await p.$$('#draw-card .field button.val'))[1].tap(); await txtKey('5');
  await p.fill('#draw-card input.textin', 'LUX'); await p.press('#draw-card input.textin', 'Enter'); await p.waitForTimeout(500);
  const txt15 = await p.evaluate(() => { const L = StreamLine, e = L.S.doc.sketches.flatMap(k => k.ents).find(x => x.t === 'text' && x.str === 'LUX'); L.S.ed.tool = 'select'; L.Draw.resetTool(); L.finishSketchEdit(); L.refresh(); return e ? e.p : null; });
  check(txt15 && txt15.join() === '12500,5', `Text: the start point can be typed on the card (${txt15})`);
  // round 16: a ring whose outer circle shrinks is found again (not dropped), and a region that is gone turns the
  // step red; a mate that conflicts leaves the part where it was; a hole tapped off-centre on a boss's end disc is
  // centred; a mirrored body keeps its name through a rollback; hiding a part keeps the Mate card; a revolve with no
  // construction line turns about the profile's own edge; STEP parts of two solids keep their names
  const r16 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, BR = L.BR, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    const out = {}, vol = id => K.volume(L.S.doc.objects.find(o => o.id === id).shape), errs = () => L.H.hist().filter(r => r.err && !r.conflict).map(r => r.err);
    L.runOp(F.sketchOpNew('ring', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [20000, 0], r: 30 }); F.addEntity(k, { t: 'circle', c: [20000, 0], r: 20 }); F.addEntity(k, { t: 'rect', x: 20100, y: 0, w: 10, h: 10 }); }));
    const sk = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk, pt: [20028, 0] }, { sk, pt: [20105, 5] }], distance: 5, mode: 'new', target: null }); const ring = L.S.doc.objects.at(-1).id;
    out.v0 = vol(ring);
    L.runOp(F.sketchOp('smaller', sk, k => { k.ents.find(e => e.t === 'circle' && e.r === 30).r = 27; }));
    out.v1 = vol(ring); out.e1 = errs();
    L.runOp(F.sketchOp('no tab', sk, k => { k.ents = k.ents.filter(e => e.t !== 'rect'); }));
    out.e2 = L.H.hist().find(r => r.op === 'F.extrude' && r.params.pts?.[0]?.sk === sk)?.err || '';
    L.undo();
    // mates: block on a base, front flush, then a face-to-face on two faces pointing the same way (conflicts)
    L.runOp(F.sketchOpNew('mb', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 21000, y: 0, w: 40, h: 40 }); F.addEntity(k, { t: 'rect', x: 21100, y: 0, w: 10, h: 10 }); }));
    const sk2 = L.S.ed.sketch;
    L.runOp(F.extrude, { pts: [{ sk: sk2, pt: [21020, 20] }], distance: 10, mode: 'new', target: null }); const base = L.S.doc.objects.at(-1).id;
    L.runOp(F.extrude, { pts: [{ sk: sk2, pt: [21105, 5] }], distance: 10, mode: 'new', target: null }); const blk = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: blk, n: [0, 0, -1], p: [21105, 5, 0], planar: true }, b: { obj: base, n: [0, 0, 1], p: [21020, 20, 10], planar: true }, gap: 0, align: 'face' });
    L.runOp(F.mateOp, { a: { obj: blk, n: [0, -1, 0], p: [21105, 0, 5], planar: true }, b: { obj: base, n: [0, -1, 0], p: [21020, 0, 5], planar: true }, gap: 0, align: 'flush' });
    const ob = () => L.S.doc.objects.find(o => o.id === blk), pose = () => [...ob().loc, ...ob().rot].map(v => +(+v).toFixed(6)).join();
    const p2 = pose();
    L.runOp(F.mateOp, { a: { obj: blk, n: [1, 0, 0], p: [21110, 5, 5], planar: true }, b: { obj: base, n: [1, 0, 0], p: [21040, 20, 5], planar: true }, gap: 0, align: 'face' });
    out.mate = { p2, p3: pose(), err: L.H.hist().filter(r => r.op === 'F.mateOp').at(-1).err || '' };
    // hiding the base keeps this Mate's card open
    BR.setVisible('obj', base, false); out.card = L.getLast()?.def === F.mateOp; out.hid = !!L.S.doc.objects.find(o => o.id === base).hidden;
    BR.setVisible('obj', base, true);
    // hole tapped off-centre (0.8 R) on a Ø8 boss's end disc
    L.runOp(F.sketchOpNew('boss', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [22000, 0], r: 4 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [22000, 0] }], distance: 10, mode: 'new', target: null }); const boss = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: boss, n: [0, 0, 1], w: 10, p: [22003.2, 0, 10], planar: true }]; L.runOp(F.holeOp, { dia: 3, depth: 4 }); L.S.ed.faces = [];
    const hp = L.H.hist().filter(r => r.op === 'F.holeOp').at(-1).params; out.hole = [hp.x, hp.y].map(v => +v.toFixed(6)).join();
    // mirrored copy renamed, rolled back past the Mirror and forward again
    L.runOp(F.sketchOpNew('half', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 23000, y: 5, w: 20, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [23010, 10] }], distance: 5, mode: 'new', target: null }); const half = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = []; L.S.ed.selected = new Set([half]); L.S.ed.active = half;
    L.runOp(F.mirrorOp, { obj: half, plane: 'y', fuse: false }); const mir = L.S.doc.objects.at(-1).id;
    L.runOp(L.OPS.setPropOp('Rename', [mir], () => { L.S.doc.objects.find(o => o.id === mir).name = 'Housing R'; }, false, true));
    BR.rollTo(L.H.hist().findIndex(r => r.op === 'F.mirrorOp')); out.gone = !L.S.doc.objects.some(o => o.id === mir);
    BR.rollTo(1e9); out.mirName = L.S.doc.objects.find(o => o.id === mir)?.name;
    // a turned profile drawn off the sketch's Y axis, as lines: revolves about its own edge
    L.runOp(F.sketchOpNew('turn', XY(0), null, k => { const P = [[24010, 0], [24015, 0], [24015, 20], [24010, 20]]; P.forEach((a, i) => F.addEntity(k, { t: 'line', a, b: P[(i + 1) % 4] })); }));
    L.runOp(F.revolve, { pts: [{ sk: L.S.ed.sketch, pt: [24012, 10] }], mode: 'new', target: null }); const rv = L.S.doc.objects.at(-1).id;
    out.rev = { axis: L.H.hist().at(-1).params.axis, v: vol(rv) };
    return out;
  });
  check(Math.abs(r16.v0 - (Math.PI * 500 * 5 + 500)) < 1e-6 && Math.abs(r16.v1 - (Math.PI * 329 * 5 + 500)) < 1e-6 && !r16.e1.length, `A ring whose outer circle shrinks is found again: ${r16.v0.toFixed(2)} → ${r16.v1.toFixed(2)} mm³${r16.e1.length ? ' · ' + r16.e1.join('; ') : ''}`);
  check(/no longer exist/.test(r16.e2), `A picked region that is gone turns the Extrude red instead of building less (${r16.e2})`);
  check(r16.mate.p3 === r16.mate.p2 && /Conflicts/.test(r16.mate.err), `A conflicting mate leaves the part where its other mates put it (${r16.mate.p2} → ${r16.mate.p3}; ${r16.mate.err})`);
  check(r16.card && r16.hid, 'Hiding a part in Items keeps the Mate card open');
  check(r16.hole === '22000,0', `A hole tapped off-centre on a boss's end disc is centred (${r16.hole})`);
  check(r16.gone && r16.mirName === 'Housing R', `A mirrored body keeps its name through a rollback (${r16.mirName})`);
  check(/^l:/.test(r16.rev.axis) && Math.abs(r16.rev.v - Math.PI * 25 * 20) < 1e-6, `Revolve with no construction line turns about the profile's own edge (${r16.rev.axis}, ${r16.rev.v.toFixed(2)} mm³)`);
  const step16 = await p.evaluate(async () => { const K = StreamLine.K, R = K.R; return R.exportSTEP([{ shape: R.makeCompound([R.makeBox([0, 0, 0], [10, 10, 10]), R.makeBox([20, 0, 0], [30, 10, 10])]), name: 'Halves', color: '#3a6ea5' }, { shape: R.makeBox([40, 0, 0], [50, 10, 10]), name: 'Trigger', color: '#a7c4a0' }], { unit: 'MM' }).text(); });
  const n16 = await p.evaluate(() => StreamLine.S.doc.objects.length);
  await p.setInputFiles('#file-input', { name: 'two.step', mimeType: 'application/octet-stream', buffer: Buffer.from(step16) });
  await p.waitForFunction(n => StreamLine.S.doc.objects.length >= n + 3, n16, { timeout: 120000 });
  const names16 = await p.evaluate(() => StreamLine.S.doc.objects.slice(-3).map(o => o.name).join(', '));
  check(names16 === 'Halves, Halves (2), Trigger', `STEP: a part made of two solids keeps its name, and so do the others (${names16})`);
  // round 17: a shell that would come out invalid (a loft between two circles) says so instead of leaving a broken
  // solid; a hex socket with its drill-point cone removes the whole socket; STEP colours are written as they look;
  // Mate by hole axes keeps the tapped faces seated
  const r17 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }), out = {};
    const shapeOf = id => L.S.doc.objects.find(x => x.id === id).shape;
    L.runOp(F.sketchOpNew('l0', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [40000, 0], r: 30 }); })); const s0 = L.S.ed.sketch;
    L.runOp(F.sketchOpNew('l1', XY(50), null, k => { F.addEntity(k, { t: 'circle', c: [40000, 0], r: 42 }); })); const s1 = L.S.ed.sketch;
    L.runOp(F.loftOp, { pts: [{ sk: s0, pt: [40000, 0] }, { sk: s1, pt: [40000, 0] }], mode: 'new', target: null }); const loft = L.S.doc.objects.at(-1).id;
    const vl = K.volume(shapeOf(loft));
    L.S.ed.faces = [{ obj: loft, n: [0, 0, 1], w: 50, p: [40000, 0, 50], planar: true }, { obj: loft, n: [0, 0, -1], w: 0, p: [40000, 0, 0], planar: true }];
    const ok = L.runOp(F.shellOp, { t: 2 }); L.S.ed.faces = [];
    out.shell = { ok, valid: K.isValid(shapeOf(loft)), v: +K.volume(shapeOf(loft)).toFixed(3), v0: +vl.toFixed(3) };
    L.runOp(F.sketchOpNew('hx', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [41000, 0], r: 9 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [41000, 0] }], distance: 12, mode: 'new', target: null }); const hx = L.S.doc.objects.at(-1).id;
    const v0 = K.volume(shapeOf(hx));
    L.S.ed.faces = [{ obj: hx, p: [41000.4, -0.3, 12], n: [0, 0, 1], w: 12, planar: true }]; L.runOp(F.recessOp, { kind: 'hex', size: 6, depth: 10, tip: true }); L.S.ed.faces = [];
    out.hex = +(v0 - K.volume(shapeOf(hx))).toFixed(3);
    const txt = await K.exportSTEP([{ shape: K.R.makeBox([0, 0, 0], [5, 5, 5]), name: 'C', color: '#b8bcc4' }, { shape: K.R.makeBox([10, 0, 0], [15, 5, 5]), name: 'D', color: '#6f7782' }], { unit: 'MM' }).text();
    const cols = [...txt.matchAll(/COLOUR_RGB\s*\(\s*'[^']*'\s*,\s*([\d.Ee+-]+)\s*,\s*([\d.Ee+-]+)\s*,\s*([\d.Ee+-]+)/g)].map(m => [m[1], m[2], m[3]].map(v => +(+v * 255).toFixed(3)).join());
    out.rgb = [...new Set(cols)].sort().join(' ');
    // two plates with Ø6 holes: B's bottom beside its rim onto A's top beside its rim, by hole axes
    L.runOp(F.sketchOpNew('pa', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 42000, y: 0, w: 30, h: 20 }); F.addEntity(k, { t: 'circle', c: [42010, 10], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [42002, 2] }], distance: 10, mode: 'new', target: null }); const A = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('pb', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 42100, y: 0, w: 20, h: 20 }); F.addEntity(k, { t: 'circle', c: [42110, 10], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [42102, 2] }], distance: 8, mode: 'new', target: null }); const B = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: B, n: [0, 0, -1], p: [42113.5, 10, 0], planar: true }, b: { obj: A, n: [0, 0, 1], p: [42013.5, 10, 10], planar: true }, gap: 0, align: 'face', by: 'axis' });
    const bb = K.worldShape(L.S.doc.objects.find(x => x.id === B)).boundingBox.bounds.map(q => q.map(v => +v.toFixed(4)));
    let ov = 0; try { const i = K.worldShape(L.S.doc.objects.find(x => x.id === A)).intersect(K.worldShape(L.S.doc.objects.find(x => x.id === B))); ov = K.isEmpty(i) ? 0 : K.volume(i); } catch (e) {}
    out.seat = { bb, overlap: +ov.toFixed(4), err: L.H.hist().filter(r => r.op === 'F.mateOp').at(-1).err || '' };
    return out;
  });
  check(!r17.shell.ok || (r17.shell.valid && r17.shell.v < r17.shell.v0 / 3), `Shell of a loft between two circles is valid or refused — never a broken solid (${JSON.stringify(r17.shell)})`);
  check(Math.abs(r17.hex - 337.924) < 0.05, `A hex socket with its drill-point cone removes the whole socket (${r17.hex} mm³, expected 337.924)`);
  check(r17.rgb === '111,119,130 184,188,196', `STEP colours are written exactly as they look, dark ones too (#6f7782 #b8bcc4 → ${r17.rgb})`);
  check(r17.seat.bb[0][0] === 42000 && r17.seat.bb[0][2] === 10 && r17.seat.overlap < 1e-6 && !r17.seat.err, `Mate by hole axes: the holes line up and the faces stay seated (${JSON.stringify(r17.seat)})`);
  // sketches on faces, Fusion-style: editing one keeps the part solid and puts the grid on the face; a sketch on a
  // free plane still ghosts the bodies
  const skf = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('slab', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 30000, y: 0, w: 40, h: 30 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [30005, 5] }], distance: 6, mode: 'new', target: null }); const id = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('on top', XY(6), { obj: id }, k => { F.addEntity(k, { t: 'circle', c: [30020, 15], r: 5 }); }));
    const fsk = L.S.ed.sketch, ground = L.S.doc.sketches.find(k => k.name.startsWith('Sketch') && k.plane.n[2] === 1 && k.plane.o[2] === 0 && !k.face)?.id;
    L.BR.editStep(L.H.hist().find(r => r.kind === 'sketch' && r.sk === fsk).id); L.refresh();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onFace = { xray: L.view.xrayFor, grid: L.view.gridPlane?.o?.[2], dark: L.view.gridDark };
    document.querySelector('#btn-finish').click(); L.refresh();
    const r2 = L.H.hist().find(r => r.kind === 'sketch' && r.sk === ground);
    if (r2) { L.BR.editStep(r2.id); L.refresh(); }
    const free = { xray: L.view.xrayFor, dark: L.view.gridDark };
    document.querySelector('#btn-finish').click(); L.refresh();
    return { onFace, free, after: L.S.ed.editingSketch, hadGround: !!r2 };
  });
  check(skf.onFace.xray === false && skf.onFace.grid === 6 && skf.onFace.dark === true && (!skf.hadGround || (skf.free.xray === true && skf.free.dark === false)) && skf.after == null,
    `Editing a sketch on a face keeps the part solid with the grid on the face; a sketch on a free plane ghosts the bodies (${JSON.stringify(skf)})`);
  // round 17 leftovers: Draft turns a round wall into a cone (and carries a fillet beside a wall along); a bolt circle
  // on a ring face goes round the face's centre at the tapped radius; turning a part about its mate axis is not
  // "held by mates" (pulling it off its mate is); the Polygon tool takes a typed centre
  const r17b = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }), m = await import('./js/ops.js');
    const out = {}, vol = id => K.volume(L.S.doc.objects.find(o => o.id === id).shape);
    L.runOp(F.sketchOpNew('cyl', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [60000, 0], r: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [60000, 0] }], distance: 30, mode: 'new', target: null }); let id = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: id, n: [1, 0, 0], p: [60020, 0, 15], planar: false }]; L.runOp(F.draftOp, { angle: 3, pull: 'z' }); m.commit();
    const r1 = 20 - 30 * Math.tan(3 * Math.PI / 180); out.cone = [vol(id), Math.PI * 10 * (400 + 20 * r1 + r1 * r1)];
    L.runOp(F.sketchOpNew('fil', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 60100, y: 0, w: 40, h: 30 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [60110, 10] }], distance: 20, mode: 'new', target: null }); id = L.S.doc.objects.at(-1).id;
    L.S.ed.edges = [{ obj: id, a: [60140, 0, 0], b: [60140, 0, 20] }]; L.runOp(F.edgeBlendOp, { kind: 'fillet', size: 5 }); m.commit(); const vb = vol(id);
    L.S.ed.faces = [{ obj: id, n: [0, -1, 0], p: [60120, 0, 10], planar: true }]; L.runOp(F.draftOp, { angle: 5, pull: 'z' }); m.commit();
    out.filletWall = { ok: !L.H.hist().at(-1).err && vol(id) < vb - 100, valid: K.isValid(L.S.doc.objects.find(o => o.id === id).shape) };
    L.runOp(F.sketchOpNew('fl', XY(0), null, k => { F.addEntity(k, { t: 'circle', c: [60300, 0], r: 40 }); F.addEntity(k, { t: 'circle', c: [60300, 0], r: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [60325, 0] }], distance: 10, mode: 'new', target: null }); id = L.S.doc.objects.at(-1).id; const v0 = vol(id);
    L.S.ed.faces = [{ obj: id, p: [60325, 5, 10], n: [0, 0, 1], w: 10, planar: true }]; L.runOp(F.holeOp, { dia: 5, depth: 0 }); m.updateOp({ pattern: 'circle', count: 6 });
    const hp = L.getLast().params; out.bolt = { c: [hp.x, hp.y, hp.z].join(), r: hp.radius, cut: v0 - vol(id) }; m.commit(); L.S.ed.faces = [];
    L.runOp(F.sketchOpNew('ma', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 60500, y: 0, w: 30, h: 20 }); F.addEntity(k, { t: 'circle', c: [60510, 10], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [60502, 2] }], distance: 10, mode: 'new', target: null }); const A = L.S.doc.objects.at(-1).id;
    L.runOp(F.sketchOpNew('mb', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 60600, y: 0, w: 20, h: 20 }); F.addEntity(k, { t: 'circle', c: [60610, 10], r: 3 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [60602, 2] }], distance: 8, mode: 'new', target: null }); const B = L.S.doc.objects.at(-1).id;
    L.runOp(F.mateOp, { a: { obj: B, n: [0, 0, -1], p: [60613.5, 10, 0], planar: true }, b: { obj: A, n: [0, 0, 1], p: [60513.5, 10, 10], planar: true }, gap: 0, align: 'face', by: 'axis' }); m.commit();
    L.S.ed.pick = 'solid'; L.S.ed.selected = new Set([B]); L.S.ed.active = B;
    L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'm', angle: 45 }); out.turn = L.getLast().heldByMate; m.commit();
    L.runOp(L.OPS.transform, { mode: 'move', x: 0, y: 0, z: 15 }); out.lift = L.getLast().heldByMate; m.commit();
    L.S.ed.selected = new Set(); L.refresh();
    return out;
  });
  check(Math.abs(r17b.cone[0] - r17b.cone[1]) < 1e-6 && r17b.filletWall.ok && r17b.filletWall.valid, `Draft turns a round wall into the exact cone (${r17b.cone[0].toFixed(3)} mm³) and takes a fillet beside a wall along`);
  check(r17b.bolt.c === '60300,0,10' && r17b.bolt.r === 25.5 && Math.abs(r17b.bolt.cut - 6 * Math.PI * 6.25 * 10) < 1e-6, `A bolt circle on a ring face goes round its centre at the tapped radius (${r17b.bolt.c} R${r17b.bolt.r}, ${r17b.bolt.cut.toFixed(3)} mm³)`);
  check(r17b.turn === false && r17b.lift === true, `Turning a part about its mate axis is not "held by mates"; lifting it off its mate is (${r17b.turn}, ${r17b.lift})`);
  await p.evaluate(() => { const L = StreamLine; L.sketchOn({ plane: 'XY' }); L.refresh(); }); await p.waitForTimeout(600);
  await p.tap('#tools .tool[data-tool=polygon]'); await p.waitForTimeout(300);
  await p.tap('#draw-card .field.ax-x .val'); await keypad('60710');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('5');
  await (await p.$$('#draw-card .field button.val')).at(-1).tap(); await keypad('10');
  const poly = await p.evaluate(() => {
    const L = StreamLine, k = L.SK.sketchById(L.S.ed.editingSketch), ls = k.ents.filter(e => e.t === 'line'), P = ls.map(e => e.a);
    const c = [0, 1].map(i => P.reduce((s, q) => s + q[i], 0) / (P.length || 1));
    const flats = ls.length ? 2 * Math.hypot((ls[0].a[0] + ls[0].b[0]) / 2 - c[0], (ls[0].a[1] + ls[0].b[1]) / 2 - c[1]) : 0;
    L.Draw.resetTool(); L.finishSketchEdit();
    return { n: ls.length, c: c.map(v => +v.toFixed(6)).join(), flats: +flats.toFixed(6) };
  });
  check(poly.n === 6 && poly.c === '60710,5' && poly.flats === 10, `Polygon: the centre can be typed on its card (${poly.n} sides round ${poly.c}, ${poly.flats} across flats)`);
  // interference: each part's solids are boxed and only overlapping ones intersected (a body of two blocks against one
  // that overlaps just the first: one pair, the exact overlap), without freezing the app
  const interf = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    L.runOp(F.sketchOpNew('ia', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 61000, y: 0, w: 20, h: 10 }); F.addEntity(k, { t: 'rect', x: 61100, y: 0, w: 20, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [61005, 5] }, { sk: L.S.ed.sketch, pt: [61105, 5] }], distance: 10, mode: 'new', target: null }); const A = L.S.doc.objects.at(-1);
    L.runOp(F.sketchOpNew('ib', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 61015, y: 0, w: 20, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [61030, 5] }], distance: 10, mode: 'new', target: null }); const B = L.S.doc.objects.at(-1);
    L.runOp(F.sketchOpNew('ic', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 61300, y: 0, w: 20, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [61305, 5] }], distance: 10, mode: 'new', target: null }); const C = L.S.doc.objects.at(-1);
    const res = await L.checkInterference([A, B, C]);
    document.querySelector('#scrim')?.click(); L.S.ed.selected = new Set(); L.refresh();
    return { solids: A.shape.solids?.length, res: res.map(x => [x.a === A.id, x.b === B.id, +x.v.toFixed(6)]) };
  });
  check(interf.solids === 2 && JSON.stringify(interf.res) === '[[true,true,500]]', `Check interference intersects only the solids whose boxes overlap: one pair, 500 mm³ (${JSON.stringify(interf.res)})`);
  // round 18: a union that crosses a revolved torus off its seam is exact, also after an earlier union was undone (the
  // stored torus stays whole); Draft starts with a pull that works; a hole tapped off-centre on a big disc stays put;
  // an offset Front plane is named by where it sits; Rotate takes a typed pivot; − first on the keypad is negative;
  // STEP colours exact (above); Select all picks bodies; a tap after the view turned is a fresh pick
  const r18 = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, K = L.K, m = await import('./js/ops.js'), out = {};
    const XZ = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] }, YZ = x => ({ o: [x, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] });
    L.runOp(F.sketchOpNew('torus', { ...XZ, o: [0, 70000, 0] }, null, k => { F.addEntity(k, { t: 'circle', c: [70, 0], r: 1.5 }); }));
    L.runOp(F.revolve, { pts: [{ sk: L.S.ed.sketch, pt: [70, 0] }], axis: 'y', mode: 'new', target: null }); m.commit(); const T = L.S.doc.objects.at(-1).id;
    const rod = ang => { L.runOp(F.sketchOpNew('rod', YZ(0), null, k => { F.addEntity(k, { t: 'circle', c: [70000, 0], r: 1.2 }); })); L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [70000, 0] }], distance: 130, mode: 'new', target: null }); m.commit();
      const id = L.S.doc.objects.at(-1).id; L.S.ed.pick = 'solid'; L.S.ed.selected = new Set([id]); L.S.ed.active = id; if (ang) { L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'z', angle: ang, pivot: [0, 70000, 0] }); m.commit(); } return id; };
    const vol = id => K.volume(L.S.doc.objects.find(o => o.id === id).shape), unite = id => { L.S.ed.pick = 'solid'; L.S.ed.selected = new Set([T, id]); L.S.ed.active = T; const ok = L.runOp(F.bodyBoolean, { kind: 'union' }); m.commit(); return ok; };
    const r0 = rod(0); unite(r0); out.u0 = vol(T); L.undo();
    const r30 = rod(30); out.ok30 = unite(r30); out.u30 = vol(T); out.err = L.H.hist().at(-1).err || '';
    // Draft on a box's top face (its normal along the default +Z pull): the card opens with a pull that works
    L.runOp(F.sketchOpNew('db', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { F.addEntity(k, { t: 'rect', x: 71000, y: 0, w: 20, h: 20 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [71010, 10] }], distance: 10, mode: 'new', target: null }); m.commit(); const db = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: db, n: [0, 0, 1], p: [71010, 10, 10], planar: true }]; const dok = L.runOp(F.draftOp, { angle: 3 }); out.draft = { ok: dok, pull: L.getLast()?.params?.pull, err: L.H.hist().at(-1).err || '' }; m.commit(); L.S.ed.faces = [];
    // a Ø200 disc: a hole tapped 50 mm off its centre stays where it was tapped; one tapped 3 mm off goes to the centre
    L.runOp(F.sketchOpNew('disc', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { F.addEntity(k, { t: 'circle', c: [72000, 0], r: 100 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [72000, 0] }], distance: 10, mode: 'new', target: null }); m.commit(); const dc = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: dc, n: [0, 0, 1], w: 10, p: [72030, -40, 10], planar: true }]; L.runOp(F.holeOp, { dia: 5, depth: 0 }); out.far = [L.getLast().params.x, L.getLast().params.y].join(); m.commit();
    L.S.ed.faces = [{ obj: dc, n: [0, 0, 1], w: 10, p: [72002, 2, 10], planar: true }]; L.runOp(F.holeOp, { dia: 5, depth: 0 }); out.near = [L.getLast().params.x, L.getLast().params.y].join(); m.commit(); L.S.ed.faces = [];
    // Rotate about a typed pivot: a 10 mm cube at x 73000 turned 90° about Z through (73000, 0, 0)
    L.runOp(F.sketchOpNew('rc', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { F.addEntity(k, { t: 'rect', x: 73010, y: 0, w: 10, h: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [73015, 5] }], distance: 10, mode: 'new', target: null }); m.commit(); const rc = L.S.doc.objects.at(-1).id;
    L.S.ed.pick = 'solid'; L.S.ed.selected = new Set([rc]); L.S.ed.active = rc;
    L.runOp(L.OPS.transform, { mode: 'rotate', axis: 'z', angle: 90 }); out.pivotFields = L.getLast().def.fields(L.getLast().params).map(f => f.label).filter(l => /Pivot/.test(l)).join();
    m.updateOp({ px: 73000, py: 0, pz: 0 }); m.commit();
    out.turned = K.worldShape(L.S.doc.objects.find(o => o.id === rc)).boundingBox.bounds.map(q => q.map(v => +v.toFixed(6)).join()).join(' ');
    L.S.ed.selected = new Set(); L.refresh();
    return out;
  });
  check(Math.abs(r18.u0 - 3684.657) < 0.05 && r18.ok30 && Math.abs(r18.u30 - 3684.657) < 0.05 && !r18.err, `Union of a revolved torus and a rod across it is exact, on its seam and off it, after an undo too (${r18.u0.toFixed(3)}, ${r18.u30.toFixed(3)} mm³)`);
  check(r18.draft.ok && r18.draft.pull !== 'z' && !r18.draft.err, `Draft on a face that looks along +Z starts with a pull that works (+${String(r18.draft.pull).toUpperCase()})`);
  check(r18.far === '72030,-40' && r18.near === '72000,0', `A hole 50 mm off a Ø200 disc's centre stays where tapped (${r18.far}); 3 mm off goes to the centre (${r18.near})`);
  check(r18.pivotFields === 'Pivot X,Pivot Y,Pivot Z' && r18.turned === '72990,10,0 73000,20,10', `Rotate takes a typed pivot (${r18.pivotFields}; turned about (73000, 0): ${r18.turned})`);
  // Select all after a face pick picks the bodies (Boolean offered); − first on the keypad starts a negative number
  await p.evaluate(() => { const L = StreamLine; L.S.ed.selected = new Set(); L.S.ed.pick = 'face'; L.S.ed.faces = [{ obj: L.S.doc.objects[0].id, n: [0, 0, 1], p: [0, 0, 0], planar: true }]; L.refresh(); });
  await p.tap('#btn-all'); await p.waitForTimeout(250);
  const sa = await p.evaluate(() => ({ pick: StreamLine.S.ed.pick, n: StreamLine.S.ed.selected.size, faces: StreamLine.S.ed.faces.length }));
  await p.tap('#btn-all'); await p.waitForTimeout(250);
  check(sa.faces === 0 && sa.pick !== 'solid', 'Select all first clears a face pick');
  const sa2 = await p.evaluate(() => ({ pick: StreamLine.S.ed.pick, n: StreamLine.S.ed.selected.size }));
  check(sa2.pick === 'solid' && sa2.n > 1 && (await ctxBar()).includes('Boolean'), `Select all then picks every body, and Boolean is offered (${sa2.pick}, ${sa2.n})`);
  await p.evaluate(() => { StreamLine.S.ed.selected = new Set(); StreamLine.refresh(); });
  await p.evaluate(async () => { const ui = await import('./js/ui.js'); window.__kpv = null; ui.openKeypad({ label: 'Test', kind: 'len', value: 12, onCommit: v => { window.__kpv = v; } }); });
  await p.waitForTimeout(500);
  for (const k of ['−', '5', 'ok']) { await p.tap(`#keypad [data-k="${k}"]`); await p.waitForTimeout(150); }
  const kpv = await p.evaluate(() => window.__kpv);
  check(kpv === -5, `On the keypad, − first on a fresh value starts a negative number (12 → ${kpv})`);
  // layout: the view tools sit in the zoom column and beside the cube (nothing over the middle of the model); the
  // Browser leaves the rail in view; a Distance result stays in the HUD; a thread's default length is at most 16
  // turns and follows the pitch until a length is typed
  const lay = await p.evaluate(() => {
    const r = q => document.querySelector(q)?.getBoundingClientRect(), vw = innerWidth;
    const snap = r('#zoombar #btn-snap'), xr = r('#zoombar #btn-xray'), home = r('#vtools-c #btn-home'), fr = r('#vtools-c #btn-frame'), pp = r('#vtools-c #btn-persp'), cube = r('#nav');
    return { inCol: !!(snap && xr), side: !!(home && fr && pp) && pp.right <= cube.left + 2 && [home, fr, pp].every(b => b.left > vw * 0.55), noMid: !document.querySelector('#vtools-r') };
  });
  check(lay.inCol && lay.side && lay.noMid, `View tools: Snap and X-ray under the zoom bar, Home / Frame / Persp beside the cube, nothing over the middle (${JSON.stringify(lay)})`);
  await p.tap('#btn-browser'); await p.waitForTimeout(450);
  const brl = await p.evaluate(() => ({ br: document.querySelector('#browser').getBoundingClientRect().left, rail: document.querySelector('#toolrail').getBoundingClientRect().right }));
  await p.tap('#btn-browser'); await p.waitForTimeout(400);
  check(brl.br >= brl.rail - 1, `The Browser opens beside the tool rail, leaving it in view (${Math.round(brl.br)} ≥ ${Math.round(brl.rail)})`);
  await p.tap('#toolsets .tset[data-set=inspect]'); await p.waitForTimeout(250);
  await p.tap('#tools .tool[data-id=dist]'); await p.waitForTimeout(250);
  await p.evaluate(() => { StreamLine.Draw.typed('0,0'); StreamLine.Draw.typed('30,40'); }); await p.waitForTimeout(3500);
  const hudD = await p.textContent('#hud');
  check(/Distance 50\.00/.test(hudD) && /ΔX 30\.00/.test(hudD), `A Distance result stays in the HUD after its toast (${hudD.slice(0, 70)})`);
  await p.tap('#toolsets .tset[data-set=solid]'); await p.waitForTimeout(250);
  const thr = await p.evaluate(async () => {
    const L = StreamLine, F = L.F, m = await import('./js/ops.js');
    L.runOp(F.sketchOpNew('rod', { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, null, k => { F.addEntity(k, { t: 'circle', c: [74000, 0], r: 10 }); }));
    L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [74000, 0] }], distance: 60, mode: 'new', target: null }); m.commit(); const id = L.S.doc.objects.at(-1).id;
    L.S.ed.faces = [{ obj: id, n: [1, 0, 0], w: 74010, p: [74010, 0, 50], planar: false }];
    L.runOp(F.threadOp, {}); const a = [L.getLast().params.pitch, L.getLast().params.length];
    m.updateOp({ pitch: 1.5 }); const b = [L.getLast().params.pitch, L.getLast().params.length, L.H.hist().at(-1).err || '']; m.commit(); L.S.ed.faces = [];
    return { a: a.join(), b: b.join() };
  });
  check(thr.a === '2.5,40' && thr.b === '1.5,24,', `A thread's default length is at most 16 turns and follows the pitch until typed (M20: ${thr.a} → ${thr.b})`);
  // the Line card switches the next segment to a tangent arc
  await p.evaluate(() => { const L = StreamLine; L.sketchOn({ plane: 'XY' }); L.refresh(); }); await p.waitForTimeout(600);
  await p.tap('#tools .tool[data-tool=line]'); await p.waitForTimeout(300);
  await p.tap('#draw-card .field.ax-x .val'); await keypad('75000');
  await p.tap('#draw-card .field.ax-y .val'); await keypad('0');
  await p.tap('#draw-card .field .val'); await keypad('20');
  await p.locator('#draw-card .seg.modebar button', { hasText: 'Tangent arc' }).tap(); await p.waitForTimeout(200);
  await (await p.$$('#draw-card .field button.val'))[1].tap(); await keypad('90');
  await (await p.$$('#draw-card .field button.val'))[0].tap(); await keypad('10');
  const arcEnts = await p.evaluate(() => { const L = StreamLine, r = L.SK.sketchById(L.S.ed.editingSketch).ents.map(e => e.t + (e.r ? ':' + (+e.r.toFixed(6)) : '')).join(); L.Draw.resetTool(); L.finishSketchEdit(); return r; });
  check(arcEnts === 'line,arc:5', `The Line card's Tangent arc makes the next segment an arc tangent to the line (${arcEnts})`);
  // touch controls: one finger never moves the view; the orientation cube turns it and the zoom bar zooms; a held
  // finger brings up the precision cursor with a magnifier and picks on release; picks get Plasticity gizmos (drag
  // to push / pull, fillet, move, rotate) with a value bubble to type into; constraint glyphs can be picked
  {
    await p.evaluate(() => { const L = StreamLine; document.querySelector('#scrim')?.click(); L.S.ed.tool = 'select'; L.S.ed.selected = new Set(); L.S.ed.faces = []; L.S.ed.edges = []; L.S.ed.drawSel = new Set(); L.S.ed.profiles = []; L.refresh(); });
    await p.evaluate(async () => { const m = await import('./js/ops.js'); m.clearLast(); });
    const tid = await p.evaluate(() => {
      const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
      L.runOp(F.sketchOpNew('tc', XY(0), null, k => { F.addEntity(k, { t: 'rect', x: 50000, y: -20, w: 60, h: 40 }); F.addEntity(k, { t: 'circle', c: [50012, 10], r: 3 }); }));
      L.runOp(F.extrude, { pts: [{ sk: L.S.ed.sketch, pt: [50002, -18] }], distance: 12, mode: 'new', target: null });
      L.S.ed.sketch = null; L.S.ed.selected = new Set(); L.refresh(); L.view.setView('iso');
      return L.S.doc.objects.at(-1).id;
    });
    await p.waitForTimeout(400); await frame([50000, -20, 0], [50060, 20, 12]); await p.waitForTimeout(700);
    const cdp2 = await ctx.newCDPSession(p);
    const touch = (type, x, y) => cdp2.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4 }] });
    const tdrag = async (a, b, n = 10) => { await touch('touchStart', a.x, a.y); for (let i = 1; i <= n; i++) { await touch('touchMove', a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n); await p.waitForTimeout(25); } await touch('touchEnd'); await p.waitForTimeout(400); };
    const tapT = async q => { await touch('touchStart', q.x, q.y); await touch('touchEnd'); await p.waitForTimeout(400); };
    const camKey = () => p.evaluate(() => { const c = StreamLine.view.cam; return [c.yaw, c.pitch, c.dist].map(v => v.toFixed(4)).join(); });
    // one finger dragged across empty space: the view stays put
    await p.waitForTimeout(600); const k0 = await camKey(); await tdrag({ x: 200, y: 560 }, { x: 290, y: 515 }); const k1 = await camKey();
    check(k0 === k1, `A one-finger drag never moves the view (${k0} → ${k1})`);
    // the orientation cube: tap its middle (the TOP face in this iso view) → top view
    const nav = await p.locator('#nav').boundingBox();
    await p.mouse.click(nav.x + nav.width / 2, nav.y + nav.height / 2 - 16); await p.waitForTimeout(500);
    const top = await p.evaluate(() => [StreamLine.view.cam.yaw, StreamLine.view.cam.pitch].map(v => Math.round(v * 180 / Math.PI)).join());
    check(top === '-90,90', `Tapping the orientation cube's TOP face gives the top view (${top})`);
    await p.evaluate(() => StreamLine.view.setView('iso')); await p.waitForTimeout(400);
    // the zoom bar: push the handle up → closer
    const zb = await p.locator('#zoombar .zb-thumb').boundingBox(), d0 = await p.evaluate(() => StreamLine.view.cam.dist);
    await p.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2); await p.mouse.down(); await p.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2 - 40, { steps: 4 }); await p.waitForTimeout(400); await p.mouse.up(); await p.waitForTimeout(300);
    const d1 = await p.evaluate(() => StreamLine.view.cam.dist);
    check(d1 < d0 * 0.95, `Pushing the zoom bar's handle up zooms in (${d0.toFixed(1)} → ${d1.toFixed(1)})`);
    await frame([50000, -20, 0], [50060, 20, 12]); await p.waitForTimeout(700);
    // hold above-left of the hole rim: the cursor rides above the finger, the magnifier names the rim, release picks it
    const rim = await projW([50015, 10, 12]);
    await touch('touchStart', rim.x, rim.y + 72 + 12); await p.waitForTimeout(450);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', rim.x, rim.y + 72 + 12 - i * 3); await p.waitForTimeout(40); }
    await p.waitForTimeout(250);
    const lp = await p.evaluate(() => ({ shown: !document.querySelector('#loupe').hidden, text: document.querySelector('#loupe .lp-label').textContent }));
    await shot('7-loupe');
    await touch('touchEnd'); await p.waitForTimeout(400);
    const rimPick = await p.evaluate(() => ({ pick: StreamLine.S.ed.pick, edges: StreamLine.S.ed.edges.length, loupe: !document.querySelector('#loupe').hidden }));
    check(lp.shown && /Edge · rim/.test(lp.text) && rimPick.pick === 'edge' && rimPick.edges === 1 && !rimPick.loupe, `Holding a finger shows the precision cursor and magnifier ("${lp.text}"); letting go picks it`);
    // a face: its push / pull arrow drags the face out, and its value bubble takes a typed value
    await p.evaluate(() => { const L = StreamLine; L.S.ed.edges = []; L.refresh(); }); await p.waitForTimeout(300);
    const v0 = await p.evaluate(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), tid);
    let q = await projW([50040, -5, 12]); await tapT(q);
    const wpp = await p.evaluate(() => StreamLine.view.worldPerPixel([50040, -5, 12]));
    const a0 = await projW([50040, -5, 12 + wpp * 84 * 0.8 * 0.6]), a1 = await projW([50040, -5, 12 + wpp * 84 * 0.8 * 0.6 + 6]);
    await tdrag(a0, a1);
    const pp = await p.evaluate(id => ({ v: StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), op: StreamLine.H.hist().at(-1).op }), tid);
    const vb = await p.evaluate(() => { const el = [...document.querySelectorAll('#labels .vlabel.val')].find(e => e.style.display !== 'none'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (vb) { await tapT(vb); await p.waitForTimeout(300); for (const kk of ['4', 'ok']) { await p.tap(`#keypad [data-k="${kk}"]`); await p.waitForTimeout(200); } await p.waitForTimeout(300); }
    const typed = await p.evaluate(id => StreamLine.K.volume(StreamLine.S.doc.objects.find(o => o.id === id).shape), tid);
    const area = 60 * 40 - Math.PI * 9;
    check(pp.op === 'F.pushPullOp' && pp.v > v0 + 1 && vb && Math.abs(typed - (v0 + area * 4)) < 1e-6, `A picked face gets a push / pull arrow to drag, and its value bubble takes a typed 4 mm (${(typed - v0).toFixed(3)} mm³)`);
    // a body (the face tapped again): move arrows and rotation arcs; dragging an arc turns it
    await p.evaluate(async () => { const m = await import('./js/ops.js'); m.clearLast(); }); await p.waitForTimeout(600);
    await p.evaluate(() => { const L = StreamLine; L.S.ed.faces = []; L.S.ed.selected = new Set(); L.refresh(); }); await p.waitForTimeout(300);
    q = await projW([50040, -5, 16]); await tapT(q); await tapT(q);
    const piv = await p.evaluate(() => StreamLine.OPS.computePivot()), s = await p.evaluate(pv => StreamLine.view.worldPerPixel(pv) * 84, piv);
    const g0 = await projW([piv[0] + s * 0.74 * Math.cos(0.45), piv[1] + s * 0.74 * Math.sin(0.45), piv[2]]), g1 = await projW([piv[0] + s * 0.74 * Math.cos(1.15), piv[1] + s * 0.74 * Math.sin(1.15), piv[2]]);
    const part = await p.evaluate(q => { const r = document.querySelector('#gl').getBoundingClientRect(); return StreamLine.gizmoPartAt(q.x - r.left, q.y - r.top); }, g0);
    await tdrag(g0, g1);
    const rot = await p.evaluate(() => { const r = StreamLine.H.hist().at(-1); return { op: r.op, mode: r.params.mode, axis: r.params.axis, angle: r.params.angle }; });
    check(part === 'arc-z' && rot.op === 'O.transform' && rot.mode === 'rotate' && rot.axis === 'z' && Math.abs(rot.angle) >= 15, `A picked body gets move arrows and rotation arcs: dragging the Z arc turns it (${JSON.stringify(rot)})`);
    await p.evaluate(async () => { const m = await import('./js/ops.js'); m.clearLast(); const L = StreamLine; L.S.ed.selected = new Set(); L.S.ed.faces = []; L.refresh(); });
    // a constraint glyph is picked like anything else, and Delete removes the constraint
    const cgSk = await p.evaluate(() => {
      const L = StreamLine, F = L.F, XY = z => ({ o: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
      L.runOp(F.sketchOpNew('cg', XY(0), null, k => { F.addEntity(k, { t: 'line', a: [50100, 0], b: [50140, 3] }); }));
      const sk = L.S.ed.sketch, id = L.SK.sketchById(sk).ents[0].id;
      L.S.ed.drawSel = new Set([id]); L.Draw.constrain('h'); L.S.ed.drawSel = new Set(); L.refresh();
      L.activateSketch(sk); // (constraint glyphs show while their sketch is open)
      return sk;
    });
    await frame([50095, -12, 0], [50145, 12, 0]); await p.waitForTimeout(600);
    const glyph = await p.evaluate(() => { const el = [...document.querySelectorAll('#labels .vlabel.cons')].find(e => e.style.display !== 'none'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (glyph) await tapT(glyph);
    let cs = await p.evaluate(() => StreamLine.Draw.consSelected()), retried = false;
    if (glyph && !cs) { // (diagnose a miss, then try once more — the check says so)
      retried = true;
      const dg = await p.evaluate(() => { const L = StreamLine, g = document.querySelector('#gl').getBoundingClientRect(); return { glyphs: (L.Draw.st?.consLabels || []).map(c => [Math.round(c.x + g.left), Math.round(c.y + g.top)]), offY: L.view.offsetY, hud: document.querySelector('#hud').textContent.slice(0, 40), lastop: document.querySelector('#lastop').textContent.slice(0, 40), ed: L.S.ed.editingSketch, sk: L.S.ed.sketch, tool: L.S.ed.tool, pick: L.S.ed.pick, lock: L.S.ed.pickLock, consTool: L.S.ed.consTool, sel: [...L.S.ed.drawSel], kp: !!document.querySelector('#keypad.open'), pop: !!document.querySelector('#popover:not([hidden])'), card: !document.querySelector('#lastop').hidden, top: document.elementFromPoint(0, 0) && 0 }; });
      console.log('glyph miss', JSON.stringify(glyph), JSON.stringify(dg), await p.evaluate(g => document.elementFromPoint(g.x, g.y)?.id || document.elementFromPoint(g.x, g.y)?.className, glyph));
      await shot('glyph-miss');
      await p.waitForTimeout(500); await tapT(glyph); cs = await p.evaluate(() => StreamLine.Draw.consSelected());
    }
    if (cs) { await p.locator('#actions .act', { hasText: 'Delete' }).tap(); await p.waitForTimeout(300); }
    const consLeft = await p.evaluate(sk => (StreamLine.SK.sketchById(sk).cons || []).length, cgSk);
    check(glyph && cs && cs.t === 'h' && consLeft === 0, `A tap on a constraint glyph picks the constraint, and Delete removes it (${cs && cs.t}, ${consLeft} left${retried ? ' — after a second tap' : ''})`);
    await p.evaluate(() => StreamLine.finishSketchEdit()); await p.waitForTimeout(300);
  }
  // Look: theme, lighting, surface and edge width from the top bar's Look button
  await p.tap('#btn-look'); await p.waitForTimeout(400);
  const lookBtn = async txt => { await p.locator('#popover .swatch', { hasText: txt }).first().tap(); await p.waitForTimeout(250); };
  await lookBtn('Daylight'); // (the theme swatch comes first)
  await lookBtn('Showroom');
  await p.locator('#popover .seg button', { hasText: 'Metal' }).tap(); await p.waitForTimeout(250);
  const look = await p.evaluate(() => { const L = StreamLine; let mesh = null; L.view.scene.traverse(o => { if (!mesh && o.isMesh && o.userData.objId != null) mesh = o; });
    return { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, set: [L.S.settings.theme, L.S.settings.lighting, L.S.settings.finish].join(), env: !!L.view.scene.environment, metal: mesh?.material.metalness, sel: L.view.theme.sel }; });
  check(look.theme === 'daylight' && look.bg === 'rgb(233, 237, 243)' && look.set === 'daylight,showroom,metal' && look.env && look.metal > 0.8, `Look: Daylight theme, Showroom lighting and Metal surface apply (${JSON.stringify(look)})`);
  // edges: the same pixel width at any zoom, or scaled with zoom
  const edgeW = async (scale, k) => p.evaluate(async ([scale, k]) => { const L = StreamLine; L.S.settings.edgeScale = scale; L.S.settings.edgeWidth = 'normal';
    const d0 = L.view.cam.dist; L.view.cam.dist = d0 * k; L.view.render(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    let w = null; L.view.scene.traverse(o => { if (w == null && o.material?.isLineMaterial && o.material.userData.model && o.visible) w = o.material.linewidth; }); L.view.cam.dist = d0; L.view.render(); return w; }, [scale, k]);
  // (framed on everything shown: the zoom factor is 1 there)
  await p.evaluate(() => { const L = StreamLine, W = L.S.doc.objects.filter(L.isShown).flatMap(o => { let b = null; try { b = o.shape && L.K.worldShape(o).boundingBox.bounds; } catch (e) {} return b ? [b[0], b[1]] : [o.loc]; }); L.view.frame(W); });
  await p.waitForTimeout(1000);
  const ws = [await edgeW('screen', 0.5), await edgeW('screen', 2), await edgeW('zoom', 0.5), await edgeW('zoom', 2)];
  check(ws[0] === ws[1] && ws[2] > ws[3] * 3, `Edges stay the same width on screen, or scale with zoom when asked (${ws.map(v => v?.toFixed(2)).join(', ')})`);
  await p.evaluate(() => document.querySelector('#scrim')?.click());
  await p.evaluate(() => { const L = StreamLine; Object.assign(L.S.settings, { theme: 'midnight', lighting: 'studio', finish: 'satin', edgeScale: 'screen' }); delete document.documentElement.dataset.theme; L.view.setLook(); L.refresh(); });
  await shot('5-timeline');
} catch (e) {
  await p.screenshot({ path: OUT + 'crash.png' }).catch(() => {});
  check(false, 'test crashed: ' + e.message.split('\n').slice(0, 8).join(' / '));
}
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); srv.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);

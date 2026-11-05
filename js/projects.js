// Projects on this device and assemblies: autosave into the library, open / new / duplicate / rename /
// delete, insert another project as a linked component, and sync components when their source changed.
import { S, emit } from './state.js';
import { serialize, deserialize, objMatrix } from './scene.js';
import { runOp, resetHistory } from './ops.js';
import * as H from './history.js';
import * as K from './kernel.js';
import * as F from './features.js';
import * as LIB from './library.js';
import { I } from './icons.js';
import { h, toast, popover, closePopover, menuItem } from './ui.js';
import { askText, confirmPop } from './browser.js';

let ctx = null; // { view, refresh, frameAll, afterLoad, toggleSheet, renderSheet }
let known = new Map(); // pid → { version, name, updated } (the library, for "update available")
export function initProjects(c) { ctx = c; refreshKnown(); }
export async function refreshKnown() { try { known = new Map((await LIB.list()).map(r => [r.id, r])); } catch (e) { known = new Map(); } emit('library'); }
export const libraryInfo = pid => known.get(pid);
export function ensureProject() { if (!S.doc.project) S.doc.project = { id: LIB.newId(), name: 'Untitled', created: Date.now() }; return S.doc.project; }
export const projectName = () => S.doc.project?.name || 'Untitled';

// the project's solids as one exact shape (what other projects insert)
function exportShape() {
  const solids = S.doc.objects.filter(o => o.shape && !o.hidden).map(o => K.worldShape(o).clone()); // clone: compounds consume their inputs
  if (!solids.length) return null;
  return solids.length === 1 ? solids[0] : K.R.makeCompound(solids);
}
// the project's parts, named and coloured (sub-assemblies expanded: "Seat / Slat"), for STEP export of
// assemblies that contain this project
export function partsOf(o, prefix = '') {
  const c = o.link && (S.doc.components || {})[o.link.pid];
  if (c && c.parts && c.parts.length > 1) return c.parts.map(pt => ({ name: `${prefix}${o.name} / ${pt.name}`, color: pt.color, shape: () => K.transformShape(K.deserialize(pt.brep), objMatrix(o)) }));
  return [{ name: prefix + o.name, color: o.color, shape: () => K.worldShape(o).clone() }];
}
function exportParts() {
  return S.doc.objects.filter(o => o.shape && !o.hidden).flatMap(o => partsOf(o)).map(pt => ({ name: pt.name, color: pt.color, brep: K.serialize(pt.shape()) }));
}
const sigCache = new WeakMap();
const shapeSig = sh => { let v = sigCache.get(sh); if (!v) { v = [K.volume(sh), K.area(sh)]; sigCache.set(sh, v); } return v; };
let saveT = 0, saving = null;
export function scheduleLibrarySave() { clearTimeout(saveT); saveT = setTimeout(() => saveNow(), 1500); }
export async function saveNow() {
  clearTimeout(saveT);
  if (saving) await saving;
  const pr = ensureProject();
  saving = (async () => {
    try {
      const prev = await LIB.get(pr.id);
      // the version only moves when the exported solids changed, so assemblies only see real updates. A rebuild can
      // serialize the same solids a little differently, so compare their geometry (volume, area per part, placement),
      // measured once per shape — and only build and serialize the export when that changed (big assemblies are slow)
      const sig = S.doc.objects.filter(o => o.shape && !o.hidden).map(o => [...shapeSig(o.shape), ...o.loc, ...o.rot, ...o.scl].map(v => (+v).toFixed(5)).join(',')).join('|');
      const changed = !prev || prev.sig !== sig;
      const shp = changed ? exportShape() : null, brep = changed ? (shp ? K.serialize(shp) : null) : prev.exportBrep;
      const parts = changed ? exportParts() : prev.parts || null;
      const rec = { id: pr.id, name: pr.name, created: prev?.created || pr.created || Date.now(), updated: changed || !prev ? Date.now() : prev.updated, version: changed ? (prev?.version || 0) + 1 : prev.version,
        data: JSON.stringify(serialize(false)), exportBrep: brep, parts, sig, /* full solids: opening needs no rebuild (fast) */ thumb: ctx?.view?.thumbnail?.() || prev?.thumb || null,
        bodies: S.doc.objects.filter(o => o.shape).length };
      await LIB.put(rec);
      known.set(rec.id, { id: rec.id, name: rec.name, version: rec.version, updated: rec.updated, thumb: rec.thumb });
    } catch (e) { console.warn('library save failed', e); }
  })();
  await saving; saving = null;
}

export async function openProject(id) {
  if (S.doc.project?.id === id) return;
  await saveNow();
  const rec = await LIB.get(id); if (!rec) { toast('That project is gone'); return; }
  deserialize(rec.data);
  if (S.doc.objects.some(o => o.regen)) { H.resetCache(); H.regenerate(0); for (const o of S.doc.objects) delete o.regen; }
  S.doc.project = { id: rec.id, name: rec.name, created: rec.created };
  resetHistory(); ctx.closeSheet?.(); ctx.afterLoad(); toast(`Opened “${rec.name}”`);
}
export async function newProject() {
  await saveNow();
  ctx.newScene();
  S.doc.project = { id: LIB.newId(), name: nextName(), created: Date.now() };
  await saveNow(); await refreshKnown(); toast(`New project “${S.doc.project.name}”`);
}
function nextName() { let n = 1; const names = new Set([...known.values()].map(r => r.name)); while (names.has(`Project ${n}`)) n++; return `Project ${n}`; }

// ---------- assemblies ----------
export async function insertProject(id) {
  if (id === S.doc.project?.id) { toast('A project cannot contain itself'); return; }
  const rec = await LIB.get(id);
  if (!rec || !rec.exportBrep) { toast('That project has no solids yet'); return; }
  if (S.doc.project && await containsProject(rec, S.doc.project.id)) { toast('That project already contains this one (directly or inside one of its parts) — inserting it would loop'); return; }
  const def = { ...F.insertComponent, prepare(p) { S.doc.components = { ...(S.doc.components || {}), [id]: { name: rec.name, version: rec.version, brep: rec.exportBrep, parts: rec.parts || null } }; return F.insertComponent.prepare(p); } };
  def.opName = F.insertComponent.opName; // recorded as the normal insert step
  if (runOp(def, { pid: id })) { ctx.closeSheet?.(); toast(`Inserted “${rec.name}” — drag it with Move, or type its position`); ctx.refresh(); }
}
// does a saved project contain `target` anywhere down its tree of linked components?
async function containsProject(rec, target, seen = new Set()) {
  if (!rec || seen.has(rec.id)) return false; seen.add(rec.id);
  let comps = {}; try { comps = JSON.parse(rec.data).doc.components || {}; } catch (e) { return false; }
  for (const pid of Object.keys(comps)) {
    if (pid === target) return true;
    if (await containsProject(await LIB.get(pid), target, seen)) return true;
  }
  return false;
}
// bring a linked component up to its source project's latest saved version
export async function syncComponent(pid) {
  const rec = await LIB.get(pid);
  if (!rec) { toast('Its project was deleted on this device — the component keeps its last version'); return; }
  const cur = (S.doc.components || {})[pid];
  if (cur && cur.version === rec.version) { toast(`“${rec.name}” is up to date`); return; }
  if (!rec.exportBrep) { toast('Its project has no solids now'); return; }
  runOp({
    label: () => `Sync ${rec.name}`, noRecord: true, touch: () => 'all',
    apply() {
      S.doc.components = { ...(S.doc.components || {}), [pid]: { name: rec.name, version: rec.version, brep: rec.exportBrep, parts: rec.parts || null } };
      const i = H.hist().findIndex(r => r.op === 'F.insertComponent' && r.params?.pid === pid);
      if (i < 0) return 'Component step missing';
      H.invalidate(i); H.regenerate(i);
      for (const o of S.doc.objects) if (o.link?.pid === pid) o.name = rec.name;
    },
  });
  toast(`Synced “${rec.name}” to its latest version`);
}
export function outOfDate(pid) { const k = known.get(pid), c = (S.doc.components || {})[pid]; return !!(k && c && k.version !== c.version); }
export async function openSource(pid) { if (!known.has(pid)) { toast('Its project is not on this device'); return; } await openProject(pid); }

// ---------- the Projects panel ----------
const when = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function projectsTab(group) {
  const cur = ensureProject();
  const wrap = h('div', {});
  const nameIn = h('input', { class: 'textin', value: cur.name, enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false' });
  nameIn.addEventListener('change', async () => { const n = nameIn.value.trim(); if (n && n !== cur.name) { cur.name = n; await saveNow(); refreshKnown(); } });
  nameIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') nameIn.blur(); });
  wrap.append(group('This project', nameIn,
    h('div', { class: 'btnrow', style: 'justify-content:flex-start;flex-wrap:wrap' },
      h('button', { class: 'btn primary', onclick: async () => { await saveNow(); await refreshKnown(); toast('Saved on this device'); } }, 'Save now'),
      h('button', { class: 'btn', onclick: () => newProject() }, 'New project'),
      h('button', { class: 'btn', onclick: async () => { await saveNow(); const c = await LIB.duplicate(cur.id); await refreshKnown(); toast(`Duplicated as “${c.name}”`); } }, 'Duplicate')),
    h('p', { class: 'note' }, 'Projects save on this device automatically. Insert one project into another to build an assembly; when the inserted project changes, select it and tap Sync.')));
  const listEl = h('div', { class: 'projgrid' }, h('p', { class: 'note' }, 'Loading…'));
  wrap.append(group('On this device', listEl));
  LIB.list().then(rows => {
    known = new Map(rows.map(r => [r.id, r]));
    if (!rows.length) { listEl.replaceChildren(h('p', { class: 'note' }, 'No saved projects yet.')); return; }
    listEl.replaceChildren(...rows.map(r => {
      const isCur = r.id === cur.id;
      const card = h('button', { class: 'projcard' + (isCur ? ' cur' : '') },
        r.thumb ? h('img', { src: r.thumb, alt: '' }) : h('div', { class: 'nothumb', html: I.cube }),
        h('div', { class: 'pname' }, r.name), h('div', { class: 'pmeta' }, (isCur ? 'Open now · ' : '') + when(r.updated)));
      card.onclick = () => projectMenu(card, r, isCur);
      return card;
    }));
  });
  return [wrap];
}
function projectMenu(anchor, r, isCur) {
  popover(anchor, h('div', {},
    h('div', { class: 'mtitle' }, r.name),
    !isCur ? menuItem(I.folder, 'Open', () => openProject(r.id)) : null,
    !isCur ? menuItem(I.plus, r.hasSolids ? 'Insert into this project' : 'Insert (no solids yet)', () => insertProject(r.id)) : null,
    menuItem(I.sliders, 'Rename…', () => setTimeout(() => askText(anchor, 'Rename project', r.name, n => LIB.rename(r.id, n).then(() => { if (isCur) S.doc.project.name = n; refreshKnown(); ctx.renderSheet(); })), 0)),
    menuItem(I.dup, 'Duplicate', () => LIB.duplicate(r.id).then(() => { refreshKnown(); ctx.renderSheet(); })),
    !isCur ? h('div', { class: 'msep' }) : null,
    !isCur ? menuItem(I.trash, 'Delete…', () => setTimeout(() => confirmPop(anchor, `Delete “${r.name}”?`, 'It is removed from this device. Assemblies that use it keep their last synced copy.', 'Delete', () => LIB.remove(r.id).then(() => { refreshKnown(); ctx.renderSheet(); })), 0)) : null,
  ));
}

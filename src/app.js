'use strict';
window.addEventListener('error', e => window.__TAURI__?.core.invoke('dev_log', { msg: `${e.message} @${e.lineno}` }));
window.addEventListener('unhandledrejection', e => window.__TAURI__?.core.invoke('dev_log', { msg: 'rejection: ' + (e.reason && (e.reason.stack || e.reason)) }));
const S = window.MaqtoShared, G = window.MaqtoGraph, I18N = window.MaqtoI18n, ICONS = window.MaqtoIcons;
const interchange = window.MaqtoInterchange;
// names of the rich clip animations (anims.js) and their groups
for (const [id, ar, en] of MaqtoAnims.NAMES) { I18N.ar['an_' + id] ??= ar; I18N.en['an_' + id] ??= en; }
for (const [id, ar, en] of [['basic', 'أساسي', 'Basic'], ...MaqtoAnims.CATS]) { I18N.ar['ac_' + id] = ar; I18N.en['ac_' + id] = en; }
// the two sample photos (trpics/) shown on transition, filter, effect and layer cards
const trImgs = ['a', 'b'].map(n => Object.assign(new Image(), { src: 'trpics/' + n + '.jpg' }));
for (const [id, p] of Object.entries(S.PRESETS)) if (p.en) { I18N.en['p_' + id] = I18N.en['p_' + id] || p.en; I18N.ar['p_' + id] = I18N.ar['p_' + id] || p.ar; } // filter names live with the filters
for (const [id, , , en, ar] of window.MaqtoGLT.LIST) if (en) { I18N.en['tr_' + id] = en; I18N.ar['tr_' + id] = ar; } // so do the newer transition names
for (const f of S.FXG) { I18N.en['fx_' + f.id] = f.en; I18N.ar['fx_' + f.id] = f.ar; } // and the formula effects'
Object.assign(I18N.en, { trc_geo: 'Patterns', fxc_color: 'Colour', fxc_light: 'Light', fxc_overlay: 'Overlays' }); Object.assign(I18N.ar, { trc_geo: 'أنماط', fxc_color: 'ألوان', fxc_light: 'إضاءة', fxc_overlay: 'طبقات فوق' });
const TA = window.__TAURI__;
const inv = TA.core.invoke;
const { clamp, num } = S;
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function paintRange(input) {
  const min = Number(input.min), max = Number(input.max);
  input.style.setProperty('--range-fill', max > min ? (input.valueAsNumber - min) / (max - min) : 0);
}
document.addEventListener('input', e => {
  if (e.target.type === 'range') paintRange(e.target);
});
$$('input[type=range]').forEach(paintRange);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="ic" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const IS_MAC = /Mac/.test(navigator.userAgent);
const AI_TOOLS_NEW = true;
const seenVersionKey = 'kadr.seenVersion';
// Startup persists language and workspace defaults even on a fresh install.
const hasOldMaqtoState = (() => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('kadr.') && key !== seenVersionKey) return true;
    }
  } catch {}
  return false;
})();
if (IS_MAC) document.documentElement.classList.add('mac');

const ASPECTS = Object.fromEntries(['9:16', '16:9', '1:1', '4:5', '4:3', '3:4', '21:9'].map(r => [r, dimsFor(r)]));
/* ---------- fonts: bundled Google set, the rest of Google Fonts on demand, and this computer's own fonts ---------- */
const FONT_CAT = window.FONT_CAT || []; // [family, category letter, flags: a = Arabic, b = bundled]
const fontCatalog = new Map(FONT_CAT.map(c => [c[0], c]));
const FontLib = { sys: new Map(), dl: {}, tried: new Set() };
const FW = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };
function regFont(fam, files) {
  for (const f of files) {
    const n = f.split(/[\\/]/).pop(), w = /\[|VariableFont/.test(n) ? '100 900' : String(FW[(n.match(/-([A-Za-z]+)\.ttf$/) || [])[1]] || 400);
    const ff = new FontFace(fam, `url("${MEDIA_BASE + encodeURIComponent(f)}")`, { weight: w });
    document.fonts.add(ff);
    ff.load().then(() => (needsDraw = true)).catch(() => {});
  }
  FontLib.dl[fam] = files;
}
const fontReady = f => FontLib.sys.has(f) || !!FontLib.dl[f] || !fontCatalog.has(f) || fontCatalog.get(f)[2].includes('b');
async function fetchFont(f) {
  const files = await inv('font_fetch', { family: f });
  regFont(f, files);
  await document.fonts.load(`400 40px "${f}"`).catch(() => {});
}
// OpenType collection directories point into the whole file. Repack one face with its own offsets and checksum.
function unpackFontFace(buffer, index) {
  const source = new DataView(buffer);
  if (source.getUint32(0) !== 0x74746366 || index >= source.getUint32(8)) throw new Error('Invalid font collection');
  const start = source.getUint32(12 + index * 4), tables = [];
  for (let i = 0; i < source.getUint16(start + 4); i++) {
    const record = start + 12 + i * 16, tag = source.getUint32(record);
    if (tag === 0x44534947) continue; // DSIG no longer applies to the extracted face
    const data = new Uint8Array(buffer, source.getUint32(record + 8), source.getUint32(record + 12));
    tables.push({ tag, checksum: source.getUint32(record + 4), data });
  }
  const directorySize = 12 + tables.length * 16;
  const size = tables.reduce((total, { data }) => total + Math.ceil(data.length / 4) * 4, directorySize);
  if (!tables.length || size > buffer.byteLength + directorySize + tables.length * 3) throw new Error('Invalid face directory');
  const bytes = new Uint8Array(size), out = new DataView(bytes.buffer);
  const selector = Math.floor(Math.log2(tables.length)), searchRange = 16 * 2 ** selector;
  out.setUint32(0, source.getUint32(start));
  out.setUint16(4, tables.length);
  out.setUint16(6, searchRange);
  out.setUint16(8, selector);
  out.setUint16(10, tables.length * 16 - searchRange);
  let offset = directorySize, adjustment;
  tables.forEach(({ tag, checksum, data }, i) => {
    const record = 12 + i * 16;
    out.setUint32(record, tag);
    out.setUint32(record + 4, checksum);
    out.setUint32(record + 8, offset);
    out.setUint32(record + 12, data.length);
    bytes.set(data, offset);
    if (tag === 0x68656164 && data.length >= 12) {
      adjustment = offset + 8;
      out.setUint32(adjustment, 0);
    }
    offset += Math.ceil(data.length / 4) * 4;
  });
  if (adjustment === undefined) throw new Error('Missing font header');
  let sum = 0;
  for (let i = 0; i < size; i += 4) sum = (sum + out.getUint32(i)) >>> 0;
  out.setUint32(adjustment, (0xb1b0afba - sum) >>> 0);
  return bytes;
}
// One fetch per collection file, kept for the next faces of the same .ttc (a few at most: they can be tens of MB).
const collectionReads = new Map();
function systemFontSource(file) {
  const url = MEDIA_BASE + encodeURIComponent(file.path);
  if (!file.collection) return `url("${url}")`;
  let read = collectionReads.get(url);
  if (read) collectionReads.delete(url);
  else read = fetch(url).then(res => {
    if (!res.ok) throw new Error('Could not read font collection');
    return res.arrayBuffer();
  });
  collectionReads.set(url, read);
  read.catch(() => collectionReads.delete(url));
  if (collectionReads.size > 4) collectionReads.delete(collectionReads.keys().next().value);
  return read.then(data => unpackFontFace(data, file.index));
}
function loadCollectionFonts(family) {
  const font = FontLib.sys.get(family);
  if (!font?.files.some(file => file.collection)) return;
  return font.collectionLoad ??= Promise.allSettled(font.files.filter(file => file.collection).map(async file => {
    const face = new FontFace(family, await systemFontSource(file), { weight: String(file.weight), style: file.italic ? 'italic' : 'normal' });
    document.fonts.add(face);
  })).then(() => { needsDraw = true; });
}
let fontPreviewId = 0;
// Preview faces live in document.fonts only while recent: past 150 the oldest is released and its row reloads on scroll-in.
const previewLru = new Map();
function keepPreview(font, face) {
  previewLru.delete(font);
  previewLru.set(font, face);
  if (previewLru.size <= 150) return;
  const [old, oldFace] = previewLru.entries().next().value;
  previewLru.delete(old);
  document.fonts.delete(oldFace);
  old.preview = null;
}
async function loadSystemPreview(font) {
  const family = 'maqto-system-preview-' + ++fontPreviewId;
  for (const file of font.previewFiles) {
    try {
      const face = await new FontFace(family, await systemFontSource(file)).load();
      document.fonts.add(face);
      return { family, sample: file.sample, face };
    } catch { /* try another face in this family */ }
  }
  return null;
}
// A project that uses a library font this computer hasn't downloaded yet fetches it quietly.
function ensureFonts() {
  for (const it of P.items) {
    const f = isText(it) && it.style && it.style.font;
    if (FontLib.sys.has(f)) loadCollectionFonts(f);
    else if (f && !fontReady(f) && !FontLib.tried.has(f)) { FontLib.tried.add(f); fetchFont(f).then(() => { needsDraw = true; }).catch(e => inv('dev_log', { msg: 'font ' + f + ': ' + e })); }
  }
}
// Canvas draws with a fallback until a face is loaded: ask for it once, then redraw.
const fontAsked = new Set();
function wantFont(spec) {
  if (fontAsked.has(spec) || document.fonts.check(spec)) return;
  fontAsked.add(spec);
  document.fonts.load(spec).then(() => (needsDraw = true)).catch(() => {});
}
const FONT_ROW_HEIGHT = 28, FONT_ROW_BUFFER = 5;
function fontPickerRange(count, scrollTop, height, buffer = 0) {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / FONT_ROW_HEIGHT) - buffer));
  const end = Math.min(count, Math.ceil((scrollTop + height) / FONT_ROW_HEIGHT) + buffer);
  return [first, Math.max(first, end)];
}
let fontTab = 'all';
function fontPicker(it) {
  // compact dropdown under the font button; closes on outside click or Esc
  if ($('#fpop')) return closeFontPop();
  const pop = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'fpop' }));
  pop.innerHTML = `<div class="fpq">${icon('search')}<input id="fpQ" type="search" role="combobox" aria-label="${tr('fontSearch')}" aria-controls="fpRows" aria-expanded="true" aria-autocomplete="list" placeholder="${tr('fontSearch')}" dir="auto"></div>
    <div class="ftabs">${[['all'], ['fav', 'star'], ['sys', 'monitor'], ['recent', 'history'], ['lib']].map(([x, ic]) => `<button data-ft="${x}" class="${x === fontTab ? 'on' : ''}${ic ? ' fti' : ''}" title="${tr('ft_' + x)}">${ic ? icon(ic) : tr('ft_' + x)}</button>`).join('')}</div>
    <div id="fpL" class="fpl"><div id="fpRows" class="fpRows" role="listbox" aria-label="${tr('ft_' + fontTab)}"></div><p class="hint" hidden>${tr('fontNone')}</p></div><p class="fpn">${tr('fontNote')}</p>`;
  const r = $('#fontBtn').getBoundingClientRect(), w = 300, h = 420;
  pop.style.left = clamp(r.right - w, 8, innerWidth - w - 8) + 'px';
  pop.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  pop.style.setProperty('--font-row-height', FONT_ROW_HEIGHT + 'px');
  const input = pop.querySelector('#fpQ'), list = pop.querySelector('#fpL'), spacer = pop.querySelector('#fpRows');
  const empty = list.querySelector('.hint'), cur = it.style.font;
  let rows = [], favs = new Set(), active = -1, frame = 0, busy = null;
  const mounted = new Map();

  const paint = () => {
    const [first, end] = fontPickerRange(rows.length, list.scrollTop, list.clientHeight, FONT_ROW_BUFFER);
    const [visibleFirst, visibleEnd] = fontPickerRange(rows.length, list.scrollTop, list.clientHeight);
    for (const [i, row] of mounted) if (i < first || i >= end) { row.remove(); mounted.delete(i); }
    let next = spacer.firstElementChild;
    for (let i = first; i < end; i++) {
      const [family, kind] = rows[i];
      let row = mounted.get(i);
      if (!row) {
        row = document.createElement('div');
        row.className = 'fr' + (family === cur ? ' on' : '');
        row.id = 'fpRow-' + i;
        row.dataset.index = i;
        row.style.top = i * FONT_ROW_HEIGHT + 'px';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', family === cur);
        row.setAttribute('aria-posinset', i + 1);
        row.setAttribute('aria-setsize', rows.length);
        row.innerHTML = `<span class="fn" dir="auto">${esc(family)}</span><span class="fs" dir="auto">${kind === 'sys' ? '' : 'أبجد Aa'}</span>${kind === 'dl' ? icon('download') : ''}<button class="fv${favs.has(family) ? ' on' : ''}" data-fav title="${tr('ft_fav')}" aria-pressed="${favs.has(family)}">${icon('star')}</button>`;
        spacer.insertBefore(row, next);
        mounted.set(i, row);
      }
      next = row.nextElementSibling;
      row.classList.toggle('key-focus', i === active);
      row.classList.toggle('busy', family === busy);
      if (i < visibleFirst || i >= visibleEnd || row.dataset.preview || kind === 'dl') continue;
      row.dataset.preview = 'started';
      if (kind === 'sys') {
        const font = FontLib.sys.get(family), sample = row.querySelector('.fs');
        font.preview ??= loadSystemPreview(font);
        if (previewLru.has(font)) keepPreview(font, previewLru.get(font));
        font.preview.then(preview => {
          if (preview && !previewLru.has(font) && font.preview) keepPreview(font, preview.face);
          if (!sample.isConnected) return;
          sample.textContent = preview?.sample ?? tr('fontNoPreview');
          if (preview) sample.style.fontFamily = preview.family;
          else sample.classList.add('no-preview');
        });
      } else {
        for (const label of row.querySelectorAll('.fn, .fs')) label.style.fontFamily = `"${family}", Cairo`;
      }
    }
    if (mounted.has(active)) input.setAttribute('aria-activedescendant', mounted.get(active).id);
    else input.removeAttribute('aria-activedescendant');
  };
  const revealActive = () => {
    const top = active * FONT_ROW_HEIGHT;
    if (active >= 0 && top < list.scrollTop) list.scrollTop = top;
    if (active >= 0 && top + FONT_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + FONT_ROW_HEIGHT - list.clientHeight;
    paint();
  };
  const updateList = (reset = false) => {
    const q = input.value.trim().toLowerCase(), activeFamily = rows[active]?.[0];
    favs = new Set(lsGet('kadr.favFonts', []));
    const kind = f => FontLib.sys.has(f) ? 'sys' : fontReady(f) ? 'ok' : 'dl';
    if (fontTab === 'sys') rows = Array.from(FontLib.sys.keys(), f => [f, 'sys']);
    else if (fontTab === 'fav' || fontTab === 'recent') rows = [...(fontTab === 'fav' ? favs : lsGet('kadr.recentFonts', []))].map(f => [f, kind(f)]);
    else {
      rows = FONT_CAT.filter(([f]) => fontTab === 'lib' ? !fontReady(f) : !FontLib.sys.has(f))
        .map(([f, , flags]) => [f, kind(f), flags.includes('a')]);
      if (fontTab === 'all') {
        for (const [f, font] of FontLib.sys) rows.push([f, 'sys', font.arabic]);
        rows.sort((a, b) => (a[1] === 'dl') - (b[1] === 'dl') || b[2] - a[2]);
      }
    }
    if (q) rows = rows.filter(([f]) => f.toLowerCase().includes(q));
    active = reset || !activeFamily ? -1 : rows.findIndex(([f]) => f === activeFamily);
    mounted.clear();
    spacer.replaceChildren();
    spacer.style.height = rows.length * FONT_ROW_HEIGHT + 'px';
    empty.hidden = !!rows.length;
    if (reset) list.scrollTop = 0;
    paint();
  };
  const selectFont = async f => {
    if (busy !== null) return;
    busy = f;
    paint();
    try {
      if (!fontReady(f)) await fetchFont(f);
      await loadCollectionFonts(f);
    } catch (er) {
      busy = null;
      paint();
      return toast(tr('fontFail') + ' ' + (er.message || er));
    }
    snapshot();
    it.style.font = f;
    lsSet('kadr.recentFonts', [f, ...lsGet('kadr.recentFonts', []).filter(x => x !== f)]);
    const restoreFocus = pop.contains(document.activeElement);
    if (pop.isConnected) closeFontPop();
    await document.fonts.load(`${it.style.weight || 400} 40px "${f}"`).catch(() => {});
    refresh();
    if (restoreFocus) $('#fontBtn')?.focus({ preventScroll: true });
  };
  const onKey = e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeFontPop();
      $('#fontBtn')?.focus();
      return;
    }
    if (!pop.contains(e.target) || e.isComposing) return;
    if (e.key === 'Enter' && e.target === input && rows.length) {
      e.preventDefault();
      const first = Math.min(rows.length - 1, Math.floor(list.scrollTop / FONT_ROW_HEIGHT));
      selectFont(rows[active < 0 ? first : active][0]);
      return;
    }
    if (!rows.length) return;
    const page = Math.max(1, Math.floor(list.clientHeight / FONT_ROW_HEIGHT));
    let index;
    if (e.key === 'ArrowDown') index = active < 0 ? Math.floor(list.scrollTop / FONT_ROW_HEIGHT) : active + 1;
    else if (e.key === 'ArrowUp') index = active < 0 ? Math.ceil((list.scrollTop + list.clientHeight) / FONT_ROW_HEIGHT) - 1 : active - 1;
    else if (e.key === 'PageDown') index = Math.max(0, active) + page;
    else if (e.key === 'PageUp') index = Math.max(0, active) - page;
    else if (e.key === 'Home' && (e.target !== input || !input.value || e.ctrlKey || e.metaKey)) index = 0;
    else if (e.key === 'End' && (e.target !== input || !input.value || e.ctrlKey || e.metaKey)) index = rows.length - 1;
    else return;
    e.preventDefault();
    if (e.target !== input) input.focus({ preventScroll: true });
    active = clamp(index, 0, rows.length - 1);
    revealActive();
  };
  const away = e => { if (!pop.contains(e.target) && !e.target.closest('#fontBtn')) closeFontPop(); };
  document.addEventListener('pointerdown', away, true);
  window.addEventListener('keydown', onKey, true);
  pop._off = () => {
    document.removeEventListener('pointerdown', away, true);
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(frame);
  };
  pop._list = updateList;
  list.onscroll = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
  };
  input.oninput = () => updateList(true);
  pop.querySelector('.ftabs').onclick = e => {
    const button = e.target.closest('[data-ft]');
    if (!button) return;
    fontTab = button.dataset.ft;
    pop.querySelectorAll('[data-ft]').forEach(tab => tab.classList.toggle('on', tab === button));
    spacer.setAttribute('aria-label', tr('ft_' + fontTab));
    updateList(true);
  };
  list.onclick = e => {
    const row = e.target.closest('[data-index]');
    if (!row) return;
    const [family] = rows[Number(row.dataset.index)];
    if (!e.target.closest('[data-fav]')) return selectFont(family);
    // Keep the list open and preserve its scroll position when starring a font.
    if (favs.has(family)) favs.delete(family);
    else favs = new Set([family, ...favs]);
    lsSet('kadr.favFonts', [...favs]);
    if (fontTab === 'fav') updateList();
    else {
      const button = row.querySelector('[data-fav]');
      button.classList.toggle('on', favs.has(family));
      button.setAttribute('aria-pressed', favs.has(family));
    }
  };
  updateList();
  input.focus({ preventScroll: true });
}
function closeFontPop() { const p = $('#fpop'); if (p) { p._off(); p.remove(); } }
const ACCENT = '#5cd3c6';
let CHROME_ACCENT = ACCENT;
const PANEL_GAP = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap'));
const ROW = 37;
const IN_T = 0.35, OUT_T = 0.25;
const MEDIA_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

/* ---------- language ---------- */
let LANG = (() => { try { return localStorage.getItem('kadr.lang') || 'ar'; } catch { return 'ar'; } })();
const tr = (k, vars) => { let s = (I18N[LANG] && I18N[LANG][k]) ?? I18N.en[k] ?? k; if (vars) for (const v in vars) s = s.replace('{' + v + '}', vars[v]); return s; };
function applyLang() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === 'ar' ? 'rtl' : 'ltr';
  $$('[data-t]').forEach(el => (el.textContent = tr(el.dataset.t)));
  $$('[data-ph]').forEach(el => (el.placeholder = tr(el.dataset.ph)));
  paintShortcutHints();
  try { localStorage.setItem('kadr.lang', LANG); } catch {}
}
function paintIcons(root = document) {
  root.querySelectorAll('[data-i]').forEach(el => { if (!el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.i)); });
}

/* ---------- project & history ---------- */
function newProject() {
  return {
    version: 2, w: 1080, h: 1920, fps: 30, media: {}, items: [], markers: [], groups: {}, loudnessTarget: 0,
    tracks: [
      { id: 'c1', kind: 'text' }, { id: 't1', kind: 'text' }, { id: 'v2', kind: 'video' },
      { id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio' },
    ],
  };
}
let P = newProject(), projectPath = null, dirty = false;
let offline = new Set(); // media ids whose file is gone; drawn as a "Media offline" card, never dropped
const msel = new Set(); // timeline multi-selection (always includes sel when used)
let openGrp = null, sel = null, t = 0, playing = false, pps = 60, lastTick = 0, needsDraw = true, cancelled = false;
let playRate = 1;
let tool = 'select', magnet = true, snapOn = true, inspTab = null;
let cancelProTrim = null;
const undoStack = [], redoStack = [];

const item = id => P.items.find(i => i.id === id);
const media = (it, project = P) => it && it.media && project.media[it.media];
const isText = it => it && it.type === 'text';
const active = (it, time) => time >= it.start && time < it.start + it.dur;
const kindOf = it => (isText(it) ? 'text' : media(it).kind);
const total = () => S.projectDur(P);
const markerTimes = () => P.markers.map(m => m.time);
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60), x = Math.floor(s % 60), f = Math.floor((s % 1) * P.fps + 1e-6); return `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}:${String(f).padStart(2, '0')}`; };
const renderOrder = (pr, kind) => pr.tracks.filter(x => x.kind === kind).map(x => x.id).reverse();
let MEDIA_BASE = '';
const piperAudio = new Audio();
const urlOf = m => MEDIA_BASE + encodeURIComponent(m.path);
const cleanErr = e => String(e && e.message || e).replace(/^Error: /, '');

function snapshot() {
  undoStack.push(JSON.stringify(P));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  dirty = true;
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(P));
  P = JSON.parse(from.pop());
  dirty = true;
  syncSettings();
  refresh();
  scanOffline();
}

/* ---------- media elements ---------- */
const els = new Map(), imgs = new Map();
const mediaHold = document.body.appendChild(Object.assign(document.createElement('div'), { ariaHidden: 'true' }));
mediaHold.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:.01;pointer-events:none;z-index:-1';
// Pieces of one clip that play back to back (a split) share one media element, so a cut plays through
// without restarting the decoder (WebKit takes ~0.6 s to start a paused video).
const chainKeys = new Map();
let playbackProject;
function chainKey(it) {
  if (it.id.includes('|mc')) return it.id.endsWith('|viewer') && S.hasCurve(it) ? it.id : it.id.split('|').slice(0, 2).join('|');
  if (it.audioOnly) return it.id;
  let k = chainKeys.get(it);
  if (k) return k;
  const sp = num(it.speed, 1), eps = 1e-4;
  const prev = !S.hasCurve(it) && P.items.find(p => p !== it && p.track === it.track && p.media === it.media && num(p.speed, 1) === sp && !S.hasCurve(p) &&
    Math.abs(p.start + p.dur - it.start) < eps && Math.abs(num(p.in, 0) + p.dur * sp - num(it.in, 0)) < eps);
  chainKeys.set(it, k = prev ? chainKey(prev) : it.id);
  return k;
}
// Speed-curve clips preview from a small pre-retimed copy (proxy_render) played at 1x: changing
// playbackRate every frame makes WebKit stall. Until the copy is ready the original plays stepped.
const pxOk = new Map(), pxPath = new Map();
function pxKey(it) {
  const m = media(it);
  return JSON.stringify([m.path, G.toneMap(m), num(it.in, 0), it.dur, it.curve, !!it.pitch, P.fps, smoothSlow(it) && num(it.speed, 1), smoothSlow(it) && rifeFor(it)]);
}
// smooth slow-mo previews from the proxy too: the export's motion-interpolated frames, made once
const smoothSlow = it => !!it.smooth && (S.hasCurve(it) ? it.curve.pts.some(p => p[1] < 1) : num(it.speed, 1) < 1);
// AI in-between frames (RIFE): a high-frame-rate copy of the clip's source range, made once per range
let rifeTool = false;
inv('rife_ready').then(v => (rifeTool = v), () => {});
const rifeOk = new Map(), rifePath = new Map(), rifeSources = new Map();
const rifeFactor = it => clamp(Math.ceil(1 / Math.max(0.125, S.hasCurve(it) ? Math.min(...it.curve.pts.map(p => p[1])) : num(it.speed, 1))), 2, 8);
const rifeKey = (it, m = media(it)) => JSON.stringify([m.path, G.toneMap(m), +num(it.in, 0).toFixed(3), +S.srcLen(it).toFixed(3), rifeFactor(it)]);
async function makeRife(it, m) {
  const filter = G.toneMap(m), len = S.srcLen(it), factor = rifeFactor(it);
  let path = m.path, start = num(it.in, 0);
  if (filter) {
    // Prepare only the source range. RIFE's RGB PNGs cannot carry the video's HLG/PQ metadata.
    const args = ['-y', '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', path, '-map', '0:v:0', '-vf', filter,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-fps_mode', 'passthrough', ...G.SDR_TAGS, '__OUT__'];
    const key = JSON.stringify(args);
    if (!rifeSources.has(key)) rifeSources.set(key, inv('proxy_render', { args }).finally(() => rifeSources.delete(key)));
    path = await rifeSources.get(key);
    start = 0;
  }
  return inv('rife_make', { path, start, len, factor, job: it.id });
}
// path of the AI copy, '' while it is being made, null when not used (tool missing, not slow, failed)
function rifeFor(it, m = media(it)) {
  if (!rifeTool || !smoothSlow(it)) return null;
  const k = rifeKey(it, m);
  if (rifePath.has(k)) return rifePath.get(k);
  if (!rifeOk.has(k)) {
    rifeOk.set(k, makeRife(it, m)
      .then(p => { rifePath.set(k, p); needsDraw = true; pxPaint(it.id); return p; }, e => { rifePath.set(k, null); toast(cleanErr(e)); return null; }));
  }
  return '';
}
const upscaleCaches = new Map();
let upscaleTask = null;

function upscaleMedia(it) {
  const m = it && media(it);
  return m?.path && !m.angles && !m.fill && !m.adj && !it.audioOnly && ['video', 'image'].includes(m.kind) ? m : null;
}
const upscaleScale = it => [2, 4].includes(it.upscale?.scale) ? it.upscale.scale : 0;
const upscaleType = it => it.upscale?.model === 'animation' ? 'animation' : 'footage';
function upscaleRequest(it, m, settings = { scale: upscaleScale(it), model: upscaleType(it) }) {
  if (!m?.path || !['video', 'image'].includes(m.kind) || it.audioOnly || !settings.scale) return null;
  const still = m.kind === 'image', start = still ? 0 : num(it.in, 0), len = still ? 0 : S.srcLen(it);
  return { path: m.path, start, len, still, ...settings, toneMap: G.toneMap(m) || null };
}
const upscaleRange = req => JSON.stringify([req.start, req.len]);
const upscaleKey = (m, req) => JSON.stringify([m.sourceKey, req]);
function upscaleState(it, m) {
  const req = upscaleRequest(it, m);
  if (!req || it.upscale?.prepared !== upscaleRange(req)) return null;
  const key = upscaleKey(m, req);
  let state = upscaleCaches.get(key);
  if (!state) {
    state = {};
    upscaleCaches.set(key, state);
    state.wait = inv('upscale_cached', { request: req }).then(path => (state.path = path), () => null).finally(() => {
      needsDraw = true;
      if (item(sel)?.id === it.id && inspTab === 'tVideo') paintUpscaleStatus();
    });
  }
  return state;
}
function upscaleVisual(it, m) {
  const path = upscaleState(it, m)?.path;
  if (!path) return null;
  const factor = upscaleScale(it);
  return { ...m, path, w: m.w * factor, h: m.h * factor, hdr: false,
    dur: m.kind === 'video' ? S.srcLen(it) : m.dur };
}
const depthDrafts = new WeakMap(), depthCaches = new Map();
let depthTask = null, depthPicker = null, depthGeometry = null;
const DEPTH_DEFAULTS = { blur: 0, range: 0.12, progressive: true, focus: null, fog: 0, color: '#d5e3ee', parallax: 0, motion: 'zoomIn' };
function depthSettings(it) {
  const fx = it.depth || {}, point = fx.focus;
  const amount = key => clamp(num(fx[key], DEPTH_DEFAULTS[key]), 0, 1);
  const focus = point && [point.x, point.y, point.time].every(Number.isFinite)
    ? { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1), time: Math.max(0, point.time) } : null;
  return { blur: amount('blur'), range: amount('range'), progressive: fx.progressive !== false, focus,
    fog: amount('fog'), color: /^#[0-9a-f]{6}$/i.test(fx.color) ? fx.color : DEPTH_DEFAULTS.color,
    parallax: amount('parallax'), motion: ['zoomIn', 'leftRight', 'circle'].includes(fx.motion) ? fx.motion : DEPTH_DEFAULTS.motion };
}
const depthEnabled = fx => fx.blur > 0 || fx.fog > 0 || fx.parallax > 0;
const depthDraft = it => depthDrafts.get(it) || depthSettings(it);
function depthRequest(it, m, project, fx = depthSettings(it)) {
  if (!m?.path || m.angles || m.fill || m.adj || it.audioOnly || !['video', 'image'].includes(m.kind) || !depthEnabled(fx)) return null;
  const still = m.kind === 'image', start = still ? 0 : num(it.in, 0), len = still ? it.dur : S.srcLen(it);
  const motionTiming = !still && fx.parallax > 0 && S.hasCurve(it)
    ? Array.from({ length: 65 }, (_, i) => clamp(S.ltAt(it, len * i / 64) / it.dur, 0, 1)) : null;
  const { color, focus, blur, range, progressive, fog, parallax, motion } = fx;
  const rgb = parseInt(color.slice(1), 16);
  const upscale = upscaleVisual(it, m);
  return { path: m.path, start, len, still, width: m.w, height: m.h,
    upscale: upscale ? { path: upscale.path, width: upscale.w, height: upscale.h } : null,
    fps: clamp(still ? (parallax ? project.fps : 1) : m.fps || 30, 1, 240), toneMap: G.toneMap(m) || null,
    effects: { blur, range, progressive, focus, fog, color: [rgb >> 16, rgb >> 8 & 255, rgb & 255], parallax, motion, motionTiming } };
}
const depthKey = (m, request) => JSON.stringify([m?.sourceKey, request]);
function depthState(it, m, project = P) {
  if (!it.depth) return null;
  const request = depthRequest(it, m, project);
  if (!request) return null;
  const key = depthKey(m, request);
  let state = depthCaches.get(key);
  if (!state) {
    state = {};
    depthCaches.set(key, state);
    state.wait = inv('depth_cached', { request }).then(({ path }) => (state.path = path), () => null).finally(() => {
      needsDraw = true;
      if (sel === it.id) paintDepthStatus();
    });
  }
  return state;
}
function depthVisual(it, m, project = P) {
  const path = depthState(it, m, project)?.path;
  if (!path) return null;
  const upscale = upscaleVisual(it, m);
  const animatedStill = m.kind === 'image' && depthSettings(it).parallax > 0;
  return { ...m, path, depth: true, animatedStill, hdr: false, w: upscale?.w || m.w, h: upscale?.h || m.h,
    kind: animatedStill ? 'video' : m.kind, fps: clamp(animatedStill ? project.fps : m.fps || 30, 1, 240),
    dur: m.kind === 'video' ? S.srcLen(it) : it.dur };
}
const preparedVisual = (it, m, project = P) => depthVisual(it, m, project) || upscaleVisual(it, m);
function depthStatus(it, m) {
  if (depthTask?.item === it) {
    const task = depthTask, pct = Math.round(task.p * 100);
    const label = tr(task.cancelled ? 'cancelled' : aiTransfers.has('depth_dl') ? 'p_depth_dl' : task.stage === 'map' ? 'depthEstimating' : 'depthRendering', { p: pct });
    return `<div class="pxb insp" role="progressbar" aria-label="${tr('depthTitle')}" aria-valuenow="${pct}" style="--p:${task.p}"><i></i><em>${label}</em></div>`;
  }
  if (depthPicker?.item === it) return `<p class="hint">${tr('depthFocusHint')}</p>`;
  const draft = depthDraft(it);
  if (!it.depth && !depthEnabled(draft)) return '';
  const ready = !depthDrafts.has(it) && depthState(it, m)?.path;
  return `<p class="hint">${tr(ready ? 'depthReady' : 'depthNeedsPrepare')}</p>`;
}
function paintDepthStatus() {
  const node = $('#depthStatus'), it = item(sel), m = upscaleMedia(it);
  if (node && m) node.innerHTML = depthStatus(it, m);
}
function depthInspector(it, m) {
  const fx = depthDraft(it), busy = depthTask?.item === it;
  const field = (key, title, type, attrs, value) => `<label class="f"><span>${tr(title)}</span><input aria-label="${tr(title)}" type="${type}" data-depth-field="${key}" ${attrs} value="${esc(String(value))}"${busy ? ' disabled' : ''}></label>`;
  const amount = (key, title) => field(key, title, 'range', 'min="0" max="1" step="0.01"', fx[key]);
  const button = (key, title, disabled = false) => `<button class="wide" id="depth${key}"${disabled ? ' disabled' : ''}>${tr(title)}</button>`;
  return grp('depthTitle', `<div id="depthControls"><div class="gh">${tr('depthBokeh')}</div>` +
    amount('blur', 'depthBlur') + amount('range', 'depthRange') +
    `<label class="sam-field"><input type="checkbox" data-depth-field="progressive"${fx.progressive ? ' checked' : ''}${busy ? ' disabled' : ''}>${tr('depthProgressive')}</label>` +
    `<div class="inl">${button('Pick', fx.focus ? 'depthRepick' : 'depthPick', busy || it.hidden)}${button('Auto', 'depthAuto', busy || !fx.focus)}</div>` +
    `<div class="gh">${tr('depthFog')}</div>` + amount('fog', 'depthDensity') +
    field('color', 'color', 'color', '', fx.color) +
    `<div class="gh">${tr('depthParallax')}</div><label class="f"><span>${tr('depthMotion')}</span><select data-depth-field="motion"${busy ? ' disabled' : ''}>` +
    ['zoomIn', 'leftRight', 'circle'].map(key => `<option value="${key}"${key === fx.motion ? ' selected' : ''}>${tr('depth_' + key)}</option>`).join('') +
    `</select></label>` + amount('parallax', 'depthAmount') +
    `<p class="hint">${tr('depthDuration', { time: it.dur.toFixed(2) })}</p><div id="depthStatus">${depthStatus(it, m)}</div>` +
    (busy ? button('Cancel', 'cancel', depthTask.cancelled) : button('Apply', 'depthPrepare', !depthEnabled(fx) && !it.depth)) + '</div>');
}
function setDepthDraft(it, patch) {
  const next = { ...depthDraft(it), ...patch };
  if (JSON.stringify(next) === JSON.stringify(depthSettings(it))) depthDrafts.delete(it);
  else depthDrafts.set(it, next);
  paintDepthStatus();
  const apply = $('#depthApply');
  if (apply) apply.disabled = !depthEnabled(depthDraft(it)) && !it.depth;
}
function endDepthPick() {
  depthPicker = depthGeometry = null;
  $('#stage').classList.remove('depth-picking');
  needsDraw = true;
  paintDepthStatus();
}
function startDepthPick(it) {
  if (pickInput) endPick();
  if (playing) setPlaying(false);
  if (!active(it, t)) seek(it.start);
  depthPicker = { item: it, project: P };
  $('#stage').classList.add('depth-picking');
  paintDepthStatus();
  needsDraw = true;
}
function depthPointer(e) {
  if (!depthPicker || e.button !== 0) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const { item: it } = depthPicker, g = depthGeometry;
  if (!g || g.item !== it || item(sel) !== it || !active(it, t)) return;
  const r = view.getBoundingClientRect();
  const point = S.objectSourcePoint([(e.clientX - r.left) * P.w / r.width, (e.clientY - r.top) * P.h / r.height], g.matrix, g.dest, g.crop);
  if (!point) return;
  setDepthDraft(it, { focus: { x: clamp(point[0] / g.m.w, 0, 1), y: clamp(point[1] / g.m.h, 0, 1), time: g.time } });
  endDepthPick();
  inspector();
}
function stopDepth(task) {
  if (!task || task.cancelled) return;
  task.cancelled = true;
  if (task.running) inv('depth_cancel', { job: task.job }).catch(e => toast(cleanErr(e)));
  inspector();
}
async function prepareDepth(it, fx = depthDraft(it), download = true) {
  const m = upscaleMedia(it);
  if (!m) throw new Error(tr('upscalePick'));
  if (depthTask || exporting) throw new Error(tr('depthBusy'));
  endDepthPick();
  const project = P;
  await upscaleState(it, m)?.wait;
  if (depthTask || exporting || project !== P || item(it.id) !== it || upscaleMedia(it) !== m) throw new Error(tr('depthBusy'));
  const request = depthRequest(it, m, P, fx);
  if (!request) {
    depthDrafts.delete(it);
    if (it.depth) { snapshot(); delete it.depth; dirty = true; refresh(); }
    else inspector();
    return { enabled: false };
  }
  const original = it.depth, key = depthKey(m, request);
  const task = depthTask = { item: it, project, job: uid(), stage: 'map', p: 0 };
  const current = () => project === P && item(it.id) === it && it.depth === original &&
    depthKey(upscaleMedia(it), depthRequest(it, upscaleMedia(it), P, fx)) === key;
  inspector();
  try {
    let { path, hasMap } = await inv('depth_cached', { request });
    if (!path && !hasMap && !await depthModel.ready()) {
      if (!download) throw new Error(tr('depthModelMissing'));
      if (task.cancelled || !current() || !await TA.dialog.ask(tr('depthDownloadAsk'), { title: tr('depthTitle') })) return;
      if (task.cancelled || !current()) return;
      await depthModel.download();
    }
    if (task.cancelled || !current()) return;
    if (!path) {
      task.running = true;
      path = await inv('depth_prepare', { request, job: task.job });
    }
    if (task.cancelled || !current()) return;
    depthCaches.set(key, { path, wait: Promise.resolve(path) });
    depthDrafts.delete(it);
    if (JSON.stringify(fx) !== JSON.stringify(original)) {
      snapshot();
      it.depth = fx;
      dirty = true;
    }
    return { enabled: true };
  } catch (e) {
    if (!task.cancelled) throw e;
  } finally {
    depthTask = null;
    refresh();
  }
}
TA.event.listen('depthprog', ({ payload: { job, stage, p } }) => {
  const task = depthTask;
  if (task?.job !== job) return;
  if (task.cancelled) {
    inv('depth_cancel', { job }).catch(() => {});
    return;
  }
  Object.assign(task, { stage, p });
  paintDepthStatus();
});
function upscaleEta(eta) {
  if (eta == null) return '';
  const time = eta >= 60 ? tr('upscaleMinutes', { n: Math.ceil(eta / 60) }) : tr('upscaleSeconds', { n: Math.ceil(eta) });
  return tr(eta >= 300 ? 'upscaleLong' : 'upscaleEta', { time });
}
function upscaleStatus(it, m) {
  const task = upscaleTask?.item === it ? upscaleTask : null;
  if (task) {
    const transfer = aiTransfers.get('upscale_dl');
    const p = transfer?.p ?? task.p;
    const label = task.cancelled ? tr('cancelled') : transfer ? tr('upscaleDownload') : tr('upscaleProgress', { p: Math.round(p * 100) });
    const eta = !task.cancelled && upscaleEta(task.eta);
    return `<div class="pxb insp" style="--p:${p}" role="progressbar" aria-label="${tr('upscaleTitle')}" aria-valuenow="${Math.round(p * 100)}"><i></i><em>${label}</em></div>` +
      (eta ? `<p class="hint">${eta}</p>` : '');
  }
  if (upscaleState(it, m)?.path) return `<p class="hint">${tr('upscaleReady')}</p>`;
  const req = upscaleRequest(it, m);
  if (!req) return '';
  const estimate = S.upscaleEstimate(m.w, m.h, m.fps, req.len, req.still, req.scale);
  const workPixels = req.model === 'footage' && req.scale === 2 ? estimate.pixels * 4 : estimate.pixels;
  if (workPixels >= 2e9) return `<p class="hint">${tr('upscaleLarge', estimate)}</p>`;
  return it.upscale?.prepared ? `<p class="hint">${tr('upscaleNeedsPrepare')}</p>` : '';
}
function paintUpscaleStatus() {
  const node = $('#upscaleStatus'), it = item(sel), m = upscaleMedia(it);
  if (node && m) node.innerHTML = upscaleStatus(it, m);
}
function upscaleInspector(it, m) {
  const busy = upscaleTask?.item === it, scale = upscaleScale(it), model = upscaleType(it);
  const select = (id, label, options, value, disabled) =>
    `<label class="f"><span>${tr(label)}</span><select id="${id}"${disabled ? ' disabled' : ''}>${options.map(([v, text]) =>
      `<option value="${v}"${v === value ? ' selected' : ''}>${text}</option>`).join('')}</select></label>`;
  return grp('upscaleTitle',
    select('upscaleScale', 'upscaleScale', [[0, tr('upscaleOff')], [2, '2×'], [4, '4×']], scale, busy) +
    select('upscaleModel', 'upscaleModel', [['footage', tr('upscaleFootage')], ['animation', tr('upscaleAnimation')]], model, busy || !scale) +
    `<div id="upscaleStatus">${upscaleStatus(it, m)}</div>` +
    (busy ? `<button class="wide" id="upscaleCancel"${upscaleTask.cancelled ? ' disabled' : ''}>${tr('cancel')}</button>`
      : `<button class="wide" id="upscalePrepare"${scale ? '' : ' disabled'}>${tr('upscalePrepare')}</button>`));
}
function setUpscale(it, settings) {
  if (settings.scale === upscaleScale(it) && settings.model === upscaleType(it)) return;
  snapshot();
  it.upscale = settings;
  dirty = true;
  refresh();
}
function stopUpscale(task) {
  if (!task || task.cancelled) return;
  task.cancelled = true;
  if (task.running) inv('upscale_cancel', { job: task.job }).catch(e => toast(cleanErr(e)));
  if (task.item && item(sel) === task.item) inspector();
}
async function prepareUpscale(it, settings, download = true) {
  const m = upscaleMedia(it), request = upscaleRequest(it, m, settings);
  if (!request) throw new Error(tr('upscalePick'));
  if (upscaleTask || exporting) throw new Error(tr('upscaleBusy'));
  const project = P, original = it.upscale, key = upscaleKey(m, request);
  const task = upscaleTask = { item: it, project, job: uid(), p: 0 };
  const current = () => project === P && item(it.id) === it && it.upscale === original &&
    upscaleKey(m, upscaleRequest(it, upscaleMedia(it), settings)) === key;
  if (sel === it.id) inspector();
  try {
    let path = await inv('upscale_cached', { request });
    if (!path && !await upscaleModel.ready()) {
      if (!download) throw new Error(tr('upscaleModelMissing'));
      if (task.cancelled || !current() || !await TA.dialog.ask(tr('upscaleAsk'), { title: tr('upscaleTitle') })) return;
      if (task.cancelled || !current()) return;
      await upscaleModel.download();
    }
    if (task.cancelled || !current()) return;
    if (!path) {
      task.running = true;
      path = await inv('upscale_prepare', { request, job: task.job });
    }
    if (task.cancelled || !current()) return;
    upscaleCaches.set(key, { path, wait: Promise.resolve(path) });
    const prepared = upscaleRange(request);
    if (original?.prepared !== prepared || original.scale !== request.scale || original.model !== request.model) {
      snapshot();
      it.upscale = { scale: request.scale, model: request.model, prepared };
      dirty = true;
    }
    return { path };
  } catch (e) {
    if (!task.cancelled) throw e;
  } finally {
    upscaleTask = null;
    if (P === project) refresh();
  }
}
TA.event.listen('upscaleprog', ({ payload: { job, p, eta } }) => {
  const task = upscaleTask;
  if (task?.job !== job) return;
  if (task.cancelled) {
    // A progress event also confirms registration if Cancel arrived while the command was starting.
    if (!task.cancelRetried) {
      task.cancelRetried = true;
      inv('upscale_cancel', { job }).catch(() => {});
    }
    return;
  }
  Object.assign(task, { p, eta });
  if (task.item) paintUpscaleStatus();
  else progress(upscaleEta(eta) || tr('upscaleTitle'), p);
});

const objectMattes = new Map(), fillCaches = new Map(), fillJobs = new Map(), fillImages = new Map(), fillLast = new Map();
let exportFill = null;
const objectRaster = new WeakMap();
const objectProjects = new WeakMap();
let objectDraft = null, objectGeometry = null, objectDrawing = false, objectJob = null;
function objectMedia(it) {
  const m = it && media(it);
  return m?.path && !m.angles && !m.fill && !m.adj && !it.audioOnly && !it.hidden && ['video', 'image'].includes(m.kind) ? m : null;
}
const objectMode = it => it.objectMask?.mode || 'keep';
const objectEdges = it => ({
  invert: Boolean(it.objectMask?.invert),
  feather: clamp(Math.round(num(it.objectMask?.feather, objectMode(it) === 'fill' ? 2 : 0)), 0, 128),
  expand: clamp(Math.round(num(it.objectMask?.expand, 0)), -128, 128),
});
const objectEdit = it => objectDraft?.project === P && objectDraft.id === it?.id && sel === it?.id &&
  objectDraft.path === media(it)?.path ? objectDraft : null;
const objectSourceTime = (it, lt) => num(it.in, 0) + S.srcAt(it, clamp(lt, 0, it.dur));
const objectFrame = (m, time) => m.kind === 'image' ? 0 : Math.floor(time * (m.fps >= 1 ? m.fps : 30) + 0.0001);

function fillRequest(it, m) {
  if (objectMode(it) !== 'fill' || !it.objectMask?.key || !m?.path || it.hidden || it.audioOnly) return null;
  const start = m.kind === 'image' ? 0 : num(it.in, 0);
  return { path: m.path, start, end: m.kind === 'image' ? 0 : start + S.srcLen(it), key: it.objectMask.key,
    edges: objectEdges(it), smooth: m.kind === 'video' && it.objectMask.smooth !== false, toneMap: G.toneMap(m) || null };
}
const fillKey = (m, request) => JSON.stringify([m?.sourceKey, request]);
function fillState(it, m, immediate = false, retry = false) {
  const request = fillRequest(it, m);
  if (!request) return null;
  const key = fillKey(m, request);
  let state = fillCaches.get(key);
  if (state && !retry) {
    if (immediate) state.start();
    return state;
  }
  state = { p: 0, job: uid(), key };
  const update = () => {
    needsDraw = true;
    if (inspTab === 'tVideo' && item(sel)?.objectMask?.key === request.key) inspector();
  };
  state.start = () => {
    if (state.wait) return;
    clearTimeout(state.timer);
    fillJobs.set(state.job, state);
    state.wait = inv('migan_render', { request: { ...request, job: state.job } }).then(cache => (state.cache = cache),
      error => {
        state.error = cleanErr(error);
        if (state.error === 'MI-GAN model is missing') state.needsModel = true;
        return null;
      }).finally(() => { fillJobs.delete(state.job); update(); });
  };
  state.cancel = () => {
    state.cancelled = true;
    clearTimeout(state.timer);
    if (!state.wait) state.wait = Promise.resolve(null);
    else inv('migan_cancel', { job: state.job }).catch(e => toast(cleanErr(e)));
  };
  fillCaches.set(key, state);
  if (immediate) state.start();
  else state.timer = setTimeout(() => {
    const current = item(it.id);
    if (current && fillKey(media(current), fillRequest(current, media(current))) === key) state.start();
    else if (!state.wait && fillCaches.get(key) === state) fillCaches.delete(key);
  }, 350);
  return state;
}
function releaseFill(state) {
  if (!state || state.cache || state.error || state.cancelled || state === exportFill) return;
  if (P.items.some(it => fillKey(media(it), fillRequest(it, media(it))) === state.key)) return;
  state.cancel();
  fillCaches.delete(state.key);
}
const fillError = state => state?.needsModel ? tr('fillModelMissing') : state?.error || tr('fillRenderFailed');
function fillIndex(cache, time) {
  let lo = 0, hi = cache.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cache.times[mid] <= time + .000001) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
const fillPath = (cache, i) => cache.path + '/' + String(i).padStart(9, '0') + '.png';
function fillImage(cache, i) {
  const path = fillPath(cache, i);
  let image = fillImages.get(path);
  if (image) fillImages.delete(path);
  else {
    image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => (needsDraw = true);
    image.src = urlOf({ path });
  }
  fillImages.set(path, image);
  if (fillImages.size > 12) fillImages.delete(fillImages.keys().next().value);
  return image;
}
function fillPreview(it, cache, lt) {
  const index = fillIndex(cache, objectSourceTime(it, lt));
  const image = fillImage(cache, index);
  if (playing) for (let i = index + 1; i < Math.min(cache.times.length, index + 4); i++) fillImage(cache, i);
  if (image.complete && image.naturalWidth) {
    fillLast.delete(it.id);
    fillLast.set(it.id, { path: cache.path, image });
    if (fillLast.size > 4) fillLast.delete(fillLast.keys().next().value);
    return image;
  }
  const last = fillLast.get(it.id);
  return last?.path === cache.path ? last.image : null;
}
async function retryFill(it) {
  const m = objectMedia(it), project = P;
  if (!m || !fillRequest(it, m)) return;
  if (!await miganModel.ready().catch(() => false)) {
    if (!await TA.dialog.ask(tr('fillAsk'), { title: tr('sam_fill') })) return;
    try {
      progress(tr('p_migan_dl'), 0);
      await miganModel.download(false);
    } catch (e) { toast(cleanErr(e)); return; }
    finally { hideModal(); }
  }
  if (P !== project || item(it.id) !== it || media(it)?.path !== m.path) return;
  fillState(it, m, true, true);
  inspector();
}
function paintFillProgress(state, label) {
  const bar = $('#fillProgress');
  if (bar?.dataset.job === state.job) {
    bar.style.setProperty('--p', state.p);
    bar.querySelector('em').textContent = label;
  }
}
TA.event.listen('miganprog', e => {
  const { job, p } = e.payload;
  const state = fillJobs.get(job);
  if (!state || state.cancelled) return;
  state.p = p;
  const label = tr('fillProgress', { p: Math.round(p * 100) });
  paintFillProgress(state, label);
  if (exporting && exportFill === state && !cancelled) progress(label, p);
});

function objectMatteState(it, m) {
  if (!it.objectMask?.key || !m?.path) return null;
  const { key } = it.objectMask, edges = objectEdges(it);
  const id = JSON.stringify([key, m.path, edges]);
  if (!objectMattes.has(id)) {
    const state = {};
    state.wait = inv('sam2_matte', { key, source: m.path, edges }).then(v => {
      state.matte = v;
      return v;
    }, e => {
      state.error = e;
      return null;
    }).finally(() => {
      needsDraw = true;
      if (inspTab === 'tVideo' && item(sel)?.objectMask?.key === key) inspector();
    });
    objectMattes.set(id, state);
  }
  return objectMattes.get(id);
}

function objectMatteEl(it, mt) {
  const el = matteVideo(it.id + '|obj', mt.path);
  el._objectMatte = mt;
  return el;
}

function stopObjectEdit() {
  objectDraft = null;
  view.classList.remove('object-prompt');
  needsDraw = true;
}

async function openObjectSelect(it, mode = objectEdit(it)?.mode) {
  const m = objectMedia(it);
  if (!m) return toast(tr('samPick'));
  if (objectEdit(it) && !objectEdit(it).brush) { stopObjectEdit(); inspector(); return; }
  const project = P, path = m.path;
  if (!await sam2Model.ready().catch(() => false)) {
    if (!await TA.dialog.ask(tr('samAsk'), { title: tr('samSelect') })) return;
    try {
      progress(tr('p_sam2_dl'), 0);
      await sam2Model.download(false);
    } catch (e) { toast(cleanErr(e)); return; }
    finally { hideModal(); }
  }
  if (project !== P || item(it.id) !== it || sel !== it.id || media(it)?.path !== path) return;
  setPlaying(false);
  const saved = it.objectMask?.prompt;
  const lt = saved && m.kind === 'video' ? S.ltAt(it, saved.time - num(it.in, 0)) : t - it.start;
  if (saved || !active(it, t)) seek(it.start + clamp(lt, 0, Math.max(0, it.dur - .001)));
  const seed = m.kind === 'image' ? 0 : objectSourceTime(it, t - it.start);
  const prompt = saved && objectFrame(m, seed) === objectFrame(m, saved.time) ? saved : { points: [], bbox: null };
  objectDraft = { project, path, id: it.id, seed, prompt, mode, pending: false };
  view.classList.add('object-prompt');
  revealPanel('player');
  openAIInspector('tVideo', '[data-object="select"]');
  needsDraw = true;
  if (prompt.points.length || prompt.bbox) decodeObject(objectDraft, m);
}

function brushTracks(it) {
  return P.items.filter(f => f.trk?.subject?.clip === it.id && f.trk.subject.media === it.media && f.trk.subject.pts?.length);
}
function brushOffset(brush, m, time) {
  const at = t0 => {
    const p = brush.motion;
    if (!p.length) return [0, 0];
    const n = p.findIndex(p => p[0] > t0);
    if (n === 0) return p[0].slice(1);
    if (n < 0) return p.at(-1).slice(1);
    const a = p[n - 1], b = p[n], q = (t0 - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * q, a[2] + (b[2] - a[2]) * q];
  };
  const [x, y] = at(time), [sx, sy] = at(brush.seed);
  return [(x - sx) * m.w, (y - sy) * m.h];
}
function drawBrushSegment(draft, m, stroke, to, from) {
  const c = draft.overlay, ctx = c.getContext('2d');
  ctx.setTransform(c.width / m.w, 0, 0, c.height / m.h, 0, 0);
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.fillStyle = ctx.strokeStyle = getComputedStyle(view).getPropertyValue('--accent').trim();
  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (from) { ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke(); }
  else { ctx.arc(...to, stroke.size / 2, 0, Math.PI * 2); ctx.fill(); }
}
function openBrush(it, preset = false) {
  const m = objectMedia(it);
  if (!m || sel !== it.id) return toast(tr('samPick'));
  const edit = objectEdit(it);
  if (edit?.brush && !preset) { stopObjectEdit(); inspector(); return; }
  if (objectJob?.clip === it.id) return;
  setPlaying(false);
  if (!active(it, t)) seek(it.start);
  const saved = edit?.brush ? edit : it.objectMask?.brush;
  const seed = saved?.seed ?? (m.kind === 'image' ? 0 : objectSourceTime(it, t - it.start));
  const scale = Math.min(1, 1024 / Math.max(m.w, m.h));
  const overlay = Object.assign(document.createElement('canvas'), {
    width: Math.max(1, Math.round(m.w * scale)), height: Math.max(1, Math.round(m.h * scale)),
  });
  objectDraft = { project: P, path: m.path, id: it.id, brush: true, seed, overlay,
    preset, mode: preset ? 'fill' : edit?.mode,
    track: preset ? '' : (saved?.track || ''), motion: preset ? [] : (saved?.motion || []),
    size: saved?.size || 40, erase: false, strokes: structuredClone(saved?.strokes || []) };
  for (const stroke of objectDraft.strokes) stroke.points.forEach((p, i) => drawBrushSegment(objectDraft, m, stroke, p, stroke.points[i - 1]));
  view.classList.add('object-prompt');
  revealPanel('player');
  openAIInspector('tVideo', '[data-object="brush"]');
  needsDraw = true;
}
function paintBrush(e, draft, g, pos) {
  const [dx, dy] = brushOffset(draft, g.m, g.time);
  const point = (ev, clip) => {
    const p = pos(ev, clip);
    return p && [p[0] - dx, p[1] - dy];
  };
  const first = point(e, false);
  if (!first) return;
  const stroke = { size: draft.size, erase: draft.erase || e.button === 2, points: [first] };
  draft.strokes.push(stroke);
  draft.pointer = e.pointerId;
  drawBrushSegment(draft, g.m, stroke, first);
  needsDraw = true;
  view.setPointerCapture(e.pointerId);
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const p = point(ev, true), prev = stroke.points.at(-1);
    if (!p || Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 1) return;
    drawBrushSegment(draft, g.m, stroke, p, prev);
    stroke.points.push(p);
    needsDraw = true;
  };
  const finish = ev => {
    if (ev.pointerId !== e.pointerId) return;
    view.removeEventListener('pointermove', move);
    view.removeEventListener('pointerup', finish);
    view.removeEventListener('lostpointercapture', finish);
    delete draft.pointer;
    if (objectDraft === draft) inspector();
  };
  view.addEventListener('pointermove', move);
  view.addEventListener('pointerup', finish);
  view.addEventListener('lostpointercapture', finish);
}
async function applyBrush(it) {
  const draft = objectEdit(it), m = objectMedia(it);
  if (!draft?.brush || !m || !draft.strokes.length || objectJob) return;
  const { seed, strokes, motion, size, track, mode } = draft;
  const job = objectJob = { clip: it.id, brush: true };
  inspector();
  try {
    const key = await inv('object_brush', { project: objectNamespace(P), path: m.path, brush: { seed, strokes, motion } });
    if (P !== draft.project || objectDraft !== draft || item(it.id) !== it || media(it)?.path !== m.path) return;
    snapshot();
    const { prompt, ...previous } = it.objectMask || {};
    it.objectMask = { ...previous, ...(draft.preset ? { invert: false } : {}), key, mode: mode || objectMode(it), brush: { seed, strokes, motion, size, track } };
    dirty = true;
    stopObjectEdit();
  } catch (e) {
    toast(cleanErr(e) === 'The brush mask is empty' ? tr('brushEmpty') : cleanErr(e));
  } finally { objectJob = null; refresh(); }
}

function decodeObject(draft, m) {
  draft.pending = true;
  draft.lost = false;
  if (draft.decoding) return;
  draft.decoding = true;
  inspector();
  (async () => {
    while (objectDraft === draft && draft.pending) {
      const { prompt, seed } = draft;
      draft.pending = false;
      try {
        const raw = new Uint8Array(await inv('sam2_preview', { path: m.path, time: seed, prompt }));
        if (objectDraft !== draft || draft.prompt !== prompt || draft.seed !== seed) continue;
        const w = raw[0] + 256 * raw[1], h = raw[2] + 256 * raw[3];
        const mask = raw.subarray(5);
        draft.lost = raw[4] !== 0 || !S.objectMaskGeometry(mask, w, h);
        if (draft.lost) continue;
        const c = draft.overlay || (draft.overlay = document.createElement('canvas'));
        c.width = w; c.height = h;
        const ctx = c.getContext('2d'), pixels = ctx.createImageData(w, h);
        for (let i = 0; i < mask.length; i++) pixels.data[4 * i + 3] = mask[i];
        ctx.putImageData(pixels, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = getComputedStyle(view).getPropertyValue('--accent').trim();
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      } catch (e) {
        if (objectDraft === draft && draft.prompt === prompt) { draft.lost = true; toast(cleanErr(e)); }
      }
    }
  })().finally(() => {
    draft.decoding = false;
    needsDraw = true;
    if (objectDraft === draft && inspTab === 'tVideo') inspector();
  });
}

function drawObjectPrompt() {
  const it = item(sel), draft = objectEdit(it), g = objectGeometry;
  view.classList.toggle('object-prompt', !!draft);
  if (!draft || !g || playing || (!draft.brush && objectFrame(g.m, g.time) !== objectFrame(g.m, draft.seed))) return;
  const { dest, crop, matrix, m } = g, ctx = vctx;
  const x = v => dest.x + (v - crop.x) * dest.w / crop.w;
  const y = v => dest.y + (v - crop.y) * dest.h / crop.h;
  const scale = P.w / Math.max(1, view.getBoundingClientRect().width);
  ctx.save();
  ctx.setTransform(...matrix);
  ctx.beginPath(); ctx.rect(dest.x, dest.y, dest.w, dest.h); ctx.clip();
  const accent = getComputedStyle(view).getPropertyValue('--accent').trim();
  if (draft.overlay) {
    ctx.globalAlpha = .45;
    const ow = draft.overlay.width, oh = draft.overlay.height;
    const [dx, dy] = draft.brush ? brushOffset(draft, m, g.time) : [0, 0];
    ctx.drawImage(draft.overlay, (crop.x - dx) / m.w * ow, (crop.y - dy) / m.h * oh,
      crop.w / m.w * ow, crop.h / m.h * oh, dest.x, dest.y, dest.w, dest.h);
    ctx.globalAlpha = 1;
  }
  if (draft.brush) { ctx.restore(); return; }
  const bbox = draft.drag || draft.prompt.bbox;
  ctx.lineWidth = 1.5 * scale;
  if (bbox) {
    ctx.strokeStyle = accent;
    ctx.setLineDash([5 * scale, 4 * scale]);
    ctx.strokeRect(x(bbox[0]), y(bbox[1]), x(bbox[2]) - x(bbox[0]), y(bbox[3]) - y(bbox[1]));
    ctx.setLineDash([]);
  }
  for (const [px, py, sign] of draft.prompt.points) {
    ctx.beginPath(); ctx.arc(x(px), y(py), 4 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = sign ? accent : '#f06565';
    ctx.strokeStyle = '#fff'; ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function objectNamespace(project) {
  let id = project.items.find(i => i.objectMask?.key)?.objectMask.key.split('/')[0] || objectProjects.get(project);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => n.toString(16).padStart(2, '0')).join('');
    objectProjects.set(project, id);
  }
  return id;
}

async function applyObject(it, still) {
  const draft = objectEdit(it), m = objectMedia(it);
  if (!m || !draft || draft.decoding || draft.lost || !draft.overlay || objectJob) return;
  const path = m.path, start = num(it.in, 0), end = start + S.srcLen(it);
  const job = objectJob = { id: uid(), clip: it.id, p: 0, cancelled: false };
  inspector();
  try {
    const res = await inv('sam2_track', { request: { project: objectNamespace(P), path, start, end,
      seed: draft.seed, prompt: draft.prompt, still: still || m.kind === 'image', job: job.id } });
    if (job.cancelled || P !== draft.project || item(it.id) !== it || media(it)?.path !== path ||
        num(it.in, 0) !== start || start + S.srcLen(it) !== end) return;
    snapshot();
    const { brush, ...previous } = it.objectMask || {};
    it.objectMask = { ...previous, key: res.key, mode: draft.mode || objectMode(it), prompt: { ...draft.prompt, time: draft.seed } };
    dirty = true;
    if (objectDraft === draft) stopObjectEdit();
    if (res.lost) toast(tr('samLostTrack'));
  } catch (e) {
    if (!job.cancelled) toast(cleanErr(e));
  } finally {
    objectJob = null;
    refresh();
  }
}

function cancelObjectJob() {
  if (!objectJob?.id) return;
  objectJob.cancelled = true;
  inv('sam2_cancel', { job: objectJob.id }).catch(e => toast(cleanErr(e)));
  inspector();
}
TA.event.listen('sam2prog', e => {
  if (objectJob?.id !== e.payload.job) return;
  objectJob.p = e.payload.p;
  const bar = $('#objectProgress');
  if (bar) {
    bar.style.setProperty('--p', objectJob.p);
    bar.querySelector('em').textContent = tr('samProgress', { p: Math.round(objectJob.p * 100) });
  }
});

function objectInspector(it, m) {
  const edit = objectEdit(it), mask = it.objectMask, fill = objectMode(it) === 'fill';
  const state = !fill && objectMatteState(it, m), painted = edit?.brush;
  const rendered = fill && fillState(it, m);
  const job = objectJob?.clip === it.id ? objectJob : null;
  const button = (id, label, disabled = false, pressed = null) => `<button class="wide" data-object="${id}"${pressed === null ? '' : ` aria-pressed="${pressed}"`}${disabled ? ' disabled' : ''}>${tr(label)}</button>`;
  const tracks = painted && m.kind === 'video' ? brushTracks(it) : [];
  const brushFields = painted ? `<p class="hint">${tr('brushHint')}</p>
    <label class="sam-field">${tr('brushSize')}<input type="range" min="4" max="300" step="1" value="${edit.size}" data-brush-field="size"></label>
    <label class="sam-field"><input type="checkbox" data-brush-field="erase"${edit.erase ? ' checked' : ''}>${tr('brushEraser')}</label>
    ${tracks.length || edit.track ? `<label class="sam-field">${tr('brushMotion')}<select data-brush-field="track">
      <option value="">${tr('brushStatic')}</option>${edit.track && !tracks.some(f => f.id === edit.track) ? `<option value="${esc(edit.track)}" selected>${tr('brushFollow')}</option>` : ''}
      ${tracks.map(f => `<option value="${esc(f.id)}"${f.id === edit.track ? ' selected' : ''}>${tr('brushFollow')}${tracks.length > 1 ? ' · ' + esc(f.text || media(f)?.name || f.id) : ''}</option>`).join('')}</select></label>` : ''}` : '';
  const running = rendered && !rendered.cache && !rendered.error && !rendered.cancelled;
  return grp('samSelect', button('select', edit && !painted ? 'samDone' : 'samSelect', !!job, !!edit && !painted) +
    button('brush', painted ? 'samDone' : 'brush', !!job, !!painted) +
    button('watermark', 'brushWatermark', !!job) +
    (painted ? brushFields + button('clear', 'brushClear', !!job || !edit.strokes.length) +
      button('apply-brush', 'samApply', !!objectJob || !edit.strokes.length)
      : edit ? `<p class="hint">${tr(edit.decoding ? 'samDecode' : edit.lost ? 'samLostSeed' : 'samHint')}</p>` +
      button('clear', 'samClearPoints', !!job || !edit.prompt.points.length && !edit.prompt.bbox) +
      button('still', m.kind === 'image' ? 'samApply' : 'samApplyFrame', !!objectJob || edit.decoding || edit.lost || !edit.overlay) +
      (m.kind === 'video' ? button('track', 'samTrack', !!objectJob || edit.decoding || edit.lost || !edit.overlay) : '') : '') +
    (job && !job.brush ? `<div class="pxb insp" id="objectProgress" role="status" style="--p:${job.p}"><i></i><em>${tr('samProgress', { p: Math.round(job.p * 100) })}</em></div>` + button('cancel', 'cancel', job.cancelled) : '') +
    (mask ? (state && (state.error || state.matte?.lost || !state.matte) ? `<p class="hint">${tr(state.error ? 'samCacheMissing' : state.matte?.lost ? 'samLostTrack' : 'samPreparing')}</p>` : '') +
      `<label class="sam-field">${tr('samMode')}<select data-object-field="mode">${['keep', 'pixel', 'pop', 'fill'].map(mode => `<option value="${mode}"${objectMode(it) === mode ? ' selected' : ''}>${tr('sam_' + mode)}</option>`).join('')}</select></label>
      <label class="sam-field"><input type="checkbox" data-object-field="invert"${mask.invert ? ' checked' : ''}>${tr('mkInvert')}</label>
      <label class="sam-field">${tr('samFeather')}<input type="number" min="0" max="128" step="1" value="${objectEdges(it).feather}" data-object-field="feather"></label>
      <label class="sam-field">${tr('samExpand')}<input type="number" min="-128" max="128" step="1" value="${objectEdges(it).expand}" data-object-field="expand"></label>` +
      (fill && m.kind === 'video' ? `<label class="sam-field"><input type="checkbox" data-object-field="smooth"${mask.smooth !== false ? ' checked' : ''}>${tr('fillSmooth')}</label>` : '') +
      (running ? `<div class="pxb insp" id="fillProgress" data-job="${rendered.job}" role="status" style="--p:${rendered.p}"><i></i><em>${tr('fillProgress', { p: Math.round(rendered.p * 100) })}</em></div>` + button('fill-cancel', 'cancel') : '') +
      (rendered && !running && !rendered.cache ? `<p class="hint">${rendered.cancelled ? tr('cancelled') : esc(fillError(rendered))}</p>` + button('fill-retry', rendered.needsModel ? 'aiDownload' : 'fillRender') : '') +
      button('remove', 'samRemoveMask', !!job) : ''));
}

function objectPointer(e) {
  const it = item(sel), draft = objectEdit(it), g = objectGeometry;
  if (!draft || ![0, 2].includes(e.button)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (playing || !g || objectJob?.clip === it.id || draft.pointer != null) return;
  const r = view.getBoundingClientRect();
  const toSource = (ev, clip) => S.objectSourcePoint([(ev.clientX - r.left) * P.w / r.width, (ev.clientY - r.top) * P.h / r.height],
    g.matrix, g.dest, g.crop, clip);
  if (draft.brush) { paintBrush(e, draft, g, toSource); return; }
  const from = toSource(e, false);
  if (!from) return;
  if (objectFrame(g.m, g.time) !== objectFrame(g.m, draft.seed)) {
    draft.seed = g.time; draft.prompt = { points: [], bbox: null }; draft.overlay = null;
  }
  if (e.button === 2) {
    draft.prompt = { ...draft.prompt, points: [...draft.prompt.points, [...from, 0]] };
    decodeObject(draft, g.m);
    return;
  }
  const negative = e.altKey;
  const moved = ev => Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 5;
  draft.pointer = e.pointerId;
  view.setPointerCapture(e.pointerId);
  const move = ev => {
    if (ev.pointerId !== e.pointerId || negative || (!draft.drag && !moved(ev))) return;
    draft.drag = S.objectPromptBox(from, toSource(ev, true));
    needsDraw = true;
  };
  const finish = ev => {
    if (ev.pointerId !== e.pointerId) return;
    view.removeEventListener('pointermove', move);
    view.removeEventListener('pointerup', finish);
    view.removeEventListener('lostpointercapture', finish);
    delete draft.pointer;
    delete draft.drag;
    needsDraw = true;
    if (ev.type !== 'pointerup' || objectEdit(it) !== draft) return;
    draft.prompt = !negative && moved(ev) ? { ...draft.prompt, bbox: S.objectPromptBox(from, toSource(ev, true)) } :
      { ...draft.prompt, points: [...draft.prompt.points, [...from, negative ? 0 : 1]] };
    decodeObject(draft, g.m);
  };
  view.addEventListener('pointermove', move);
  view.addEventListener('pointerup', finish);
  view.addEventListener('lostpointercapture', finish);
}

// Remove background: an AI matte video per source file, multiplied into the clip's alpha.
// Two models: people (MODNet) and objects/products (BiRefNet-lite)
const matteTool = {};
const mtKind = it => (it.rmbgKind === 'object' ? 'object' : 'person');
for (const k of ['person', 'object']) inv('matte_ready', { kind: k }).then(v => (matteTool[k] = v), () => {});
const matteOk = new Map(), mattePath = new Map(), matteProg = new Map();
function matteFor(it, m = media(it)) {
  if (!it.rmbg || m?.kind !== 'video' || !matteTool[mtKind(it)]) return null;
  const k = mtKey(it, m);
  if (mattePath.has(k)) return mattePath.get(k);
  if (!matteOk.has(k)) matteOk.set(k, inv('matte_make', { path: m.path, job: it.id, kind: mtKind(it), full: !!it.rmbgFull })
    .then(p => { mattePath.set(k, p); needsDraw = true; if (inspTab === 'tVideo') inspector(); return p; }, e => { mattePath.set(k, null); toast(cleanErr(e)); return null; }));
  return '';
}
const mtKey = (it, m) => m.path + '|' + mtKind(it) + (mtKind(it) === 'object' && it.rmbgFull ? '|full' : '');
const matteWait = (it, m) => (matteFor(it, m), matteOk.get(mtKey(it, m)) || Promise.resolve(null));
TA.event.listen('matteprog', e => { matteProg.set(e.payload.job, e.payload.p); const b = document.querySelector(`[data-mtbar="${e.payload.job}"]`); if (b) { b.style.setProperty('--p', e.payload.p); b.querySelector('em').textContent = tr('mtPrep').replace('{p}', Math.round(e.payload.p * 100)); } });
function matteEl(it, project = P) {
  const m = media(it, project), path = matteFor(it, m);
  const key = (project === P || project === playbackProject ? chainKey(it) : mtKey(it, m)) + '|mt';
  return matteVideo(key, path);
}
function matteVideo(key, path) {
  const url = urlOf({ path });
  let el = els.get(key);
  if (el && el.dataset.src === url) return el;
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
  el = document.createElement('video');
  Object.assign(el, { preload: 'auto', muted: true, playsInline: true, crossOrigin: 'anonymous' });
  el.dataset.src = el.src = url;
  for (const event of ['loadeddata', 'seeked']) el.addEventListener(event, () => (needsDraw = true));
  mediaHold.appendChild(el); // WebKit only feeds fresh frames from a <video> in the document
  els.set(key, el);
  return el;
}
const rifeWait = (it, m) => (rifeFor(it, m), rifeOk.get(rifeKey(it, m)) || Promise.resolve(null));
TA.event.listen('rifeprog', e => { const g = pxProg.get(e.payload.job); if (g) { g.p = e.payload.p * 0.85; pxPaint(e.payload.job); } });
function proxyFor(it) {
  if (!(S.hasCurve(it) || smoothSlow(it)) || media(it).kind !== 'video') return null;
  const key = pxKey(it);
  if (pxPath.has(key)) return pxPath.get(key);
  if (cancelProTrim) return null;
  if (!pxOk.has(key)) {
    const w = pxWait.get(it.id), now = performance.now();
    if (!w || w.key !== key) { pxWait.set(it.id, { key, at: now }); pxProg.delete(it.id); setTimeout(() => (needsDraw = true), 450); pxPaint(it.id); return null; }
    if (now - w.at < 400) return null; // still being edited: start once the curve stops changing
    const rf = smoothSlow(it) ? rifeFor(it) : null;
    if (rf === '') { if (!pxProg.has(it.id) || pxProg.get(it.id).key !== key) { pxProg.set(it.id, { key, p: 0 }); pxPaint(it.id); } return null; } // AI frames first
    const m = media(it);
    const k = Math.min(1, 960 / Math.max(m.w, m.h)), ev = v => Math.max(2, Math.round(v * k / 2) * 2);
    const q = { w: ev(m.w), h: ev(m.h), fps: P.fps, media: { m }, tracks: [{ id: 'v', kind: 'video' }],
      items: [{ id: 'x', track: 'v', media: 'm', start: 0, dur: it.dur, in: num(it.in, 0), curve: it.curve, speed: it.speed, smooth: it.smooth, pitch: it.pitch, fit: 'cover' }] };
    let args;
    try { args = G.buildArgs(q, { out: '__OUT__', codec: 'proxy', rife: rf ? { x: rf } : null }).args.filter(a => a !== '-progress' && a !== 'pipe:1'); } catch { args = null; }
    pxProg.set(it.id, { key, p: 0 }); pxPaint(it.id);
    pxOk.set(key, args ? inv('proxy_render', { args, job: it.id, total: it.dur }).then(path => { pxPath.set(key, path); needsDraw = true; pxPaint(it.id); return path; },
      e => { if (String(e).includes('cancelled')) pxOk.delete(key); return null; }) : Promise.resolve(null));
  }
  return null;
}
// Preparing a curve / slow-mo clip: shown on the clip in the timeline and in the Speed panel.
const pxWait = new Map(), pxProg = new Map(); // clip id -> {key, at} / {key, p}
const pxNeeds = it => it && !it.audioOnly && !it.id.includes('|mc') && !isText(it) &&
  media(it)?.kind === 'video' && !media(it).angles && (S.hasCurve(it) || smoothSlow(it));
function pxStatus(it) {
  if (!pxNeeds(it)) return null;
  const key = pxKey(it);
  if (pxPath.has(key)) return { ready: true, p: 1 };
  const g = pxProg.get(it.id);
  return { ready: false, p: g && g.key === key ? g.p : 0 };
}
const pxLabel = s => s.ready ? tr('pxReady') : tr('pxPrep').replace('{p}', Math.round(s.p * 100));
const pxBar = (it, cls) => { const s = pxStatus(it); return s ? `<div class="pxb ${cls}${s.ready ? ' done' : ''}" data-pxbar="${it.id}" style="--p:${s.p}"><i></i><em>${pxLabel(s)}</em></div>` : ''; };
function pxPaint(id) {
  const s = pxStatus(item(id));
  for (const el of document.querySelectorAll(`[data-pxbar="${id}"]`)) {
    if (!s) { el.hidden = true; continue; }
    el.hidden = false; el.classList.toggle('done', s.ready); el.style.setProperty('--p', s.p);
    el.querySelector('em').textContent = pxLabel(s);
  }
}
TA.event.listen('pxprog', e => { const g = pxProg.get(e.payload.job); if (g) { g.p = e.payload.p; pxPaint(e.payload.job); } });
const mediaProxies = new Map(), manualProxies = new Set();
let proxyJob, proxyLookup = 0, proxyDeleting = false;
const proxyMode = () => proxyPrefs['kadr.proxyMode'];
const proxyHigh = () => proxyPrefs['kadr.proxyHigh'];
const proxyEnabled = () => proxyPrefs['kadr.proxy'];
const proxySources = () => new Map(Object.values(P.media).filter(m => S.needsProxy(m, 'always') && m.path).map(m => [m.path, m]));
const proxyEntry = m => {
  const entry = mediaProxies.get(m?.path);
  return entry && entry.sourceKey === m.sourceKey && entry.high === proxyHigh() ? entry : undefined;
};
function mediaProxy(m) {
  return proxyEnabled() ? proxyEntry(m)?.file : undefined;
}
function proxyEntryFor(m) {
  let entry = proxyEntry(m);
  if (!entry && m.sourceKey) {
    entry = { sourceKey: m.sourceKey, high: proxyHigh() };
    mediaProxies.set(m.path, entry);
  }
  return entry;
}
function paintMediaProxies() {
  for (const badge of $$('#binList .proxy-badge')) {
    const entry = proxyEntry(P.media[badge.closest('.mi').dataset.mid]);
    const building = entry?.progress != null;
    badge.hidden = !building && !entry?.file;
    badge.classList.toggle('building', building);
    badge.style.setProperty('--progress', (entry?.progress || 0) * 360 + 'deg');
    badge.title = building ? tr('proxyBuilding', { n: Math.round(entry.progress * 100) }) : tr('proxyReady');
    badge.setAttribute('aria-label', badge.title);
  }
}
function proxyChanged() {
  paintMediaProxies();
  syncMedia();
  needsDraw = true;
}
function pumpMediaProxies() {
  if (proxyJob || proxyDeleting) return;
  const mode = proxyMode(), suppressed = new Set(lsGet('kadr.proxyDeleted', []));
  for (const [path, m] of proxySources()) {
    const entry = proxyEntry(m);
    if (!entry || entry.file || entry.failed || (!entry.manual &&
      (!S.needsProxy(m, mode) || suppressed.has(m.sourceKey)))) continue;
    const job = { id: uid(), path, entry };
    proxyJob = job;
    entry.progress = 0;
    paintMediaProxies();
    job.done = inv('make_proxy', { path, high: entry.high, toneMap: G.toneMap(m), job: job.id, sourceKey: entry.sourceKey })
      .then(file => { if (!job.cancelled && proxyEntry(m) === entry) entry.file = file; })
      .catch(e => {
        if (!job.cancelled) {
          entry.failed = true;
          if (entry.manual) toast(tr('error') + ': ' + cleanErr(e));
        }
      }).finally(() => {
        delete entry.progress;
        delete entry.manual;
        proxyJob = null;
        proxyChanged();
        refreshProxySize();
        pumpMediaProxies();
      });
    break;
  }
}
TA.event.listen('mediaproxyprog', ({ payload: { job, p } }) => {
  if (proxyJob?.id !== job || proxyJob.cancelled) return;
  proxyJob.entry.progress = p;
  paintMediaProxies();
});
function mergeSourceMeta(m, fresh) {
  if (m.sourceKey === fresh.sourceKey && typeof m.hdr === 'boolean' && 'codec' in m && 'audioChannels' in m && 'firstMarker' in m) return;
  for (const key of ['w', 'h', 'dur', 'fps', 'hasAudio', 'audioChannels', 'hdr', 'trc', 'primaries', 'matrix', 'codec', 'bitrate', 'sourceKey', 'firstMarker']) {
    if (key in fresh) m[key] = fresh[key];
    else delete m[key];
  }
}
async function syncMediaProxies(manualPath) {
  if (manualPath) manualProxies.add(manualPath);
  const sources = proxySources(), high = proxyHigh(), request = ++proxyLookup;
  for (const path of manualProxies) if (!sources.has(path)) manualProxies.delete(path);
  if (!sources.size || proxyDeleting) return;
  try {
    const paths = [...sources.keys()];
    const knownFiles = new Map(paths.map(path => [path, mediaProxies.get(path)?.file]));
    const info = await inv('media_proxy_info', { paths, high });
    if (request !== proxyLookup) return;
    const changed = paths.filter(path => info[path] && (info[path].sourceKey !== sources.get(path).sourceKey || !('codec' in sources.get(path))));
    const fresh = changed.length ? (await inv('probe', { paths: changed })).ok : [];
    if (request !== proxyLookup) return;
    for (const m of Object.values(P.media)) {
      if (!sources.has(m.path) || m.kind !== 'video') continue;
      const update = fresh.find(f => f.path === m.path);
      if (update) {
        mergeSourceMeta(m, update);
        dirty = true;
      }
      const data = info[m.path];
      if (!data || data.sourceKey !== m.sourceKey) {
        mediaProxies.delete(m.path);
        continue;
      }
      const entry = proxyEntryFor(m);
      if (data.path || entry.file === knownFiles.get(m.path)) entry.file = data.path || undefined;
      if (manualProxies.delete(m.path)) { entry.manual = true; entry.failed = false; }
    }
    proxyChanged();
    pumpMediaProxies();
  } catch (e) {
    if (request === proxyLookup && manualProxies.size) {
      manualProxies.clear();
      toast(tr('error') + ': ' + cleanErr(e));
    }
  }
}
async function cancelProxyJob() {
  const job = proxyJob;
  if (!job) return;
  job.cancelled = true;
  await inv('cancel_media_proxy', { job: job.id }).catch(() => {});
  await job.done;
}
async function deleteMediaProxies(path, cancelOnly = false) {
  if (proxyDeleting) return;
  proxyDeleting = true;
  ++proxyLookup;
  const suppressed = new Set(lsGet('kadr.proxyDeleted', []));
  for (const [source, m] of proxySources()) if ((!path || path === source) && m.sourceKey) suppressed.add(m.sourceKey);
  lsSet('kadr.proxyDeleted', [...suppressed]);
  if (path) { mediaProxies.delete(path); manualProxies.delete(path); }
  else { mediaProxies.clear(); manualProxies.clear(); }
  proxyChanged();
  try {
    if (proxyJob && (!path || proxyJob.path === path)) await cancelProxyJob();
    if (!cancelOnly) await inv('delete_media_proxies', { path });
  } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
  finally {
    proxyDeleting = false;
    syncMediaProxies();
    refreshProxySize();
  }
}
async function setProxyPreference(key, value) {
  proxyDeleting = true;
  ++proxyLookup;
  proxyPrefs[key] = value;
  lsSet(key, value);
  lsSet('kadr.proxyDeleted', []);
  try {
    if (proxyJob && (proxyJob.entry.high !== proxyHigh() || (proxyMode() === 'off' && !proxyJob.entry.manual))) await cancelProxyJob();
  } finally {
    proxyDeleting = false;
    syncMediaProxies();
    proxyChanged();
  }
}
function paintProxyToggle() {
  $('#bProxy').classList.toggle('on', proxyEnabled());
  $('#bProxy').setAttribute('aria-pressed', String(proxyEnabled()));
}
function toggleProxies() {
  proxyPrefs['kadr.proxy'] = !proxyEnabled();
  lsSet('kadr.proxy', proxyEnabled());
  paintProxyToggle();
  proxyChanged();
}
function elFor(it, visual = null) {
  const m = media(it), audio = it.audioOnly || m.kind === 'audio';
  const rp = visual || it.id.includes('|mc') || it.audioOnly ? null : proxyFor(it);
  const px = visual || it.audioOnly ? null : rp || mediaProxy(m);
  const url = px ? urlOf({ path: px }) : urlOf(visual || m), key = visual ? it.id + '|prepared' : chainKey(it);
  let el = els.get(key);
  if (el && el.dataset.src === url && el._sourceKey === m.sourceKey) return el;
  const replaced = !!el;
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
  el = document.createElement(audio ? 'audio' : 'video');
  el.preload = 'auto';
  el.crossOrigin = 'anonymous'; // untainted frames for WebGL grading

  el.playsInline = true;
  el._sourceKey = m.sourceKey;
  el._restoreTime = replaced || !!visual;
  el._depth = !!visual?.depth;
  el._preparedOrigin = visual && !visual.animatedStill ? num(it.in, 0) : 0;
  if (visual) el.muted = true;
  el._proxy = !!px;
  el._px = !!rp || !!visual?.animatedStill; // a retimed proxy plays timeline time; a plain one keeps source time
  el.dataset.src = url;
  el.src = url;
  el.addEventListener('seeked', () => (needsDraw = true));
  el.addEventListener('loadeddata', () => (needsDraw = true));
  // WebKit only feeds fresh frames to drawImage from a <video> that is in the document.
  if (!audio) mediaHold.appendChild(el);
  els.set(key, el);
  return el;
}
function imgFor(m) {
  const url = urlOf(m);
  let im = imgs.get(url);
  if (!im) { im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => (needsDraw = true); im.src = url; imgs.set(url, im); }
  return im;
}
// Blend modes (Photoshop names -> canvas); the export uses ffmpeg's blend filter with the same modes.
const BLENDS = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', softlight: 'soft-light',
  hardlight: 'hard-light', difference: 'difference', exclusion: 'exclusion', addition: 'lighter', dodge: 'color-dodge', burn: 'color-burn' };
// Transition tail: the outgoing clip's last frame, grabbed once with its own decoder (the playback
// element may already be showing the next piece of the same file).
const tails = new Map();
function tailFrame(it) {
  const original = media(it), visual = preparedVisual(it, original), m = visual || original;
  const px = !visual && mediaProxy(m);
  const id = it.id + (px ? '|proxy' : '');
  const lt = Math.max(0, it.dur - 0.5 / P.fps);
  const at = visual?.depth ? depthLastFrame(visual) : (visual ? 0 : num(it.in, 0)) + S.srcAt(it, lt);
  const key = JSON.stringify([px || m.path, m.sourceKey, at]);
  let c = tails.get(id);
  if (c && c._key === key) return c._ok ? c : null;
  if (!c) tails.set(id, c = document.createElement('canvas'));
  Object.assign(c, { _key: key, _ok: false });
  readVideoFrame(m, at, px || m.path).then(v => {
    try {
      if (c._key === key) {
        const s = Math.min(1, 1280 / Math.max(m.w, m.h));
        c.width = Math.round(m.w * s); c.height = Math.round(m.h * s);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c._ok = true; needsDraw = true;
      }
    } finally {
      releaseVideoFrame(v);
    }
  }).catch(() => {});
  return null;
}
// Fill layers (solid colour or gradient), drawn at frame size. Points are 0..1 of the layer box.
const FILL_DEF = { type: 'linear', c1: '#000000', a1: 0, c2: '#000000', a2: 0.85, x1: 0.5, y1: 0.35, x2: 0.5, y2: 1, mid: 0.5 };
const fills = new Map();
function hexA(hex, a) { const n = parseInt(String(hex).slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${clamp(num(a, 1), 0, 1)})`; }
function paintFill(g, f, w, h) {
  f = { ...FILL_DEF, ...f };
  g.clearRect(0, 0, w, h);
  if (f.type === 'solid') { g.fillStyle = hexA(f.c1, 1); return g.fillRect(0, 0, w, h); }
  const gr = f.type === 'radial'
    ? g.createRadialGradient(f.x1 * w, f.y1 * h, 0, f.x1 * w, f.y1 * h, Math.max(1, Math.hypot((f.x2 - f.x1) * w, (f.y2 - f.y1) * h)))
    : g.createLinearGradient(f.x1 * w, f.y1 * h, f.x2 * w, f.y2 * h);
  const n1 = parseInt(f.c1.slice(1), 16), n2 = parseInt(f.c2.slice(1), 16), mix = (s, k) => Math.round(((n1 >> s & 255) + (n2 >> s & 255)) / 2);
  gr.addColorStop(0, hexA(f.c1, f.a1));
  gr.addColorStop(clamp(num(f.mid, 0.5), 0.02, 0.98), `rgba(${mix(16)},${mix(8)},${mix(0)},${(num(f.a1, 1) + num(f.a2, 1)) / 2})`);
  gr.addColorStop(1, hexA(f.c2, f.a2));
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}
function fillCanvas(it, w = P.w, h = P.h) {
  const key = JSON.stringify(it.fill) + w + 'x' + h;
  let c = fills.get(it.id);
  if (c && c._key === key) return c;
  if (!c) fills.set(it.id, c = document.createElement('canvas'));
  c.width = w; c.height = h; c._key = key; c._w = w;
  paintFill(c.getContext('2d'), it.fill || {}, w, h);
  return c;
}
// Gradient handles on the preview: start point, end point and the midpoint diamond (as in Photoshop).
const fillPts = (f, L) => { f = { ...FILL_DEF, ...f }; const P1 = [L.ox + f.x1 * L.cw, L.oy + f.y1 * L.ch], P2 = [L.ox + f.x2 * L.cw, L.oy + f.y2 * L.ch], q = num(f.mid, 0.5);
  return { p1: P1, p2: P2, mid: [P1[0] + (P2[0] - P1[0]) * q, P1[1] + (P2[1] - P1[1]) * q] }; };
function drawFillGuide(ctx, f, L) {
  const p = fillPts(f, L), s = P.w / Math.max(1, view.getBoundingClientRect().width); // screen pixel in project units
  ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = 3 * s; ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(...p.p1); ctx.lineTo(...p.p2); ctx.stroke();
  for (const [pt, r, c] of [[p.p1, 9, f.c1 || '#000'], [p.p2, 7, f.c2 || '#000']]) {
    ctx.beginPath(); ctx.arc(pt[0], pt[1], r * s, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 3 * s; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  ctx.translate(...p.mid); ctx.rotate(Math.PI / 4); ctx.fillStyle = '#fff'; ctx.fillRect(-6 * s, -6 * s, 12 * s, 12 * s);
  ctx.restore();
}
// Denoise / normalize: each source's sound is processed once per effect set (audio_fx, cached),
// then played and exported in its place.
const dnOk = new Map(), dnReady = new Map(), voiceJobs = new Map(), voiceErrors = new Map();
const fxId = (it, m = media(it)) => JSON.stringify([m.path, m.sourceKey, S.fxKey(it)]);
const voiceError = e => cleanErr(e) === 'voice_clean_missing' ? tr('voiceMissing') : cleanErr(e);
const stopVoice = job => job && inv('voice_clean_cancel', { job }).catch(e => toast(cleanErr(e)));
function ensureDn(it, m = media(it)) {
  const id = fxId(it, m), fx = S.fxKey(it);
  if (!dnOk.has(id)) {
    const voice = fx.startsWith('voice:');
    const state = voice ? { job: uid(), p: 0, listeners: new Set() } : null;
    if (state) {
      voiceJobs.set(id, state);
      voiceErrors.delete(id);
    }
    dnOk.set(id, inv('audio_fx', { path: m.path, fx, job: state?.job }).then(path => {
      dnReady.set(id, path); needsDraw = true; return path;
    }, e => {
      dnOk.delete(id);
      if (state) voiceErrors.set(id, cleanErr(e));
      throw e;
    }).finally(() => {
      if (state) { voiceJobs.delete(id); paintVoiceClean(); }
    }));
    if (state) paintVoiceClean();
  }
  return dnOk.get(id).then(path => { (m.fx ??= {})[fx] = path; return path; });
}
TA.event.listen('voice-clean-progress', ({ payload: { job, p } }) => {
  const state = [...voiceJobs.values()].find(s => s.job === job);
  if (!state) return;
  state.p = p;
  paintVoiceClean();
  for (const listener of state.listeners) listener();
});
async function dnPrep(project = P, signal, onProgress) {
  const pending = new Set();
  const tasks = project.items.filter(i => {
    const m = media(i, project), fx = S.fxKey(i);
    return m && fx && (!fx.startsWith('voice:') || G.audible(project, i));
  }).map(i => {
    const m = media(i, project), result = ensureDn(i, m);
    const state = voiceJobs.get(fxId(i, m));
    if (state) pending.add(state);
    return result;
  });
  const report = () => {
    if (!signal?.aborted && pending.size) onProgress?.([...pending].reduce((sum, state) => sum + state.p, 0) / pending.size);
  };
  const abort = () => { for (const state of pending) stopVoice(state.job); };
  for (const state of pending) state.listeners.add(report);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  report();
  try {
    const results = await Promise.allSettled(tasks);
    const error = results.find(r => r.status === 'rejected');
    if (error) throw voiceError(error.reason);
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const state of pending) state.listeners.delete(report);
  }
}
const dnLive = it => !!S.fxKey(it) && dnReady.has(fxId(it));
function dnEl(it) {
  const m = media(it), key = chainKey(it) + '|dn', url = urlOf({ path: dnReady.get(fxId(it, m)) });
  let el = els.get(key);
  if (el && el.dataset.src === url && el._sourceKey === m.sourceKey) return el;
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
  el = document.createElement('audio');
  el.preload = 'auto';
  el.dataset.src = el.src = url;
  el._sourceKey = m.sourceKey;
  els.set(key, el);
  return el;
}
function gcEls() {
  for (const [id, el] of els) {
    const it = item(id.split('|')[0]);
    if (it && (!id.endsWith('|prepared') || preparedVisual(it, media(it)))) continue;
    el.pause(); el.removeAttribute('src'); el.load(); el.remove(); els.delete(id);
  }
}
function playMedia(el) {
  if (el._play || performance.now() < el._retryPlay) return;
  const p = el._play = el.play();
  const done = e => {
    if (el._play !== p) return;
    el._play = null;
    if (e && e.name !== 'AbortError') el._retryPlay = performance.now() + 250;
  };
  p.then(() => done(), done);
}
function pauseMedia(el) {
  el._play = null;
  el._retryPlay = 0;
  if (!el.paused) el.pause();
}
function syncMedia(project = S.expandMulticam(P)) {
  playbackProject = project;
  // One controller per element: the active piece, else the next one coming up.
  const ctl = new Map();
  for (const it of playbackProject.items) {
    const m = media(it);
    if (!m || m.kind === 'image') continue;
    const k = chainKey(it), c = ctl.get(k);
    if (!c || (!active(c, t) && (active(it, t) || (it.start > t && (c.start <= t || it.start < c.start))))) ctl.set(k, it);
  }
  const viewer = panelVisible('multicam') && activeMulticam();
  const angles = viewer ? viewerAngles(viewer) : [];
  for (const it of angles) {
    if (!it) continue;
    const key = chainKey(it), current = ctl.get(key);
    if (!current || !active(current, t)) ctl.set(key, it);
  }
  try { waSync(); } catch (e) { console.error(e); } // sound must never stop the playback loop
  const driven = new Set();
  const drive = (el, it, silent) => { driven.add(el); driveEl(el, it, silent); };
  for (const it of ctl.values()) {
    const fx = S.fxKey(it);
    if (fx && (!fx.startsWith('voice:') || hasSound(media(it)) && !it.muted && !voiceErrors.has(fxId(it)))
      && !dnOk.has(fxId(it))) ensureDn(it).catch(() => {});
    const dn = dnLive(it);
    const el = elFor(it);
    drive(el, it, dn);
    if (!it.audioOnly && !it.id.endsWith('|viewer') && matteFor(it)) drive(matteEl(it), it, true);
    if (dn) drive(dnEl(it), it, false);
  }
  for (const it of project.items) {
    const m = media(it, project), visual = !it.hidden && !it.audioOnly && preparedVisual(it, m, project);
    if (visual?.kind === 'video' && (active(it, t) || playing && it.start > t && it.start - t < 1.5)) drive(elFor(it, visual), it, true);
    if (!it.objectMask || it.audioOnly || !active(it, t) && !(playing && it.start > t && it.start - t < 0.8)) continue;
    const mt = objectMode(it) !== 'fill' && objectMatteState(it, m)?.matte;
    if (mt && m.kind === 'video' && mt.last > mt.origin) drive(objectMatteEl(it, mt), it, true);
  }
  renderMulticamViewer(viewer, angles);
  for (const el of els.values()) {
    if (driven.has(el)) continue;
    pauseMedia(el);
  }
  driveTails();
}
// Clip sound through Web Audio: each source's sound track is pulled out once (audio_fx 'x'), decoded,
// and started sample-exact at its cut. A <video> that starts its own sound blocks WebKit's page for
// ~200 ms at every cut, so those players stay muted and only give the picture.
const AC = window.AudioContext ? new AudioContext({ latencyHint: 'interactive' }) : null;
const waLat = () => (AC.outputLatency || 0) + (AC.baseLatency || 0); // seconds between start() and the speaker
// Decoded sound per source path, kept outside the project: undo snapshots and saves copy P as JSON.
const waBuf = new Map(), waReady = new Map(), waLive = new Map();
const hasSound = m => !!m && (m.kind === 'audio' || (m.kind === 'video' && m.hasAudio));
const duckBusy = new Set();
function duckPlan(it) {
  const { amount, attack, release, source } = { ...S.DUCK_DEFAULTS, ...it.duck };
  const { start, dur } = it;
  const from = start - clamp(num(release, S.DUCK_DEFAULTS.release), 0.01, 5);
  const to = start + dur + clamp(num(attack, S.DUCK_DEFAULTS.attack), 0.01, 5);
  const sources = P.items.filter(i => i !== it && (!source || i.track === source) &&
    i.start < to && i.start + i.dur > from && G.audible(P, i)).map(i => ({
      path: media(i).path, start: i.start, dur: i.dur, in: i.in, speed: i.speed, curve: i.curve,
    }));
  return { start, dur, amount, attack, release, source, on: it.duck?.on, sources };
}
async function generateDucking(it) {
  if (media(it)?.kind !== 'audio') throw new Error(tr('duckAudioOnly'));
  if (duckBusy.has(it)) throw new Error(tr('duckWork'));
  const project = P, plan = duckPlan(it), stamp = JSON.stringify(plan);
  duckBusy.add(it);
  if (sel === it.id) inspector();
  try {
    const found = new Map(), regions = [];
    for (const clip of plan.sources) {
      if (!found.has(clip.path)) found.set(clip.path, await inv('speech_regions', { path: clip.path }));
      for (const [a, b] of S.speechTimelineRegions(clip, found.get(clip.path))) regions.push([a - plan.start, b - plan.start]);
    }
    if (P !== project || item(it.id) !== it || JSON.stringify(duckPlan(it)) !== stamp) throw new Error(tr('duckChanged'));
    const keys = S.duckGainKeys(regions, plan.dur, plan);
    // Nothing found and nothing old to clear: no undo step (the #duckGo handler toasts duckEmpty for keyframes 0).
    if (!keys.length && !it.kf?.volume?.some(q => q[2] === 'duck' || q[2] === 'ducked')) return { keyframes: 0 };
    snapshot();
    (it.duck ??= {}).on = true;
    return { keyframes: S.writeDuckKeys(it, keys) };
  } finally {
    duckBusy.delete(it);
    refresh();
  }
}
const waOk = it => hasSound(media(it)) && !S.fxKey(it) && !S.hasCurve(it) && (num(it.speed, 1) === 1 || !!it.pitch);
const waOf = m => (m && waReady.get(m.path)) || null;
let waTime = 0, waAt = 0;
const waRunning = (now = lastTick) => AC?.state === 'running' && now - waAt < 250;
AC?.addEventListener('statechange', () => {
  inv('dev_log', { msg: 'audio context ' + AC.state }).catch(() => {});
  if (AC.state !== 'running') waStopAll();
});
function waLoad(mid) {
  const m = P.media[mid];
  if (!m || waBuf.has(m.path) || num(m.dur, 0) > 900) return; // shortcut: very long sources keep element audio (memory)
  const path = m.path;
  waBuf.set(path, inv('audio_fx', { path, fx: 'x' })
    .then(p => fetch(urlOf({ path: p }))).then(r => r.arrayBuffer()).then(b => AC.decodeAudioData(b))
    .then(B => { waReady.set(path, B); }, e => inv('dev_log', { msg: 'wa failed ' + e })));
}
function waStop(id) { const n = waLive.get(id); if (!n) return; try { n.src.stop(); } catch {} n.src.disconnect(); n.g.disconnect(); waLive.delete(id); }
function waStopAll() { for (const id of waLive.keys()) waStop(id); }
function waSync() {
  if (!waRunning() || !playing || clockHeld()) return waStopAll();
  const want = new Set();
  for (const it of playbackProject.items) {
    if (it.muted || !waOk(it)) continue;
    waLoad(it.media);
    // play ahead by the output delay, so each word reaches the speaker on its frame (and its caption)
    const B = waOf(media(it)), local = t - it.start, lt = local + waLat() * playRate;
    if (!B || lt < -0.3 * playRate || local >= it.dur) continue; // starts up to 0.3 s ahead, scheduled on the audio clock
    const sp = num(it.speed, 1), in0 = num(it.in, 0), now = AC.currentTime;
    const from = Math.max(0, lt), off = in0 + from * sp;
    let n = waLive.get(it.id);
    // Let the audio clock advance before correcting drift again.
    if (n && (n.sp !== sp || n.in0 !== in0 || n.dur !== it.dur || n.src.buffer !== B ||
        (now - n.at > 0.25 && lt > 0.2 && Math.abs((now - n.t0) * playRate - lt) > 0.12 * playRate))) { waStop(it.id); n = null; }
    if (!n) {
      if (lt >= it.dur || off >= B.duration) continue;
      const src = AC.createBufferSource(), g = AC.createGain(), when = now + Math.max(0, -lt) / playRate;
      const len = (it.dur - from) * sp;
      src.buffer = B; src.playbackRate.value = sp * playRate;
      g.gain.value = 0;
      src.start(when, off, len);
      src.connect(g).connect(AC.destination);
      waLive.set(it.id, n = { src, g, sp, in0, dur: it.dur, at: now, t0: when - from / playRate });
      if (off + len > B.duration) src.onended = () => { if (waLive.get(it.id)?.src === src) waStop(it.id); };
      // Mute the fallback before opening the gain, even if another player stalls this frame.
      const el = local >= 0 && els.get(chainKey(it));
      if (el && !el.muted) el.muted = true;
    }
    want.add(it.id);
    const x = clamp(lt, 0, it.dur);
    n.g.gain.value = clamp(S.volumeAt(it, x) * S.audioFade(it, x), 0, 2);
  }
  for (const id of waLive.keys()) if (!want.has(id)) waStop(id);
}
// Under a shader transition the outgoing clip keeps playing from its source past its out-point (both
// clips move, as in CapCut), on an element of its own; with no source left it holds its last frame.
const tailSrcAt = (it, x, m = media(it)) => Math.min(Math.max(0, num(m.dur, 0) - 0.05), num(it.in, 0) + S.srcAt(it, it.dur) + x * (S.hasCurve(it) ? S.rateAt(it, it.dur) : num(it.speed, 1)));
const liveTail = it => { const m = media(it), TO = S.transOut(playbackProject ?? P, it); return !!TO && S.GLT.includes(TO.id) && m && m.kind === 'video' && !m.fill && !m.adj ? TO : null; };
const tailEls = new Map();
function tailEl(key, it) {
  const m = media(it), visual = preparedVisual(it, m);
  const px = !visual && mediaProxy(m), url = px ? urlOf({ path: px }) : urlOf(visual || m);
  let el = tailEls.get(key);
  if (el && el.dataset.src === url) return el;
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
  el = document.createElement('video');
  Object.assign(el, { preload: 'auto', crossOrigin: 'anonymous', playsInline: true, muted: true });
  el._sourceKey = m.sourceKey;
  el.dataset.src = url; el.src = url;
  el.addEventListener('seeked', () => (needsDraw = true));
  el.addEventListener('loadeddata', () => (needsDraw = true));
  mediaHold.appendChild(el); // WebKit only feeds fresh frames from a <video> in the document
  tailEls.set(key, el);
  return el;
}
const rateOf = it => clamp(S.hasCurve(it) ? S.rateAt(it, it.dur) : num(it.speed, 1), 0.0625, 16);
const headSrcAt = (it, x) => Math.max(0, num(it.in, 0) + x * rateOf(it)); // x <= 0: before the clip starts
// One player per edge, running over timeline [s0, s1] with source time src(t).
function driveEdge(key, it, s0, s1, src, live) {
  live.add(key);
  const el = tailEl(key, it), sp = Math.min(16, rateOf(it) * playRate), want = src(clamp(t, s0, s1));
  if (playing && t >= s0 && t < s1) {
    if (Math.abs(el.playbackRate - sp) > 1e-3) el.playbackRate = sp;
    if (el.paused) { if (Math.abs(el.currentTime - want) > 0.1) el.currentTime = want; playMedia(el); }
    else if (Math.abs(el.currentTime - want) > 0.25 * Math.max(1, sp)) el.currentTime = want;
  } else if (playing && t < s0 && t > s0 - 0.8) { // warm the decoder up just before, crawling from the start
    if (el.playbackRate !== 0.0625) el.playbackRate = 0.0625;
    if (el.paused) { if (!el.seeking && Math.abs(el.currentTime - want) > 0.05) el.currentTime = want; playMedia(el); }
  } else {
    pauseMedia(el);
    if (!el.seeking && Math.abs(el.currentTime - want) > 0.5 / P.fps) el.currentTime = want;
  }
}
function driveTails() {
  const live = new Set(), isV = x => { const m = media(x); return m && m.kind === 'video' && !m.fill && !m.adj && !x.hidden; };
  for (const b of playbackProject.items) {
    if (!b.trans || !S.GLT.includes(b.trans.id)) continue;
    const T = S.transIn(playbackProject, b), h = T && T.d / 2;
    if (!T || t < b.start - h - 1.5 || t > b.start + h + 0.1) continue;
    const a = T.prev, aEnd = a.start + a.dur;
    for (const [it, edge, s0, s1, sourceAt] of [
      [a, '|t', aEnd, aEnd + h, x => tailSrcAt(a, x - aEnd)],
      [b, '|h', b.start - h, b.start, x => headSrcAt(b, x - b.start)],
    ]) {
      const cached = preparedVisual(it, media(it));
      if (!isV(it) && !cached?.animatedStill) continue;
      if (cached) {
        if (edge === '|h') {
          live.add(it.id + edge);
          tailEl(it.id + edge, it); // Warm the first cached frame before the clip begins.
        }
        continue;
      }
      driveEdge(it.id + edge, it, s0, s1, sourceAt, live);
    }
  }
  for (const [k, el] of tailEls) if (!live.has(k)) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); tailEls.delete(k); }
}
function headSrc(it) {
  const el = tailEls.get(it.id + '|h');
  return el && el.readyState >= 2 ? el : undefined;
}
function tailSrc(it) {
  const el = liveTail(it) && tailEls.get(it.id + '|t');
  return el && el.readyState >= 2 ? el : tailFrame(it);
}
function driveEl(el, it, silent) {
  {
    const on = active(it, t), lt = clamp(t - it.start, 0, it.dur);
    // a proxy is already retimed: it plays at 1x from the clip's start
    const mt = el._objectMatte, sourceTime = objectSourceTime(it, lt), origin = mt?.origin ?? el._preparedOrigin ?? 0;
    const in0 = el._px ? 0 : Math.max(0, num(it.in, 0) - origin);
    const sp = el._px ? playRate : clamp(S.rateAt(it, lt) * playRate, 0.0625, 16);
    let want = el._px ? lt : Math.max(0, sourceTime - origin);
    if (mt) {
      if (!playing || sourceTime < mt.origin || sourceTime >= mt.last) {
        const frame = clamp(Math.floor((sourceTime - mt.origin) * mt.fps + .0001), 0, Math.round((mt.last - mt.origin) * mt.fps));
        want = (frame + .25) / mt.fps;
        pauseMedia(el);
        if (on && el.readyState && !el.seeking && Math.floor(el.currentTime * mt.fps + .0001) !== frame) el.currentTime = want;
        return;
      }
      want = sourceTime - mt.origin;
    }
    if (el._restoreTime) {
      if (!el.readyState || el.seeking) return;
      el._restoreTime = false;
      if (on && Math.abs(el.currentTime - want) > 0.5 / P.fps) {
        el.currentTime = want;
        return;
      }
    }
    if (el.preservesPitch !== !it.pitch) el.preservesPitch = !it.pitch;
    // Warm-up: just before a cut, run the next clip muted at a crawl from its in-point, so the decoder is
    // already going when the cut arrives (WebKit needs ~0.6 s to start a paused video).
    const warm = !on && playing && it.start > t && it.start - t < 0.8;
    // Fast parts (over 3x) can't be decoded in real time: hold the element paused and jump to the
    // wanted frame whenever the last jump has landed (frame skipping keeps the picture in sync).
    const held = clockHeld(), fast = on && playing && !held && sp > 3;
    // Speed curves change the rate every frame; WebKit stutters on each playbackRate write, so step it.
    const wa = waLive.has(it.id);
    const rate = warm ? 0.0625 : !el._px && S.hasCurve(it) ? +Math.pow(1.15, Math.round(Math.log(sp) / Math.log(1.15))).toFixed(3) : sp, mute = silent || !!it.muted || fast || wa || (!on && !warm); // warming: unmuted at volume 0, so the sound path is already open at the cut
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    if (el.muted !== mute) el.muted = mute;
    const vol = on ? clamp(S.volumeAt(it, lt) * S.audioFade(it, lt), 0, 1) : 0;
    if (Math.abs(el.volume - vol) > 0.005) el.volume = vol;
    el._hold = fast;
    if (wa && el.tagName === 'AUDIO') {
      pauseMedia(el);
    } else if (fast) {
      pauseMedia(el);
      // a jump that hasn't landed in 250 ms is overtaken by a fresh one
      const now = performance.now();
      if ((!el.seeking || now - (el._seekAt || 0) > 250) && Math.abs(el.currentTime - want) > 1 / P.fps) {
        el._seekAt = now;
        if (el.fastSeek && sp > 6) el.fastSeek(want); else el.currentTime = want;
      }
    } else if (on && playing && (!held || clock.seekHold)) {
      // the file often ends a few ms before its clip does: hold the last frame, no restart (play() costs ~80 ms in WebKit)
      const atEnd = isFinite(el.duration) ? want >= el.duration - (el._depth ? 0.001 : 0.06) : el.ended;
      if (el._first && el._live === undefined) { // the cut: wait for its first fresh frame (at most 400 ms)
        el._live = false; el._liveAt = performance.now();
        if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(() => { el._live = true; needsDraw = true; }); else el._live = true;
      }
      if (atEnd) {}
      else if (el.paused) { if (Math.abs(el.currentTime - want) > (mt ? 0.75 / mt.fps : 0.15)) el.currentTime = want; playMedia(el); }
      else if (Math.abs(el.currentTime - want) > (mt ? 1 / mt.fps : 0.3 * Math.max(1, sp))) el.currentTime = want; // faster clips drift more between frames
    } else if (warm) {
      if (el.paused) { el._first = null; el._live = undefined; if (!el.seeking && Math.abs(el.currentTime - in0) > 0.05) el.currentTime = in0; playMedia(el); }
      // Keep its first frame before the cut: WebKit blocks ~100-200 ms on the first draws of a video that
      // has just started; the preview shows this copy until the player hands over a fresh frame.
      else if (!el._first && el.readyState >= 2 && el.tagName === 'VIDEO' && el.videoWidth) {
        const c = el._first = document.createElement('canvas');
        c.width = el.videoWidth; c.height = el.videoHeight;
        c.getContext('2d').drawImage(el, 0, 0);
      }
    } else {
      pauseMedia(el);
      // while dragging: nearest keyframe (fast, smooth); once it stops the exact frame follows
      if (on && !el.seeking && Math.abs(el.currentTime - want) > 0.5 / P.fps) { if (scrubbing && el.fastSeek && Math.abs(el.currentTime - want) > 1) el.fastSeek(want); else el.currentTime = want; }
      // Preroll: park the next clip on its first frame so the cut starts without a seek.
      else if (!on && playing && it.start > t && it.start - t < 1.5 && !el.seeking && Math.abs(el.currentTime - in0) > 0.05) el.currentTime = in0;
    }
  }
}

/* ---------- drawing (shared by preview and export raster) ---------- */
// Color grade on the GPU: per-channel slope/intercept, then SVG-style saturate matrix.
// Same math as lutrgb + hue=s in the export. (WebKit has no canvas ctx.filter, so no CSS/SVG filters.)
const GL = (() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }'));
  // Two modes: the basic grade as math, or (advanced colour) the clip's baked 3D LUT stored as an
  // (N*N) x N strip — x = blue slice * N + red, y = green — read with trilinear blending.
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision highp float; varying vec2 uv; uniform sampler2D tex; uniform sampler2D lut; uniform vec4 rect;
    uniform vec3 slope; uniform vec3 icpt; uniform float sat; uniform float useLut; uniform float n; uniform vec3 key; uniform vec2 kuv;
    uniform float fxId; uniform vec4 fxv; uniform vec2 bsz; uniform float ft; uniform sampler2D mat; uniform float useMat; uniform sampler2D obj; uniform float objMode; uniform vec2 objSize;
    vec3 lut3(vec3 v){ vec3 s = clamp(v, 0., 1.) * (n - 1.); float b0 = floor(s.b), b1 = min(b0 + 1., n - 1.);
      vec2 a = vec2((b0 * n + s.r + .5) / (n * n), (s.g + .5) / n), b = vec2((b1 * n + s.r + .5) / (n * n), (s.g + .5) / n);
      return mix(texture2D(lut, a).rgb, texture2D(lut, b).rgb, s.b - b0); }
    vec4 grade(vec2 u){ vec2 su = rect.xy + clamp(u, 0., 1.) * rect.zw; vec4 c = texture2D(tex, su);
      if (useMat > .5) c.a *= texture2D(mat, su).r;
      if (objMode > .5) {
        float a = texture2D(obj, su).r;
        if (objMode < 1.5) c.a *= a;
        else if (objMode < 2.5) {
          vec2 p = (floor(su * objSize / 16.) * 16. + 7.5) / objSize;
          c.rgb = mix(c.rgb, texture2D(tex, p).rgb, a);
        } else {
          float y = dot(c.rgb, vec3(.299, .587, .114));
          c.rgb = mix(vec3(y), c.rgb, a);
        }
      }
      if (key.z > 0.) { // chroma key: x = similarity, y = blend, z = on; kuv holds the key's CbCr
        vec2 p = vec2(dot(c.rgb, vec3(-.1146, -.3854, .5)), dot(c.rgb, vec3(.5, -.4542, -.0458)));
        float d = length(p - kuv) / 1.4142;
        c.a *= key.y > 0.0001 ? clamp((d - key.x) / key.y, 0., 1.) : step(key.x, d);
      }
      if (useLut > .5) return vec4(lut3(c.rgb), c.a);
      vec3 v = clamp(c.rgb * slope + icpt, 0., 1.);
      mat3 m = mat3(.213 + .787 * sat, .213 - .213 * sat, .213 - .213 * sat, .715 - .715 * sat, .715 + .285 * sat, .715 - .715 * sat, .072 - .072 * sat, .072 - .072 * sat, .072 + .928 * sat);
      return vec4(clamp(m * v, 0., 1.), c.a); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float L6(vec2 u){ return dot(grade(u).rgb, vec3(.299, .587, .114)); }
    ${S.fxgGLSL()}
    void main(){ // clip effects: ids are S.FX index + 1, numbers from S.fxVals; the export runs the same maths (S.fxChain)
      int id = int(fxId + .5); vec2 u = uv, px = uv * bsz; vec4 c;
      if (id >= ${S.FXG0}) { gl_FragColor = gfx(id); return; } // formula effects (S.FXG), clamped inside gfx
      if (id == 2 || id == 3 || (id >= 13 && id <= 18)) u = .5 + (u - .5) / fxv.z + fxv.xy; // shake, zoom, bounce, sway...
      if (id >= 19 && id <= 21) { vec2 p = (uv - .5) * bsz; float cs = cos(fxv.x), sn = sin(fxv.x); u = .5 + vec2(cs * p.x + sn * p.y, -sn * p.x + cs * p.y) / fxv.y / bsz; }
      if (id == 9) { vec2 b = fxv.x / bsz; u = (floor(u / b) + .5) * b; }
      if (id == 22) u.x = u.x < .5 ? u.x : 1. - u.x;
      if (id == 23) u.y = u.y < .5 ? u.y : 1. - u.y;
      if (id == 24) u = fract(u * 2.);
      if (id == 25) u = fract(u * 3.);
      if (id == 26) u.x = .5 + (fract(u.x * 3.) - .5) / 3.;
      if (id == 27) u = .5 - abs(u - .5);
      if (id == 28) u.x += fxv.x * sin(6.2831853 * (3. * uv.y + fxv.y));
      if (id >= 29 && id <= 32) { vec2 P = (px - .5 * bsz) / bsz.y; float r = length(P);
        if (id == 29) P *= 1. + fxv.x * sin(40. * r - fxv.y) / (r + .0001);
        if (id == 30 && r < .5) P *= 1. - fxv.x * (1. - 4. * r * r);
        if (id == 31 && r < .5) P *= 1. + fxv.x * (1. - 4. * r * r);
        if (id == 32 && r < .5) { float a = fxv.x * (1. - 2. * r) * (1. - 2. * r), cs = cos(a), sn = sin(a); P = vec2(cs * P.x - sn * P.y, sn * P.x + cs * P.y); }
        u = .5 + P * bsz.y / bsz; }
      if (id == 48) { float h = fract(sin(floor(px.y / fxv.y) * 1.7 + fxv.z * 3.1) * 43.758); u.x += h > .7 ? (h - .85) * fxv.x : 0.; }
      vec2 d = 1. / bsz;
      if (id == 1) { float ws = 0.; c = vec4(0.);
        for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) { float w = exp(-float(i * i + j * j) / 4.5); c += grade(u + vec2(float(i), float(j)) * fxv.x / 3. / bsz) * w; ws += w; }
        c /= ws; }
      else if (id >= 6 && id <= 8) { vec2 o = vec2(fxv.x / bsz.x, 0.); c = grade(u); c.r = grade(u + o).r; c.b = grade(u - o).b; }
      else if (id == 44) { vec2 o = vec2(0., fxv.x / bsz.y); c = grade(u); c.r = grade(u + o).r; c.b = grade(u - o).b; }
      else if (id == 35 || id == 36) { c = grade(u); vec3 s = vec3(0.);
        if (id == 35) s = -2. * grade(u - d).rgb - grade(u + vec2(0., -d.y)).rgb - grade(u + vec2(-d.x, 0.)).rgb + grade(u + vec2(d.x, 0.)).rgb + grade(u + vec2(0., d.y)).rgb + 2. * grade(u + d).rgb;
        else s = 4. * c.rgb - grade(u + vec2(0., -d.y)).rgb - grade(u + vec2(-d.x, 0.)).rgb - grade(u + vec2(d.x, 0.)).rgb - grade(u + vec2(0., d.y)).rgb;
        c.rgb += fxv.x * s; }
      else if (id == 37) { float tl = L6(u - d), t0 = L6(u + vec2(0., -d.y)), tr = L6(u + vec2(d.x, -d.y)), l = L6(u + vec2(-d.x, 0.)), r = L6(u + vec2(d.x, 0.)), bl = L6(u + vec2(-d.x, d.y)), b0 = L6(u + vec2(0., d.y)), br = L6(u + d);
        float gx = tr + 2. * r + br - tl - 2. * l - bl, gy = bl + 2. * b0 + br - tl - 2. * t0 - tr;
        c = vec4(vec3(1. - clamp(sqrt(gx * gx + gy * gy) * fxv.x, 0., 1.)), grade(u).a); }
      else if (id == 38) { vec2 cc = (floor(px / fxv.x) + .5) * fxv.x; vec4 k = grade(cc / bsz); float L = dot(k.rgb, vec3(.299, .587, .114));
        c = length(px - cc) < .6 * fxv.x * sqrt(L) ? k : vec4(0., 0., 0., grade(u).a); }
      else if (id == 45) { c = grade(u); c.rgb = (c.rgb + grade(u + vec2(fxv.x * d.x, 0.)).rgb) * .5; }
      else c = grade(u);
      if (id == 40) c.rgb = clamp(vec3(.15, 1.25, .25) * dot(c.rgb, vec3(.299, .587, .114)), 0., 1.);
      if (id == 41) c.rgb = clamp(mat3(.393, .349, .272, .769, .686, .534, .189, .168, .131) * c.rgb, 0., 1.) + fxv.z;
      if (id == 4 || id == 8 || id == 40 || id == 41) c.rgb += (hash(floor(uv * bsz) + ft) - .5) * fxv.y;
      if (id == 5 || id == 40 || id == 41) { float d = length((uv - .5) * bsz) / (.5 * length(bsz)), k = cos(fxv.x * d); c.rgb *= d > 1. ? 0. : k * k * k * k; }
      if (id == 8) c.rgb = mix(vec3(dot(c.rgb, vec3(.299, .587, .114))), c.rgb, fxv.z);
      if (id == 10 || (id == 42 && fxv.x > .5)) c.rgb = 1. - c.rgb;
      if (id == 11) c.rgb += fxv.x;
      if (id == 12 && (uv.y < fxv.x || uv.y > 1. - fxv.x)) c = vec4(0., 0., 0., 1.);
      if (id == 33) c.rgb = floor(clamp(c.rgb, 0., 1.) * fxv.x + .5) / fxv.x;
      if (id == 34) c.rgb = vec3(step(fxv.x, dot(c.rgb, vec3(.2126, .7152, .0722))));
      if (id == 39 && mod(floor(px.y), 3.) < .5) c.rgb *= fxv.x;
      if (id == 43 && fxv.x > .5) c.rgb = vec3(0.);
      if (id == 46) { vec3 v = clamp(c.rgb, 0., 1.); float Y = dot(v, vec3(.299, .587, .114)), U = (v.b - Y) * .564, V = (v.r - Y) * .713, cs = cos(fxv.x), sn = sin(fxv.x);
        float U2 = cs * U - sn * V, V2 = sn * U + cs * V; c.rgb = vec3(Y + 1.403 * V2, Y - .344 * U2 - .714 * V2, Y + 1.773 * U2); }
      if (id == 47 && (px.x < fxv.x || px.y < fxv.x || px.x > bsz.x - fxv.x || px.y > bsz.y - fxv.x)) c.rgb = vec3(1.);
      gl_FragColor = vec4(clamp(c.rgb, 0., 1.), c.a); }`));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texParams = () => { for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); };
  const frameTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  texParams();
  const U = n => gl.getUniformLocation(prog, n);
  const u = { obj: U('obj'), objMode: U('objMode'), objSize: U('objSize'), mat: U('mat'), useMat: U('useMat'), fxId: U('fxId'), fxv: U('fxv'), bsz: U('bsz'), ft: U('ft'), key: U('key'), kuv: U('kuv'), rect: U('rect'), slope: U('slope'), icpt: U('icpt'), sat: U('sat'), useLut: U('useLut'), n: U('n'), tex: U('tex'), lut: U('lut') };
  gl.uniform1i(u.tex, 0); gl.uniform1i(u.lut, 1); gl.uniform1i(u.mat, 2);
  const matTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, matTex); texParams(); gl.activeTexture(gl.TEXTURE0);
  const objTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, objTex); texParams(); gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(u.obj, 3);
  const luts = new Map(); // baked table -> texture (a few recent ones)
  const lutTex = L => {
    let t = luts.get(L);
    if (t) return t;
    const n = L.n || S.LUT_N, px = new Uint8Array(n * n * n * 4);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const i = (r + g * n + b * n * n) * 3, o = (g * n * n + b * n + r) * 4;
      px[o] = Math.round(L.arr[i] * 255); px[o + 1] = Math.round(L.arr[i + 1] * 255); px[o + 2] = Math.round(L.arr[i + 2] * 255); px[o + 3] = 255;
    }
    t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t); texParams();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n * n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.activeTexture(gl.TEXTURE0);
    luts.set(L, t);
    if (luts.size > 24) { const [k, old] = luts.entries().next().value; gl.deleteTexture(old); luts.delete(k); }
    return t;
  };
  // Draws src rect (sx,sy,sw,sh of a WxH source) graded into ctx at (dx,dy,dw,dh).
  return (ctx, src, W, H, sx, sy, sw, sh, dx, dy, dw, dh, g, L) => {
    const ow = Math.max(1, Math.round(Math.min(dw, 2048))), oh = Math.max(1, Math.round(Math.min(dh, 2048)));
    if (c.width !== ow || c.height !== oh) { c.width = ow; c.height = oh; }
    gl.viewport(0, 0, ow, oh);
    gl.uniform1f(u.useLut, L ? 1 : 0);
    if (L) { const t = lutTex(L); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t); gl.activeTexture(gl.TEXTURE0); gl.uniform1f(u.n, L.n || S.LUT_N); }
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1f(u.useMat, g.matte ? 1 : 0);
    if (g.matte) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, matTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.matte); gl.activeTexture(gl.TEXTURE0); }
    gl.uniform1f(u.objMode, g.object?.mode || 0);
    if (g.object) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, objTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.object.mask);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.objSize, g.object.w, g.object.h);
    }
    gl.uniform4f(u.rect, sx / W, sy / H, sw / W, sh / H);
    gl.uniform3f(u.slope, g.ch[0].slope, g.ch[1].slope, g.ch[2].slope);
    gl.uniform3f(u.icpt, g.ch[0].intercept, g.ch[1].intercept, g.ch[2].intercept);
    gl.uniform1f(u.sat, g.s);
    const K = g.chroma;
    gl.uniform3f(u.key, K ? K.sim : 0, K ? K.blend : 0, K ? 1 : 0);
    if (K) gl.uniform2f(u.kuv, K.uv[0], K.uv[1]);
    const F = g.fx;
    gl.uniform1f(u.fxId, F ? F.i : 0);
    if (F) { gl.uniform4f(u.fxv, ...F.v); gl.uniform2f(u.bsz, dw, dh); gl.uniform1f(u.ft, Math.floor(g.ft * 30)); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(c, dx, dy, dw, dh);
  };
})();

// User .cube files, read once: path -> parsed table, or a promise while loading.
const userLuts = new Map();
function loadUserLut(f) {
  if (!userLuts.has(f)) userLuts.set(f, inv('read_lut', { path: f }).then(t => { const L = S.parseCube(t); userLuts.set(f, L); needsDraw = true; return L; },
    e => { userLuts.set(f, null); toast(tr('lutFail') + ': ' + cleanErr(e)); return null; }));
  return Promise.resolve(userLuts.get(f));
}
function userLutFor(it) {
  const f = it.color && it.color.lut && it.color.lut.file;
  if (!f) return null;
  const u = userLuts.get(f);
  if (u === undefined) { loadUserLut(f); return null; }
  return u instanceof Promise ? null : u;
}
// A clip's whole colour (basic + looks + LUT + wheels + curves + HSL) baked once per change.
const lutBake = new Map();
function lutFor(it) {
  const ul = userLutFor(it), key = S.colorKey(it) + (ul ? '|u' : '');
  let c = lutBake.get(it.id);
  if (!c || c.key !== key) { const n = /^card:/.test(it.id) ? 17 : S.LUT_N; c = { key, arr: S.bakeLut(it, ul, n), n }; lutBake.set(it.id, c); } // panel cards: a smaller table, 7x quicker
  return c;
}
// drawImage with the item's grade applied.
function drawGraded(ctx, it, src, sx, sy, sw, sh, dx, dy, dw, dh, lt = 0, project = P) {
  const g = S.grade(it), adv = S.hasColor(it), m = media(it, project);
  const mt = objectMode(it) !== 'fill' && objectMatteState(it, m)?.matte;
  if (mt) {
    const live = project === P || project === playbackProject;
    const mask = live ? (!objectEdit(it) && objectMatteEl(it, mt)) : objectRaster.get(project)?.get(it.id);
    if (mask && (mask.tagName !== 'VIDEO' || mask.readyState >= 2)) {
      g.object = { mask, w: m.w, h: m.h, mode: { keep: 1, pixel: 2, pop: 3 }[objectMode(it)] || 1 };
    }
  }
  if (matteFor(it, media(it, project))) { const me = matteEl(it, project); if (me.readyState >= 2) g.matte = me; }
  if (S.hasKey(it)) g.chroma = { sim: num(it.chroma.sim, 0.3), blend: num(it.chroma.blend, 0.1), uv: S.keyUV(it.chroma.color) };
  g.fx = S.fxVals(it, lt, dw, dh); g.ft = lt;
  if ((g.identity && !adv && !g.chroma && !g.fx && !g.matte && !g.object) || !GL) return ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  const W = src.videoWidth || src.naturalWidth || src.width, H = src.videoHeight || src.naturalHeight || src.height;
  try { GL(ctx, src, W, H, sx, sy, sw, sh, dx, dy, dw, dh, g, adv ? lutFor(it) : null); }
  catch (e) { if (!drawGraded.warned) { drawGraded.warned = true; inv('dev_log', { msg: 'grade failed: ' + e }); } ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh); }
}

// Logo removal preview: the box is filled from the pixel rows just above and below it, blended
// top to bottom (export uses ffmpeg delogo, which interpolates from all four edges).
const dlc = document.createElement('canvas');
dlc.width = 8; dlc.height = 2;
// Masks: a scratch canvas per clip box size, and the mask shape cached per settings and size.
const mBox = document.createElement('canvas');
function maskBox(L) {
  const w = Math.round(L.cw), h = Math.round(L.ch);
  if (mBox.width !== w || mBox.height !== h) { mBox.width = w; mBox.height = h; }
  const c = mBox.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h);
  return c;
}
const maskCache = new Map();
function maskCanvas(M, w, h) {
  const key = JSON.stringify(M) + w + 'x' + h;
  let c = maskCache.get(key);
  if (!c) {
    c = document.createElement('canvas'); c.width = w; c.height = h;
    S.drawMask(c.getContext('2d'), M, w, h);
    if (maskCache.size > 12) maskCache.delete(maskCache.keys().next().value);
    maskCache.set(key, c);
  }
  return c;
}
// Dashed outline of the mask shape while its settings are open.
function drawMaskGuide(ctx, M, L) {
  const q = { ...S.MASK_DEF, ...M }, w = L.cw, h = L.ch;
  ctx.save();
  ctx.translate(L.ox + q.x * w, L.oy + q.y * h); ctx.rotate(q.rot * Math.PI / 180);
  ctx.setLineDash([10, 8]); ctx.lineWidth = 3; ctx.strokeStyle = CHROME_ACCENT;
  ctx.beginPath();
  const D = Math.hypot(w, h);
  if (q.type === 'linear') { ctx.moveTo(-D, 0); ctx.lineTo(D, 0); }
  else if (q.type === 'mirror') { ctx.moveTo(-D, -q.h * h / 2); ctx.lineTo(D, -q.h * h / 2); ctx.moveTo(-D, q.h * h / 2); ctx.lineTo(D, q.h * h / 2); }
  else if (q.type === 'circle') ctx.ellipse(0, 0, q.w * w / 2, q.h * h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(-q.w * w / 2, -q.h * h / 2, q.w * w, q.h * h);
  ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = CHROME_ACCENT; ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawDelogo(ctx, it, src, m, kx, ky, C, L, u, v, project) {
  const b = S.logoBox(it.logo, m), dc = dlc.getContext('2d');
  dc.clearRect(0, 0, 8, 2);
  drawGraded(dc, it, src, b.x * kx, (b.y - 1) * ky, b.w * kx, ky, 0, 0, 8, 1, 0, project);
  drawGraded(dc, it, src, b.x * kx, (b.y + b.h) * ky, b.w * kx, ky, 0, 1, 8, 1, 0, project);
  const dx = L.ox + (b.x - C.x) / u - L.cx, dy = L.oy + (b.y - C.y) / v - L.cy;
  ctx.save();
  ctx.beginPath(); ctx.rect(L.ox, L.oy, L.cw, L.ch); ctx.clip();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(dlc, 0, 0, 8, 2, dx, dy, b.w / u, b.h / v);
  if (ctx === vctx && sel === it.id && inspTab === 'tVideo' && !playing) {
    ctx.setLineDash([10, 8]); ctx.lineWidth = 3; ctx.strokeStyle = CHROME_ACCENT;
    ctx.strokeRect(dx, dy, b.w / u, b.h / v);
  }
  ctx.restore();
}

// Adjustment layer (effect / filter on its own clip): re-grades everything drawn below it.
const adjCopy = document.createElement('canvas');
function drawAdj(ctx, it, lt) {
  const c = ctx.canvas;
  if (adjCopy.width !== c.width || adjCopy.height !== c.height) { adjCopy.width = c.width; adjCopy.height = c.height; }
  const g = adjCopy.getContext('2d');
  g.clearRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0);
  ctx.save();
  ctx.globalAlpha = S.fadeAlpha(it, lt) * clamp(num(it.opacity, 1), 0, 1);
  drawGraded(ctx, it, adjCopy, 0, 0, c.width, c.height, 0, 0, P.w, P.h, lt);
  ctx.restore();
}
// ov = {id, lt}: draw that clip at its own local time (animation preview) whatever the playhead says.
function drawVisual(ctx, time, ov, textHook) {
  const project = playbackProject ?? P;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, P.w, P.h);
  for (const tr0 of P.tracks.filter(x => x.kind !== 'audio').reverse()) { // bottom of the stack first
    const tid = tr0.id;
    if (tr0.kind === 'text') { if (textHook) textHook(tid); continue; }
    // by start time: a clip's frozen tail is drawn under the next clip's transition
    // a shader transition draws its two clips into their own layers and mixes them
    const gt = glTransAt(tid, time, ov);
    for (const it of project.items.filter(i => i.track === tid && !isText(i)).sort((a, b) => a.start - b.start)) {
      if (gt && (it === gt.a || it === gt.b)) { if (it === gt.b) drawGlTrans(ctx, gt, time, undefined, undefined, project); continue; }
      drawItem(ctx, it, time, ov, undefined, false, false, project);
    }
  }
}
// One clip of the stack at project time `time` (src: a frame to use instead of the clip's own video).
// WebKit ignores the blend mode when it draws a <video> straight onto a canvas, so a blended clip is
// drawn into its own layer first and that layer is blended onto the frame.
const blendLayer = document.createElement('canvas');
// Layout uses source metadata. Only texture sampling uses the decoder's pixel dimensions.
function sampleScale(src, m) {
  return [(src.videoWidth || src.naturalWidth || src.width || m.w) / m.w,
    (src.videoHeight || src.naturalHeight || src.height || m.h) / m.h];
}
function drawItem(ctx, it, time, ov, srcOv, flat, noFx, project = P) {
    const pv = ov && ov.id === it.id, m = media(it, project);
    if (!m || m.kind === 'audio' || it.audioOnly || it.hidden) return;
    if (offline.has(it.media) && !m.adj) { if ((ov && ov.id === it.id) || active(it, time)) drawOffline(ctx, it, project); return; }
    if (!noFx && !m.adj && (pv || active(it, time))) { // rich animation: draw the clip on its own layer, then animfx.js
      const lt = pv ? ov.lt : time - it.start, q = S.vaFx(it, lt);
      if (q && !(it.blend && it.blend !== 'normal' && !flat)) return drawFx(ctx, it, time, ov, srcOv, flat, q, lt, project);
    }
    if (!flat && it.blend && it.blend !== 'normal' && BLENDS[it.blend]) {
      const c = ctx.canvas, g = blendLayer.getContext('2d');
      if (blendLayer.width !== c.width || blendLayer.height !== c.height) { blendLayer.width = c.width; blendLayer.height = c.height; }
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.setTransform(ctx.getTransform());
      drawItem(g, it, time, ov, srcOv, true, noFx, project);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = BLENDS[it.blend]; ctx.drawImage(blendLayer, 0, 0); ctx.restore();
      return;
    }
    const end = it.start + it.dur, TO = !pv && time >= end && S.transOut(project, it), tail = !!TO && time < end + (S.GLT.includes(TO.id) ? TO.d / 2 : TO.d);
    const live = project === P || project === playbackProject;
    if (!(pv || tail || active(it, time))) return;
    if (m.adj) { drawAdj(ctx, it, pv ? ov.lt : time - it.start); return; }
    const visual = live && (depthPicker?.item === it ? upscaleVisual(it, m) : preparedVisual(it, m, project));
    if (live && TO === false && (visual || m).kind === 'video' && end - time < 2 && S.transOut(project, it)) tailFrame(it); // fetch ahead
    let src = srcOv || (m.fill ? fillCanvas(it, project.w, project.h) : (visual || m).kind === 'image' ? imgFor(visual || m)
      : live ? (tail ? tailSrc(it) : elFor(it, visual)) : null);
    if (!srcOv && visual?.kind === 'video' && !tail && (src.readyState < 2 || src._restoreTime)) {
      src = m.kind === 'image' ? imgFor(m) : elFor(it);
    }
    const fillLt = pv ? ov.lt : tail ? it.dur : time - it.start;
    if (live && !objectEdit(it) && objectMode(it) === 'fill') {
      const cache = fillState(it, m)?.cache;
      if (cache) src = fillPreview(it, cache, fillLt) || src;
    }
    if (!src) return;
    if (src._live === false && src._first && performance.now() - src._liveAt < 400) src = src._first;
    if (m.fill || src.tagName === 'CANVAS') {} // fill layer / held last frame: always ready
    else if (src.tagName === 'IMG' ? !src.complete || !src.naturalWidth : src.readyState < 2 || src._restoreTime) {
      if (!src._snap) return;
      src = src._snap; // frame-skipping playback: keep the last frame while the next jump lands
    } else if (src._hold && ctx === vctx) {
      const c = src._snap || (src._snap = document.createElement('canvas'));
      if (c.width !== m.w || c.height !== m.h) { c.width = m.w; c.height = m.h; }
      c.getContext('2d').drawImage(src, 0, 0, m.w, m.h);
    }
    const lt = pv ? ov.lt : tail ? it.dur : time - it.start;
    if (m.fill) { m.w = project.w; m.h = project.h; }
    const a = S.withVa(S.animAt(it, lt), lt, project.w, project.h), L = S.layout(a, m, project.w, project.h), C = S.srcCrop(it, m);
    const [kx, ky] = sampleScale(src, m), u = C.w / L.sw, v = C.h / L.sh;
    ctx.save();
    ctx.globalAlpha = S.fadeAlpha(it, lt) * clamp(num(a.opacity, 1), 0, 1);
    // transitions: TI = this clip coming in, TO = this clip's held tail going out
    const TI = !tail && !pv ? S.transIn(project, it) : null, trIn = TI && lt < TI.d ? TI : null;
    const qi = trIn ? clamp(lt / trIn.d, 0, 1) : 1, qo = tail ? clamp((time - end) / TO.d, 0, 1) : 0;
    if (trIn && (S.TR_DIP[trIn.id] || S.TR_MOVE[trIn.id]) && qi < 0.5) { ctx.restore(); return; }
    // zoom / spin / shake / glitch: [formulas, progress through this side's half]
    const mv = [trIn && S.TR_MOVE[trIn.id] && [S.TR_MOVE[trIn.id].b, (qi - 0.5) * 2], tail && S.TR_MOVE[TO.id] && [S.TR_MOVE[TO.id].a, Math.min(1, qo * 2)]].filter(Boolean);
    const mz = mv.reduce((z, [M, u]) => z * (M.z != null ? S.trVal(M.z, u) : 1), 1), mr = mv.reduce((r, [M, u]) => r + (M.r != null ? S.trVal(M.r, u) : 0), 0);
    const mx = mv.reduce((x, [M, u]) => x + (M.x != null ? S.trVal(M.x, u) : 0), 0);
    if (mx) ctx.translate(mx * project.w, 0);
    if (trIn && trIn.id === 'fade') ctx.globalAlpha *= qi;
    const sl = trIn && S.TR_SLIDE[trIn.id] ? [S.TR_SLIDE[trIn.id], 1 - S.ease3(qi)] : tail && S.TR_SLIDE[TO.id] ? [S.TR_SLIDE[TO.id], -S.ease3(qo)] : null;
    if (sl) ctx.translate(sl[0][0] * project.w * sl[1], sl[0][1] * project.h * sl[1]);
    const [tx, ty] = S.trkAt(it, lt);
    if (tx || ty) ctx.translate(tx * project.w, ty * project.h);
    if (it.flipH || it.flipV || num(a.rotate, 0)) {
      ctx.translate(L.ox + L.cw / 2, L.oy + L.ch / 2);
      ctx.rotate(num(a.rotate, 0) * Math.PI / 180);
      ctx.scale(it.flipH ? -1 : 1, it.flipV ? -1 : 1);
      ctx.translate(-(L.ox + L.cw / 2), -(L.oy + L.ch / 2));
    }
    if (trIn && S.TR_GEQ[trIn.id]) S.transClip(ctx, trIn.id, S.ease3(qi), L.ox, L.oy, L.cw, L.ch);
    if (mz !== 1 || mr) { // inside the clip's own box, as the export crops it
      ctx.beginPath(); ctx.rect(L.ox, L.oy, L.cw, L.ch); ctx.clip();
      ctx.translate(L.ox + L.cw / 2, L.oy + L.ch / 2); ctx.rotate(mr * Math.PI / 180); ctx.scale(mz, mz); ctx.translate(-(L.ox + L.cw / 2), -(L.oy + L.ch / 2));
    }
    const objectPicking = objectDrawing && objectEdit(it);
    const depthPicking = objectDrawing && depthPicker?.item === it;
    if ((objectPicking || depthPicking) && !tail) {
      const { a, b, c, d, e, f } = ctx.getTransform(), k = ctx.canvas.width / P.w;
      const geometry = { item: it, matrix: [a / k, b / k, c / k, d / k, e / k, f / k], dest: { x: L.ox, y: L.oy, w: L.cw, h: L.ch },
        crop: { x: C.x + L.cx * u, y: C.y + L.cy * v, w: L.cw * u, h: L.ch * v }, m, time: objectSourceTime(it, lt) };
      if (objectPicking) objectGeometry = geometry;
      if (depthPicking) depthGeometry = geometry;
    }
    const mk = S.hasMask(it) && L.cw >= 1 && L.ch >= 1;
    const dc = mk ? maskBox(L) : ctx;
    if (mk) { dc.save(); dc.translate(-L.ox, -L.oy); }
    drawGraded(dc, it, src, (C.x + L.cx * u) * kx, (C.y + L.cy * v) * ky, L.cw * u * kx, L.ch * v * ky, L.ox, L.oy, L.cw, L.ch, lt, project);
    if (it.logo && it.logo.on) drawDelogo(dc, it, src, m, kx, ky, C, L, u, v, project);
    if (mk) {
      dc.restore();
      dc.globalCompositeOperation = 'destination-in';
      dc.drawImage(maskCanvas(it.mask, Math.round(L.cw), Math.round(L.ch)), 0, 0);
      dc.globalCompositeOperation = 'source-over';
      ctx.drawImage(dc.canvas, 0, 0, Math.round(L.cw), Math.round(L.ch), L.ox, L.oy, Math.round(L.cw), Math.round(L.ch));
      if (ctx === vctx && sel === it.id && inspTab === 'tAdjust' && colSub === 'mask' && !playing) drawMaskGuide(ctx, it.mask, L);
    }
    // dip to black/white: the clip's box fades to the colour (going out) or from it (coming in)
    const dip = trIn && S.TR_DIP[trIn.id] ? [trIn.id, 1 - (qi - 0.5) * 2] : tail && S.TR_DIP[TO.id] ? [TO.id, Math.min(1, qo * 2)] : null;
    if (dip && dip[1] > 0) { ctx.globalAlpha *= dip[1]; ctx.fillStyle = S.TR_DIP[dip[0]]; ctx.fillRect(L.ox, L.oy, L.cw, L.ch); }
    if (ctx === vctx && sel === it.id && m.fill && it.fill && it.fill.type !== 'solid' && !playing) drawFillGuide(ctx, it.fill, L);
    ctx.restore();
}

const fxLayer = document.createElement('canvas');
function drawFx(ctx, it, time, ov, srcOv, flat, q, lt, project) {
  const c = ctx.canvas, mt = ctx.getTransform();
  if (fxLayer.width !== c.width || fxLayer.height !== c.height) { fxLayer.width = c.width; fxLayer.height = c.height; }
  const g = fxLayer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.setTransform(mt);
  drawItem(g, it, time, ov, srcOv, flat, true, project);
  const a = S.withVa(S.animAt(it, lt), lt, project.w, project.h), L = S.layout(a, media(it, project), project.w, project.h), [tx, ty] = S.trkAt(it, lt);
  const x = L.ox + tx * project.w, y = L.oy + ty * project.h;
  MaqtoFx.draw(ctx, fxLayer, { x: mt.a * x + mt.e, y: mt.d * y + mt.f, w: L.cw * mt.a, h: L.ch * mt.d, r: num(a.rotate, 0) }, q);
}

// ---------- shader transitions (src/gltrans.js) ----------
// The incoming clip b and the held outgoing clip a are drawn into their own full-frame layers, then
// mixed by the transition's fragment shader. The export renders the same frames (renderGlTrans).
const GLX_VS = 'attribute vec2 a;varying vec2 uv0;void main(){uv0=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
// one GL context: frame(id, A, B, q) -> its canvas holding the mixed frame (A, B: same-size canvases)
// WebKit drops a context that holds too many programs, so only the last few stay compiled, and a lost
// context is replaced by a new canvas.
function mkGlx() {
  const progs = new Map();
  let c = null, gl = null, buf = null, tex = [];
  const init = () => {
    if (gl && !gl.isContextLost()) return gl;
    c = document.createElement('canvas'); progs.clear(); tex = [];
    gl = c.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true });
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
      tex.push(t);
    }
    return gl;
  };
  const prog = id => {
    let pr = progs.get(id);
    if (pr) { progs.delete(id); progs.set(id, pr); return pr; } // most recently used last
    while (progs.size >= 12) { const [k, old] = progs.entries().next().value; gl.deleteProgram(old.q); progs.delete(k); }
    const def = MaqtoGLT.LIST.find(x => x[0] === id);
    const sh = (type, src) => {
      const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(id + ': ' + gl.getShaderInfoLog(o));
      return o;
    };
    const q = gl.createProgram(), vs = sh(gl.VERTEX_SHADER, GLX_VS), fs = sh(gl.FRAGMENT_SHADER, MaqtoGLT.HEAD + def[2] + MaqtoGLT.MAIN);
    gl.attachShader(q, vs); gl.attachShader(q, fs);
    gl.linkProgram(q);
    gl.deleteShader(vs); gl.deleteShader(fs); // freed with the program
    if (!gl.getProgramParameter(q, gl.LINK_STATUS)) throw new Error(id + ': ' + gl.getProgramInfoLog(q));
    pr = { q, a: gl.getAttribLocation(q, 'a'), tA: gl.getUniformLocation(q, 'tA'), tB: gl.getUniformLocation(q, 'tB'), p: gl.getUniformLocation(q, 'p'), R: gl.getUniformLocation(q, 'RR'), D: gl.getUniformLocation(q, 'D') };
    progs.set(id, pr);
    return pr;
  };
  const frame = (id, A, B, q, dir = 0, ease = 'lin') => {
    init();
    const pr = prog(id), w = A.width, h = A.height;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h); gl.useProgram(pr.q);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    [A, B].forEach((s, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s); });
    gl.uniform1i(pr.tA, 0); gl.uniform1i(pr.tB, 1); gl.uniform1f(pr.p, MaqtoGLT.ease(ease, q)); gl.uniform2f(pr.R, w, h); gl.uniform1f(pr.D, dir);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(pr.a); gl.vertexAttribPointer(pr.a, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return c;
  };
  return { frame, check: id => { init(); prog(id); } };
}
const GLX = { main: mkGlx(), thumb: mkGlx(), A: document.createElement('canvas'), B: document.createElement('canvas') };
// Shader transitions coming up in the next 2 s get compiled (and the outgoing clip's last frame
// fetched) ahead of time, so the first frame of the transition doesn't stall playback.
function warmTrans() {
  const project = playbackProject ?? P;
  for (const it of project.items) if (pxNeeds(it)) proxyFor(it);
  for (const b of project.items) {
    if (!b.trans || !S.GLT.includes(b.trans.id) || b.start < t - 1 || b.start > t + 2.5) continue;
    const T = S.transIn(project, b);
    if (!T) continue;
    try { GLX.main.check(T.id); } catch {}
    if (media(T.prev) && media(T.prev).kind === 'video') tailFrame(T.prev);
  }
}
function glTransAt(tid, time, ov) {
  if (ov) return null;
  const project = playbackProject ?? P;
  for (const b of project.items) {
    if (b.track !== tid || !b.trans || !S.GLT.includes(b.trans.id) || time < b.start - 1.01 || time >= b.start + 1.01) continue;
    const T = S.transIn(project, b);
    if (T && time >= b.start - T.d / 2 && time < b.start + T.d / 2) return { id: T.id, dir: T.dir, ease: T.ease, a: T.prev, b, q: (time - b.start + T.d / 2) / T.d };
  }
  return null;
}
function drawGlTrans(ctx, gt, time, srcA, srcB, project = P) {
  const k = ctx === vctx ? Math.min(1, (playing ? 480 : 640) / Math.max(project.w, project.h)) : 1, w = Math.round(project.w * k), h = Math.round(project.h * k);
  for (const c of [GLX.A, GLX.B]) {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h); g.setTransform(k, 0, 0, k, 0, 0);
  }
  drawItem(GLX.A.getContext('2d'), gt.a, time, null, srcA, false, false, project);
  // before the cut B shows its source from before its in-point (or its first frame)
  drawItem(GLX.B.getContext('2d'), gt.b, Math.max(time, gt.b.start), null, srcB || ((project === P || project === playbackProject) && time < gt.b.start ? headSrc(gt.b) : undefined), false, false, project);
  try { ctx.drawImage(GLX.main.frame(gt.id, GLX.A, GLX.B, gt.q, gt.dir, gt.ease), 0, 0, project.w, project.h); }
  catch (e) { console.error(e); ctx.drawImage(gt.q < 0.5 ? GLX.A : GLX.B, 0, 0, project.w, project.h); }
}

// Text presets ("Aa" styles). Each only sets the fields it cares about; the rest reset to defaults.
const TEXT_STYLES = (() => { const W = '#ffffff', B = '#000000'; return [
  { id: 'plain', s: {} },
  { id: 'outline', s: { strokeW: 7 } },
  { id: 'outlineW', s: { color: B, stroke: W, strokeW: 7 } },
  { id: 'shadow', s: { shadowOn: true, shadowBlur: 18, shadowDist: 8 } },
  { id: 'softGlow', s: { glowOn: true, glowColor: W, glowSize: 26 } },
  { id: 'yellowOut', s: { color: '#ffe14d', strokeW: 7 } },
  { id: 'redOut', s: { color: '#ff3b3b', stroke: W, strokeW: 7 } },
  { id: 'orange', s: { color: '#ff9a2e', stroke: W, strokeW: 6 } },
  { id: 'blue', s: { color: '#3aa0ff', stroke: W, strokeW: 6 } },
  { id: 'green', s: { color: '#5cff6a', strokeW: 7 } },
  { id: 'greyBox', s: { color: B, bgOn: true, bg: '#9a9a9a' } },
  { id: 'whiteGreyBox', s: { bgOn: true, bg: '#b5b5b5' } },
  { id: 'yellowBox', s: { color: B, bgOn: true, bg: '#ffd43b' } },
  { id: 'purpleBox', s: { bgOn: true, bg: '#7b2cff' } },
  { id: 'purpleOnWhite', s: { color: '#7b2cff', bgOn: true, bg: W } },
  { id: 'box', s: { color: B, bgOn: true, bg: W } },
  { id: 'blackBox', s: { bgOn: true, bg: B } },
  { id: 'greenBlack', s: { color: '#5cff6a', bgOn: true, bg: B } },
  { id: 'accent', s: { color: '#04201e', bgOn: true, bg: ACCENT } },
  { id: 'glitchGreen', s: { color: B, shadowOn: true, shadowColor: '#22e05a', shadowBlur: 0, shadowDist: 7 } },
  { id: 'retro', s: { color: '#ffcf3f', shadowOn: true, shadowColor: '#c2410c', shadowBlur: 0, shadowDist: 8 } },
  { id: 'neonPink', s: { color: '#ffe6ef', glowOn: true, glowColor: '#ff2d6f', glowSize: 30 } },
  { id: 'neonYellow', s: { color: '#fffbe0', glowOn: true, glowColor: '#ffd000', glowSize: 30 } },
  { id: 'neonGreen', s: { color: '#eaffea', glowOn: true, glowColor: '#22e05a', glowSize: 30 } },
  { id: 'gradient', s: { color: '#ffd84d', gradOn: true, fill2: '#ff4d8d', strokeW: 5 } },
  { id: 'yellowHl', s: { strokeW: 6, hl: '#ffd400' } },
  { id: 'serif', s: { font: 'Georgia', weight: 400 } },
  { id: 'impact', s: { font: 'Impact', weight: 400, caseMode: 'upper', strokeW: 5, spacing: 2 } },
]; })();
function textDefaults(caption) {
  return {
    font: 'Cairo', size: caption ? 78 : 110, weight: 800, color: '#ffffff', stroke: '#000000', strokeW: caption ? 6 : 0,
    bg: '#000000', bgOn: false, bgAlpha: 1, bgRadius: 0.22, hl: ACCENT, italic: false, underline: false, caseMode: 'none',
    spacing: 0, lineH: 1.3, align: 'center', shadowOn: false, shadowColor: '#000000', shadowBlur: 12, shadowDist: 6,
    glowOn: false, glowColor: ACCENT, glowSize: 24, gradOn: false, fill2: ACCENT,
  };
}
// Caption templates: a style plus an animation, applied to one caption or all of them.
const CAP_TPL = [
  { id: 'classic', s: { strokeW: 7, hl: '#ffe14d' } },
  { id: 'greenPop', s: { strokeW: 7, hl: '#5cff6a' }, anim: 'wordPop' },
  { id: 'purpleBox', s: { strokeW: 0, shadowOn: true, shadowBlur: 14, shadowDist: 4, hl: '#ffffff', hlBg: '#7b2cff' } },
  { id: 'redBox', s: { font: 'Tajawal', weight: 900, strokeW: 0, shadowOn: true, shadowBlur: 12, shadowDist: 4, hl: '#ffffff', hlBg: '#ff3b3b' } },
  { id: 'yellowBox', s: { font: 'Almarai', weight: 800, strokeW: 5, hl: '#111111', hlBg: '#ffd400' } },
  { id: 'blackBar', s: { strokeW: 0, bgOn: true, bg: '#000000', bgAlpha: 0.72, hl: ACCENT } },
  { id: 'whiteCard', s: { color: '#111111', strokeW: 0, bgOn: true, bg: '#ffffff', hl: '#7b2cff' } },
  { id: 'neon', s: { color: '#ffffff', strokeW: 0, glowOn: true, glowColor: '#ff2d6f', glowSize: 28, hl: '#ff8fb3' }, anim: 'wordFade' },
  { id: 'lalezar', s: { font: 'Lalezar', weight: 400, color: '#ffd84d', strokeW: 0, shadowOn: true, shadowColor: '#c2410c', shadowBlur: 0, shadowDist: 9, hl: '#ffffff' } },
  { id: 'anton', s: { font: 'Anton', weight: 400, caseMode: 'upper', strokeW: 6, spacing: 1, hl: '#ffe14d' }, anim: 'wordPop' },
  { id: 'bebas', s: { font: 'Bebas Neue', weight: 400, caseMode: 'upper', strokeW: 5, spacing: 2, hl: ACCENT } },
  { id: 'elegant', s: { font: 'El Messiri', weight: 700, strokeW: 0, shadowOn: true, shadowBlur: 18, shadowDist: 3, hl: '#ffd27a' }, anim: 'wordRise' },
  { id: 'kufi', s: { font: 'Reem Kufi', weight: 700, strokeW: 6, hl: '#3aa0ff' } },
  { id: 'gradient', s: { gradOn: true, color: '#ffd84d', fill2: '#ff4d8d', strokeW: 5, hl: '#ffffff' } },
  { id: 'minimal', s: { font: 'Tajawal', weight: 700, strokeW: 0, shadowOn: true, shadowBlur: 10, shadowDist: 2, hl: ACCENT }, anim: 'wordFade' },
  { id: 'inverse', s: { color: '#000000', stroke: '#ffffff', strokeW: 7, hl: '#ff3b3b' } },
  { id: 'changa', s: { font: 'Changa', weight: 800, strokeW: 6, hl: '#ff9a2e' }, loop: 'pulse' },
  { id: 'greenBox', s: { font: 'Rubik', weight: 800, strokeW: 0, shadowOn: true, shadowBlur: 10, shadowDist: 3, hl: '#04201e', hlBg: '#5cff6a' }, anim: 'wordPop' },
];
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const proxyPrefs = {
  'kadr.proxyMode': lsGet('kadr.proxyMode', 'auto'),
  'kadr.proxyHigh': lsGet('kadr.proxyHigh', false),
  'kadr.proxy': lsGet('kadr.proxy', true),
};
function applyTpl(it, id) {
  const tp = CAP_TPL.find(x => x.id === id);
  if (!tp) return;
  snapshot();
  const all = it.track === 'c1' && lsGet('kadr.tplAll', true);
  for (const c of all ? P.items.filter(i => i.track === 'c1' && isText(i)) : [it]) {
    c.style = { ...textDefaults(c.track === 'c1'), ...tp.s, size: c.style.size };
    c.anim = tp.anim || 'none'; c.loop = tp.loop || 'none'; c.tpl = id;
  }
  refresh();
}
const presetStyle = (id, caption) => ({ ...textDefaults(caption), ...((TEXT_STYLES.find(s => s.id === id) || {}).s || {}) });

const ANIM_IN = ['none', 'fade', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'pop', 'zoomIn', 'grow', 'drop', 'rotateIn', 'spin', 'wipe', 'type', 'wordPop', 'wordFade', 'wordRise',
  'flipIn', 'unfold', 'stretchIn', 'bounceIn', 'elastic', 'swingIn', 'rollIn', 'jackBox', 'blinkIn', 'glitchIn', 'wordDrop', 'wordZoom'];
const ANIM_OUT = ['none', 'fade', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'shrink', 'zoomOut', 'rotateOut', 'sink', 'wipe', 'typeErase',
  'flipOut', 'squash', 'stretchOut', 'fall', 'blinkOut', 'glitchOut', 'wordFadeOut'];
const ANIM_LOOP = ['none', 'pulse', 'float', 'shake', 'swing', 'heartbeat', 'wave', 'flicker', 'jelly', 'bounce', 'tada', 'tilt', 'zoomBeat', 'jitter', 'breathe', 'blink', 'spinLoop', 'hop', 'wiggle', 'orbit', 'popBeat', 'rock'];
// Repeatable pseudo-random in 0..1 (no Math.random: preview and export must match).
const rnd = x => { const v = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
const elastic = p => p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * 2 * Math.PI / 3) + 1;
const EASE = S.EASE;
const caseText = (txt, m) => m === 'upper' ? txt.toUpperCase() : m === 'lower' ? txt.toLowerCase() : m === 'title' ? txt.replace(/\b\p{L}/gu, c => c.toUpperCase()) : txt;

// Animation state at local time lt. Pure function of (item, lt): preview and export match.
function textState(it, lt) {
  const st = it.style, size = st.size, TAU = Math.PI * 2;
  const inA = { slide: 'slideUp' }[it.anim] || it.anim || 'none', outA = it.out || 'none', loopA = it.loop || 'none';
  const inD = num(it.inDur, 0.5), outD = Math.min(num(it.outDur, 0.4), it.dur), len = it.text.length;
  let alpha = 1, dx = 0, dy = 0, sc = 1, sx = 1, sy = 1, rot = 0, chars = Infinity, wipe = 1, wipeOut = 0, anim = false;
  const toks = [];
  if (inA !== 'none' && lt < inD && !/^(type|word)/.test(inA)) {
    anim = true;
    const p = clamp(lt / inD, 0, 1), e = EASE.out(p);
    switch (inA) {
      case 'fade': alpha = e; break;
      case 'slideUp': alpha = e; dy = (1 - e) * size * 0.8; break;
      case 'slideDown': alpha = e; dy = -(1 - e) * size * 0.8; break;
      case 'slideLeft': alpha = e; dx = (1 - e) * size * 1.6; break;
      case 'slideRight': alpha = e; dx = -(1 - e) * size * 1.6; break;
      case 'pop': sc = 0.6 + 0.4 * EASE.back(p); alpha = Math.min(1, p * 3); break;
      case 'zoomIn': sc = 2.2 - 1.2 * e; alpha = e; break;
      case 'grow': sc = Math.max(0.001, EASE.back(p)); break;
      case 'drop': dy = -(1 - EASE.bounce(p)) * size * 2; alpha = Math.min(1, p * 4); break;
      case 'rotateIn': rot = -(1 - e) * Math.PI / 2; sc = 0.5 + 0.5 * e; alpha = e; break;
      case 'spin': rot = -(1 - e) * TAU; sc = Math.max(0.001, e); break;
      case 'wipe': wipe = e; break;
      case 'flipIn': sy = Math.max(0.01, EASE.back(p)); alpha = Math.min(1, p * 3); break;
      case 'unfold': sx = Math.max(0.01, EASE.back(p)); break;
      case 'stretchIn': sx = 2.6 - 1.6 * e; sy = 0.6 + 0.4 * e; alpha = e; break;
      case 'bounceIn': dy = (1 - EASE.bounce(p)) * size * 2; alpha = Math.min(1, p * 4); break;
      case 'elastic': sc = Math.max(0.01, elastic(p)); break;
      case 'swingIn': rot = -(1 - EASE.back(p)) * 0.7; alpha = e; break;
      case 'rollIn': dx = -(1 - e) * size * 3; rot = -(1 - e) * Math.PI; alpha = e; break;
      case 'jackBox': sc = Math.max(0.01, e); rot = Math.sin(p * Math.PI * 3) * (1 - p) * 0.5; alpha = e; break;
      case 'blinkIn': alpha = p > 0.85 || [0.15, 0.35, 0.55, 0.7].some((x, i) => p > x && p < x + 0.08 + i * 0.02) ? 1 : 0.08; break;
      case 'glitchIn': { const q = Math.floor(p * 14), j = (1 - p) * size; dx = (rnd(q) - 0.5) * j * 1.6; dy = (rnd(q + 7) - 0.5) * j * 0.3; alpha = rnd(q + 3) < p + 0.3 ? 1 : 0.2; break; }
    }
  }
  if (inA === 'type') { chars = Math.floor(lt * Math.max(22, len / Math.max(inD, 0.2))); if (chars < len) anim = true; }
  if (/^word/.test(inA)) {
    const n = it.text.split(/\s+/).filter(Boolean).length, step = Math.min(0.14, inD / Math.max(1, n)), w = 0.28;
    if (lt < (n - 1) * step + w) anim = true;
    toks.push(i => {
      const q = clamp((lt - i * step) / w, 0, 1);
      if (inA === 'wordDrop') return { a: Math.min(1, q * 4), sc: 1, dy: -(1 - EASE.bounce(q)) * size * 0.9 };
      if (inA === 'wordZoom') return { a: EASE.out(q), sc: 2.2 - 1.2 * EASE.out(q), dy: 0 };
      return inA === 'wordPop' ? { a: Math.min(1, q * 3), sc: 0.4 + 0.6 * EASE.back(q), dy: 0 }
        : inA === 'wordRise' ? { a: EASE.out(q), sc: 1, dy: (1 - EASE.out(q)) * size * 0.6 } : { a: EASE.out(q), sc: 1, dy: 0 };
    });
  }
  const r = it.dur - lt;
  if (outA !== 'none' && r < outD) {
    anim = true;
    const p = clamp(1 - r / outD, 0, 1), e = EASE.in(p);
    switch (outA) {
      case 'fade': alpha *= 1 - p; break;
      case 'slideUp': dy -= e * size * 0.8; alpha *= 1 - p; break;
      case 'slideDown': dy += e * size * 0.8; alpha *= 1 - p; break;
      case 'slideLeft': dx -= e * size * 1.6; alpha *= 1 - p; break;
      case 'slideRight': dx += e * size * 1.6; alpha *= 1 - p; break;
      case 'shrink': sc *= Math.max(0.001, 1 - e); break;
      case 'zoomOut': sc *= 1 + e * 1.2; alpha *= 1 - p; break;
      case 'rotateOut': rot += e * Math.PI / 2; sc *= 1 - 0.5 * e; alpha *= 1 - p; break;
      case 'sink': dy += e * size; alpha *= 1 - p; break;
      case 'wipe': wipeOut = EASE.out(p); break;
      case 'typeErase': chars = Math.min(chars, Math.floor(len * (1 - p))); break;
      case 'flipOut': sy *= Math.max(0.01, 1 - e); break;
      case 'squash': sy *= Math.max(0.01, 1 - e); sx *= 1 + 0.5 * e; alpha *= 1 - p * p; break;
      case 'stretchOut': sx *= 1 + 1.6 * e; sy *= 1 - 0.4 * e; alpha *= 1 - p; break;
      case 'fall': dy += e * size * 3; rot += e * 0.6; alpha *= 1 - p * p; break;
      case 'blinkOut': alpha *= p < 0.15 || [0.25, 0.45, 0.62].some((x, i) => p > x && p < x + 0.1 - i * 0.02) ? 1 : 0.08; break;
      case 'glitchOut': { const q = Math.floor(p * 14), j = p * size; dx += (rnd(q + 11) - 0.5) * j * 1.6; dy += (rnd(q + 5) - 0.5) * j * 0.3; alpha *= rnd(q + 2) > p - 0.1 ? 1 - p * 0.5 : 0.1; break; }
      case 'wordFadeOut': {
        const n = it.text.split(/\s+/).filter(Boolean).length;
        toks.push(i => ({ a: 1 - clamp((p * (n + 1) - i), 0, 1), sc: 1, dy: 0 }));
        break;
      }
    }
  }
  if (loopA !== 'none') {
    anim = true;
    switch (loopA) {
      case 'pulse': sc *= 1 + 0.06 * Math.sin(TAU * lt * 1.5); break;
      case 'float': dy += Math.sin(TAU * lt * 0.8) * size * 0.12; break;
      case 'shake': dx += Math.sin(lt * 47) * Math.sin(lt * 13) * size * 0.05; dy += Math.sin(lt * 39) * size * 0.03; break;
      case 'swing': rot += Math.sin(TAU * lt) * 0.08; break;
      case 'heartbeat': sc *= 1 + 0.1 * Math.pow(Math.max(0, Math.sin(TAU * lt * 1.2)), 8); break;
      case 'flicker': alpha *= Math.sin(lt * 23) * Math.sin(lt * 7) > 0.6 ? 0.35 : 1; break;
      case 'wave': toks.push(i => ({ a: 1, sc: 1, dy: Math.sin(TAU * lt * 0.9 - i * 0.7) * size * 0.14 })); break;
      case 'jelly': { const w = Math.sin(TAU * lt * 1.4) * 0.07; sx *= 1 + w; sy *= 1 - w; break; }
      case 'bounce': dy -= Math.abs(Math.sin(Math.PI * lt * 1.6)) * size * 0.22; break;
      case 'tada': { const q = (lt % 2) / 0.9; if (q < 1) { sc *= 1 + 0.1 * Math.sin(Math.PI * q); rot += Math.sin(q * Math.PI * 8) * 0.06 * (1 - q); } break; }
      case 'tilt': rot += Math.sin(TAU * lt * 0.35) * 0.05; break;
      case 'zoomBeat': sc *= 1 + 0.12 * Math.pow(Math.max(0, Math.sin(TAU * lt)), 12); break;
      case 'jitter': { const q = Math.floor(lt * 12); if (rnd(q) > 0.82) { dx += (rnd(q + 1) - 0.5) * size * 0.25; dy += (rnd(q + 2) - 0.5) * size * 0.08; } break; }
      case 'breathe': sc *= 1 + 0.03 * Math.sin(TAU * lt * 0.4); break;
      case 'blink': alpha *= (lt % 1.2) < 0.12 ? 0.25 : 1; break;
      case 'spinLoop': rot += TAU * lt * 0.5; break;
      case 'hop': { const q = (lt % 1.1) / 1.1, up = Math.sin(Math.PI * Math.min(1, q / 0.6)), sq = q > 0.6 ? Math.sin(Math.PI * (q - 0.6) / 0.4) * 0.12 : 0;
        dy -= up * size * 0.3; sx *= 1 + sq; sy *= 1 - sq; break; }
      case 'wiggle': { const q = lt % 1.6; if (q < 0.5) rot += Math.sin(q * Math.PI * 8) * 0.18 * (1 - q / 0.5); break; }
      case 'orbit': dx += Math.cos(TAU * lt * 0.7) * size * 0.1; dy += Math.sin(TAU * lt * 0.7) * size * 0.1; break;
      case 'popBeat': { const q = (lt % 1.2) / 1.2; sc *= 1 + 0.18 * Math.max(0, Math.sin(Math.PI * Math.min(1, q / 0.25))) * (q < 0.25 ? 1 : 0); break; }
      case 'rock': rot += Math.sin(TAU * lt * 0.6) * 0.25; break;
    }
  }
  let word = -1;
  if (it.words) for (let i = 0; i < it.words.length; i++) if (it.words[i].s <= lt) word = i;
  const tok = toks.length ? i => toks.reduce((m, f) => { const k = f(i); return { a: m.a * k.a, sc: m.sc * k.sc, dy: m.dy + k.dy }; }, { a: 1, sc: 1, dy: 0 }) : null;
  return { alpha, dx, dy, sc, sx, sy, rot, chars, wipe, wipeOut, tok, anim, word };
}

// pr: project (P, or a scaled copy for export) — sizes come from it.
function drawTextItem(ctx, pr, it, lt) {
  it = S.animAt(it, lt);
  const st = { ...textDefaults(it.track === 'c1'), ...it.style }, s = textState({ ...it, style: st }, lt);
  if (it.icon) return drawIconItem(ctx, pr, it, st, s, lt);
  // Enter starts a new line; each paragraph reads right-to-left or left-to-right on its own
  // (auto: its first letter decides; the dir buttons force one way for the whole text).
  const tokens = [], brk = new Set(), tokR = [];
  for (const para of caseText(it.text, st.caseMode).split('\n')) {
    const w = para.split(/\s+/).filter(Boolean);
    if (!w.length) continue;
    const r = st.dir === 'rtl' ? true : st.dir === 'ltr' ? false : /^[^A-Za-z\u0590-\u08FF]*[\u0590-\u08FF]/.test(para);
    if (tokens.length) brk.add(tokens.length);
    for (const x of w) { tokens.push(x); tokR.push(r); }
  }
  const alpha = s.alpha * clamp(num(it.opacity, 1), 0, 1);
  if (alpha <= 0 || !tokens.length || s.sc <= 0 || s.sx <= 0 || s.sy <= 0) return;
  if (ctx === vctx && it.id === editId) return; // being edited in place: the editor box shows it
  const rtl = tokR[0];
  let R = rtl;
  ctx.save();
  ctx.font = `${st.italic ? 'italic ' : ''}${st.weight} ${st.size}px "${st.font}"`;
  wantFont(`${st.weight} 40px "${st.font}"`);
  // Letter spacing splits Arabic joins (kashida/tatweel gaps), so Arabic gets it between words instead.
  const arab = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(it.text);
  if ('letterSpacing' in ctx) ctx.letterSpacing = (arab ? 0 : num(st.spacing, 0)) + 'px';
  ctx.textBaseline = 'middle';
  ctx.direction = 'ltr';
  const space = ctx.measureText(' ').width + (arab ? num(st.spacing, 0) * 3 : 0), maxW = pr.w * 0.86;
  const widths = tokens.map(tk => ctx.measureText(tk).width);
  const lines = [];
  let cur = [], w = 0;
  tokens.forEach((tk, i) => {
    if (cur.length && (brk.has(i) || w + space + widths[i] > maxW)) { lines.push({ idx: cur, w, rtl: tokR[cur[0]] }); cur = []; w = 0; }
    w += (cur.length ? space : 0) + widths[i];
    cur.push(i);
  });
  if (cur.length) lines.push({ idx: cur, w, rtl: tokR[cur[0]] });
  let shown = tokens;
  if (s.chars < Infinity) {
    let left = s.chars;
    shown = tokens.map(tk => { const v = tk.slice(0, Math.max(0, left)); left -= tk.length + 1; return v; });
  }
  const lh = st.size * num(st.lineH, 1.3), tk = S.trkAt(it, lt), cx = (num(it.x, 0.5) + tk[0]) * pr.w, cy = (num(it.y, 0.5) + tk[1]) * pr.h;
  const blockW = Math.max(...lines.map(l => l.w)), top = cy - (lines.length * lh) / 2 + lh / 2;
  const pad = st.size * 0.35;
  if (ctx === vctx) textBoxes.set(it.id, { cx: cx + s.dx, cy: cy + s.dy, w: (blockW + pad * 2) * s.sc * s.sx * num(it.scale, 1), h: lines.length * lh * s.sc * s.sy * num(it.scale, 1), rot: s.rot * 180 / Math.PI + num(it.rotate, 0) });
  ctx.translate(cx + s.dx, cy + s.dy);
  ctx.rotate(s.rot + num(it.rotate, 0) * Math.PI / 180);
  ctx.scale(s.sc * s.sx * num(it.scale, 1), s.sc * s.sy * num(it.scale, 1));
  ctx.translate(-cx, -cy);
  if (s.wipe < 1 || s.wipeOut > 0) { // reveal along the reading direction
    const L = cx - blockW / 2 - pad, full = blockW + pad * 2, a = full * s.wipeOut, b = full * s.wipe;
    ctx.beginPath();
    if (rtl) ctx.rect(L + full - b, top - lh, b - a, lines.length * lh + lh); else ctx.rect(L + a, top - lh, b - a, lines.length * lh + lh);
    ctx.clip();
  }
  ctx.globalAlpha = alpha;
  const hlOK = it.words && it.words.length === tokens.length;
  const lineLeft = ln => st.align === 'left' ? cx - blockW / 2 : st.align === 'right' ? cx + blockW / 2 - ln.w : cx - ln.w / 2;
  const fillFor = (y, i) => {
    if (hlOK && i === s.word) return st.hl;
    if (!st.gradOn) return st.color;
    const g = ctx.createLinearGradient(0, y - st.size / 2, 0, y + st.size / 2);
    g.addColorStop(0, st.color); g.addColorStop(1, st.fill2);
    return g;
  };
  const glyphs = (txt, x, y, i) => {
    if (st.hlBg && hlOK && i === s.word) { // box behind the word being spoken
      const w = widths[i], p = st.size * 0.14;
      ctx.save(); ctx.fillStyle = st.hlBg; ctx.beginPath();
      ctx.roundRect((R ? x - w : x) - p, y - st.size * 0.62, w + p * 2, st.size * 1.24, st.size * 0.2); ctx.fill(); ctx.restore();
    }
    if (st.glowOn) {
      ctx.save();
      ctx.shadowColor = st.glowColor; ctx.shadowBlur = st.glowSize; ctx.fillStyle = st.glowColor;
      ctx.fillText(txt, x, y); ctx.fillText(txt, x, y);
      ctx.restore();
    }
    // extra strokes stack outward around the main one (Photoshop-style); extra shadows fall from the whole outline
    const rings = [];
    let rw = st.strokeW > 0 ? st.strokeW : 0;
    for (const k of st.strokes || []) if (k.w > 0) rings.push([rw += +k.w, k.c]);
    ctx.lineJoin = 'round';
    for (const sh of st.shadows || []) {
      // only the shadow lands on screen: the body is drawn far off-canvas and its shadow shifted back
      // (so a fading text never shows a solid shadow-coloured copy through itself)
      const m = ctx.getTransform(), OFF = 1e4, d = num(sh.dist, 0) * 0.7;
      ctx.save();
      ctx.shadowColor = sh.c; ctx.shadowBlur = num(sh.blur, 0);
      ctx.shadowOffsetX = d - OFF * m.a; ctx.shadowOffsetY = d - OFF * m.b;
      ctx.fillStyle = ctx.strokeStyle = sh.c;
      if (rw > 0) { ctx.lineWidth = rw * 2; ctx.strokeText(txt, x + OFF, y); }
      ctx.fillText(txt, x + OFF, y);
      ctx.restore();
    }
    if (st.shadowOn) {
      ctx.shadowColor = st.shadowColor; ctx.shadowBlur = st.shadowBlur;
      ctx.shadowOffsetX = st.shadowDist * 0.7; ctx.shadowOffsetY = st.shadowDist * 0.7;
    }
    for (let j = rings.length - 1; j >= 0; j--) { ctx.lineWidth = rings[j][0] * 2; ctx.strokeStyle = rings[j][1]; ctx.strokeText(txt, x, y); ctx.shadowColor = 'transparent'; }
    if (st.strokeW > 0) { ctx.lineWidth = st.strokeW * 2; ctx.strokeStyle = st.stroke; ctx.strokeText(txt, x, y); ctx.shadowColor = 'transparent'; }
    ctx.fillStyle = fillFor(y, i);
    ctx.fillText(txt, x, y);
    ctx.shadowColor = 'transparent';
  };
  lines.forEach((ln, li) => {
    const y = top + li * lh, x0 = lineLeft(ln);
    R = ln.rtl;
    ctx.textAlign = R ? 'right' : 'left';
    if (st.bgOn) {
      ctx.save();
      ctx.globalAlpha = alpha * num(st.bgAlpha, 1);
      ctx.fillStyle = st.bg;
      ctx.beginPath();
      ctx.roundRect(x0 - pad, y - lh / 2, ln.w + pad * 2, lh, st.size * num(st.bgRadius, 0.22));
      ctx.fill();
      ctx.restore();
    }
    let x = R ? x0 + ln.w : x0;
    for (const i of ln.idx) {
      const txt = shown[i];
      if (txt) {
        if (s.tok) {
          const k = s.tok(i), mid = R ? x - widths[i] / 2 : x + widths[i] / 2;
          if (k.a > 0 && k.sc > 0) {
            ctx.save();
            ctx.globalAlpha = alpha * k.a;
            ctx.translate(mid, y + k.dy); ctx.scale(k.sc, k.sc); ctx.translate(-mid, -y);
            glyphs(txt, x, y, i);
            ctx.restore();
          }
        } else glyphs(txt, x, y, i);
      }
      x += (R ? -1 : 1) * (widths[i] + space);
    }
    if (st.underline) {
      ctx.fillStyle = st.gradOn ? st.color : st.color;
      ctx.fillRect(x0, y + st.size * 0.52, ln.w, Math.max(2, st.size * 0.06));
    }
  });
  ctx.restore();
}

function visibleTexts(pr, time) {
  const out = [];
  for (const tid of renderOrder(pr, 'text')) for (const it of pr.items) if (it.track === tid && isText(it) && !it.hidden && active(it, time)) out.push(it);
  return out;
}

const view = $('#view'), vctx = view.getContext('2d');
const textBoxes = new Map(); // text id -> on-screen box, filled while drawing the preview
let editId = null; // text being edited in place on the preview (not drawn on the canvas meanwhile)
const selBox = $('#stage').appendChild(Object.assign(document.createElement('div'), { id: 'selbox', hidden: true,
  innerHTML: '<i data-sh="nw"></i><i data-sh="ne"></i><i data-sh="sw"></i><i data-sh="se"></i><button data-sh="del"></button><button data-sh="rot"></button>' }));
selBox.querySelector('[data-sh="del"]').innerHTML = icon('x');
selBox.querySelector('[data-sh="rot"]').innerHTML = icon('rotate-cw');
function draw() {
  if (view.width !== P.w || view.height !== P.h) { view.width = P.w; view.height = P.h; fitView(); }
  let ap = animPreview && item(animPreview.id);
  if (animPreview && (!ap || ap.id !== sel || inspTab !== 'tAnim')) { animPreview = null; ap = null; }
  textBoxes.clear();
  const vt = visibleTexts(P, t);
  const render = ctx => drawVisual(ctx, t, ap && !isText(ap) ? { id: ap.id, lt: animPreviewLt(ap) } : null, tid => {
    for (const it of vt) if (it.track === tid && (!ap || it.id !== ap.id)) drawTextItem(ctx, P, it, t - it.start);
    if (ap && isText(ap) && ap.track === tid) drawTextItem(ctx, P, ap, animPreviewLt(ap));
  });
  objectGeometry = depthGeometry = null;
  objectDrawing = true;
  try { render(vctx); } finally { objectDrawing = false; }
  drawObjectPrompt();
  syncKfUI();
  placeSelBox();
  if (!panelVisible('scopes')) return;
  // Scopes sample the frame the viewer just drew (the proxy frame when one is active).
  updateScopes(view, playing || !!animPreview);
}
// Animation preview: plays just the chosen animation on the selected text, looping, while the rest of the frame holds still.
let animPreview = null;
function animPreviewLt(it) {
  const inD = num(it.inDur, 0.5), outD = Math.min(num(it.outDur, 0.4), it.dur), sub = animPreview.sub;
  const [a, b] = sub === 'out' ? [Math.max(0, it.dur - outD - 0.5), it.dur] : sub === 'loop' ? [Math.min(inD, it.dur), Math.min(inD + 2, it.dur)] : [0, Math.min(it.dur, inD + 0.6)];
  const span = b - a + (sub === 'out' ? 0.35 : 0), e = (performance.now() - animPreview.at) / 1000 % (span + 0.25);
  return Math.min(a + e, sub === 'out' ? it.dur - 1e-3 : b);
}
function startAnimPreview(it) {
  setPlaying(false);
  animPreview = { id: it.id, sub: animSub, at: performance.now() };
  needsDraw = true;
}
function fitView() {
  const st = $('#stage'), aw = st.clientWidth - 28, ah = st.clientHeight - 28;
  const k = Math.max(0.01, Math.min(aw / P.w, ah / P.h));
  view.style.width = Math.floor(P.w * k) + 'px';
  view.style.height = Math.floor(P.h * k) + 'px';
}
new ResizeObserver(fitView).observe($('#stage'));

/* ---------- safe zone: the app UI of each platform drawn over the preview (never exported) ---------- */
// Margins kept free of app UI, in px of a 1080x1920 frame: [top, right, bottom, left].
const SAFE = {
  tiktok: { m: [130, 150, 480, 60], icons: ['circle-user', 'heart', 'message-circle', 'bookmark', 'share-2'], top: 'Following   For You', user: '@username', cap: 'caption text #hashtag', music: 'original sound' },
  reels: { m: [220, 150, 420, 40], icons: ['heart', 'message-circle', 'send', 'ellipsis'], top: 'Reels', user: 'username · Follow', cap: 'caption text…', music: 'original audio' },
  snap: { m: [180, 140, 380, 50], icons: ['heart', 'message-circle', 'send', 'ellipsis'], top: 'Spotlight', user: 'username', cap: 'caption text', music: 'original sound' },
};
// platform marks for the buttons (simple line drawings in the app's icon style)
const SZ_MARK = {
  tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.5 2.6 2.4 4.4 5 4.6"/>',
  reels: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/>',
  snap: '<path d="M12 3c-3 0-5 2.2-5 5v2.5l-1.8-.6c-.6-.2-1 .6-.5 1l1.8 1.2c-.6 1.6-1.8 2.9-3.3 3.5.4.7 1.5.9 2.4 1 .2.6.3 1.1.8 1.2.7.1 1.5-.3 2.4 0 1.1.4 2 1.7 3.2 1.7s2.1-1.3 3.2-1.7c.9-.3 1.7.1 2.4 0 .5-.1.6-.6.8-1.2.9-.1 2-.3 2.4-1-1.5-.6-2.7-1.9-3.3-3.5l1.8-1.2c.5-.4.1-1.2-.5-1l-1.8.6V8c0-2.8-2-5-5-5z"/>',
};
let safeOn = lsGet('kadr.safe', '');
if (!SAFE[safeOn]) safeOn = '';
function renderSafe() {
  const el = $('#safe'), z = SAFE[safeOn];
  for (const b of $('#bSafe').children) {
    const k = b.dataset.sz;
    if (!b.firstChild) b.innerHTML = `<svg class="ic" viewBox="0 0 24 24">${SZ_MARK[k]}</svg>`;
    b.classList.toggle('on', k === safeOn);
    b.title = tr('safeZone') + ': ' + tr('sz_' + k);
  }
  el.hidden = !z;
  if (!z) return;
  const [t0, r0, b0, l0] = z.m, pct = (v, d) => (v / d * 100).toFixed(2) + '%';
  el.innerHTML = `<div class="sz-box" style="top:${pct(t0, 1920)};right:${pct(r0, 1080)};bottom:${pct(b0, 1920)};left:${pct(l0, 1080)}"></div>` +
    `<div class="sz-top">${esc(z.top)}</div><div class="sz-tag">${esc(tr('sz_' + safeOn))}</div>` +
    `<div class="sz-icons">${z.icons.map(n => icon(n)).join('')}</div>` +
    `<div class="sz-meta"><b>${esc(z.user)}</b><span>${esc(z.cap)}</span><span>${icon('music')} ${esc(z.music)}</span></div>`;
  placeSafe();
}
function placeSafe() {
  const el = $('#safe');
  if (el.hidden) return;
  const vr = view.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
  Object.assign(el.style, { left: vr.left - sr.left + 'px', top: vr.top - sr.top + 'px', width: vr.width + 'px', height: vr.height + 'px', fontSize: vr.width / 1080 * 34 + 'px' });
}
new ResizeObserver(placeSafe).observe(view);
$('#bSafe').onclick = e => { const b = e.target.closest('[data-sz]'); if (!b) return; safeOn = safeOn === b.dataset.sz ? '' : b.dataset.sz; lsSet('kadr.safe', safeOn); renderSafe(); }; // a second click hides it
renderSafe();

/* ---------- docking and workspaces ---------- */
const W = window.MaqtoWorkspace, dock = $('#dock'), wsMenu = $('#workspaces'), wsButton = $('#bWorkspaces');
const dockPanels = Object.fromEntries(W.panels.map(id => [id, $(W.library.includes(id) ? `[data-pane="${id}"]` : '#' + id)]));
const dockNames = { player: 'wsPreview', insp: 'wsInspector', tl: 'wsTimeline', scopes: 'wsScopes', transcript: 'wsTranscript', multicam: 'wsMulticam', effects: 'fxTab', stickers: 'stTab', icons: 'icTab', trans: 'transitions', layers: 'layersTab', sounds: 'sfxTab' };
const dockName = id => tr(dockNames[id] || id);
const panelVisible = id => !dockPanels[id].hidden;
const updateScopes = MaqtoScopes.mount(dockPanels.scopes, () => { needsDraw = true; });
const wsKey = 'kadr.workspaces', validAccent = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const accents = { wsTeal: ACCENT, wsOrange: '#ff8a3d', wsGreen: '#46c770', wsBlue: '#4a8dff', wsViolet: '#8b6cff', wsPink: '#ff5c9a', wsYellow: '#f5c542', wsRed: '#ff5a5a' };
const cloneDock = tree => JSON.parse(JSON.stringify(tree));
const dockGroups = new Map(), dockTabsObserver = new ResizeObserver(entries => entries.forEach(e => e.target.updateEdges()));
let ws, dockDrag;

function loadWorkspaces() {
  const saved = lsGet(wsKey, null);
  const validLayout = layout => W.valid(W.withPanels(layout));
  const validEntry = w => w && typeof w.id === 'string' && w.id && w.id !== 'standard' && typeof w.name === 'string' && w.name.trim() && validAccent(w.accent) && validLayout(w.layout);
  if (saved?.version === 1 && validLayout(saved.standard) && validLayout(saved.layout) && validAccent(saved.accent)
      && Array.isArray(saved.workspaces) && saved.workspaces.every(validEntry)
      && new Set(saved.workspaces.map(w => w.id)).size === saved.workspaces.length
      && (saved.current === 'standard' || saved.workspaces.some(w => w.id === saved.current))) return saved;
  const legacy = (key, fallback, min, max) => {
    const size = +lsGet('kadr.' + key, 0);
    return saved == null && Number.isFinite(size) && size > 0 ? clamp(size, min, Math.max(min, max)) : fallback;
  };
  const lib = legacy('libW', 290, 200, 560), insp = legacy('inspW', 320, 240, 560);
  const bounds = dock.getBoundingClientRect();
  const height = bounds.height - PANEL_GAP, tl = legacy('tlH', 340, 150, height - 320);
  const standard = { split: 'col', sizes: W.fractions([Math.max(160, height - tl), tl]), children: [
    { split: 'row', sizes: W.fractions([lib, Math.max(240, bounds.width - 2 * PANEL_GAP - lib - insp), insp]), children: [W.group(...W.library), W.group('player'), W.group('insp', 'scopes', 'transcript', 'multicam')] },
    W.group('tl'),
  ] };
  return { version: 1, current: 'standard', standard, workspaces: [], layout: cloneDock(standard), accent: ACCENT };
}
const persistDock = () => lsSet(wsKey, ws);
function applyAccent(colour) {
  ws.accent = colour.toLowerCase();
  const root = document.documentElement.style;
  const rgb = ws.accent.slice(1).match(/../g).map(c => parseInt(c, 16));
  const hex = channels => '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
  const whiteMix = amount => rgb.map(c => Math.round(c + (255 - c) * amount));
  const luma = channels => channels.reduce((sum, c, i) => {
    const s = c / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  }, 0);
  const darkInk = (luma(rgb) + 0.05) / 0.05 >= 4.5;
  // Keep the same readable ink when the accent button is hovered.
  const hover = [0.18, 0.09, 0.04, 0.02, 0].map(whiteMix).find(c => darkInk || 1.05 / (luma(c) + 0.05) >= 4.5);
  root.setProperty('--accent', ws.accent);
  root.setProperty('--accent-hover', hex(hover));
  root.setProperty('--accent-ink', darkInk ? '#000' : '#fff');
  CHROME_ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  needsDraw = true;
}
function dockVisibility(before) {
  if (before.has('text') && !panelVisible('text')) piperAudio.pause();
  if (panelVisible('scopes') && !before.has('scopes')) needsDraw = true;
  if (panelVisible('transcript') && !before.has('transcript')) { renderCapModels(); renderTranscript(); }
  if (panelVisible('trans') && !before.has('trans')) renderTrans();
  if (['filters', 'effects'].some(id => panelVisible(id) && !before.has(id))) renderLookCards();
  if (panelVisible('layers') && !before.has('layers')) renderLayers();
  if (panelVisible('icons') && !$('#iconList').childElementCount) renderIcons();
  if (panelVisible('captions') && !before.has('captions')) renderCapModels();
  if (panelVisible('sounds') && !before.has('sounds')) loadSfx();
  if (panelVisible('aiTools') && !before.has('aiTools')) renderAITools();
  if (!panelVisible('sounds') && !sfxAudio.paused) sfxAudio.pause();
  if (!panelVisible('media')) stopBinPrev();
}
function dockTabState(group) {
  for (const id of group.tabs) dockPanels[id].hidden = id !== group.active;
  const bar = dockGroups.get(group).bar;
  if (!bar) return;
  for (const b of bar.children) {
    const on = b.dataset.dockTab === group.active;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
}
function revealPanel(id) {
  const group = W.find(ws.layout, id), { bar } = dockGroups.get(group);
  const before = new Set(W.panels.filter(panelVisible));
  group.active = id;
  dockTabState(group);
  const b = bar?.querySelector(`[data-dock-tab="${id}"]`);
  if (b) {
    const r = b.getBoundingClientRect(), q = bar.getBoundingClientRect();
    if (r.left < q.left + 22 || r.right > q.right - 22) bar.scrollBy({ left: (r.left + r.right - q.left - q.right) / 2 });
  }
  dockVisibility(before);
  persistDock();
}
function renderDock() {
  const before = new Set(W.panels.filter(id => panelVisible(id) && dockPanels[id].closest('.dock-group')));
  const focused = document.activeElement, focusedTab = focused.dataset.dockTab;
  dockTabsObserver.disconnect();
  dockGroups.clear();
  function build(node) {
    const el = document.createElement('div');
    if (!node.split) {
      el.className = 'dock-group glass panel';
      el.dockGroup = node;
      const bar = dockHeader(el, node);
      dockGroups.set(node, { el, bar });
      el.append(...node.tabs.map(id => dockPanels[id]));
      dockTabState(node);
      const widths = { player: 240, insp: 240, tl: 280 };
      const heights = { player: 160, tl: 150 };
      return { el, w: Math.max(...node.tabs.map(id => widths[id] || 200)), h: 32 + Math.max(...node.tabs.map(id => heights[id] || 96)) };
    }
    const row = node.split === 'row', children = node.children.map(build), axis = row ? 'w' : 'h';
    el.className = 'dock-split dock-' + node.split;
    const tracks = () => {
      const cells = children.map((c, i) => `minmax(${c[axis]}px, ${Math.max(1, node.sizes[i] * 1000)}fr)`).join(' var(--gap) ');
      el.style[row ? 'gridTemplateColumns' : 'gridTemplateRows'] = cells;
    };
    tracks();
    children.forEach((c, i) => {
      if (i) el.append(dockSplitter(node, children, i - 1, row, tracks));
      el.append(c.el);
    });
    const sum = k => children.reduce((n, c) => n + c[k], (children.length - 1) * PANEL_GAP);
    const max = k => Math.max(...children.map(c => c[k]));
    return { el, w: row ? sum('w') : max('w'), h: row ? max('h') : sum('h') };
  }
  const { el, w, h } = build(ws.layout);
  el.style.minWidth = w + 'px';
  el.style.minHeight = h + 'px';
  dock.replaceChildren(el);
  if (focusedTab) dock.querySelector(`[data-dock-tab="${focusedTab}"]`)?.focus({ preventScroll: true });
  else if (dock.contains(focused) && !focused.closest('[hidden]')) focused.focus({ preventScroll: true });
  for (const { bar } of dockGroups.values()) {
    if (!bar) continue;
    const active = bar.querySelector('.on');
    const b = active.getBoundingClientRect(), r = bar.getBoundingClientRect();
    if (b.left < r.left || b.right > r.right) bar.scrollLeft += (b.left + b.right - r.left - r.right) / 2;
  }
  dockVisibility(before);
  persistDock();
}
function dockHeader(el, group) {
  const wrap = el.appendChild(document.createElement('div')), multiple = group.tabs.length > 1;
  wrap.className = multiple ? 'tabwrap' : 'dock-title';
  const bar = multiple ? wrap.appendChild(document.createElement('nav')) : wrap;
  if (multiple) bar.className = 'tabs';
  for (const id of group.tabs) {
    const b = bar.appendChild(document.createElement('button'));
    b.type = 'button';
    b.dataset.dockTab = id;
    b.textContent = dockName(id);
    if (id === 'aiTools' && AI_TOOLS_NEW) {
      b.insertAdjacentHTML('beforeend', `<span class="ai-new">${tr('aiNew')}</span>`);
    }
    b.onpointerdown = e => startDockDrag(e, id, b);
    b.onclick = e => {
      if (b.dragged && e.detail) { b.dragged = false; return; }
      if (id === 'media') focusZone = 'bin';
      if (id === 'tl') focusZone = 'tl';
      if (multiple) revealPanel(id);
    };
  }
  if (!multiple) return null;
  const arrow = (side, dx) => {
    const b = wrap.appendChild(document.createElement('button'));
    b.className = 'tarr ' + side;
    b.innerHTML = icon(side === 'l' ? 'chevron-left' : 'chevron-right');
    b.setAttribute('aria-label', tr(dx < 0 ? 'wsScrollLeft' : 'wsScrollRight'));
    b.onclick = () => bar.scrollBy({ left: dx * bar.clientWidth * 0.7 });
    return b;
  };
  const left = arrow('l', -1), right = arrow('r', 1);
  bar.updateEdges = () => {
    const r = bar.getBoundingClientRect(), kids = [...bar.children].map(c => c.getBoundingClientRect());
    left.hidden = Math.min(...kids.map(c => c.left)) >= r.left - 1;
    right.hidden = Math.max(...kids.map(c => c.right)) <= r.right + 1;
  };
  bar.onscroll = bar.updateEdges;
  bar.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    bar.scrollLeft += e.deltaY * (LANG === 'ar' ? -1 : 1);
    e.preventDefault();
  }, { passive: false });
  dockTabsObserver.observe(bar);
  return bar;
}
function dockSplitter(node, children, i, row, tracks) {
  const sp = document.createElement('div');
  sp.className = 'split ' + (row ? 'v' : 'h');
  sp.onpointerdown = e => {
    if (e.button !== 0 || !e.isPrimary) return;
    const axis = row ? 'w' : 'h', size = row ? 'width' : 'height', coord = row ? 'clientX' : 'clientY';
    const sizes = children.map(c => c.el.getBoundingClientRect()[size]);
    const start = e[coord], direction = row && LANG === 'ar' ? -1 : 1, original = node.sizes;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('on');
    document.body.classList.add('resizing');
    document.body.style.cursor = row ? 'col-resize' : 'row-resize';
    const move = ev => {
      if (ev.pointerId !== e.pointerId) return;
      const d = clamp((ev[coord] - start) * direction, children[i][axis] - sizes[i], sizes[i + 1] - children[i + 1][axis]);
      node.sizes = d === 0 ? original : W.fractions(sizes.map((s, j) => s + (j === i ? d : j === i + 1 ? -d : 0)));
      tracks();
    };
    const finish = ev => {
      if (ev.type !== 'blur' && ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (sp.hasPointerCapture(e.pointerId)) sp.releasePointerCapture(e.pointerId);
      sp.classList.remove('on');
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      persistDock();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };
  sp.ondblclick = () => { node.sizes = children.map(() => 1 / children.length); tracks(); persistDock(); };
  return sp;
}
function startDockDrag(e, id, tab) {
  if (e.button !== 0 || !e.isPrimary || dockDrag) return;
  tab.dragged = false;
  const ghost = document.createElement('div'), overlay = document.createElement('div');
  ghost.className = 'dock-ghost glass';
  ghost.textContent = dockName(id);
  overlay.className = 'dock-drop';
  const zones = ['left', 'right', 'top', 'bottom', 'center'];
  overlay.innerHTML = zones.map(zone => `<i class="${zone}"></i>`).join('');
  let active = false, target, zone, x = e.clientX, y = e.clientY;
  const draw = (px, py) => {
    ghost.style.transform = `translate(${px + 12}px, ${py + 12}px)`;
    const over = document.elementFromPoint(px, py)?.closest('.dock-group');
    target = over?.dockGroup;
    overlay.hidden = !target;
    if (!target) return;
    if (overlay.parentNode !== over) over.append(overlay);
    const r = over.getBoundingClientRect(), fx = (px - r.left) / r.width, fy = (py - r.top) / r.height;
    const distances = [fx, 1 - fx, fy, 1 - fy], min = Math.min(...distances);
    zone = min < 0.25 ? zones[distances.indexOf(min)] : 'center';
    const same = target.tabs.includes(id);
    overlay.dataset.zone = same && (target.tabs.length === 1 || zone === 'center') ? '' : zone;
  };
  const start = () => {
    active = tab.dragged = true;
    tab.setPointerCapture(e.pointerId);
    document.body.append(ghost);
    draw(x, y);
  };
  const timer = setTimeout(start, 250);
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    x = ev.clientX; y = ev.clientY;
    if (!active && Math.hypot(x - e.clientX, y - e.clientY) > 5) { clearTimeout(timer); start(); }
    if (active) draw(x, y);
  };
  const finish = ev => {
    clearTimeout(timer);
    if (!ev) tab.dragged = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', finish);
    if (active && tab.hasPointerCapture(e.pointerId)) tab.releasePointerCapture(e.pointerId);
    overlay.remove();
    ghost.remove();
    dockDrag = null;
    if (active && ev?.type === 'pointerup' && target) {
      const rtl = LANG === 'ar';
      const logical = zone === 'left' ? (rtl ? 'end' : 'start') : zone === 'right' ? (rtl ? 'start' : 'end') : zone;
      const next = W.move(ws.layout, id, target.active, logical);
      if (next !== ws.layout) { ws.layout = next; renderDock(); }
    }
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (active && ev.type === 'pointerup') draw(ev.clientX, ev.clientY);
    finish(ev);
  };
  dockDrag = finish;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', finish);
}

function activateWorkspace(id) {
  const w = ws.workspaces.find(w => w.id === id);
  ws.current = id;
  ws.layout = cloneDock(w ? w.layout : ws.standard);
  applyAccent(w ? w.accent : ACCENT);
  renderDock();
}
function closeWorkspaces(focus = false) {
  wsMenu.hidden = true;
  wsButton.setAttribute('aria-expanded', 'false');
  if (focus) wsButton.focus();
}
function openWorkspaces() {
  if (!ws || !$('#modal').hidden) return;
  const current = ws.workspaces.find(w => w.id === ws.current);
  const entry = (act, label, extra = '') => `<button type="button" data-ws="${act}" ${extra}>${esc(label)}</button>`;
  const choices = [{ id: 'standard', name: tr('wsStandard') }, ...ws.workspaces];
  wsMenu.innerHTML = `<div class="ws-list">${choices.map(w => `<button type="button" data-ws-id="${esc(w.id)}" aria-pressed="${w.id === ws.current}"><span>${w.id === ws.current ? icon('check') : ''}</span><bdi>${esc(w.name)}</bdi></button>`).join('')}</div><hr>` +
    entry('saveAs', tr('wsSaveAs')) + (current ? entry('save', tr('wsSave').replace('{name}', () => current.name)) : '') + entry('reset', tr('wsReset')) +
    (current ? entry('rename', tr('wsRename')) + entry('delete', tr('wsDelete'), 'class="danger"') : '') +
    `<hr><div class="ws-accent"><span>${tr('wsAccent')}</span><div>${Object.entries(accents).map(([k, c]) => `<button class="ws-swatch" type="button" data-colour="${c}" style="--swatch:${c}" title="${tr(k)}" aria-label="${tr(k)}" aria-pressed="${c === ws.accent}"></button>`).join('')}<input type="color" value="${ws.accent}" aria-label="${tr('wsCustom')}" title="${tr('wsCustom')}"></div></div>`;
  wsMenu.hidden = false;
  wsButton.setAttribute('aria-expanded', 'true');
  const r = wsButton.getBoundingClientRect(), width = wsMenu.offsetWidth;
  wsMenu.style.left = clamp(LANG === 'ar' ? r.right - width : r.left, 6, innerWidth - width - 6) + 'px';
  wsMenu.style.top = r.bottom + 6 + 'px';
  wsMenu.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
}
function chooseAccent(colour) {
  applyAccent(colour);
  wsMenu.querySelector('input').value = ws.accent;
  wsMenu.querySelectorAll('[data-colour]').forEach(b => b.setAttribute('aria-pressed', b.dataset.colour === ws.accent));
  persistDock();
}
wsMenu.oninput = e => { if (e.target.type === 'color') chooseAccent(e.target.value); };
wsMenu.onclick = async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.colour) return chooseAccent(b.dataset.colour);
  closeWorkspaces(true);
  if (b.dataset.wsId) {
    if (b.dataset.wsId !== ws.current) activateWorkspace(b.dataset.wsId);
    return;
  }
  const current = ws.workspaces.find(w => w.id === ws.current), action = b.dataset.ws;
  if (action === 'reset') return activateWorkspace(ws.current);
  if (action === 'delete') {
    ws.workspaces = ws.workspaces.filter(w => w !== current);
    return activateWorkspace('standard');
  }
  if (action === 'save') Object.assign(current, { layout: cloneDock(ws.layout), accent: ws.accent });
  else {
    const name = await askText(tr('wsName'), action === 'rename' ? current.name : '');
    wsButton.focus();
    if (!name) return;
    if (action === 'rename') current.name = name;
    else {
      ws.current = uid();
      ws.workspaces.push({ id: ws.current, name, layout: cloneDock(ws.layout), accent: ws.accent });
    }
  }
  persistDock();
};
wsButton.onclick = () => { if (wsMenu.hidden) openWorkspaces(); else closeWorkspaces(); };
document.addEventListener('pointerdown', e => {
  if (!wsMenu.hidden && !wsMenu.contains(e.target) && !wsButton.contains(e.target)) closeWorkspaces();
}, true);
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !dockDrag && wsMenu.hidden) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (dockDrag) dockDrag(); else closeWorkspaces(true);
}, true);

/* ---------- transport ---------- */
function loop(now) {
  requestAnimationFrame(loop); // first: an error in this frame must not freeze playback
  chainKeys.clear();
  playbackProject = S.expandMulticam(P);
  if (playing) {
    if (AC && AC.currentTime !== waTime) { waTime = AC.currentTime; waAt = now; }
    // The playing clip is the clock (no seeks fighting the decoder); wall time only if it stalls > 0.8 s.
    // Clock: the clip sound being heard (captions then follow the voice), else the playing video.
    // One far from t is stale (a seek just moved t), not a clock.
    const tc0 = (clockHeld(now) ? null : waClock(now)) ?? clockTime(), tc = tc0 !== null && Math.abs(tc0 - t) < 0.3 ? tc0 : null;
    if (tc !== null && tc !== clock.tc) { clock.tc = tc; clock.at = now; }
    const tn = tc !== null && now - clock.at < 800 ? Math.max(t, tc) : t + (now - lastTick) * playRate / 1000;
    // At a cut, hold the clock (and the last picture) until the next clip's decoder runs, at most 1 s:
    // running on would skip its first frames and words, then seek again to catch up.
    const cw = cutWait(t, tn);
    if (cw) { if (!clock.wait) clock.wait = now; clock.seekHold = cw === 2; } else { if (clock.wait) inv('dev_log', { msg: `cut wait ${Math.round(now - clock.wait)}ms at t=${t.toFixed(2)}` }); clock.wait = 0; }
    if (!clockHeld(now)) t = tn;
    if (t >= total()) { t = total(); setPlaying(false); }
    needsDraw = true;
    follow();
  }
  if (playing && now - lastTick > 50) inv('dev_log', { msg: `frame gap ${Math.round(now - lastTick)}ms at t=${t.toFixed(2)}${clock.wait ? ' (cut wait)' : ''}` });
  lastTick = now;
  const p0 = performance.now();
  syncMedia(playbackProject);
  const p1 = performance.now();
  if (needsDraw || animPreview) { needsDraw = false; draw(); updatePlayhead(); }
  const p2 = performance.now();
  if (playing && p2 - p0 > 30) inv('dev_log', { msg: `slow tick sync=${Math.round(p1 - p0)}ms draw=${Math.round(p2 - p1)}ms at t=${t.toFixed(2)}` });
  if (!playing && inspTab === 'tAnim' && now - (loop.th || 0) > 33) { loop.th = now; animThumbs(now / 1000); }
  if (!playing && panelVisible('trans') && now - (loop.tt || 0) > 40) { loop.tt = now; transThumbs(now / 1000); }
  if (!playing && panelVisible('effects') && fxHover && now - (loop.tf || 0) > 33) { loop.tf = now; fxThumbs(now / 1000); }
  if (!playing && panelVisible('stickers') && stCat === 'anim' && now - (loop.ts || 0) > 40) { loop.ts = now; stickerThumbs(now / 1000); }
  if (!playing && panelVisible('icons') && (icCat === 'anim' || icCat === 'draw') && !$('#icQ').value && now - (loop.ti || 0) > 40) { loop.ti = now; iconThumbs(now / 1000); }
  if (now - (loop.tw || 0) > 300) { loop.tw = now; warmTrans(); }
}
const clock = { tc: null, at: 0 };
const clockHeld = (now = lastTick) => !!clock.wait && now - clock.wait < 1000;
// A clip on screen whose player is seeking, or one starting in (t0, t1] / under 1 s ago still buffering.
// Running on during a seek makes the player chase the clock (seek, land late, seek again): frozen picture.
// 1: a cut (players held paused), 2: a playing player seeking (it keeps playing, only the clock waits).
function cutWait(t0, t1) {
  let r = 0;
  for (const it of playbackProject.items) {
    if (it.start > t1 || it.start + it.dur <= t1 || it.hidden) continue;
    const fresh = it.start > t0 - 1, m = media(it), el = m && m.kind !== 'image' && els.get(chainKey(it));
    if (!el || ((m.kind === 'audio' || it.audioOnly) && waLive.has(it.id) && waRunning())) continue;
    if (fresh && (el.seeking || el.readyState < 3)) return 1;
    if (!fresh && el.seeking && !el.paused && rateOf(it) <= 3) r = 2; // fast parts skip frames by seeking on purpose
  }
  return r;
}
// Timeline time of the clip sound now reaching the speaker.
function waClock(now) {
  if (!waRunning(now)) return null;
  for (const it of playbackProject.items) { const n = waLive.get(it.id); if (n && active(it, t)) return it.start + (AC.currentTime - n.t0 - waLat()) * playRate; }
  return null;
}
function clockTime() {
  let best = null;
  for (const it of playbackProject.items) {
    const m = media(it), el = els.get(chainKey(it));
    // speed-curve clips change rate as they play; WebKit stalls on each change, so wall time leads there (unless a retimed proxy plays)
    if (!m || m.kind === 'image' || (S.hasCurve(it) && !el?._px) || !el || el.paused || el.ended || el.seeking || el.readyState < 3 || !active(it, t)) continue;
    if (best && best.it.track === 'v1') continue;
    best = { it, el };
  }
  return best && best.it.start + (best.el._px ? best.el.currentTime : S.ltAt(best.it, best.el.currentTime - num(best.it.in, 0))); // a retimed proxy plays timeline time at 1x
}
function setPlaying(v, rate = 1) {
  if (v) piperAudio.pause();
  clock.wait = 0;
  clock.tc = null;
  if (rate !== playRate) waStopAll();
  playRate = rate;
  if (v) { animPreview = null; stopBinPrev(); }
  playing = v && total() > 0;
  if (playing) {
    if (t >= total() - 0.01) seek(0);
    waAt = performance.now();
    if (AC && (AC.state === 'suspended' || AC.state === 'interrupted')) AC.resume().catch(() => {});
  } else {
    waStopAll();
    for (const el of els.values()) pauseMedia(el);
    for (const el of tailEls.values()) pauseMedia(el);
    if (panelVisible('scopes')) needsDraw = true;
  }
  const b = $('#bPlay');
  b.dataset.i = playing ? 'pause' : 'play';
  b.innerHTML = icon(b.dataset.i);
}
function seek(v) { animPreview = null; t = clamp(v, 0, Math.max(total(), 0)); needsDraw = true; clock.wait = 0; clock.tc = null; waStopAll(); }
function updatePlayhead() {
  const end = total();
  if (t > end) t = end; // a clip removed or shortened under the playhead
  $('#ph').style.left = t * pps + 'px';
  $('#ruler').style.setProperty('--playhead-x', t * pps + 'px');
  $('#endln').style.left = end * pps + 'px'; // the end of the last clip: the playhead stops here
  $('#endln').classList.toggle('on', !!end && scrubbing && (end - t) * pps < 60); // only while dragging the playhead near the end
  $('#tc').textContent = fmt(t);
  if (panelVisible('transcript')) updateTranscriptPlayhead();
  for (const grip of $('#rows').querySelectorAll('[data-vkf]')) {
    const it = item(grip.dataset.vkf);
    if (!it) continue;
    const vol = clamp(S.volumeAt(it, kfLt(it)), 0, 2);
    grip.style.top = volGripTop(vol);
    grip.title = Math.round(vol * 100) + '%';
  }
}
function follow() {
  const sc = $('#scroll'), x = t * pps;
  if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 60;
}

/* ---------- timeline ---------- */
const TRACK_COLOR = { video: 'rgb(var(--video))', audio: 'rgb(var(--audio))', text: 'rgb(var(--text-c))' };
function clipLabel(it) {
  const off = it.hidden ? icon('eye-off') : '';
  if (isText(it)) return off + icon('type') + esc(it.text);
  const m = media(it);
  return off + icon(m.adj ? 'zap' : m.fill ? 'paint-bucket' : m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film') + esc(m.name) + (num(it.speed, 1) !== 1 ? `  ×${+num(it.speed, 1).toFixed(2)}` : '');
}
const groupInfo = id => id && Object.hasOwn(P.groups || {}, id) ? P.groups[id] : undefined;
const inTimeline = it => (groupInfo(it.grp) ? it.grp : null) === openGrp;
const timelineItems = () => P.items.filter(inTimeline);
const groupItems = id => P.items.filter(i => i.grp === id);
function addTimelineItem(it, group = openGrp) {
  if (groupInfo(group)) it.grp = group;
  P.items.push(it);
}
function groupBlocks() {
  const members = new Map();
  for (const it of P.items) if (it.grp && groupInfo(it.grp)) {
    if (!members.has(it.grp)) members.set(it.grp, []);
    members.get(it.grp).push(it);
  }
  return [...members].map(([id, its]) => {
    const span = S.groupSpan(its), { name } = groupInfo(id);
    const tracks = new Set(its.map(i => i.track));
    return { id, name, ...span, track: P.tracks.find(x => tracks.has(x.id))?.id, compound: true };
  });
}
const timelineClips = () => openGrp ? timelineItems() : [...timelineItems(), ...groupBlocks()];
const laneKeep = new Set();
const shownTracks = (clips = timelineClips()) => {
  const used = new Set(clips.map(i => i.track));
  return P.tracks.filter(x => used.has(x.id) || laneKeep.has(x.id) ||
    (!openGrp && x.id === 'v1' && !P.items.some(i => i.track === 'v1')));
};
const laneItems = id => P.items.filter(i => i.track === id && (!openGrp || inTimeline(i)));
const groupCrumb = $('#tl').insertBefore(Object.assign(document.createElement('nav'), { className: 'groupCrumb', hidden: true }), $('#tl .tlbody'));
groupCrumb.onclick = e => { if (e.target.closest('button')) showGroup(null); };
function showGroup(id) {
  if (id && !groupInfo(id)) return;
  const back = openGrp;
  openGrp = id;
  focusZone = 'tl';
  select(id ? null : back);
  renderTimeline();
  if (id) {
    const span = S.groupSpan(groupItems(id));
    if (!active(span, t)) seek(span.start);
    const sc = $('#scroll');
    if (span.start * pps < sc.scrollLeft || span.start * pps >= sc.scrollLeft + sc.clientWidth) sc.scrollLeft = span.start * pps;
  }
}
// Lane buttons: hide (every clip on it), lock (no moving or trimming), mute (sound of its clips).
function laneBtns(x) {
  const its = laneItems(x.id), off = its.length && its.every(i => i.hidden), mute = its.length && its.every(i => i.muted);
  const snd = x.kind !== 'text' && its.some(i => media(i) && (media(i).kind === 'audio' || media(i).kind === 'video') && !media(i).adj);
  return `<span class="lb">${snd ? `<b data-lk="mute" class="${mute ? 'on' : ''}" title="${tr('laneMute')}">${icon(mute ? 'volume-x' : 'volume-2')}</b>` : ''}` +
    `<b data-lk="lock" class="${x.locked ? 'on' : ''}" title="${tr('laneLock')}">${icon(x.locked ? 'lock' : 'lock-open')}</b>` +
    `<b data-lk="hide" class="${off ? 'on' : ''}" title="${tr('laneHide')}">${icon(off ? 'eye-off' : 'eye')}</b></span>`;
}
// Shader transitions sit centred on the cut as a see-through box; drag its edges to change the length.
function trBoxes(its) {
  return its.filter(b => b.trans && S.GLT.includes(b.trans.id)).map(b => {
    const T = S.transIn(P, b);
    return T ? `<b class="trn trbox" data-trn="${b.id}" title="${tr('tr_' + T.id)}" style="left:calc(${b.start - T.d / 2}px * var(--pps));width:calc(${T.d}px * var(--pps))"><i class="e l"></i>${icon('arrow-right-left')}<i class="e r"></i></b>` : '';
  }).join('');
}
$('#rows').addEventListener('pointerdown', e => {
  const bx = e.target.closest('.trbox');
  if (!bx || e.button !== 0) return;
  e.stopImmediatePropagation();
  if (!e.target.classList.contains('e')) return; // a plain click opens it (click handler below)
  e.preventDefault();
  const b = item(bx.dataset.trn), T = S.transIn(P, b), max = Math.min(2, b.dur, T.prev.dur);
  let moved = false;
  const mv = ev => {
    if (!moved) { snapshot(); moved = true; }
    b.trans.dur = +clamp(Math.abs(timeAt(ev.clientX) - b.start) * 2, 0.1, max).toFixed(2);
    bx.style.left = (b.start - b.trans.dur / 2) * pps + 'px'; bx.style.width = b.trans.dur * pps + 'px';
    needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (moved) { dirty = true; refresh(); if (panelVisible('trans')) renderTrans(); } }, { once: true });
}, true);
// The main lane sits in the middle of the timeline; new lanes stack above it until they reach the top, then it scrolls.
function laneGap() {
  const sc = $('#scroll'), above = Math.max(0, shownTracks().findIndex(x => x.id === 'v1')), mid = (sc.clientHeight - $('#ruler').offsetHeight) / 2;
  const g = Math.max(0, Math.round(mid - ROW / 2 - above * ROW));
  $('#rows').style.marginTop = $('#heads').style.marginTop = g + 'px';
}
new ResizeObserver(() => requestAnimationFrame(laneGap)).observe($('#scroll'));
/* ---------- audio waveforms on the timeline ---------- */
// Peaks (the loudest sample of each 1/50 s) of a sound, from the buffer Web Audio decodes for playback.
const PK = 50, peaks = new Map(), pkWait = new Set();
function peaksOf(it) {
  const m = media(it);
  if (peaks.has(m.path)) return peaks.get(m.path);
  const B = waOf(m);
  if (!B) {
    if (AC && !pkWait.has(m.path)) { pkWait.add(m.path); waLoad(it.media); (waBuf.get(m.path) || Promise.reject()).then(() => renderTimeline(), () => {}); }
    return null;
  }
  const n = Math.ceil(B.duration * PK), step = B.sampleRate / PK, out = new Float32Array(n), chs = [...Array(B.numberOfChannels)].map((_, c) => B.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let mx = 0;
    for (const d of chs) for (let j = Math.floor(i * step), e = Math.min(d.length, Math.floor((i + 1) * step)); j < e; j++) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
    out[i] = mx;
  }
  const mx = out.reduce((a, v) => Math.max(a, v), 1e-6);
  for (let i = 0; i < n; i++) out[i] /= mx; // the file's loudest moment fills the lane
  peaks.set(m.path, out);
  return out;
}
// Clip time 0..dur on x (seconds, stretched by the lane zoom), loudness 0..1 on y; volume and fades shape both
// the wave and the volume line. The line's grip (.vl) drags the volume up and down.
const volGripTop = v => `calc(${(1 - v / 2) * 100}% - 4px)`;
function waveHtml(it) {
  const pk = media(it).kind === 'audio' && peaksOf(it), keys = it.kf?.volume, dur = it.dur;
  const fi = Math.max(num(it.fadeIn, 0), num(it.afIn, 0)), fo = Math.max(num(it.fadeOut, 0), num(it.afOut, 0));
  const vol = x => clamp(S.volumeAt(it, x), 0, 2), env = x => S.audioFade(it, x);
  let wave = '';
  if (pk) {
    const n = Math.min(1500, Math.max(2, Math.round(dur * PK))), top = [], bot = [];
    for (let k = 0; k <= n; k++) {
      const x = dur * k / n, a = (pk[Math.floor((num(it.in, 0) + S.srcAt(it, x)) * PK)] || 0) * Math.min(1, 0.35 + 0.65 * vol(x)) * env(x) * 0.46; // quiet clips stay readable
      top.push(`${x.toFixed(3)} ${(0.5 - a).toFixed(3)}`); bot.unshift(`${x.toFixed(3)} ${(0.5 + a).toFixed(3)}`);
    }
    wave = `<path d="M${top.join('L')}L${bot.join('L')}Z" class="wv"/>`;
  }
  const knots = fi + fo > dur ? [dur * fi / (fi + fo)] : [fi, dur - fo];
  const xs = [...new Set([0, dur, ...knots, ...(keys || []).map(q => q[0])])].filter(x => x >= 0 && x <= dur).sort((a, b) => a - b);
  const line = `<polyline class="vln" points="${xs.map(x => `${x} ${1 - vol(x) * env(x) / 2}`).join(' ')}"/>`;
  const v = vol(kfLt(it));
  const dips = (keys || []).slice(1).map((b, i) => {
    const a = keys[i], from = Math.max(0, a[0]), to = Math.min(dur, b[0]);
    return to > from && (a[2] === 'ducked' || b[2] === 'ducked')
      ? `<rect class="duck-region" x="${from}" width="${to - from}" height="1"/>` : '';
  }).join('');
  return `<svg class="wf" viewBox="0 0 ${dur} 1" preserveAspectRatio="none">${dips}${wave}${line}</svg><div class="vl"${keys?.length ? ` data-vkf="${it.id}"` : ''} style="top:${volGripTop(v)}" title="${Math.round(v * 100)}%"></div>`;
}
function volDrag(e, it) {
  e.stopPropagation();
  const y0 = e.clientY, lt = kfLt(it), v0 = clamp(S.volumeAt(it, lt), 0, 2);
  let changed = false;
  const mv = ev => {
    if (!changed) { snapshot(); changed = true; }
    const v = Math.round(clamp(v0 + (y0 - ev.clientY) / 100, 0, 2) * 100) / 100; // 1% a pixel: the lane is too short to map its height
    if (it.kf?.volume?.length) kfSet(it, 'volume', lt, v); else it.volume = v;
    const live = $(`.clip[data-id="${it.id}"]`), h = live && live.querySelector('.wf');
    if (h) { const tmp = document.createElement('div'); tmp.innerHTML = waveHtml(it); h.replaceWith(tmp.firstChild); live.querySelector('.vl').replaceWith(tmp.firstChild); }
    toast(tr('volume') + ' ' + Math.round(v * 100) + '%');
    dirty = true; needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (changed) refresh(); }, { once: true });
}

function renderTimeline() {
  const width = (Math.max(total(), t) + 30) * pps, clips = timelineClips(), TS = shownTracks(clips);
  groupCrumb.hidden = !openGrp;
  $('#tl').classList.toggle('inside-group', !!openGrp);
  if (openGrp) {
    const html = `<button type="button">${esc(tr('mainTimeline'))}</button>${icon(LANG === 'ar' ? 'chevron-left' : 'chevron-right')}<span aria-current="location">${esc(groupInfo(openGrp).name)}</span>`;
    if (groupCrumb.innerHTML !== html) groupCrumb.innerHTML = html;
  }
  ppsVar();
  $('#rows').style.width = $('#ruler').style.width = `calc(${width / pps}px * var(--pps))`;
  $('#heads').innerHTML = TS.map(x => `<div class="head${x.locked ? ' locked' : ''}" data-track="${x.id}" title="${tr('dragTrack')}"><i style="background:${TRACK_COLOR[x.kind]}"></i><em>${esc(trackLabel(x))}</em>${laneBtns(x)}</div>`).join('');
  $('#rows').innerHTML = TS.map(x => {
    const row = clips.filter(i => i.track === x.id);
    const blocks = row.map(it => {
      const kind = it.compound ? 'group' : kindOf(it);
      const body = it.compound ? `<span>${icon('layers')}${esc(it.name)}</span>` :
        `<div class="h l"></div>${S.transIn(P, it) && !S.GLT.includes(it.trans.id) ? `<b class="trn" data-trn="${it.id}" title="${tr('tr_' + it.trans.id)}">${icon('arrow-right-left')}</b>` : ''}
        ${!media(it)?.angles && (kind === 'audio' || (it.kf?.volume?.length && hasSound(media(it)))) ? waveHtml(it) : ''}<span>${clipLabel(it)}</span>${multicamBoundaries(it)}${sceneTicks(it)}
        ${kfTimes(it).filter(x => x >= 0 && x <= it.dur).map(x => `<i class="kfd" data-kt="${x}" style="left:calc(${x}px * var(--pps))"></i>`).join('')}${pxBar(it, 'tl')}<div class="h r"></div>`;
      return `<div class="clip k-${kind}${isSel(it.id) ? ' sel' : ''}${it.hidden ? ' off' : ''}" data-id="${it.id}" style="left:calc(${it.start}px * var(--pps));width:max(4px, calc(${it.dur}px * var(--pps)))">${body}</div>`;
    }).join('');
    return `<div class="row${x.id === 'v1' ? ' main' : ''}${x.locked ? ' locked' : ''}" data-track="${x.id}">${blocks}${trBoxes(row)}</div>`;
  }).join('');
  laneGap();
  renderSilencePreview();
  renderRuler(width);
  $('#tdur').textContent = fmt(total());
  $('#tl').classList.toggle('blade', tool === 'blade');
  updatePlayhead();
}

// Drag a track header up/down to reorder tracks (layer order follows: higher = drawn on top).
$('#heads').addEventListener('click', e => {
  const b = e.target.closest('[data-lk]');
  if (!b) return;
  const x = P.tracks.find(q => q.id === b.closest('.head').dataset.track), its = laneItems(x.id), k = b.dataset.lk;
  snapshot();
  if (k === 'lock') x.locked = !x.locked || undefined;
  else { const f = k === 'hide' ? 'hidden' : 'muted', v = !its.every(i => i[f]); for (const i of its) i[f] = v || undefined; }
  dirty = true; refresh();
});
$('#heads').addEventListener('contextmenu', e => {
  const track = e.target.closest('.head')?.dataset.track;
  const clips = timelineItems().filter(it => it.track === track && isTranslatable(it));
  if (!clips.length) return;
  e.preventDefault();
  const captionTrack = track === 'c1' || P.tracks.some(x => x.id === track && x.captionLanguage);
  ctxMenu(e, [['translateCaptions', () => openCaptionTranslation(clips)],
    captionTrack && ['piperRead', () => openPiper(clips)]]);
});
$('#heads').addEventListener('pointerdown', e => {
  const h = e.target.closest('.head');
  if (!h || e.button !== 0 || e.target.closest('[data-lk]')) return;
  const id = h.dataset.track, y0 = e.clientY;
  let moved = false;
  const mv = ev => {
    if (!moved) { if (Math.abs(ev.clientY - y0) < 4) return; snapshot(); moved = true; }
    const TS = shownTracks(), r = $('#heads').getBoundingClientRect(), to = clamp(Math.floor((ev.clientY - r.top) / ROW), 0, TS.length - 1);
    const from = TS.findIndex(x => x.id === id);
    if (to === from) return;
    const tk = P.tracks.splice(P.tracks.indexOf(TS[from]), 1)[0], at = P.tracks.indexOf(TS[to]);
    P.tracks.splice(to > from ? at + 1 : at, 0, tk);
    renderTimeline(); needsDraw = true;
    $(`#heads .head[data-track="${id}"]`).classList.add('drag');
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (moved) { dirty = true; refresh(); } }, { once: true });
});
function compatible(it, trackId) {
  const x = P.tracks.find(q => q.id === trackId);
  if (!x) return false;
  if (isText(it)) return x.kind === 'text';
  const k = media(it).kind;
  return k === 'audio' ? x.kind === 'audio' : k === 'image' ? x.kind === 'video' : x.kind !== 'text';
}
const timeAt = clientX => { const sc = $('#scroll'); return (clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / pps; };
function snapPoints(exceptId) {
  const pts = [0, t, ...markerTimes()];
  for (const i of P.items) if (i.id !== exceptId) pts.push(i.start, i.start + i.dur);
  return pts;
}
function snap1(v, pts) {
  if (!snapOn) return v;
  const th = 8 / pps;
  let best = v, d = th;
  for (const p of pts) if (Math.abs(p - v) < d) { d = Math.abs(p - v); best = p; }
  return best;
}
function snapMove(start, dur, pts) {
  const left = snap1(start, pts), end = start + dur, right = snap1(end, pts);
  if (right === end || (left !== start && Math.abs(left - start) <= Math.abs(right - end))) return left;
  return right - dur;
}
function sourceBound(it) {
  const m = media(it);
  return m && m.kind !== 'image' && m.dur ? m : null;
}
// Compound members keep their offsets when an outside edit ripples a lane.
const pack = () => { if (!openGrp) packLane('v1'); };
const magLane = id => magnet && (P.tracks.find(x => x.id === id) || {}).kind !== 'text';
const byStart = (a, b) => a.start - b.start;
function laneObstacles(id, except) {
  const items = P.items.filter(i => i.track === id && !inTimeline(i) && (!except || i.grp !== except));
  const blocks = openGrp ? [] : groupBlocks().filter(i => i.track === id && i.id !== except);
  return [...items, ...blocks].sort(byStart);
}
function clearStart(at, dur, fixed) {
  for (const q of fixed) if (q.start < at + dur - 1e-6 && at < q.start + q.dur - 1e-6) at = q.start + q.dur;
  return at;
}
function packLane(id, origin) {
  if (!magLane(id)) return;
  const its = timelineItems().filter(i => i.track === id).sort(byStart), fixed = laneObstacles(id);
  let at = origin ?? (openGrp ? its[0]?.start ?? 0 : 0);
  for (const it of its) { it.start = clearStart(at, it.dur, fixed); at = it.start + it.dur; }
}
function dragProTrim(e, it, mode, edge) {
  const project = P, x0 = e.clientX, playhead = t, minDur = 1 / P.fps;
  const sourceDuration = clip => sourceBound(clip)?.dur ?? Infinity;
  if (mode === 'slip') {
    if (S.hasCurve(it)) return toast(tr('slipCurve'));
    if (!Number.isFinite(sourceDuration(it))) return;
  }
  const live = timelineItems().filter(clip => clip.track === it.track);
  const before = [...live.map(clip => ({ ...clip })), ...laneObstacles(it.track).map(clip => ({ ...clip, fixed: true }))];
  const pts = [0, t, ...markerTimes(), ...P.items.filter(clip => clip.track !== it.track).flatMap(clip => [clip.start, clip.start + clip.dur])];
  const origin = it.start + (edge === 'out' ? it.dur : 0);
  const hud = $('#trimFeedback'), rows = $('#rows');
  const showFrame = mode !== 'audio' && laneKind(it) !== 'audio';
  const { pointerId } = e;
  let last = { clips: before, delta: 0 };
  const apply = (next, previous) => live.forEach((clip, i) => {
    if (next[i] === previous[i]) return;
    for (const k of ['start', 'dur', 'in', 'curve', 'words', 'kf', 'trk']) {
      if (Object.hasOwn(next[i], k)) clip[k] = next[i][k]; else delete clip[k];
    }
  });
  const move = ev => {
    if (ev.pointerId !== pointerId || P !== project) return;
    const dx = ev.clientX - x0;
    if (hud.hidden && Math.abs(dx) < 3) return;
    const raw = dx / pps, d = mode === 'slip' || !raw ? raw : snap1(origin + raw, pts) - origin;
    const result = mode === 'slip' ? S.slipClip(before, it.id, d, sourceDuration)
      : mode === 'slide' ? S.slideClip(before, it.id, d, sourceDuration, minDur)
      : (mode === 'roll' ? S.rollEdit : mode === 'ripple' ? S.rippleTrim : S.trimAudioEdge)(before, it.id, edge, d, sourceDuration, minDur);
    if (result.delta !== last.delta) {
      if (playing) setPlaying(false);
      apply(result.clips, last.clips);
      if (showFrame) {
        const preview = mode === 'roll' ? origin + result.delta + 1e-6
          : edge === 'out' ? it.start + Math.max(0, it.dur - minDur) : it.start;
        seek(result.delta ? preview : playhead);
      }
      renderTimeline();
      needsDraw = true;
      last = result;
    }
    const delta = mode === 'slip' ? result.delta * num(it.speed, 1) : result.delta;
    hud.firstElementChild.textContent = (delta < 0 ? '−' : delta > 0 ? '+' : '') + fmt(Math.abs(delta));
    hud.lastElementChild.hidden = mode !== 'slip';
    if (mode === 'slip') {
      const start = num(it.in, 0);
      hud.lastElementChild.textContent = tr('trimSource', { in: '\u2066' + fmt(start) + '\u2069', out: '\u2066' + fmt(start + S.srcLen(it)) + '\u2069' });
    }
    hud.hidden = false;
    hud.style.left = clamp(ev.clientX + (LANG === 'ar' ? -hud.offsetWidth - 12 : 12), 6, innerWidth - hud.offsetWidth - 6) + 'px';
    hud.style.top = clamp(ev.clientY - hud.offsetHeight - 12, 6, innerHeight - hud.offsetHeight - 6) + 'px';
  };
  const finish = commit => {
    rows.removeEventListener('pointermove', move);
    rows.removeEventListener('pointerup', end);
    rows.removeEventListener('pointercancel', end);
    rows.removeEventListener('lostpointercapture', end);
    window.removeEventListener('blur', cancelProTrim);
    if (rows.hasPointerCapture(pointerId)) rows.releasePointerCapture(pointerId);
    cancelProTrim = null;
    hud.hidden = true;
    if (P !== project || !last.delta) return;
    // The undo snapshot needs the state before the drag preview.
    apply(before, last.clips);
    if (commit) { snapshot(); apply(last.clips, before); }
    if (showFrame) seek(playhead);
    refresh();
  };
  const end = ev => { if (ev.pointerId === pointerId) finish(ev.type === 'pointerup'); };
  cancelProTrim = () => finish(false);
  e.preventDefault();
  rows.setPointerCapture(pointerId);
  rows.addEventListener('pointermove', move);
  rows.addEventListener('pointerup', end);
  rows.addEventListener('pointercancel', end);
  rows.addEventListener('lostpointercapture', end);
  window.addEventListener('blur', cancelProTrim);
}
$('#rows').addEventListener('pointerdown', e => {
  if (e.button !== 0 || cancelProTrim) return;
  const c = e.target.closest('.clip');
  if (!c) { tlMarquee(e); return; }
  const it = item(c.dataset.id);
  if (e.metaKey || e.ctrlKey || e.shiftKey) { toggleSel(c.dataset.id); return; }
  if (!it) {
    if (tool !== 'select' && tool !== 'blade') return select(c.dataset.id);
    return compoundMove(e, groupBlocks().find(b => b.id === c.dataset.id));
  }
  if (tool === 'blade') { seek(snap1(timeAt(e.clientX), snapPoints(null))); select(it.id); splitAt(); return; }
  const locked = P.tracks.find(x => x.id === it.track)?.locked;
  const cut = e.target.closest('[data-mc-cut]');
  if (cut && !locked) return dragMulticamCut(e, it, +cut.dataset.mcCut);
  const mode = e.target.matches('.h.l') ? 'l' : e.target.matches('.h.r') ? 'r' : 'move';
  const edge = mode === 'l' ? 'in' : mode === 'r' ? 'out' : null;
  if (tool !== 'select' || e.altKey) {
    select(it.id);
    if (locked) return;
    const pro = e.altKey && edge && laneKind(it) === 'audio' ? 'audio'
      : tool === 'select' ? (edge ? 'roll' : 'slip') : tool;
    if (edge === null ? pro === 'slip' || pro === 'slide' : pro === 'ripple' || pro === 'roll' || pro === 'audio') dragProTrim(e, it, pro, edge);
    return;
  }
  if (msel.size > 1 && msel.has(it.id) && !e.target.classList.contains('h')) return selectedGroups().length ? compoundMove(e, it) : groupMove(e, it);
  select(it.id);
  if (locked) return;
  if (e.target.classList.contains('vl')) return volDrag(e, it);
  const x0 = e.clientX, o = JSON.parse(JSON.stringify(it)), pts = snapPoints(it.id);
  const sp = num(o.speed, 1), m = sourceBound(it);
  let changed = false;
  const onMove = ev => {
    const d = (ev.clientX - x0) / pps;
    if (!changed) { if (Math.abs(ev.clientX - x0) < 3) return; snapshot(); changed = true; }
    if (mode === 'move') {
      it.start = Math.max(0, snapMove(Math.max(0, o.start + d), o.dur, pts));
      const tk = it.track;
      dropLane(it, ev.clientY, lane);
      if (magnet) settle(it, lane);
      if (it.track === tk) { const el = $(`.clip[data-id="${it.id}"]`); if (el) { el.style.left = it.start * pps + 'px'; needsDraw = true; return; } }
    } else if (mode === 'l') {
      // a curved clip can only be shortened (its curve covers the source range it has)
      const min = S.hasCurve(o) ? o.start : m ? Math.max(0, o.start - num(o.in, 0) / sp) : 0;
      const s = clamp(snap1(o.start + d, pts), min, o.start + o.dur - 1 / P.fps), shift = s - o.start;
      it.start = s;
      it.dur = o.dur - shift;
      if (m) it.in = num(o.in, 0) + S.srcAt(o, shift);
      if (S.hasCurve(o)) it.curve = S.subCurve(o, shift, o.dur);
      if (o.words) it.words = o.words.map(w => ({ ...w, s: w.s - shift, e: w.e - shift }));
      if (o.kf || o.trk) { const c = JSON.parse(JSON.stringify(o)); S.shiftTimes(c, shift); it.kf = c.kf; it.trk = c.trk; }
    } else {
      const max = S.hasCurve(o) ? o.start + o.dur : m ? o.start + (m.dur - num(o.in, 0)) / sp : Infinity;
      it.dur = clamp(snap1(o.start + o.dur + d, pts), o.start + 1 / P.fps, max) - o.start;
      if (S.hasCurve(o)) it.curve = S.subCurve(o, 0, it.dur);
      const el = !S.hasCurve(o) && $(`.clip[data-id="${it.id}"]`);
      if (el) { el.style.width = Math.max(4, it.dur * pps) + 'px'; needsDraw = true; return; }
    }
    renderTimeline();
    needsDraw = true;
  };
  const lane = { nt: null, from: it.track, origin: openGrp ? Math.min(...timelineItems().filter(i => i.track === it.track).map(i => i.start)) : 0 };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    if (changed) { if (lane.gap != null && magLane(it.track)) it.start = lane.gap; packLane(it.track, lane.from === it.track ? lane.origin : undefined); if (lane.from !== it.track) packLane(lane.from, lane.origin); dropLaneEnd(lane); refresh(); }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
});
// Dragging a clip up/down: onto a free lane of its kind it goes there; over another kind, a busy
// spot, or above the top lane it gets a new lane of its own (made once per drag, follows the pointer).
// Captions stay on their lane, and nothing else goes onto it.
const laneKind = it => isText(it) ? 'text' : media(it).kind === 'audio' ? 'audio' : 'video';
function dropLane(it, clientY, lane) {
  if (it.track === 'c1' && !lane.nt) return;
  const TS = shownTracks(), r = $('#rows').getBoundingClientRect(), i = Math.floor((clientY - r.top) / ROW), x = TS[i], kind = laneKind(it);
  if (x && x === lane.nt) return;
  const free = x && x.id !== 'c1' && !x.locked && compatible(it, x.id) && (magLane(x.id) || x.id === it.track ||
    ![...P.items, ...(!openGrp ? groupBlocks() : [])].some(q => q !== it && q.track === x.id && q.start < it.start + it.dur - 1e-6 && it.start < q.start + q.dur - 1e-6));
  if (free) { it.track = x.id; return; }
  if (i >= TS.length && kind !== 'audio') return; // below the last lane: only sounds get a new lane there
  if (lane.nt) { P.tracks.splice(P.tracks.indexOf(lane.nt), 1); TS.splice(TS.indexOf(lane.nt), 1); }
  else { lane.nt = { id: kind[0] + uid(), kind }; laneKeep.add(lane.nt.id); }
  const before = TS[Math.max(0, i)];
  P.tracks.splice(i >= TS.length || !before ? P.tracks.length : P.tracks.indexOf(before), 0, lane.nt);
  it.track = lane.nt.id;
  renderTimeline();
}
// Magnet on: on the main lane the other clips close up around a gap where the dragged clip will land;
// on other lanes the clip stops against its neighbour instead of sliding over it.
function settle(it, lane, clearGroup) {
  lane.gap = null;
  const fixed = laneObstacles(it.track, it.compound ? it.id : undefined);
  const others = timelineItems().filter(q => q !== it && q.track === it.track).sort(byStart);
  if (clearGroup && (!others.length || !magLane(it.track))) {
    it.start = clearGroup(it.start, [...others, ...fixed].sort(byStart));
    return;
  }
  if (magLane(it.track)) {
    const idx = others.filter(q => q.start + q.dur / 2 < it.start).length;
    const row = [...others.slice(0, idx), it, ...others.slice(idx)];
    let at = openGrp && lane.from !== it.track ? Math.min(it.start, others[0]?.start ?? it.start) : lane.origin;
    for (const q of row) {
      const start = q === it && clearGroup ? clearGroup(at, fixed) : clearStart(at, q.dur, fixed);
      if (q === it) lane.gap = start;
      else if (q.start !== start) {
        q.start = start;
        const el = $(`.clip[data-id="${q.id}"]`);
        if (el) el.style.left = start * pps + 'px';
      }
      at = start + q.dur;
    }
    return;
  }
  const occupied = [...others, ...fixed].sort(byStart);
  for (let k = 0; k < 4; k++) {
    const q = occupied.find(q => q.start < it.start + it.dur - 1e-6 && it.start < q.start + q.dur - 1e-6);
    if (!q) return;
    it.start = it.start + it.dur / 2 < q.start + q.dur / 2 && q.start >= it.dur ? q.start - it.dur : q.start + q.dur;
  }
}
function compoundMove(e, lead) {
  if (!lead) return;
  if (!isSel(lead.id)) select(lead.id);
  const its = selectedItems(), tracks = new Set(its.map(i => i.track));
  if (P.tracks.some(x => x.locked && tracks.has(x.id)) || tool === 'blade') { select(lead.id); return; }
  const saved = new Map(its.map(i => [i, i.start])), start = S.groupSpan(its).start;
  const ids = new Set(its.map(i => i.id));
  const outside = P.items.filter(i => !ids.has(i.id));
  const pts = [0, t, ...markerTimes(), ...outside.flatMap(i => [i.start, i.start + i.dur])];
  const blocks = timelineClips().filter(i => isSel(i.id)), x0 = e.clientX, start0 = lead.start;
  const lane = { origin: 0 };
  const otherLanes = its.filter(i => i.track !== lead.track).map(i => ({
    offset: i.start - start0, dur: i.dur, fixed: outside.filter(q => q.track === i.track).sort(byStart),
  }));
  // A gap must fit the block and every member on its original track.
  const clearGroup = (at, fixed) => {
    let next = at;
    do {
      at = next;
      next = clearStart(at, lead.dur, fixed);
      for (const i of otherLanes) next = Math.max(next, clearStart(at + i.offset, i.dur, i.fixed) - i.offset);
    } while (next > at + 1e-6);
    return next;
  };
  let changed = false;
  const mv = ev => {
    if (!changed) { if (Math.abs(ev.clientX - x0) < 3) return; snapshot(); changed = true; }
    const s = snapMove(start0 + (ev.clientX - x0) / pps, lead.dur, pts);
    let d = Math.max(-start, s - start0);
    if (magnet && blocks.length === 1) {
      const block = { ...lead, start: start0 + d };
      settle(block, lane, clearGroup);
      d = (lane.gap ?? block.start) - start0;
    }
    for (const [i, at] of saved) i.start = at + d;
    for (const block of blocks) {
      const el = $(`.clip[data-id="${block.id}"]`);
      if (el) el.style.left = ((saved.get(block) ?? block.start) + d) * pps + 'px';
    }
    needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (changed) refresh(); else select(lead.id); }, { once: true });
}
// After the drag: lanes left empty by it go away (the built-in ones stay).
function dropLaneEnd(lane) {
  if (lane.nt) laneKeep.delete(lane.nt.id);
  const keep = new Set(['c1', 't1', 'v1', 'v2', 'a1', 'a2']);
  P.tracks = P.tracks.filter(x => keep.has(x.id) || (x !== lane.nt && x.id !== lane.from) || P.items.some(i => i.track === x.id));
}
// Several clips selected: drag one and they all move together, in time and across lanes.
function groupMove(e, lead) {
  if (sel !== lead.id) { sel = lead.id; inspTab = null; inspector(); paintSel(); }
  const group = selIds().map(item).filter(Boolean), o = new Map(group.map(i => [i.id, i.start])), x0 = e.clientX, y0 = e.clientY;
  const minStart = Math.min(...group.map(i => i.start)), ids = new Set(group.map(i => i.id));
  const others = [...P.items, ...(!openGrp ? groupBlocks() : [])].filter(i => !ids.has(i.id));
  const spts = [0, t, ...markerTimes(), ...others.flatMap(i => [i.start, i.start + i.dur])];
  const TS = shownTracks(), row0 = new Map(group.map(i => [i.id, TS.findIndex(x => x.id === i.track)]));
  const pinned = TS.filter(x => !laneKeep.has(x.id)).map(x => x.id); // lanes keep their rows while dragging
  pinned.forEach(id => laneKeep.add(id));
  let changed = false, dr = 0;
  // the whole group moves up/down by whole lanes, only where every clip fits (same kind, free spot, not captions or locked)
  const fits = k => group.every(i => {
    const x = TS[row0.get(i.id) + k];
    return x && (i.track === 'c1' ? k === 0 : x.id !== 'c1') && !x.locked && compatible(i, x.id) &&
      !others.some(q => q.track === x.id && q.start < i.start + i.dur - 1e-6 && i.start < q.start + q.dur - 1e-6);
  });
  const mv = ev => {
    if (!changed) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return; snapshot(); changed = true; }
    const start = o.get(lead.id), s = snapMove(start + (ev.clientX - x0) / pps, lead.dur, spts);
    const d = Math.max(s - start, -minStart);
    for (const i of group) i.start = o.get(i.id) + d;
    const k = Math.round((ev.clientY - y0) / ROW);
    if (k !== dr && fits(k)) dr = k;
    else if (!fits(dr)) dr = fits(0) ? 0 : dr;
    let moved = false;
    for (const i of group) { const id = TS[row0.get(i.id) + dr].id; if (i.track !== id) { i.track = id; moved = true; } }
    if (moved) renderTimeline();
    else for (const i of group) { const el = $(`.clip[data-id="${i.id}"]`); if (el) el.style.left = i.start * pps + 'px'; }
    needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); pinned.forEach(id => laneKeep.delete(id)); if (changed) { if (group.some(i => i.track === 'v1' || TS[row0.get(i.id)]?.id === 'v1')) pack(); refresh(); } else select(lead.id); }, { once: true }); // plain click picks just this clip
}
$('#rows').addEventListener('pointermove', e => {
  let bl = $('.bladeline');
  if (tool !== 'blade' || !e.target.closest('.clip:not(.k-group)')) { if (bl) bl.remove(); return; }
  if (!bl) { bl = document.createElement('div'); bl.className = 'bladeline'; $('#scroll').appendChild(bl); }
  bl.style.left = timeAt(e.clientX) * pps + 'px';
});

// Dragging the playhead pauses playback (players only show frames, one jump at a time) and resumes on release.
let scrubbing = false;
function scrubFrom(e) {
  const at = ev => { seek(timeAt(ev.clientX)); if ((t + 10) * pps > $('#rows').offsetWidth) renderTimeline(); };
  const was = playing;
  scrubbing = true;
  if (was) setPlaying(false);
  at(e);
  const mv = ev => at(ev);
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); scrubbing = false; needsDraw = true; if (was) setPlaying(true); }, { once: true });
}
$('#ruler').addEventListener('pointerdown', e => {
  focusZone = 'tl';
  if (e.button === 0 && !e.target.closest('.mk')) scrubFrom(e);
});
$('#ruler').addEventListener('click', e => {
  const mk = e.target.closest('.mk');
  if (mk) seekMarker(P.markers[+mk.dataset.mk]);
});
$('#ruler').addEventListener('dblclick', e => {
  const mk = e.target.closest('.mk');
  if (mk) editMarker(P.markers[+mk.dataset.mk], mk);
});
$('#ruler').addEventListener('contextmenu', e => {
  const mk = e.target.closest('.mk');
  if (!mk) return;
  e.preventDefault();
  const m = P.markers[+mk.dataset.mk];
  ctxMenu(e, [['editMarker', () => editMarker(m, mk)], ['del', () => deleteMarker(m), 'danger']]);
});

const rulerStep = () => [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find(s => s * pps >= 70) || 300;
function renderRuler(width) {
  const step = renderRuler.step = rulerStep();
  let ticks = '';
  for (let s = 0; s * pps < width; s += step) ticks += `<div class="tick" style="left:calc(${s}px * var(--pps))">${fmt(s).replace(/:00$/, '')}</div>`;
  ticks += P.markers.map((m, i) => `<button type="button" class="mk" data-mk="${i}" title="${esc(markerName(m))}" aria-label="${esc(markerName(m))}" style="left:calc(${m.time}px * var(--pps));--marker-color:${markerColor(m.color)}"></button>`).join('');
  $('#ruler').innerHTML = ticks;
}
// One variable carries the zoom: every clip, tick and keyframe is placed as seconds x --pps.
const ppsVar = () => { $('#rows').style.setProperty('--pps', pps); $('#ruler').style.setProperty('--pps', pps); };
// Zoom writes one CSS variable; the ruler is rebuilt only when its tick spacing changes.
function setZoom(v) {
  const zoom = $('#zoom');
  pps = clamp(v, 8, 400);
  zoom.value = pps;
  paintRange(zoom);
  ppsVar();
  if (rulerStep() !== renderRuler.step) renderRuler((Math.max(total(), t) + 30) * pps);
  updatePlayhead();
}
$('#zoom').addEventListener('input', e => setZoom(+e.target.value));
const zoomQ = { k: 1, x: 0, raf: 0 };
$('#scroll').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomQ.k *= Math.exp(-clamp(e.deltaY, -60, 60) * 0.012); // trackpad pinch sends small deltas, mouse wheel big ones
  zoomQ.x = e.clientX;
  if (zoomQ.raf) return;
  zoomQ.raf = requestAnimationFrame(() => {
    const sc = $('#scroll'), ax = zoomQ.x - sc.getBoundingClientRect().left, at = (ax + sc.scrollLeft) / pps;
    setZoom(pps * zoomQ.k);
    sc.scrollLeft = at * pps - ax; // keep the moment under the pointer still
    zoomQ.k = 1; zoomQ.raf = 0;
  });
}, { passive: false });
// The playhead line itself can be grabbed anywhere along its height.
$('#ph').addEventListener('pointerdown', e => { if (e.button === 0) { e.stopPropagation(); scrubFrom(e); } });
// Keyframe diamonds on a clip: drag sideways to move that keyframe (all properties keyed there), click to jump to it.
$('#rows').addEventListener('pointerdown', e => {
  const d = e.target.closest('.kfd');
  if (!d || e.button !== 0) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const it = item(d.closest('.clip').dataset.id), kt = +d.dataset.kt, x0 = e.clientX;
  if (sel !== it.id) select(it.id);
  let moved = false, cur = kt;
  const same = q => Math.abs(q[0] - cur) < 1e-4;
  const mv = ev => {
    if (!moved) { if (Math.abs(ev.clientX - x0) < 3) return; snapshot(); moved = true; }
    const nt = +clamp(Math.round((kt + (ev.clientX - x0) / pps) * P.fps) / P.fps, 0, it.dur).toFixed(4);
    for (const k of Object.keys(it.kf || {})) { for (const q of it.kf[k]) if (same(q)) q[0] = nt; it.kf[k].sort((a, b) => a[0] - b[0]); }
    cur = nt; d.style.left = nt * pps + 'px'; needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (moved) { dirty = true; refresh(); } else seek(it.start + kt); }, { once: true });
}, true);

/* ---------- edits ---------- */
const selIds = () => msel.size ? [...msel] : sel ? [sel] : [];
const isSel = id => id === sel || msel.has(id);
function paintSel() { $$('.clip').forEach(c => c.classList.toggle('sel', isSel(c.dataset.id))); renderSilencePreview(); needsDraw = true; }
function select(id) {
  const had = msel.size;
  msel.clear();
  if (sel === id) { if (had) paintSel(); return; }
  sel = id;
  if (objectDraft && objectDraft.id !== id) stopObjectEdit();
  paintSel();
  inspTab = null;
  inspector();
  if (panelVisible('filters') || panelVisible('effects')) renderLookCards();
}
// Cmd/Ctrl/Shift-click adds or removes a clip from the selection.
function toggleSel(id) {
  if (!msel.size && sel) msel.add(sel);
  if (msel.has(id)) msel.delete(id); else msel.add(id);
  const prev = sel;
  sel = msel.has(id) ? id : [...msel].pop() || null;
  if (msel.size < 2) msel.clear();
  paintSel();
  if (sel !== prev) { inspTab = null; inspector(); }
}
// Drag on an empty part of the timeline: rubber-band select. A plain click still moves the playhead.
function tlMarquee(e) {
  const rows = $('#rows'), sc = $('#scroll'), x0 = e.clientX, y0 = e.clientY, keep = e.metaKey || e.ctrlKey || e.shiftKey, base = new Set(keep ? selIds() : []);
  let box = null;
  const mv = ev => {
    if (!box) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return; box = sc.appendChild(Object.assign(document.createElement('div'), { className: 'marq' })); }
    const l = Math.min(x0, ev.clientX), r = Math.max(x0, ev.clientX), tp = Math.min(y0, ev.clientY), b = Math.max(y0, ev.clientY), R = sc.getBoundingClientRect();
    Object.assign(box.style, { left: l - R.left + sc.scrollLeft + 'px', top: tp - R.top + sc.scrollTop + 'px', width: r - l + 'px', height: b - tp + 'px' });
    const ids = new Set(base);
    for (const c of rows.querySelectorAll('.clip')) { const q = c.getBoundingClientRect(); if (q.right > l && q.left < r && q.bottom > tp && q.top < b) ids.add(c.dataset.id); }
    msel.clear();
    if (ids.size > 1) ids.forEach(x => msel.add(x));
    const nsel = ids.has(sel) ? sel : [...ids][0] || null;
    if (nsel !== sel) { sel = nsel; inspTab = null; inspector(); }
    paintSel();
  };
  const up = ev => {
    window.removeEventListener('pointermove', mv);
    if (box) box.parentNode.removeChild(box);
    else { select(null); seek(timeAt(ev.clientX)); }
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up, { once: true });
}

function addMedia(mid, trackId, start, extra, joinStep) {
  const m = P.media[mid];
  const probe = { media: mid };
  if (!trackId || !compatible(probe, trackId)) trackId = m.kind === 'audio' ? 'a1' : 'v1';
  if (start == null) {
    const row = openGrp ? timelineItems() : [...P.items, ...groupBlocks()];
    start = row.filter(i => i.track === trackId).reduce((a, i) => Math.max(a, i.start + i.dur), openGrp ? S.groupSpan(row).start : 0);
  }
  if (!joinStep) snapshot();
  const it = { id: uid(), track: trackId, media: mid, start, dur: m.kind === 'image' ? 5 : m.dur, in: 0, speed: 1, volume: 1 };
  if (m.angles) it.cuts = [{ t: 0, angle: m.defaultAngle }];
  if (m.kind !== 'audio') Object.assign(it, { fit: 'contain', scale: 1, x: 0, y: 0, opacity: 1, preset: 'none', brightness: 1, contrast: 1, saturation: 1, temp: 0 });
  Object.assign(it, extra);
  addTimelineItem(it);
  if (it.track === 'v1') pack();
  setSelection([it.id]);
  refresh();
  return it;
}

// Where a new text goes: at the playhead on the lowest text lane that is free there; if every text lane
// is busy, on a new lane above them (CapCut-style stacking). Drag texts side by side to share a lane.
function textSlot(dur) {
  const lanes = P.tracks.filter(x => x.kind === 'text' && x.id !== 'c1');
  const free = x => !P.items.some(i => i.track === x.id && i.start < t + dur - 1e-6 && t < i.start + i.dur - 1e-6);
  let x = [...lanes].reverse().find(free);
  if (!x) { x = { id: 't' + uid(), kind: 'text' }; P.tracks.splice(lanes.length ? P.tracks.indexOf(lanes[0]) : 0, 0, x); }
  return { track: x.id, start: t };
}
function addText(styleId) {
  snapshot();
  const st = presetStyle(styleId);
  const it = { id: uid(), type: 'text', ...textSlot(3), dur: 3, text: tr('defaultText'), style: st, x: 0.5, y: 0.5, anim: 'pop', out: 'fade' };
  addTimelineItem(it);
  setSelection([it.id]);
  refresh();
}

function targetsAtPlayhead() {
  const ss = selIds().map(item).filter(i => i && active(i, t)); // every selected layer under the playhead
  return ss.length ? ss : selectedGroups().length ? [] : timelineItems().filter(i => active(i, t));
}
function splitAt(all) {
  const min = 1 / P.fps;
  const ok = (all ? timelineItems().filter(i => active(i, t)) : targetsAtPlayhead()).filter(it => t - it.start > min && it.start + it.dur - t > min);
  if (!ok.length) return toast(tr('cutHint'));
  snapshot();
  splitItems(ok);
  if (ok.some(i => i.track === 'v1')) pack();
  refresh();
}
function splitItems(ok, at = t) {
  for (const it of ok) {
    const cut = at - it.start, b = JSON.parse(JSON.stringify(it));
    b.id = uid(); b.start = at; b.dur = it.dur - cut; b.fadeIn = 0;
    S.shiftTimes(b, cut);
    if (sourceBound(it)) b.in = num(it.in, 0) + S.srcAt(it, cut);
    if (S.hasCurve(it)) { b.curve = S.subCurve(it, cut, it.dur); it.curve = S.subCurve(it, 0, cut); }
    it.dur = cut; it.fadeOut = 0;
    S.trimTranscript(it); S.trimTranscript(b);
    if (it.words) {
      const w = it.words;
      it.words = w.filter(x => x.s < cut);
      b.words = w.filter(x => x.s >= cut).map(x => ({ ...x, s: x.s - cut, e: x.e - cut }));
      it.text = it.words.map(x => x.w).join(' ');
      b.text = b.words.map(x => x.w).join(' ');
    }
    P.items.push(b);
  }
}
// Q / W: drop the part of the clip before / after the playhead.
function trimTo(side) {
  const min = 1 / P.fps;
  const ok = targetsAtPlayhead().filter(it => t - it.start > min && it.start + it.dur - t > min);
  if (!ok.length) return toast(tr('cutHint'));
  snapshot();
  for (const it of ok) {
    const cut = t - it.start;
    if (side === 'right') { if (S.hasCurve(it)) it.curve = S.subCurve(it, 0, cut); it.dur = cut; continue; }
    if (sourceBound(it)) it.in = num(it.in, 0) + S.srcAt(it, cut);
    if (S.hasCurve(it)) it.curve = S.subCurve(it, cut, it.dur);
    if (it.words) it.words = it.words.filter(x => x.s >= cut).map(x => ({ ...x, s: x.s - cut, e: x.e - cut }));
    S.shiftTimes(it, cut);
    it.start = t;
    it.dur -= cut;
  }
  if (magnet && !openGrp && ok.some(i => i.track === 'v1')) { pack(); const s = item(sel); if (s && side === 'left') seek(s.start); }
  refresh();
}
const selectedGroups = () => openGrp ? [] : selIds().filter(groupInfo);
const canGroup = () => !openGrp && selIds().length >= 2 && !selectedGroups().length;
const selectedItems = () => {
  const ids = new Set(selIds()), groups = new Set(selectedGroups());
  return P.items.filter(i => ids.has(i.id) || groups.has(i.grp));
};
function groupSel() {
  if (!canGroup()) return;
  const its = selectedItems(), names = new Set(Object.values(P.groups).map(g => g.name));
  let n = 1;
  while (names.has(tr('groupName', { n }))) n++;
  snapshot();
  const id = 'g' + uid();
  P.groups[id] = { name: tr('groupName', { n }) };
  for (const i of its) i.grp = id;
  setSelection([id]);
  refresh();
}
function ungroupSel() {
  const ids = new Set(selectedGroups());
  if (!ids.size) return;
  snapshot();
  const members = [];
  for (const it of P.items) if (ids.has(it.grp)) { delete it.grp; members.push(it.id); }
  for (const id of ids) delete P.groups[id];
  setSelection([...selIds().filter(id => !ids.has(id)), ...members]);
  refresh();
}
async function renameGroup(id) {
  const group = groupInfo(id), name = await askText(tr('rename'), group.name);
  if (!name || name === group.name || group !== groupInfo(id)) return;
  snapshot();
  group.name = name;
  refresh();
}
function setSelection(ids) {
  sel = ids[0] || null; msel.clear(); inspTab = null;
  if (ids.length > 1) ids.forEach(id => msel.add(id));
}
function removeSel() {
  const its = new Set(selectedItems());
  if (!its.size) return;
  const compound = selectedGroups().length;
  snapshot();
  P.items = P.items.filter(i => !its.has(i));
  setSelection([]);
  if (!compound && !openGrp && [...its].some(i => i.track === 'v1')) pack();
  refresh();
}
const MARKER_COLORS = { accent: 'var(--accent)', red: '#ef7076', orange: '#f4a85d', green: '#77c88d', blue: '#69a8ea', purple: '#b795ed' };
const markerColor = color => Object.hasOwn(MARKER_COLORS, color) ? MARKER_COLORS[color] : MARKER_COLORS.accent;
const markerName = m => m.name || tr('marker');
const markerAt = time => Number.isFinite(time) ? P.markers.find(m => Math.abs(m.time - time) <= 1e-3) : undefined;
const chapters = () => S.youtubeChapters(P.markers, total(), tr('chapterIntro'), tr('marker'));
function seekMarker(m) {
  setPlaying(false);
  seek(m.time);
  follow();
}
function addMarker() {
  if (markerAt(t)) return;
  snapshot();
  P.markers.push({ time: t, name: '', note: '', color: 'accent' });
  P.markers.sort((a, b) => a.time - b.time);
  refresh();
}
function deleteMarker(m) {
  const i = P.markers.indexOf(m);
  if (i < 0) return;
  snapshot();
  P.markers.splice(i, 1);
  refresh();
}
const markerEditor = $('#markerEditor');
function closeMarkerEditor() { markerEditor.hidden = true; }
function editMarker(m, anchor) {
  if (!P.markers.includes(m)) return;
  markerEditor.innerHTML = `<b id="markerEditorTitle">${tr('editMarker')}</b>
    <label class="f"><span>${tr('np_name')}</span><input name="title" dir="auto" maxlength="80" value="${esc(m.name)}" placeholder="${esc(tr('marker'))}"></label>
    <label class="f"><span>${tr('markerNote')}</span><textarea name="note" dir="auto" rows="3">${esc('\n' + m.note)}</textarea></label>
    <fieldset><legend>${tr('color')}</legend><div class="marker-swatches">${Object.entries(MARKER_COLORS).map(([color, paint]) => {
      const label = tr('markerColor_' + color);
      return `<label title="${esc(label)}"><input type="radio" name="color" value="${color}" aria-label="${esc(label)}"${paint === markerColor(m.color) ? ' checked' : ''}><i style="--marker-color:${paint}"></i></label>`;
    }).join('')}</div></fieldset>
    <div class="acts"><button type="button" id="markerCancel">${tr('cancel')}</button><button class="primary">${tr('save')}</button></div>`;
  markerEditor.hidden = false;
  const a = anchor.getBoundingClientRect(), r = markerEditor.getBoundingClientRect();
  const x = LANG === 'ar' ? a.right - r.width : a.left;
  markerEditor.style.left = clamp(x, 6, innerWidth - r.width - 6) + 'px';
  markerEditor.style.top = (a.bottom + r.height + 12 <= innerHeight ? a.bottom + 6 : Math.max(6, a.top - r.height - 6)) + 'px';
  const title = markerEditor.elements.namedItem('title');
  title.focus();
  title.select();
  const dismiss = () => { closeMarkerEditor(); anchor.focus({ preventScroll: true }); };
  $('#markerCancel').onclick = dismiss;
  markerEditor.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } };
  markerEditor.onsubmit = e => {
    e.preventDefault();
    const name = S.markerTitle(title.value), note = markerEditor.elements.note.value, color = markerEditor.elements.color.value;
    dismiss();
    if (name === m.name && note === m.note && color === m.color) return;
    snapshot();
    Object.assign(m, { name, note, color });
    refresh();
    $(`#ruler [data-mk="${P.markers.indexOf(m)}"]`)?.focus({ preventScroll: true });
  };
}
window.addEventListener('pointerdown', e => { if (!markerEditor.hidden && !markerEditor.contains(e.target)) closeMarkerEditor(); });
function renderMarkers() {
  $('#markerList').innerHTML = P.markers.map((m, i) =>
    `<div class="marker-row"><button type="button" data-seek-marker="${i}" title="${esc(markerName(m))}">
      <bdi class="tc">${fmt(m.time)}</bdi><i class="marker-dot" style="--marker-color:${markerColor(m.color)}"></i><bdi>${esc(markerName(m))}</bdi>
    </button><button type="button" class="ib danger" data-delete-marker="${i}" title="${tr('del')}" aria-label="${tr('del')}: ${esc(markerName(m))}">${icon('trash-2')}</button></div>`).join('');
  const warning = $('#chapterWarning');
  warning.hidden = chapters().valid;
  warning.textContent = tr('chapterWarning');
}
$('#markerList').onclick = e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.seekMarker != null) seekMarker(P.markers[+button.dataset.seekMarker]);
  else deleteMarker(P.markers[+button.dataset.deleteMarker]);
};
async function copyChapters() {
  const { text } = chapters();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.body.appendChild(document.createElement('textarea'));
      field.value = text;
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      field.select();
      try { if (!document.execCommand('copy')) throw new Error(tr('chapterCopyFailed')); }
      finally { field.remove(); $('#copyChapters').focus(); }
    }
    toast(tr('chaptersCopied'));
  } catch { toast(tr('chapterCopyFailed')); }
}
async function saveChapters() {
  const { text } = chapters();
  try {
    const path = await TA.dialog.save({ defaultPath: tr('chapterFilename') + '.txt', filters: [{ name: 'TXT', extensions: ['txt'] }] });
    if (!path) return;
    await inv('save_chapters', { path: /\.txt$/i.test(path) ? path : path + '.txt', text });
    toast(tr('chaptersSaved'));
  } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
}
$('#copyChapters').onclick = copyChapters;
$('#saveChapters').onclick = saveChapters;
const visualSel = () => selIds().map(item).filter(it => it && !isText(it) && media(it).kind !== 'audio');
function mirrorSel() {
  const its = visualSel();
  if (!its.length) return;
  snapshot();
  for (const it of its) it.flipH = !it.flipH;
  refresh();
}

let binSig = '';
function refresh() {
  if (depthTask && (depthTask.project !== P || item(depthTask.item.id) !== depthTask.item)) stopDepth(depthTask);
  if (depthPicker && (depthPicker.project !== P || item(sel) !== depthPicker.item || depthPicker.item.hidden)) endDepthPick();
  if (upscaleTask?.item && (upscaleTask.project !== P || item(upscaleTask.item.id) !== upscaleTask.item)) stopUpscale(upscaleTask);
  closeMarkerEditor();
  if (MEDIA_BASE) ensureFonts();
  P.groups ??= {};
  const used = new Set(P.items.map(i => i.grp));
  for (const id of Object.keys(P.groups)) if (!used.has(id)) delete P.groups[id];
  if (openGrp && !groupInfo(openGrp)) openGrp = null;
  const visible = new Set(timelineClips().map(i => i.id));
  if (selIds().some(id => !visible.has(id))) setSelection(selIds().filter(id => visible.has(id)));
  for (const [k, m] of Object.entries(P.media)) if ((m.fill || m.adj) && !P.items.some(i => i.media === k)) delete P.media[k];
  // library redraws only when its files or their "in use" marks change (thumbnails are <video> elements)
  const sig = Object.keys(P.media).join() + '|' + [...new Set(P.items.map(i => i.media))].join();
  if (sig !== binSig) { binSig = sig; renderBin(); }
  renderTimeline();
  renderMarkers();
  inspector();
  if (panelVisible('transcript')) renderTranscript();
  gcEls();
  needsDraw = true;
  const name = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/, '') : P.name || tr('untitled');
  $('#pname').textContent = name + (dirty ? ' •' : '');
  $('#bUndo').disabled = !undoStack.length;
  $('#bRedo').disabled = !redoStack.length;
}

/* ---------- inspector ---------- */
const getPath = (o, k) => k.split('.').reduce((a, x) => (a == null ? a : a[x]), o);
function setPath(o, k, v) { const ks = k.split('.'); const last = ks.pop(); ks.reduce((a, x) => (a[x] ??= {}), o)[last] = v; }
// Every slider has a number box beside it, in the unit people read (percent, degrees, seconds).
const PCT = /volume|opacity|bgAlpha|crop\.|logo\.|Mix$|lut\.mix|fill\.(a1|a2|mid)/;
const unitOf = k => /Dur$|^(fadeIn|fadeOut|afIn|afOut|duck\.(attack|release))$/.test(k) ? 's' : k === 'duck.amount' ? 'dB' : k === 'rotate' ? '°' : PCT.test(k) ? '%' : '';
const dispVal = (k, v) => PCT.test(k) ? Math.round(v * 100) : /size|strokeW|spacing|Blur|Dist|glowSize|rotate/.test(k) ? Math.round(v) : +(+v).toFixed(2);
function setShow(k, v) {
  const nb = document.querySelector(`#inspBody [data-num="${k}"]`);
  if (nb && document.activeElement !== nb) nb.value = dispVal(k, v);
}

const fld = {
  range: (k, label, min, max, step, it, d = 0) =>
    `<div class="f"><div class="lb"><span>${tr(label)}</span></div><div class="spd"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${num(getPath(it, k), d)}"><span class="nbx"><input type="number" data-num="${k}" step="any" value="${dispVal(k, num(getPath(it, k), d))}"><i>${unitOf(k)}</i></span></div></div>`,
  number: (k, label, step, it) =>
    `<div class="f"><div class="lb"><span>${tr(label)}</span></div><input type="number" data-k="${k}" step="${step}" value="${+num(getPath(it, k), 0).toFixed(3)}"></div>`,
  select: (k, label, opts, it) =>
    `<div class="f"><div class="lb"><span>${tr(label)}</span></div><select data-k="${k}">${opts.map(([v, n]) => `<option value="${esc(v)}"${String(getPath(it, k)) === String(v) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`,
  color: (k, label, it) => `<label>${tr(label)}<input type="color" data-k="${k}" value="${esc(getPath(it, k))}"></label>`,
  check: (k, label, it) => `<label><input type="checkbox" data-k="${k}"${getPath(it, k) ? ' checked' : ''}>${tr(label)}</label>`,
};
const grp = (title, body) => `<div class="grp"><div class="gh">${tr(title)}</div>${body}</div>`;

// Built-in tracks have their own names; extra video tracks (added for effect layers) are "Video N", counted from the bottom.
function trackLabel(x) {
  if (x.captionLanguage === 'ar') return tr('subtitleTrackAr');
  if (x.captionLanguage === 'en') return tr('subtitleTrackEn');
  const k = 'tr_' + x.id;
  if (tr(k) !== k) return tr(k);
  const vs = P.tracks.filter(y => y.kind === x.kind && y.id !== 'c1');
  if (x.kind === 'audio') return tr('audioN', { n: vs.indexOf(x) + 1 }); // sounds count down from the top
  return tr(x.kind === 'text' ? 'textN' : 'videoN', { n: vs.reverse().indexOf(x) + 1 });
}
function duckFields(it) {
  const form = { duck: { ...S.DUCK_DEFAULTS, ...it.duck } }, busy = duckBusy.has(it);
  const tracks = P.tracks.filter(x => x.kind !== 'text').map(x => [x.id, trackLabel(x)]);
  return grp('duckSec', `<div class="inl">${fld.check('duck.on', 'duckOn', form)}</div>` + (form.duck.on ?
    fld.range('duck.amount', 'duckAmount', -30, -3, 1, form) +
    `<div class="row2">${fld.range('duck.attack', 'duckAttack', 0.01, 5, 0.01, form)}${fld.range('duck.release', 'duckRelease', 0.01, 5, 0.01, form)}</div>` +
    fld.select('duck.source', 'duckSource', [['', tr('duckAll')], ...tracks], form) +
    `<button class="wide" id="duckGo"${busy ? ' disabled' : ''}>${icon('volume-2')}${tr(busy ? 'duckWork' : 'duckGo')}</button>` : ''));
}
function voiceCleanFields(it) {
  if (!hasSound(media(it))) return '';
  const voice = S.voiceSettings(it.voiceClean);
  return `<div class="inl"><label><input type="checkbox" role="switch" data-voice="on"${voice.on ? ' checked' : ''}>${tr('voiceClean')}</label></div>
    <p class="hint">${tr('voiceHint')}</p>` + (voice.on ? `
    <label class="f"><span>${tr('voiceStrength')}</span>
      <select data-voice="strength">
        ${[[12, 'voiceLight'], [24, 'voiceMedium'], [100, 'voiceStrong']].map(([db, label]) =>
          `<option value="${db}"${db === voice.strength ? ' selected' : ''}>${tr(label)}</option>`).join('')}
      </select>
    </label>
    <label class="f"><span class="lb">${tr('voiceRoom')} <output>${voice.room}%</output></span>
      <input type="range" min="0" max="30" step="1" value="${voice.room}" data-voice="room">
    </label>
    <div data-voice-status>${voiceCleanStatus(it)}</div>` : '');
}
function voiceCleanStatus(it) {
  const id = fxId(it), state = voiceJobs.get(id), error = voiceErrors.get(id);
  const transfer = aiTransfers.get('voice_clean_dl');
  const button = (action, label) => `<button type="button" class="ghost" data-voice-action="${action}">${tr(label)}</button>`;
  const bar = p => `<div class="pxb insp" style="--p:${p}" role="progressbar" aria-label="${tr('voiceClean')}" aria-valuenow="${Math.round(p * 100)}"><i></i><em>${tr('voiceProgress', { p: Math.round(p * 100) })}</em></div>`;
  if (state) return bar(state.p) + button('cancel', 'cancel');
  if (!error) return '';
  if (error === 'voice_clean_missing' && transfer?.action === 'download')
    return `<p class="hint">${tr('aiDownloading', { p: Math.round(transfer.p * 100) })}</p>` + button('stop-download', 'cancel');
  const ready = aiReady.get(voiceCleanModel.key());
  if (error === 'voice_clean_missing' && ready === null) return `<p class="hint">${tr('aiUnavailable')}</p>`;
  if (error === 'voice_clean_missing' && !ready)
    return `<p class="hint">${tr('voiceMissing')}</p>` + button('download', 'aiDownload');
  const label = error === 'cancelled' ? tr('cancelled') : voiceError(error);
  return `<p class="hint">${esc(label)}</p>` + button('retry', 'voiceRetry');
}
function paintVoiceClean() {
  const body = $('#inspBody [data-voice-status]'), it = sel && item(sel);
  if (body && it && hasSound(media(it)) && it.voiceClean?.on) {
    const html = voiceCleanStatus(it);
    if (body._voiceStatus !== html) {
      body._voiceStatus = html;
      const action = document.activeElement?.dataset.voiceAction;
      body.innerHTML = html;
      if (action) body.querySelector(`[data-voice-action="${action}"]`)?.focus({ preventScroll: true });
    }
  }
}
function tryVoiceClean(it) {
  ensureDn(it).catch(() => {}); // the inspector shows the error and its retry action
}

function inspTabsFor(it) {
  if (!it) return [];
  if (isText(it)) return ['tText', 'tTpl', 'tAnim'];
  const k = media(it).kind;
  if (media(it).angles) return [];
  if (media(it).adj) return ['tVideo', 'tAdjust'];
  return k === 'audio' ? ['tAudio', 'tSpeed'] : k === 'image' ? ['tVideo', 'tAnim', 'tAdjust'] : ['tVideo', 'tAudio', 'tSpeed', 'tAnim', 'tAdjust'];
}

/* ---------- keyframes ---------- */
const KF_DEF = it => ({ x: isText(it) ? 0.5 : 0, y: isText(it) ? 0.5 : 0, scale: 1, rotate: 0, opacity: 1, volume: 1 });
const kfLt = it => clamp(t - it.start, 0, it.dur);
const kfTol = () => 0.5 / P.fps;
const kfTimes = (it, props = S.KF) => it.kf ? [...new Set(props.flatMap(k => (it.kf[k] || []).map(q => q[0])))].sort((a, b) => a - b) : [];
const kfProps = group => group === 'volume' ? ['volume'] : S.VIS_KF;
const kfHere = (it, group) => kfTimes(it, kfProps(group)).some(x => Math.abs(x - kfLt(it)) < kfTol());
function kfSet(it, k, lt, v) {
  it.kf ??= {};
  const p = (it.kf[k] ??= []), i = p.findIndex(q => Math.abs(q[0] - lt) < kfTol());
  if (i >= 0) p[i][1] = v; else { p.push([+lt.toFixed(4), v]); p.sort((a, b) => a[0] - b[0]); }
}
// Toggle the group's keys at the playhead.
function kfToggle(it, group) {
  snapshot();
  const lt = kfLt(it), props = kfProps(group);
  if (kfHere(it, group)) {
    for (const k of props) if (it.kf[k]) { it.kf[k] = it.kf[k].filter(q => Math.abs(q[0] - lt) >= kfTol()); if (!it.kf[k].length) delete it.kf[k]; }
    if (!S.hasKf(it)) delete it.kf;
  } else {
    const a = S.animAt(it, lt), d = KF_DEF(it);
    for (const k of props) kfSet(it, k, lt, num(a[k], d[k]));
  }
  refresh();
}
function kfJump(it, dir, group) {
  const lt = kfLt(it), ts = kfTimes(it, kfProps(group));
  const n = dir > 0 ? ts.find(x => x > lt + kfTol()) : [...ts].reverse().find(x => x < lt - kfTol());
  if (n != null) { seek(it.start + n); syncKfUI(true); }
}
// Animated props shown in the inspector follow the playhead.
let kfSyncT = -1;
function syncKfUI(force) {
  const it = sel && item(sel);
  if (!it || editing || (!force && t === kfSyncT)) return;
  kfSyncT = t;
  const b = document.querySelector('#inspBody [data-kf="tog"]');
  if (b) b.classList.toggle('on', kfHere(it, b.parentElement.dataset.kfGroup));
  if (!S.hasKf(it)) return;
  const a = S.animAt(it, kfLt(it)), d = KF_DEF(it);
  for (const k of S.KF) {
    const el = document.querySelector(`#inspBody [data-k="${k}"]`), v = num(a[k], d[k]);
    if (!el) continue;
    el.value = el.type === 'number' ? +v.toFixed(3) : v;
    if (el.type === 'range') paintRange(el);
    setShow(k, v);
  }
}
const kfBar = (it, group = 'visual') => `<div class="kfbar" data-kf-group="${group}" dir="ltr"><button class="ib" data-kf="prev" title="${tr('kf_prev')}">${icon('chevron-left')}</button>` +
  `<button class="kfb${kfHere(it, group) ? ' on' : ''}" data-kf="tog" title="${tr(group === 'volume' ? 'kf_volume' : 'kf_tip')}">${icon('diamond')}<span>${tr('keyframe')}</span></button>` +
  `<button class="ib" data-kf="next" title="${tr('kf_next')}">${icon('chevron-right')}</button></div>`;
const trkBtns = it => grp('tracking', `<button class="wide" id="trkGo">${icon('crosshair')} ${tr(it.trk ? 'trk_redo' : 'trk_go')}</button>` + (it.trk ? `<button class="wide" id="trkClear">${tr('trk_clear')}</button>` : ''));
// Eyedropper: the next click on the preview takes that pixel's colour into the chosen colour box.
let pickInput = null;
function startPick(inp) {
  if (depthPicker) endDepthPick();
  pickInput = inp;
  view.classList.add('picking');
  toast(tr('pickHint'));
}
function endPick() { pickInput = null; view.classList.remove('picking'); }
view.addEventListener('pointerdown', e => {
  if (!pickInput) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const r = view.getBoundingClientRect(), x = Math.floor((e.clientX - r.left) * P.w / r.width), y = Math.floor((e.clientY - r.top) * P.h / r.height);
  const d = vctx.getImageData(clamp(x, 0, P.w - 1), clamp(y, 0, P.h - 1), 1, 1).data, hx = v => v.toString(16).padStart(2, '0');
  const inp = pickInput; endPick();
  if (!document.body.contains(inp)) return;
  inp.value = '#' + hx(d[0]) + hx(d[1]) + hx(d[2]);
  inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
}, true);
window.addEventListener('keydown', e => { if (pickInput && e.key === 'Escape') endPick(); });
function addPickers(root) {
  for (const inp of root.querySelectorAll('input[type=color]')) {
    if (inp.nextElementSibling && inp.nextElementSibling.classList.contains('pick')) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ib pick'; b.title = tr('pickColor'); b.innerHTML = icon('pipette');
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); startPick(inp); };
    inp.after(b);
  }
}
// Drag sideways on a number field's label to scrub its value.
$('#inspBody').addEventListener('pointerdown', e => {
  const lb = e.target.closest('.f > .lb'), inp = lb && lb.parentElement.querySelector('input[type=number][data-k]');
  if (!inp || e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX, v0 = +inp.value || 0, st = +inp.step || 0.01, k = inp.dataset.k;
  const mv = ev => {
    const step = (k === 'start' || k === 'dur') ? 1 / P.fps : st >= 1 ? st : st;
    let v = v0 + Math.round((ev.clientX - x0) / 3) * step;
    if (k === 'dur') v = Math.max(1 / P.fps, v);
    if (k === 'start') v = Math.max(0, v);
    inp.value = +v.toFixed(3);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); inp.dispatchEvent(new Event('change', { bubbles: true })); }, { once: true });
});
function inspector() {
  kfSyncT = -1;
  if (depthPicker && (depthPicker.project !== P || item(sel) !== depthPicker.item || depthPicker.item.hidden)) endDepthPick();
  if (panelVisible('trans')) renderTrans();
  const body = $('#inspBody'), it = sel && item(sel), tabs = inspTabsFor(it);
  if (!tabs.includes(inspTab)) inspTab = tabs[0] || null;
  $('#inspTabs').innerHTML = tabs.map(x => `<button data-itab="${x}" class="${x === inspTab ? 'on' : ''}">${tr(x)}</button>`).join('');
  $('#inspTabs').hidden = !tabs.length;
  if (!it) {
    const k = (label, ...ids) => {
      const keys = ids.flatMap(id => activeKeys[id]);
      return keys.length ? `<div>${keys.map(keyBadge).join(' ')} ${tr(label)}</div>` : '';
    };
    body.innerHTML = `<p class="hint">${tr('nothingSel')}</p><div class="keys"><h4>${tr('shortcuts')}</h4>
      ${k('k_play', 'togglePlay')}${k('split', 'split', 'addEdit')}${k('delLeft', 'trimLeft')}${k('delRight', 'trimRight')}
      ${k('k_copy', 'copy')}${k('k_paste', 'paste')}${k('undo', 'undo')}${k('select', 'select')}${k('blade', 'blade')}
      ${k('k_frames', 'prevFrame', 'nextFrame')}
      <button class="wide" id="bAllKeys">${tr('k_all')}</button></div>`;
    $('#bAllKeys').onclick = () => showKeys();
    return;
  }
  if (media(it)?.angles) {
    body.innerHTML = '<p></p><div class="mc-actions"></div>';
    body.firstChild.textContent = media(it).name;
    const locked = P.tracks.find(x => x.id === it.track)?.locked;
    for (const [label, run, disabled] of [
      ['wsMulticam', () => revealPanel('multicam')],
      ['mcSettings', () => editMulticam(it.media), locked],
      ['mcFlatten', () => flattenMulticam(it), locked],
    ]) {
      const button = document.createElement('button');
      button.textContent = tr(label);
      button.onclick = run;
      button.disabled = !!disabled;
      body.lastChild.append(button);
    }
    return;
  }
  const h = [];
  const timing = `<div class="row2">${fld.number('start', 'start', 0.01, it)}${fld.number('dur', 'dur', 0.01, it)}</div>`;
  const fades = `<div class="row2">${fld.range('fadeIn', 'fadeIn', 0, 2, 0.05, it)}${fld.range('fadeOut', 'fadeOut', 0, 2, 0.05, it)}</div>`;
  if (inspTab === 'tText') {
    const st = { ...textDefaults(it.track === 'c1'), ...it.style };
    it.style = st;
    if (it.icon) h.push(hideRow(it), grp('iconSec', `<div class="row2">${fld.range('style.size', 'size', 20, 600, 1, it)}${fld.range('style.iconW', 'lineW', 0.5, 4, 0.1, it, 2)}</div>` +
      `<div class="inl">${fld.color('style.color', 'color', it)}${fld.check('style.gradOn', 'gradient', it)}${st.gradOn ? fld.color('style.fill2', 'color2', it) : ''}</div>` +
      `<div class="inl">${fld.check('style.iconFillOn', 'fill', it)}${st.iconFillOn ? fld.color('style.iconFill', 'color', it) : ''}</div>` +
      fld.select('draw', 'drawLine', [['', tr('draw_none')], ['in', tr('draw_in')], ['loop', tr('draw_loop')]], it)));
    else {
    h.push(`<div class="f"><textarea data-k="text" dir="auto">${esc(it.text)}</textarea></div>`, it.track === 'c1' ? capAllRow() : '', hideRow(it));
    const pOpen = (() => { try { return localStorage.getItem('kadr.presetsOpen') === '1'; } catch { return false; } })();
    h.push(`<div class="grp"><div class="gh ghx"><span>${tr('presets')}</span><button class="ib pTog${pOpen ? ' open' : ''}" data-ptog title="${tr(pOpen ? 'showLess' : 'showMore')}">${icon('chevron-down')}</button></div>` +
      `<div class="tpresets${pOpen ? '' : ' collapsed'}">${TEXT_STYLES.map(x => `<button data-tpreset="${x.id}" title="${x.id}"></button>`).join('')}</div></div>`);
    h.push(grp('font', `<div class="f"><button class="fontbtn" id="fontBtn" style="font-family:'${esc(st.font)}',Cairo">${esc(st.font)}${icon('chevron-down')}</button></div>` +
      `<div class="row2">${fld.range('style.size', 'size', 20, 260, 1, it)}${fld.select('style.weight', 'weight', [400, 600, 800, 900].map(w => [w, tr('w' + w)]), it)}</div>` +
      `<div class="tbar"><span>${tr('pattern')}</span><div class="tg">` +
        `<button data-tog="bold" class="${st.weight >= 700 ? 'on' : ''}" title="${tr('bold')}"><b>B</b></button>` +
        `<button data-tog="underline" class="${st.underline ? 'on' : ''}" title="${tr('underline')}"><u>U</u></button>` +
        `<button data-tog="italic" class="${st.italic ? 'on' : ''}" title="${tr('italic')}"><i>I</i></button></div></div>` +
      `<div class="tbar"><span>${tr('caseMode')}</span><div class="tg">${[['upper', 'TT'], ['lower', 'tt'], ['title', 'Tt']].map(([v, l]) => `<button data-set="caseMode" data-v="${v}" class="${st.caseMode === v ? 'on' : ''}" title="${tr('case_' + v)}">${l}</button>`).join('')}</div></div>` +
      `<div class="tbar"><span>${tr('align')}</span><div class="tg">${['left', 'center', 'right'].map(v => `<button data-set="align" data-v="${v}" class="${st.align === v ? 'on' : ''}" title="${tr('al_' + v)}">${icon('align-' + v)}</button>`).join('')}</div></div>` +
      `<div class="tbar"><span>${tr('dir')}</span><div class="tg">${[['ltr', 'pilcrow-right'], ['rtl', 'pilcrow-left']].map(([v, ic]) => `<button data-set="dir" data-v="${v}" class="${st.dir === v ? 'on' : ''}" title="${tr('dir_' + v + 'T')}">${icon(ic)}</button>`).join('')}</div></div>` +
      `<div class="row2">${fld.range('style.spacing', 'spacing', -5, 40, 1, it)}${fld.range('style.lineH', 'lineH', 0.8, 2.5, 0.05, it, 1.3)}</div>` +
      `<div class="inl">${fld.color('style.color', 'color', it)}${fld.check('style.gradOn', 'gradient', it)}${st.gradOn ? fld.color('style.fill2', 'color2', it) : ''}${it.words ? fld.color('style.hl', 'hl', it) : ''}</div>`));
    }
    const extra = (key, rowFn) => (st[key] || []).map((x, i) => `<div class="xl"><div class="xlh"><span>${tr(key === 'strokes' ? 'stroke' : 'shadow')} ${i + 2}</span><button class="ib" data-xdel="${key}.${i}" title="${tr('remove')}">${icon('x')}</button></div>${rowFn(`style.${key}.${i}`)}</div>`).join('');
    const addBtn = (title, key) => `<div class="gh ghx"><span>${tr(title)}</span><button class="ib" data-xadd="${key}" title="${tr('addLayer')}">${icon('plus')}</button></div>`;
    h.push(`<div class="grp">${addBtn('stroke', 'strokes')}` + fld.range('style.strokeW', 'stroke', 0, 20, 1, it) + `<div class="inl">${fld.color('style.stroke', 'strokeColor', it)}</div>` +
      extra('strokes', k => fld.range(k + '.w', 'stroke', 0, 20, 1, it) + `<div class="inl">${fld.color(k + '.c', 'strokeColor', it)}</div>`) + '</div>');
    h.push(grp('bg', `<div class="inl">${fld.check('style.bgOn', 'bg', it)}${fld.color('style.bg', 'color', it)}</div>` +
      (st.bgOn ? `<div class="row2">${fld.range('style.bgAlpha', 'opacity', 0, 1, 0.01, it, 1)}${fld.range('style.bgRadius', 'radius', 0, 0.5, 0.01, it, 0.22)}</div>` : '')));
    h.push(`<div class="grp">${addBtn('shadow', 'shadows')}<div class="inl">${fld.check('style.shadowOn', 'shadow', it)}${fld.color('style.shadowColor', 'color', it)}</div>` +
      (st.shadowOn ? `<div class="row2">${fld.range('style.shadowBlur', 'blur', 0, 60, 1, it)}${fld.range('style.shadowDist', 'distance', 0, 40, 1, it)}</div>` : '') +
      extra('shadows', k => `<div class="inl">${fld.color(k + '.c', 'color', it)}</div><div class="row2">${fld.range(k + '.blur', 'blur', 0, 60, 1, it)}${fld.range(k + '.dist', 'distance', 0, 40, 1, it)}</div>`) + '</div>');
    h.push(grp('glow', `<div class="inl">${fld.check('style.glowOn', 'glow', it)}${fld.color('style.glowColor', 'color', it)}</div>` +
      (st.glowOn ? fld.range('style.glowSize', 'size', 2, 80, 1, it) : '')));
    const ai = S.animAt(it, kfLt(it));
    h.push(grp('transform', kfBar(it) + fld.range('x', 'horiz', 0, 1, 0.01, ai, 0.5) + fld.range('y', 'vert', 0, 1, 0.01, ai, 0.5) +
      fld.range('scale', 'scale', 0.1, 4, 0.01, ai, 1) + fld.range('rotate', 'rotation', -180, 180, 1, ai) + fld.range('opacity', 'opacity', 0, 1, 0.01, ai, 1)));
    h.push(trkBtns(it));
  } else if (inspTab === 'tTpl') {
    const fav = lsGet('kadr.tplFav', []), card = x => `<div class="tpl${it.tpl === x.id ? ' on' : ''}" data-tpl="${x.id}" title="${x.id}"><button class="star${fav.includes(x.id) ? ' on' : ''}" data-fav="${x.id}">${icon('star')}</button></div>`;
    if (it.track === 'c1') h.push(`<label class="tplall"><input type="checkbox" id="tplAll"${lsGet('kadr.tplAll', true) ? ' checked' : ''}>${tr('tplAll')}</label>`);
    if (fav.length) h.push(`<div class="gh">${tr('favorites')}</div><div class="tpls">${CAP_TPL.filter(x => fav.includes(x.id)).map(card).join('')}</div>`);
    h.push(`<div class="gh">${tr('tTpl')}</div><div class="tpls">${CAP_TPL.map(card).join('')}</div>`);
  } else if (inspTab === 'tAnim') {
    {
      const V = !isText(it);
      const key = { in: 'anim', out: 'out', loop: 'loop' }[animSub];
      const all = V ? Object.keys({ in: S.VA_IN, out: S.VA_OUT, loop: S.VA_LOOP }[animSub]) : null, catOf = a => MaqtoAnims.CAT[a] || 'basic';
      const cats = V ? ['basic', ...MaqtoAnims.CATS.map(c => c[0])].filter(c => all.some(a => catOf(a) === c)) : [];
      if (V && !cats.includes(animCat)) animCat = 'basic';
      const list = V ? ['none', ...all.filter(a => catOf(a) === animCat)] : { in: ANIM_IN, out: ANIM_OUT, loop: ANIM_LOOP }[animSub];
      const curA = ({ slide: 'slideUp' })[it[key]] || it[key] || 'none';
      h.push(`<div class="seg">${['in', 'out', 'loop'].map(x => `<button data-asub="${x}" class="${x === animSub ? 'on' : ''}">${tr('an_' + x)}${(x === 'in' ? it.anim : x === 'out' ? it.out : it.loop) && (x === 'in' ? it.anim : x === 'out' ? it.out : it.loop) !== 'none' ? ' •' : ''}</button>`).join('')}</div>`);
      if (V) h.push(`<div class="acats">${cats.map(c => `<button data-acat="${c}" class="${c === animCat ? 'on' : ''}">${tr('ac_' + c)}${all.includes(curA) && catOf(curA) === c ? ' •' : ''}</button>`).join('')}</div>`);
      h.push(`<div class="agrid">${list.map(a => `<button data-anim="${a}" class="${a === curA ? 'on' : ''}">${a === 'none' ? icon('x') : `<canvas data-a="${a}" width="120" height="80"></canvas>`}<span>${tr('an_' + a)}</span></button>`).join('')}</div>`);
      if (animSub !== 'loop' && curA !== 'none') h.push(fld.range(animSub === 'in' ? 'inDur' : 'outDur', 'animDur', 0.1, 3, 0.05, it, animSub === 'in' ? 0.5 : 0.4));
      if (V) h.push(fades);
    }
  } else if (inspTab === 'tVideo' && media(it).adj) {
    h.push(`<p class="hint">${tr('adjHint')}</p>`, timing, hideRow(it),
      grp('fxSec', fld.select('fx.id', 'effect', [['', tr('fx_none')], ...S.FX.map(x => [x, tr('fx_' + x)])], it) + (S.fxOf(it) ? fld.range('fx.a', 'fxAmt', 0, 1, 0.01, it, 0.5) : '')),
      grp('filters', fld.select('preset', 'filters', Object.keys(S.PRESETS).map(x => [x, tr('p_' + x)]), it)),
      fld.range('opacity', 'opacity', 0, 1, 0.01, it, 1), fades);
  } else if (inspTab === 'tVideo') {
    const FM = media(it).fill;
    h.push(`<div class="f hint" style="direction:ltr;text-align:start">${esc(media(it).name)}</div>`, timing, hideRow(it));
    if (FM) {
      const f = it.fill = { ...FILL_DEF, ...it.fill }, gr = f.type !== 'solid';
      h.push(grp('fillSec', fld.select('fill.type', 'fillType', ['solid', 'linear', 'radial'].map(x => [x, tr('ft_' + x)]), it) +
        `<div class="inl">${fld.color('fill.c1', gr ? 'color1' : 'color', it)}${gr ? fld.color('fill.c2', 'color2', it) : ''}</div>` +
        (gr ? `<div class="row2">${fld.range('fill.a1', 'op1', 0, 1, 0.01, it, 1)}${fld.range('fill.a2', 'op2', 0, 1, 0.01, it, 1)}</div>` +
          fld.range('fill.mid', 'fillMid', 0.05, 0.95, 0.01, it, 0.5) + `<button class="wide" id="fillSwap">${icon('arrow-right-left')}${tr('fillSwap')}</button><p class="hint">${tr('fillHint')}</p>` : '')));
    }
    const ai = S.animAt(it, kfLt(it));
    h.push(grp('scale', kfBar(it) + fld.select('fit', 'fit_', [['cover', tr('cover')], ['contain', tr('contain')]], it) +
      fld.range('scale', 'scale', 0.1, 3, 0.01, ai, 1) +
      `<div class="row2">${fld.number('x', 'posX', 1, ai)}${fld.number('y', 'posY', 1, ai)}</div>` +
      fld.range('rotate', 'rotation', -180, 180, 1, ai) +
      fld.range('opacity', 'opacity', 0, 1, 0.01, ai, 1) +
      `<div class="inl">${fld.check('flipH', 'flipH', it)}${fld.check('flipV', 'flipV', it)}</div>`));
    h.push(grp('blendSec', fld.select('blend', 'blendMode', ['normal', ...Object.keys(BLENDS)].map(x => [x, tr('bm_' + x)]), it) + `<p class="hint">${tr('blendHint')}</p>`));
    h.push(grp('fxSec', fld.select('fx.id', 'effect', [['', tr('fx_none')], ...S.FX.map(x => [x, tr('fx_' + x)])], it) +
      (S.fxOf(it) ? fld.range('fx.a', 'fxAmt', 0, 1, 0.01, it, 0.5) : '')));
    if (media(it).kind === 'video') h.push(grp('stabSec', it.stabFrom ? `<button class="wide" id="stabOff">${icon('x')}${tr('stabOff')}</button>` :
      fld.select('stabLvl', 'stabLvl', [[1, tr('stab1')], [2, tr('stab2')], [3, tr('stab3')]], { stabLvl: num(it.stabLvl, 2) }) +
      (stabBusy.has(it.media) ? `<p class="hint work">${tr('stabWork')}</p>` : `<button class="wide" id="stabGo">${icon('vibrate')}${tr('stabGo')}</button>`) + `<p class="hint">${tr('stabHint')}</p>`));
    if (upscaleMedia(it)) h.push(depthInspector(it, media(it)), upscaleInspector(it, media(it)));
    if (it.track !== 'v1') h.push(trkBtns(it));
    if (!FM) h.push(`<div id="cropGrp">${grp('cropSec', `<div class="row2">${fld.range('crop.l', 'cropL', 0, 0.45, 0.01, it)}${fld.range('crop.r', 'cropR', 0, 0.45, 0.01, it)}</div>` +
      `<div class="row2">${fld.range('crop.t', 'cropT', 0, 0.45, 0.01, it)}${fld.range('crop.b', 'cropB', 0, 0.45, 0.01, it)}</div>`)}</div>`);
    const K = it.chroma || {};
    if (objectMedia(it)) h.push(objectInspector(it, media(it)));
    if (!FM && media(it).kind === 'video') {
      const mf = matteFor(it), mp = matteProg.get(it.id) || 0;
      const ob = mtKind(it) === 'object';
      h.push(grp('rmbgSec', `<div class="inl">${fld.check('rmbg', 'rmbgOn', it)}</div>` +
        (it.rmbg ? fld.select('rmbgKind', 'rmbgKind', [['person', tr('rmbgPerson')], ['object', tr('rmbgObject')]], it) : '') +
        (it.rmbg && ob ? `<div class="inl">${fld.check('rmbgFull', 'rmbgFull', it)}</div>` : '') +
        (it.rmbg && !matteTool[mtKind(it)] ? `<button class="ghost" data-matteget>${icon('download')}<span>${tr(ob ? 'matteGetObj' : 'matteGet')}</span></button>` : '') +
        (mf === '' ? `<div class="pxb insp" data-mtbar="${it.id}" style="--p:${mp}"><i></i><em>${tr('mtPrep').replace('{p}', Math.round(mp * 100))}</em></div>` : '') +
        `<p class="hint">${tr(ob ? 'rmbgHintObj' : 'rmbgHint')}</p>`));
    }
    if (!FM) h.push(grp('keySec', `<div class="inl">${fld.check('chroma.on', 'keyOn', it)}</div>` + (K.on ? `<div class="row2"><label>${tr('keyColor')}<input type="color" data-k="chroma.color" value="${esc(K.color || '#00ff00')}"></label><button id="keyPick" data-i="pipette"><span>${tr('keyPick')}</span></button></div>` +
      fld.range('chroma.sim', 'keySim', 0.01, 1, 0.01, it, 0.3) + fld.range('chroma.blend', 'keyBlend', 0, 1, 0.01, it, 0.1) : '') + `<p class="hint">${tr('keyHint')}</p>`));
    const lo = it.logo && it.logo.on;
    if (!FM) h.push(grp('logoSec', `<div class="inl">${fld.check('logo.on', 'logoOn', it)}</div>` + (lo ?
      `<div class="row2">${fld.range('logo.x', 'posX', 0, 0.99, 0.005, it)}${fld.range('logo.y', 'posY', 0, 0.99, 0.005, it)}</div>` +
      `<div class="row2">${fld.range('logo.w', 'lgW', 0.02, 1, 0.005, it, 0.18)}${fld.range('logo.h', 'lgH', 0.02, 1, 0.005, it, 0.1)}</div>` : '') +
      `<p class="hint">${tr('logoHint')}</p>`));
  } else if (inspTab === 'tAudio') {
    if (media(it).kind === 'audio') h.push(`<div class="f hint" style="direction:ltr;text-align:start">${esc(media(it).name)}</div>`, timing);
    h.push(fld.range('volume', 'volume', 0, 2, 0.01, { volume: S.volumeAt(it, kfLt(it)) }, 1),
      hasSound(media(it)) ? kfBar(it, 'volume') : '', `<div class="inl">${fld.check('muted', 'mute', it)}</div>`);
    if (media(it).kind !== 'audio') h.push(`<div class="row2">${fld.range('afIn', 'fadeIn', 0, 5, 0.05, it)}${fld.range('afOut', 'fadeOut', 0, 5, 0.05, it)}</div>`);
    h.push(grp('dnSec', `<div class="inl">${fld.check('norm', 'normalize', it)}</div><p class="hint">${tr('normHint')}</p>` +
      `<div class="inl">${fld.check('denoise', 'denoise', it)}</div><p class="hint">${tr('denoiseHint')}</p>` +
      voiceCleanFields(it) +
      (!it.voiceClean?.on && S.fxKey(it) && !dnLive(it) ? `<p class="hint work">${tr('dnWork')}</p>` : '')));
    if (media(it).kind === 'audio') h.push(duckFields(it), fades);
  } else if (inspTab === 'tSpeed') {
    const durRow = `<div class="f"><div class="lb"><span>${tr('dur')}</span></div><div class="spdur"><span>${S.srcLen(it).toFixed(1)}s</span><i></i><input type="number" data-k="dur" step="0.1" value="${+it.dur.toFixed(2)}"></div></div>`;
    const sp = num(it.speed, 1);
    h.push(`<div class="f"><div class="lb"><span>${tr('speed')}</span><b data-show="spdLog">×${sp}</b></div><div class="spd"><input type="range" data-k="spdLog" min="-1" max="1" step="0.005" value="${Math.log10(sp)}" list="spdTicks"><input type="number" data-k="speed" min="0.1" max="10" step="0.05" value="${sp}"></div>` +
      `<datalist id="spdTicks"><option value="-1"></option><option value="-0.699"></option><option value="-0.301"></option><option value="0"></option><option value="0.301"></option><option value="0.699"></option><option value="1"></option></datalist>` +
      `<div class="ticks"><span>0.1x</span><span>0.5x</span><span>1x</span><span>2x</span><span>5x</span><span>10x</span></div></div>`, durRow);
    if (media(it).kind === 'video' || media(it).hasAudio || media(it).kind === 'audio') h.push(`<div class="inl">${fld.check('pitch', 'pitchShift', it)}</div>`);
    if (media(it).kind === 'video') h.push(`<div class="inl">${fld.check('smooth', 'smoothSlow', it)}</div><p class="hint">${tr(rifeTool ? 'smoothHintAi' : 'smoothHint')}</p>`, rifeTool ? '' : `<button class="ghost" data-rifeget>${icon('download')}<span>${tr('rifeGet')}</span></button>`, pxBar(it, 'insp'));
  } else if (inspTab === 'tAdjust') {
    h.push(`<div class="seg csub">${['basic', 'hsl', 'qual', 'curves', 'wheels', 'lut', 'mask'].map(x => `<button data-csub="${x}" class="${x === colSub ? 'on' : ''}">${tr('cs_' + x)}</button>`).join('')}</div>`);
    const C = it.color || {};
    if (colSub === 'basic') {
      h.push(fld.select('preset', 'filter', Object.keys(S.PRESETS).map(p => [p, tr('p_' + p)]), it));
      h.push(fld.range('brightness', 'brightness', 0.5, 1.5, 0.01, it, 1), fld.range('contrast', 'contrast', 0.5, 1.5, 0.01, it, 1));
      h.push(fld.range('saturation', 'saturation', 0, 2, 0.01, it, 1), fld.range('temp', 'temp', -1, 1, 0.01, it));
      h.push(`<div class="row2 cbtns"><button id="autoAdj" data-i="wand-sparkles"><span>${tr('autoAdj')}</span></button><button id="colMatch" data-i="pipette"><span>${tr('colMatch')}</span></button></div><p class="hint">${tr('autoHint')}</p>`);
      if (C.match) h.push(fld.range('color.match.amt', 'matchAmt', 0, 100, 1, it, 100));
      h.push(`<button class="wide" id="colReset" data-i="rotate-ccw"><span>${tr('resetAllColor')}</span></button>`);
    } else if (colSub === 'hsl') {
      h.push(`<div class="hsw">${S.HSL_BANDS.map(([b, hc]) => { const v = (C.hsl || {})[b]; const used = v && (num(v.h, 0) || num(v.s, 0) || num(v.l, 0));
        return `<button data-hsl="${b}" class="${b === hslSel ? 'on' : ''}${used ? ' used' : ''}" style="--hc:hsl(${hc} 85% 55%)" title="${tr('hc_' + b)}"></button>`; }).join('')}</div>`);
      h.push(fld.range(`color.hsl.${hslSel}.h`, 'hue', -100, 100, 1, it), fld.range(`color.hsl.${hslSel}.s`, 'saturation', -100, 100, 1, it), fld.range(`color.hsl.${hslSel}.l`, 'lightness', -100, 100, 1, it));
      h.push(`<button class="wide" id="hslReset" data-i="rotate-ccw"><span>${tr('reset')}</span></button>`);
    } else if (colSub === 'qual') {
      h.push(`<div class="inl">${fld.check('color.qual.on', 'qualOn', it)}${fld.check('color.qual.show', 'qualShow', it)}<button class="ghost" id="qualPickBtn" data-i="pipette"><span>${tr('qualPick')}</span></button><input type="color" id="qualPick" hidden></div>`);
      h.push(fld.range('color.qual.h', 'hue', 0, 360, 1, it, 0), fld.range('color.qual.hw', 'qualWidth', 0, 360, 1, it, 40));
      h.push(`<div class="row2">${fld.range('color.qual.smin', 'qualSatMin', 0, 1, 0.01, it, 0.1)}${fld.range('color.qual.smax', 'qualSatMax', 0, 1, 0.01, it, 1)}</div>`);
      h.push(`<div class="row2">${fld.range('color.qual.lmin', 'qualLumMin', 0, 1, 0.01, it, 0)}${fld.range('color.qual.lmax', 'qualLumMax', 0, 1, 0.01, it, 1)}</div>`);
      h.push(fld.range('color.qual.soft', 'qualSoft', 0, 1, 0.01, it, 0.2), `<div class="gh">${tr('qualAdjust')}</div>`);
      h.push(fld.range('color.qual.dh', 'hue', -100, 100, 1, it), fld.range('color.qual.ds', 'saturation', -100, 100, 1, it), fld.range('color.qual.dl', 'lightness', -100, 100, 1, it));
      h.push(`<p class="hint">${tr('qualHint')}</p><button class="wide" id="qualReset" data-i="rotate-ccw"><span>${tr('reset')}</span></button>`);
    } else if (colSub === 'curves') {
      h.push(`<div class="seg cch">${['l', 'r', 'g', 'b'].map(c => `<button data-cch="${c}" class="${c === curCh ? 'on' : ''} c-${c}">${tr('ch_' + c)}</button>`).join('')}</div>`);
      h.push(`<div class="cved"><svg id="ccEd" viewBox="0 0 256 256"></svg></div><p class="hint">${tr('curveHint')}</p>`);
      h.push(`<button class="wide" id="curReset" data-i="rotate-ccw"><span>${tr('reset')}</span></button>`);
    } else if (colSub === 'mask') {
      const M = it.mask || {}, ty = S.hasMask(it) ? M.type : 'none';
      const shp = { linear: '<path d="M2 14h20"/><path d="M2 14h20v8H2z" fill="currentColor" opacity=".35"/>', mirror: '<path d="M2 8h20M2 16h20"/><path d="M2 8h20v8H2z" fill="currentColor" opacity=".35"/>', circle: '<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".35"/>', rect: '<rect x="4" y="6" width="16" height="12" rx="2" fill="currentColor" fill-opacity=".35"/>' };
      h.push(`<div class="mshapes">${['none', ...S.MASKS].map(x => `<button data-mask="${x}" class="${x === ty ? 'on' : ''}">${x === 'none' ? icon('x') : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${shp[x]}</svg>`}<span>${tr('mk_' + x)}</span></button>`).join('')}</div>`);
      if (ty !== 'none') {
        h.push(`<div class="row2">${fld.range('mask.x', 'mkX', 0, 1, 0.01, it, 0.5)}${fld.range('mask.y', 'mkY', 0, 1, 0.01, it, 0.5)}</div>`);
        if (ty === 'circle' || ty === 'rect') h.push(`<div class="row2">${fld.range('mask.w', 'lgW', 0.02, 1.5, 0.01, it, 0.5)}${fld.range('mask.h', 'lgH', 0.02, 1.5, 0.01, it, 0.5)}</div>`);
        if (ty === 'mirror') h.push(fld.range('mask.h', 'mkBand', 0.02, 1.5, 0.01, it, 0.5));
        h.push(fld.range('mask.rot', 'rotate', -180, 180, 1, it, 0), fld.range('mask.feather', 'mkFeather', 0, 1, 0.01, it, 0.1));
        if (ty === 'rect') h.push(fld.range('mask.round', 'mkRound', 0, 1, 0.01, it, 0));
        h.push(fld.check('mask.invert', 'mkInvert', it));
      }
    } else if (colSub === 'wheels') {
      h.push(fld.range('color.wheelMix', 'intensity', 0, 1, 0.01, it, 1));
      h.push(`<div class="whls">${['lift', 'gamma', 'gain', 'offset'].map(w => `<div class="whl" data-w="${w}"><b>${tr('w_' + w)}</b><div class="wring" data-wheel="${w}"><i></i></div>${fld.range(`color.wheels.${w}.l`, 'wLum', -1, 1, 0.01, it)}</div>`).join('')}</div>`);
      h.push(`<p class="hint">${tr('wheelHint')}</p><button class="wide" id="whlReset" data-i="rotate-ccw"><span>${tr('reset')}</span></button>`);
    } else {
      if (!lutLib) loadLutLib();
      const lf = C.lut && C.lut.file;
      h.push(`<div class="gh">${tr('lutLib')}</div>${lf ? fld.range('color.lut.mix', 'intensity', 0, 1, 0.01, it, 1) : ''}`);
      h.push(`<div class="looks lutlib"><button id="lutImport" class="add">${icon('upload')}<span>${tr('lutImport')}</span></button><button data-lutf="-1" class="${lf ? '' : 'on'}"><i class="lk0">${icon('x')}</i><span>${tr('lk_none')}</span></button>` +
        (lutLib || []).map((L, i) => `<button data-lutf="${i}" class="${lf === L.path ? 'on' : ''}" title="${esc(L.name)}"><canvas width="64" height="64"></canvas><span dir="ltr">${esc(L.name)}</span>${L.builtin ? '' : `<i class="ldel" data-lutdel="${i}" title="${tr('remove')}">×</i>`}</button>`).join('') + `</div><p class="hint">${tr('lutHint')}</p>`);
      h.push(`<div class="gh">${tr('looks')}</div>${C.look && C.look !== 'none' ? fld.range('color.lookMix', 'intensity', 0, 1, 0.01, it, 1) : ''}`);
      h.push(`<div class="looks">${['none', ...Object.keys(S.LOOKS)].map(l => `<button data-look="${l}" class="${(C.look || 'none') === l ? 'on' : ''}">${l === 'none' ? `<i class="lk0">${icon('x')}</i>` : '<canvas width="64" height="64"></canvas>'}<span>${tr('lk_' + l)}</span></button>`).join('')}</div>`);
    }
  }
  body.innerHTML = h.join('');
  body.querySelectorAll('input[type=range]').forEach(paintRange);
  paintIcons(body);
  $$('#inspBody [data-tpl]').forEach(b => {
    const tp = CAP_TPL.find(x => x.id === b.dataset.tpl), txt = tr('tplSample'), w = txt.split(' ');
    const fake = { text: txt, words: w.map((x, i) => ({ w: x, s: i, e: i + 1 })), style: { ...textDefaults(true), ...tp.s, size: 64 }, x: 0.5, y: 0.5, dur: 9 };
    b.prepend(cardCanvas(ctx => { ctx.fillStyle = '#3a3f47'; ctx.fillRect(0, 0, 240, 180); drawTextItem(ctx, { w: 240, h: 180 }, fake, 1.5); }, 96, 72));
  });
  const ta = $('#tplAll');
  if (ta) ta.onchange = () => lsSet('kadr.tplAll', ta.checked);
  $$('#inspBody [data-tpreset]').forEach(b => {
    const fake = { text: 'Aa', style: { ...presetStyle(b.dataset.tpreset, false), size: 96, strokeW: num(presetStyle(b.dataset.tpreset).strokeW, 0) * 1.1, shadowBlur: 10, shadowDist: 8, glowSize: 26 }, x: 0.5, y: 0.5, dur: 9 };
    b.appendChild(cardCanvas(ctx => drawTextItem(ctx, { w: 240, h: 180 }, fake, 5), 64, 48));
  });
  if ($('#ccEd')) colorCurveEditor(it);
  if ($('.whls')) wheelsUI(it);
  if ($('.looks')) lookThumbs(it);
  if ($('#fontBtn')) $('#fontBtn').onclick = () => fontPicker(it);
  const tg = $('#trkGo'), tc = $('#trkClear');
  if (tg) tg.onclick = () => trackPick(it);
  if (tc) tc.onclick = () => { snapshot(); delete it.trk; refresh(); };
  const cr = $('#colReset');
  if (cr) cr.onclick = () => { snapshot(); Object.assign(it, { preset: 'none', brightness: 1, contrast: 1, saturation: 1, temp: 0 }); delete it.color; refresh(); };
  const col = () => (it.color ??= {});
  const bind = (id, f) => { const b = $(id); if (b) b.onclick = f; };
  bind('#duckGo', async () => {
    try {
      const { keyframes } = await generateDucking(it);
      toast(tr(keyframes ? 'duckDone' : 'duckEmpty'));
    } catch (e) { toast(cleanErr(e)); }
  });
  bind('#qualReset', () => { snapshot(); if (it.color) delete it.color.qual; refresh(); });
  bind('#qualPickBtn', () => { if (it.color?.qual?.show) { snapshot(); it.color.qual.show = false; refresh(); } startPick($('#qualPick')); });
  if ($('#qualPick')) $('#qualPick').onchange = e => {
    const v = e.target.value, [h] = S.rgb2hsl(...[1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255));
    snapshot(); const q = (col().qual ??= {}); q.h = Math.round(h); q.on = true; refresh();
  };
  bind('#hslReset', () => { snapshot(); if (it.color && it.color.hsl) delete it.color.hsl[hslSel]; refresh(); });
  bind('#curReset', () => { snapshot(); if (it.color && it.color.curves) delete it.color.curves[curCh]; refresh(); });
  bind('#whlReset', () => { snapshot(); if (it.color) { delete it.color.wheels; delete it.color.wheelMix; } refresh(); });
  bind('#lutImport', async () => {
    const f = await TA.dialog.open({ filters: [{ name: 'LUT (.cube)', extensions: ['cube', 'CUBE'] }] });
    if (!f) return;
    let p;
    try { p = await inv('lut_add', { path: f }); } catch (e) { return toast(tr('lutFail') + ': ' + cleanErr(e)); }
    userLuts.delete(p);
    if (!(await loadUserLut(p))) { inv('lut_remove', { path: p }).catch(() => {}); return; }
    snapshot(); col().lut = { file: p, mix: 1 };
    await loadLutLib(); refresh();
  });
  bind('#autoAdj', () => autoAdjust(it));
  bind('#keyPick', () => keyPick(it));
  bind('#hideBtn', () => toggleHidden());
  addPickers(body);
  for (const control of document.querySelectorAll('#inspBody [data-depth-field]')) {
    control.onchange = () => setDepthDraft(it, { [control.dataset.depthField]:
      control.type === 'checkbox' ? control.checked : control.type === 'range' ? +control.value : control.value });
  }
  bind('#depthApply', () => prepareDepth(it).catch(e => toast(cleanErr(e))));
  bind('#depthCancel', () => stopDepth(depthTask));
  bind('#depthPick', () => startDepthPick(it));
  bind('#depthAuto', () => { endDepthPick(); setDepthDraft(it, { focus: null }); inspector(); });
  const upScale = $('#upscaleScale'), upModel = $('#upscaleModel');
  if (upScale) upScale.onchange = () => setUpscale(it, { scale: +upScale.value, model: upscaleType(it) });
  if (upModel) upModel.onchange = () => setUpscale(it, { scale: upscaleScale(it), model: upModel.value });
  bind('#upscalePrepare', () => prepareUpscale(it).catch(e => toast(cleanErr(e))));
  bind('#upscaleCancel', () => stopUpscale(upscaleTask));
  bind('#stabGo', () => stabilize(it));
  bind('#stabOff', () => { snapshot(); it.media = it.stabFrom; delete it.stabFrom; dirty = true; refresh(); });
  bind('#fillSwap',() => { snapshot(); const f = it.fill; [f.c1, f.c2, f.a1, f.a2] = [f.c2, f.c1, f.a2, f.a1]; dirty = true; refresh(); });
  bind('#colMatch', () => colorMatchPick(it));
}
$('#inspBody').addEventListener('click', e => {
  const action = e.target.closest('[data-object]')?.dataset.object;
  if (!action) return;
  const it = item(sel), draft = objectEdit(it);
  if (action === 'select') openObjectSelect(it);
  if (action === 'brush' || action === 'watermark') openBrush(it, action === 'watermark');
  if (action === 'apply-brush') applyBrush(it);
  if (action === 'fill-retry') retryFill(it);
  if (action === 'fill-cancel') { fillState(it, media(it))?.cancel(); inspector(); }
  if (action === 'cancel') cancelObjectJob();
  if (action === 'clear' && draft?.brush) {
    draft.strokes = [];
    draft.overlay.width = draft.overlay.width;
    needsDraw = true; inspector();
    return;
  }
  if (action === 'clear' && draft) {
    draft.prompt = { points: [], bbox: null }; draft.overlay = null; draft.lost = false; draft.pending = false;
    needsDraw = true; inspector();
  }
  if (action === 'still' || action === 'track') applyObject(it, action === 'still');
  if (action === 'remove' && it?.objectMask) {
    const fill = fillState(it, media(it));
    snapshot(); delete it.objectMask; dirty = true;
    releaseFill(fill);
    refresh();
  }
});
$('#inspBody').addEventListener('change', e => {
  const it = item(sel), draft = objectEdit(it), field = e.target.dataset.brushField;
  if (field && draft?.brush) {
    if (field === 'size') draft.size = +e.target.value;
    if (field === 'erase') draft.erase = e.target.checked;
    if (field === 'track') {
      draft.track = e.target.value;
      draft.motion = brushTracks(it).find(f => f.id === draft.track)?.trk.subject.pts || [];
      needsDraw = true;
    }
    return;
  }
  const k = e.target.dataset.objectField;
  if (!k || !it?.objectMask) return;
  const v = k === 'mode' ? e.target.value : (k === 'invert' || k === 'smooth') ? e.target.checked :
    clamp(Math.round(num(+e.target.value, 0)), k === 'expand' ? -128 : 0, 128);
  if (it.objectMask[k] === v) return;
  const fill = fillState(it, media(it));
  if (draft && k === 'mode') draft.mode = v;
  snapshot(); it.objectMask = { ...it.objectMask, [k]: v }; dirty = true;
  releaseFill(fill);
  refresh();
});
$('#inspBody').addEventListener('click', async e => {
  if (!e.target.closest('[data-matteget]')) return;
  const it = sel && item(sel), kind = it ? mtKind(it) : 'person';
  if (!(await TA.dialog.ask(tr(kind === 'object' ? 'matteAskObj' : 'matteAsk'), { title: tr('rmbgSec') }))) return;
  try { progress(tr('p_matte_dl'), 0); await matteModels[kind].download(false); hideModal(); toast(tr('matteOk')); inspector(); }
  catch (err) { hideModal(); toast(cleanErr(err)); }
});
// one-time download of the AI frame engine (RIFE, under 20 MB)
$('#inspBody').addEventListener('click', async e => {
  if (!e.target.closest('[data-rifeget]')) return;
  if (!(await TA.dialog.ask(tr('rifeAsk'), { title: tr('smoothSlow') }))) return;
  try { progress(tr('p_rife_dl'), 0); await rifeModel.download(false); hideModal(); toast(tr('rifeOk')); refresh(); }
  catch (err) { hideModal(); toast(cleanErr(err)); }
});
$('#inspBody').addEventListener('input', e => {
  if (e.target.dataset.voice === 'room') e.target.closest('label').querySelector('output').value = e.target.value + '%';
});
$('#inspBody').addEventListener('change', e => {
  const key = e.target.dataset.voice, it = sel && item(sel);
  if (!key || !it || !hasSound(media(it))) return;
  const value = key === 'on' ? e.target.checked : Number(e.target.value);
  if (S.voiceSettings(it.voiceClean)[key] === value) return;
  snapshot();
  (it.voiceClean ??= {})[key] = value;
  dirty = needsDraw = true;
  if (it.voiceClean.on) tryVoiceClean(it);
  if (key === 'on') {
    inspector();
    $('#inspBody [data-voice="on"]')?.focus({ preventScroll: true });
  }
});
$('#inspBody').addEventListener('click', e => {
  const it = sel && item(sel);
  if (!it) return;
  const voiceAction = e.target.closest('[data-voice-action]')?.dataset.voiceAction;
  if (voiceAction) {
    if (voiceAction === 'cancel') return stopVoice(voiceJobs.get(fxId(it))?.job);
    if (voiceAction === 'stop-download') return stopVoice('download');
    if (voiceAction === 'download') {
      voiceCleanModel.download().then(() => {
        if (item(it.id) === it && it.voiceClean?.on) tryVoiceClean(it);
      }).catch(e => { if (cleanErr(e) !== 'cancelled') toast(voiceError(e)); });
      return;
    }
    return tryVoiceClean(it);
  }
  const cs = e.target.closest('[data-csub]'), hs = e.target.closest('[data-hsl]'), ch = e.target.closest('[data-cch]'), lk = e.target.closest('[data-look]');
  if (cs) { colSub = cs.dataset.csub; needsDraw = true; inspector(); }
  else if (e.target.closest('[data-mask]')) {
    const x = e.target.closest('[data-mask]').dataset.mask;
    snapshot();
    if (x === 'none') delete it.mask;
    else it.mask = { ...S.MASK_DEF, ...(it.mask || {}), type: x };
    dirty = true; refresh();
  }
  else if (hs) { hslSel = hs.dataset.hsl; inspector(); }
  else if (ch) { curCh = ch.dataset.cch; inspector(); }
  else if (e.target.closest('[data-lutdel]')) {
    const L = lutLib[+e.target.closest('[data-lutdel]').dataset.lutdel];
    inv('lut_remove', { path: L.path }).then(loadLutLib).then(inspector, er => toast(tr('error') + ': ' + cleanErr(er)));
  } else if (e.target.closest('[data-lutf]')) {
    const i = +e.target.closest('[data-lutf]').dataset.lutf, c = (it.color ??= {});
    snapshot();
    if (i < 0) delete c.lut; else c.lut = { file: lutLib[i].path, mix: num(c.lut && c.lut.mix, 1) };
    dirty = true; refresh();
  } else if (lk) { snapshot(); const c = (it.color ??= {}); if (lk.dataset.look === 'none') delete c.look; else { c.look = lk.dataset.look; c.lookMix ??= 1; } dirty = true; refresh(); }
});
$('#inspTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-itab]');
  if (b) { inspTab = b.dataset.itab; inspector(); }
});

let animCat = 'basic';
let editing = false, animSub = 'in', colSub = 'basic', hslSel = 'red', curCh = 'l';

// A clip's frame (at its local time lt) as 96px pixels, for auto colour. Videos use a spare element.
// Background colour for the chroma key: the most common colour around the frame's edges.
async function keyPick(it) {
  const d = await framePixels(it, clamp(t - it.start, 0, it.dur)), n = 96, hist = new Map();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (x > 5 && x < n - 6 && y > 5 && y < n - 6) continue;
    const i = (y * n + x) * 4, k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4, e = hist.get(k) || [0, 0, 0, 0];
    e[0]++; e[1] += d[i]; e[2] += d[i + 1]; e[3] += d[i + 2]; hist.set(k, e);
  }
  const b = [...hist.values()].sort((a, c) => c[0] - a[0])[0], hx = v => Math.round(v / b[0]).toString(16).padStart(2, '0');
  snapshot(); it.chroma = { ...(it.chroma || {}), on: true, color: '#' + hx(b[1]) + hx(b[2]) + hx(b[3]) };
  dirty = true; refresh();
}
async function readVideoFrame(m, at, path = m.path) {
  const v = document.createElement('video');
  Object.assign(v, { crossOrigin: 'anonymous', muted: true, preload: 'auto' });
  const wait = (name, start) => new Promise((resolve, reject) => {
    const done = e => {
      v.removeEventListener(name, done);
      v.removeEventListener('error', done);
      if (e.type === 'error') reject(new Error(m.name));
      else resolve();
    };
    v.addEventListener(name, done);
    v.addEventListener('error', done);
    start();
  });
  try {
    mediaHold.appendChild(v);
    await wait('loadeddata', () => { v.src = urlOf({ path }); });
    const want = clamp(at, 0, Math.max(0, v.duration - 0.01));
    if (Math.abs(v.currentTime - want) > 0.001) await wait('seeked', () => { v.currentTime = want; });
    return v;
  } catch (e) { releaseVideoFrame(v); throw e; }
}
function releaseVideoFrame(v) {
  v.removeAttribute('src');
  v.load();
  v.remove();
}
async function framePixels(it, lt) {
  const m = media(it), still = m.kind === 'image';
  const src = still ? imgFor(m) : await readVideoFrame(m, num(it.in, 0) + S.srcAt(it, clamp(lt, 0, it.dur - 0.05)));
  if (still && !src.complete) await new Promise(ok => { src.onload = ok; });
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const x = c.getContext('2d', { willReadFrequently: true });
  try {
    x.drawImage(src, 0, 0, 96, 96);
    return x.getImageData(0, 0, 96, 96).data;
  } finally { if (!still) releaseVideoFrame(src); }
}
function frameStats(d) {
  const ch = [[], [], []], mean = [0, 0, 0], sd = [0, 0, 0], n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const v = d[i + k] / 255; ch[k].push(v); mean[k] += v / n; }
  for (let k = 0; k < 3; k++) { for (const v of ch[k]) sd[k] += (v - mean[k]) ** 2 / n; sd[k] = Math.sqrt(sd[k]); ch[k].sort((a, b) => a - b); }
  const q = (k, f) => ch[k][Math.min(n - 1, Math.floor(f * n))];
  return { mean, sd, lo: [0, 1, 2].map(k => q(k, 0.005)), hi: [0, 1, 2].map(k => q(k, 0.995)) };
}
// Auto adjust: per-channel levels from this frame (also neutralises a colour cast), held back to stay natural.
async function autoAdjust(it) {
  let st;
  try { st = frameStats(await framePixels(it, t - it.start)); } catch (e) { return toast(tr('error') + ': ' + cleanErr(e)); }
  snapshot();
  const lo = st.lo.map(v => +Math.min(0.25, v * 0.85).toFixed(4)), hi = st.hi.map(v => +Math.max(0.6, 1 - (1 - v) * 0.85).toFixed(4));
  (it.color ??= {}).auto = { lo, hi };
  dirty = true; refresh(); toast(tr('autoDone'));
}
// Colour match (Reinhard in Lab): pick a clip (the ones under the playhead first) or a still image;
// this clip's frame statistics are moved onto the reference's and stored as RGB gain/offset with an amount.
function colorMatchPick(it) {
  const others = P.items.filter(x => x !== it && media(x) && media(x).kind !== 'audio' && !isText(x)).sort((a, b) => active(b, t) - active(a, t));
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<h3>${tr('colMatch')}</h3><p class="hint">${tr('matchPick')}</p><div class="mlist"><button data-still>${icon('upload')}<b>${tr('matchStill')}</b></button>${others.map((x, i) => `<button data-mi="${i}"><b dir="ltr">${esc(media(x).name)}</b><small>${active(x, t) ? tr('matchNow') + ' · ' : ''}${x.start.toFixed(1)}s</small></button>`).join('')}</div><div class="acts"><span class="flex"></span><button id="mNo">${tr('cancel')}</button></div>`;
  $('#mNo').onclick = hideModal;
  $('#mBox').onclick = async e => {
    const b = e.target.closest('[data-mi],[data-still]');
    if (!b) return;
    try {
      let rd;
      if (b.dataset.still != null) {
        const f = await TA.dialog.open({ filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        if (!f) return;
        const im = new Image(); im.crossOrigin = 'anonymous';
        await new Promise((ok, no) => { im.onload = ok; im.onerror = no; im.src = urlOf({ path: f }); });
        const c = document.createElement('canvas'); c.width = c.height = 96;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, 96, 96);
        rd = x.getImageData(0, 0, 96, 96).data;
      } else { const ref = others[+b.dataset.mi]; rd = await framePixels(ref, active(ref, t) ? t - ref.start : ref.dur / 2); }
      hideModal();
      const m = S.reinhardGainOffset(S.labStats(await framePixels(it, t - it.start)), S.labStats(rd));
      snapshot(); (it.color ??= {}).match = { ...m, amt: 100 }; dirty = true; refresh(); toast(tr('matchDone'));
    } catch (er) { hideModal(); toast(tr('error') + ': ' + cleanErr(er)); }
  };
}
// Colour curve editor: drag points, click the line to add one, double-click a point to remove it.
function colorCurveEditor(it) {
  const svg = $('#ccEd'), N = 256, COL = { l: '#e9edf2', r: '#ff5a5a', g: '#4cd964', b: '#4aa3ff' };
  const pts = () => ((it.color ??= {}).curves ??= {})[curCh] ??= [[0, 0], [1, 1]];
  const path = (p, cls, col) => { const f = S.curveFn(p) || (x => x); return `<path class="${cls}" stroke="${col}" d="${Array.from({ length: 65 }, (_, i) => `${i ? 'L' : 'M'}${(i / 64 * N).toFixed(1)} ${((1 - f(i / 64)) * N).toFixed(1)}`).join('')}"/>`; };
  const paint = () => {
    const C = (it.color && it.color.curves) || {};
    svg.innerHTML = `<path class="gl" d="M64 0V256M128 0V256M192 0V256M0 64H256M0 128H256M0 192H256"/><path class="gl1" d="M0 256L256 0"/>` +
      ['l', 'r', 'g', 'b'].filter(c => c !== curCh && C[c]).map(c => path(C[c], 'cv ghost', COL[c])).join('') +
      path(pts(), 'cv', COL[curCh]) + pts().map((q, i) => `<circle data-cp="${i}" cx="${q[0] * N}" cy="${(1 - q[1]) * N}" r="7" fill="${COL[curCh]}"/>`).join('');
  };
  paint();
  const at = ev => { const r = svg.getBoundingClientRect(); return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1)]; };
  svg.onpointerdown = e => {
    snapshot();
    let p = pts(), i = e.target.dataset.cp != null ? +e.target.dataset.cp : -1;
    if (i < 0) { const [x] = at(e), f = S.curveFn(p) || (v => v); p.push([+x.toFixed(4), +f(x).toFixed(4)]); p.sort((a, b) => a[0] - b[0]); i = p.findIndex(q => q[0] === +x.toFixed(4)); }
    const end = i === 0 || i === p.length - 1;
    const mv = ev => {
      const [x, y] = at(ev);
      p[i][1] = +y.toFixed(4);
      if (!end) p[i][0] = +clamp(x, p[i - 1][0] + 0.01, p[i + 1][0] - 0.01).toFixed(4);
      dirty = true; needsDraw = true; paint();
    };
    mv(e);
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); paint(); }, { once: true });
  };
  svg.ondblclick = e => {
    const i = e.target.dataset.cp != null ? +e.target.dataset.cp : -1, p = pts();
    if (i <= 0 || i >= p.length - 1) return;
    snapshot(); p.splice(i, 1); dirty = true; needsDraw = true; paint();
  };
}
// Colour wheels: drag the dot to push that tonal range toward a hue; double-click to centre it.
function wheelsUI(it) {
  for (const ring of $$('.wring')) {
    const w = ring.dataset.wheel, dot = ring.firstElementChild;
    const get = () => ((it.color ??= {}).wheels ??= {})[w] ??= {};
    const place = () => { const v = (it.color && it.color.wheels && it.color.wheels[w]) || {}; dot.style.left = 50 + num(v.x, 0) * 50 + '%'; dot.style.top = 50 - num(v.y, 0) * 50 + '%'; };
    place();
    ring.onpointerdown = e => {
      snapshot();
      const r = ring.getBoundingClientRect();
      const mv = ev => {
        let x = (ev.clientX - r.left) / r.width * 2 - 1, y = -((ev.clientY - r.top) / r.height * 2 - 1);
        const d = Math.hypot(x, y); if (d > 1) { x /= d; y /= d; }
        const v = get(); v.x = +x.toFixed(3); v.y = +y.toFixed(3);
        dirty = true; needsDraw = true; place();
      };
      mv(e);
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', mv), { once: true });
    };
    ring.ondblclick = () => { snapshot(); const v = get(); v.x = v.y = 0; dirty = true; needsDraw = true; place(); };
  }
}
// LUT library (shipped + imported .cube files).
let lutLib = null;
async function loadLutLib() {
  try { lutLib = await inv('lut_library'); } catch { lutLib = []; }
  if (inspTab === 'tAdjust' && colSub === 'lut') inspector();
  return lutLib;
}
// Look cards show the clip's own current frame through each look.
function lookThumbs(it) {
  const m = media(it);
  if (m.angles) return;
  const src = m.kind === 'image' ? imgFor(m) : elFor(it);
  const ok = m.kind === 'image' ? src.complete && src.naturalWidth : src.readyState >= 2;
  if (!ok) return;
  const W = m.w, H = m.h, s = Math.min(W, H), [kx, ky] = sampleScale(src, m);
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, (W - s) * kx / 2, (H - s) * ky / 2, s * kx, s * ky, 0, 0, 64, 64);
  let base;
  try { base = x.getImageData(0, 0, 64, 64); } catch { return; }
  for (const cv of $$('.lutlib [data-lutf] canvas')) {
    const L = lutLib && lutLib[+cv.parentElement.dataset.lutf];
    if (L) loadUserLut(L.path).then(T => {
      if (!T || !cv.isConnected) return;
      const out = new ImageData(64, 64), d = base.data, o = out.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = S.sampleLut(T, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        o[i] = clamp(v[0], 0, 1) * 255; o[i + 1] = clamp(v[1], 0, 1) * 255; o[i + 2] = clamp(v[2], 0, 1) * 255; o[i + 3] = 255;
      }
      cv.getContext('2d').putImageData(out, 0, 0);
    });
  }
  for (const b of $$('.looks [data-look] canvas')) {
    const f = S.LOOKS[b.parentElement.dataset.look], out = new ImageData(64, 64), d = base.data, o = out.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = f(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
      o[i] = clamp(v[0], 0, 1) * 255; o[i + 1] = clamp(v[1], 0, 1) * 255; o[i + 2] = clamp(v[2], 0, 1) * 255; o[i + 3] = 255;
    }
    b.getContext('2d').putImageData(out, 0, 0);
  }
}
$('#inspBody').addEventListener('input', e => {
  const nk = e.target.dataset.num;
  if (!nk || e.target.value === '' || !isFinite(+e.target.value)) return;
  const r = document.querySelector(`#inspBody input[type=range][data-k="${nk}"]`);
  if (!r) return;
  r.value = PCT.test(nk) ? +e.target.value / 100 : +e.target.value;
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#inspBody').addEventListener('change', e => { // out-of-range numbers snap back to what the slider took
  const nk = e.target.dataset.num, r = nk && document.querySelector(`#inspBody input[type=range][data-k="${nk}"]`);
  if (r) e.target.value = dispVal(nk, +r.value);
});
$('#inspBody').addEventListener('input', e => {
  const k = e.target.dataset.k, it = sel && item(sel);
  if (!k || !it) return;
  let v = e.target.type === 'checkbox' ? e.target.checked
    : (e.target.type === 'range' || e.target.type === 'number') ? +e.target.value : e.target.value;
  if (typeof v === 'number' && !isFinite(v)) return;
  if (k === 'style.weight') v = +v;
  if (!editing) { snapshot(); editing = true; }
  const m = sourceBound(it);
  if (k === 'speed' || k === 'spdLog') {
    v = clamp(k === 'spdLog' ? Math.pow(10, v) : v, 0.1, 10);
    v = +v.toFixed(v < 1 ? 3 : 2);
    it.dur = S.srcLen(it) / v; // keep the same source range
    it.speed = v;
    delete it.curve;
    const o = $(`#inspBody [data-k="${k === 'speed' ? 'spdLog' : 'speed'}"]`), dd = $('#inspBody [data-k="dur"]');
    if (o) {
      o.value = k === 'speed' ? Math.log10(v) : v;
      if (o.type === 'range') paintRange(o);
    }
    if (dd) dd.value = +it.dur.toFixed(2);
  } else if (k === 'dur') {
    if (S.hasCurve(it)) it.dur = Math.max(1 / P.fps, v); // stretches the whole curve
    else if (m && it.track !== 't1' && inspTab === 'tSpeed') { // speed tab: the duration sets the speed
      it.speed = clamp(S.srcLen(it) / Math.max(1 / P.fps, v), 0.1, 10); it.dur = S.srcLen(it) / it.speed;
    } else {
      const max = m ? (m.dur - num(it.in, 0)) / num(it.speed, 1) : Infinity;
      it.dur = clamp(v, 1 / P.fps, max);
    }
  } else if (k === 'start') {
    it.start = Math.max(0, v);
  } else if (it.kf && it.kf[k] && S.KF.includes(k)) {
    kfSet(it, k, kfLt(it), v);
  } else {
    setPath(it, k, v); // caption text with a new word count simply loses the highlight (see drawTextItem)
  }
  if (k === 'logo.on') {
    if (v && it.logo.w == null) Object.assign(it.logo, { x: 0.78, y: 0.04, w: 0.18, h: 0.1 });
    inspector();
  }
  if (k === 'duck.on' && !v) S.writeDuckKeys(it, []);
  if ((k === 'denoise' || k === 'norm') && it.voiceClean?.on) {
    if (k === 'norm') tryVoiceClean(it);
    // The general change handler redraws after the checkbox commits.
  } else if ((k === 'denoise' || k === 'norm') && S.fxKey(it) && !dnLive(it)) {
    ensureDn(it).then(() => { toast(tr('dnDone')); if (sel === it.id) inspector(); },
      er => { it[k] = false; if (sel === it.id) inspector(); toast(tr('dnFail') + ': ' + cleanErr(er)); });
    inspector();
  } else if (k === 'denoise' || k === 'norm') inspector();
  if (e.target.type === 'range') setShow(k, v);
  dirty = true;
  if (/^(start|dur|speed|spdLog)$/.test(k)) { pack(); }
  if (k === 'spdLog' || k === 'speed') { const sh = $('#inspBody [data-show="spdLog"]'); if (sh) sh.textContent = '×' + it.speed; }
  if (/^(inDur|outDur)$/.test(k)) startAnimPreview(it);
  renderTimeline();
  needsDraw = true;
});
$('#inspBody').addEventListener('input', e => {
  if (e.target.dataset.voice === 'room') e.target.closest('label').querySelector('output').value = e.target.value + '%';
});
$('#inspBody').addEventListener('change', e => {
  const key = e.target.dataset.voice, it = sel && item(sel);
  if (!key || !it || !hasSound(media(it))) return;
  const value = key === 'on' ? e.target.checked : Number(e.target.value);
  if (S.voiceSettings(it.voiceClean)[key] === value) return;
  snapshot();
  (it.voiceClean ??= {})[key] = value;
  dirty = needsDraw = true;
  if (it.voiceClean.on) tryVoiceClean(it);
  if (key === 'on') {
    inspector();
    $('#inspBody [data-voice="on"]')?.focus({ preventScroll: true });
  }
});
$('#inspBody').addEventListener('click', e => {
  const it = sel && item(sel);
  if (!it) return;
  const voiceAction = e.target.closest('[data-voice-action]')?.dataset.voiceAction;
  if (voiceAction) {
    if (voiceAction === 'cancel') return stopVoice(voiceJobs.get(fxId(it))?.job);
    if (voiceAction === 'stop-download') return stopVoice('download');
    if (voiceAction === 'download') {
      voiceCleanModel.download().then(() => {
        if (item(it.id) === it && it.voiceClean?.on) tryVoiceClean(it);
      }).catch(e => { if (cleanErr(e) !== 'cancelled') toast(voiceError(e)); });
      return;
    }
    return tryVoiceClean(it);
  }
  const kb = e.target.closest('[data-kf]');
  if (kb) { const a = kb.dataset.kf, group = kb.parentElement.dataset.kfGroup; return a === 'tog' ? kfToggle(it, group) : kfJump(it, a === 'next' ? 1 : -1, group); }
  const ac = e.target.closest('[data-acat]');
  if (ac) { animCat = ac.dataset.acat; return inspector(); }
  const sub = e.target.closest('[data-asub]');
  if (sub) {
    animSub = sub.dataset.asub;
    inspector();
    const cur = it[{ in: 'anim', out: 'out', loop: 'loop' }[animSub]];
    if (cur && cur !== 'none') startAnimPreview(it); else animPreview = null;
    return;
  }
  const fv = e.target.closest('[data-fav]');
  if (fv) {
    const f = lsGet('kadr.tplFav', []), id = fv.dataset.fav;
    lsSet('kadr.tplFav', f.includes(id) ? f.filter(x => x !== id) : [...f, id]);
    return inspector();
  }
  const tp = e.target.closest('[data-tpl]');
  if (tp) return applyTpl(it, tp.dataset.tpl);
  const tg = e.target.closest('[data-tog]');
  if (tg) {
    snapshot();
    const k = tg.dataset.tog;
    if (k === 'bold') it.style.weight = it.style.weight >= 700 ? 400 : 800; else it.style[k] = !it.style[k];
    return refresh();
  }
  const ts = e.target.closest('[data-set]');
  if (ts) {
    snapshot();
    const k = ts.dataset.set, v = ts.dataset.v;
    it.style[k] = k === 'caseMode' && it.style[k] === v ? 'none' : k === 'dir' && it.style[k] === v ? 'auto' : v; // a second click turns it back off
    return refresh();
  }
  const an = e.target.closest('[data-anim]');
  if (an) {
    snapshot();
    it[{ in: 'anim', out: 'out', loop: 'loop' }[animSub]] = an.dataset.anim;
    refresh();
    if (an.dataset.anim !== 'none') startAnimPreview(it); else animPreview = null;
    return;
  }
  const xa = e.target.closest('[data-xadd], [data-xdel]');
  if (xa) { // add / remove an extra stroke or shadow layer
    snapshot();
    if (xa.dataset.xadd) {
      const k = xa.dataset.xadd, last = (it.style[k] || []).slice(-1)[0];
      it.style[k] = [...(it.style[k] || []), k === 'strokes' ? { w: 5, c: last ? last.c : '#000000' } : { c: '#000000', blur: 10, dist: 10 }];
    } else { const [k, i] = xa.dataset.xdel.split('.'); it.style[k] = it.style[k].filter((_, j) => j !== +i); }
    refresh(); inspector();
    return;
  }
  if (e.target.closest('[data-ptog]')) {
    const g = $('#inspBody .tpresets'), open = g.classList.toggle('collapsed') === false;
    const b = e.target.closest('[data-ptog]');
    b.classList.toggle('open', open); b.title = tr(open ? 'showLess' : 'showMore');
    try { localStorage.setItem('kadr.presetsOpen', open ? '1' : '0'); } catch {}
    return;
  }
  const pr = e.target.closest('[data-tpreset]');
  if (pr) {
    snapshot();
    const keep = { size: it.style.size, font: it.style.font, weight: it.style.weight, hl: it.style.hl };
    const ps = TEXT_STYLES.find(x => x.id === pr.dataset.tpreset).s;
    it.style = { ...presetStyle(pr.dataset.tpreset, it.track === 'c1'), size: keep.size, hl: keep.hl, ...(ps.font ? {} : { font: keep.font, weight: keep.weight }) };
    refresh();
  }
});
$('#inspBody').addEventListener('change', e => {
  editing = false;
  if (e.target.dataset.voice) return;
  if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox' || e.target.type === 'number') inspector();
});

/* ---------- preview: selection box, click to select, dragging ---------- */
function visBox(it, lt) {
  const m = media(it), a = S.withVa(S.animAt(it, lt), lt, P.w, P.h), L = S.layout(a, m, P.w, P.h), [tx, ty] = S.trkAt(it, lt);
  return { cx: L.ox + L.cw / 2 + tx * P.w, cy: L.oy + L.ch / 2 + ty * P.h, w: L.cw, h: L.ch, rot: num(a.rotate, 0) };
}
const boxOf = it => isText(it) ? textBoxes.get(it.id) : visBox(it, t - it.start);
function inBox(b, x, y) {
  const r = -b.rot * Math.PI / 180, dx = x - b.cx, dy = y - b.cy;
  const u = dx * Math.cos(r) - dy * Math.sin(r), v = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(u) <= b.w / 2 + 6 && Math.abs(v) <= b.h / 2 + 6;
}
// Topmost thing under the pointer: texts above clips, upper tracks above lower ones.
function hitAt(x, y) {
  const tx = visibleTexts(P, t);
  for (let i = tx.length - 1; i >= 0; i--) { const b = textBoxes.get(tx[i].id); if (b && inTimeline(tx[i]) && inBox(b, x, y)) return tx[i]; }
  const order = renderOrder(P, 'video');
  for (let i = order.length - 1; i >= 0; i--)
    for (const it of [...P.items].reverse()) if (it.track === order[i] && inTimeline(it) && !isText(it) && !it.hidden && active(it, t) && media(it).kind !== 'audio' && !media(it).adj && inBox(visBox(it, t - it.start), x, y)) return it;
  return null;
}
// Multi-selection: a plain outline on each picked layer showing on the preview (no handles).
const mselBoxes = [];
function placeSelBox() {
  const vr = view.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect(), k = vr.width / P.w;
  const at = b => ({ left: vr.left - sr.left + (b.cx - b.w / 2) * k + 'px', top: vr.top - sr.top + (b.cy - b.h / 2) * k + 'px',
    width: Math.max(8, b.w * k) + 'px', height: Math.max(8, b.h * k) + 'px', transform: `rotate(${b.rot}deg)` });
  const shown = id => { const x = item(id); return x && !x.hidden && active(x, t) && !(media(x) && media(x).kind === 'audio') && boxOf(x); };
  const bs = playing || msel.size < 2 ? [] : [...msel].map(shown).filter(Boolean);
  while (mselBoxes.length < bs.length) mselBoxes.push($('#stage').appendChild(Object.assign(document.createElement('div'), { className: 'mselbox' })));
  mselBoxes.forEach((d, i) => { d.hidden = i >= bs.length; if (!d.hidden) Object.assign(d.style, at(bs[i])); });
  const it = sel && item(sel), b = it && !objectEdit(it) && !playing && msel.size < 2 && active(it, t) && !(media(it) && media(it).kind === 'audio') && boxOf(it);
  selBox.hidden = !b;
  if (!b) return;
  Object.assign(selBox.style, at(b));
}
// Value of an animatable prop on the selected item, written as a keyframe when that prop is keyframed.
const propNow = (it, k) => num(S.animAt(it, kfLt(it))[k], KF_DEF(it)[k]);
function setProp(it, k, v) { if (it.kf && it.kf[k]) kfSet(it, k, kfLt(it), v); else it[k] = v; }
selBox.addEventListener('pointerdown', e => {
  const h = e.target.closest('[data-sh]'), it = sel && item(sel);
  if (!h || !it) return;
  e.preventDefault(); e.stopPropagation();
  if (h.dataset.sh === 'del') return removeSel();
  const r = selBox.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const s0 = propNow(it, 'scale'), r0 = propNow(it, 'rotate'), d0 = Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy)), a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
  let changed = false;
  const mv = ev => {
    if (!changed) { snapshot(); changed = true; }
    if (h.dataset.sh === 'rot') {
      let v = r0 + (Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180 / Math.PI;
      v = ((v + 540) % 360) - 180;
      for (const q of [-180, -90, 0, 90, 180]) if (Math.abs(v - q) < 4) v = q;
      setProp(it, 'rotate', Math.round(v));
    } else setProp(it, 'scale', +clamp(s0 * Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0, 0.05, 10).toFixed(3));
    needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); if (changed) { renderTimeline(); inspector(); } }, { once: true });
});
view.addEventListener('dblclick', e => {
  if (e.shiftKey || e.metaKey || e.ctrlKey) return; // quick shift-clicks build a selection, never open the editor
  const r = view.getBoundingClientRect(), k = P.w / r.width;
  const hit = hitAt((e.clientX - r.left) * k, (e.clientY - r.top) * k);
  if (hit && isText(hit) && !hit.icon) editTextInline(hit);
});
function editTextInline(it) {
  const b = textBoxes.get(it.id);
  if (!b || editId) return;
  setPlaying(false);
  select(it.id);
  const st = { ...textDefaults(it.track === 'c1'), ...it.style }, orig = it.text;
  const vr = view.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect(), k = vr.width / P.w;
  const fs = st.size * propNow(it, 'scale') * k, w = Math.max(160, b.w * k + fs);
  const ta = document.createElement('textarea');
  ta.id = 'tedit';
  ta.value = it.text;
  ta.dir = st.dir === 'rtl' || st.dir === 'ltr' ? st.dir : 'auto';
  Object.assign(ta.style, {
    font: `${st.italic ? 'italic ' : ''}${st.weight} ${fs}px "${st.font}", Cairo`, lineHeight: num(st.lineH, 1.3),
    color: st.color, textAlign: st.align || 'center', width: w + 'px',
    left: vr.left - sr.left + b.cx * k - w / 2 + 'px', transform: `rotate(${b.rot}deg)`,
  });
  $('#stage').appendChild(ta);
  editId = it.id;
  needsDraw = true;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.top = vr.top - sr.top + b.cy * k - ta.offsetHeight / 2 + 'px'; };
  fit();
  ta.focus(); ta.select();
  let snapped = false;
  ta.oninput = () => { if (!snapped) { snapshot(); snapped = true; } it.text = ta.value; fit(); };
  const done = keep => {
    if (editId !== it.id) return;
    editId = null;
    if (!keep) it.text = orig;
    ta.remove();
    if (!it.text.trim()) it.text = orig; // an emptied text keeps its old words
    refresh();
  };
  ta.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') done(false);
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done(true);
  };
  ta.onblur = () => done(true);
}
// Click on the empty area around the frame: drop the selection.
$('#stage').addEventListener('pointerdown', e => { if (e.button === 0 && e.target === e.currentTarget && (sel || msel.size)) select(null); });
$('#stage').addEventListener('pointerdown', depthPointer, true);
window.addEventListener('keydown', e => {
  if (!depthPicker || e.key !== 'Escape') return;
  e.preventDefault(); e.stopImmediatePropagation();
  endDepthPick();
}, true);
view.addEventListener('pointerdown', objectPointer, true);
view.addEventListener('pointerdown', e => {
  const r = view.getBoundingClientRect(), k = P.w / r.width, x0 = e.clientX, y0 = e.clientY;
  if (e.button !== 0) return;
  const cf = sel && item(sel);
  if (cf && !isText(cf) && media(cf) && media(cf).fill && cf.fill && cf.fill.type !== 'solid' && !cf.hidden && active(cf, t)) {
    const lt = t - cf.start, L = S.layout(S.withVa(S.animAt(cf, lt), lt, P.w, P.h), media(cf), P.w, P.h), p = fillPts(cf.fill, L);
    const px = (x0 - r.left) * k, py = (y0 - r.top) * k, near = q => Math.hypot(q[0] - px, q[1] - py) < 14 * k;
    const hd = near(p.mid) ? 'mid' : near(p.p2) ? 'p2' : near(p.p1) ? 'p1' : null;
    if (hd) {
      snapshot();
      const f = cf.fill;
      const mv = ev => {
        const X = ((ev.clientX - r.left) * k - L.ox) / L.cw, Y = ((ev.clientY - r.top) * k - L.oy) / L.ch;
        if (hd === 'mid') { const dx = f.x2 - f.x1, dy = f.y2 - f.y1; f.mid = +clamp(((X - f.x1) * dx + (Y - f.y1) * dy) / (dx * dx + dy * dy || 1), 0.05, 0.95).toFixed(3); }
        else { f[hd === 'p1' ? 'x1' : 'x2'] = +X.toFixed(4); f[hd === 'p1' ? 'y1' : 'y2'] = +Y.toFixed(4); }
        dirty = true; needsDraw = true;
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); inspector(); }, { once: true });
      return;
    }
  }
  if (e.shiftKey || e.metaKey || e.ctrlKey) { // add / remove the layer under the pointer, like the timeline
    const hit = hitAt((x0 - r.left) * k, (y0 - r.top) * k);
    if (hit) toggleSel(hit.id);
    return;
  }
  const cur = sel && item(sel), cb = cur && active(cur, t) && !(media(cur) && media(cur).kind === 'audio') && boxOf(cur);
  // one click on a text always takes the text; otherwise keep the current selection when clicking inside it
  // (so you can grab a clip under a text), else pick what's on top
  const hit = hitAt((x0 - r.left) * k, (y0 - r.top) * k);
  if ((hit && isText(hit)) || !(cb && inBox(cb, (x0 - r.left) * k, (y0 - r.top) * k))) select(hit ? hit.id : null);
  const it = sel && item(sel);
  if (!it || !active(it, t) || (media(it) && media(it).kind === 'audio')) return;
  const a0 = S.animAt(it, kfLt(it)), ox = num(a0.x, isText(it) ? 0.5 : 0), oy = num(a0.y, isText(it) ? 0.5 : 0);
  let changed = false;
  const snap = 8 * k; // project px: centre pulls within 8 screen px, Alt turns it off
  const mv = ev => {
    const dx = (ev.clientX - x0) * k, dy = (ev.clientY - y0) * k;
    if (!changed) { snapshot(); changed = true; }
    let nx, ny;
    if (isText(it)) { nx = clamp(ox + dx / P.w, 0, 1); ny = clamp(oy + dy / P.h, 0, 1); }
    else { nx = Math.round(ox + dx); ny = Math.round(oy + dy); }
    const c0 = isText(it) ? 0.5 : 0, sx = isText(it) ? P.w : 1, sy = isText(it) ? P.h : 1;
    const gx = !ev.altKey && Math.abs(nx - c0) * sx < snap, gy = !ev.altKey && Math.abs(ny - c0) * sy < snap;
    it.x = gx ? c0 : nx; it.y = gy ? c0 : ny;
    guides(gx, gy);
    for (const k of ['x', 'y']) if (it.kf && it.kf[k]) kfSet(it, k, kfLt(it), it[k]);
    capSync(); // with "apply to all" every caption moves along
    needsDraw = true;
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); guides(false, false); if (changed) inspector(); }, { once: true });
});
// Centre guide lines shown while a drag is snapped to the frame's middle
const guideEls = ['v', 'h'].map(d => $('#stage').appendChild(Object.assign(document.createElement('i'), { className: 'guide ' + d, hidden: true })));
function guides(gx, gy) {
  const R = view.getBoundingClientRect(), S0 = $('#stage').getBoundingClientRect();
  Object.assign(guideEls[0].style, { left: R.left - S0.left + R.width / 2 + 'px', top: R.top - S0.top + 'px', height: R.height + 'px' });
  Object.assign(guideEls[1].style, { top: R.top - S0.top + R.height / 2 + 'px', left: R.left - S0.left + 'px', width: R.width + 'px' });
  guideEls[0].hidden = !gx; guideEls[1].hidden = !gy;
}
// Right-click on the preview: put the layer back in the frame
view.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (objectEdit(item(sel))) return;
  const r = view.getBoundingClientRect(), k = P.w / r.width;
  const hit = hitAt((e.clientX - r.left) * k, (e.clientY - r.top) * k), it = hit || (sel && item(sel));
  if (!it || (media(it) && media(it).kind === 'audio')) return;
  if (hit) select(hit.id);
  const set = v => {
    snapshot();
    Object.assign(it, v);
    for (const key of Object.keys(v)) if (it.kf && it.kf[key]) kfSet(it, key, kfLt(it), it[key]);
    refresh(); inspector();
  };
  const c = isText(it) ? 0.5 : 0;
  ctxMenu(e, [
    !isText(it) && ['fitFrame', () => set({ fit: 'contain', scale: 1, x: 0, y: 0, rotate: 0 })],
    !isText(it) && ['fillFrame', () => set({ fit: 'cover', scale: 1, x: 0, y: 0, rotate: 0 })],
    ['centerLayer', () => set({ x: c, y: c })],
  ]);
});

/* ---------- motion tracking (template matching, no model) ---------- */
// Video under the follower at time t: topmost active video clip that isn't the follower itself.
function trackSource(f, time) {
  const order = renderOrder(P, 'video');
  for (let i = order.length - 1; i >= 0; i--)
    for (const it of P.items) if (it !== f && it.track === order[i] && !isText(it) && active(it, time) && media(it).kind === 'video') return it;
  return null;
}
// Pick the box on the preview: drag to draw, buttons to start or cancel.
function trackPick(f) {
  const src = trackSource(f, t);
  if (!src) return toast(tr('trk_noVideo'));
  setPlaying(false);
  const st = $('#stage'), r = () => view.getBoundingClientRect(), sr = () => st.getBoundingClientRect();
  const fp = isText(f) ? [num(f.x, 0.5) + S.trkAt(f, t - f.start)[0], num(f.y, 0.5) + S.trkAt(f, t - f.start)[1]] : [0.5, 0.5];
  let b = { x: clamp(fp[0] - 0.12, 0, 0.76), y: clamp(fp[1] - 0.12 * P.w / P.h, 0, 1 - 0.24 * P.w / P.h), w: 0.24, h: 0.24 * P.w / P.h };
  const ov = document.createElement('div');
  ov.className = 'trkpick';
  ov.innerHTML = `<i class="box"></i><div class="bar"><span>${tr('trk_hint')}</span><button class="primary" data-go>${tr('trk_start')}</button><button data-no>${tr('cancel')}</button></div>`;
  st.appendChild(ov);
  const box = ov.querySelector('.box');
  const place = () => {
    const R = r(), S0 = sr();
    Object.assign(box.style, { left: R.left - S0.left + b.x * R.width + 'px', top: R.top - S0.top + b.y * R.height + 'px', width: b.w * R.width + 'px', height: b.h * R.height + 'px' });
  };
  place();
  const ro = new ResizeObserver(place); ro.observe(st);
  ov.addEventListener('pointerdown', e => {
    if (e.target.closest('.bar')) return;
    const R = r(), fx = x => clamp((x - R.left) / R.width, 0, 1), fy = y => clamp((y - R.top) / R.height, 0, 1);
    const x0 = fx(e.clientX), y0 = fy(e.clientY), inside = x0 > b.x && x0 < b.x + b.w && y0 > b.y && y0 < b.y + b.h, b0 = { ...b };
    const mv = ev => {
      const x = fx(ev.clientX), y = fy(ev.clientY);
      if (inside) b = { ...b0, x: clamp(b0.x + x - x0, 0, 1 - b0.w), y: clamp(b0.y + y - y0, 0, 1 - b0.h) };
      else b = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      place();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', mv), { once: true });
  });
  const close = () => { ro.disconnect(); ov.remove(); };
  ov.querySelector('[data-no]').onclick = close;
  ov.querySelector('[data-go]').onclick = async () => {
    close();
    if (b.w * P.w < 12 || b.h * P.h < 12) return toast(tr('trk_small'));
    try { await runTrack(f, src, b); } catch (e) { hideModal(); if (!cancelled) toast(String(e.message || e)); }
  };
}
async function runTrack(f, src, box) {
  cancelled = false;
  // shortcut: a curved clip is tracked at its average speed; sample the curve if tracking drifts on those.
  const m = media(src), L = S.layout(src, m, P.w, P.h), C = S.srcCrop(src, m), FPS = 15, sp = S.srcLen(src) / src.dur;
  const bw = box.w * P.w, bh = box.h * P.h, sc = clamp(40 / Math.max(bw, bh), 0.03, 1); // template ~40px on its long side
  // Frames cover the clip's on-screen box (L.cw x L.ch at L.ox,L.oy) at work scale, grey, decoded once by ffmpeg.
  const W = Math.max(8, Math.round(L.cw * sc / 2) * 2), H = Math.max(8, Math.round(L.ch * sc / 2) * 2), kx = W / L.cw, ky = H / L.ch;
  const lo = Math.max(f.start, src.start), hi = Math.min(f.start + f.dur, src.start + src.dur), t0 = clamp(t, lo, hi - 1 / FPS);
  // shortcut: whole range is held in memory (W*H bytes per frame); stream it if clips get very long.
  const vf = [G.toneMap(m)].filter(Boolean);
  if (C.any) vf.push(`scale=${m.w}:${m.h}`, `crop=${C.w}:${C.h}:${C.x}:${C.y}`);
  if (src.flipH) vf.push('hflip');
  if (src.flipV) vf.push('vflip');
  vf.push(`setpts=(PTS-STARTPTS)/${sp}`, `fps=${FPS}`, `scale=${L.sw}:${L.sh}`, `crop=${L.cw}:${L.ch}:${L.cx}:${L.cy}`, `scale=${W}:${H}`, 'format=gray');
  progress(tr('trk_run'), null);
  const buf = new Uint8Array(await inv('gray_frames', { args: ['-v', 'error', '-ss', String(num(src.in, 0) + (lo - src.start) * sp), '-t', String((hi - lo) * sp),
    '-i', m.path, '-an', '-vf', vf.join(','), '-f', 'rawvideo', 'pipe:1'] }));
  const N = Math.floor(buf.length / (W * H));
  if (!N) throw new Error(tr('trk_noVideo'));
  const frame = i => buf.subarray(i * W * H, (i + 1) * W * H);
  const tw = Math.max(4, Math.round(bw * kx)), th = Math.max(4, Math.round(bh * ky));
  const patch = (g, x, y) => { // template at integer top-left, zero-mean
    const p = new Float32Array(tw * th);
    let s = 0;
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) s += p[j * tw + i] = g[clamp(y + j, 0, H - 1) * W + clamp(x + i, 0, W - 1)];
    s /= p.length;
    for (let i = 0; i < p.length; i++) p[i] -= s;
    return p;
  };
  const norm = p => Math.sqrt(p.reduce((a, v) => a + v * v, 0)) || 1;
  // Normalised cross-correlation in a window around (px,py); sub-pixel peak by parabola fit.
  const R = 24;
  const match = (g, tpl, tn, px, py) => {
    const x0 = Math.round(px), y0 = Math.round(py), n = 2 * R + 1, sc2 = new Float32Array(n * n).fill(-2), NN = tw * th;
    let best = -2, bi = 0, bj = 0;
    for (let dj = -R; dj <= R; dj++) {
      const y = y0 + dj;
      if (y < 0 || y + th > H) continue;
      for (let di = -R; di <= R; di++) {
        const x = x0 + di;
        if (x < 0 || x + tw > W) continue;
        let s = 0, ss = 0, st = 0;
        for (let j = 0; j < th; j++) { const o = (y + j) * W + x, q = j * tw; for (let i = 0; i < tw; i++) { const v = g[o + i]; s += v; ss += v * v; st += v * tpl[q + i]; } }
        const r = st / (tn * Math.sqrt(Math.max(ss - s * s / NN, 1e-6)));
        sc2[(dj + R) * n + di + R] = r;
        if (r > best) { best = r; bi = di; bj = dj; }
      }
    }
    const at = (i, j) => Math.abs(i) > R || Math.abs(j) > R ? -2 : sc2[(j + R) * n + i + R];
    const sub = (a, b0, c0) => { const d = a - 2 * b0 + c0; return a > -2 && c0 > -2 && d < 0 ? clamp(0.5 * (a - c0) / d, -0.5, 0.5) : 0; };
    return { x: x0 + bi + sub(at(bi - 1, bj), best, at(bi + 1, bj)), y: y0 + bj + sub(at(bi, bj - 1), best, at(bi, bj + 1)), r: best };
  };
  const i0 = clamp(Math.round((t0 - lo) * FPS), 0, N - 1), timeOf = i => lo + i / FPS;
  const sx = Math.round((box.x * P.w - L.ox) * kx), sy = Math.round((box.y * P.h - L.oy) * ky), tpl0 = patch(frame(i0), sx, sy);
  const pts = [[timeOf(i0) - f.start, 0, 0]];
  let done = 0, lost = 0;
  for (const dir of [1, -1]) {
    let tpl = Float32Array.from(tpl0), tn = norm(tpl), px = sx, py = sy, vx = 0, vy = 0;
    for (let i = i0 + dir; i >= 0 && i < N; i += dir) {
      if (cancelled) throw new Error(tr('cancelled'));
      const g = frame(i), hit = match(g, tpl, tn, px + vx, py + vy);
      if (hit.r < 0.35) lost++; else { vx = (hit.x - px) * 0.7; vy = (hit.y - py) * 0.7; px = hit.x; py = hit.y; }
      if (hit.r > 0.75) { // slow template refresh follows lighting/shape changes without drifting
        const p = patch(g, Math.round(px), Math.round(py));
        for (let k = 0; k < tpl.length; k++) tpl[k] = tpl[k] * 0.9 + p[k] * 0.1;
        tn = norm(tpl);
      }
      pts.push([timeOf(i) - f.start, (px - sx) / kx / P.w, (py - sy) / ky / P.h]);
      if (++done % 10 === 0) { progress(tr('trk_run'), done / N); await new Promise(r => setTimeout(r)); }
    }
  }
  hideModal();
  pts.sort((a, b) => a[0] - b[0]);
  // light smoothing (3-tap) to kill sub-pixel jitter
  const sm = pts.map((p, i) => i && i < pts.length - 1 ? [p[0], (pts[i - 1][1] + p[1] * 2 + pts[i + 1][1]) / 4, (pts[i - 1][2] + p[2] * 2 + pts[i + 1][2]) / 4] : p);
  snapshot();
  const atSource = (pos, crop, extent, full, flip) => (crop + (flip ? 1 - pos : pos) * extent) / full;
  f.trk = {
    pts: sm.map(p => [+p[0].toFixed(4), +p[1].toFixed(5), +p[2].toFixed(5)]),
    subject: { clip: src.id, media: src.media, pts: sm.map(([lt, x, y]) => [
      num(src.in, 0) + (lt + f.start - src.start) * sp,
      atSource((L.cx + (sx + tw / 2) / kx + x * P.w) / L.sw, C.x, C.w, m.w, src.flipH),
      atSource((L.cy + (sy + th / 2) / ky + y * P.h) / L.sh, C.y, C.h, m.h, src.flipV),
    ]) },
  };
  refresh();
  toast(lost > pts.length * 0.2 ? tr('trk_weak') : tr('trk_done'));
}

/* ---------- media library: search, sort, grid/list, multi-select, context menu ---------- */
const binSel = new Set();
let binAnchor = null, focusZone = 'tl';
let binView = (() => { try { return localStorage.getItem('kadr.binView') || 'grid'; } catch { return 'grid'; } })();
function binOrder() {
  const q = $('#binQ').value.trim().toLowerCase(), by = $('#binSort').value;
  const cmp = {
    added: (a, b) => num(b[1].added, 0) - num(a[1].added, 0),
    name: (a, b) => a[1].name.localeCompare(b[1].name),
    dur: (a, b) => num(b[1].dur, 0) - num(a[1].dur, 0),
    kind: (a, b) => a[1].kind.localeCompare(b[1].kind) || a[1].name.localeCompare(b[1].name),
  }[by];
  return Object.entries(P.media).filter(([, m]) => !m.fill && !m.adj && (!q || m.name.toLowerCase().includes(q))).sort(cmp).map(([id]) => id);
}
// Quick preview inside the card: one click plays the clip (with its sound) in its own thumbnail.
let binPrev = null;
function stopBinPrev() {
  if (!binPrev) return;
  const { el, mi, own } = binPrev;
  binPrev = null;
  el.pause(); el.ontimeupdate = el.onended = null;
  if (own) el.removeAttribute('src'); else { el.muted = true; el.currentTime = 0.5; }
  mi.classList.remove('prev'); mi.querySelector('.pbar')?.remove();
}
function toggleBinPrev(mi) {
  const was = binPrev?.mi === mi;
  stopBinPrev();
  const m = P.media[mi.dataset.mid];
  if (was || !m || m.angles || !(m.kind === 'video' || m.kind === 'audio')) return;
  if (playing) setPlaying(false);
  const v = mi.querySelector('.th video'), own = !v, el = v || new Audio(urlOf(m));
  const bar = mi.querySelector('.th').appendChild(Object.assign(document.createElement('span'), { className: 'pbar' }));
  el.ontimeupdate = () => { bar.style.width = (el.currentTime / (el.duration || 1)) * 100 + '%'; };
  el.onended = stopBinPrev;
  el.muted = false; el.currentTime = 0;
  binPrev = { el, mi, own };
  mi.classList.add('prev');
  el.play().catch(stopBinPrev);
}
function renderBin() {
  stopBinPrev();
  for (const id of binSel) if (!P.media[id]) binSel.delete(id);
  const used = mediaDependencies(P.items);
  $('#binList').className = binView;
  $('#binView').innerHTML = icon(binView === 'grid' ? 'list' : 'layout-grid');
  $('#binList').innerHTML = binOrder().map(id => {
    const m = P.media[id], url = m.angles ? '' : esc(urlOf(m));
    const th = m.angles ? icon('layers') : m.kind === 'video' ? `<video src="${url}#t=0.5" muted preload="metadata"></video>`
      : m.kind === 'image' ? `<img src="${url}">` : icon('music');
    const proxyBadge = S.needsProxy(m, 'always') ? '<span class="proxy-badge" role="img" hidden>P</span>' : '';
    return `<div class="mi${binSel.has(id) ? ' sel' : ''}" data-mid="${id}" title="${esc(m.path)}"><div class="th">${th}${proxyBadge}<span class="du">${m.dur ? fmt(m.dur) : tr('image')}</span>${binSceneTicks(m)}<span class="sc-st" hidden></span>${used.has(id) ? `<span class="used" title="${tr('inUse')}">${icon('check')}</span>` : ''}<button class="add" data-add title="${tr('addToTl')}">${icon('plus')}</button><button class="del" data-del title="${tr('del')}">${icon('trash-2')}</button></div><div class="nm">${esc(m.name)}</div></div>`;
  }).join('');
  $('#binAll').innerHTML = icon('check');
  paintBinSel();
  paintMediaProxies();
  paintBinScenes();
}
function paintBinSel() {
  $$('#binList .mi').forEach(el => el.classList.toggle('sel', binSel.has(el.dataset.mid)));
  const n = binSel.size, b = $('#binDel');
  b.hidden = !n;
  b.innerHTML = `${icon('trash-2')}<span>${n > 1 ? n : ''}</span>`;
  b.title = n > 1 ? tr('delN', { n }) : tr('del');
}
$('#binAll').onclick = () => { focusZone = 'bin'; binOrder().forEach(id => binSel.add(id)); paintBinSel(); };
$('#binDel').onclick = () => deleteMedia(picked());
function binPick(mid, e) {
  focusZone = 'bin';
  if (e.shiftKey && binAnchor) {
    const o = binOrder(), a = o.indexOf(binAnchor), b = o.indexOf(mid);
    if (!(e.metaKey || e.ctrlKey)) binSel.clear();
    o.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => binSel.add(x));
  } else if (e.metaKey || e.ctrlKey) {
    binSel.has(mid) ? binSel.delete(mid) : binSel.add(mid);
    binAnchor = mid;
  } else {
    if (!binSel.has(mid)) { binSel.clear(); binSel.add(mid); }
    binAnchor = mid;
  }
  paintBinSel();
}
const picked = () => binOrder().filter(id => binSel.has(id));
// Adds clips one after another on a track, starting at `start` (end of the track when null).
function addMany(mids, track, start) {
  let at = start, last;
  for (const mid of mids) { last = addMedia(mid, track, at); at = last.start + last.dur; track = last.track; }
}
$('#binQ').addEventListener('input', renderBin);
$('#binSort').addEventListener('change', renderBin);
$('#binView').onclick = () => { binView = binView === 'grid' ? 'list' : 'grid'; try { localStorage.setItem('kadr.binView', binView); } catch {} renderBin(); };
// Pointer drag from the bin (HTML5 drag-and-drop is off on Windows while native file drop is on).
$('#binList').addEventListener('pointerdown', e => {
  const mi = e.target.closest('.mi');
  if (e.target.closest('[data-del]')) { e.stopPropagation(); return deleteMedia([mi.dataset.mid]); }
  if (e.target.closest('[data-add]')) { e.stopPropagation(); focusZone = 'bin'; return addMany([mi.dataset.mid]); }
  if (!mi) { focusZone = 'bin'; if (e.button === 0) binMarquee(e); return; }
  if (e.button !== 0) return;
  const mid = mi.dataset.mid, x0 = e.clientX, y0 = e.clientY, ghost = $('#ghost');
  const wasSel = binSel.has(mid) && !e.shiftKey && !(e.metaKey || e.ctrlKey);
  if (!wasSel) binPick(mid, e); else focusZone = 'bin';
  let dragging = false;
  const mv = ev => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    dragging = true;
    const n = binSel.size;
    ghost.hidden = false;
    ghost.textContent = n > 1 ? tr('nClips', { n }) : P.media[mid].name;
    ghost.style.left = ev.clientX + 12 + 'px';
    ghost.style.top = ev.clientY + 12 + 'px';
    $$('.row.over, .clip.swap').forEach(r => r.classList.remove('over', 'swap'));
    const hit = document.elementFromPoint(ev.clientX, ev.clientY), row = hit?.closest('.row'), c = swapTarget(hit, n);
    if (c) c.classList.add('swap');
    else if (row) row.classList.add('over');
  };
  const up = async ev => {
    window.removeEventListener('pointermove', mv);
    ghost.hidden = true;
    $$('.row.over, .clip.swap').forEach(r => r.classList.remove('over', 'swap'));
    if (!dragging) { if (wasSel) { binSel.clear(); binPick(mid, ev); } if (!(ev.shiftKey || ev.metaKey || ev.ctrlKey)) toggleBinPrev(mi); return; }
    const hit = document.elementFromPoint(ev.clientX, ev.clientY), row = hit?.closest('.row');
    const t0 = snap1(Math.max(0, timeAt(ev.clientX)), snapPoints(null)), sw = swapTarget(hit, binSel.size);
    if (sw && await TA.dialog.ask(tr('swapAsk', { a: (media(item(sw.dataset.id)) || {}).name || '', b: P.media[mid].name }), { title: tr('swapT') })) return swapMedia(item(sw.dataset.id), mid);
    if (row) { addMany(picked(), row.dataset.track, t0); if (magnet && row.dataset.track !== 'v1') { packLane(row.dataset.track); refresh(); } }
    else if (hit?.closest('#tl')) addMany(picked(), newLaneFor(picked()[0], ev.clientY < $('#rows').getBoundingClientRect().top), t0); // empty timeline space: a lane of its own
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up, { once: true });
});
// One file dropped on a clip of the same kind (picture/video on a picture/video, sound on a sound): offer to swap it in.
function swapTarget(hit, n) {
  const c = n === 1 && hit?.closest('.clip'), it = c && item(c.dataset.id), mid = picked()[0], m = P.media[mid];
  if (!it || isText(it) || !m || it.media === mid || (P.tracks.find(x => x.id === it.track) || {}).locked) return null;
  return (m.kind === 'audio') === (media(it).kind === 'audio') ? c : null;
}
// The clip keeps its place, look and effects; only the file changes (a shorter file shortens the clip).
function swapMedia(it, mid) {
  const m = P.media[mid];
  snapshot();
  it.media = mid; it.in = 0;
  delete it.curve;
  if (m.kind !== 'image') it.dur = Math.min(it.dur, m.dur / num(it.speed, 1));
  sel = it.id; inspTab = null;
  if (magnet) packLane(it.track);
  dirty = true; refresh();
}
// Drag on empty space: rubber-band select (adds to the selection with ⌘/shift).
function binMarquee(e) {
  const list = $('#binList'), keep = e.metaKey || e.ctrlKey || e.shiftKey, base = keep ? new Set(binSel) : new Set();
  if (!keep) binSel.clear();
  paintBinSel();
  const box = list.appendChild(Object.assign(document.createElement('div'), { className: 'marq' }));
  const x0 = e.clientX, y0 = e.clientY;
  const mv = ev => {
    const l = Math.min(x0, ev.clientX), r = Math.max(x0, ev.clientX), t = Math.min(y0, ev.clientY), b = Math.max(y0, ev.clientY), L = list.getBoundingClientRect();
    Object.assign(box.style, { left: l - L.left + list.scrollLeft + 'px', top: t - L.top + list.scrollTop + 'px', width: r - l + 'px', height: b - t + 'px' });
    binSel.clear(); base.forEach(id => binSel.add(id));
    for (const el of list.querySelectorAll('.mi')) {
      const q = el.getBoundingClientRect();
      if (q.right > l && q.left < r && q.bottom > t && q.top < b) binSel.add(el.dataset.mid);
    }
    paintBinSel();
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', mv); box.parentNode.removeChild(box); }, { once: true });
}
$('#binList').addEventListener('dblclick', e => { if (e.target.closest('.mi')) { stopBinPrev(); addMany(picked()); } });
// Zoom: card size of the grid view.
{
  const z = $('#binZoom');
  const set = v => {
    v = Math.max(+z.min, Math.min(+z.max, v));
    z.value = v;
    paintRange(z);
    $('#binList').style.setProperty('--binW', v + 'px');
    try { localStorage.setItem('kadr.binZoom', v); } catch {}
  };
  let v0 = 72; try { v0 = +localStorage.getItem('kadr.binZoom') || 72; } catch {}
  set(v0);
  z.oninput = () => set(+z.value);
  $('#binZOut').onclick = () => set(+z.value - 24);
  $('#binZIn').onclick = () => set(+z.value + 24);
  $('#binList').addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); set(+z.value - Math.sign(e.deltaY) * 12); } }, { passive: false });
}

/* ---------- multicam ---------- */
function mediaDependencies(items) {
  const ids = new Set(items.map(it => it.media).filter(Boolean));
  for (const id of ids) for (const angle of P.media[id]?.angles || []) ids.add(angle.media);
  return ids;
}
const multicamLocked = it => P.tracks.find(x => x.id === it.track)?.locked;
const multicamCuts = (it, m = media(it)) => it.cuts?.length ? it.cuts : [{ t: 0, angle: m.defaultAngle ?? 0 }];
const multicamAngleAt = (it, time) => {
  const cuts = multicamCuts(it);
  return cuts[Math.max(0, S.cutIndex(cuts, S.multicamTime(it, time - it.start)))].angle;
};
function activeMulticam() {
  const selected = item(sel);
  if (selected && media(selected)?.angles && active(selected, t)) return selected;
  if (!panelVisible('multicam')) return null;
  return timelineItems().filter(it => !it.hidden && media(it)?.angles && active(it, t))
    .sort((a, b) => P.tracks.findIndex(x => x.id === a.track) - P.tracks.findIndex(x => x.id === b.track))[0] || null;
}
function chooseMulticamAngle(angle) {
  const it = activeMulticam();
  if (!it || multicamLocked(it) || angle >= media(it).angles.length) return;
  const old = multicamCuts(it), time = S.multicamTime(it, t - it.start);
  const cuts = (playing ? S.recordCut : S.switchSegment)(old, time, angle);
  if (cuts === old) return;
  snapshot();
  it.cuts = cuts;
  refresh();
}
function viewerAngles(it) {
  const source = media(it);
  return source.angles.map(({ media: id }, angle) => {
    if (P.media[id]?.kind !== 'video') return null;
    const piece = S.multicamAngle(it, source, P.media, angle, num(it.in, 0), S.multicamTime(it, it.dur));
    return piece && { ...piece, id: it.id + '|mc' + angle + '|viewer', muted: true, hidden: false };
  });
}
const mcGrid = $('#mcGrid');
let mcViewerKey = '';
function renderMulticamViewer(it, angles) {
  const source = media(it), names = source?.angles.map(a => P.media[a.media]?.name || '');
  const key = source ? JSON.stringify([it.id, names, LANG]) : '';
  if (key !== mcViewerKey) {
    for (const el of mcGrid.querySelectorAll('video')) mediaHold.appendChild(el);
    mcViewerKey = key;
    mcGrid.replaceChildren();
    $('#mcEmpty').hidden = !!source;
    if (source) {
      mcGrid.style.setProperty('--mc-cols', source.angles.length > 4 ? 3 : 2);
      names.forEach((name, angle) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'mc-tile';
        tile.innerHTML = `<span class="mc-picture">${icon(P.media[source.angles[angle].media]?.kind === 'audio' ? 'music' : 'video')}</span><span class="mc-name"></span>`;
        tile.lastChild.textContent = (angle + 1) + ' · ' + name;
        tile.title = name;
        tile.onclick = () => chooseMulticamAngle(angle);
        mcGrid.append(tile);
      });
    }
  }
  if (!it) return;
  const activeAngle = multicamAngleAt(it, t);
  for (const [i, tile] of Array.from(mcGrid.children).entries()) {
    tile.setAttribute('aria-pressed', i === activeAngle);
    tile.disabled = !!multicamLocked(it);
    const piece = angles[i], frame = tile.firstChild, previous = frame.querySelector('video');
    const el = piece && active(piece, t) && els.get(chainKey(piece));
    if (previous && previous !== el) mediaHold.appendChild(previous);
    if (el && el !== previous) frame.appendChild(el);
  }
}
function multicamBoundaries(it) {
  const source = media(it);
  if (!source?.angles) return '';
  return S.cutsToSegments(it, source).map(({ a, b, angle, index }, j) => {
    const x = S.ltAt(it, a - num(it.in, 0)), w = S.ltAt(it, b - num(it.in, 0)) - x;
    return `<i class="mc-segment" style="left:calc(${x}px * var(--pps));width:calc(${w}px * var(--pps))"><span>${angle + 1}</span>${j ? `<b data-mc-cut="${index}" title="${tr('rollTool')}"></b>` : ''}</i>`;
  }).join('');
}
function dragMulticamCut(e, it, index) {
  e.preventDefault();
  select(it.id);
  const cuts = it.cuts, x = e.clientX;
  const local = value => S.ltAt(it, value - num(it.in, 0));
  const frame = frameDur(), lo = Math.max(0, local(cuts[index - 1].t)) + frame;
  const hi = Math.min(it.dur, cuts[index + 1] ? local(cuts[index + 1].t) : it.dur) - frame;
  if (lo > hi) return;
  const origin = local(cuts[index].t), points = snapPoints(it.id);
  let moved = false;
  const mv = ev => {
    if (ev.pointerId !== e.pointerId || item(it.id) !== it || it.cuts !== cuts || (!moved && Math.abs(ev.clientX - x) < 3)) return;
    const raw = origin + timeAt(ev.clientX) - timeAt(x);
    const next = S.multicamTime(it, clamp(snap1(it.start + raw, points) - it.start, lo, hi));
    if (Math.abs(cuts[index].t - next) < 1e-7) return;
    if (!moved) { snapshot(); moved = true; }
    cuts[index].t = next;
    renderTimeline();
    needsDraw = true;
  };
  const done = ev => {
    if ('pointerId' in ev && ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    window.removeEventListener('blur', done);
    if (moved) refresh();
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
  window.addEventListener('blur', done);
}
function multicamInputs(ids, timeline = false) {
  if (ids.length < 2 || ids.length > 9) return null;
  const inputs = [];
  for (const id of ids) {
    const it = timeline ? item(id) : null, mid = timeline ? it?.media : id, m = P.media[mid];
    if (!m?.path || m.angles || !['video', 'audio'].includes(m.kind) || (it && multicamLocked(it))) return null;
    const start = num(it?.in, 0), end = Math.min(m.dur, it ? start + S.srcLen(it) : m.dur);
    if (!(end > start)) return null;
    const tm = it && P.markers.find(marker => active(it, marker.time));
    const marker = tm ? S.multicamTime(it, tm.time - it.start) : m.firstMarker;
    inputs.push({ media: mid, in: start, out: end, marker, it });
  }
  return inputs;
}
function multicamForm(title, fields, submit, run) {
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<form id="mcForm"><h3>${esc(title)}</h3>${fields}<p class="hint" id="mcStatus" hidden></p>
    <div class="acts"><button type="button" id="mNo">${tr('cancel')}</button><button class="primary">${tr(submit)}</button></div></form>`;
  const form = $('#mcForm');
  $('#mNo').onclick = hideModal;
  form.onkeydown = e => { if (e.key === 'Escape') hideModal(); };
  form.onsubmit = e => { e.preventDefault(); run(form); };
  form.querySelector('select, input, .primary').focus();
  return form;
}
function multicamAudioOptions(angles, audio, auto = false) {
  return `<label class="f"><span>${tr('mcAudioAngle')}</span><select name="audio">
    <option value=""${audio == null ? ' selected' : ''}>${tr(auto ? 'mcAutoAudio' : 'mcNoAudio')}</option>
    ${angles.map((a, i) => hasSound(P.media[a.media]) ? `<option value="${i}"${i === audio ? ' selected' : ''}>${i + 1} · ${esc(P.media[a.media].name)}</option>` : '').join('')}
  </select></label>`;
}
function reviewMulticam(title, angles, audio, submit, save) {
  multicamForm(title, multicamAudioOptions(angles, audio) +
    `<p class="hint">${tr('mcOffsetHelp')}</p><div class="mc-offsets">${angles.map((a, i) => `
      <label class="mc-offset"><span>${i + 1} · ${esc(P.media[a.media]?.name || '')}
        ${a.warning ? `<small class="mc-warning">${tr(a.warning)}</small>` : ''}
      </span><input type="number" name="offset" step="any" required value="${+a.offset.toFixed(4)}" aria-label="${tr('mcOffset')}"></label>`).join('')}</div>`,
  submit, form => {
    const data = new FormData(form), ref = data.get('audio');
    save(angles.map((a, i) => ({ ...a, offset: +data.getAll('offset')[i] })), ref === '' ? null : +ref);
    hideModal();
  });
}
function createMulticam(inputs, timeline = false) {
  const project = P;
  const current = () => P === project && inputs.every(a => P.media[a.media] && (!a.it || item(a.it.id) === a.it && !multicamLocked(a.it)));
  multicamForm(tr('mcCreate'), `<label class="f"><span>${tr('mcSync')}</span><select name="sync">
    <option value="audio">${tr('mcAudio')}</option><option value="start">${tr('mcStart')}</option><option value="marker">${tr('mcMarkers')}</option>
    </select></label>` + multicamAudioOptions(inputs, null, true), 'mcAlign', async form => {
    if (!current()) { hideModal(); return; }
    const data = new FormData(form), mode = data.get('sync'), value = data.get('audio'), ref = value === '' ? null : +value;
    const button = form.querySelector('.primary'), status = form.querySelector('#mcStatus');
    button.disabled = true;
    status.hidden = false;
    status.textContent = tr('mcWorking');
    try {
      const unknown = mode === 'marker' ? inputs.filter(a => a.marker === undefined) : [];
      const paths = [...new Set(unknown.map(a => P.media[a.media].path))];
      const [result, probes] = await Promise.all([
        mode === 'audio' || ref == null ? inv('sync_multicam', {
          inputs: inputs.map(a => ({ path: P.media[a.media].path, start: a.in, duration: a.out - a.in, audio: hasSound(P.media[a.media]) })),
          reference: ref, align: mode === 'audio',
        }) : { audio: ref, matches: [] },
        paths.length ? inv('probe', { paths }).catch(() => ({ ok: [] })) : { ok: [] },
      ]);
      if (!form.isConnected || $('#modal').hidden) return;
      if (!current()) { hideModal(); return; }
      const markers = inputs.map(a => {
        const mark = a.marker ?? probes.ok.find(m => m.path === P.media[a.media].path)?.firstMarker;
        return Number.isFinite(mark) && mark >= a.in && mark < a.out ? mark : null;
      });
      const markerRef = (markers[result.audio] == null ? markers.findIndex(m => m != null) : result.audio);
      const markerLead = markerRef >= 0 ? markers[markerRef] - inputs[markerRef].in : 0;
      const angles = inputs.map(({ media, in: start, out }, i) => {
        const match = result.matches[i], confidence = mode === 'audio' ? match?.confidence || 0 : undefined;
        const warning = mode === 'audio' && confidence < 0.5 ? 'mcLowConfidence'
          : mode === 'marker' && markers[i] == null ? 'mcMissingMarker' : undefined;
        const offset = mode === 'marker' ? -(markers[i] ?? (start + markerLead))
          : (confidence >= 0.5 ? match.offset : 0) - start;
        return { media, in: start, out, offset, confidence, warning };
      });
      reviewMulticam(tr('mcCreate'), angles, result.audio, 'mcMake', (aligned, audio) => {
        if (current()) saveMulticam(aligned, audio, timeline ? inputs.map(a => a.it) : []);
      });
    } catch (err) {
      if (form.isConnected) { status.textContent = cleanErr(err); button.disabled = false; }
    }
  });
}
function saveMulticam(angles, audioAngle, clips) {
  const zero = Math.min(...angles.map(a => a.in + a.offset));
  for (const a of angles) a.offset -= zero;
  const dur = Math.max(...angles.map(a => a.out + a.offset));
  const cameras = angles.map((a, i) => ({ ...a, i })).filter(a => P.media[a.media].kind === 'video');
  const first = cameras.sort((a, b) => a.in + a.offset - b.in - b.offset)[0];
  const kind = first ? 'video' : 'audio', mid = uid(), defaultAngle = first?.i ?? audioAngle ?? 0;
  snapshot();
  P.media[mid] = { kind, name: tr('wsMulticam'), path: '', w: P.w, h: P.h, dur, angles, audioAngle, defaultAngle, added: Date.now() };
  if (clips.length) {
    const anchor = clips.find(it => P.tracks.find(x => x.id === it.track)?.kind === kind);
    const it = { id: uid(), media: mid, track: anchor?.track ?? (kind === 'video' ? 'v1' : 'a1'),
      start: Math.min(...clips.map(it => it.start)), dur, in: 0, speed: 1, volume: 1, cuts: [{ t: 0, angle: defaultAngle }] };
    P.items = P.items.filter(i => !clips.includes(i));
    it.track = freeLaneAbove([it], null, []);
    addTimelineItem(it, clips[0].grp);
    setSelection([it.id]);
    seek(it.start);
    revealPanel('multicam');
  } else {
    binSel.clear();
    binSel.add(mid);
  }
  refresh();
}
function editMulticam(id) {
  const project = P, source = P.media[id];
  if (!source?.angles) return;
  reviewMulticam(tr('mcSettings'), source.angles, source.audioAngle, 'ok', (angles, audio) => {
    if (P !== project || P.media[id] !== source) return;
    snapshot();
    source.angles = angles;
    source.audioAngle = audio;
    refresh();
  });
}
function flattenMulticam(it) {
  const source = media(it);
  if (!source?.angles || multicamLocked(it)) return;
  snapshot();
  const { video, audio } = S.multicamClips(it, source, P.media), clips = [...video];
  P.items = P.items.filter(i => i !== it);
  if (audio) {
    const original = P.media[audio.media];
    if (original.kind === 'video') {
      audio.media = Object.keys(P.media).find(k => P.media[k].path === original.path && P.media[k].kind === 'audio') || uid();
      P.media[audio.media] ??= { ...original, kind: 'audio', name: original.name + ' · ' + tr('audioWord'), added: Date.now() };
    }
    delete audio.audioOnly;
    delete audio.trans;
    audio.track = freeLaneAbove([{ ...audio, track: source.kind === 'audio' ? it.track : 'a1' }], null, []);
    clips.push(audio);
  }
  const base = source.kind === 'audio' ? (audio ? [audio] : []) : video;
  const stop = it.start + it.dur;
  let cursor = it.start, gapMedia;
  for (const piece of [...base, { start: stop, dur: 0 }]) {
    if (piece.start - cursor > 1e-6) {
      gapMedia ??= uid();
      P.media[gapMedia] ??= { kind: 'image', name: tr('mcGap'), path: '', fill: true, w: P.w, h: P.h };
      const gap = { media: gapMedia, track: source.kind === 'audio' ? 'v1' : it.track, start: cursor,
        dur: piece.start - cursor, in: 0, hidden: true, muted: true };
      if (source.kind === 'audio') gap.track = freeLaneAbove([gap], null, clips);
      clips.push(gap);
    }
    cursor = piece.start + piece.dur;
  }
  for (const clip of clips) {
    clip.id = uid();
    addTimelineItem(clip, it.grp);
  }
  setSelection(clips.map(i => i.id));
  refresh();
}

$('#binList').addEventListener('contextmenu', e => {
  e.preventDefault();
  const mi = e.target.closest('.mi');
  if (!mi) return ctxMenu(e, [['import', importMedia]]);
  if (!binSel.has(mi.dataset.mid)) { binSel.clear(); binPick(mi.dataset.mid, {}); }
  const ids = picked(), one = ids.length === 1 && P.media[ids[0]];
  const proxy = S.needsProxy(one, 'always'), entry = proxy && proxyEntry(one);
  const inputs = multicamInputs(ids);
  ctxMenu(e, [
    ['addToTl', () => addMany(ids)],
    inputs && ['mcCreate', () => createMulticam(inputs)],
    one?.angles && ['mcSettings', () => editMulticam(ids[0])],
    one && ['rename', () => renameMedia(ids[0])],
    ids.some(id => P.media[id].kind === 'video' && !P.media[id].angles) && ['scenesDetect', () => ids.forEach(id => detectScenes(id))],
    ids.some(sceneBusy) && ['scenesCancel', () => ids.forEach(cancelScenes)],
    one?.path && ['revealFinder', () => TA.opener.revealItemInDir(one.path)],
    proxy && !entry?.file && entry?.progress == null && ['proxyCreate', () => syncMediaProxies(one.path)],
    proxy && entry?.progress != null && ['proxyCancel', () => deleteMediaProxies(one.path, true)],
    proxy && ['proxyDelete', () => deleteMediaProxies(one.path)],
    ['-'],
    [ids.length > 1 ? tr('delN', { n: ids.length }) : 'del', () => deleteMedia(ids), 'danger'],
  ]);
});
async function deleteMedia(ids) {
  if (!ids.length) return;
  const dependents = Object.keys(P.media).filter(id => !ids.includes(id) && P.media[id].angles?.some(a => ids.includes(a.media)));
  ids = [...ids, ...dependents];
  const uses = P.items.filter(i => ids.includes(i.media)).length;
  const notice = dependents.length ? tr('mcDeleteUsed', { n: dependents.length, clips: uses }) : uses && tr('delUsed', { n: uses });
  if (notice && !(await TA.dialog.ask(notice, { kind: 'warning' }))) return;
  snapshot();
  for (const id of ids) delete P.media[id];
  const main = P.items.some(i => !i.grp && i.track === 'v1' && ids.includes(i.media));
  P.items = P.items.filter(i => !ids.includes(i.media));
  if (main) pack();
  binSel.clear();
  refresh();
}
async function renameMedia(id) {
  const name = await askText(tr('rename'), P.media[id].name);
  if (!name || name === P.media[id].name) return;
  snapshot();
  P.media[id].name = name;
  refresh();
}
function askText(title, value) {
  return new Promise(res => {
    $('#modal').hidden = false;
    $('#mBox').innerHTML = `<h3>${esc(title)}</h3><input id="mText" value="${esc(value)}"><div class="acts"><button id="mNo">${tr('cancel')}</button><button class="primary" id="mOk">${tr('ok')}</button></div>`;
    const inp = $('#mText'), done = v => { hideModal(); res(v); };
    inp.select();
    $('#mOk').onclick = () => done(inp.value.trim());
    $('#mNo').onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value.trim()); else if (e.key === 'Escape') done(null); };
  });
}
// Right-click menu. items: [labelKeyOrText, run, 'danger'?] | ['-'] | falsy (skipped)
function ctxMenu(e, items) {
  const m = $('#ctx');
  m.innerHTML = items.filter(Boolean).map((x, i) => x[0] === '-' ? '<hr>' : `<button data-i="${i}" class="${x[2] || ''}">${esc(tr(x[0]))}</button>`).join('');
  const list = items.filter(Boolean);
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + 'px';
  m.onclick = ev => { const b = ev.target.closest('button'); if (!b) return; m.hidden = true; list[+b.dataset.i][1](); };
  setTimeout(() => window.addEventListener('pointerdown', ev => { if (!m.contains(ev.target)) m.hidden = true; }, { once: true }));
}
$('#rows').addEventListener('pointerdown', () => (focusZone = 'tl'), true);
// The lanes sit at the bottom; a drag in the empty space above them selects too
$('#scroll').addEventListener('pointerdown', e => { if (e.target === $('#scroll') && e.button === 0) { focusZone = 'tl'; tlMarquee(e); } });
$('#rows').addEventListener('contextmenu', e => {
  e.preventDefault();
  focusZone = 'tl';
  const c = e.target.closest('.clip');
  if (!c) return ctxMenu(e, [['k_paste', pasteClip], ['marker', addMarker]]);
  const id = c.dataset.id;
  if (!isSel(id)) select(id);
  const it = item(id), m = media(it), vid = !m?.angles && m?.kind === 'video', group = groupInfo(id);
  const inputs = multicamInputs(selIds(), true);
  const canExtract = vid && m.hasAudio && !P.tracks.some(x => x.id === it.track && x.locked);
  ctxMenu(e, [inputs && ['mcCreate', () => createMulticam(inputs, true)],
    m?.angles && ['wsMulticam', () => revealPanel('multicam')],
    m?.angles && !P.tracks.find(x => x.id === it.track)?.locked && ['mcFlatten', () => flattenMulticam(it)],
    isTranslatable(it) && ['translateCaptions', () => openCaptionTranslation(selectedItems())],
    canGroup() && ['groupClips', groupSel], selectedGroups().length && ['ungroupClips', ungroupSel],
    group && ['openGroup', () => showGroup(id)], group && ['rename', () => renameGroup(id)],
    it && ['split', () => splitAt()], vid && ['scenesSplit', () => splitAtScenes(selectedItems())],
    ['k_copy', copySel], ['k_cut', cutSel], ['k_paste', pasteClip], ['dup', duplicateSel],
    vid && ['freeze', freezeFrame], canExtract && ['extractAudio', () => extractAudio(it)],
    canExtract && ['splitAudioEdge', () => { extractAudio(it); setTool('select'); toast(tr('splitAudioEdgeHint')); }],
    !m?.angles && (m?.kind === 'audio' || m?.hasAudio) && ['stems', separateSounds], m && m.kind !== 'audio' && ['rotate90', rotateSel], it && m?.kind !== 'audio' && [it.hidden ? 'showLayer' : 'hideLayer', toggleHidden], ['-'], ['del', removeSel, 'danger']]);
});
$('#rows').addEventListener('dblclick', e => {
  const c = e.target.closest('.k-group');
  if (c && !e.metaKey && !e.ctrlKey && !e.shiftKey) showGroup(c.dataset.id);
});

// The clip's sound as its own clip on a free audio lane under it (same file, same timing); the video goes silent.
function extractAudio(it) {
  const m = it && !isText(it) && media(it);
  if (!m || m.kind !== 'video' || !m.hasAudio) return;
  snapshot();
  let aid = Object.keys(P.media).find(k => P.media[k].path === m.path && P.media[k].kind === 'audio');
  if (!aid) P.media[aid = uid()] = { ...m, kind: 'audio', name: m.name.replace(/\.[^.]+$/, '') + ' · ' + tr('audioWord'), added: Date.now() };
  const end = it.start + it.dur, free = x => !P.items.some(i => i.track === x.id && i.start < end - 1e-6 && it.start < i.start + i.dur - 1e-6);
  let lane = P.tracks.find(x => x.kind === 'audio' && !x.locked && free(x));
  if (!lane) P.tracks.push(lane = { id: 'a' + uid(), kind: 'audio' });
  const a = { id: uid(), track: lane.id, media: aid, start: it.start, dur: it.dur, in: it.in, speed: it.speed, volume: num(it.volume, 1) };
  if (it.afIn) a.fadeIn = it.afIn; // a video's sound fades live in afIn/afOut, an audio clip's in fadeIn/fadeOut
  if (it.afOut) a.fadeOut = it.afOut;
  if (it.pitch != null) a.pitch = it.pitch;
  if (S.hasCurve(it)) a.curve = { ...it.curve, pts: it.curve.pts.map(point => [...point]) };
  if (it.kf?.volume) a.kf = { volume: it.kf.volume.map(key => [...key]) };
  if (it.denoise) a.denoise = it.denoise;
  if (it.voiceClean) a.voiceClean = { ...it.voiceClean };
  if (it.norm) a.norm = it.norm;
  it.muted = true;
  addTimelineItem(a);
  sel = a.id; msel.clear(); inspTab = null;
  dirty = true; refresh(); renderBin();
}

// Voice, music and sound effects of a clip, each on its own audio lane under it (TIGER-DnR, on this computer; model 7 MB once)
let stemsTool = false;
inv('stems_ready').then(v => (stemsTool = v), () => {});
async function separateSounds() {
  const it = sel && item(sel), m = it && !isText(it) && media(it);
  if (!m || m.angles || !(m.kind === 'audio' || m.hasAudio)) return;
  cancelled = false;
  try {
    if (!stemsTool) {
      if (!(await TA.dialog.ask(tr('stemsAsk'), { title: tr('stems') }))) return;
      progress(tr('p_stems_dl'), 0); await stemsModel.download(false);
    }
    progress(tr('p_stems'), 0);
    const paths = await inv('stems_make', { path: m.path, start: num(it.in, 0), len: S.srcLen(it) });
    hideModal();
    const files = await inv('probe', { paths });
    if (item(it.id) !== it) return;
    const mids = addToBin(files);
    if (mids.length !== 3) return;
    snapshot();
    const end = it.start + it.dur, free = x => !P.items.some(i => i.track === x.id && i.start < end - 1e-6 && it.start < i.start + i.dur - 1e-6);
    const base = m.name.replace(/\.[^.]+$/, '');
    mids.forEach((mid, k) => {
      P.media[mid].name = base + ' · ' + tr(['stVoice', 'stMusic', 'stSfx'][k]);
      let lane = P.tracks.find(x => x.kind === 'audio' && free(x));
      if (!lane) P.tracks.push(lane = { id: 'a' + uid(), kind: 'audio' });
      const a = { id: uid(), track: lane.id, media: mid, start: it.start, dur: it.dur, in: 0, speed: it.speed, volume: num(it.volume, 1) };
      const fi = m.kind === 'audio' ? it.fadeIn : it.afIn, fo = m.kind === 'audio' ? it.fadeOut : it.afOut;
      if (fi) a.fadeIn = fi;
      if (fo) a.fadeOut = fo;
      if (it.pitch != null) a.pitch = it.pitch;
      addTimelineItem(a, it.grp || null);
    });
    it.muted = true;
    sel = null; msel.clear(); inspTab = null;
    dirty = true; refresh(); renderBin(); toast(tr('stemsOk'));
  } catch (err) { hideModal(); if (!cancelled) toast(cleanErr(err)); cancelled = false; }
}

/* ---------- apply to all captions ---------- */
// On: a look change on one auto caption (style, animation, place) is copied to every caption; off: each on its own.
const capAllRow = () => `<label class="wide capall"><input type="checkbox" id="capAll"${lsGet('kadr.capAll', true) ? ' checked' : ''}><span>${tr('applyAll')}</span></label>`;
const CAP_OWN = new Set(['id', 'type', 'track', 'grp', 'start', 'dur', 'text', 'words', 'kf', 'hidden']);
function capSync() {
  const it = sel && item(sel);
  if (!it || it.track !== 'c1' || !lsGet('kadr.capAll', true)) return;
  for (const c of P.items) {
    if (c === it || c.track !== 'c1') continue;
    for (const k of Object.keys(c)) if (!CAP_OWN.has(k) && !(k in it)) delete c[k];
    for (const [k, v] of Object.entries(it)) if (!CAP_OWN.has(k)) c[k] = structuredClone(v);
  }
  needsDraw = true; dirty = true;
}
$('#inspBody').addEventListener('change', e => { if (e.target.id === 'capAll') { lsSet('kadr.capAll', e.target.checked); if (e.target.checked) { snapshot(); capSync(); } } });
for (const ev of ['input', 'click']) $('#inspBody').addEventListener(ev, e => { if (e.target.id !== 'capAll') capSync(); });
$('#stage').addEventListener('pointerdown', () => window.addEventListener('pointerup', () => capSync(), { once: true })); // resize / rotate handles too

/* ---------- hide / show layers ---------- */
const hideRow = it => `<button class="wide hidebtn${it.hidden ? ' on' : ''}" id="hideBtn">${icon(it.hidden ? 'eye-off' : 'eye')}${tr(it.hidden ? 'showLayer' : 'hideLayer')}</button>`;
function toggleHidden() {
  const ids = selIds().filter(id => { const i = item(id); return i && (isText(i) || media(i).kind !== 'audio'); });
  if (!ids.length) return;
  snapshot();
  const v = !item(ids[0]).hidden;
  for (const id of ids) { const i = item(id); if (v) i.hidden = true; else delete i.hidden; }
  dirty = true; refresh();
}

/* ---------- transitions pane ---------- */
// The cut a transition goes on: the selected clip if a clip ends right where it starts, else the
// clip right after the selected one, else the main-track cut nearest the playhead.
function transTarget() {
  if (selectedGroups().length) return null;
  const ok = b => b && inTimeline(b) && !isText(b) && media(b) && media(b).kind !== 'audio' && !b.hidden && S.transIn(P, { ...b, trans: { id: 'fade' } });
  const cur = sel && item(sel);
  if (ok(cur)) return cur;
  if (cur) { const nx = P.items.find(i => i.track === cur.track && i.id !== cur.id && Math.abs(i.start - cur.start - cur.dur) < 0.5 / P.fps); if (ok(nx)) return nx; }
  let best = null;
  for (const b of P.items) if (b.track === 'v1' && ok(b) && (!best || Math.abs(b.start - t) < Math.abs(best.start - t))) best = b;
  return best;
}
function renderTrans() {
  const tg = transTarget(), T = tg && S.transIn(P, tg), cur = T ? T.id : 'none';
  $('#transHead').innerHTML = !tg ? `<p class="hint">${tr('trNone')}</p>` :
    `<p class="hint">${tr('trAt', { t: fmt(tg.start) })}</p>` + (T ? `<div class="f"><div class="lb"><span>${tr('dur')}</span><b>${T.d.toFixed(1)}s</b></div>` +
      `<input type="range" id="trDur" min="0.1" max="${Math.min(2, tg.dur).toFixed(2)}" step="0.05" value="${T.d}"></div>` +
      (S.GLT.includes(T.id) ? `<div class="f"><div class="lb"><span>${tr('trDir')}</span></div><div class="seg trseg" style="grid-template-columns:repeat(4,1fr)">${[0, 1, 2, 3].map(d => `<button data-trdir="${d}" class="${d === T.dir ? 'on' : ''}">${d ? d * 90 + '°' : tr('trDir0')}</button>`).join('')}</div></div>` +
        `<div class="f"><div class="lb"><span>${tr('trEase')}</span></div><div class="seg trseg">${MaqtoGLT.EASES.map(k => `<button data-trease="${k}" class="${k === T.ease ? 'on' : ''}">${tr('tre_' + k)}</button>`).join('')}</div></div>` : '') : '');
  if (!TR_CATS.includes(trCat)) trCat = 'hot';
  $('#trCats').innerHTML = TR_CATS.map(c => `<button class="chip${c === trCat ? ' on' : ''}" data-cat="${c}">${tr('trc_' + c)}</button>`).join('');
  const ids = trCat === 'fav' ? favs.tr || [] : trCat === 'hot' ? TR_HOT : trCat === 'basic' ? S.TRANS : MaqtoGLT.ids.filter(x => MaqtoGLT.cat[x] === trCat);
  $('#transCards').innerHTML = favFirst('tr', ['none', ...ids]).map(id => `<button class="trc${id === cur ? ' on' : ''}" data-tr="${id}"${tg ? '' : ' data-off'}>` +
    (S.GLT.includes(id) ? `<i class="tv" style="background-image:url(trstill/${id}.jpg),url(trpics/a.jpg)"><canvas data-gl="${id}" width="320" height="200"></canvas></i>` : `<i class="tv tv-${id}"><b></b></i>`) +
    `<span>${tr('tr_' + id)}</span>${id === 'none' ? '' : `<i class="plus" title="${tr('trApply')}">${icon('plus')}</i>` + favStar('tr', id)}</button>`).join('');
  transThumbs(performance.now() / 1000);
  const d = $('#trDur');
  if (d) {
    paintRange(d);
    d.onpointerdown = () => snapshot();
    d.oninput = () => { tg.trans.dur = +d.value; d.previousElementSibling.lastElementChild.textContent = (+d.value).toFixed(1) + 's'; dirty = true; needsDraw = true; };
    d.onchange = () => { renderTimeline(); previewTrans(tg); };
  }
  $$('#transHead [data-trdir], #transHead [data-trease]').forEach(b => b.onclick = () => {
    snapshot();
    if (b.dataset.trdir) { const v = +b.dataset.trdir; if (v) tg.trans.dir = v; else delete tg.trans.dir; }
    else if (b.dataset.trease === 'lin') delete tg.trans.ease; else tg.trans.ease = b.dataset.trease;
    dirty = true; needsDraw = true; renderTrans(); previewTrans(tg);
  });
}
// Transition cards: the shader ones play on two sample pictures, each card at its own point in the loop.
const TR_CATS = ['fav', 'hot', 'basic', ...MaqtoGLT.CATS];
const TR_HOT = ['lensIn', 'whipL', 'spinZoom', 'glitchBlock', 'flash', 'cubeL', 'swirl', 'leakWarm', 'gallery', 'tiles', 'snap', 'burn', 'shakeCam', 'heart', 'torn', 'rgbSplit', 'fade', 'slideL'];
let trCat = 'hot', trPics = null, trHover = null;
$('#trCats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { trCat = c.dataset.cat; renderTrans(); $('#transCards').scrollTop = 0; } });
// Cards show a ready-made still of each shader transition (trstill/<id>.jpg, made from the two photos in
// trpics/ by stillsDump below), so switching categories compiles nothing. Only the card under the pointer
// plays live. After changing or adding a shader, run stillsDump() in a dev build and save its output there.
function trPair() {
  if (!trPics && trImgs.every(i => i.complete && i.naturalWidth)) trPics = trImgs.map(i => cardCanvas(ctx => ctx.drawImage(i, 0, 0, 240, 180), 320, 200));
  return trPics;
}
// the moment each still shows: earlier for colour wipes and dips to black, which are solid at mid-way
const stillQ = id => ({ blink: 0.15, inkBlack: 0.22, vFadeBlur: 0.2 })[id] || (MaqtoGLT.cat[id] === 'shape' ? 0.2 : 0.4);
function stillsDump() { // -> { id: jpeg data URL }
  const pics = trPair(), out = {};
  for (const id of MaqtoGLT.ids) out[id] = cardCanvas(ctx => ctx.drawImage(GLX.thumb.frame(id, pics[0], pics[1], stillQ(id)), 0, 0, 240, 180), 320, 200).toDataURL('image/jpeg', 0.82);
  return out;
}
function transThumbs(now) {
  const c = trHover, pics = c && trPair();
  if (!pics) return;
  const per = 2.2, q = clamp((now % per) / per * 1.5 - 0.25, 0, 1);
  try { c.getContext('2d').drawImage(GLX.thumb.frame(c.dataset.gl, pics[0], pics[1], q), 0, 0); } catch (e) { console.error(e); }
}
const trUnhover = () => { if (trHover) trHover.getContext('2d').clearRect(0, 0, trHover.width, trHover.height); trHover = null; };
$('#transCards').addEventListener('pointerover', e => {
  const b = e.target.closest('.trc'), c = b && b.querySelector('canvas[data-gl]');
  if (c !== trHover) { trUnhover(); trHover = c; }
});
$('#transCards').addEventListener('pointerleave', trUnhover);
function previewTrans(tg) {
  const T = S.transIn(P, tg);
  if (!T) return;
  setPlaying(false); seek(Math.max(0, tg.start - 0.6)); setPlaying(true);
  clearTimeout(previewTrans.tm);
  previewTrans.tm = setTimeout(() => { if (playing) setPlaying(false); }, (T.d + 1.2) * 1000);
}
$('#transCards').addEventListener('click', e => {
  const b = e.target.closest('[data-tr]'), tg = b && transTarget();
  if (b && !tg) return toast(tr('trNone'));
  if (!tg) return;
  snapshot();
  if (b.dataset.tr === 'none') delete tg.trans;
  else tg.trans = { ...tg.trans, id: b.dataset.tr, dur: num(tg.trans && tg.trans.dur, 0.5) };
  dirty = true;
  select(tg.id); refresh();
  previewTrans(tg);
});
$('#rows').addEventListener('click', e => {
  const b = e.target.closest('.trn');
  if (!b) return;
  select(b.dataset.trn); revealPanel('trans');
});

/* ---------- fill layers pane ---------- */
const LAYERS = {
  shadow: { type: 'linear', c1: '#000000', a1: 0, c2: '#000000', a2: 0.85, x1: 0.5, y1: 0.4, x2: 0.5, y2: 1, mid: 0.5 },
  gradient: { type: 'linear', c1: ACCENT, a1: 1, c2: '#141518', a2: 1, x1: 0, y1: 0, x2: 1, y2: 1, mid: 0.5 },
  vignette: { type: 'radial', c1: '#000000', a1: 0, c2: '#000000', a2: 0.8, x1: 0.5, y1: 0.5, x2: 1, y2: 1, mid: 0.6 },
  solid: { type: 'solid', c1: ACCENT, a1: 1 },
};
function renderLayers() {
  $('#layerCards').innerHTML = Object.keys(LAYERS).map(id => `<button class="trc" data-layer="${id}"><i class="lv"><canvas width="96" height="96"></canvas></i><span>${tr('ly_' + id)}</span><i class="plus" title="${tr('addLayer')}">${icon('plus')}</i></button>`).join('');
  for (const c of $$('#layerCards canvas')) {
    paintFill(c.getContext('2d'), LAYERS[c.closest('[data-layer]').dataset.layer], 96, 96); // the plain layer, as in the old cards
  }
}
function addFill(id) {
  const mid = 'fill_' + uid();
  P.media[mid] = { kind: 'image', fill: true, name: tr('ly_' + id), w: P.w, h: P.h, path: '' };
  const busy = tk => P.items.some(i => i.track === tk && i.start < t + 5 && i.start + i.dur > t);
  let tk = P.tracks.find(x => x.kind === 'video' && x.id !== 'v1' && !busy(x.id));
  if (!tk) { tk = { id: 'v' + uid(), kind: 'video' }; P.tracks.splice(P.tracks.findIndex(x => x.kind === 'video'), 0, tk); } // never stack on a busy lane: new top video track
  const it = addMedia(mid, tk.id, t);
  it.fill = { ...FILL_DEF, ...LAYERS[id] };
  inspTab = 'tVideo';
  refresh();
}
$('#layerCards').addEventListener('click', e => { const b = e.target.closest('[data-layer]'); if (b) addFill(b.dataset.layer); });
/* ---------- sound effects pane ---------- */
let sfxLib = null;
const sfxAudio = new Audio();
async function loadSfx(force) {
  if (!sfxLib || force) { try { sfxLib = await inv('sfx_library'); } catch { sfxLib = []; } }
  const cats = [...new Set(sfxLib.map(s => s.cat))], cur = $('#sfxCat').value;
  $('#sfxCat').innerHTML = `<option value="">${tr('sfxAll')} (${sfxLib.length})</option>` + cats.map(c => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
  renderSfx();
}
function renderSfx() {
  const q = $('#sfxQ').value.trim().toLowerCase(), c = $('#sfxCat').value;
  const list = (sfxLib || []).map((s, i) => [s, i]).filter(([s]) => (!c || s.cat === c) && (!q || (s.name + ' ' + s.cat).toLowerCase().includes(q)));
  $('#sfxList').innerHTML = !sfxLib || !sfxLib.length ? `<p class="hint">${tr('sfxEmpty')}</p>` : list.map(([s, i]) =>
    `<div class="sfx" data-sfx="${i}" title="${esc(s.cat)}"><button class="ib" data-play>${icon(sfxAudio.dataset.i === String(i) && !sfxAudio.paused ? 'pause' : 'play')}</button><span>${esc(s.name)}</span><button class="ib" data-add title="${tr('sfxAdd')}">${icon('plus')}</button></div>`).join('');
}
async function addSfx(s) {
  const [mid] = addToBin(await inv('probe', { paths: [s.path] }));
  const m = mid && P.media[mid];
  if (!m) return;
  const free = P.tracks.filter(x => x.kind === 'audio').map(x => x.id).find(a => !P.items.some(i => i.track === a && i.start < t + m.dur && i.start + i.dur > t)) || 'a2';
  addMedia(mid, free, t);
}
$('#sfxList').addEventListener('click', e => {
  const row = e.target.closest('[data-sfx]'), s = row && sfxLib[+row.dataset.sfx];
  if (!s) return;
  if (e.target.closest('[data-add]')) return addSfx(s);
  if (sfxAudio.dataset.i === row.dataset.sfx && !sfxAudio.paused) sfxAudio.pause();
  else { sfxAudio.src = urlOf(s); sfxAudio.dataset.i = row.dataset.sfx; sfxAudio.play().catch(() => {}); }
  renderSfx();
});
$('#sfxList').addEventListener('dblclick', e => { const row = e.target.closest('[data-sfx]'); if (row) addSfx(sfxLib[+row.dataset.sfx]); });
sfxAudio.onended = sfxAudio.onpause = () => renderSfx();
$('#sfxQ').addEventListener('input', renderSfx);
$('#sfxCat').addEventListener('change', renderSfx);
$('#sfxImport').addEventListener('click', async () => {
  const d = await TA.dialog.open({ directory: true });
  if (!d) return;
  try { const n = await inv('sfx_import', { dir: d }); toast(tr('sfxImported', { n })); loadSfx(true); } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
});

/* ---------- freeze frame & rotate ---------- */
async function freezeFrame() {
  const cur = sel && item(sel);
  const it = cur && !isText(cur) && media(cur).kind === 'video' && active(cur, t) ? cur
    : !selectedGroups().length && timelineItems().find(i => i.track === 'v1' && active(i, t) && media(i).kind === 'video');
  if (!it || media(it).angles) return toast(tr('freezeHint'));
  setPlaying(false);
  const m = media(it), want = num(it.in, 0) + S.srcAt(it, t - it.start);
  let mid;
  try {
    const el = await readVideoFrame(m, want), c = document.createElement('canvas');
    c.width = m.w; c.height = m.h;
    try { c.getContext('2d').drawImage(el, 0, 0, m.w, m.h); }
    finally { releaseVideoFrame(el); }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const path = await inv('save_recording', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-ext': 'png' } });
    [mid] = addToBin(await inv('probe', { paths: [path] }));
  } catch (e) { return toast(tr('error') + ': ' + cleanErr(e)); }
  if (!mid) return;
  snapshot();
  const len = 3, cut = t - it.start;
  if (cut > 1 / P.fps && it.dur - cut > 1 / P.fps) splitItems([it]);
  const fr = JSON.parse(JSON.stringify(it));
  Object.assign(fr, { id: uid(), media: mid, start: t, dur: len, in: 0, speed: 1, fadeIn: 0, fadeOut: 0, volume: 0 });
  delete fr.words;
  if (it.track === 'v1' && magnet && !openGrp) fr.start = t - 1e-4; // sorts before the second half when the main track packs
  else for (const x of timelineItems()) if (x.track === it.track && x.start >= t - 1e-6) x.start += len;
  P.items.push(fr);
  if (fr.track === 'v1') pack();
  setSelection([fr.id]);
  refresh();
}
function rotateSel() {
  const its = visualSel();
  if (!its.length) return;
  snapshot();
  for (const it of its) { const r = num(it.rotate, 0) + 90; it.rotate = r > 180 ? r - 360 : r; }
  refresh();
}
// Stabilize: the source is processed once (video_stab, cached) and the clip switches to the steady copy;
// "remove" switches back. The original stays in the bin.
const stabBusy = new Set();
async function stabilize(it) {
  const m = media(it), from = it.media, lvl = num(it.stabLvl, 2);
  if (stabBusy.has(from)) return;
  stabBusy.add(from); inspector();
  try {
    const path = await inv('video_stab', { path: m.path, level: lvl, toneMap: G.toneMap(m) || null });
    const [id] = addToBin(await inv('probe', { paths: [path] }));
    if (!id) throw new Error('probe');
    P.media[id].name = m.name.replace(/\.[^.]+$/, '') + ' · ' + tr('stabTag');
    snapshot();
    for (const x of P.items) if (x.media === from && (x.id === it.id || msel.has(x.id))) { x.stabFrom = from; x.media = id; }
    dirty = true; toast(tr('stabDone'));
  } catch (e) { toast(tr('stabFail') + ': ' + cleanErr(e)); }
  stabBusy.delete(from);
  refresh();
}
function addToBin(res) {
  const added = [];
  for (const m of res.ok) {
    const have = Object.entries(P.media).find(([, x]) => x.path === m.path && x.kind === m.kind);
    if (have) {
      if (m.kind === 'video') mergeSourceMeta(have[1], m);
      added.push(have[0]); continue;
    }
    const id = uid();
    P.media[id] = { ...m, added: Date.now() };
    dirty = true;
    added.push(id);
    if (m.kind === 'video' && lsGet('kadr.sceneAuto', false)) detectScenes(id, true);
  }
  if (res.bad.length) toast(tr('unsupported') + ': ' + res.bad.join(' · '));
  renderBin();
  syncMediaProxies();
  return added;
}
async function importMedia() {
  const r = await TA.dialog.open({ multiple: true, filters: [{ name: 'Media', extensions: MEDIA_EXT }] });
  if (!r) return;
  addToBin(await inv('probe', { paths: Array.isArray(r) ? r : [r] }));
}
TA.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(async e => {
  const p = e.payload;
  const group = ws && dockGroups.get(W.find(ws.layout, 'media')).el;
  group?.classList.toggle('drop', p.type === 'enter' || p.type === 'over');
  if (ws && p.type === 'drop' && p.paths.length) {
    revealPanel('media');
    addToBin(await inv('probe', { paths: p.paths }));
  }
});

function cardCanvas(paint, w = 240, h = 180) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.scale(w / 240, h / 180);
  paint(ctx);
  return c;
}
function sampleScene(ctx) {
  const g = ctx.createLinearGradient(0, 0, 240, 180);
  g.addColorStop(0, '#f6a35c'); g.addColorStop(0.5, '#d9566b'); g.addColorStop(1, '#3a4fa8');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 240, 180);
  ctx.fillStyle = '#ffe7a8'; ctx.beginPath(); ctx.arc(170, 60, 26, 0, 7); ctx.fill();
  ctx.fillStyle = '#1f2a44'; ctx.beginPath(); ctx.moveTo(0, 180); ctx.lineTo(80, 100); ctx.lineTo(140, 150); ctx.lineTo(200, 110); ctx.lineTo(240, 140); ctx.lineTo(240, 180); ctx.fill();
}
function renderLibCards() {
  const ts = $('#textStyles');
  ts.innerHTML = '';
  for (const id of favFirst('style', TEXT_STYLES.map(x => x.id))) {
    const s = TEXT_STYLES.find(x => x.id === id), b = document.createElement('button');
    b.className = 'card';
    b.dataset.style = s.id;
    b.innerHTML = `<i class="plus" title="${tr('addText')}">${icon('plus')}</i>` + favStar('style', s.id);
    const fake = { text: LANG === 'ar' ? 'ماكتو' : 'Maqto', style: { ...presetStyle(s.id), size: 46, strokeW: (s.s.strokeW || 0) * 0.45, shadowBlur: 8, shadowDist: 5, glowSize: 16 }, x: 0.5, y: 0.5, dur: 9 };
    b.prepend(cardCanvas(ctx => { ctx.fillStyle = '#20262f'; ctx.fillRect(0, 0, 240, 180); drawTextItem(ctx, { w: 240, h: 180 }, fake, 5); }));
    ts.appendChild(b);
  }
  renderLookCards();
  renderStickers();
}
// The selected clip's current picture (cover-cropped to 240x180), or null.
function clipThumb(it = sel && item(sel)) {
  const m = it && !isText(it) && media(it);
  if (!m || m.kind === 'audio' || m.fill || m.adj) return null;
  const src = m.kind === 'image' ? imgFor(m) : els.get(chainKey(it));
  if (!src || (m.kind === 'image' ? !src.naturalWidth : src.readyState < 2)) return null;
  const W = m.w, H = m.h;
  const k = Math.max(240 / W, 180 / H);
  return cardCanvas(ctx => ctx.drawImage(src, (240 - W * k) / 2, (180 - H * k) / 2, W * k, H * k));
}
// Filter and effect cards show the selected clip (or a sample picture) with each look applied.
// Filter and effect cards: the selected clip (or the sample photo) with each look applied, by category.
// Cards are drawn once per picture and kept; the effect card under the pointer plays.
const FX_SHOW = { shake: 0.3, zoomPulse: 0.125, flash: 1 / 6, glitch: 1.1, bounce: 0.3, sway: 0.5, earthquake: 0.2, zoomIn: 2.5, zoomBeat: 0.25,
  drunk: 0.6, wobble: 0.2, wave: 0.1, ripple: 0.3, strobe: 0.05, blackout: 0.5, hueCycle: 0.8, slices: 0.5 };
const FL_HOT = ['warm', 'cool', 'vivid', 'tealOrange', 'clear', 'glow', 'rosy', 'softSkin', 'goldFilm', 'moody', 'blockbuster', 'bw', 'noir', 'faded', 'seventies', 'sunset', 'peachy', 'lofi'];
const FX_HOT = ['shake', 'zoomPulse', 'glitch', 'rgbSplit', 'vhs', 'blur', 'bounce', 'earthquake', 'zoomIn', 'mirror', 'oldFilm', 'strobe', 'swirl', 'grain', 'vignette', 'flash'];
const FL_CATS = ['hot', 'fav', 'basic', 'social', 'film', 'cine', 'portrait', 'life', 'bw', 'retro', 'mood', 'creative'];
const FX_CATS = ['hot', 'fav', ...Object.keys(S.FX_CAT)];
let flCat = 'hot', fxCat = 'hot', fxHover = null;
const lookCache = new Map(), LOOK_W = 168, LOOK_H = 126;
function lookScene() { // [key, 240x180 canvas]
  const it = sel && item(sel), c = clipThumb(it);
  if (c) return ['c' + it.id, c];
  const im = trImgs[0];
  if (im.complete && im.naturalWidth) return ['photo', lookScene.photo || (lookScene.photo = cardCanvas(ctx => ctx.drawImage(im, 13.3, 0, 293.4, 200, 0, 0, 240, 180)))];
  im.addEventListener('load', () => { if (panelVisible('filters') || panelVisible('effects')) renderLookCards(); }, { once: true });
  return ['sample', cardCanvas(sampleScene)];
}
const lookFake = (attr, x) => attr === 'preset' ? { id: 'card:' + x, preset: x } : { id: 'card:' + x, fx: { id: x, a: 0.7 }, dur: 5 };
function renderLookCards() {
  const [key, scene] = lookScene(), it = sel && item(sel);
  fxHover = null;
  if (lookCache.key !== key) { lookCache.clear(); lookCache.key = key; lookScene.cur = scene; }
  const fill = (box, cats, cat, list, attr, cap, on) => {
    cats.innerHTML = (attr === 'preset' ? FL_CATS : FX_CATS).map(c => `<button class="chip${c === cat ? ' on' : ''}" data-cat="${c}">${tr((attr === 'preset' ? 'flc_' : 'fxc_') + c)}</button>`).join('');
    box.innerHTML = '';
    for (const x of favFirst(attr, ['none', ...list])) {
      const b = document.createElement('button');
      b.className = 'card' + (on === x || (x === 'none' && !on) ? ' on' : '');
      b.dataset[attr] = x;
      let c = lookCache.get(attr + x);
      if (!c) {
        c = cardCanvas(x === 'none' ? noneSign : ctx => drawGraded(ctx, lookFake(attr, x), scene, 0, 0, 240, 180, 0, 0, 240, 180, FX_SHOW[x] || 0), LOOK_W, LOOK_H);
        lookCache.set(attr + x, c);
      }
      b.appendChild(c);
      b.insertAdjacentHTML('beforeend', `<span class="cap">${tr(cap + x)}</span>${x === 'none' ? '' : `<i class="plus" data-plus title="${tr('addLayer')}">${icon('plus')}</i>` + favStar(attr, x)}`);
      box.appendChild(b);
    }
  };
  if (!FL_CATS.includes(flCat)) flCat = 'hot';
  const fl = flCat === 'hot' ? FL_HOT : flCat === 'fav' ? favs.preset || [] : Object.keys(S.PRESETS).filter(p => S.PRESETS[p].cat === flCat);
  const fx = fxCat === 'hot' ? FX_HOT : fxCat === 'fav' ? favs.fx || [] : S.FX_CAT[fxCat] || FX_HOT;
  fill($('#filterCards'), $('#flCats'), flCat, fl.filter(p => S.PRESETS[p]), 'preset', 'p_', it && it.preset);
  fill($('#fxCards'), $('#fxCats'), fxCat, fx.filter(f => S.FX.includes(f)), 'fx', 'fx_', it && it.fx && it.fx.id);
}
$('#flCats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { flCat = c.dataset.cat; renderLookCards(); } });
$('#fxCats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { fxCat = c.dataset.cat; renderLookCards(); } });
// the effect card under the pointer plays its effect
function fxThumbs(now) {
  const c = fxHover && fxHover.querySelector('canvas'), x = fxHover && fxHover.dataset.fx;
  if (!c || x === 'none' || !lookScene.cur) return;
  const g = c.getContext('2d');
  g.setTransform(LOOK_W / 240, 0, 0, LOOK_H / 180, 0, 0);
  drawGraded(g, lookFake('fx', x), lookScene.cur, 0, 0, 240, 180, 0, 0, 240, 180, now % 5);
}
$('#fxCards').addEventListener('pointerover', e => {
  const b = e.target.closest('[data-fx]');
  if (b === fxHover) return;
  if (fxHover) { const c = fxHover.querySelector('canvas'), k = lookCache.get('fx' + fxHover.dataset.fx); if (c && k && c !== k) c.replaceWith(k); }
  fxHover = b;
  if (b && b.dataset.fx !== 'none') { const k = b.querySelector('canvas'), c = document.createElement('canvas'); c.width = LOOK_W; c.height = LOOK_H; k.replaceWith(c); }
});
$('#fxCards').addEventListener('pointerleave', () => { if (fxHover) { const c = fxHover.querySelector('canvas'), k = lookCache.get('fx' + fxHover.dataset.fx); if (c && k && c !== k) c.replaceWith(k); } fxHover = null; });
function noneSign(ctx) {
  ctx.fillStyle = '#20262f'; ctx.fillRect(0, 0, 240, 180);
  ctx.strokeStyle = '#ff4d4f'; ctx.lineWidth = 12; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(120, 84, 44, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(89, 115); ctx.lineTo(151, 53); ctx.stroke();
}
// Favourites (star on a card): kept per list in this computer's settings, shown first.
let favs = lsGet('kadr.favs', {});
const isFav = (k, id) => (favs[k] || []).includes(id);
const favFirst = (k, list) => [...list.filter(x => x === 'none'), ...list.filter(x => x !== 'none' && isFav(k, x)), ...list.filter(x => x !== 'none' && !isFav(k, x))];
const favStar = (k, id) => `<i class="fav${isFav(k, id) ? ' on' : ''}" data-favk="${k}" title="${tr('favTip')}">${icon('star')}</i>`;
document.addEventListener('click', e => {
  const st = e.target.closest('[data-favk]');
  if (!st) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const k = st.dataset.favk, id = st.parentElement.dataset[k], l = favs[k] || [];
  favs = { ...favs, [k]: l.includes(id) ? l.filter(x => x !== id) : [...l, id] };
  lsSet('kadr.favs', favs);
  if (k === 'tr') renderTrans(); else if (k === 'style') renderLibCards(); else renderLookCards();
}, true);
function addAdj(kind, id) {
  const mid = 'adj_' + uid();
  P.media[mid] = { kind: 'image', adj: true, name: tr((kind === 'fx' ? 'fx_' : 'p_') + id), w: P.w, h: P.h, path: '' };
  const busy = tk => P.items.some(i => i.track === tk && i.start < t + 3 && i.start + i.dur > t);
  let tk = P.tracks.find(x => x.kind === 'video' && x.id !== 'v1' && !busy(x.id));
  if (!tk) { tk = { id: 'v' + uid(), kind: 'video' }; P.tracks.splice(P.tracks.findIndex(x => x.kind === 'video'), 0, tk); } // new top video track
  const it = addMedia(mid, tk.id, t);
  it.dur = 3;
  if (kind === 'fx') it.fx = { id, a: 0.5 }; else it.preset = id;
  inspTab = 'tVideo';
  refresh();
}
$('#filterCards').addEventListener('click', e => { const pl = e.target.closest('[data-plus]'); if (pl) { e.stopImmediatePropagation(); addAdj('preset', pl.closest('[data-preset]').dataset.preset); } }, true);
$('#fxCards').addEventListener('click', e => {
  const pl = e.target.closest('[data-plus]');
  if (pl) return addAdj('fx', pl.closest('[data-fx]').dataset.fx);
  const c = e.target.closest('[data-fx]'), it = sel && item(sel);
  if (!c) return;
  if (!it || isText(it) || media(it).kind === 'audio') return toast(tr('fxPick'));
  snapshot();
  if (c.dataset.fx === 'none' || (it.fx && it.fx.id === c.dataset.fx)) delete it.fx; // None or a second click removes it
  else it.fx = { id: c.dataset.fx, a: num(it.fx && it.fx.a, 0.5) };
  inspTab = 'tVideo'; dirty = true;
  refresh(); renderLookCards();
});
// Animation grid: every preset plays on a small copy of the clip (or a word for text), looping.
let athumb = { id: null, c: null };
// Animated cards (animations, stickers, icons) sit still on one frame; the card under the pointer plays.
const STILL_T = 0.6;
let hoverCv = null;
document.addEventListener('pointerover', e => {
  const L = e.target.closest?.('#stickerList, #iconList, #inspBody .agrid');
  let b = e.target; while (L && b && b.parentElement !== L) b = b.parentElement;
  const c = L && b ? b.querySelector('canvas') : null;
  if (c === hoverCv) return;
  if (hoverCv) hoverCv._drawn = false; // back to its still frame on the next tick
  hoverCv = c;
});
function animThumbs(now) {
  const B = $('#inspBody').getBoundingClientRect(), it = sel && item(sel);
  // still cards are drawn once (when on screen); only the hovered card moves
  const cs = $$('#inspBody .agrid canvas').filter(c => c === hoverCv || (!c._drawn && (r => r.bottom > B.top && r.top < B.bottom && r.height > 0)(c.getBoundingClientRect())));
  if (!cs.length || !it) return;
  const V = !isText(it);
  if (V && athumb.id !== it.id) athumb = { id: it.id, c: null };
  const pic = V && (athumb.c || (athumb.c = clipThumb(it)) || cardCanvas(sampleScene));
  const real = !V || athumb.c, now0 = now;
  for (const c of cs) {
    now = c === hoverCv ? now0 : STILL_T; c._drawn = !!real;
    const a = c.dataset.a, g = c.getContext('2d'), W = c.width, H = c.height;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(0, 0, W, H);
    if (V) {
      const per = animSub === 'loop' ? 2.4 : 1.6, u = Math.min(1, (now % per) / (per * 0.6));
      const f = animSub === 'in' ? S.VA_IN[a] : animSub === 'out' ? S.VA_OUT[a] : S.VA_LOOP[a] && S.VA_LOOP[a].f;
      if (!f) continue;
      if (S.RICH[animSub].has(a)) { richThumb(g, pic, a, now); continue; }
      const d = animSub === 'loop' ? f(now % per, per) : f(u), s = num(d.s, 1) * 0.62;
      g.translate(W / 2 + (d.dx || 0) * W, H / 2 + (d.dy || 0) * H); g.rotate((d.r || 0) * Math.PI / 180);
      g.globalAlpha = clamp(num(d.o, 1), 0, 1);
      g.drawImage(pic, -W * s / 2, -H * s / 2, W * s, H * s);
    } else {
      const D = 3, fake = { text: LANG === 'ar' ? 'أهلاً' : 'Aa', style: { ...presetStyle('plain'), size: 30 }, x: 0.5, y: 0.5, dur: D, inDur: 0.5, outDur: 0.4,
        anim: animSub === 'in' ? a : 'none', out: animSub === 'out' ? a : 'none', loop: animSub === 'loop' ? a : 'none' };
      const lt = animSub === 'in' ? now % 1.4 : animSub === 'out' ? Math.min(D - 1e-3, D - 0.9 + now % 1.3) : 0.6 + now % 2.4;
      drawTextItem(g, { w: W, h: H }, fake, lt);
    }
  }
}
// A rich animation on the thumbnail: the same channels and compositor as the preview, on a fake 0.62-size clip.
const thumbLayer = document.createElement('canvas');
function richThumb(g, pic, a, now) {
  const W = g.canvas.width, H = g.canvas.height, per = animSub === 'loop' ? 4 : 1.8, D = per * 0.6;
  const fk = { dur: per, inDur: D, outDur: D, anim: animSub === 'in' ? a : 'none', out: animSub === 'out' ? a : 'none', loop: animSub === 'loop' ? a : 'none' };
  const u = Math.min(1, (now % per) / D), lt = animSub === 'in' ? u * D : animSub === 'out' ? Math.min(per - 1e-3, per - D + u * D) : now % per;
  const d = S.vaDelta(fk, lt), q = S.vaFx(fk, lt);
  if (thumbLayer.width !== W || thumbLayer.height !== H) { thumbLayer.width = W; thumbLayer.height = H; }
  const t = thumbLayer.getContext('2d'), cx = W / 2 + d.dx * W, cy = H / 2 + d.dy * H, w = W * 0.62 * num(d.s, 1), h = H * 0.62 * num(d.s, 1);
  t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, W, H); t.globalAlpha = clamp(num(d.o, 1), 0, 1);
  t.translate(cx, cy); t.rotate(d.r * Math.PI / 180); t.drawImage(pic, -w / 2, -h / 2, w, h); t.globalAlpha = 1;
  if (q) MaqtoFx.draw(g, thumbLayer, { x: cx - w / 2, y: cy - h / 2, w, h, r: d.r }, q); else g.drawImage(thumbLayer, 0, 0);
}
// Stickers: emoji placed as text layers, so they scale, animate and export like any text.
const STICKERS = {
  st_react: '😂 😍 🤯 😱 🥳 😎 🤔 😭 🥹 😡 🤩 😴 🙄 😇 🤫 🫡 👏 👍 👎 🙏 💪 👀 🫶 👋',
  st_hot: '🔥 💯 ❤️ 💔 ✨ ⭐ 🌟 💥 💫 ⚡ 🎉 🎊 🎁 🏆 👑 💎 💰 🚀 🎯 📈 💡 🔔 📌 📍',
  st_mark: '➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ 🔴 🟢 🔵 🟡 ⭕ ❌ ✅ ❗ ❓ ⚠️ 🚫 💬 💭 🆕 🆓 🔝 ✔️ 🔊',
  st_life: '☀️ 🌙 🌈 ☁️ 🌊 🌹 🌸 🍀 ☕ 🍕 🍔 🍩 🎂 🍿 🎵 🎬 📸 🎥 🎤 🎮 ⚽ ✈️ 🚗 🏠',
};
/* ---------- icons: Lucide line icons (iconlib.js, 24x24 paths) drawn as text-like layers ----------
   They take the text look: colour/gradient, outline strokes (+ extra), shadows (+ extra), glow, box, every animation,
   plus line width, fill and a self-drawing line (draw: 'in' once, 'loop' draw-hold-erase). */
const ICLIB = window.MaqtoIconLib || {}, iconPaths = new Map(), iconLens = new Map();
const iconPath = n => { if (!iconPaths.has(n)) iconPaths.set(n, new Path2D(ICLIB[n][0])); return iconPaths.get(n); };
function iconLen(n) { // total line length, measured once by the browser
  if (!iconLens.has(n)) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('d', ICLIB[n][0]);
    let L = 60; try { L = e.getTotalLength() || 60; } catch {}
    iconLens.set(n, L);
  }
  return iconLens.get(n);
}
const ease3 = x => x * x * (3 - 2 * x);
function drawProg(it, lt) {
  if (it.draw === 'in') return ease3(clamp(lt / num(it.drawDur, 1.2), 0, 1));
  if (it.draw === 'loop') { const q = (lt % 2.4) / 2.4; return q < 0.45 ? ease3(q / 0.45) : q < 0.8 ? 1 : 1 - ease3((q - 0.8) / 0.2); }
  return 1;
}
function drawIconItem(ctx, pr, it, st, s, lt) {
  const alpha = s.alpha * clamp(num(it.opacity, 1), 0, 1);
  if (alpha <= 0 || !ICLIB[it.icon] || s.sc <= 0 || s.sx <= 0 || s.sy <= 0) return;
  const sz = st.size, k = sz / 24, tk = S.trkAt(it, lt), cx = (num(it.x, 0.5) + tk[0]) * pr.w, cy = (num(it.y, 0.5) + tk[1]) * pr.h;
  const sc = s.sc * num(it.scale, 1), box = sz * 1.2;
  if (ctx === vctx) textBoxes.set(it.id, { cx: cx + s.dx, cy: cy + s.dy, w: box * sc * s.sx, h: box * sc * s.sy, rot: s.rot * 180 / Math.PI + num(it.rotate, 0) });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx + s.dx, cy + s.dy);
  ctx.rotate(s.rot + num(it.rotate, 0) * Math.PI / 180);
  ctx.scale(sc * s.sx, sc * s.sy);
  if (st.bgOn) { // rounded tile behind the icon
    ctx.save(); ctx.globalAlpha = alpha * num(st.bgAlpha, 1); ctx.fillStyle = st.bg; ctx.beginPath();
    ctx.roundRect(-box * 0.62, -box * 0.62, box * 1.24, box * 1.24, box * 1.24 * num(st.bgRadius, 0.22)); ctx.fill(); ctx.restore();
  }
  if (s.wipe < 1 || s.wipeOut > 0) { ctx.beginPath(); ctx.rect(-box + 2 * box * s.wipeOut, -box, 2 * box * (s.wipe - s.wipeOut), 2 * box); ctx.clip(); }
  ctx.translate(-sz / 2, -sz / 2);
  ctx.scale(k, k); // 24-unit icon space from here
  const P2 = iconPath(it.icon), lw = num(st.iconW, 2), fillOn = !!st.iconFillOn, dr = drawProg(it, lt);
  ctx.lineCap = ctx.lineJoin = 'round';
  if (dr < 1) { const L = iconLen(it.icon); ctx.setLineDash([L, L]); ctx.lineDashOffset = L * (1 - dr); }
  const fillA = dr < 1 ? dr * dr : 1;
  const rings = [];
  let rw = st.strokeW > 0 ? st.strokeW : 0;
  for (const q of st.strokes || []) if (q.w > 0) rings.push([rw += +q.w, q.c]);
  const body = (extra, col) => { // the icon's shape widened by `extra` px on each side, in one colour
    ctx.strokeStyle = ctx.fillStyle = col;
    if (fillOn) { ctx.save(); ctx.globalAlpha *= fillA; ctx.fill(P2); ctx.restore(); }
    ctx.lineWidth = lw + extra * 2 / k; ctx.stroke(P2);
  };
  for (const sh of st.shadows || []) { // shadow only: the body sits far off-canvas, its shadow is shifted back
    const m = ctx.getTransform(), OFF = 1e4, d = num(sh.dist, 0) * 0.7;
    ctx.save();
    ctx.shadowColor = sh.c; ctx.shadowBlur = num(sh.blur, 0); ctx.shadowOffsetX = d - OFF * m.a; ctx.shadowOffsetY = d - OFF * m.b;
    ctx.translate(OFF, 0);
    body(rw, sh.c);
    ctx.restore();
  }
  if (st.glowOn) { ctx.save(); ctx.shadowColor = st.glowColor; ctx.shadowBlur = st.glowSize; body(rw, st.glowColor); body(rw, st.glowColor); ctx.restore(); }
  if (st.shadowOn) { ctx.shadowColor = st.shadowColor; ctx.shadowBlur = st.shadowBlur; ctx.shadowOffsetX = ctx.shadowOffsetY = st.shadowDist * 0.7; }
  for (let j = rings.length - 1; j >= 0; j--) { body(rings[j][0], rings[j][1]); ctx.shadowColor = 'transparent'; }
  if (st.strokeW > 0) { body(st.strokeW, st.stroke); ctx.shadowColor = 'transparent'; }
  let col = st.color;
  if (st.gradOn) { col = ctx.createLinearGradient(0, 0, 0, 24); col.addColorStop(0, st.color); col.addColorStop(1, st.fill2); }
  if (fillOn) { ctx.save(); ctx.globalAlpha *= fillA; ctx.fillStyle = st.iconFill || col; ctx.fill(P2); ctx.restore(); }
  ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(P2);
  ctx.restore();
}

// Icon library panel: animated (an icon with a motion) and every icon by category, searchable by name and tags.
const IC_ANIM = [['heart', 'heartbeat'], ['star', 'spinLoop'], ['bell', 'swing'], ['bell-ring', 'shake'], ['thumbs-up', 'popBeat'], ['flame', 'flicker'], ['zap', 'blink'],
  ['rocket', 'float'], ['sparkles', 'breathe'], ['party-popper', 'tada'], ['gift', 'hop'], ['trophy', 'rock'], ['crown', 'float'], ['gem', 'spinLoop'], ['sun', 'spinLoop'],
  ['moon', 'tilt'], ['cloud', 'float'], ['cloud-rain', 'jitter'], ['snowflake', 'spinLoop'], ['umbrella', 'swing'], ['wind', 'wave'], ['loader', 'spinLoop'], ['loader-circle', 'spinLoop'],
  ['refresh-cw', 'spinLoop'], ['settings', 'spinLoop'], ['cog', 'spinLoop'], ['fan', 'spinLoop'], ['hourglass', 'rock'], ['alarm-clock', 'shake'], ['clock', 'pulse'], ['timer', 'pulse'],
  ['phone', 'shake'], ['phone-call', 'jitter'], ['message-circle', 'hop'], ['message-square', 'popBeat'], ['mail', 'bounce'], ['send', 'float'], ['share-2', 'pulse'], ['at-sign', 'spinLoop'],
  ['music', 'float'], ['music-2', 'wiggle'], ['headphones', 'pulse'], ['mic', 'pulse'], ['volume-2', 'zoomBeat'], ['play', 'popBeat'], ['circle-play', 'pulse'], ['video', 'pulse'], ['camera', 'popBeat'],
  ['shopping-cart', 'wiggle'], ['shopping-bag', 'hop'], ['credit-card', 'tilt'], ['wallet', 'jelly'], ['banknote', 'float'], ['coins', 'bounce'], ['piggy-bank', 'jelly'], ['tag', 'swing'], ['percent', 'spinLoop'],
  ['chart-line', 'pulse'], ['trending-up', 'hop'], ['chart-column', 'zoomBeat'], ['target', 'pulse'], ['award', 'swing'], ['medal', 'swing'], ['badge-check', 'popBeat'], ['circle-check', 'popBeat'],
  ['check', 'popBeat'], ['x', 'shake'], ['circle-alert', 'blink'], ['triangle-alert', 'blink'], ['info', 'pulse'], ['circle-help', 'wiggle'], ['lightbulb', 'flicker'], ['key', 'wiggle'], ['lock', 'shake'],
  ['lock-open', 'tada'], ['shield-check', 'breathe'], ['eye', 'blink'], ['search', 'orbit'], ['map-pin', 'hop'], ['navigation', 'float'], ['compass', 'rock'], ['globe', 'spinLoop'], ['plane', 'float'],
  ['car', 'jitter'], ['bike', 'rock'], ['truck', 'jitter'], ['house', 'popBeat'], ['building-2', 'breathe'], ['wifi', 'pulse'], ['bluetooth', 'blink'], ['battery-charging', 'flicker'], ['smartphone', 'wiggle'],
  ['laptop', 'float'], ['monitor', 'breathe'], ['download', 'bounce'], ['upload', 'hop'], ['cloud-download', 'bounce'], ['arrow-down', 'bounce'], ['arrow-up', 'hop'], ['arrow-right', 'wave'],
  ['chevrons-down', 'bounce'], ['chevrons-right', 'wave'], ['mouse-pointer-click', 'popBeat'], ['hand', 'swing'], ['pointer', 'hop'], ['smile', 'jelly'], ['laugh', 'wiggle'], ['frown', 'tilt'],
  ['user', 'breathe'], ['users', 'pulse'], ['baby', 'rock'], ['dog', 'wiggle'], ['cat', 'tilt'], ['fish', 'wave'], ['bird', 'float'], ['bug', 'jitter'], ['leaf', 'swing'], ['flower', 'spinLoop'],
  ['tree-pine', 'swing'], ['coffee', 'float'], ['pizza', 'rock'], ['cake', 'tada'], ['ice-cream-cone', 'wiggle'], ['cookie', 'spinLoop'], ['apple', 'hop'], ['dumbbell', 'jelly'], ['activity', 'pulse'],
  ['heart-pulse', 'heartbeat'], ['stethoscope', 'swing'], ['pill', 'spinLoop'], ['brain', 'breathe'], ['book-open', 'tilt'], ['graduation-cap', 'hop'], ['pencil', 'wiggle'], ['paintbrush', 'swing'],
  ['palette', 'spinLoop'], ['scissors', 'jitter'], ['magnet', 'shake'], ['anchor', 'swing'], ['flag', 'wave'], ['bookmark', 'popBeat'], ['calendar', 'popBeat'], ['briefcase', 'rock']];
const IC_DRAW = ['heart', 'star', 'check', 'circle-check', 'thumbs-up', 'bell', 'mail', 'phone', 'house', 'user', 'map-pin', 'rocket', 'lightbulb', 'shopping-cart', 'camera', 'music',
  'gift', 'crown', 'trophy', 'sparkles', 'sun', 'cloud', 'leaf', 'coffee', 'smile', 'zap', 'flame', 'globe', 'plane', 'award', 'chart-line', 'trending-up', 'message-circle', 'send', 'calendar', 'clock'];
const IC_POP = ['heart', 'star', 'thumbs-up', 'check', 'x', 'plus', 'minus', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'chevron-right', 'house', 'user', 'users', 'phone', 'mail', 'map-pin',
  'search', 'settings', 'bell', 'camera', 'image', 'video', 'music', 'play', 'pause', 'mic', 'message-circle', 'send', 'share-2', 'link', 'download', 'upload', 'calendar', 'clock', 'shopping-cart',
  'shopping-bag', 'credit-card', 'wallet', 'gift', 'tag', 'percent', 'trophy', 'crown', 'flame', 'zap', 'sparkles', 'sun', 'moon', 'cloud', 'globe', 'lock', 'eye', 'smile', 'circle-check',
  'circle-alert', 'info', 'lightbulb', 'rocket', 'coffee', 'pizza', 'car', 'plane', 'wifi', 'smartphone', 'laptop', 'bookmark', 'flag', 'award', 'target', 'chart-line', 'trending-up', 'badge-check'];
const IC_CATS = {
  arrows: /arrow|chevron|move|corner|redo|undo|repeat|refresh|rotate/,
  social: /message|chat|mail|phone|share|send|at-sign|rss|inbox|contact|reply|bell|megaphone|speech|comment/,
  media: /play|pause|music|video|film|camera|image|mic|volume|headphone|speaker|radio|disc|clapper|tv|podcast|cast|record/,
  money: /dollar|euro|pound|coin|wallet|credit|bank|cart|shopping|store|receipt|tag|percent|chart|trending|piggy|bitcoin|briefcase|badge|gift|package/,
  people: /user|person|baby|smile|frown|laugh|meh|angry|hand|heart|thumb|accessibility|contact/,
  weather: /sun|moon|cloud|rain|snow|wind|thermometer|umbrella|rainbow|leaf|tree|flower|sprout|mountain|waves|droplet|flame|zap|sunrise|sunset|star/,
  food: /coffee|cup|pizza|apple|cake|cookie|ice-cream|beer|wine|martini|utensil|sandwich|salad|soup|egg|carrot|cherry|citrus|grape|banana|croissant|popcorn|donut|candy|milk|fish|beef|ham|drumstick|chef/,
  tech: /laptop|monitor|smartphone|tablet|wifi|bluetooth|battery|cpu|server|database|code|terminal|keyboard|mouse|printer|hard-drive|usb|plug|cable|router|cloud|bot|app/,
  travel: /plane|car|bus|train|bike|ship|sailboat|truck|map|compass|globe|navigation|tent|hotel|luggage|ticket|fuel|parking|route|signpost|landmark|castle/,
  shapes: /^(circle|square|triangle|hexagon|octagon|pentagon|diamond|star|heart|shapes|cone|cylinder|cuboid|pyramid|torus|spline)/,
};
const IC_TABS = ['anim', 'draw', 'pop', 'all', ...Object.keys(IC_CATS)];
let icCat = 'anim';
const icSvg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICLIB[n][0]}"/></svg>`;
function renderIcons() {
  const q = ($('#icQ').value || '').trim().toLowerCase(), names = Object.keys(ICLIB);
  $('#icCats').innerHTML = IC_TABS.map(c => `<button class="chip${c === icCat && !q ? ' on' : ''}" data-cat="${c}">${tr('ic_' + c)}</button>`).join('');
  const btn = n => `<button data-ic="${n}" title="${n}">${icSvg(n)}</button>`;
  let h;
  if (q) {
    const hits = names.filter(n => n.includes(q) || ICLIB[n][1].includes(q));
    h = hits.length ? `<div class="stk icl">${hits.map(btn).join('')}</div>` : `<p class="hint">${tr('stNone')}</p>`;
  } else if (icCat === 'anim') h = `<div class="stk stanim">${IC_ANIM.filter(([n]) => ICLIB[n]).map(([n, l]) => `<button data-ic="${n}" data-loop="${l}" title="${n} · ${esc(tr('an_' + l))}"><canvas width="64" height="64"></canvas></button>`).join('')}</div>`;
  else if (icCat === 'draw') h = `<div class="stk stanim">${IC_DRAW.filter(n => ICLIB[n]).map(n => `<button data-ic="${n}" data-draw="loop" title="${n}"><canvas width="64" height="64"></canvas></button>`).join('')}</div>`;
  else if (icCat === 'pop') h = `<div class="stk icl">${IC_POP.filter(n => ICLIB[n]).map(btn).join('')}</div>`;
  else h = `<div class="stk icl">${(icCat === 'all' ? names : names.filter(n => IC_CATS[icCat].test(n))).map(btn).join('')}</div>`;
  $('#iconList').innerHTML = h;
  iconThumbs(performance.now() / 1000);
}
function iconThumbs(now0) {
  for (const c of $$('#iconList canvas')) {
    if (c !== hoverCv && c._drawn) continue;
    const now = c === hoverCv ? now0 : STILL_T; c._drawn = true;
    const b = c.parentElement, g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 64, 64);
    drawTextItem(g, { w: 64, h: 64 }, { text: b.dataset.ic, icon: b.dataset.ic, style: { ...presetStyle('plain'), size: 30, strokeW: 0, color: '#e8ecf1' }, x: 0.5, y: 0.5, dur: 1e4, anim: 'none', out: 'none', loop: b.dataset.loop, draw: b.dataset.draw }, 1 + now % 60);
  }
}
$('#icCats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { icCat = c.dataset.cat; $('#icQ').value = ''; renderIcons(); $('#iconList').scrollTop = 0; } });
$('#icQ').addEventListener('input', () => renderIcons());
$('#iconList').addEventListener('click', e => {
  const b = e.target.closest('[data-ic]');
  if (!b) return;
  snapshot();
  const it = { id: uid(), type: 'text', ...textSlot(3), dur: 3, text: b.dataset.ic, icon: b.dataset.ic,
    style: { ...presetStyle('plain'), size: Math.round(Math.min(P.w, P.h) * 0.3), color: '#ffffff', strokeW: 0, iconW: 2 }, x: 0.5, y: 0.5, anim: 'pop', out: 'fade' };
  if (b.dataset.loop) it.loop = b.dataset.loop;
  if (b.dataset.draw) { it.draw = b.dataset.draw; it.anim = 'none'; }
  addTimelineItem(it);
  sel = it.id; inspTab = null; dirty = true;
  refresh();
});

// Every emoji by group (emoji.js), a search over their English names, and animated stickers: an emoji with a loop.
const ST_ANIM = [['❤️', 'heartbeat'], ['🔥', 'jelly'], ['😂', 'wiggle'], ['🎉', 'tada'], ['⭐', 'spinLoop'], ['👍', 'popBeat'], ['👏', 'jelly'], ['😍', 'pulse'],
  ['💯', 'popBeat'], ['🚀', 'float'], ['✨', 'breathe'], ['👀', 'jitter'], ['😱', 'shake'], ['🤯', 'tada'], ['🥳', 'hop'], ['😎', 'rock'], ['🤔', 'tilt'],
  ['😭', 'wiggle'], ['💥', 'pulse'], ['⚡', 'flicker'], ['🎵', 'float'], ['🎶', 'orbit'], ['💡', 'blink'], ['🔔', 'swing'], ['📌', 'hop'], ['👉', 'orbit'],
  ['⬇️', 'bounce'], ['✅', 'popBeat'], ['❌', 'shake'], ['⚠️', 'blink'], ['💰', 'spinLoop'], ['🏆', 'rock'], ['👑', 'float'], ['💎', 'spinLoop'], ['🎁', 'hop'],
  ['🌟', 'pulse'], ['😴', 'breathe'], ['🙏', 'popBeat'], ['💪', 'jelly'], ['👋', 'swing'], ['🫶', 'heartbeat'], ['🌈', 'float'], ['☀️', 'spinLoop'], ['🍕', 'rock'],
  ['☕', 'float'], ['🎂', 'tada'], ['🎈', 'float'], ['⏰', 'shake'], ['📢', 'pulse'], ['💬', 'hop'], ['❓', 'wiggle'], ['❗', 'popBeat'], ['🤩', 'spinLoop'], ['😡', 'shake']];
const EMOJI = Object.fromEntries(Object.entries(window.MaqtoEmoji || {}).map(([g, s]) => [g, s.split(';').map(x => x.split('|'))]));
const ST_CATS = ['anim', 'hot', ...Object.keys(EMOJI)];
let stCat = 'anim';
const stBtn = (e, loop) => `<button data-st="${e}"${loop ? ` data-loop="${loop}" title="${esc(tr('an_' + loop))}"` : ''}>${loop ? '<canvas width="64" height="64"></canvas>' : e}</button>`;
function renderStickers() {
  const q = ($('#stQ').value || '').trim().toLowerCase();
  $('#stCats').innerHTML = ST_CATS.map(c => `<button class="chip${c === stCat && !q ? ' on' : ''}" data-cat="${c}">${tr('stc_' + c)}</button>`).join('');
  let h;
  if (q) {
    const hits = Object.values(EMOJI).flat().filter(([, n]) => n.includes(q)).slice(0, 400);
    h = hits.length ? `<div class="stk">${hits.map(([e]) => stBtn(e)).join('')}</div>` : `<p class="hint">${tr('stNone')}</p>`;
  } else if (stCat === 'anim') h = `<div class="stk stanim">${ST_ANIM.map(([e, l]) => stBtn(e, l)).join('')}</div>`;
  else if (stCat === 'hot') h = Object.entries(STICKERS).map(([k, v]) => `<div class="gh">${tr(k)}</div><div class="stk">${v.split(' ').map(e => stBtn(e)).join('')}</div>`).join('');
  else h = `<div class="stk">${(EMOJI[stCat] || []).map(([e]) => stBtn(e)).join('')}</div>`;
  $('#stickerList').innerHTML = h;
  stickerThumbs(performance.now() / 1000);
}
function stickerThumbs(now0) {
  for (const c of $$('#stickerList canvas')) {
    if (c !== hoverCv && c._drawn) continue;
    const now = c === hoverCv ? now0 : STILL_T; c._drawn = true;
    const b = c.parentElement, g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 64, 64);
    drawTextItem(g, { w: 64, h: 64 }, { text: b.dataset.st, style: { ...presetStyle('plain'), size: 30 }, x: 0.5, y: 0.5, dur: 1e4, anim: 'none', out: 'none', loop: b.dataset.loop }, 1 + now % 60);
  }
}
$('#stCats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { stCat = c.dataset.cat; $('#stQ').value = ''; renderStickers(); $('#stickerList').scrollTop = 0; } });
$('#stQ').addEventListener('input', () => renderStickers());
$('#stickerList').addEventListener('click', e => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  snapshot();
  const it = { id: uid(), type: 'text', ...textSlot(3), dur: 3, text: b.dataset.st, style: { ...presetStyle('plain'), size: Math.round(Math.min(P.w, P.h) * 0.22) }, x: 0.5, y: 0.5, anim: 'pop', out: 'fade', sticker: true };
  if (b.dataset.loop) it.loop = b.dataset.loop;
  addTimelineItem(it);
  sel = it.id; inspTab = 'tAnim'; dirty = true;
  refresh();
});
$('#textStyles').addEventListener('click', e => { const c = e.target.closest('[data-style]'); if (c) addText(c.dataset.style); });
$('#filterCards').addEventListener('click', e => {
  const c = e.target.closest('[data-preset]'), it = sel && item(sel);
  if (!c) return;
  if (!it || isText(it) || media(it).kind === 'audio') return toast(tr('filtersHint'));
  snapshot();
  it.preset = c.dataset.preset;
  inspTab = 'tAdjust';
  refresh();
});

/* ---------- modal / toast ---------- */
function progress(label, p) {
  if (activeQueueItem) {
    activeQueueItem.progress = tr('rq_rendering', { p: Math.round((p ?? 0) * 100) }) + ' · ' + label;
    $('#rqProgress')?.replaceChildren(activeQueueItem.progress);
    return;
  }
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<div>${esc(label)}${p != null ? ` — ${Math.round(p * 100)}%` : ''}</div><div class="pbar"><i style="width:${Math.round((p || 0) * 100)}%"></i></div><div class="acts"><button id="mCancel">${tr('cancel')}</button></div>`;
  $('#mCancel').onclick = () => exporting ? cancelExport() : (cancelled = true, modalAudioPrep?.abort(), inv('cancel'));
}
let modalAudioPrep;
async function prepareModalAudio(project = P) {
  const abort = new AbortController();
  modalAudioPrep = abort;
  try { await dnPrep(project, abort.signal, p => progress(tr('voiceClean'), p)); }
  finally { if (modalAudioPrep === abort) modalAudioPrep = null; }
}
const hideModal = () => ($('#modal').hidden = true);
async function refreshProxySize() {
  const label = $('#proxyCacheSize');
  if (!label || $('#modal').hidden) return;
  const bytes = await inv('media_proxy_size').catch(() => null);
  if (bytes == null) { label.textContent = '—'; return; }
  const gb = bytes >= 1e9;
  label.textContent = new Intl.NumberFormat(LANG, { style: 'unit', unit: gb ? 'gigabyte' : 'megabyte', maximumFractionDigits: 1 })
    .format(bytes / (gb ? 1e9 : 1e6));
}
function proxySettings() {
  $('#modal').hidden = false;
  $('#mBox').onclick = null;
  $('#mBox').innerHTML = `<h3>${tr('settings')}</h3><div class="proxy-settings">
    <label class="xr"><span>${tr('proxies')}</span><select id="proxyMode">
      <option value="off">${tr('proxyOff')}</option><option value="auto">${tr('proxyAuto')}</option><option value="always">${tr('proxyAlways')}</option></select></label>
    <label class="xr"><span>${tr('proxyQuality')}</span><select id="proxyHigh">
      <option value="false">${tr('proxyStandard')} · 960 px</option><option value="true">${tr('proxyHigh')} · 1280 px</option></select></label>
    <div class="xr"><span>${tr('proxyCache')}</span><bdi id="proxyCacheSize">—</bdi></div>
    </div><div class="acts"><button id="proxyDeleteAll">${tr('proxyDeleteAll')}</button><span class="flex"></span><button id="proxyClose">${tr('close')}</button></div>`;
  $('#proxyMode').value = proxyMode();
  $('#proxyHigh').value = String(proxyHigh());
  const change = (key, value) => {
    $('#proxyMode').disabled = $('#proxyHigh').disabled = $('#proxyDeleteAll').disabled = true;
    setProxyPreference(key, value).finally(() => {
      if ($('#proxyMode')) $('#proxyMode').disabled = $('#proxyHigh').disabled = $('#proxyDeleteAll').disabled = false;
    });
  };
  $('#proxyMode').onchange = e => change('kadr.proxyMode', e.target.value);
  $('#proxyHigh').onchange = e => change('kadr.proxyHigh', e.target.value === 'true');
  $('#proxyDeleteAll').onclick = async e => {
    const button = e.currentTarget;
    $('#proxyMode').disabled = $('#proxyHigh').disabled = button.disabled = true;
    await deleteMediaProxies();
    if ($('#proxyMode')) $('#proxyMode').disabled = $('#proxyHigh').disabled = button.disabled = false;
  };
  $('#proxyClose').onclick = hideModal;
  refreshProxySize();
}
$('#bSettings').onclick = proxySettings;
$('#bProxy').onclick = toggleProxies;
window.addEventListener('focus', () => { if (MEDIA_BASE) syncMediaProxies(); });
TA.event.listen('progress', ({ payload: { label, p } }) => {
  const transfer = aiTransfers.get(label);
  if (transfer?.p != null) {
    transfer.p = p;
    paintAITools();
    if (label === 'upscale_dl' && upscaleTask?.item) paintUpscaleStatus();
    if (label === 'depth_dl' && depthTask) paintDepthStatus();
    const job = captionTranslationJob;
    if (label === 'translation_dl' && job?.update && !job.cancelled && !job.running &&
        transfer.id === 'translation:' + job.direction) job.update(tr('translationDownload'), p);
    if (transfer.inline) return;
  }
  if (label === 'upscale_dl' && upscaleTask?.export) {
    if (!cancelled) progress(tr('upscaleDownload'), p);
    return;
  }
  if (label === 'export' ? exporting && !cancelled : !queueRunning) progress(tr('p_' + label), p);
});

/* ---------- auto update (GitHub Releases, signed) ---------- */
/* ---------- updates: auto (download quietly, install on restart or quit) or manual (button only) ---------- */
const updMode = {
  get() { try { return localStorage.getItem('kadr.updMode') || 'auto'; } catch { return 'auto'; } },
  set(v) { try { localStorage.setItem('kadr.updMode', v); } catch {} },
};
let updReady = null; // downloaded, waiting to be installed
const updLog = e => inv('dev_log', { msg: 'update: ' + e });
async function autoUpdate() {
  if (!TA.updater || updMode.get() !== 'auto') return;
  try {
    const u = await TA.updater.check();
    if (!u) return;
    await u.download();
    updReady = u;
    $('#bUpd').classList.add('dot');
    updPrompt(u);
  } catch (e) { updLog(e); } // offline or no release yet (no update: say nothing)
}
// Auto mode: once the new version is downloaded, ask in a small centred window (after any open dialog closes)
function updPrompt(u) {
  if (!$('#modal').hidden) return setTimeout(() => updPrompt(u), 2000);
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<div class="upd unew"><div class="uic">${icon('sparkles')}</div><h3>${tr('updPromptT')}</h3>
    <p>${tr('updPromptB', { v: `<bdi>v${esc(u.version)}</bdi>` })}</p>${u.body ? `<p class="hint unotes">${esc(u.body)}</p>` : ''}
    <div class="acts"><button id="uLater">${tr('updLater')}</button><span class="flex"></span><button class="primary" id="uNow">${icon('refresh-cw')}${tr('updNow')}</button></div></div>`;
  paintIcons($('#mBox'));
  $('#uLater').onclick = hideModal; // still installs when the app quits
  $('#uNow').onclick = () => { hideModal(); installNow(); };
}
async function installNow() {
  if (!updReady) return;
  if (dirty && (await TA.dialog.ask(tr('updSaveFirst'), { title: tr('updates'), kind: 'warning' }))) { await save(); if (dirty) return; }
  setPlaying(false);
  progress(tr('p_install'), null);
  try { await updReady.install(); await TA.process.relaunch(); } catch (e) { hideModal(); toast(String(e)); }
}
// Quitting with an update downloaded installs it on the way out.
async function quitNow() {
  if (updReady) { progress(tr('p_install'), null); try { await updReady.install(); } catch (e) { updLog(e); } }
  inv('quit_app');
}
async function updateDialog() {
  const cur = TA.app ? await TA.app.getVersion().catch(() => '') : '';
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<div class="upd"><h3>${tr('updates')}</h3><p class="hint">${tr('curVer')} <bdi>v${esc(cur)}</bdi></p>
    <div id="uState" class="ustate"></div>
    <div class="umode"><div class="gh">${tr('updHow')}</div>
      ${['auto', 'manual'].map(m => `<label class="uopt"><input type="radio" name="um" value="${m}"${updMode.get() === m ? ' checked' : ''}><span><b>${tr('upd_' + m)}</b><small>${tr('upd_' + m + 'Hint')}</small></span></label>`).join('')}</div>
    <div class="acts"><button id="uCheck">${icon('refresh-cw')}${tr('updCheck')}</button><button id="uWhats">${icon('sparkles')}${tr('wnTitle')}</button><span class="flex"></span><button id="uClose">${tr('close')}</button><button class="primary" id="uGo" hidden></button></div></div>`;
  paintIcons($('#mBox'));
  $('#mBox').querySelectorAll('[name="um"]').forEach(r => (r.onchange = () => updMode.set(r.value)));
  $('#uClose').onclick = hideModal;
  $('#uWhats').onclick = () => {
    const entries = whatsNewEntries(cur);
    hideModal();
    $('#bUpd').focus();
    showWhatsNew(MaqtoWhatsNew.replaySteps(entries, cur), entries.at(-1)?.version, cur);
  };
  const st = $('#uState'), go = $('#uGo');
  const show = (html, btn, run) => { st.innerHTML = html; go.hidden = !btn; if (btn) { go.textContent = btn; go.disabled = false; go.onclick = run; } };
  const chk = $('#uCheck');
  chk.onclick = () => check();
  if (updReady) return show(`<p>${tr('updReady', { v: esc(updReady.version) })}</p>`, tr('updRestart'), installNow);
  check();
  // "Check for updates" button: asks the update server now, every time it is pressed
  async function check() {
  chk.disabled = true; chk.classList.add('busy');
  show(`<p class="hint">${tr('updChecking')}</p>`);
  if (!TA.updater) { chk.disabled = false; chk.classList.remove('busy'); return show(`<p class="hint">${tr('updNoUpdater')}</p>`); }
  let u;
  try { u = await TA.updater.check(); } catch (e) { updLog(e); u = false; }
  if (!$('#uCheck')) return; // dialog closed meanwhile
  chk.disabled = false; chk.classList.remove('busy');
  const when = `<small class="uwhen">${tr('updLast')} ${new Date().toLocaleTimeString(LANG === 'ar' ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit' })}</small>`;
  if (u === false) return show(`<p>${tr('updOffline')}</p>${when}`);
  if (!u) return show(`<p class="ok">${icon('check')} ${tr('updLatest')}</p>${when}`);
  const notes = u.body ? `<p class="hint unotes">${esc(u.body)}</p>` : '';
  show(`<p><b>${tr('updNew', { v: esc(u.version) })}</b></p>${notes}`, tr('updGet'), async () => {
    go.disabled = true;
    let total = 0, got = 0;
    st.insertAdjacentHTML('beforeend', `<div class="pbar"><i id="uBar"></i></div>`);
    try {
      await u.download(ev => {
        if (ev.event === 'Started') total = ev.data.contentLength || 0;
        else if (ev.event === 'Progress') { got += ev.data.chunkLength; if (total) $('#uBar').style.width = Math.round(got / total * 100) + '%'; }
      });
      updReady = u;
      $('#bUpd').classList.add('dot');
      installNow();
    } catch (e) { updLog(e); show(`<p>${tr('updFailed')}</p>`, tr('retry'), updateDialog); }
  });
  }
}
$('#bUpd').onclick = updateDialog;
/* ---------- What's new ---------- */
const whatsNewDialog = $('#whatsNew');
const whatsNewEntries = cur => MaqtoWhatsNew.WHATS_NEW
  .filter(e => cur && MaqtoWhatsNew.cmp(e.version, cur) <= 0)
  .sort((a, b) => MaqtoWhatsNew.cmp(a.version, b.version));
function showWhatsNew(steps, version, current) {
  if (!steps.length || whatsNewDialog.open) return;
  const list = $('#wnFeatures'), detail = $('#wnDetail'), prev = $('#wnPrev'), next = $('#wnNext');
  let index = 0;
  $('#wnHeading').textContent = tr('wnHeading', { v: version });
  list.innerHTML = steps.map((step, i) => `<button type="button" data-step="${i}">${icon(step.icon)}<span>${esc(step[LANG].title)}</span></button>`).join('');
  function select(i, focus = false) {
    index = clamp(i, 0, steps.length - 1);
    const step = steps[index], content = step[LANG];
    for (const [j, button] of [...list.children].entries()) {
      button.setAttribute('aria-pressed', j === index);
      button.tabIndex = j === index ? 0 : -1;
    }
    detail.innerHTML = `<div class="wn-art">${step.art}</div><h3>${esc(content.title)}</h3><p>${esc(content.body)}</p>
      <div class="wn-location"><div><strong>${tr('wnWhere')}</strong><div>${esc(step.where[LANG])}</div></div>
      <button type="button" class="primary" id="wnShow">${tr('wnShow')}</button></div>`;
    $('#wnShow').onclick = () => { whatsNewDialog.close(); showWhatsNewTarget(step); };
    $('#wnCount').textContent = tr('wnStep', { i: index + 1, n: steps.length });
    prev.disabled = index === 0;
    next.disabled = index === steps.length - 1;
    if (focus) list.children[index].focus({ preventScroll: true });
    if (whatsNewDialog.open) list.children[index].scrollIntoView({ block: 'nearest' });
    detail.scrollTop = 0;
  }
  list.onclick = e => {
    const button = e.target.closest('[data-step]');
    if (button) select(+button.dataset.step, true);
  };
  prev.onclick = () => select(index - 1, index === 1);
  next.onclick = () => select(index + 1, index === steps.length - 2);
  $('#wnClose').setAttribute('aria-label', tr('close'));
  $('#wnClose').onclick = () => whatsNewDialog.close();
  whatsNewDialog.onkeydown = e => {
    e.stopPropagation();
    const rtl = LANG === 'ar';
    if (e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
      e.preventDefault(); select(index + 1, true);
    } else if (e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      e.preventDefault(); select(index - 1, true);
    }
  };
  whatsNewDialog.onclose = () => markWhatsNewSeen(current);
  select(0);
  whatsNewDialog.showModal();
  list.firstElementChild.focus();
}
function showWhatsNewTarget(step) {
  if (step.id === 'interchange') return exportTimelineDialog();
  if (step.panel) revealPanel(step.panel);
  if (step.id === 'fonts' && sel && item(sel) && isText(item(sel))) { inspTab = 'tText'; inspector(); }
  const control = step.target && $(step.target);
  const target = control?.getClientRects().length ? control : null;
  const el = target || (step.panel && dockPanels[step.panel]);
  if (el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.wnPulse?.cancel();
    const accent = getComputedStyle(el).getPropertyValue('--accent').trim();
    const colors = matchMedia('(prefers-reduced-motion: reduce)').matches ? [accent, accent] : [accent, 'transparent', accent, 'transparent'];
    el.wnPulse = el.animate(colors.map(outlineColor => ({ outline: `2px solid ${outlineColor}`, outlineOffset: '-2px' })), 1500);
  }
  if (!target) toast(step.where[LANG]);
}
function markWhatsNewSeen(current) {
  const seen = lsGet(seenVersionKey, '');
  if (!seen || MaqtoWhatsNew.cmp(current, seen) > 0) lsSet(seenVersionKey, current);
}
async function initWhatsNew() {
  const cur = TA.app ? await TA.app.getVersion().catch(() => '') : '';
  if (!cur) return;
  const { whatsNewFrom, pendingSteps } = MaqtoWhatsNew, entries = whatsNewEntries(cur);
  const from = whatsNewFrom(lsGet(seenVersionKey, ''), hasOldMaqtoState, entries);
  const steps = pendingSteps(entries, from, cur);
  if (!steps.length) return markWhatsNewSeen(cur);
  await new Promise(r => setTimeout(r, 1500));
  while (!$('#modal').hidden || document.querySelector('dialog[open]')) {
    if (MaqtoWhatsNew.cmp(lsGet(seenVersionKey, ''), cur) >= 0) return;
    await new Promise(r => setTimeout(r, 800));
  }
  if (MaqtoWhatsNew.cmp(lsGet(seenVersionKey, ''), cur) < 0) showWhatsNew(steps, entries.at(-1).version, cur);
}
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  const tl = dockPanels.tl.getBoundingClientRect();
  const overTimeline = tl.bottom >= innerHeight - PANEL_GAP && tl.top > 100 && tl.left <= innerWidth / 2 && tl.right >= innerWidth / 2;
  el.style.bottom = (20 + (overTimeline ? innerHeight - tl.top : 0)) + 'px';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.run; el.appendChild(b); }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 8000 : 4500);
}

/* ---------- export ---------- */
// Adjacent text tracks (no video between them) are rasterized together; each group keeps its place in the stack.
function textGroups(Q) {
  const out = [];
  let cur = null;
  for (const x of Q.tracks.filter(x => x.kind !== 'audio').reverse()) {
    if (x.kind !== 'text') { cur = null; continue; }
    if (!cur) out.push(cur = []);
    cur.push(x.id);
  }
  return out;
}
async function rasterizeTexts(Q, work, tracks = null, pre = 'f') {
  const texts = Q.items.filter(i => isText(i) && !i.hidden && (!tracks || tracks.includes(i.track)));
  if (!texts.length) return null;
  await Promise.all([...new Set(texts.map(i => `${i.style.weight} 40px "${i.style.font}"`))].map(f => document.fonts.load(f).catch(() => {})));
  const c = document.createElement('canvas');
  c.width = Q.w; c.height = Q.h;
  const ctx = c.getContext('2d');
  const N = Math.ceil(S.projectDur(Q) * Q.fps), list = [];
  let last = null;
  for (let f = 0; f < N; f++) {
    if (cancelled) throw new Error(tr('cancelled'));
    const time = f / Q.fps, vis = visibleTexts(Q, time).filter(i => !tracks || tracks.includes(i.track));
    const key = vis.map(it => { const s = textState(it, time - it.start); return it.id + (s.anim || it.trk || S.hasKf(it) ? 'a' + f : 'w' + s.word); }).join('|');
    if (key === last) { list[list.length - 1].frames++; continue; }
    last = key;
    ctx.clearRect(0, 0, Q.w, Q.h);
    for (const it of vis) drawTextItem(ctx, Q, it, time - it.start);
    const name = pre + String(list.length).padStart(5, '0') + '.png';
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await inv('write_frame', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-id': String(work.id), 'x-name': name } });
    list.push({ name, frames: 1 });
    if (list.length % 8 === 0) progress(tr('p_texts'), f / N);
  }
  return list;
}

// Frames of a video clip at the given local times, decoded by ffmpeg (exact, unlike seeking a <video>).
async function clipFrames(it, lts) {
  return framesAt(media(it), lts.map(lt => num(it.in, 0) + S.srcAt(it, clamp(lt, 0, it.dur))));
}
// Source frames of a video at source times `at` (seconds), as canvases.
async function framesAt(m, at, limit = 1280) {
  const s0 = Math.min(...at), span = Math.max(...at) - s0, sc = Math.min(1, limit / Math.max(m.w, m.h));
  const w = Math.max(2, Math.round(m.w * sc / 2) * 2), h = Math.max(2, Math.round(m.h * sc / 2) * 2);
  const rate = span > 1e-3 ? clamp(at.length / span, 1, 120) : 30, st = Math.max(0, s0 - 0.2); // start early: a seek right at the end of a file returns nothing
  const vf = [G.toneMap(m), `fps=${rate.toFixed(3)}`, `scale=${w}:${h}`].filter(Boolean);
  const buf = new Uint8Array(await inv('gray_frames', { args: ['-v', 'error', '-ss', st.toFixed(3), '-i', m.path, '-an', '-t', String(s0 - st + span + 2 / rate),
    '-vf', vf.join(','), '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'] }));
  const N = Math.floor(buf.length / (w * h * 4));
  if (!N) throw new Error(tr('trk_noVideo'));
  const cache = new Map();
  return at.map(a => {
    const i = clamp(Math.round((a - st) * rate), 0, N - 1);
    if (!cache.has(i)) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; c._w = w;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, i * w * h * 4, w * h * 4), w, h), 0, 0);
      cache.set(i, c);
    }
    return cache.get(i);
  });
}
// Rasterized transitions and animations sample the same derived matte as the FFmpeg graph.
async function objectFramesAt(project, it, times) {
  const m = media(it, project), mt = objectMode(it) !== 'fill' && objectMatteState(it, m)?.matte;
  if (!mt) return [];
  const last = Math.round((mt.last - mt.origin) * mt.fps);
  const indices = times.map(time => m.kind === 'image' ? 0 : clamp(Math.floor((time - mt.origin) * mt.fps + .0001), 0, last));
  const unique = [...new Set(indices)].sort((a, b) => a - b), first = unique[0];
  const seek = (Math.max(0, first - .1) / mt.fps).toFixed(8);
  const select = unique.map(i => `eq(n,${i - first})`).join('+');
  const rgba = new Uint8ClampedArray(await inv('gray_frames', { args: ['-v', 'error', '-ss', seek, '-i', mt.path,
    '-vf', `select='${select}'`, '-vsync', '0', '-frames:v', String(unique.length), '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'] }));
  const size = mt.w * mt.h * 4;
  if (rgba.length !== unique.length * size) throw new Error(tr('samCacheMissing'));
  const frames = new Map();
  unique.forEach((n, i) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: mt.w, height: mt.h });
    canvas.getContext('2d').putImageData(new ImageData(rgba.subarray(i * size, (i + 1) * size), mt.w, mt.h), 0, 0);
    frames.set(n, canvas);
  });
  return indices.map(n => frames.get(n));
}
function setObjectRaster(project, frames) {
  if (frames.some(([, frame]) => frame)) objectRaster.set(project, new Map(frames));
  else objectRaster.delete(project);
}
// Shader transitions for the export: each one's frames as PNGs, overlaid just above its track.
async function decodedFill(cache, time) {
  const image = fillImage(cache, fillIndex(cache, time));
  await image.decode();
  return image;
}
const depthLastFrame = visual => (Math.max(1, Math.ceil(visual.dur * visual.fps - 1e-6)) - 0.5) / visual.fps;
function preparedRaster(it, m, times, visuals, localTimes) {
  const visual = visuals[it.id];
  if (!visual) return [m, times, 1280];
  const last = visual.depth ? depthLastFrame(visual) : Math.max(0, visual.dur - 1 / (visual.fps || 30));
  const seek = visual.animatedStill ? localTimes : times.map(time => time - num(it.in, 0));
  return [visual, seek.map(time => clamp(time, 0, last)), 2160];
}
async function renderGlTrans(project, work, fps, fills, visuals) {
  const out = [], c = document.createElement('canvas');
  c.width = project.w; c.height = project.h;
  const ctx = c.getContext('2d'), png = async name => {
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await inv('write_frame', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-id': String(work.id), 'x-name': name } });
  };
  const list = project.items.filter(b => b.trans && S.GLT.includes(b.trans.id) && S.transIn(project, b));
  for (const [gi, b] of list.entries()) {
    if (cancelled) throw new Error(tr('cancelled'));
    const T = S.transIn(project, b);
    const a = T.prev, N = Math.max(1, Math.round(T.d * fps)), t0 = b.start - T.d / 2, times = Array.from({ length: N }, (_, f) => t0 + f / fps);
    progress(tr('p_trans'), gi / list.length);
    const am = media(a, project), bm = media(b, project);
    const aEnd = a.start + a.dur;
    const transitionFrames = async (it, m, sourceTimes) => {
      if (fills[it.id]) return [];
      if ((visuals[it.id] || m).kind === 'image' && !m.fill && !m.adj) {
        const image = imgFor(visuals[it.id] || m);
        await image.decode();
        return sourceTimes.map(() => image);
      }
      return (visuals[it.id] || m).kind === 'video' && !m.fill
        ? framesAt(...preparedRaster(it, m, sourceTimes, visuals, times.map(time => time - it.start))) : [];
    };
    const [fa, fb] = await Promise.all([
      transitionFrames(a, am, times.map(x => x < aEnd ? objectSourceTime(a, x - a.start) : tailSrcAt(a, x - aEnd, am))),
      transitionFrames(b, bm, times.map(x => x >= b.start ? objectSourceTime(b, x - b.start) : headSrcAt(b, x - b.start))),
    ]);
    const [ma, mb] = await Promise.all([
      objectFramesAt(project, a, times.map(x => objectSourceTime(a, x - a.start))),
      objectFramesAt(project, b, times.map(x => objectSourceTime(b, x - b.start))),
    ]);
    const names = [];
    for (let f = 0; f < N; f++) {
      if (cancelled) throw new Error(tr('cancelled'));
      ctx.clearRect(0, 0, project.w, project.h);
      const [srcA, srcB] = await Promise.all([
        fills[a.id] ? decodedFill(fills[a.id], objectSourceTime(a, times[f] - a.start)) : fa[f],
        fills[b.id] ? decodedFill(fills[b.id], objectSourceTime(b, times[f] - b.start)) : fb[f],
      ]);
      setObjectRaster(project, [[a.id, ma[f]], [b.id, mb[f]]]);
      try { drawGlTrans(ctx, { id: T.id, dir: T.dir, ease: T.ease, a, b, q: f / N }, times[f], srcA, srcB, project); }
      finally { objectRaster.delete(project); }
      const name = `x${gi}_${String(f).padStart(4, '0')}.png`;
      await png(name); names.push({ name, frames: 1 });
    }
    ctx.clearRect(0, 0, project.w, project.h);
    await png(`x${gi}_end.png`); names.push({ name: `x${gi}_end.png`, frames: 1 }); // clear frame: nothing stays on top after it
    out.push({ track: b.track, start: t0, path: await inv('write_work', new TextEncoder().encode(G.concatText(names, fps)), { headers: { 'x-id': String(work.id), 'x-name': 'trans' + gi + '.ffconcat' } }) });
  }
  return out;
}

// Rich animations (anims.js): their stretches are drawn with the preview code and laid over the clip's track as PNG frames;
// the graph hides the clip itself over the same frames (S.richSegs / S.segFrames).
async function renderRich(project, work, fps, fills, visuals) {
  const out = [], c = document.createElement('canvas');
  c.width = project.w; c.height = project.h;
  const ctx = c.getContext('2d');
  const list = project.items.filter(b => !b.audioOnly && !isText(b) && media(b, project) && media(b, project).kind !== 'audio' && !media(b, project).adj && S.richSegs(b).length);
  const png = async name => { const blob = await new Promise(r => c.toBlob(r, 'image/png')); await inv('write_frame', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-id': String(work.id), 'x-name': name } }); };
  for (const [gi, b] of list.entries()) {
    const m = media(b, project), visual = visuals[b.id] || m, isV = visual.kind === 'video' && !m.fill;
    const image = !fills[b.id] && visual.kind === 'image' && !m.fill ? imgFor(visual) : null;
    if (image) await image.decode();
    for (const [si, sg] of S.richSegs(b).entries()) {
      const N = S.segFrames(sg, fps), names = [];
      const batch = visuals[b.id] ? 16 : 60;
      for (let f0 = 0; f0 < N; f0 += batch) { // decode in batches: a long loop would not fit in memory at once
        if (cancelled) throw new Error(tr('cancelled'));
        const fs = Array.from({ length: Math.min(batch, N - f0) }, (_, i) => sg[0] + (f0 + i) / fps);
        const times = fs.map(lt => objectSourceTime(b, Math.min(lt, b.dur - .001)));
        const [fr, masks] = await Promise.all([
          !fills[b.id] && isV ? framesAt(...preparedRaster(b, m, times, visuals, fs)) : [],
          objectFramesAt(project, b, times),
        ]);
        for (const [i, lt] of fs.entries()) {
          if (cancelled) throw new Error(tr('cancelled'));
          progress(tr('p_anim'), (gi + (f0 + i) / N) / list.length);
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, project.w, project.h);
          const src = fills[b.id] ? await decodedFill(fills[b.id], times[i]) : image || fr[i];
          setObjectRaster(project, [[b.id, masks[i]]]);
          try { drawItem(ctx, b, b.start + lt, null, src, false, false, project); }
          finally { objectRaster.delete(project); }
          const name = `r${gi}_${si}_${String(f0 + i).padStart(5, '0')}.png`;
          await png(name); names.push({ name, frames: 1 });
        }
      }
      ctx.clearRect(0, 0, project.w, project.h);
      const end = `r${gi}_${si}_end.png`;
      await png(end); names.push({ name: end, frames: 1 }); // clear frame: nothing stays on top after it
      out.push({ track: b.track, start: b.start + sg[0], path: await inv('write_work', new TextEncoder().encode(G.concatText(names, fps)), { headers: { 'x-id': String(work.id), 'x-name': `rich${gi}_${si}.ffconcat` } }) });
    }
  }
  return out;
}

const RES = [['720p', 720], ['1080p', 1080], ['2K', 1440], ['4K', 2160]];
/* ---------- new project / welcome ---------- */
const FORMATS = [ // [ratio, label key, platforms]
  ['9:16', 'f_vertical', 'TikTok · Reels · Shorts'], ['16:9', 'f_wide', 'YouTube'], ['1:1', 'f_square', 'Instagram · Facebook'],
  ['4:5', 'f_portrait', 'Instagram'], ['4:3', 'f_classic', 'TV · iPad'], ['3:4', 'f_classicV', 'Pinterest'], ['21:9', 'f_cinema', 'Cinema'],
];
function dimsFor(ratio) { // short side 1080, even numbers
  const [a, b] = ratio.split(':').map(Number), even = v => Math.round(v / 2) * 2;
  return a >= b ? [even(1080 * a / b), 1080] : [1080, even(1080 * b / a)];
}
const recent = {
  get() { try { return JSON.parse(localStorage.getItem('kadr.recent') || '[]'); } catch { return []; } },
  add(f) { try { localStorage.setItem('kadr.recent', JSON.stringify([f, ...recent.get().filter(x => x !== f)].slice(0, 12))); } catch {} },
  // off the start screen only: the project file itself stays on disk
  remove(f) { try { localStorage.setItem('kadr.recent', JSON.stringify(recent.get().filter(x => x !== f))); localStorage.removeItem('kadr.rmeta:' + f); } catch {} },
  meta(f) { try { return JSON.parse(localStorage.getItem('kadr.rmeta:' + f) || 'null'); } catch { return null; } },
  // a 200px still of the preview + save time + length, shown on the start screen
  snap(f) {
    try {
      const k = 200 / Math.max(view.width, view.height), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(view.width * k)); c.height = Math.max(1, Math.round(view.height * k));
      c.getContext('2d').drawImage(view, 0, 0, c.width, c.height);
      localStorage.setItem('kadr.rmeta:' + f, JSON.stringify({ img: c.toDataURL('image/jpeg', 0.7), t: Date.now(), dur: S.projectDur(P), w: P.w, h: P.h }));
    } catch {}
  },
};
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? tr('justNow') : m < 60 ? m + ' ' + tr('minAgo') : m < 1440 ? Math.round(m / 60) + ' ' + tr('hrAgo') : new Date(ms).toLocaleDateString(LANG === 'ar' ? 'ar-EG' : 'en-GB'); };
const mmss = d => { d = Math.round(d || 0); return String(d / 60 | 0).padStart(2, '0') + ':' + String(d % 60).padStart(2, '0'); };
async function newProj(welcome) {
  if (!welcome && dirty && !(await TA.dialog.ask(tr('unsaved'), { kind: 'warning' }))) return;
  setPlaying(false);
  let ratio = '9:16', fps = 30, res = 1080;
  const rec = welcome ? recent.get() : [], hasRec = welcome && !!lsGet('kadr.recovery', 0);
  const shape = r => { const [a, b] = r.split(':').map(Number), k = 30 / Math.max(a, b); return `<i class="shape" style="width:${a * k}px;height:${b * k}px"></i>`; };
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<div class="npx">
    <div class="np-head"><h3>${tr(welcome ? 'welcome' : 'k_new')}</h3>${welcome ? `<p class="hint">${tr('welcomeSub')}</p>` : ''}</div>
    <div class="np-grid">${FORMATS.map(([r, k, pl]) => `<button class="fmt${r === ratio ? ' on' : ''}" data-r="${r}">${shape(r)}<b>${r}</b><span>${tr(k)}</span><small>${pl}</small></button>`).join('')}
      <button class="fmt" data-r="custom"><i class="shape dash" style="width:26px;height:26px"></i><b>${tr('custom')}</b><span dir="ltr"><input id="npW" type="number" value="1080" min="16" max="8192"> × <input id="npH" type="number" value="1920" min="16" max="8192"></span></button></div>
    <div class="np-row">
      <label class="f"><span>${tr('np_name')}</span><input id="npName" value="${esc(tr('untitled'))}"></label>
      <label class="f"><span>${tr('resolution')}</span><select id="npRes">${RES.map(([n, v]) => `<option value="${v}"${v === res ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="f"><span>${tr('fps')}</span><select id="npFps">${[24, 25, 30, 50, 60].map(f => `<option${f === fps ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
    </div>
    ${rec.length || hasRec ? `<div class="np-recent"><h4>${tr('recent')}</h4><div class="rgrid">${hasRec ? (m => `<button data-recover class="unsaved"><i class="rdel" data-del title="${tr('removeRecent')}">${icon('x')}</i><span class="rth" style="aspect-ratio:${m.w || 9}/${m.h || 16}">${m.img ? `<img src="${m.img}" alt="">` : icon('film')}${m.dur ? `<em>${mmss(m.dur)}</em>` : ''}</span><b>${tr('unsavedWork')}</b><small>${m.t ? ago(m.t) : ''}</small></button>`)(recent.meta('recovery') || {}) : ''}${rec.map((f, i) => { const m = recent.meta(f) || {};
      return `<button data-rec="${i}" title="${esc(f)}"><i class="rdel" data-del title="${tr('removeRecent')}">${icon('x')}</i><span class="rth" style="aspect-ratio:${m.w || 9}/${m.h || 16}">${m.img ? `<img src="${m.img}" alt="">` : icon('film')}${m.dur ? `<em>${mmss(m.dur)}</em>` : ''}</span><b>${esc(f.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/, ''))}</b><small>${m.t ? ago(m.t) : ''}</small></button>`; }).join('')}</div></div>` : ''}
    <div class="acts">${welcome ? `<button id="npOpen">${tr('open')}…</button>` : ''}<span class="flex"></span><button id="npNo">${tr(welcome ? 'skip' : 'cancel')}</button><button class="primary" id="npGo">${tr('create')}</button></div></div>`;
  $('#mBox').onclick = e => {
    const b = e.target.closest('.fmt');
    if (b) { ratio = b.dataset.r; $$('.fmt').forEach(x => x.classList.toggle('on', x === b)); }
    const del = e.target.closest('[data-del]');
    if (del) {
      const card = del.closest('button');
      if (card.dataset.recover != null) clearRecovery(); else recent.remove(rec[+card.dataset.rec]);
      const g = card.parentElement; card.remove();
      if (!g.children.length) g.parentElement.remove();
      return;
    }
    const r = e.target.closest('[data-rec]');
    if (r) { hideModal(); openPath(rec[+r.dataset.rec]); }
    if (e.target.closest('[data-recover]')) { hideModal(); restoreRecovery(); }
  };
  $('#mBox').ondblclick = e => { const b = e.target.closest('.fmt'); if (b && b.dataset.r !== 'custom') $('#npGo').click(); };
  $('#npNo').onclick = hideModal;
  if ($('#npOpen')) $('#npOpen').onclick = () => { hideModal(); open(); };
  $('#npGo').onclick = () => {
    let w, h;
    if (ratio === 'custom') { const e = v => Math.max(16, Math.round(clamp(+v || 1080, 16, 8192) / 2) * 2); w = e($('#npW').value); h = e($('#npH').value); }
    else [w, h] = dimsFor(ratio);
    hideModal();
    P = Object.assign(newProject(), { w, h, fps: +$('#npFps').value, res: +$('#npRes').value, name: $('#npName').value.trim() || tr('untitled') });
    projectPath = null; openGrp = null; setSelection([]); t = 0; dirty = false;
    lastAuto = JSON.stringify(P); clearRecovery();
    undoStack.length = redoStack.length = 0;
    binSel.clear();
    syncSettings();
    refresh();
  };
}

/* ---------- export ---------- */
const QUALITY = [['low', 'q_low'], ['rec', 'q_rec'], ['high', 'q_high']];
const pref = (k, d) => { try { return localStorage.getItem('kadr.x.' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('kadr.x.' + k, v); } catch {} };
const EXPORT_PRESETS_KEY = 'kadr.exportPresets';
const EXPORT_FIELDS = {
  video: 'xVid', audio: 'xAud', res: 'xRes', fps: 'xFps', quality: 'xQ', codec: 'xCodec',
  format: 'xFmt', afmt: 'xAFmt', hw: 'xHw', chapters: 'xChapters', loudnessTarget: 'xLoudness',
  transparent: 'xTrans', gifFps: 'xGifFps', gifWidth: 'xGifW',
};
const seqFirst = p => p && p.replace('%05d', '00001'); // image sequences name their first frame
const outputFiles = paths => [seqFirst(paths.video), paths.audio].filter(Boolean);
const STILL_CODECS = ['png', 'jpg'], SPECIAL_FMT = { prores: 'mov', prores4444: 'mov', vp9a: 'webm', gif: 'gif', png: 'png', jpg: 'jpg' };
const outputName = value => value.trim().replace(/[\\/:*?"<>|]/g, '-') || 'maqto-export';
const renderQueue = [];
let queueRunning = false, activeQueueItem = null, exporting = false, exportChild = false, exportCancel = null;

function cancelExport() {
  if (cancelled) return;
  cancelled = true;
  if (exportFill) exportFill.cancel();
  if (upscaleTask?.export) stopUpscale(upscaleTask);
  modalAudioPrep?.abort();
  if (exportChild) exportCancel = inv('cancel').catch(e => toast(cleanErr(e)));
}

function queuePathInUse(paths, except) {
  const files = outputFiles(paths);
  return renderQueue.some(job => job !== except && ['waiting', 'rendering'].includes(job.status)
    && outputFiles(job.paths).some(path => files.includes(path)));
}

function updateQueueBadge() {
  const count = renderQueue.filter(job => ['waiting', 'rendering'].includes(job.status)).length;
  $('#rqBadge').textContent = count;
  $('#rqBadge').hidden = !count;
}

function showRenderQueue() {
  $('#modal').hidden = false;
  const box = $('#mBox');
  box.innerHTML = `<section class="rq"><h3>${tr('renderQueue')}</h3>
    <div class="rq-list">${renderQueue.length ? renderQueue.map((job, i) => `<div class="rq-row" data-job="${i}">
      <bdi title="${esc(outputFiles(job.paths).join('\n'))}">${esc(job.name)}</bdi>
      <span class="rq-status"><bdi>${esc(job.preset)}</bdi> · <span ${job.status === 'rendering' ? 'id="rqProgress"' : ''}>${tr('rq_' + job.status, { p: 0 })}</span></span>
      ${job.error ? `<small class="rq-status">${esc(job.error)}</small>` : ''}
      <div class="rq-actions">
        ${job.status === 'done' ? outputFiles(job.paths).map((path, j) =>
          `<button data-reveal="${j}" title="${esc(path)}">${icon('folder-open')}${tr(outputFiles(job.paths).length > 1 ? (j === 0 ? 'rqRevealVideo' : 'rqRevealAudio') : 'reveal')}</button>`).join('') : ''}
        ${['failed', 'cancelled'].includes(job.status) ? `<button data-action="retry">${tr('retry')}</button>` : ''}
        ${job.status === 'rendering' ? `<button data-action="cancel"${cancelled && activeQueueItem === job ? ' disabled' : ''}>${tr('cancel')}</button>`
          : `<button data-action="remove">${tr('rqRemove')}</button>`}
      </div>
    </div>`).join('') : `<p class="hint">${tr('rqEmpty')}</p>`}</div>
    <div class="acts"><button id="rqClose"${queueRunning ? ' disabled' : ''}>${tr('close')}</button>
      <button id="rqRun" class="primary"${queueRunning || !renderQueue.some(job => job.status === 'waiting') ? ' disabled' : ''}>${tr('renderAll')}</button></div></section>`;
  box.querySelector('.rq-list').onclick = e => {
    const button = e.target.closest('button'), row = button?.closest('[data-job]');
    if (!row) return;
    const job = renderQueue[+row.dataset.job];
    if (button.dataset.reveal != null) {
      TA.opener.revealItemInDir(outputFiles(job.paths)[+button.dataset.reveal]).catch(e => toast(cleanErr(e)));
      return;
    }
    if (button.dataset.action === 'cancel') {
      cancelExport();
      button.disabled = true;
      return;
    }
    if (button.dataset.action === 'retry') {
      if (queuePathInUse(job.paths, job)) return toast(tr('rqPathInUse'));
      job.status = 'waiting';
      job.error = '';
    } else renderQueue.splice(+row.dataset.job, 1);
    updateQueueBadge();
    showRenderQueue();
  };
  $('#rqClose').onclick = hideModal;
  $('#rqRun').onclick = runRenderQueue;
  if (activeQueueItem?.progress) $('#rqProgress').textContent = activeQueueItem.progress;
}

function openRenderQueue() {
  if (!$('#modal').hidden) return;
  showRenderQueue();
}

async function runRenderQueue() {
  if (queueRunning || exporting) return;
  queueRunning = true;
  setPlaying(false);
  const counts = { done: 0, failed: 0, cancelled: 0 };
  try {
    let job;
    while ((job = renderQueue.find(item => item.status === 'waiting'))) {
      cancelled = false;
      job.status = 'rendering';
      activeQueueItem = job;
      job.progress = '';
      if ($('#rqRun') && !$('#modal').hidden) showRenderQueue();
      const result = await doExport(job.project, job.settings, job.paths, true);
      job.status = result.status;
      job.error = result.error;
      counts[job.status]++;
      activeQueueItem = null;
      updateQueueBadge();
    }
  } finally {
    activeQueueItem = null;
    queueRunning = false;
    if ($('#rqRun') && !$('#modal').hidden) showRenderQueue();
  }
  toast(tr('rqFinished', counts));
  if (pendingOpen) openPending();
}
async function measureLoudness(project, target) {
  const { args } = G.buildArgs(project, { loudnessAnalysis: true, loudnessTarget: target });
  return inv('loudness_measure', { args });
}
async function exportDialog() {
  if (queueRunning || exporting) return;
  if (!total()) return toast(tr('emptyTl'));
  setPlaying(false);
  const short = Math.min(P.w, P.h), upscaleSize = S.upscale4k(P.w, P.h);
  let dir = pref('dir', '');
  if (!dir) try { dir = await TA.path.desktopDir(); } catch {}
  const cover = document.createElement('canvas');
  cover.width = 360; cover.height = Math.round(360 * P.h / P.w);
  cover.getContext('2d').drawImage(view, 0, 0, cover.width, cover.height);
  const res0 = +pref('res', P.res || short), base = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/, '') : (P.name || 'maqto-export');
  const storedPresets = lsGet(EXPORT_PRESETS_KEY, []);
  const presets = Array.isArray(storedPresets) ? storedPresets : [];
  const builtIns = Object.entries(S.SOCIAL_EXPORT_PRESETS).filter(([id]) => id !== 'master' || G.ENCODERS.prores)
    .map(([id, preset]) => ({ id, name: tr('xp_' + id), preset }));
  const opt = (id, list, v) => `<select id="${id}">${list.map(([val, n]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<div class="xp">
    <div class="xp-cover"></div>
    <div class="xp-form">
      <h3>${tr('exportTitle')}</h3>
      <div class="xp-presets">
        ${fld.select('xPreset', 'xpPreset', [], {})}
        <div class="xp-preset-actions"><button id="xPresetSave">${tr('xpSavePreset')}</button><button id="xPresetRename" hidden>${tr('rename')}</button><button id="xPresetDelete" hidden>${tr('xpDeletePreset')}</button></div>
        <form id="xPresetNameForm" class="xp-preset-actions" hidden>
          <input id="xPresetName" aria-label="${tr('xpPresetName')}" placeholder="${tr('xpPresetName')}" required>
          <button type="button" id="xPresetNameCancel">${tr('cancel')}</button><button class="primary">${tr('ok')}</button>
        </form>
        <p id="xAspectHint" class="hint" role="status" hidden></p>
      </div>
      <label class="xr"><span>${tr('np_name')}</span><input id="xName" value="${esc(base)}"></label>
      <div class="xr"><span>${tr('exportTo')}</span><div class="xdir"><input id="xDir" value="${esc(dir)}" readonly><button class="ib" id="xPick" data-i="folder-open"></button></div></div>
      <label class="xsec"><input type="checkbox" id="xVid" checked> <b>${tr('video')}</b></label>
      <div id="xVidBox">
        <label class="xr"><span>${tr('resolution')}</span>${opt('xRes', RES.map(([n, v]) => [v, n]), RES.some(r => r[1] === res0) ? res0 : 1080)}</label>
        ${upscaleSize ? `<label class="xr"><span>${tr('upscaleExport')}</span><input type="checkbox" id="xUpscale"></label>` : ''}
        <label class="xr"><span>${tr('bitrate')}</span>${opt('xQ', QUALITY.map(([v, k]) => [v, tr(k)]), pref('q', 'rec'))}</label>
        <label class="xr"><span>${tr('codec')}</span>${opt('xCodec', [['h264', 'H.264'], ['hevc', 'HEVC / H.265'], ['prores', 'ProRes 422'], ['prores4444', 'ProRes 4444 (alpha)'], ['vp9a', 'WebM VP9 (alpha)'], ['gif', 'GIF'], ['png', 'PNG sequence'], ['jpg', 'JPG sequence']], pref('codec', 'h264'))}</label>
        <label class="xr"><span>${tr('format')}</span>${opt('xFmt', [['mp4', 'mp4'], ['mov', 'mov'], ['webm', 'webm'], ['gif', 'gif'], ['png', 'png'], ['jpg', 'jpg']], pref('fmt', 'mp4'))}</label>
        <label class="xr" id="xTransRow"><span>${tr('xTransparent')}</span><input type="checkbox" id="xTrans" checked></label>
        <label class="xr" id="xGifFpsRow"><span>${tr('xGifFps')}</span>${opt('xGifFps', [10, 15, 24].map(f => [f, f + 'fps']), 15)}</label>
        <label class="xr" id="xGifWRow"><span>${tr('xGifW')}</span>${opt('xGifW', [240, 320, 480, 640, 800].map(w => [w, w + 'px']), 480)}</label>
        <label class="xr"><span>${tr('fps')}</span>${opt('xFps', [...new Set([24, 25, 30, 50, 60, P.fps])].sort((a, b) => a - b).map(f => [f, f + 'fps']), P.fps)}</label>
        ${P.markers.length ? `<label class="xr"><span>${tr('embedChapters')}</span><input type="checkbox" id="xChapters" checked></label>` : ''}
        ${IS_MAC ? `<label class="xr"><span>${tr('hw')}</span><input type="checkbox" id="xHw"${pref('hw', '1') === '1' ? ' checked' : ''}></label>` : ''}
      </div>
      <label class="xsec"><input type="checkbox" id="xAud"${pref('aud', '0') === '1' ? ' checked' : ''}> <b>${tr('audioFile')}</b></label>
      <div id="xAudBox"><label class="xr"><span>${tr('format')}</span>${opt('xAFmt', [['mp3', 'MP3'], ['wav', 'WAV'], ['m4a', 'AAC (m4a)']], pref('afmt', 'mp3'))}</label></div>
      <div class="xsec"><b>${tr('masterLoudness')}</b></div>
      <label class="xr"><span>${tr('loudnessTarget')}</span>${opt('xLoudness', [0, ...G.LOUDNESS_TARGETS].map(v => [v, tr('lufs_' + Math.abs(v))]), P.loudnessTarget)}</label>
      <button id="xMeasure">${tr('measureLoudness')}</button>
      <output id="xLoudnessReadout" role="status"></output>
    </div>
    <div class="xp-foot"><span id="xInfo"></span><span class="flex"></span><button id="xNo">${tr('cancel')}</button><button id="xQueue">${tr('rqAdd')}</button><button class="primary" id="xGo">${tr('exportGo')}</button></div></div>`;
  $('.xp-cover').appendChild(cover);
  paintIcons($('#mBox'));
  const measure = $('#xMeasure'), readout = $('#xLoudnessReadout'), go = $('#xGo'), add = $('#xQueue'), target = $('#xLoudness');
  const presetSelect = $('.xp-presets select'), nameForm = $('#xPresetNameForm'), nameInput = $('#xPresetName'), fileName = $('#xName');
  presetSelect.setAttribute('aria-label', tr('xpPreset'));
  let measuring = false, analyzing = false, stopped = false, starting = false, stats = null, aspectHint = '';
  const selectedPreset = () => [...builtIns, ...presets].find(p => p.id === presetSelect.value);
  const exportName = queued => {
    const name = fileName.value.trim() || base, preset = selectedPreset();
    const suffix = preset?.id.startsWith('user-') ? preset.name : preset?.id;
    return outputName(queued && name === base && suffix ? base + '-' + suffix : name);
  };
  const readSettings = () => ({
    upscale: $('#xVid').checked && !!$('#xUpscale')?.checked,
    ...Object.fromEntries(Object.entries(EXPORT_FIELDS).map(([key, id]) => {
      const input = $('#' + id);
      return [key, !input ? key === 'chapters' : input.type === 'checkbox' ? input.checked
        : ['res', 'fps', 'loudnessTarget', 'gifFps', 'gifWidth'].includes(key) ? +input.value : input.value];
    })),
  });
  const updatePresets = id => {
    presetSelect.replaceChildren(new Option(tr('xpCurrent'), ''),
      ...[...builtIns, ...presets].map(p => new Option(p.name, p.id)));
    presetSelect.value = id;
    sync();
  };
  const sync = () => {
    const vid = $('#xVid').checked, aud = $('#xAud').checked, codec0 = $('#xCodec').value, pr = !!SPECIAL_FMT[codec0];
    $('#xVidBox').classList.toggle('off', !vid);
    $('#xAudBox').classList.toggle('off', !aud);
    const fmtSel = $('#xFmt');
    for (const o of fmtSel.options) o.disabled = pr ? o.value !== SPECIAL_FMT[codec0] : !['mp4', 'mov'].includes(o.value);
    if (pr) fmtSel.value = SPECIAL_FMT[codec0]; else if (fmtSel.selectedOptions[0]?.disabled) fmtSel.value = 'mp4';
    fmtSel.disabled = pr;
    $('#xTransRow').hidden = !G.ALPHA[codec0];
    $('#xGifFpsRow').hidden = $('#xGifWRow').hidden = codec0 !== 'gif';
    if ($('#xHw')) $('#xHw').disabled = pr;
    const up = $('#xUpscale');
    if (up && pr) up.checked = false;
    const upscale = vid && up?.checked;
    if (up) up.disabled = !vid || pr;
    $('#xRes').closest('label').hidden = !!upscale;
    const sh = +$('#xRes').value, k = sh / short, fps = +$('#xFps').value;
    const [w, h] = upscale ? upscaleSize : [Math.round(P.w * k / 2) * 2, Math.round(P.h * k / 2) * 2];
    const area = w * h;
    const hint = $('#xAspectHint');
    hint.hidden = !aspectHint || !vid;
    hint.textContent = tr('xpAspectHint', { ratio: aspectHint, w, h });
    const q = { low: 0.6, rec: 1, high: 1.8 }[$('#xQ').value], codec = $('#xCodec').value;
    const mbps = codec.startsWith('prores') ? 147 * area / (1920 * 1080) * fps / 30 : 8 * q * area / (1920 * 1080) * fps / 30 * (codec === 'hevc' ? 0.6 : 1);
    const mb = total() * ((vid ? mbps : 0) + (aud ? ($('#xAFmt').value === 'wav' ? 1.536 : 0.192) : 0) + (vid ? 0.192 : 0)) / 8;
    $('#xInfo').innerHTML = `${tr('duration')}: <bdi>${fmt(total())}</bdi> · ${tr('size')}: <bdi>~${mb < 1000 ? Math.max(1, Math.round(mb)) + ' MB' : (mb / 1000).toFixed(1) + ' GB'}</bdi>`;
    go.disabled = add.disabled = starting || measuring || !nameForm.hidden || (!vid && !aud);
    add.title = exportName(true);
    measure.disabled = starting || measuring;
    const custom = presets.some(p => p.id === presetSelect.value);
    $('#xPresetRename').hidden = $('#xPresetDelete').hidden = !custom;
    if (stats) {
      const hasTarget = +target.value !== 0, ok = Math.abs(Number(stats.input_i) - +target.value) <= 1;
      const metric = (label, raw, unit) => `<span>${tr(label)} <bdi>${raw === '-inf' ? '−∞' : Number(raw).toFixed(1)} ${unit}</bdi></span>`;
      readout.className = hasTarget ? (ok ? 'ok' : 'warn') : '';
      readout.innerHTML = metric('loudnessIntegrated', stats.input_i, 'LUFS') + metric('loudnessPeak', stats.input_tp, 'dBTP')
        + metric('loudnessRange', stats.input_lra, 'LU')
        + (hasTarget ? `<span>${tr(ok ? 'loudnessOnTarget' : 'loudnessOutsideTarget')}</span>` : '');
    }
  };
  $('.xp').onchange = sync;
  fileName.oninput = () => { add.title = exportName(true); };
  presetSelect.onchange = () => {
    nameForm.hidden = true;
    const preset = selectedPreset()?.preset;
    aspectHint = '';
    if (preset) {
      const result = S.exportPresetSettings({ hw: pref('hw', '1') === '1', ...preset }, P, G.ENCODERS);
      aspectHint = result.aspectHint;
      if ($('#xUpscale')) $('#xUpscale').checked = !!preset.upscale;
      for (const [key, value] of Object.entries(result.settings)) {
        const id = EXPORT_FIELDS[key], input = id && $('#' + id);
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = !!value;
        else {
          if (key === 'fps' && ![...input.options].some(o => +o.value === value)) input.add(new Option(value + 'fps', value));
          input.value = value;
        }
      }
    }
    sync();
  };
  const editPresetName = preset => {
    nameForm.hidden = false;
    nameInput.value = preset?.name || '';
    nameInput.focus();
    nameInput.select();
    nameForm.onsubmit = e => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const saved = preset || { id: 'user-' + uid(), preset: { ...readSettings(), aspect: [P.w, P.h] } };
      saved.name = name;
      if (!preset) { presets.push(saved); aspectHint = ''; }
      lsSet(EXPORT_PRESETS_KEY, presets);
      nameForm.hidden = true;
      updatePresets(saved.id);
    };
    sync();
  };
  $('#xPresetSave').onclick = () => editPresetName();
  $('#xPresetRename').onclick = () => editPresetName(selectedPreset());
  $('#xPresetNameCancel').onclick = () => { nameForm.hidden = true; sync(); };
  $('#xPresetDelete').onclick = () => {
    const index = presets.findIndex(p => p.id === presetSelect.value);
    if (index < 0) return;
    presets.splice(index, 1);
    lsSet(EXPORT_PRESETS_KEY, presets);
    nameForm.hidden = true;
    aspectHint = '';
    updatePresets('');
  };
  target.onchange = () => {
    snapshot();
    P.loudnessTarget = +target.value;
    refresh();
  };
  updatePresets('');
  $('#xPick').onclick = async () => {
    const input = $('#xDir'), folder = await TA.dialog.open({ directory: true, defaultPath: input.value || undefined });
    if (folder) input.value = folder;
  };
  let loudnessPrep;
  $('#xNo').onclick = () => {
    if (!measuring) return hideModal();
    if (stopped) return;
    stopped = true;
    loudnessPrep?.abort();
    if (analyzing) inv('cancel');
  };
  measure.onclick = async () => {
    measuring = true;
    stopped = false;
    stats = null;
    readout.className = '';
    readout.textContent = tr('loudnessMeasuring');
    sync();
    const project = P;
    try {
      loudnessPrep = new AbortController();
      await dnPrep(project, loudnessPrep.signal, p => { readout.textContent = `${tr('voiceClean')} · ${Math.round(p * 100)}%`; });
      loudnessPrep = null;
      if (stopped || project !== P || !measure.isConnected || $('#modal').hidden) return;
      analyzing = true;
      const result = await measureLoudness(project, +target.value);
      if (!stopped && project === P) stats = result;
    } catch (e) {
      if (!stopped && measure.isConnected && !$('#modal').hidden) toast(tr('error') + ': ' + cleanErr(e));
    } finally {
      loudnessPrep = null;
      measuring = analyzing = false;
      readout.textContent = '';
      if (measure.isConnected) sync();
    }
  };
  const submit = async queued => {
    const d = $('#xDir').value;
    if (!d) return toast(tr('pickFolder'));
    const settings = readSettings(), preset = selectedPreset();
    const name = exportName(queued);
    const sep = d.includes('\\') ? '\\' : '/', at = ext => d.replace(/[\\/]$/, '') + sep + name + '.' + ext;
    const seq = STILL_CODECS.includes(settings.codec);
    const paths = { video: settings.video && (seq ? d.replace(/[\\/]$/, '') + sep + name.replace(/%/g, '-') + '_%05d.' + settings.codec : at(settings.format)), audio: settings.audio && at(settings.afmt) };
    if (queuePathInUse(paths)) return toast(tr('rqPathInUse'));
    const job = S.snapshotExport(P, settings, paths);
    starting = true;
    sync();
    try {
      const exists = (await Promise.all(outputFiles(paths).map(path => inv('path_exists', { path })))).some(Boolean);
      if (exists && !(await TA.dialog.ask(tr('overwrite'), { kind: 'warning' }))) return;
    } catch (e) {
      return toast(tr('error') + ': ' + cleanErr(e));
    } finally {
      starting = false;
      if (go.isConnected) sync();
    }
    if (!go.isConnected || $('#modal').hidden) return;
    Object.entries({ dir: d, res: settings.res, q: settings.quality, codec: settings.codec, fmt: settings.format,
      hw: settings.hw ? '1' : '0', aud: settings.audio ? '1' : '0', afmt: settings.afmt }).forEach(([k, v]) => setPref(k, v));
    if (queued) {
      renderQueue.push({ ...job, name, preset: preset?.name || tr('xpCurrent'), status: 'waiting' });
      updateQueueBadge();
      hideModal();
      toast(tr('rqAdded'), { label: tr('renderQueue'), run: openRenderQueue });
    } else doExport(job.project, job.settings, job.paths);
  };
  go.onclick = () => submit(false);
  add.onclick = () => submit(true);
}
async function upscaleExport(path, out, size, encoder) {
  if (upscaleTask) throw new Error(tr('upscaleBusy'));
  const task = upscaleTask = { export: true, job: uid(), p: 0 };
  try {
    if (!await upscaleModel.ready()) {
      if (task.cancelled) return;
      progress(tr('upscaleDownload'), 0);
      await upscaleModel.download(false);
    }
    if (task.cancelled) return;
    task.running = true;
    progress(tr('upscaleExport'), 0);
    await inv('upscale_export', { path, out, size, encoder, job: task.job });
  } finally { upscaleTask = null; }
}
async function exportFramePng() {
  if (!total()) return toast(tr('emptyTl'));
  setPlaying(false);
  try {
    const name = (P.name || (projectPath && projectPath.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/, '')) || 'maqto-frame').replace(/[\\/]/g, '-');
    const dest = await TA.dialog.save({ defaultPath: `${name}_${String(Math.round(t * P.fps)).padStart(5, '0')}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!dest) return;
    const blob = await new Promise(r => view.toBlob(r, 'image/png')); // the preview canvas is the frame the export matches
    await inv('save_png', { path: /\.png$/i.test(dest) ? dest : dest + '.png', bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
    toast(tr('exported'));
  } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
}
async function doExport(source, settings, paths, queued = false) {
  if (exporting || (queueRunning && !queued)) return { status: 'failed', error: tr('rqBusy') };
  const offlineUsed = [...mediaDependencies(source.items)].filter(id => offline.has(id));
  if (offlineUsed.length && !(await TA.dialog.ask(tr('offlineExport', { n: offlineUsed.length }), { kind: 'warning' }))) return { status: 'failed', error: tr('cancelled') };
  exporting = true;
  cancelled = false;
  exportCancel = null;
  const checkCancelled = () => { if (cancelled) throw new Error('cancelled'); };
  const runChild = async run => {
    checkCancelled();
    exportChild = true;
    try {
      const result = await run();
      checkCancelled();
      return result;
    } finally { exportChild = false; }
  };
  let work = null, upscaleWork = null;
  try {
    const project = S.expandMulticam(S.scaleProject(source, 1));
    progress(tr(paths.video ? 'p_texts' : 'p_audioExport'), 0);
    await prepareModalAudio(project);
    checkCancelled();
    const loudnessTarget = settings.loudnessTarget ?? project.loudnessTarget;
    let loudnessStats;
    if (G.LOUDNESS_TARGETS.includes(loudnessTarget)) {
      progress(tr('loudnessMeasuring'), null);
      loudnessStats = await runChild(() => measureLoudness(project, loudnessTarget));
    }
    if (paths.video) {
      progress(tr('p_texts'), 0);
      const upscaleSize = settings.upscale && !SPECIAL_FMT[settings.codec] && S.upscale4k(project.w, project.h);
      if (upscaleSize && upscaleTask) throw new Error(tr('upscaleBusy'));
      const Q = S.scaleProject(project, upscaleSize ? 1 : settings.k ?? settings.res / Math.min(project.w, project.h));
      Q.fps = settings.fps;
      work = await inv('work_begin');
      const textLists = [];
      for (const [gi, g] of textGroups(Q).entries()) {
        const list = await rasterizeTexts(Q, work, g, 'g' + gi + '_');
        if (list) textLists.push({ track: g[0], path: await inv('write_work', new TextEncoder().encode(G.concatText(list, Q.fps)), { headers: { 'x-id': String(work.id), 'x-name': 'text' + gi + '.ffconcat' } }) });
      }
      const luts = await writeLuts(Q, work), masks = await writeMasks(Q, work);
      await writeFills(Q, work);
      const rife = {}, mattes = {}, fills = {}, visuals = {};
      for (const it of project.items) {
        checkCancelled();
        const m = media(it, project);
        if (it.audioOnly || it.hidden || !m) continue;
        let fill = fillState(it, m, true);
        if (fill) {
          if (fill.cancelled) fill = fillState(it, m, true, true);
          exportFill = fill;
          progress(tr('fillProgress', { p: Math.round(fill.p * 100) }), fill.p);
          try {
            fills[it.id] = await fill.wait;
            checkCancelled();
            if (!fills[it.id]) throw new Error(fillError(fill));
          } finally { exportFill = null; }
        }
        if (!fill) {
          await upscaleState(it, m)?.wait;
          await depthState(it, m, project)?.wait;
          const depth = depthVisual(it, m, project);
          if (!depth && depthRequest(it, m, project)) throw new Error(tr('depthCacheMissing', { name: m.name }));
          const visual = depth || upscaleVisual(it, m);
          if (visual) visuals[it.id] = visual;
          else {
            const req = upscaleRequest(it, m);
            if (req && it.upscale?.prepared === upscaleRange(req)) throw new Error(tr('upscaleCacheMissing', { name: m.name }));
          }
        }
        const object = !fill && objectMatteState(it, m);
        if (object) {
          progress(tr('samPreparing'), 0);
          const mt = await object.wait;
          if (!mt) throw new Error(tr('samCacheMissing'));
          mattes[it.id] = { object: { ...mt, mode: objectMode(it) } };
        }
        if (m.kind !== 'video') continue;
        if (!fill && !visuals[it.id] && !isText(it) && smoothSlow(it) && rifeTool) {
          progress(tr('p_rife'), 0);
          const path = await rifeWait(it, m);
          if (path) rife[it.id] = path;
        }
        if (it.rmbg && matteTool[mtKind(it)]) {
          progress(tr('p_matte'), 0);
          const path = await matteWait(it, m);
          if (path) mattes[it.id] = mattes[it.id] ? { ...mattes[it.id], background: path } : path;
        }
      }
      const transLists = [...await renderGlTrans(project, work, Q.fps, fills, visuals), ...await renderRich(project, work, Q.fps, fills, visuals)];
      checkCancelled();
      const metadata = (settings.chapters ?? true) && /\.(mp4|mov)$/i.test(paths.video) && G.chapterMetadata(Q.markers, S.projectDur(Q), tr('chapterIntro'), tr('marker'));
      const chapterFile = metadata && await inv('write_work', new TextEncoder().encode(metadata), {
        headers: { 'x-id': String(work.id), 'x-name': 'chapters.ffmetadata' },
      });
      const codec = settings.hw && Object.hasOwn(G.ENCODERS, settings.codec + '_hw') ? settings.codec + '_hw' : settings.codec;
      if (upscaleSize) upscaleWork = await inv('work_begin');
      const videoOut = upscaleWork ? upscaleWork.path + '/project.mp4' : paths.video;
      const { args, duration } = G.buildArgs(Q, { out: videoOut, textLists, transLists,
        codec: upscaleSize ? 'h264' : codec, quality: upscaleSize ? 'high' : settings.quality,
        luts, masks, rife, mattes, fills, visuals, loudnessTarget, loudnessStats, chapterFile,
        transparent: settings.transparent !== false, gifFps: settings.gifFps ?? 15, gifWidth: settings.gifWidth ?? 480 });
      progress(tr('p_export'), 0);
      await runChild(() => inv('export_run', { id: work.id, args, concat: null, duration }));
      work = null;
      if (upscaleSize) {
        await upscaleExport(videoOut, paths.video, upscaleSize, (G.ENCODERS[codec] || G.ENCODERS.h264)(settings.quality));
        checkCancelled();
      }
    }
    if (paths.audio) {
      checkCancelled();
      progress(tr('p_audioExport'), 0);
      work = await inv('work_begin');
      const { args, duration } = G.buildArgs(project, { out: paths.audio, audioExport: paths.audio.split('.').pop(), loudnessTarget, loudnessStats });
      await runChild(() => inv('export_run', { id: work.id, args, concat: null, duration }));
      work = null;
    }
    if (!queued) {
      const out = seqFirst(paths.video) || paths.audio;
      toast(tr('exported') + ': ' + out.split(/[\\/]/).pop(), { label: tr('reveal'), run: () => TA.opener.revealItemInDir(out) });
    }
    return { status: 'done' };
  } catch (e) {
    const status = cancelled || String(e) === 'cancelled' ? 'cancelled' : 'failed', error = status === 'failed' ? cleanErr(e) : '';
    if (!queued) toast(status === 'cancelled' ? tr('cancelled') : tr('error') + ': ' + error);
    return { status, error };
  } finally {
    await exportCancel;
    if (work) await inv('work_end', { id: work.id }).catch(() => {});
    if (upscaleWork) await inv('work_end', { id: upscaleWork.id }).catch(() => {});
    if (!queued) hideModal();
    exporting = false;
  }
}

/* ---------- captions ---------- */
// Speech models for auto captions and their download size; the user picks one, each downloads once.
const CAP_MODELS = { small: '466 MB', 'large-v3-turbo-q5_0': '547 MB', 'large-v3-turbo': '1.6 GB', 'large-v3-q5_0': '1.1 GB' };
const capModel = () => { const m = lsGet('kadr.capModel', 'large-v3-turbo-q5_0'); return CAP_MODELS[m] ? m : 'large-v3-turbo-q5_0'; };
async function renderCapModels() {
  const have = await Promise.all(Object.keys(CAP_MODELS).map(m => inv('model_ready', { model: m }).catch(() => false)));
  const options = Object.keys(CAP_MODELS).map((m, i) => `<option value="${m}"${m === capModel() ? ' selected' : ''}>${tr('cm_' + m)} · ${CAP_MODELS[m]}${have[i] ? ' ✓' : ''}</option>`).join('');
  $('#capModel').innerHTML = $('#transcriptModel').innerHTML = options;
  $('#capModelHint').textContent = tr('cmh_' + capModel());
}
const setCapModel = e => { lsSet('kadr.capModel', e.target.value); renderCapModels(); if (panelVisible('aiTools')) renderAITools(); };
$('#capModel').onchange = $('#transcriptModel').onchange = setCapModel;
$('#transcriptLang').innerHTML = $('#capLang').innerHTML;
$('#transcriptLang').onchange = e => { $('#capLang').value = e.target.value; };
$('#capLang').onchange = e => { $('#transcriptLang').value = e.target.value; };
async function ensureCaptionModel(model, title) {
  if (await inv('model_ready', { model })) return true;
  if (!(await TA.dialog.ask(tr('modelAskN', { size: CAP_MODELS[model] }), { title: tr(title) }))) return false;
  progress(tr('p_model'), 0);
  await whisperModel.download(false, model);
  return true;
}
async function autoCaptions() {
  // only the clips picked on the timeline: their sound alone is transcribed, captions elsewhere stay
  const pick = selIds().map(item).filter(i => { const m = i && media(i); return m && !i.muted && (m.kind === 'audio' || m.hasAudio); });
  if (!pick.length) return toast(tr(P.items.some(i => media(i)) ? 'capPick' : 'needAudio'));
  const group = openGrp;
  const inPick = c => pick.some(i => c.start + c.dur / 2 >= i.start && c.start + c.dur / 2 < i.start + i.dur);
  const old = timelineItems().filter(i => i.track === 'c1' && inPick(i));
  if (old.length && !(await TA.dialog.ask(tr('replaceCaps'), { kind: 'warning' }))) return;
  setPlaying(false);
  cancelled = false;
  let work = null;
  try {
    const model = capModel();
    if (!(await ensureCaptionModel(model, 'genCaptions'))) return;
    progress(tr('p_audio'), 0);
    work = await inv('work_begin');
    await prepareModalAudio({ ...P, items: pick });
    if (cancelled) throw new Error('cancelled');
    const { args } = G.buildArgs({ ...P, items: pick }, { out: work.path + '/mix.wav', audioOnly: true });
    const json = await inv('transcribe', { id: work.id, audioArgs: args, lang: $('#capLang').value, model });
    work = null;
    hideModal();
    const words = S.parseWhisper(JSON.parse(json));
    if (!words.length) return toast(tr('noSpeech'));
    if (pick.some(i => item(i.id) !== i)) return;
    snapshot();
    const prev = old[0] || P.items.find(i => i.track === 'c1');
    const style = prev && isText(prev) ? prev.style : textDefaults(true);
    P.items = P.items.filter(i => !old.includes(i));
    const groups = S.groupWords(words);
    groups.forEach((g, i) => {
      const next = groups[i + 1];
      const end = next && next.start - g.end < 0.5 ? next.start : g.end + 0.25;
      addTimelineItem({
        id: uid(), type: 'text', track: 'c1', start: g.start, dur: Math.max(0.2, end - g.start), text: g.text,
        words: g.words.map(w => ({ w: w.w, s: w.s - g.start, e: w.e - g.start })),
        style: { ...style }, x: 0.5, y: 0.72, anim: 'pop', out: 'none',
      }, group);
    });
    refresh();
    toast(tr('capsDone', { n: groups.length }));
  } catch (e) {
    hideModal();
    const m = cleanErr(e);
    toast(cancelled ? tr('cancelled') : m === 'whisper' ? tr('needWhisper') : tr('error') + ': ' + m);
  } finally {
    if (work) inv('work_end', { id: work.id });
  }
}

/* ---------- offline caption translation ---------- */
const TRANSLATION_DIRECTIONS = { 'ar-en': 'translationArEn', 'en-ar': 'translationEnAr' };
const translationDirectionOptions = value => Object.entries(TRANSLATION_DIRECTIONS).map(([code, label]) =>
  `<option value="${code}"${code === value ? ' selected' : ''}>${tr(label)}</option>`).join('');
const isTranslatable = it => isText(it) && !it.icon && typeof it.text === 'string' && it.text.trim().length > 0;

function captionTranslationTargets() {
  const selected = selectedItems().filter(isTranslatable);
  return selected.length ? selected : timelineItems().filter(it => it.track === 'c1' && isTranslatable(it));
}
const captionStamp = it => JSON.stringify([it.track, it.grp, it.start, it.dur, it.text]);
function checkCaptionSources(project, clips, stamps) {
  if (P !== project || clips.some((it, i) => item(it.id) !== it || captionStamp(it) !== stamps[i])) {
    throw new Error(tr('translationChanged'));
  }
}

async function translateCaptionItems(clips, direction, job) {
  const project = P, stamps = clips.map(captionStamp);
  const paragraphs = clips.map(it => it.text.split(/\r\n?|\n/));
  const lines = paragraphs.flat().filter(line => line.trim());
  job.total = lines.length;
  job.update?.(tr('translationProgress', { done: 0, total: job.total }), 0);
  const translated = await inv('translation_run', { job: job.id, direction, lines }).catch(e => {
    if (cleanErr(e) === 'translation_line_too_long') throw new Error(tr('translationLineTooLong'));
    throw e;
  });
  if (job.cancelled) throw new Error('cancelled');
  checkCaptionSources(project, clips, stamps);
  if (translated.length !== lines.length) throw new Error(tr('translationIncomplete'));
  let index = 0;
  return paragraphs.map(parts => parts.map(line => line.trim() ? translated[index++] || line : line).join('\n'));
}

function applyCaptionTranslation(clips, translated, direction, output) {
  const replace = output === 'replace';
  if (replace && clips.some(it => lockedTrack(it.track))) throw new Error(tr('translationLocked'));
  const toArabic = direction === 'en-ar';
  let lane;
  snapshot();
  if (!replace) {
    const at = P.tracks.findLastIndex(track => clips.some(it => it.track === track.id));
    const id = 't' + uid();
    lane = { id, kind: 'text', captionLanguage: toArabic ? 'ar' : 'en' };
    P.tracks.splice(at + 1, 0, lane);
  }
  return clips.map((source, i) => {
    const it = replace ? source : structuredClone(source);
    if (lane) {
      it.id = uid();
      it.track = lane.id;
      it.style = { ...textDefaults(source.track === 'c1'), ...it.style };
      const y = num(it.y, 0.5);
      const lineHeight = num(it.style.size, 78) * num(it.style.lineH, 1.3) / P.h;
      const halfHeight = text => Math.min(0.22, lineHeight * text.split(/\r\n?|\n/).filter(line => line.trim()).length / 2);
      const translatedHeight = halfHeight(translated[i]);
      const gap = Math.max(0.08, halfHeight(source.text) + translatedHeight + 0.014);
      it.y = y + gap + translatedHeight <= 0.97 ? y + gap : Math.max(0.03 + translatedHeight, y - gap);
      // The second line needs its own vertical position even when the source is animated.
      if (it.kf) delete it.kf.y;
      delete it.trk;
      addTimelineItem(it, it.grp || null);
    }
    it.text = translated[i];
    it.style = { ...it.style, dir: toArabic ? 'rtl' : 'ltr' };
    delete it.words;
    return it.id;
  });
}

let captionTranslationJob;
TA.event.listen('translation-progress', ({ payload: { job, done } }) => {
  const active = captionTranslationJob;
  if (active?.id === job && !active.cancelled) active.update?.(tr('translationProgress', { done, total: active.total }), done / active.total);
});
function openCaptionTranslation(candidates = captionTranslationTargets()) {
  if (captionTranslationJob || exporting || queueRunning || !$('#modal').hidden) return;
  const clips = candidates.filter(isTranslatable);
  if (!clips.length) return toast(tr('translationPick'));
  const previous = document.activeElement, project = P, stamps = clips.map(captionStamp);
  const box = $('#mBox');
  box.onclick = box.ondblclick = null;
  box.innerHTML = `<form id="captionTranslateForm" role="dialog" aria-modal="true" aria-labelledby="captionTranslateTitle">
    <h3 id="captionTranslateTitle">${tr('aiTranslation')}</h3>
    <label class="f"><span>${tr('translationDirection')}</span><select id="captionTranslateDirection">${translationDirectionOptions(S.captionDirection(clips.map(it => it.text)))}</select></label>
    <label class="f"><span>${tr('translationOutput')}</span><select id="captionTranslateOutput">
      <option value="replace"${clips.some(it => lockedTrack(it.track)) ? ' disabled' : ''}>${tr('translationReplace')}</option>
      <option value="track">${tr('translationTrack')}</option><option value="srt">${tr('translationSrt')}</option>
    </select></label>
    <div id="captionTranslateProgress" hidden><p role="status"></p><div class="pbar reframe-progress"><i></i></div></div>
    <div class="acts"><button type="button" id="captionTranslateCancel">${tr('cancel')}</button>
      <button class="primary" id="captionTranslateGo">${tr('captionTranslate')}</button></div></form>`;
  const form = $('#captionTranslateForm'), directionSelect = $('#captionTranslateDirection'), outputSelect = $('#captionTranslateOutput');
  const cancel = $('#captionTranslateCancel'), go = $('#captionTranslateGo');
  const close = () => { hideModal(); previous?.focus(); };
  const update = (label, p) => {
    const panel = $('#captionTranslateProgress');
    if (!panel || !form.isConnected || $('#modal').hidden) return;
    panel.hidden = false;
    panel.querySelector('[role="status"]').textContent = label;
    panel.querySelector('i').style.width = `${Math.round(p * 100)}%`;
  };
  $('#modal').hidden = false;
  directionSelect.focus();
  let job;
  cancel.onclick = () => {
    if (!job) return close();
    job.cancelled = true;
    if (job.running) void inv('translation_cancel', { job: job.id }).catch(() => {});
    close();
  };
  form.onkeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    if (e.key !== 'Tab') return;
    const controls = [directionSelect, outputSelect, cancel, go].filter(el => !el.disabled);
    const edge = e.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (job) return;
    const direction = directionSelect.value, output = outputSelect.value;
    job = captionTranslationJob = { id: uid(), update, direction };
    go.disabled = directionSelect.disabled = outputSelect.disabled = true;
    cancel.focus();
    setPlaying(false);
    try {
      if (!await inv('translation_ready', { direction })) {
        if (job.cancelled || !await TA.dialog.ask(tr('translationAsk'), { title: tr('aiTranslation') })) return;
        if (job.cancelled) return;
        update(tr('translationDownload'), 0);
        await translationModel.download(true, direction);
      }
      if (job.cancelled) return;
      checkCaptionSources(project, clips, stamps);
      job.running = true;
      const translated = await translateCaptionItems(clips, direction, job);
      if (output === 'srt') {
        const text = S.captionsToSrt(clips.map((it, i) => ({ start: it.start, dur: it.dur, text: translated[i] })));
        const name = (P.name || 'Maqto').replace(/[\\/]/g, '-');
        const dest = await TA.dialog.save({ defaultPath: `${name}.${direction.slice(-2)}.srt`, filters: [{ name: 'SubRip', extensions: ['srt'] }] });
        if (!dest || job.cancelled) return;
        await inv('save_srt', { path: /\.srt$/i.test(dest) ? dest : dest + '.srt', text });
        toast(tr('exported'));
      } else {
        applyCaptionTranslation(clips, translated, direction, output);
        refresh();
        toast(tr('translationDone', { n: clips.length }));
      }
    } catch (e) {
      if (!job.cancelled) toast(cleanErr(e));
    } finally {
      captionTranslationJob = null;
      if (!job.cancelled && form.isConnected) close();
    }
  };
}
$('#bTranslateCaptions').onclick = () => openCaptionTranslation();

/* ---------- transcript editing ---------- */
const transcriptText = $('#transcriptText');
const fillerDefaults = [
  ...['يعني', 'اه', 'آه', 'ااه', 'امم', 'إمم', 'ممم', 'ايه', 'يا', 'طب'].map((text, i) => ({ text, enabled: i < 7 })),
  ...['um', 'uh', 'erm', 'hmm', 'like', 'you know'].map((text, i) => ({ text, enabled: i < 4 })),
];
const savedFillers = lsGet('kadr.fillers', null);
let fillers = Array.isArray(savedFillers) ? savedFillers.filter(f => typeof f?.text === 'string') : fillerDefaults;
let transcriptProject, transcriptEntries = [], transcriptButtons = [], transcriptEnds = [];
let pickedWords = new Set(), wordAnchor = null, currentWord = -1, wordDrag = null;
let transcribing = false, scanningSilences = false, silencePreview = null;
const lockedTrack = id => P.tracks.some(track => track.id === id && track.locked);
function speechTargets(edit = true) {
  const clips = selIds().length ? selectedItems() : timelineItems().filter(it => it.track === 'v1');
  return clips.filter(it => hasSound(media(it)) && (!edit || inTimeline(it) && !lockedTrack(it.track)));
}
const speechStamp = clips => JSON.stringify(clips.map(it => [it.id, it.track, it.grp, it.start, it.dur, it.in, it.speed, it.curve, media(it)?.path]));
async function transcribeClips() {
  if (transcribing || exporting || queueRunning) return;
  const clips = speechTargets(false);
  if (!clips.length) return toast(tr('needAudio'));
  const project = P, sources = clips.map(it => media(it).path), model = capModel(), lang = $('#capLang').value;
  const found = new Map();
  let work;
  transcribing = true;
  $('#transcribeClips').disabled = true;
  cancelled = false;
  setPlaying(false);
  try {
    if (!(await ensureCaptionModel(model, 'transcribeClips')) || cancelled) return;
    // Read each source once so extending a trim or splitting a clip needs no new transcription.
    for (const path of new Set(sources)) {
      progress(tr('p_audio'), 0);
      work = await inv('work_begin');
      if (cancelled) throw new Error('cancelled');
      const audioArgs = ['-y', '-i', path, '-map', '0:a:0', '-af', 'aresample=16000:async=1:first_pts=0',
        '-ac', '1', '-c:a', 'pcm_s16le', work.path + '/mix.wav'];
      const json = await inv('transcribe', { id: work.id, audioArgs, lang, model });
      work = null;
      if (cancelled) throw new Error('cancelled');
      found.set(path, S.parseWhisper(JSON.parse(json)));
    }
    if (P !== project || clips.some((it, i) => item(it.id) !== it || media(it)?.path !== sources[i])) throw new Error(tr('transcriptChanged'));
    snapshot();
    clips.forEach((it, i) => { it.transcript = found.get(sources[i]); });
    refresh();
    if (![...found.values()].some(words => words.length)) toast(tr('noSpeech'));
  } catch (e) {
    const message = cleanErr(e);
    toast(cancelled ? tr('cancelled') : message === 'whisper' ? tr('needWhisper') : message);
  } finally {
    if (work) await inv('work_end', { id: work.id }).catch(() => {});
    hideModal();
    transcribing = false;
    $('#transcribeClips').disabled = false;
  }
}
function visibleTranscript() {
  const entries = [];
  for (const it of timelineItems()) {
    if (!Array.isArray(it.transcript)) continue;
    const from = num(it.in, 0), to = from + S.srcLen(it), locked = lockedTrack(it.track);
    it.transcript.forEach((word, index) => {
      const mid = (word.s + word.e) / 2;
      // A word crossing a split belongs to the piece containing its midpoint.
      if (!(word.e > word.s && mid >= from && mid < to)) return;
      const start = it.start + S.ltAt(it, Math.max(word.s, from) - from);
      const end = it.start + S.ltAt(it, Math.min(word.e, to) - from);
      entries.push({ it, word, index, start, end, locked });
    });
  }
  return entries.sort((a, b) => a.start - b.start);
}
function renderTranscript() {
  const entries = visibleTranscript();
  if (P !== transcriptProject || entries.length !== transcriptEntries.length || entries.some((entry, i) => {
    const old = transcriptEntries[i];
    return entry.it !== old.it || entry.word !== old.word || entry.index !== old.index || entry.start !== old.start ||
      entry.end !== old.end || entry.locked !== old.locked;
  }) || !transcriptText.childElementCount || transcriptText.lang !== LANG) {
    transcriptProject = P;
    transcriptEntries = entries;
    transcriptText.lang = LANG;
    pickedWords.clear();
    wordAnchor = null;
    wordDrag = null;
    currentWord = -1;
    let end = -Infinity, html = '';
    transcriptEnds = entries.map(({ word, start, end: stop }, i) => {
      if (start - end > 0.8) html += (i ? '</p>' : '') + '<p dir="auto">';
      html += `<button type="button" tabindex="-1" class="transcript-word" data-word="${i}" aria-pressed="false">${esc(word.w)}</button> `;
      end = Math.max(end, stop);
      return end;
    });
    transcriptText.innerHTML = html ? html + '</p>' : `<p class="hint">${esc(tr('transcriptEmpty'))}</p>`;
    transcriptButtons = [...transcriptText.querySelectorAll('[data-word]')];
  }
  renderFillers();
  paintWordSelection();
  updateTranscriptPlayhead();
}
function updateTranscriptPlayhead() {
  let lo = 0, hi = transcriptEntries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (transcriptEntries[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  let next = lo - 1;
  while (next >= 0 && transcriptEnds[next] > t && transcriptEntries[next].end <= t) next--;
  if (next >= 0 && transcriptEnds[next] <= t) next = -1;
  if (next === currentWord) return;
  transcriptButtons[currentWord]?.classList.remove('current');
  currentWord = next;
  transcriptButtons[currentWord]?.classList.add('current');
}
function paintWordSelection() {
  transcriptButtons.forEach((b, i) => {
    b.classList.toggle('picked', pickedWords.has(i));
    b.setAttribute('aria-pressed', pickedWords.has(i));
  });
  $('#cutTranscript').disabled = !pickedWords.size;
}
function pickWordSpan(a, b) {
  pickedWords.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!transcriptEntries[i]?.locked) pickedWords.add(i);
  paintWordSelection();
}
transcriptText.addEventListener('pointerdown', e => {
  const word = e.target.closest('[data-word]');
  if (e.button !== 0 || !word) return;
  e.preventDefault();
  transcriptText.focus({ preventScroll: true });
  const i = +word.dataset.word;
  if (!e.shiftKey || wordAnchor == null) wordAnchor = i;
  pickWordSpan(wordAnchor, i);
  wordDrag = { id: e.pointerId, from: wordAnchor, last: i, dragged: e.shiftKey };
});
window.addEventListener('pointermove', e => {
  if (wordDrag?.id !== e.pointerId) return;
  const word = document.elementFromPoint(e.clientX, e.clientY)?.closest('#transcriptText [data-word]');
  if (!word || +word.dataset.word === wordDrag.last) return;
  wordDrag.last = +word.dataset.word;
  wordDrag.dragged = true;
  pickWordSpan(wordDrag.from, wordDrag.last);
});
window.addEventListener('pointerup', e => {
  if (wordDrag?.id !== e.pointerId) return;
  if (!wordDrag.dragged && transcriptEntries[wordDrag.last]) seek(transcriptEntries[wordDrag.last].start);
  wordDrag = null;
});
window.addEventListener('pointercancel', e => { if (wordDrag?.id === e.pointerId) wordDrag = null; });

const fillerKey = text => S.normalizeArabic(text).toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
function findFillers() {
  const patterns = new Map(), byClip = new Map(), selected = new Set();
  for (const { text, enabled } of fillers) {
    const words = fillerKey(text);
    if (!enabled || !words.length) continue;
    if (!patterns.has(words[0])) patterns.set(words[0], new Map());
    patterns.get(words[0]).set(words.join(' '), words);
  }
  transcriptEntries.forEach((entry, i) => {
    if (entry.locked) return;
    if (!byClip.has(entry.it)) byClip.set(entry.it, []);
    byClip.get(entry.it).push(...fillerKey(entry.word.w).map(word => ({ word, i })));
  });
  let count = 0;
  for (const words of byClip.values()) for (let i = 0; i < words.length;) {
    const matches = patterns.get(words[i].word);
    let length = 0;
    for (const pattern of matches?.values() || []) if (pattern.length > length && pattern.every((word, j) => {
      const token = words[i + j];
      return token?.word === word && (!j || transcriptEntries[token.i].start - transcriptEntries[words[i + j - 1].i].end <= 0.75);
    })) length = pattern.length;
    if (!length) { i++; continue; }
    count++;
    for (let j = 0; j < length; j++) selected.add(words[i++].i);
  }
  return { count, selected };
}
function renderFillers() {
  updateFillerCount();
  $('#fillerInput').setAttribute('aria-label', tr('fillerPhrase'));
  $('#fillerList').innerHTML = fillers.map(({ text, enabled }, i) => `<span class="filler-entry"><label><input type="checkbox" data-filler="${i}"${enabled ? ' checked' : ''}><bdi>${esc(text)}</bdi></label>
    <button type="button" data-drop-filler="${i}" aria-label="${esc(tr('remove') + ' ' + text)}">×</button></span>`).join('');
}
function updateFillerCount() {
  const { count } = findFillers();
  $('#fillerCount').textContent = tr('fillerCount', { n: count });
  $('#selectFillers').disabled = !count;
}
const saveFillers = () => lsSet('kadr.fillers', fillers);
$('#fillerList').onchange = e => {
  const { filler } = e.target.dataset;
  if (filler != null) { fillers[filler].enabled = e.target.checked; saveFillers(); updateFillerCount(); }
};
$('#fillerList').onclick = e => {
  const { dropFiller } = e.target.dataset;
  if (dropFiller != null) { fillers.splice(+dropFiller, 1); saveFillers(); renderFillers(); }
};
$('#fillerForm').onsubmit = e => {
  e.preventDefault();
  const input = $('#fillerInput'), text = input.value.trim();
  if (!fillerKey(text).length || fillers.some(f => f.text === text)) return;
  fillers.push({ text, enabled: true });
  input.value = '';
  saveFillers();
  renderFillers();
};
$('#selectFillers').onclick = () => {
  pickedWords = findFillers().selected;
  wordAnchor = null;
  paintWordSelection();
  transcriptText.focus();
};

function applySpeechCuts(byTrack) {
  // The removed time is rippled out of every unlocked track (and the markers), so captions, music and b-roll stay in sync.
  const cuts = [...byTrack].flatMap(([track, ranges]) => lockedTrack(track) ? [] : ranges.map(([a, b]) => [a, b]));
  if (!cuts.length) return 0;
  const changes = new Map(), inScope = timelineItems();
  for (const track of new Set(inScope.map(it => it.track))) {
    if (lockedTrack(track)) continue;
    const clips = inScope.filter(it => it.track === track);
    const row = [...clips, ...laneObstacles(track).map(it => ({ ...it, fixed: true }))];
    const pieces = S.cutRanges(row, cuts, 1 / P.fps, it => sourceBound(it)?.dur ?? Infinity, true);
    if (pieces === row) continue;
    const replacements = new Map(clips.map(it => [it.id, []]));
    for (const piece of pieces) {
      if (piece.fixed) continue;
      const kept = replacements.get(piece.id);
      kept.push(kept.length ? { ...piece, id: uid() } : piece);
    }
    for (const [id, kept] of replacements) changes.set(id, kept);
  }
  if (!changes.size) return 0;
  setPlaying(false);
  snapshot();
  P.items = P.items.flatMap(it => changes.get(it.id) ?? [it]);
  if (!openGrp) P.markers = S.cutMarkers(P.markers, cuts);
  silencePreview = null;
  pickedWords.clear();
  refresh();
  return [...byTrack.values()].reduce((n, ranges) => n + ranges.length, 0);
}
function addSpeechRanges(byTrack, it, ranges) {
  if (!ranges.length) return;
  if (!byTrack.has(it.track)) byTrack.set(it.track, []);
  byTrack.get(it.track).push(...ranges.map(([a, b]) => [a, b, it.id]));
}
function cutTranscript(entries, indices) {
  const words = new Map(), ranges = new Map();
  for (const i of indices) {
    const entry = entries[i];
    if (!entry || entry.locked) continue;
    if (!words.has(entry.it)) words.set(entry.it, []);
    words.get(entry.it).push(entry.word);
  }
  for (const [it, selected] of words) addSpeechRanges(ranges, it, S.speechTimelineRegions(it, S.wordsToRanges(selected)));
  return applySpeechCuts(ranges);
}
$('#transcribeClips').onclick = transcribeClips;
$('#findHighlights').onclick = openHighlights;
const cutPickedWords = () => {
  renderTranscript();
  cutTranscript(transcriptEntries, pickedWords);
  transcriptText.focus();
};
$('#cutTranscript').onclick = cutPickedWords;
$('#transcript').addEventListener('keydown', e => {
  if (!['Delete', 'Backspace'].includes(e.key) || e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat && pickedWords.size) cutPickedWords();
});

const silenceOptions = (options = {}) => ({
  thresholdDb: clamp(num(options.thresholdDb, -40), -100, 0),
  minSilence: Math.max(0, num(options.minSilence, 0.5)),
  padding: Math.max(0, num(options.padding, 0.12)),
});
const readSilenceOptions = () => silenceOptions({ thresholdDb: $('#silenceThreshold').valueAsNumber,
  minSilence: $('#minSilence').valueAsNumber, padding: $('#silencePadding').valueAsNumber });
async function scanSilences(clips, options) {
  const project = P, group = openGrp, stamp = speechStamp(clips), found = new Map(), ranges = new Map();
  const { thresholdDb, minSilence, padding } = options;
  for (const it of clips) {
    const path = media(it).path;
    if (!found.has(path)) found.set(path, await inv('speech_regions', { path, thresholdDb, silences: true }));
    if (P !== project || group !== openGrp || clips.some(clip => item(clip.id) !== clip || lockedTrack(clip.track))
      || speechStamp(clips) !== stamp) throw new Error(tr('transcriptChanged'));
    const silence = S.speechTimelineRegions(it, found.get(path));
    addSpeechRanges(ranges, it, S.silencesToCuts(silence, it.start, it.start + it.dur, minSilence, padding));
  }
  return { project, ranges };
}
const silenceSignature = () => JSON.stringify([openGrp, speechStamp(speechTargets()), readSilenceOptions()]);
function renderSilencePreview() {
  if (silencePreview && (silencePreview.project !== P || silencePreview.signature !== silenceSignature())) silencePreview = null;
  $$('#rows .silence-cut').forEach(el => el.remove());
  const ranges = silencePreview?.ranges;
  $('#silenceCount').textContent = scanningSilences ? tr('silenceWork') :
    ranges ? tr('silenceCount', { n: [...ranges.values()].reduce((n, row) => n + row.length, 0) }) : '';
  $('#previewSilences').disabled = $('#applySilences').disabled = scanningSilences;
  if (!ranges) return;
  for (const row of $$('#rows .row')) {
    const cuts = ranges.get(row.dataset.track);
    if (!cuts) continue;
    row.insertAdjacentHTML('beforeend', cuts.map(([a, b]) =>
      `<i class="silence-cut" style="left:calc(${a}px * var(--pps));width:calc(${b - a}px * var(--pps))"></i>`).join(''));
  }
}
async function runSilenceAction(apply) {
  if (scanningSilences) return;
  const clips = speechTargets();
  if (!clips.length) return toast(tr('needAudio'));
  const signature = silenceSignature();
  scanningSilences = true;
  renderSilencePreview();
  try {
    const result = (apply && silencePreview) || await scanSilences(clips, readSilenceOptions());
    if (P !== result.project || signature !== silenceSignature()) throw new Error(tr('transcriptChanged'));
    if (apply) {
      if (!applySpeechCuts(result.ranges)) toast(tr('silenceCount', { n: 0 }));
    } else silencePreview = { ...result, signature };
  } catch (e) {
    toast(cleanErr(e));
  } finally {
    scanningSilences = false;
    renderSilencePreview();
  }
}
$('#previewSilences').onclick = () => runSilenceAction(false);
$('#applySilences').onclick = () => runSilenceAction(true);
for (const id of ['silenceThreshold', 'minSilence', 'silencePadding']) $('#' + id).oninput = renderSilencePreview;

/* ---------- voiceover ---------- */
let rec = null;
async function toggleRecord() {
  if (rec) { rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast(tr('micDenied')); }
  const mime = ['audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const r = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [], at = t;
  r.ondataavailable = e => e.data.size && chunks.push(e.data);
  r.onstop = async () => {
    stream.getTracks().forEach(x => x.stop());
    rec = null;
    $('#bRec').classList.remove('rec');
    setPlaying(false);
    const blob = new Blob(chunks, { type: r.mimeType });
    const ext = r.mimeType.includes('mp4') ? 'm4a' : 'webm';
    try {
      const path = await inv('save_recording', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-ext': ext } });
      const [mid] = addToBin(await inv('probe', { paths: [path] }));
      if (mid) {
        const free = ['a1', 'a2'].find(a => !P.items.some(i => i.track === a && i.start < at + P.media[mid].dur && i.start + i.dur > at)) || 'a2';
        addMedia(mid, free, at);
      }
    } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
  };
  r.start();
  rec = r;
  $('#bRec').classList.add('rec');
  toast(tr('recording'));
  setPlaying(true);
}

/* ---------- screen + camera + microphone recording (ffmpeg, record.rs) ---------- */
const REC_SOURCES = [['screen', 'recScreenSrc'], ['camera', 'recCamera'], ['mic', 'recMic']];
let screenRec = null; // { timer, pill } while a recording runs
async function openRecorder() {
  if (screenRec || rec || exporting) return;
  const box = $('#mBox');
  $('#modal').hidden = false;
  box.onclick = null;
  box.innerHTML = `<h3>${tr('recScreen')}</h3><p class="hint" id="rcStatus" role="status">${tr('recHint')}</p>
    ${REC_SOURCES.map(([k, label]) => `<label class="sam-field"><input type="checkbox" id="rcOn_${k}" ${k === 'screen' ? 'checked' : ''}><span>${tr(label)}</span><select id="rcSel_${k}" dir="auto"></select></label>`).join('')}
    <label class="sam-field"><input type="checkbox" id="rcAdd" ${pref('recAdd', 'true') !== 'false' ? 'checked' : ''}>${tr('recAdd')}</label>
    <div class="acts"><button id="rcClose">${tr('hlClose')}</button><span class="flex"></span><button class="primary" id="rcGo" disabled>${tr('recStart')}</button></div>`;
  $('#rcClose').onclick = hideModal;
  const status = txt => { $('#rcStatus').textContent = txt; };
  try {
    const d = await inv('record_devices');
    for (const [k, list] of [['screen', d.screens], ['camera', d.cameras], ['mic', d.mics]]) {
      $('#rcSel_' + k).innerHTML = list.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
      if (!list.length) { $('#rcOn_' + k).checked = false; $('#rcOn_' + k).disabled = $('#rcSel_' + k).disabled = true; }
    }
  } catch (e) { return status(tr('error') + ': ' + cleanErr(e)); }
  $('#rcGo').disabled = false;
  $('#rcGo').onclick = async () => {
    const opts = {};
    for (const [k] of REC_SOURCES) if ($('#rcOn_' + k).checked) opts[k] = $('#rcSel_' + k).value;
    if (!Object.keys(opts).length) return status(tr('recPick'));
    const add = $('#rcAdd').checked;
    setPref('recAdd', add);
    $('#rcGo').disabled = true;
    for (let n = 3; n > 0; n--) { status(String(n)); await new Promise(r => setTimeout(r, 1000)); if (!$('#rcStatus')?.isConnected) return; }
    try {
      await inv('record_start', { opts, dir: projectPath ? projectPath.replace(/[\\/][^\\/]*$/, '') : null });
    } catch (e) {
      const m = cleanErr(e);
      $('#rcGo').disabled = false;
      if (!/^permission/.test(m)) return status(tr('error') + ': ' + m);
      status(tr('recPerm'));
      const kind = /screen/.test(m) ? 'screen' : opts.camera ? 'camera' : 'mic';
      if (await TA.dialog.ask(tr('recPerm'), { title: tr('recScreen') })) inv('record_open_privacy', { kind });
      return;
    }
    hideModal();
    const t0 = Date.now(), pill = document.createElement('div');
    pill.id = 'recPill';
    pill.innerHTML = `<i></i><span dir="ltr">00:00</span><button class="primary">${tr('stopRec')}</button>`;
    document.body.append(pill);
    const timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); pill.querySelector('span').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
    screenRec = { timer, pill };
    pill.querySelector('button').onclick = () => stopRecorder(add);
  };
}
async function stopRecorder(add) {
  const { timer, pill } = screenRec;
  clearInterval(timer);
  pill.querySelector('button').disabled = true;
  try {
    const files = await inv('record_stop');
    if (!files.length) return toast(tr('error') + ': ' + tr('recEmpty'));
    addToBin(await inv('probe', { paths: files.map(f => f.path) }));
    const placed = files.map(f => {
      const [mid, m] = Object.entries(P.media).find(([, x]) => x.path === f.path) || [];
      return m && { role: f.role, media: mid, w: m.w, h: m.h };
    }).filter(Boolean);
    if (add && placed.length) {
      snapshot(); // one undo step for the whole recording
      for (const x of S.recordPlacement(placed, P.w, P.h, t)) addMedia(x.media, x.track, x.start, x.extra, true);
    }
    toast(tr('recSaved', { n: files.length }));
  } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
  finally { pill.remove(); screenRec = null; }
}
$('#bRecScreen').onclick = openRecorder;

/* ---------- project ---------- */
const REFRAME_ASPECTS = ['9:16', '1:1', '4:5', '16:9'];
function reframeClip(it, m, samples, start, w, h) {
  const C = S.srcCrop(it, m), cover = Math.max(w / C.w, h / C.h);
  const L = S.layout(S.animAt(it, 0), m, P.w, P.h);
  // Older tracks stored offsets from the picked subject without its absolute position.
  const basis = it.trk?.reframe || [P.w / L.sw, P.h / L.sh];
  const tracked = P.items.map(f => f.trk?.subject).filter(s => s?.clip === it.id && s.media === it.media && s.pts.length);
  const centres = samples.map(([offset, x, y, cut]) => {
    const lt = S.ltAt(it, offset);
    const subject = tracked.find(s => start + offset >= s.pts[0][0] && start + offset <= s.pts.at(-1)[0]);
    if (subject) [x, y] = S.trackOffset(subject, start + offset);
    else if (it.trk?.pts.length && !it.trk.subject) {
      const [dx, dy] = S.trackOffset(it.trk, lt);
      x = (C.x + C.w * (0.5 + dx * basis[0] * (it.flipH ? -1 : 1))) / m.w;
      y = (C.y + C.h * (0.5 + dy * basis[1] * (it.flipV ? -1 : 1))) / m.h;
    }
    x = clamp((x * m.w - C.x) / C.w, 0, 1);
    y = clamp((y * m.h - C.y) / C.h, 0, 1);
    return [lt, it.flipH ? 1 - x : x, it.flipV ? 1 - y : y, cut];
  });
  const path = S.smoothPath(centres, { frame: [w / (C.w * cover), h / (C.h * cover)] });
  return { keys: S.cropKeyframes(path, C.w, C.h, w, h), basis };
}
function smartReframe() {
  const isVideo = it => media(it)?.kind === 'video';
  const selected = selectedItems().filter(isVideo);
  const clips = selected.length ? selected : P.items.filter(it => it.track === 'v1' && isVideo(it));
  if (!clips.length) return toast(tr('reframeNoVideo'));
  const box = $('#mBox');
  $('#modal').hidden = false;
  box.onclick = null;
  box.innerHTML = `<h3>${tr('reframe')}</h3><p class="hint">${tr(selected.length ? 'reframeSelected' : 'reframeMain', { n: clips.length })}</p>
    <label class="xr"><span>${tr('ratio')}</span><select id="reframeAspect" dir="ltr">${REFRAME_ASPECTS.map(r => `<option>${r}</option>`).join('')}</select></label>
    <div class="acts"><button id="reframeCancel">${tr('cancel')}</button><span class="flex"></span><button class="primary" id="reframeApply">${tr('reframe')}</button></div>`;
  const aspect = $('#reframeAspect');
  if (REFRAME_ASPECTS.includes($('#aspect').value)) aspect.value = $('#aspect').value;
  aspect.focus();
  $('#reframeCancel').onclick = () => { hideModal(); $('#smartReframe').focus(); };
  $('#reframeApply').onclick = () => runReframe(aspect.value, clips, box);
}
async function runReframe(ratio, clips, box) {
  setPlaying(false);
  const project = P, from = [P.w, P.h], [w, h] = ASPECTS[ratio], edits = [];
  box.innerHTML = `<div id="reframeStatus" role="status"></div><div class="pbar reframe-progress" role="progressbar" aria-label="${tr('reframe')}"><i></i></div>
    <div class="acts"><button id="reframeCancel">${tr('cancel')}</button></div>`;
  const status = $('#reframeStatus'), bar = box.querySelector('.pbar'), button = $('#reframeCancel');
  let stopped = false, job, unlisten;
  const cancel = () => {
    stopped = true;
    if (job) inv('reframe_cancel', { job }).catch(() => {});
    button.disabled = true;
    status.textContent = tr('reframeStopping');
  };
  button.onclick = cancel;
  button.focus();
  const escape = e => {
    if (e.key !== 'Escape' || !status.isConnected || $('#modal').hidden) return;
    e.preventDefault();
    cancel();
  };
  document.addEventListener('keydown', escape);
  const paint = p => {
    const percent = Math.round(p * 100);
    status.textContent = tr('reframeProgress', { i: Math.min(edits.length + 1, clips.length), n: clips.length, p: percent });
    bar.setAttribute('aria-valuenow', percent);
    bar.firstElementChild.style.width = percent + '%';
  };
  paint(0);
  try {
    unlisten = await TA.event.listen('reframe-progress', ({ payload }) => {
      if (!stopped && payload.job === job) paint((edits.length + payload.p) / clips.length);
    });
    for (const it of clips) {
      if (stopped || P !== project || !status.isConnected) return;
      const m = media(it), start = num(it.in, 0), duration = S.srcLen(it), original = JSON.stringify(it);
      job = 'reframe-' + uid();
      const samples = await inv('reframe_analyze', { job, path: m.path, start, duration });
      job = null;
      if (stopped || P !== project || !status.isConnected) return;
      edits.push({ it, original, ...reframeClip(it, m, samples, start, w, h) });
      paint(edits.length / clips.length);
    }
    if (from[0] !== P.w || from[1] !== P.h || edits.some(({ it, original }) => item(it.id) !== it || JSON.stringify(it) !== original)) {
      return toast(tr('reframeChanged'));
    }
    snapshot();
    [P.w, P.h] = [w, h];
    for (const { it, keys, basis } of edits) {
      it.fit = 'contain';
      for (const k of ['x', 'y', 'scale']) it[k] = keys[k][0][1];
      it.kf = { ...it.kf, ...keys };
      delete it.rotate;
      delete it.kf.rotate;
      if (it.trk) it.trk.reframe = basis;
    }
    syncSettings();
    refresh();
    toast(tr('reframeDone'));
  } catch (e) {
    if (!stopped && status.isConnected) toast(tr('error') + ': ' + cleanErr(e));
  } finally {
    document.removeEventListener('keydown', escape);
    unlisten?.();
    if (status.isConnected && !$('#modal').hidden) {
      hideModal();
      $('#smartReframe').focus();
    }
  }
}
function syncSettings() {
  P.markers = S.normalizeMarkers(P.markers);
  // speed curves were removed: old projects keep the clip at 1x over its whole source range
  for (const it of P.items) if (it.curve) { const src = S.srcLen(it); delete it.curve; it.speed = 1; it.dur = src; }
  const ar = Object.keys(ASPECTS).find(k => ASPECTS[k][0] === P.w && ASPECTS[k][1] === P.h);
  $('#aspect').innerHTML = Object.keys(ASPECTS).map(r => `<option>${r}</option>`).join('') + (ar ? '' : `<option value="custom">${P.w}×${P.h}</option>`);
  $('#aspect').value = ar || 'custom';
  renderBin();
  if (MEDIA_BASE) syncMediaProxies();
}
async function save(as) {
  let f = as ? null : projectPath;
  if (!f) f = await TA.dialog.save({ defaultPath: (P.name || (LANG === 'ar' ? 'مشروع' : 'project')) + '.maqto', filters: [{ name: 'Maqto', extensions: ['maqto'] }] });
  if (!f) return;
  if (!/\.(maqto|kadr)$/.test(f)) f += '.maqto';
  try { await inv('save_project', { path: f, json: JSON.stringify(P) }); } catch (e) { return toast(tr('error') + ': ' + cleanErr(e)); }
  projectPath = f;
  recent.add(f); recent.snap(f);
  dirty = false;
  lastAuto = JSON.stringify(P);
  clearRecovery();
  refresh();
  toast(tr('saved'));
}
// Autosave: a project with a file is written to it ~2s after each change; untitled work goes to a
// recovery file that reopens on the next launch (crash, force quit, power cut).
let lastAuto = '', recPath = null, autoBusy = false;
const clearRecovery = () => lsSet('kadr.recovery', 0);
async function autosave() {
  if (!MEDIA_BASE || autoBusy || cancelProTrim) return;
  const js = JSON.stringify(P);
  if (js === lastAuto) return;
  if (!projectPath && !P.items.length && !Object.keys(P.media).length) return;
  autoBusy = true;
  try {
    if (projectPath) {
      await inv('save_project', { path: projectPath, json: js });
      recent.snap(projectPath);
      if (JSON.stringify(P) === js) { dirty = false; $('#pname').textContent = $('#pname').textContent.replace(/ •$/, ''); }
    } else {
      recPath = recPath || await inv('recovery_path');
      await inv('save_project', { path: recPath, json: js });
      recent.snap('recovery');
      lsSet('kadr.recovery', 1);
    }
    lastAuto = js;
  } catch (e) { /* try again on the next tick */ } finally { autoBusy = false; }
}
setInterval(autosave, 2000);
async function writeFills(Q, work) {
  for (const it of Q.items) {
    if (cancelled) throw new Error(tr('cancelled'));
    const m = Q.media[it.media];
    if (!m || !m.fill || it.hidden) continue;
    const c = document.createElement('canvas'); c.width = Q.w; c.height = Q.h;
    paintFill(c.getContext('2d'), it.fill || {}, Q.w, Q.h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const id = 'fillx_' + it.id, name = id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) + '.png';
    Q.media[id] = { kind: 'image', path: await inv('write_work', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-id': String(work.id), 'x-name': name } }), w: Q.w, h: Q.h, name };
    it.media = id;
  }
}
async function writeMasks(Q, work) {
  const out = {};
  for (const it0 of Q.items) {
    if (cancelled) throw new Error(tr('cancelled'));
    const m = media(it0, Q);
    if (it0.audioOnly || !m || m.kind === 'audio' || !S.hasMask(it0)) continue;
    // same box the export cuts the clip to (largest keyframed scale)
    const it = S.bakeVa(it0, Q.w, Q.h), kf = S.hasKf(it, S.VIS_KF) ? it.kf : null, LP = it._loop ? S.VA_LOOP[it._loop] : null;
    const smax = (kf && kf.scale ? Math.max(...kf.scale.map(q => q[1])) : num(it.scale, 1)) * (LP && LP.smax || 1);
    const L = S.layout({ ...it, scale: smax }, m, Q.w, Q.h), w = Math.max(2, Math.round(L.cw)), h = Math.max(2, Math.round(L.ch));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), a = document.createElement('canvas'); a.width = w; a.height = h;
    S.drawMask(a.getContext('2d'), it0.mask, w, h);
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.drawImage(a, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const name = 'mask_' + String(it0.id).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) + '.png';
    out[it0.id] = await inv('write_work', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-id': String(work.id), 'x-name': name } });
  }
  return out;
}
async function writeLuts(Q, work) {
  const out = {};
  for (const it of Q.items) {
    if (cancelled) throw new Error(tr('cancelled'));
    const m = media(it, Q);
    if (it.audioOnly || !m || m.kind === 'audio' || !S.hasColor(it)) continue;
    const f = it.color && it.color.lut && it.color.lut.file, ul = f ? await loadUserLut(f) : null;
    const name = 'lut_' + String(it.id).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) + '.cube';
    out[it.id] = await inv('write_work', new TextEncoder().encode(S.cubeText(S.bakeLut(it, ul, S.LUT_N, { noMask: true }))), { headers: { 'x-id': String(work.id), 'x-name': name } });
  }
  return out;
}
async function restoreRecovery() {
  if (!lsGet('kadr.recovery', 0)) return false;
  try {
    const r = await inv('open_project', { path: await inv('recovery_path') });
    P = Object.assign(newProject(), r.project);
  } catch { clearRecovery(); return false; }
  projectPath = null; openGrp = null; setSelection([]); t = 0; dirty = true;
  lastAuto = JSON.stringify(P);
  undoStack.length = redoStack.length = 0;
  syncSettings();
  refresh();
  toast(tr('recovered'));
  return true;
}
async function open() {
  if (dirty && !(await TA.dialog.ask(tr('unsaved'), { kind: 'warning' }))) return;
  const f = await TA.dialog.open({ filters: [{ name: 'Maqto', extensions: ['maqto', 'kadr'] }] });
  if (f) openPath(f, true);
}
async function openPath(f, asked) {
  if (!asked && dirty && !(await TA.dialog.ask(tr('unsaved'), { kind: 'warning' }))) return;
  let r;
  try { r = await inv('open_project', { path: f }); } catch (e) { return toast(tr('error') + ': ' + cleanErr(e)); }
  setPlaying(false);
  P = Object.assign(newProject(), r.project);
  projectPath = f;
  recent.add(f);
  openGrp = null; setSelection([]); t = 0; dirty = false;
  lastAuto = JSON.stringify(P); clearRecovery();
  undoStack.length = redoStack.length = 0;
  syncSettings();
  refresh();
  offline = new Set(r.missingIds);
  if (offline.size) relinkDialog();
}

// ---------- offline media + relink ----------
async function scanOffline() {
  const ids = Object.keys(P.media).filter(id => P.media[id].path);
  const gone = new Set((await inv('collect_sizes', { paths: ids.map(id => P.media[id].path) }).catch(() => ({ missing: [] }))).missing);
  offline = new Set(ids.filter(id => gone.has(P.media[id].path)));
  needsDraw = true;
}
function drawOffline(ctx, it, project) {
  const { w, h } = project, m = project.media[it.media];
  ctx.save();
  ctx.fillStyle = '#241a1a'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,90,90,.28)'; ctx.lineWidth = Math.max(2, w / 160);
  for (let x = -h; x < w; x += w / 10) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${w / 13}px system-ui, sans-serif`; ctx.fillText(tr('mediaOffline'), w / 2, h / 2);
  ctx.font = `${w / 28}px system-ui, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(m?.name || '', w / 2, h / 2 + w / 11);
  ctx.restore();
}
async function applyRelink(pairs) {
  const probed = pairs.length ? (await inv('probe', { paths: pairs.map(x => x.path) }).catch(() => ({ ok: [] }))).ok : [];
  const info = new Map(probed.map(x => [x.path, x]));
  const good = pairs.filter(x => info.has(x.path));
  if (!good.length) return 0;
  snapshot(); // one undo step for the whole relink
  for (const { id, path } of good) {
    const fresh = info.get(path);
    Object.assign(P.media[id], { path, size: fresh.size, ...(fresh.sourceKey ? { sourceKey: fresh.sourceKey } : {}) });
  }
  await scanOffline();
  refresh();
  return good.length;
}
function relinkDialog() {
  const list = [...offline].filter(id => P.media[id]).map(id => ({ id, ...P.media[id] }));
  if (!list.length) return hideModal();
  const box = $('#mBox');
  box.onclick = box.ondblclick = null;
  box.innerHTML = `<h3>${tr('relinkTitle')}</h3><p class="hint">${tr('relinkHint', { n: list.length })}</p>
    <div class="relink-list">${list.map(m => `<div class="relink-row"><span dir="ltr"><b>${esc(m.name || S.baseName(m.path))}</b><small>${esc(m.path)}</small></span><button type="button" data-locate="${m.id}">${tr('relinkLocate')}</button></div>`).join('')}</div>
    <div class="acts"><button type="button" id="rlSearch">${tr('relinkSearch')}</button><button type="button" class="primary" id="rlClose">${tr('relinkLater')}</button></div>`;
  $('#modal').hidden = false;
  const done = n => { n && toast(tr('relinked', { n })); offline.size ? relinkDialog() : hideModal(); };
  $('#rlClose').onclick = hideModal;
  box.querySelectorAll('[data-locate]').forEach(b => b.onclick = async () => {
    const f = await TA.dialog.open({ multiple: false });
    if (f) done(await applyRelink([{ id: b.dataset.locate, path: f }]));
  });
  $('#rlSearch').onclick = async () => {
    const root = await TA.dialog.open({ directory: true });
    if (!root) return;
    const found = await inv('relink_search', { root, names: [...new Set(list.map(m => S.baseName(m.path)))] }).catch(() => []);
    done(await applyRelink(S.relinkMatches(list, found)));
  };
}

// ---------- collect project ----------
const fmtGB = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB';
function collectProject() {
  if (!Object.keys(P.media).length) return toast(tr('emptyTl'));
  const box = $('#mBox');
  box.onclick = box.ondblclick = null;
  box.innerHTML = `<form id="collectForm"><h3>${tr('collectTitle')}</h3><p class="hint">${tr('collectHint')}</p>
    <label class="sam-field"><input type="checkbox" id="colProxy">${tr('collectProxies')}</label>
    <label class="sam-field"><input type="checkbox" id="colCache">${tr('collectCaches')}</label>
    <label class="sam-field"><input type="checkbox" id="colZip">${tr('collectZip')}</label>
    <div class="acts"><button type="button" id="mNo">${tr('cancel')}</button><button class="primary">${tr('collectPick')}</button></div></form>`;
  $('#modal').hidden = false;
  $('#mNo').onclick = hideModal;
  $('#collectForm').onsubmit = async e => {
    e.preventDefault();
    const opt = { proxy: $('#colProxy').checked, cache: $('#colCache').checked, zip: $('#colZip').checked };
    hideModal();
    try {
      const dest = await TA.dialog.open({ directory: true });
      if (dest) await runCollect(dest, opt);
    } catch (err) { hideModal(); toast(tr('error') + ': ' + cleanErr(err)); }
  };
}
async function runCollect(dest, opt) {
  const name = (P.name || (projectPath && projectPath.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/i, '')) || 'Project').replace(/[\\/:*?"<>|]/g, '_');
  const entries = [
    ...Object.values(P.media).map(m => ({ path: m.path, dir: 'Media' })),
    ...P.items.map(it => ({ path: it.color?.lut?.file, dir: 'LUTs' })),
  ];
  // Proxies and AI caches are keyed by the original path in this session, so they ride along as plain extra files.
  if (opt.proxy) entries.push(...[...mediaProxies.values()].map(x => ({ path: x.file, dir: 'Proxies' })));
  if (opt.cache) entries.push(...[...upscaleCaches.values(), ...depthCaches.values()].map(x => ({ path: typeof x?.path === 'string' ? x.path : '', dir: 'Cache' })));
  const wanted = entries.filter(x => x.path);
  const { total, missing } = await inv('collect_sizes', { paths: [...new Set(wanted.map(x => x.path))] });
  const gone = new Set(missing);
  const plan = S.collectPlan(wanted.filter(x => !gone.has(x.path)));
  const lost = [...gone].filter(f => entries.some(x => x.path === f && x.dir !== 'Proxies' && x.dir !== 'Cache'));
  const ok = await TA.dialog.ask(tr('collectConfirm', { n: plan.files.length, size: fmtGB(total), dest: dest + '/' + name }) + (lost.length ? '\n\n' + tr('collectOffline', { n: lost.length }) : ''), { kind: 'warning' });
  if (!ok) return;
  const job = 'collect' + Date.now(), box = $('#mBox');
  box.onclick = box.ondblclick = null;
  const paint = (done, all) => {
    box.innerHTML = `<div>${tr('collecting')} — ${all ? Math.round(done / all * 100) : 0}%</div><div class="pbar"><i style="width:${all ? Math.round(done / all * 100) : 0}%"></i></div><div class="acts"><button id="mCancel">${tr('cancel')}</button></div>`;
    $('#mCancel').onclick = () => inv('collect_cancel');
  };
  paint(0, total);
  $('#modal').hidden = false;
  const un = await TA.event.listen('collectprog', ({ payload }) => payload.job === job && paint(payload.done, payload.total));
  try {
    const json = JSON.stringify(S.collectRewrite(P, plan.map));
    const r = await inv('collect_run', { job, dest, name, files: plan.files, projectJson: json, zip: opt.zip });
    toast(tr('collected', { dir: r.zip || r.dir }));
  } catch (err) {
    const msg = cleanErr(err);
    toast(msg === 'cancelled' ? tr('cancelled') : tr('error') + ': ' + msg);
  } finally { un(); hideModal(); }
}

async function timelineReport(title, warnings, empty) {
  const sections = Object.entries(warnings).map(([key, names]) =>
    tr('timelineWarn_' + key) + '\n' + names.map(name => '• ' + (name || tr('marker'))).join('\n'));
  await TA.dialog.message(sections.join('\n\n') || tr(empty), { title: tr(title) });
}
async function writeTimeline(format, path) {
  const { text, warnings } = interchange.exportTimeline(P, format);
  if (typeof path !== 'string' || !path.trim()) throw new Error(tr('timelinePath'));
  if (!path.toLowerCase().endsWith('.' + format)) path += '.' + format;
  await inv('save_timeline', { path, text });
  return { path, warnings };
}
function exportTimelineDialog() {
  const box = $('#mBox');
  box.onclick = box.ondblclick = null;
  box.innerHTML = `<form id="timelineExportForm"><h3>${tr('timelineExport')}</h3>
    <label class="f"><span>${tr('timelineFormat')}</span>
      <select id="timelineFormat">${Object.entries(interchange.formats).map(([ext, name]) => `<option value="${ext}">${name}</option>`).join('')}</select></label>
    <div class="acts"><button type="button" id="mNo">${tr('cancel')}</button><button class="primary">${tr('export')}</button></div></form>`;
  $('#modal').hidden = false;
  $('#timelineFormat').focus();
  $('#mNo').onclick = hideModal;
  $('#timelineExportForm').onsubmit = async e => {
    e.preventDefault();
    const format = $('#timelineFormat').value;
    hideModal();
    try {
      const name = (P.name || (projectPath && projectPath.split(/[\\/]/).pop().replace(/\.(maqto|kadr)$/i, '')) || 'Maqto').replace(/[\\/]/g, '-');
      const path = await TA.dialog.save({ defaultPath: name + '.' + format,
        filters: [{ name: interchange.formats[format], extensions: [format] }] });
      if (!path) return;
      const { warnings } = await writeTimeline(format, path);
      await timelineReport('timelineExported', warnings, 'timelineExportClean');
    } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
  };
}
async function importTimelineDialog() {
  try {
    const path = await TA.dialog.open({ filters: [{ name: 'FCPXML / OpenTimelineIO', extensions: ['fcpxml', 'otio'] }] });
    if (!path) return;
    const text = await inv('read_timeline', { path });
    const { project, warnings } = path.toLowerCase().endsWith('.otio')
      ? interchange.importOTIO(JSON.parse(text.replace(/^\uFEFF/, '')), path) : interchange.importFCPXML(text, path);
    const entries = Object.entries(project.media);
    const paths = [...new Set(entries.map(([, m]) => m.path))];
    const sources = paths.length ? (await inv('probe', { paths })).ok : [];
    const available = new Map(sources.map(m => [m.path, m]));
    const offline = paths.filter(path => !available.has(path));
    if (offline.length) warnings.offline = offline;
    const dimensions = sources.find(m => m.kind === 'video' && m.w && m.h);
    if (!project.w && dimensions) { project.w = dimensions.w; project.h = dimensions.h; }
    const ids = new Map();
    project.media = Object.fromEntries(entries.map(([id, m]) => {
      const next = uid(), fresh = available.get(m.path);
      ids.set(id, next);
      return [next, fresh ? { ...m, ...fresh, kind: m.kind === 'audio' ? 'audio' : fresh.kind } : m];
    }));
    project.items = project.items.map(it => ({ ...it, id: uid(), media: ids.get(it.media) }));
    const defaults = newProject();
    const hasTrack = id => project.tracks.some(track => track.id === id);
    project.tracks = [
      ...defaults.tracks.filter(track => track.kind === 'text' || track.id === 'v2' && !hasTrack(track.id)),
      ...project.tracks,
      ...defaults.tracks.filter(track => track.kind === 'audio' && !hasTrack(track.id)),
    ];
    if ((dirty || projectPath || P.items.length || Object.keys(P.media).length) &&
        !(await TA.dialog.ask(tr('timelineReplace'), { title: tr('timelineImport'), kind: 'warning' }))) return;
    cancelProTrim?.();
    setPlaying(false);
    P = Object.assign(defaults, project);
    projectPath = null; openGrp = null; setSelection([]); binSel.clear(); t = 0; dirty = true;
    lastAuto = ''; clearRecovery();
    undoStack.length = redoStack.length = 0;
    const main = P.items.filter(it => it.track === 'v1').sort(byStart);
    if (magnet && main.some((it, index) => it.start - (index ? main[index - 1].start + main[index - 1].dur : 0) > 1e-6)) {
      magnet = false;
      $('#bMagnet').classList.remove('on');
    }
    syncSettings();
    refresh();
    await timelineReport('timelineImported', warnings, 'timelineImportClean');
  } catch (e) { toast(tr('error') + ': ' + cleanErr(e)); }
}

function setTool(x) {
  cancelProTrim?.();
  tool = x;
  $$('[data-tl-tool]').forEach(b => {
    const on = b.dataset.tlTool === x;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  $('#tl').dataset.tool = x;
  if (x !== 'blade') $('.bladeline')?.remove();
  renderTimeline();
}

$('#aspect').onchange = e => { if (!ASPECTS[e.target.value]) return; snapshot(); [P.w, P.h] = ASPECTS[e.target.value]; syncSettings(); refresh(); };
$('#smartReframe').onclick = smartReframe;
$('#bImport').onclick = importMedia;
$('#bText').onclick = () => addText('plain');
$('#bCaps').onclick = autoCaptions;
$('#bExport').onclick = exportDialog;
$('#bQueue').onclick = openRenderQueue;
$('#bSave').onclick = e => save(e.shiftKey);
$('#bOpen').onclick = open;
$('#bNew').onclick = () => newProj();
$('#bUndo').onclick = () => restore(undoStack, redoStack);
$('#bRedo').onclick = () => restore(redoStack, undoStack);
$('#bPlay').onclick = () => setPlaying(!playing);
$('#bBack').onclick = () => seek(0);
$('#bFwd').onclick = () => seek(total());
$$('[data-tl-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tlTool); });
$('#bSplit').onclick = splitAt;
$('#bDelL').onclick = () => trimTo('left');
$('#bDelR').onclick = () => trimTo('right');
$('#bDel').onclick = removeSel;
$('#bDup').onclick = duplicateSel;
$('#bMarker').onclick = addMarker;
$('#bMirror').onclick = mirrorSel;
$('#bRotate').onclick = rotateSel;
$('#bFreeze').onclick = freezeFrame;
$('#bCrop').onclick = () => {
  const it = sel && item(sel);
  if (!it || isText(it) || media(it).kind === 'audio') return;
  inspTab = 'tVideo';
  inspector();
  $('#cropGrp').scrollIntoView({ behavior: 'smooth' });
};
$('#bRec').onclick = toggleRecord;
$('#bMagnet').onclick = () => { magnet = !magnet; $('#bMagnet').classList.toggle('on', magnet); if (magnet) { snapshot(); if (openGrp) { for (const x of shownTracks()) packLane(x.id); } else pack(); refresh(); } };
$('#bSnap').onclick = () => { snapOn = !snapOn; $('#bSnap').classList.toggle('on', snapOn); };
$('#bZoomIn').onclick = () => setZoom(pps * 1.4);
$('#bZoomOut').onclick = () => setZoom(pps / 1.4);
$('#bFit').onclick = () => setZoom(($('#scroll').clientWidth - 40) / Math.max(total(), 1));
$('#bLang').onclick = () => { LANG = LANG === 'ar' ? 'en' : 'ar'; applyLang(); if (ws) renderDock(); if (panelVisible('aiTools')) renderAITools(); paintPiper(); renderLibCards(); refresh(); };

/* ---------- keyboard shortcuts ---------- */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
let clipBoard = null;
function selectionCopy() {
  const groups = Object.fromEntries(selectedGroups().map(id => [id, groupInfo(id)]));
  const items = selectedItems();
  const media = Object.fromEntries([...mediaDependencies(items)].map(id => [id, P.media[id]]));
  return { groups, items, media, tracks: P.tracks };
}
function copySel() {
  const data = selectionCopy();
  if (data.items.length) clipBoard = JSON.parse(JSON.stringify(data));
}
function cutSel() { copySel(); removeSel(); }
// A pasted clip never lands on top of another: nearest free lane of its kind above its own, else a new lane right above it.
// A new empty lane for a dropped file: sounds go under the others, pictures on top (`top`) or just over the main lane.
function newLaneFor(mid, top) {
  const kind = P.media[mid]?.kind === 'audio' ? 'audio' : 'video', x = { id: kind[0] + uid(), kind };
  if (kind === 'audio') P.tracks.push(x);
  else P.tracks.splice(top ? 0 : Math.max(0, P.tracks.findIndex(t => t.id === 'v1')), 0, x);
  return x.id;
}
function freeLaneAbove(clips, source, placed, keepLanes = false) {
  const track = clips[0].track, own = P.tracks.find(x => x.id === track), kind = own?.kind || source?.kind || laneKind(clips[0]);
  const occupied = [...P.items, ...placed, ...(!openGrp ? groupBlocks() : [])];
  const free = x => !x.locked && !occupied.some(i => i.track === x.id && clips.some(b => i.start < b.start + b.dur - 1e-6 && b.start < i.start + i.dur - 1e-6));
  if (own && free(own)) return track;
  const at = own ? P.tracks.indexOf(own) : 0;
  const up = !keepLanes && P.tracks.slice(0, at).reverse().find(x => x.kind === kind && x.id !== 'c1' && free(x));
  if (up) return up.id;
  const x = { id: kind[0] + uid(), kind };
  P.tracks.splice(own ? at : kind === 'audio' ? P.tracks.length : 0, 0, x);
  return x.id;
}
function insertCopies(data, at, duplicate) {
  if (!data?.items.length) return;
  snapshot();
  const { start } = S.groupSpan(data.items), ids = new Set(), groups = new Map(), tracks = new Map(), placed = [];
  const clips = JSON.parse(JSON.stringify(data.items));
  for (const [id, m] of Object.entries(data.media)) if (m && !P.media[id]) P.media[id] = JSON.parse(JSON.stringify(m));
  const single = clips.length === 1 && !Object.keys(data.groups).length;
  for (const b of clips) {
    b.id = uid();
    b.start = at + (b.start - start);
    if (!openGrp && data.groups[b.grp]) {
      if (!groups.has(b.grp)) {
        const id = 'g' + uid();
        P.groups[id] = { ...data.groups[b.grp] };
        groups.set(b.grp, id);
      }
      const key = b.grp + '/' + b.track;
      if (!tracks.has(key)) tracks.set(key, []);
      tracks.get(key).push(b);
    }
  }
  // Allocate each copied group lane once, preserving its members' relative placement.
  for (const row of tracks.values()) {
    const track = freeLaneAbove(row, data.tracks.find(x => x.id === row[0].track), placed, true);
    for (const b of row) {
      b.track = track; b.grp = groups.get(b.grp);
      placed.push(b);
      ids.add(b.grp);
    }
  }
  let packMain = false;
  for (const b of clips) {
    if (ids.has(b.grp)) continue;
    delete b.grp;
    const c = !openGrp && single && b.track === 'v1' && magnet && timelineItems().find(i => i.track === 'v1' && active(i, t));
    if (duplicate && single && P.tracks.some(x => x.id === b.track && !x.locked)) {
      if (!openGrp && b.track === 'v1' && magnet) b.start -= 1e-4;
    } else if (c) b.start = t - c.start > c.dur / 2 ? c.start + c.dur - 1e-4 : c.start - 1e-4;
    else b.track = freeLaneAbove([b], data.tracks.find(x => x.id === b.track), placed);
    if (openGrp) b.grp = openGrp;
    placed.push(b);
    ids.add(b.id);
    packMain ||= b.track === 'v1';
  }
  P.items = P.items.concat(clips);
  if (packMain) pack();
  setSelection([...ids]);
  refresh();
}
function pasteClip() { insertCopies(clipBoard, t, false); }
function duplicateSel() {
  const data = selectionCopy(), span = S.groupSpan(data.items);
  if (span) insertCopies(data, span.start + span.dur, true);
}
function selectStep(dir) {
  const clips = timelineClips(), cur = clips.find(i => i.id === sel), tracks = shownTracks(clips);
  const track = cur?.track || tracks.find(x => x.id === 'v1')?.id || tracks[0]?.id;
  const row = clips.filter(i => i.track === track).sort(byStart);
  const k = cur ? row.indexOf(cur) + dir : dir < 0 ? row.findLastIndex(i => i.start < t) : row.findIndex(i => i.start + i.dur > t);
  if (row[k]) { select(row[k].id); seek(row[k].start); }
}
function jumpCut(dir) {
  const eps = 0.5 / P.fps, pts = [0, total(), ...markerTimes(), ...P.items.flatMap(i => [i.start, i.start + i.dur])];
  const next = dir > 0 ? Math.min(...pts.filter(p => p > t + eps)) : Math.max(...pts.filter(p => p < t - eps));
  if (isFinite(next)) seek(next);
}
function jumpMarker(dir) {
  const end = total();
  const m = dir < 0 ? P.markers.findLast(m => m.time < t - 1e-6)
    : P.markers.find(m => m.time > t + 1e-6 && m.time <= end);
  if (m) seekMarker(m);
}
const frameDur = () => 1 / P.fps;
const COMMANDS = {
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [
    'multicam' + (i + 1), { group: 'wsMulticam', label: 'mcAngle' + (i + 1), default: [String(i + 1)],
      context: () => !!activeMulticam(), when: e => !e.repeat, run: () => chooseMulticamAngle(i) },
  ])),
  selectObject: { group: 'g_player', label: 'samSelect', default: ['O'], when: e => !e.repeat, run: () => openObjectSelect(item(sel)) },
  toggleProxies: { group: 'g_player', label: 'proxyUse', default: ['Alt+P'], when: e => !e.repeat, run: toggleProxies },
  togglePlay: { group: 'g_player', label: 'k_play', default: ['Space'], run: () => setPlaying(!playing) },
  play: { group: 'g_player', label: 'play', default: ['L'], run: () => setPlaying(true) },
  shuttle: { group: 'g_player', label: 'k_shuttle', default: [], when: e => !e.repeat,
    run: () => setPlaying(true, playing ? Math.min(playRate * 2, 4) : 1) },
  pause: { group: 'g_player', label: 'k_pause', default: ['K'], run: () => setPlaying(false) },
  back: { group: 'g_player', label: 'k_back', default: ['J', 'Shift+ArrowLeft'], run: () => { setPlaying(false); seek(t - 1); } },
  forward: { group: 'g_player', label: 'k_fwd', default: ['Shift+ArrowRight'], run: () => seek(t + 1) },
  prevFrame: { group: 'g_player', label: 'k_prevFrame', default: ['ArrowLeft'], run: () => seek(t - frameDur()) },
  nextFrame: { group: 'g_player', label: 'k_nextFrame', default: ['ArrowRight'], run: () => seek(t + frameDur()) },
  prevCut: { group: 'g_player', label: 'k_prevCut', default: ['ArrowUp'], run: () => jumpCut(-1) },
  nextCut: { group: 'g_player', label: 'k_nextCut', default: ['ArrowDown'], run: () => jumpCut(1) },
  start: { group: 'g_player', label: 'k_start', default: ['Home'], run: () => seek(0) },
  end: { group: 'g_player', label: 'k_end', default: ['End'], run: () => seek(total()) },

  undo: { group: 'g_edit', label: 'undo', default: ['Mod+Z'], run: () => restore(undoStack, redoStack) },
  redo: { group: 'g_edit', label: 'redo', default: ['Mod+Shift+Z', 'Mod+Y'], run: () => restore(redoStack, undoStack) },
  copy: { group: 'g_edit', label: 'k_copy', default: ['Mod+C'], run: copySel },
  cut: { group: 'g_edit', label: 'k_cut', default: ['Mod+X'], run: cutSel },
  paste: { group: 'g_edit', label: 'k_paste', default: ['Mod+V'], run: pasteClip },
  duplicate: { group: 'g_edit', label: 'dup', default: ['Mod+D'], run: duplicateSel },
  group: { group: 'g_edit', label: 'groupClips', default: ['Mod+G'], run: groupSel },
  ungroup: { group: 'g_edit', label: 'ungroupClips', default: ['Mod+Shift+G'], run: ungroupSel },
  delete: { group: 'g_edit', label: 'del', default: ['Delete'],
    run: () => focusZone === 'bin' && binSel.size ? deleteMedia(picked()) : removeSel() },
  deselect: { group: 'g_edit', label: 'k_deselect', default: ['Escape'], run: () => {
    if (openGrp) return showGroup(null);
    select(null); binSel.clear(); paintBinSel();
  } },
  selectAll: { group: 'g_edit', label: 'selAll', default: ['Mod+A'], run: () => {
    const ids = focusZone === 'tl' ? timelineClips().map(i => i.id) : [];
    if (ids.length) {
      setSelection(ids.includes(sel) ? [sel, ...ids.filter(id => id !== sel)] : ids);
      paintSel(); inspector(); return;
    }
    binOrder().forEach(x => binSel.add(x)); paintBinSel(); focusZone = 'bin';
  } },

  split: { group: 'g_timeline', label: 'split', default: ['C', 'S'], run: () => splitAt() },
  addEdit: { group: 'g_timeline', label: 'k_addEdit', default: ['Mod+B'], run: () => splitAt() },
  splitAll: { group: 'g_timeline', label: 'k_splitAll', default: ['Mod+Shift+B'], run: () => splitAt(true) },
  trimLeft: { group: 'g_timeline', label: 'delLeft', default: ['Q'], run: () => trimTo('left') },
  trimRight: { group: 'g_timeline', label: 'delRight', default: ['W'], run: () => trimTo('right') },
  select: { group: 'g_timeline', label: 'select', default: ['V'], run: () => setTool('select') },
  blade: { group: 'g_timeline', label: 'blade', default: ['B'], run: () => setTool('blade') },
  ripple: { group: 'g_timeline', label: 'rippleTool', default: ['F'], run: () => setTool('ripple') },
  roll: { group: 'g_timeline', label: 'rollTool', default: ['R'], run: () => setTool('roll') },
  slip: { group: 'g_timeline', label: 'slipTool', default: ['Y'], run: () => setTool('slip') },
  slide: { group: 'g_timeline', label: 'slideTool', default: ['U'], run: () => setTool('slide') },
  prevClip: { group: 'g_timeline', label: 'k_selPrev', default: ['['], run: () => selectStep(-1) },
  nextClip: { group: 'g_timeline', label: 'k_selNext', default: [']'], run: () => selectStep(1) },
  magnet: { group: 'g_timeline', label: 'magnet', default: ['P'], run: () => $('#bMagnet').click() },
  snap: { group: 'g_timeline', label: 'snap', default: ['N'], run: () => $('#bSnap').click() },
  freeze: { group: 'g_timeline', label: 'freeze', default: ['Alt+Shift+F'], run: freezeFrame },
  rotate: { group: 'g_timeline', label: 'rotate90', default: ['Alt+R'], run: rotateSel },

  marker: { group: 'markers', label: 'marker', default: ['M'], run: addMarker },
  prevMarker: { group: 'markers', label: 'k_prevMarker', default: ['Shift+ArrowUp'], run: () => jumpMarker(-1) },
  nextMarker: { group: 'markers', label: 'k_nextMarker', default: ['Shift+ArrowDown'], run: () => jumpMarker(1) },

  zoomIn: { group: 'k_view', label: 'zoomIn', default: ['Mod+='], run: () => setZoom(pps * 1.4) },
  zoomOut: { group: 'k_view', label: 'zoomOut', default: ['Mod+-'], run: () => setZoom(pps / 1.4) },
  fit: { group: 'k_view', label: 'fit', default: ['Mod+0', 'Shift+Z'], run: () => $('#bFit').click() },
  shortcuts: { group: 'k_view', label: 'k_title', default: ['Shift+/', 'Mod+/'], run: () => showKeys() },
  shortcutSearch: { group: 'k_view', label: 'k_searchTitle', default: ['Mod+,'], run: () => showKeys(true) },

  new: { group: 'g_file', label: 'k_new', default: ['Mod+N'], run: () => newProj() },
  open: { group: 'g_file', label: 'open', default: ['Mod+O'], run: open },
  save: { group: 'g_file', label: 'save', default: ['Mod+S'], run: () => save() },
  saveAs: { group: 'g_file', label: 'k_saveAs', default: ['Mod+Shift+S'], run: () => save(true) },
  import: { group: 'g_file', label: 'import', default: ['Mod+I'], run: importMedia },
  recordScreen: { group: 'g_file', label: 'recScreen', default: [], run: openRecorder },
  importTimeline: { group: 'g_file', label: 'timelineImport', default: [], run: importTimelineDialog },
  exportFrame: { group: 'g_file', label: 'exportFrame', default: [], run: exportFramePng },
  collectProject: { group: 'g_file', label: 'collectTitle', default: [], run: collectProject },
  relinkMedia: { group: 'g_file', label: 'relinkTitle', default: [], run: () => scanOffline().then(() => offline.size ? relinkDialog() : toast(tr('relinkNone'))) },
  exportTimeline: { group: 'g_file', label: 'timelineExport', default: [], run: exportTimelineDialog },
  export: { group: 'g_file', label: 'export', default: ['Mod+E'], run: exportDialog },
};
const KEY_PRESETS = {
  maqto: {},
  premiere: { shuttle: ['L'], back: ['J', 'Shift+ArrowLeft'], pause: ['K'],
    blade: ['C'], select: ['V'], ripple: ['B'], roll: ['N'], snap: ['Shift+N'],
    addEdit: ['Mod+K'], marker: ['M'], trimLeft: ['Q'], trimRight: ['W'] },
  finalCut: { shuttle: ['L'], back: ['J', 'Shift+ArrowLeft'], pause: ['K'],
    blade: ['B'], select: ['A'], ripple: ['Shift+T'], roll: ['T'], addEdit: ['Mod+B'], marker: ['M'] },
};
const KEY_PRESET_NAMES = { maqto: 'Maqto', premiere: 'Premiere Pro', finalCut: 'Final Cut Pro' };
const KEY_GROUPS = ['g_player', 'g_edit', 'g_timeline', 'markers', 'wsMulticam', 'k_view', 'g_file'];
const RESERVED_KEYS = new Set(['Mod+Q', ...(MAC ? ['Mod+M', 'Mod+H', 'Mod+Alt+H', 'Mod+Ctrl+F'] : ['Alt+F4'])]);
const KEYMAP_STORAGE = 'kadr.keymap';
function loadKeymap() {
  const fallback = { preset: 'maqto', overrides: {} };
  const stored = lsGet(KEYMAP_STORAGE, null);
  const record = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!record(stored) || !Object.hasOwn(KEY_PRESETS, stored.preset) || !record(stored.overrides)) return fallback;
  for (const [preset, overrides] of Object.entries(stored.overrides)) {
    if (!Object.hasOwn(KEY_PRESETS, preset) || !record(overrides)) return fallback;
    const seen = new Set();
    for (const [id, keys] of Object.entries(overrides)) {
      if (!Object.hasOwn(COMMANDS, id) || !Array.isArray(keys) || keys.length > 2) return fallback;
      for (const key of keys) {
        if (!S.validShortcut(key) || RESERVED_KEYS.has(key) || seen.has(key)) return fallback;
        seen.add(key);
      }
    }
  }
  return stored;
}
const keymap = loadKeymap();
let presetKeys, activeKeys, shortcutRuns;
function updateKeymap() {
  const preset = KEY_PRESETS[keymap.preset];
  presetKeys = S.mergeKeymap(COMMANDS, preset);
  activeKeys = S.mergeKeymap(COMMANDS, preset, keymap.overrides[keymap.preset] || {});
  shortcutRuns = new Map(Object.entries(activeKeys).flatMap(([id, keys]) => keys.map(key => [key, COMMANDS[id]])));
}
updateKeymap();

function fmtKey(spec) {
  if (spec === 'Shift+/') return '?';
  const names = { Mod: MAC ? '⌘' : 'Ctrl', Ctrl: MAC ? '⌃' : 'Ctrl', Meta: 'Meta',
    Shift: MAC ? '⇧' : 'Shift', Alt: MAC ? '⌥' : 'Alt', Escape: 'Esc',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', '=': '+' };
  return spec.split('+').map(x => names[x] ?? x).join(MAC ? '' : '+');
}
const keyBadge = key => `<kbd dir="ltr">${esc(fmtKey(key))}</kbd>`;
function paintShortcutHints() {
  $$('[data-tt]').forEach(el => {
    const keys = (el.dataset.command || '').split(' ').flatMap(id => activeKeys[id] || []);
    const label = tr(el.dataset.tt);
    el.title = [label, ...keys.map(key => '\u2066' + fmtKey(key) + '\u2069')].join('  ');
    if (el.hasAttribute('data-tl-tool') || el.id === 'bProxy') el.setAttribute('aria-label', label);
  });
}

const keysDialog = $('#keysDialog');
const keyRows = $('#keyRows');
const keySearch = $('#keySearch');
const keyPreset = $('#keyPreset');
const keyNotice = $('#keyNotice');
let recording = null;

function renderKeyRows() {
  const query = keySearch.value.trim().toLowerCase();
  const matches = id => [tr(COMMANDS[id].label), ...activeKeys[id], ...activeKeys[id].map(fmtKey)]
    .some(value => value.toLowerCase().includes(query));
  const row = ([id, cmd]) => {
    const keys = activeKeys[id], label = esc(tr(cmd.label));
    const buttons = keys.map((key, i) => `<button type="button" data-key="${i}" aria-label="${label} · ${esc(fmtKey(key))}">${keyBadge(key)}</button>`);
    if (keys.length < 2) buttons.push(`<button type="button" data-key="${keys.length}" aria-label="${label} · ${tr('k_add')}">${tr('k_add')}</button>`);
    return `<div class="key-row" data-command-id="${id}"><span>${label}</span><div class="key-buttons">
      ${buttons.join('')}<button type="button" data-reset aria-label="${label} · ${tr('reset')}">${tr('reset')}</button></div></div>`;
  };
  keyRows.innerHTML = KEY_GROUPS.map(group => {
    const rows = Object.entries(COMMANDS).filter(([id, cmd]) => cmd.group === group && matches(id));
    return rows.length ? grp(group, rows.map(row).join('')) : '';
  }).join('') || `<p class="hint">${tr('k_noResults')}</p>`;
}
function showKeys(search = false) {
  if (keysDialog.open || !$('#modal').hidden) return;
  closeWorkspaces();
  stopKeyRecording();
  keySearch.value = '';
  keyPreset.innerHTML = Object.entries(KEY_PRESET_NAMES).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  keyPreset.value = keymap.preset;
  renderKeyRows();
  keyRows.scrollTop = 0;
  keysDialog.showModal();
  (search ? keySearch : keyPreset).focus();
}
function saveKeymap() {
  lsSet(KEYMAP_STORAGE, keymap);
  updateKeymap();
  paintShortcutHints();
  if (!sel) inspector();
  renderKeyRows();
}
function stopKeyRecording() {
  recording?.button.removeAttribute('aria-pressed');
  recording = null;
  keyNotice.replaceChildren();
}
function setCommandKeys(id, keys, button) {
  const conflicts = keys.map(key => [key, S.shortcutConflict(activeKeys, id, key)]).filter(([, owner]) => owner);
  const index = button.dataset.key;
  const commit = () => {
    const overrides = keymap.overrides[keymap.preset] ??= {};
    for (const [key, owner] of conflicts) overrides[owner] = (overrides[owner] || activeKeys[owner]).filter(k => k !== key);
    overrides[id] = keys;
    if (keys.length === presetKeys[id].length && keys.every((k, i) => k === presetKeys[id][i])) delete overrides[id];
    stopKeyRecording();
    saveKeymap();
    const row = keyRows.querySelector(`[data-command-id="${id}"]`);
    (row?.querySelector(index === undefined ? '[data-reset]' : `[data-key="${index}"]`) || keySearch).focus();
  };
  if (!conflicts.length) return commit();
  const names = [...new Set(conflicts.map(([, owner]) => tr(COMMANDS[owner].label)))].join(tr('k_listSep'));
  keyNotice.innerHTML = `<span role="status">${esc(tr('k_conflict', { name: names }))}</span>
    <button type="button" class="primary" id="keyReplace">${tr('k_replace')}</button><button type="button" id="keyCancel">${tr('cancel')}</button>`;
  $('#keyReplace').onclick = commit;
  $('#keyCancel').onclick = () => { stopKeyRecording(); button.focus(); };
  $('#keyReplace').focus();
}
$('#bKeys').onclick = () => showKeys();
$('#keyClose').onclick = () => keysDialog.close();
keysDialog.addEventListener('close', stopKeyRecording);
keySearch.oninput = () => { stopKeyRecording(); renderKeyRows(); };
keyPreset.onchange = () => { stopKeyRecording(); keymap.preset = keyPreset.value; saveKeymap(); };
$('#keyResetAll').onclick = () => { stopKeyRecording(); delete keymap.overrides[keymap.preset]; saveKeymap(); };
keyRows.onclick = e => {
  const button = e.target.closest('button');
  if (!button) return;
  const id = button.closest('[data-command-id]').dataset.commandId;
  stopKeyRecording();
  if (button.hasAttribute('data-reset')) return setCommandKeys(id, [...presetKeys[id]], button);
  recording = { id, index: +button.dataset.key, button };
  button.setAttribute('aria-pressed', 'true');
  button.focus({ preventScroll: true });
  keyNotice.innerHTML = `<span role="status">${tr('k_record')}</span><button type="button" id="keyCancel">${tr('cancel')}</button>`
    + (recording.index < activeKeys[id].length ? `<button type="button" id="keyRemove">${tr('remove')}</button>` : '');
  $('#keyCancel').onclick = () => { stopKeyRecording(); button.focus(); };
  if ($('#keyRemove')) $('#keyRemove').onclick = () => setCommandKeys(id, activeKeys[id].filter((_, i) => i !== +button.dataset.key), button);
};
keysDialog.addEventListener('keydown', e => {
  if (!recording || e.target !== recording.button) return;
  const key = S.normalizeKey(e, MAC);
  if (!key) return;
  e.preventDefault();
  if (e.repeat) return;
  if (RESERVED_KEYS.has(key)) return toast(tr('k_reserved'));
  const { id, index, button } = recording;
  stopKeyRecording();
  const keys = [...activeKeys[id]];
  if (key === keys[index]) return;
  const other = keys.indexOf(key);
  keys[index] = key;
  if (other !== -1) keys.splice(other, 1);
  setCommandKeys(id, keys, button);
});
// Window close / Cmd+Q: offer to save unsaved work first (Rust holds the close until quit_app).
let quitting = false, pendingOpen = false;
// A project double-clicked in Finder/Explorer: open it (at launch, or while the app is running).
async function openPending() {
  if (queueRunning) { pendingOpen = true; return false; }
  pendingOpen = false;
  const f = await inv('take_open_file').catch(() => null);
  if (f) {
    cancelProTrim?.();
    if (keysDialog.open) keysDialog.close();
    hideModal(); openPath(f);
  }
  return !!f;
}
TA.event.listen('open-file', openPending);
const shortcutInput = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
TA.event.listen('menu-file', e => {
  if (queueRunning || whatsNewDialog.open) return;
  if (Object.hasOwn(COMMANDS, e.payload)) {
    cancelProTrim?.();
    if (keysDialog.open) keysDialog.close();
    COMMANDS[e.payload].run();
  }
});
TA.event.listen('menu-shortcuts', () => { if (!whatsNewDialog.open) showKeys(); });
TA.event.listen('menu-workspaces', () => { if (!keysDialog.open && !whatsNewDialog.open) openWorkspaces(); });
TA.event.listen('quit-requested', async () => {
  if (quitting) return;
  cancelProTrim?.();
  if (keysDialog.open) keysDialog.close();
  quitting = true;
  const returnToQueue = !!$('#rqClose') && !$('#modal').hidden;
  if (queueRunning && !(await TA.dialog.ask(tr('rqQuit'), { kind: 'warning' }).catch(() => false))) {
    quitting = false;
    return;
  }
  await autosave();
  if (!dirty || !P.items.length && !Object.keys(P.media).length) return quitNow();
  $('#modal').hidden = false;
  $('#mBox').innerHTML = `<h3>${tr('quitTitle')}</h3><p class="hint">${tr('quitAsk')}</p><div class="acts"><button id="qNo">${tr('dontSave')}</button><span class="flex"></span><button id="qCancel">${tr('cancel')}</button><button class="primary" id="qSave">${tr('save')}</button></div>`;
  const done = () => { quitting = false; hideModal(); };
  const restoreQueue = () => { if (returnToQueue) showRenderQueue(); };
  $('#qCancel').onclick = () => { done(); restoreQueue(); };
  $('#qNo').onclick = () => { clearRecovery(); quitNow(); };
  $('#qSave').onclick = async () => { done(); await save(); if (!dirty) quitNow(); else restoreQueue(); };
});
window.addEventListener('keydown', e => {
  if (cancelProTrim) {
    e.preventDefault();
    if (e.code === 'Escape') cancelProTrim();
    return;
  }
  if (!e.defaultPrevented && e.code === 'Escape' && objectEdit(item(sel)) && $('#modal').hidden && !keysDialog.open && !whatsNewDialog.open) {
    e.preventDefault();
    if (objectJob?.id) cancelObjectJob(); else { stopObjectEdit(); inspector(); }
    return;
  }
  if (e.defaultPrevented || keysDialog.open || whatsNewDialog.open || !$('#modal').hidden || !(e.target instanceof Element)
      || markerEditor.contains(e.target) || wsMenu.contains(e.target)
      || e.code === 'Space' && e.target.closest('[data-dock-tab], .tarr, #bWorkspaces, #bAITools, .ai-actions button, .mk, #markerPanel summary, #markerPanel button, #multicam button')) return;
  const command = S.lookupKey(shortcutRuns, S.normalizeKey(e, MAC), MAC);
  if (!command || command.context && !command.context()) return;
  // In a text field only File commands and the shortcut sheet run; the rest stay native (the Edit menu owns copy/paste/undo there).
  if ((e.target.closest(shortcutInput) || e.target.isContentEditable) && command.group !== 'g_file' && command !== COMMANDS.shortcutSearch) return;
  e.preventDefault();
  if (!command.when || command.when(e)) command.run();
});

(async () => {
MEDIA_BASE = await inv('media_base');
inv('fonts_downloaded').then(m => {
  for (const [f, files] of Object.entries(m || {})) regFont(f, files);
  ensureFonts();
  $('#fpop')?._list();
}).catch(() => {});
inv('system_fonts').then(v => {
  for (const font of v || []) {
    font.previewFiles = font.files.filter(file => file.sample)
      .sort((a, b) => Number(a.italic) - Number(b.italic) || Math.abs(a.weight - 400) - Math.abs(b.weight - 400));
    font.arabic = font.previewFiles.some(file => file.sample.includes('أبجد'));
    FontLib.sys.set(font.family, font);
    for (const file of font.files) {
      if (file.collection) continue;
      document.fonts.add(new FontFace(font.family, systemFontSource(file), { weight: String(file.weight), style: file.italic ? 'italic' : 'normal' }));
    }
  }
  ensureFonts();
  $('#fpop')?._list();
  needsDraw = true;
}).catch(() => {});
/* ---------- AI Tools ---------- */
const aiToolPanel = dockPanels.aiTools;
const aiTransfers = new Map(), aiReady = new Map();
function localAIModel(command, label, param, selected = () => '', sync = () => {}) {
  const key = version => command + ':' + version;
  const invoke = (action, version) => inv(command + '_' + action, param ? { [param]: version } : undefined);
  function change(action, inline, version) {
    const id = key(version), busy = aiTransfers.get(label);
    if (busy) {
      if (busy.id === id && busy.action === action) return busy.done;
      return busy.done.catch(() => {}).then(() => change(action, inline, version));
    }
    const transfer = { id, action, inline, p: action === 'download' ? 0 : null };
    aiTransfers.set(label, transfer);
    transfer.done = invoke(action, version).then(() => {
      const ready = action === 'download';
      aiReady.set(id, ready);
      sync(ready);
    }).finally(() => {
      aiTransfers.delete(label);
      paintAITools();
    });
    paintAITools();
    return transfer.done;
  }
  return {
    label, key: () => key(selected()),
    ready: () => invoke('ready', selected()),
    download: (inline = true, version = selected()) => change('download', inline, version),
    remove: () => change('remove', true, selected()),
  };
}
const depthModel = localAIModel('depth', 'depth_dl', null);
const upscaleModel = localAIModel('upscale', 'upscale_dl', null);
const sam2Model = localAIModel('sam2', 'sam2_dl', null);
const miganModel = localAIModel('migan', 'migan_dl', null, undefined, installed => {
  if (installed) for (const [key, state] of fillCaches) if (state.needsModel) fillCaches.delete(key);
});
const matteModels = Object.fromEntries(['person', 'object'].map(kind => [kind,
  localAIModel('matte', 'matte_dl', 'kind', () => kind, v => { matteTool[kind] = v; })]));
const rifeModel = localAIModel('rife', 'rife', null, undefined, v => { rifeTool = v; });
const voiceCleanModel = localAIModel('voice_clean', 'voice_clean_dl', null, undefined, ready => {
  if (ready) for (const [key, error] of voiceErrors) if (error === 'voice_clean_missing') voiceErrors.delete(key);
});
const scenesModel = localAIModel('scenes', 'scenes_dl', null);
const stemsModel = localAIModel('stems', 'stems_dl', null, undefined, v => { stemsTool = v; });
let translationModelDirection = LANG === 'ar' ? 'ar-en' : 'en-ar';
const translationModel = localAIModel('translation', 'translation_dl', 'direction', () => translationModelDirection);
const whisperModel = localAIModel('model', 'model', 'model', capModel, () => renderCapModels());
const PIPER_VOICES = { 'ar_JO-kareem-medium': 'العربية · Kareem', 'en_US-lessac-medium': 'English · Lessac' };
const piperPanel = $('#piperPanel'), piperText = $('#piperText'), piperVoice = $('#piperVoice');
let piperSelectedVoice = Object.keys(PIPER_VOICES)[LANG === 'ar' ? 0 : 1];
let piperCaptionSource, piperJob, piperPreview, piperError = '', piperCancelling = false;
const piperModel = localAIModel('piper', 'piper_dl', 'voice', () => piperSelectedVoice);
const piperVoiceOptions = () => Object.entries(PIPER_VOICES).map(([id, name]) =>
  `<option value="${id}"${id === piperSelectedVoice ? ' selected' : ''}>${name}</option>`).join('');
const piperErrorText = e => {
  const code = cleanErr(e);
  const key = { piper_busy: 'piperBusy', piper_missing: 'piperVoiceMissing',
    piper_voice_unavailable: 'piperVoiceUnavailable', piper_engine_unavailable: 'piperEngineUnavailable' }[code];
  return key ? tr(key) : code;
};
function selectPiperVoice(voice) {
  piperSelectedVoice = piperVoice.value = voice;
  piperAudio.pause();
  piperError = '';
  const select = aiToolPanel.querySelector('[data-piper-voice]');
  if (select) select.value = voice;
  refreshAITools();
}
function openPiper(clips = null) {
  revealPanel('text');
  if (!piperJob) {
    if (clips) clips = [...clips].sort((a, b) => a.start - b.start);
    piperCaptionSource = clips && { clips, project: P, group: openGrp, stamps: clips.map(captionStamp) };
    piperError = '';
    if (clips) {
      const isArabic = S.captionDirection(clips.map(it => it.text)) === 'ar-en';
      selectPiperVoice(Object.keys(PIPER_VOICES)[isArabic ? 0 : 1]);
    }
  }
  piperPanel.open = true;
  refreshAITools();
  piperPanel.querySelector('summary').scrollIntoView({ block: 'nearest' });
  (clips ? piperVoice : piperText).focus({ preventScroll: true });
}
async function cancelPiper() {
  const job = piperJob;
  if (piperCancelling || job?.cancelled) return;
  if (job) job.cancelled = true;
  else piperCancelling = true;
  paintPiper();
  try { await inv('piper_cancel', { job: job?.id || 'download' }); }
  catch (e) { toast(piperErrorText(e)); }
}
function paintPiper() {
  const source = piperCaptionSource, ready = aiReady.get(piperModel.key());
  const transfer = aiTransfers.get(piperModel.label), downloading = transfer?.action === 'download';
  const busy = !!(piperJob || transfer);
  $('#piperCaptions').hidden = $('#piperBack').hidden = !source;
  if (source) $('#piperCaptions').textContent = tr('piperCaptionCount', { n: source.clips.length });
  $('#piperTextField').hidden = $('#piperPreview').hidden = !!source;
  $('#piperHint').hidden = !piperSelectedVoice.startsWith('ar_');
  for (const el of [piperVoice, piperText, $('#piperSpeed'), $('#piperPause'), $('#piperBack')]) el.disabled = busy;
  $('#piperStatus').textContent = downloading ? tr('aiDownloading', { p: Math.round(transfer.p * 100) })
    : piperJob?.progress ? tr('piperFitting', piperJob.progress) : piperJob ? tr('piperGenerating')
    : piperError || (ready === undefined ? tr('aiChecking') : ready === null ? tr('aiUnavailable') : ready ? '' : tr('piperVoiceMissing'));
  $('#piperDownload').hidden = ready !== false || busy;
  $('#piperCancel').hidden = !(downloading || piperJob);
  $('#piperCancel').disabled = piperCancelling || !!piperJob?.cancelled;
  const valid = !busy && ready === true && (source || piperText.value.trim());
  $('#piperAdd').disabled = !valid;
  $('#piperPreview').disabled = busy || (!valid && piperAudio.paused);
  $('#piperPreview').textContent = tr(piperAudio.paused ? 'piperPreview' : 'piperStopPreview');
}
function insertVoiceOver(result, starts) {
  snapshot();
  const mids = addToBin(result);
  const occupied = openGrp ? timelineItems() : P.items;
  const ids = mids.map((mid, i) => {
    const { dur } = P.media[mid], start = starts[i];
    let track = P.tracks.find(x => x.kind === 'audio' && !x.locked &&
      !occupied.some(it => it.track === x.id && it.start < start + dur && start < it.start + it.dur));
    if (!track) {
      track = { id: 'a' + uid(), kind: 'audio' };
      P.tracks.push(track);
    }
    const clip = { id: uid(), track: track.id, media: mid, start, dur, in: 0, speed: 1, volume: 1 };
    addTimelineItem(clip);
    if (openGrp) occupied.push(clip);
    return clip.id;
  });
  setSelection(ids);
  refresh();
  return ids;
}
async function makeVoiceOver(lines, settings, starts, source, preview = false) {
  if (piperJob || aiTransfers.has(piperModel.label)) throw new Error(tr('piperBusy'));
  const job = piperJob = { id: uid() }, project = P, group = openGrp;
  const verify = () => {
    if (job.cancelled) throw new Error('cancelled');
    if (P !== project || openGrp !== group || source && (source.project !== P || source.group !== openGrp ||
        source.clips.some((it, i) => item(it.id) !== it || captionStamp(it) !== source.stamps[i]))) {
      throw new Error(tr('piperChanged'));
    }
  };
  const options = { ...settings, lines };
  const key = JSON.stringify(options);
  piperAudio.pause();
  piperError = '';
  paintAITools();
  try {
    verify();
    const paths = !source && piperPreview?.project === P && piperPreview.key === key
      ? piperPreview.paths : await inv('piper_synthesize', { ...options, job: job.id });
    verify();
    const result = await inv('probe', { paths });
    verify();
    if (result.ok.length !== lines.length || result.ok.some(m => m.kind !== 'audio' || !(m.dur > 0))) {
      piperPreview = null;
      throw new Error(tr('piperAudioError'));
    }
    if (preview) {
      piperPreview = { project, key, paths };
      piperAudio.src = urlOf(result.ok[0]);
      setPlaying(false);
      await piperAudio.play();
      if (job.cancelled || !panelVisible('text') || !piperPanel.open) piperAudio.pause();
      return [];
    }
    const ids = insertVoiceOver(result, starts);
    toast(tr('piperAdded', { n: ids.length }));
    return ids;
  } finally {
    piperJob = null;
    paintAITools();
  }
}
async function runPiperPanel(preview) {
  if (preview && !piperAudio.paused) return piperAudio.pause();
  const speed = $('#piperSpeed'), pause = $('#piperPause');
  if (speed.value === '' || pause.value === '' || !speed.reportValidity() || !pause.reportValidity()) return;
  const source = piperCaptionSource;
  const lines = source ? source.clips.map(it => ({ text: it.text, slot: it.dur })) : [{ text: piperText.value }];
  try {
    await makeVoiceOver(lines, { voice: piperSelectedVoice, lengthScale: +speed.value, pause: +pause.value },
      source ? source.clips.map(it => it.start) : [t], source, preview);
  } catch (e) {
    if (cleanErr(e) !== 'cancelled') {
      piperError = piperErrorText(e);
      paintPiper();
    }
  }
}
piperVoice.innerHTML = piperVoiceOptions();
piperVoice.onchange = () => selectPiperVoice(piperVoice.value);
piperText.oninput = paintPiper;
piperAudio.onplay = piperAudio.onpause = piperAudio.onended = paintPiper;
piperPanel.ontoggle = () => {
  if (piperPanel.open) refreshAITools();
  else piperAudio.pause();
};
$('#piperOpen').onclick = $('#piperBack').onclick = () => openPiper();
$('#piperCancel').onclick = cancelPiper;
$('#piperPreview').onclick = () => runPiperPanel(true);
$('#piperAdd').onclick = () => runPiperPanel(false);
$('#piperDownload').onclick = async () => {
  piperError = '';
  try { await piperModel.download(); }
  catch (e) { if (cleanErr(e) !== 'cancelled') piperError = piperErrorText(e); }
  finally { piperCancelling = false; refreshAITools(); }
};
TA.event.listen('piper-progress', ({ payload: { job, done, total } }) => {
  if (piperJob?.id !== job || piperJob.cancelled) return;
  piperJob.progress = { done, total };
  paintPiper();
});


function openAIInspector(tab, selector) {
  revealPanel('insp');
  inspTab = tab;
  inspector();
  const control = $('#inspBody ' + selector);
  control?.scrollIntoView({ block: 'center' });
  control?.focus({ preventScroll: true });
}
function openAIMatte(kind, it) {
  if (media(it)?.kind !== 'video' || media(it).angles) return toast(tr('aiPickVideo'));
  if (!it.rmbg || mtKind(it) !== kind) {
    snapshot();
    Object.assign(it, { rmbg: true, rmbgKind: kind });
    dirty = true;
    refresh();
  }
  openAIInspector('tVideo', '[data-k="rmbgKind"]');
}
/* ---------- Scene detection (TransNetV2): cut positions live on the media as seconds of the source ---------- */
const sceneQueue = [];
let sceneRun = null;
const sceneSens = () => Math.min(0.9, Math.max(0.1, Number(lsGet('kadr.sceneSens', 0.5)) || 0.5));
const sceneCuts = m => m?.scenes && (!m.sourceKey || m.scenes.sourceKey === m.sourceKey) ? m.scenes.cuts : null;
const sceneBusy = mid => sceneRun?.mid === mid || sceneQueue.some(q => q.mid === mid);
function sceneTicks(it) {
  const m = media(it), cuts = !it.compound && !m?.angles && sceneCuts(m);
  return cuts ? S.sceneOffsets(it, cuts).map(o => `<i class="sct" style="left:calc(${o}px * var(--pps))"></i>`).join('') : '';
}
const binSceneTicks = m => m.dur && sceneCuts(m)?.length
  ? `<span class="sc-ticks" title="${tr('scenesCuts')}">${sceneCuts(m).map(c => `<i style="inset-inline-start:${Math.min(100, c / m.dur * 100).toFixed(2)}%"></i>`).join('')}</span>` : '';
function paintBinScenes() {
  for (const el of $$('#binList .mi')) {
    const badge = el.querySelector('.sc-st'), mid = el.dataset.mid;
    if (!badge) continue;
    badge.hidden = !sceneBusy(mid);
    badge.textContent = sceneRun?.mid === mid ? tr('scenesProgress', { p: Math.round(sceneRun.p * 100) }) : '…';
  }
}
function detectScenes(mid, quiet) {
  const m = P.media[mid];
  if (!m?.path || m.kind !== 'video' || m.angles) return quiet || toast(tr('aiPickVideo'));
  if (sceneBusy(mid)) return;
  sceneQueue.push({ mid, project: P, quiet });
  paintBinScenes();
  pumpScenes();
}
async function pumpScenes() {
  if (sceneRun || !sceneQueue.length) return;
  const { mid, project, quiet } = sceneQueue.shift(), m = project.media[mid];
  if (!m) return pumpScenes();
  const run = sceneRun = { mid, job: uid(), p: 0 };
  paintBinScenes();
  try {
    if (!(await scenesModel.ready())) { if (!quiet) toast(tr('scenesMissing')); }
    else {
      const found = await inv('scenes_detect', { request: { path: m.path, threshold: +(1 - sceneSens()).toFixed(2) }, job: run.job });
      if (found && project.media[mid] === m) {
        m.scenes = found;
        dirty = true;
        if (!quiet) toast(tr('scenesDone', { n: found.cuts.length }));
      }
    }
  } catch (e) { if (!run.cancelled && cleanErr(e) !== 'cancelled') toast(cleanErr(e)); }
  sceneRun = null;
  if (project === P) refresh();
  pumpScenes();
}
function cancelScenes(mid) {
  const i = sceneQueue.findIndex(q => q.mid === mid);
  if (i >= 0) sceneQueue.splice(i, 1);
  if (sceneRun?.mid === mid) { sceneRun.cancelled = true; inv('scenes_cancel', { job: sceneRun.job }).catch(() => {}); }
  paintBinScenes();
}
TA.event.listen('scenesprog', ({ payload: { job, p } }) => {
  if (sceneRun?.job !== job) return;
  sceneRun.p = p;
  paintBinScenes();
});
// One undo step: every selected clip is split at each detected cut inside its in..out.
function splitAtScenes(its) {
  const min = 1 / P.fps, work = its.filter(it => !isText(it) && sceneCuts(media(it))).map(it => [it, S.sceneOffsets(it, sceneCuts(media(it)), min)]).filter(([, o]) => o.length);
  if (!work.length) return toast(tr('scenesNoCuts'));
  snapshot();
  for (const [it, offsets] of work) for (const o of offsets.reverse()) splitItems([it], it.start + o);
  if (work.some(([it]) => it.track === 'v1')) pack();
  refresh();
  toast(tr('scenesDone', { n: work.reduce((n, [, o]) => n + o.length, 0) }));
}
/* ---------- Highlights → Shorts ---------- */
// Each short is saved as its own 9:16 project (silences cut, reframed, captioned); the open project is never touched.
const HL_LENGTHS = [15, 30, 45, 60];
const highlightClips = () => speechTargets(false).filter(it => media(it)?.kind === 'video' && !media(it).angles && num(it.speed, 1) === 1 && !S.hasCurve(it));
// One headless assistant turn whose text answer is wanted (not an edit). Resolves with the answer text.
async function askAssistantText(prompt, run) {
  const job = run.job = 'hl-' + uid();
  let text = '', result = '';
  const unlisten = await TA.event.listen('assistant-ev', ({ payload }) => {
    if (payload.job !== job) return;
    const ev = payload.ev;
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') text += c.text + '\n';
    if (ev.type === 'result' && typeof ev.result === 'string') result = ev.result;
  });
  try { await inv('assistant_ask', { prompt, session: '', job }); }
  finally { unlisten(); run.job = null; }
  return result || text;
}
async function scoreHighlights(clips, { length, count }, status, run) {
  const cands = [];
  for (const it of clips) {
    const words = S.transcriptWords(it).map(x => x.word);
    for (const c of S.highlightCandidates(words, { min: 15, target: length })) cands.push({ ...c, id: cands.length, it: it.id, path: media(it).path });
  }
  if (!cands.length) return { picks: [], ai: false };
  const speech = new Map();
  for (const path of new Set(cands.map(c => c.path))) speech.set(path, await inv('speech_regions', { path }).catch(() => null));
  for (const c of cands) {
    const regions = speech.get(c.path);
    if (regions) c.coverage = regions.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0) / c.dur;
    const pk = peaks.get(c.path); // only when the waveform is already decoded: never worth a long decode here
    if (pk) { const seg = pk.subarray(Math.floor(c.start * PK), Math.ceil(c.end * PK)); c.rawLoud = seg.reduce((a, v) => a + v, 0) / Math.max(1, seg.length); }
  }
  const loudest = Math.max(0, ...cands.map(c => c.rawLoud || 0));
  for (const c of cands) {
    if (loudest > 0 && c.rawLoud != null) c.loud = c.rawLoud / loudest;
    c.heur = c.score = S.heuristicScore(c, c);
    c.title = c.words.slice(0, 6).map(w => w.w).join(' ') + (c.words.length > 6 ? '…' : '');
  }
  // the assistant only sees the best few by the cheap score: fewer calls, same winners
  const short = S.pickHighlights(cands, Math.min(24, Math.max(12, count * 3)));
  let ai = false;
  if (await inv('assistant_ready').catch(() => false)) {
    const batches = Math.ceil(short.length / 8);
    for (let i = 0; i < batches; i++) {
      if (run.stopped) throw new Error('cancelled');
      status(tr('hlRating', { i: i + 1, n: batches }));
      const batch = short.slice(i * 8, i * 8 + 8);
      let ratings;
      try { ratings = S.parseHighlightRatings(await askAssistantText(S.highlightPrompt(batch), run)); }
      catch { if (run.stopped) throw new Error('cancelled'); ratings = new Map(); }
      if (!ratings.size && !i) break; // not logged in or no answer: the first miss ends the asking
      for (const c of batch) {
        const r = ratings.get(c.id);
        if (!r) continue;
        c.score = +(r.score * 0.75 + c.heur * 0.25).toFixed(2);
        if (r.title) c.title = r.title;
        ai = true;
      }
    }
  }
  return { picks: S.pickHighlights(short, count), ai };
}
let hlStop = 0;
function previewHighlight(c) {
  const it = item(c.it);
  if (!it) return;
  const from = it.start + c.start - num(it.in, 0), to = from + c.dur;
  setPlaying(false);
  seek(from);
  setPlaying(true);
  clearInterval(hlStop);
  hlStop = setInterval(() => { if (!playing || t >= to) { clearInterval(hlStop); setPlaying(false); } }, 80);
}
async function openHighlights() {
  if (transcribing || exporting || queueRunning) return;
  let clips = highlightClips();
  if (!clips.length) return toast(tr('hlNoClip'));
  if (!clips.some(it => it.transcript?.length)) {
    if (!(await TA.dialog.ask(tr('hlNeedTranscript'), { title: tr('hlTitle') }))) return;
    await transcribeClips();
    clips = highlightClips();
    if (!clips.some(it => it.transcript?.length)) return;
  }
  const box = $('#mBox'), run = { stopped: false, job: null };
  let picks = [], busy = false;
  $('#modal').hidden = false;
  box.onclick = null;
  box.innerHTML = `<h3>${tr('hlTitle')}</h3>
    <div class="hl-opts"><label class="xr"><span>${tr('hlLength')}</span><select id="hlLen" dir="ltr">${HL_LENGTHS.map(n => `<option value="${n}">${n}s</option>`).join('')}</select></label>
      <label class="xr"><span>${tr('hlCount')}</span><input id="hlN" type="number" min="1" max="10" value="5" dir="ltr"></label></div>
    <p class="hint" id="hlStatus" role="status"></p><div class="hl-list" id="hlList"></div>
    <label class="sam-field" id="hlQ" hidden><input type="checkbox" id="hlQueue">${tr('hlQueue')}</label>
    <div class="acts"><button id="hlClose">${tr('hlClose')}</button><span class="flex"></span><button id="hlGo">${tr('hlGo')}</button><button class="primary" id="hlCreate" hidden></button></div>`;
  const len = $('#hlLen'), status = text => { if (box.isConnected) $('#hlStatus').textContent = text; };
  len.value = HL_LENGTHS.includes(lsGet('kadr.hlLen', 30)) ? lsGet('kadr.hlLen', 30) : 30;
  const live = () => box.isConnected && !$('#modal').hidden;
  const syncCreate = () => {
    const n = $$('#hlList [data-hl]:checked').length;
    $('#hlCreate').textContent = tr('hlCreate', { n });
    $('#hlCreate').disabled = busy || !n;
  };
  const stop = () => { run.stopped = true; clearInterval(hlStop); if (run.job) inv('assistant_stop', { job: run.job }).catch(() => {}); };
  $('#hlClose').onclick = () => { stop(); setPlaying(false); hideModal(); };
  $('#hlGo').onclick = async () => {
    if (busy) return;
    busy = true;
    run.stopped = false;
    lsSet('kadr.hlLen', +len.value);
    $('#hlGo').disabled = true;
    $('#hlCreate').hidden = $('#hlQ').hidden = true;
    $('#hlList').innerHTML = '';
    status(tr('hlWorking'));
    try {
      const { picks: found, ai } = await scoreHighlights(clips, { length: +len.value, count: clamp(Math.round($('#hlN').valueAsNumber) || 5, 1, 10) }, status, run);
      if (!live()) return;
      picks = found;
      status(!picks.length ? tr('hlNone') : tr(ai ? 'hlUsedAI' : 'hlUsedHeur'));
      $('#hlList').innerHTML = picks.map((c, i) => `<div class="hl-row"><label><input type="checkbox" data-hl="${i}" checked><bdi>${esc(c.title)}</bdi></label>
        <span class="hl-meta"><bdi>${fmt(c.start).slice(0, 5)} · ${Math.round(c.dur)}s · ${tr('hlScore')} ${c.score.toFixed(1)}</bdi></span>
        <button class="ib" data-hl-play="${i}" title="${tr('hlPlay')}" aria-label="${tr('hlPlay')}">${icon('play')}</button></div>`).join('');
      $('#hlCreate').hidden = $('#hlQ').hidden = !picks.length;
      syncCreate();
    } catch (e) {
      if (live() && cleanErr(e) !== 'cancelled') status(tr('error') + ': ' + cleanErr(e));
    } finally {
      busy = false;
      if (live()) { $('#hlGo').disabled = false; $('#hlGo').textContent = tr('hlRerun'); syncCreate(); }
    }
  };
  $('#hlList').onchange = syncCreate;
  $('#hlList').onclick = e => { const b = e.target.closest('[data-hl-play]'); if (b) previewHighlight(picks[+b.dataset.hlPlay]); };
  $('#hlCreate').onclick = async () => {
    const chosen = $$('#hlList [data-hl]:checked').map(el => picks[+el.dataset.hl]);
    if (!chosen.length) return toast(tr('hlPick'));
    busy = true;
    run.stopped = false;
    setPlaying(false);
    clearInterval(hlStop);
    $('#hlGo').disabled = $('#hlCreate').disabled = true;
    try {
      const made = await createShorts(chosen, status, run);
      if (made) {
        if ($('#hlQueue').checked) await queueShorts(made);
        $('#hlQ').hidden = $('#hlCreate').hidden = true;
        status(tr('hlDone', { n: made.length }));
        $('#hlList').innerHTML = made.map((s, i) => `<div class="hl-row"><span><bdi>${esc(s.name)}</bdi></span><span class="flex"></span>
          <button data-short-open="${i}">${tr('open')}</button><button data-short-queue="${i}">${tr('hlQueueOne')}</button></div>`).join('');
        $('#hlList').onclick = async e => {
          const o = e.target.closest('[data-short-open]'), q = e.target.closest('[data-short-queue]');
          if (o) { hideModal(); await openPath(made[+o.dataset.shortOpen].path); }
          else if (q) queueShorts([made[+q.dataset.shortQueue]]);
        };
      }
    } catch (e) {
      if (live() && cleanErr(e) !== 'cancelled') status(tr('error') + ': ' + cleanErr(e));
    } finally {
      busy = false;
      if (live()) { $('#hlGo').disabled = false; syncCreate(); }
    }
  };
  $('#hlGo').focus();
}
// Each short is saved as a project of its own (9:16); the open project is never touched.
async function shortsFolder() {
  if (projectPath) return projectPath.replace(/[\\/][^\\/]*$/, '');
  const saved = pref('hlDir', '');
  if (saved) return saved;
  const dir = await TA.dialog.open({ directory: true });
  if (dir) setPref('hlDir', dir);
  return dir || null;
}
async function createShorts(picks, status, run) {
  const dir = await shortsFolder();
  if (!dir) return null;
  const project = P, [w, h] = ASPECTS['9:16'], made = [], sep = dir.includes('\\') ? '\\' : '/', style = textDefaults(true);
  for (const [i, c] of picks.entries()) {
    if (run.stopped) throw new Error('cancelled');
    status(tr('hlMaking', { i: i + 1, n: picks.length, name: c.title }));
    const src = item(c.it);
    if (P !== project || !src) throw new Error(tr('hlChanged'));
    const m = media(src), base = JSON.parse(JSON.stringify(src));
    for (const k of ['kf', 'trk', 'rotate', 'trans', 'grp', 'curve', 'fadeIn', 'fadeOut', 'afIn', 'afOut']) delete base[k];
    Object.assign(base, { id: uid(), start: 0, dur: c.dur, in: c.start, speed: 1,
      transcript: src.transcript.filter(x => (x.s + x.e) / 2 >= c.start - 0.05 && (x.s + x.e) / 2 < c.end + 0.05) });
    try {
      const samples = await inv('reframe_analyze', { job: 'reframe-' + uid(), path: m.path, start: c.start, duration: c.dur });
      const { keys } = reframeClip(base, m, samples, c.start, w, h);
      base.fit = 'contain';
      for (const k of ['x', 'y', 'scale']) base[k] = keys[k][0][1];
      base.kf = keys;
    } catch { Object.assign(base, { fit: 'cover', scale: 1, x: 0, y: 0 }); } // no analysis: a plain centred fill
    const regions = await inv('speech_regions', { path: m.path, thresholdDb: -40, silences: true }).catch(() => []);
    const cuts = S.silencesToCuts(S.speechTimelineRegions(base, regions), 0, c.dur, 0.5, 0.12).map(([a, b]) => [a, b, base.id]);
    const seen = new Set(), pieces = S.cutRanges([base], cuts, 1 / P.fps, it => sourceBound(it)?.dur ?? Infinity, true)
      .map(p => { const q = seen.has(p.id) ? { ...p, id: uid() } : p; seen.add(q.id); return q; });
    const words = pieces.flatMap(p => S.transcriptWords(p).map(x => ({ w: x.word.w, s: x.start, e: x.end })));
    const name = c.title || tr('untitled'), short = S.buildShortProject(P, src.media, { name, w, h, pieces, cues: S.captionCues(words), style });
    const file = outputName(name);
    let path, n = 2, tryName = file;
    for (;; tryName = `${file} ${n++}`) {
      path = dir.replace(/[\\/]$/, '') + sep + tryName + '.maqto';
      if (!(await inv('path_exists', { path }))) break;
    }
    await inv('save_project', { path, json: JSON.stringify(short) });
    made.push({ name, path, project: short });
  }
  return made;
}
// Each short in the render queue with the TikTok / Reels / Shorts preset.
async function queueShorts(made) {
  let dir = pref('dir', '');
  if (!dir) try { dir = await TA.path.desktopDir(); } catch {}
  if (!dir) return;
  const sep = dir.includes('\\') ? '\\' : '/', { settings } = S.exportPresetSettings({ hw: pref('hw', '1') === '1', ...S.SOCIAL_EXPORT_PRESETS.shorts }, P, G.ENCODERS);
  for (const { name, project } of made) {
    const file = outputName(name);
    let base = file, n = 2, paths;
    for (;; base = `${file} ${n++}`) {
      paths = { video: dir.replace(/[\\/]$/, '') + sep + base + '.' + settings.format, audio: false };
      if (!queuePathInUse(paths) && !(await inv('path_exists', { path: paths.video }))) break;
    }
    renderQueue.push({ ...S.snapshotExport(project, settings, paths), name: base, preset: tr('xp_shorts'), status: 'waiting' });
  }
  updateQueueBadge();
  toast(tr('hlQueued'), { label: tr('renderQueue'), run: openRenderQueue });
}
const aiText = key => ({ ar: I18N.ar[key], en: I18N.en[key] });
const bundledAI = { license: null, size: null, ready: () => true };
const AI_TOOLS = [
  { id: 'scenes', icon: 'film', name: aiText('scenesTitle'), desc: aiText('scenesDesc'),
    model: 'TransNetV2', license: 'MIT', size: '31 MB', ...scenesModel,
    run: it => {
      const mid = it && media(it)?.kind === 'video' ? it.media : picked().find(id => P.media[id].kind === 'video');
      mid ? detectScenes(mid) : toast(tr('aiPickVideo'));
    } },
  { id: 'depth', icon: 'layers', name: aiText('depthTitle'), desc: aiText('depthDesc'),
    model: 'Depth Anything V2 Small', license: 'Apache-2.0', size: '49 MB', ...depthModel,
    run: it => upscaleMedia(it) ? openAIInspector('tVideo', '#depthControls input') : toast(tr('upscalePick')) },
  { id: 'upscale', icon: 'maximize-2', name: aiText('upscaleTitle'), desc: aiText('upscaleDesc'),
    model: 'Real-ESRGAN', license: 'BSD-3-Clause', size: '≈50 MB', ...upscaleModel,
    run: it => upscaleMedia(it) ? openAIInspector('tVideo', '#upscaleScale') : toast(tr('upscalePick')) },
  { id: 'select-object', icon: 'crosshair', name: aiText('samSelect'), desc: aiText('samDesc'),
    model: 'SAM 2.1 tiny', license: 'Apache-2.0', size: '61 MB', ...sam2Model, run: openObjectSelect },
  { id: 'remove-object', icon: 'wand-sparkles', name: aiText('sam_fill'), desc: aiText('fillDesc'),
    model: 'MI-GAN', license: 'MIT', size: '28 MB', ...miganModel, run: it => {
      if (!objectMedia(it)) return toast(tr('samPick'));
      if (!it.objectMask?.key) return openBrush(it, true);
      if (objectMode(it) !== 'fill') { snapshot(); it.objectMask.mode = 'fill'; dirty = true; refresh(); }
      openAIInspector('tVideo', '[data-object-field="mode"]');
    } },
  { id: 'matte-person', icon: 'scan', name: aiText('aiMattePerson'), desc: aiText('aiMattePersonDesc'),
    model: 'MODNet', license: 'Apache-2.0', size: '25 MB', ...matteModels.person, run: it => openAIMatte('person', it) },
  { id: 'matte-object', icon: 'scan', name: aiText('aiMatteObject'), desc: aiText('aiMatteObjectDesc'),
    model: 'BiRefNet-lite', license: 'MIT', size: '225 MB', ...matteModels.object, run: it => openAIMatte('object', it) },
  { id: 'matte-mobile', icon: 'scan', name: aiText('aiMatteMobile'), desc: aiText('aiMatteMobileDesc'),
    model: 'U²-Net-p', license: 'Apache-2.0', size: '4.6 MB', ready: () => null, run: () => toast(tr('aiUnavailable')) },
  { id: 'rife', icon: 'film', name: aiText('aiSlowMotion'), desc: aiText('aiSlowMotionDesc'),
    model: 'RIFE v4.6', license: 'MIT', size: '<20 MB', ...rifeModel,
    ready: () => /Mac|Win/.test(navigator.platform) ? rifeModel.ready() : null,
    run: it => media(it)?.kind === 'video' && !media(it).angles
      ? openAIInspector('tSpeed', '[data-k="smooth"]') : toast(tr('aiPickVideo')) },
  { id: 'stems', icon: 'layers', name: aiText('aiStems'), desc: aiText('aiStemsDesc'),
    model: 'TIGER-DnR', license: 'Apache-2.0', size: '7.3 MB', ...stemsModel,
    run: it => hasSound(media(it)) && !media(it).angles ? separateSounds() : toast(tr('capPick')) },
  { id: 'caption-translation', icon: 'languages', name: aiText('aiTranslation'), desc: aiText('aiTranslationDesc'),
    model: 'Helsinki-NLP opus-mt (Xenova ONNX)', license: 'CC-BY-4.0', size: aiText('translationSize'),
    ...translationModel, run: () => openCaptionTranslation() },
  { id: 'whisper', icon: 'captions', name: aiText('aiWhisper'), desc: aiText('aiWhisperDesc'),
    model: () => 'Whisper ' + capModel(), license: 'MIT', size: () => CAP_MODELS[capModel()], ...whisperModel,
    run: () => { revealPanel('captions'); $('#bCaps').focus(); } },
  { id: 'assistant', icon: 'sparkles', name: aiText('asst'), desc: aiText('aiAssistantDesc'),
    model: 'Claude (Claude Code)', license: aiText('aiProprietary'), size: aiText('aiExternal'),
    ready: async () => (await inv('assistant_ready')) || null,
    run: () => { asstPanel().hidden = false; $('#asIn').focus(); } },
  { id: 'reframe', icon: 'crop', name: aiText('reframe'), desc: aiText('aiReframeDesc'), ...bundledAI,
    run: () => {
      if (!selectedItems().some(it => media(it)?.kind === 'video')) return toast(tr('aiPickVideo'));
      revealPanel('player');
      smartReframe();
    } },
  { id: 'highlights', icon: 'film', name: aiText('hlTitle'), desc: aiText('hlDesc'),
    model: () => 'Whisper ' + capModel() + ' + ' + tr('asst'), license: 'MIT', size: () => CAP_MODELS[capModel()], ready: () => whisperModel.ready(),
    run: () => openHighlights() },
  { id: 'speech-cuts', icon: 'scissors', name: aiText('aiSpeechCuts'), desc: aiText('aiSpeechCutsDesc'), ...bundledAI,
    run: () => {
      revealPanel('transcript');
      const details = $('#previewSilences').closest('details');
      details.open = $('#fillerList').closest('details').open = true;
      details.querySelector('summary').focus();
    } },
  { id: 'duck', icon: 'volume-2', name: aiText('duckSec'), desc: aiText('aiDuckDesc'), ...bundledAI,
    run: it => media(it)?.kind === 'audio' ? openAIInspector('tAudio', '[data-k="duck.on"]') : toast(tr('aiPickAudio')) },
  { id: 'tracking', icon: 'crosshair', name: aiText('tracking'), desc: aiText('aiTrackingDesc'), ...bundledAI,
    run: it => {
      if (!it || !(isText(it) || it.track !== 'v1' && ['video', 'image'].includes(media(it)?.kind))) return toast(tr('aiPickOverlay'));
      revealPanel('player');
      trackPick(it);
    } },
  { id: 'piper', icon: 'volume-2', name: aiText('piperTitle'), desc: aiText('piperDesc'),
    model: 'Piper voices via sherpa-onnx', license: 'Apache-2.0 (sherpa-onnx) + MIT (Piper voices)', size: aiText('piperModelSize'), ...piperModel,
    run: () => openPiper() },
  { id: 'voice-clean', icon: 'volume-2', name: aiText('voiceClean'), desc: aiText('voiceDesc'),
    model: 'DeepFilterNet3', license: 'MIT / Apache-2.0', size: '≈28 MB', ...voiceCleanModel,
    run: it => hasSound(media(it)) && !media(it).angles ? openAIInspector('tAudio', '[data-voice="on"]') : toast(tr('capPick')) },
  { id: 'denoise', icon: 'volume-2', name: aiText('denoise'), desc: aiText('aiDenoiseDesc'), ...bundledAI,
    model: 'RNNoise', license: 'BSD-3-Clause', size: '300 KB',
    run: it => hasSound(media(it)) && !media(it).angles ? openAIInspector('tAudio', '[data-k="denoise"]') : toast(tr('capPick')) },
];
function renderAITools() {
  aiToolPanel.setAttribute('aria-label', tr('aiTools'));
  const value = field => typeof field === 'function' ? field() : field?.[LANG] ?? field;
  aiToolPanel.innerHTML = AI_TOOLS.map(tool => `<article class="ai-card" data-ai-tool="${tool.id}">
    <h3>${icon(tool.icon)}<span>${esc(tool.name[LANG])}</span></h3><p>${esc(tool.desc[LANG])}</p>
    <p class="ai-model">${tool.model ? `<bdi>${esc(value(tool.model))}</bdi> · <bdi>${esc(value(tool.license))}</bdi> · <bdi>${esc(value(tool.size))}</bdi>` : tr('aiBuiltIn')}</p>
    ${tool.id === 'caption-translation' ? `<select data-translation-model aria-label="${tr('translationDirection')}">${translationDirectionOptions(translationModelDirection)}</select>` : ''}
    ${tool.id === 'scenes' ? `<label class="sam-field"><input type="checkbox" data-scenes-auto${lsGet('kadr.sceneAuto', false) ? ' checked' : ''}>${tr('scenesAuto')}</label>
      <label class="f"><span>${tr('scenesSens')}</span><input type="range" min="0.1" max="0.9" step="0.05" data-scenes-sens value="${sceneSens()}" aria-label="${tr('scenesSens')}"></label>` : ''}
    ${tool.id === 'piper' ? `<select data-piper-voice aria-label="${tr('piperVoice')}">${piperVoiceOptions()}</select>` : ''}
    <p class="ai-status"></p>
    <div class="ai-actions"><button type="button" class="primary" data-ai-action="run">${tr('aiOpen')}</button>
    ${tool.download ? '<button type="button" data-ai-action="model"></button>' : ''}</div></article>`).join('');
  refreshAITools();
}
let aiRefresh = 0;
function refreshAITools() {
  paintAITools();
  const revision = ++aiRefresh;
  for (const tool of AI_TOOLS) {
    const id = tool.key?.() ?? tool.id, before = aiReady.get(id);
    if (aiTransfers.has(tool.label)) continue;
    Promise.resolve().then(tool.ready).catch(() => null).then(ready => {
      if (revision !== aiRefresh || aiTransfers.has(tool.label) || aiReady.get(id) !== before) return;
      aiReady.set(id, ready);
      paintAITools();
    });
  }
}
function paintAITools() {
  for (const card of aiToolPanel.children) {
    const tool = AI_TOOLS.find(t => t.id === card.dataset.aiTool);
    const id = tool.key?.() ?? tool.id, ready = aiReady.get(id), transfer = aiTransfers.get(tool.label);
    const active = transfer?.id === id ? transfer : null;
    const label = active ? active.action === 'remove' ? 'aiRemoving' : 'aiDownloading'
      : ready === undefined ? 'aiChecking' : ready === null ? 'aiUnavailable' : ready ? 'aiReady' : 'aiMissing';
    card.querySelector('.ai-status').textContent = tr(label, { p: Math.round((active?.p || 0) * 100) });
    card.querySelector('[data-ai-action="run"]').disabled = tool.id === 'caption-translation' ? ready == null : ready == null || !!transfer;
    const direction = card.querySelector('[data-translation-model]');
    if (direction) direction.disabled = !!transfer;
    const piperPicker = card.querySelector('[data-piper-voice]');
    if (piperPicker) piperPicker.disabled = !!(transfer || piperJob);
    const button = card.querySelector('[data-ai-action="model"]');
    if (button) {
      const canStop = (tool.id === 'piper' || tool.id === 'voice-clean') && active?.action === 'download';
      button.textContent = tr(canStop ? 'cancel' : ready ? 'aiRemove' : 'aiDownload');
      button.disabled = (!canStop && (ready == null || !!transfer)) || (tool.id === 'piper' && !!(piperJob || piperCancelling));
    }
  }
  paintVoiceClean();
  paintPiper();
}
aiToolPanel.addEventListener('change', e => {
  if (e.target.matches('[data-scenes-auto]')) return lsSet('kadr.sceneAuto', e.target.checked);
  if (e.target.matches('[data-scenes-sens]')) return lsSet('kadr.sceneSens', +e.target.value);
  if (e.target.matches('[data-piper-voice]')) return selectPiperVoice(e.target.value);
  if (!e.target.matches('[data-translation-model]')) return;
  translationModelDirection = e.target.value;
  refreshAITools();
});
aiToolPanel.onclick = async e => {
  const button = e.target.closest('[data-ai-action]');
  if (!button) return;
  const tool = AI_TOOLS.find(t => t.id === button.closest('[data-ai-tool]').dataset.aiTool);
  try {
    if (button.dataset.aiAction === 'run') return await tool.run(sel && item(sel));
    if (tool.id === 'voice-clean' && aiTransfers.get(tool.label)?.action === 'download') return stopVoice('download');
    if (tool.id === 'piper' && aiTransfers.get(tool.label)?.action === 'download') return cancelPiper();
    if (tool.id === 'piper') piperError = '';
    if (aiReady.get(tool.key())) await tool.remove();
    else await tool.download();
    refresh();
  } catch (e) { if (cleanErr(e) !== 'cancelled') toast(tool.id === 'piper' ? piperErrorText(e) : cleanErr(e)); }
  finally {
    if (tool.id === 'piper' && !aiTransfers.has(tool.label)) piperCancelling = false;
    if (button.dataset.aiAction === 'model') refreshAITools();
  }
};
$('#bAITools').onclick = () => {
  revealPanel('aiTools');
  dock.querySelector('[data-dock-tab="aiTools"]')?.focus();
};
window.addEventListener('focus', () => { if (panelVisible('aiTools')) refreshAITools(); });

paintIcons();
applyLang();
paintProxyToggle();
ws = loadWorkspaces();
applyAccent(ws.accent);
renderDock();
document.fonts.load('800 40px "Cairo"').then(renderLibCards);
// Bundled fonts load on first use; redraw (and re-paint template cards) once they arrive.
document.fonts.addEventListener('loadingdone', () => { needsDraw = true; if (inspTab === 'tTpl' && document.activeElement.tagName !== 'INPUT') inspector(); });
syncSettings();
refresh();
requestAnimationFrame(loop);
setTimeout(autoUpdate, 3000);

/* ---------- MCP: Claude Code drives the open project live (`maqto --mcp`, see src-tauri/src/mcp.rs) ---------- */
const MCP_TOOLS = [
  ['get_project', 'The open project: size, fps, duration, playhead, lanes, media bin and every item as stored (learn item fields from it).', {}],
  ['catalog', 'Names you can use: text style presets and text style fields, text/clip animations (in/out/loop), transitions, effects (fx), filters (preset), layer types, easings, keyframe props, aspect ratios.', {}],
  ['new_project', 'Start an empty project (the old one stays one undo away).', { ratio: { type: 'string', description: 'e.g. 9:16, 16:9, 1:1' } }],
  ['set_project', 'Change project settings.', { ratio: { type: 'string' }, fps: { type: 'number' }, name: { type: 'string' } }],
  ['import_media', 'Add files (absolute paths: video, audio, images) to the media bin. Returns their media ids. add=true also puts each on the timeline, back to back.', { paths: { type: 'array', items: { type: 'string' } }, add: { type: 'boolean' } }, ['paths']],
  ['add_items', 'Add items to the timeline. Each needs type: "text" {text, start, dur, style_id?, style?{...fields}, x?, y? (0..1 of frame, default 0.5), anim?, out?, loop?} | "clip" {media (id), start?, dur?, track?, in?, speed?, x?, y? (px from centre), scale?} | "layer" {kind: solid|gradient|shadow|vignette, start, dur, fill?{c1,c2,a1,a2,...}} | "effect" {fx: id from catalog.fx OR preset: id from catalog.filters, start, dur}. Any extra field is set on the item as is. Returns the new item ids.', { items: { type: 'array', items: { type: 'object' } } }, ['items']],
  ['update_items', 'Change items. set: fields to assign (objects such as style, fill, fx are merged; null removes a field). Transition into a clip: set {trans: {id, dur, dir (0-3: turns a shader transition 90° each), ease (lin|smooth|hit|soft|bounce|short)}}. Timing: start, dur (seconds).', { updates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, set: { type: 'object' } }, required: ['id', 'set'] } } }, ['updates']],
  ['set_keyframes', 'Animate x, y, scale, rotate, opacity or volume of an item: keys are [time from the item start in seconds, value]; replaces that prop\'s keys ([] clears). Values use the item\'s units (text x/y 0..1; clip x/y px from centre; scale 1 = 100%; rotate degrees; opacity 0..1; volume 0..2, 1 = 100%, for audio and video with sound).', { id: { type: 'string' }, props: { type: 'object', description: '{ "scale": [[0,0.8],[0.5,1]], "volume": [[0,1],[5,0.4]] }' } }, ['id', 'props']],
  ['depth_effects', 'Prepare portrait blur, fog, or parallax on a video or image clip. Install Depth Anything V2 Small in AI Tools first. Amounts and focus range are 0 to 1. Set all amounts to zero to turn the effects off.', {
    id: { type: 'string' }, blur: { type: 'number', minimum: 0, maximum: 1 }, range: { type: 'number', minimum: 0, maximum: 1 },
    progressive: { type: 'boolean' }, fog: { type: 'number', minimum: 0, maximum: 1 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    parallax: { type: 'number', minimum: 0, maximum: 1 }, motion: { type: 'string', enum: ['zoomIn', 'leftRight', 'circle'] },
    focus: { type: ['object', 'null'], description: 'Normalized source coordinates x and y and source time in seconds. Null selects auto focus.',
      properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, time: { type: 'number', minimum: 0 } }, required: ['x', 'y', 'time'] },
  }, ['id']],
  ['upscale_clip', 'Prepare an upscaled video or image clip. Install Real-ESRGAN in AI Tools first. Set scale to 0 to turn it off.', {
    id: { type: 'string' }, scale: { type: 'integer', enum: [0, 2, 4] }, model: { type: 'string', enum: ['footage', 'animation'] },
  }, ['id', 'scale']],
  ['translate_captions', 'Translate text clips offline, preserving their timings. Install the model for the language direction in AI Tools first. Specify replace or track to add a second caption track.', {
    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
    direction: { type: 'string', enum: Object.keys(TRANSLATION_DIRECTIONS) },
    output: { type: 'string', enum: ['replace', 'track'] },
  }, ['ids', 'output']],
  ['remove_object', 'Fill a clip’s existing SAM 2 or brush mask with MI-GAN. Download MI-GAN in AI Tools first.', { id: { type: 'string' }, smooth: { type: 'boolean' } }, ['id']],
  ['voice_over', 'Generate offline speech from text and add a WAV clip to the timeline. Install the voice in AI Tools first.', {
    text: { type: 'string' }, voice: { type: 'string', enum: Object.keys(PIPER_VOICES) },
    start: { type: 'number', minimum: 0 }, length_scale: { type: 'number', minimum: 0.7, maximum: 1.4 },
    pause: { type: 'number', minimum: 0, maximum: 3 },
  }, ['text', 'voice']],
  ['voice_clean', 'Set AI voice clean-up on a clip. Install DeepFilterNet3 in AI Tools first. Strength is the attenuation limit in dB and room is the percentage of original sound.', { id: { type: 'string' }, on: { type: 'boolean' }, strength: { type: 'integer', enum: [12, 24, 100] }, room: { type: 'integer', minimum: 0, maximum: 30 } }, ['id', 'on']],
  ['get_object_mask', 'Get the tracked object mask bounds and centroid for a clip at a source time in seconds. Coordinates are in the mask grid.', { id: { type: 'string' }, time: { type: 'number' } }, ['id', 'time']],
  ['generate_ducking', 'Enable ducking on an audio clip and generate volume keyframes from other clips with sound. Uses the clip’s duck settings (amount in dB, attack and release in seconds, source track id or empty for all other clips).', { id: { type: 'string' } }, ['id']],
  ['remove_silences', 'Detect and ripple-cut silence in the selected clips or the main track. Minimum and padding are timeline seconds.', { thresholdDb: { type: 'number' }, minSilence: { type: 'number' }, padding: { type: 'number' } }],
  ['transcript_cut', 'Ripple-cut by zero-based word indices in the current transcript’s timeline order, or by a timeline range in seconds on the selected clips or main track.', { indices: { type: 'array', items: { type: 'integer', minimum: 0 } }, start: { type: 'number' }, end: { type: 'number' } }],
  ['delete_items', 'Remove items by id.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']],
  ['set_marker', 'Add or edit a marker at time in seconds. Omitted fields keep their current values.', {
    time: { type: 'number' }, name: { type: 'string', maxLength: 80 }, note: { type: 'string' },
    color: { type: 'string', enum: Object.keys(MARKER_COLORS) },
  }, ['time']],
  ['delete_marker', 'Remove the marker at time in seconds.', { time: { type: 'number' } }, ['time']],
  ['preview', 'Move the playhead to time (seconds) and return the rendered frame as an image. Use it to check your work.', { time: { type: 'number' } }, ['time']],
  ['play', 'Play from a time (seconds) on the user\'s screen; stop: true pauses.', { from: { type: 'number' }, stop: { type: 'boolean' } }],
  ['undo', 'Undo the last change (each tool call is one step).', { redo: { type: 'boolean' } }],
  ['export', 'Render the project to an mp4 at path (absolute). Waits until done.', { path: { type: 'string' }, fps: { type: 'number' } }, ['path']],
  ['export_timeline', 'Write the open timeline to an absolute path. Returns the path and any interchange omissions.', { format: { type: 'string', enum: Object.keys(interchange.formats) }, path: { type: 'string' } }, ['format', 'path']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}) } }));

const atT = (time, fn) => { const keep = t; t = Math.max(0, num(time, t)); try { return fn(); } finally { t = keep; } };
const mergeSet = (o, set) => {
  for (const [k, v] of Object.entries(set || {})) {
    if (v === null) delete o[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && k !== 'trans') Object.assign(o[k], v);
    else o[k] = v;
  }
};
const mcpPic = async time => {
  setPlaying(false); seek(time);
  await new Promise(r => setTimeout(r, 700)); // video elements seek and decode
  draw();
  const k = Math.min(1, 720 / Math.max(view.width, view.height)), c = document.createElement('canvas');
  c.width = Math.round(view.width * k); c.height = Math.round(view.height * k);
  c.getContext('2d').drawImage(view, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
};
const MCP = {
  get_project: () => ({ w: P.w, h: P.h, fps: P.fps, name: P.name, duration: +total().toFixed(3), playhead: +t.toFixed(3), tracks: P.tracks, groups: P.groups,
    media: Object.fromEntries(Object.entries(P.media).map(([id, m]) => [id, { kind: m.kind, name: m.name, dur: m.dur, w: m.w, h: m.h, path: m.path, fill: m.fill, adj: m.adj }])), items: P.items, markers: P.markers }),
  catalog: () => ({ text_styles: TEXT_STYLES.map(s => s.id), text_style_fields: textDefaults(), text_anim_in: ANIM_IN, text_anim_out: ANIM_OUT, text_anim_loop: ANIM_LOOP,
    clip_anim_in: Object.keys(S.VA_IN), clip_anim_out: Object.keys(S.VA_OUT), clip_anim_loop: Object.keys(S.VA_LOOP),
    transitions: [...S.TRANS, ...S.GLT], fx: S.FX, filters: Object.keys(S.PRESETS), layers: LAYERS, blends: ['normal', ...Object.keys(BLENDS)],
    keyframe_props: S.KF, ratios: Object.keys(ASPECTS) }),
  new_project: a => { snapshot(); P = newProject(); if (ASPECTS[a.ratio]) [P.w, P.h] = ASPECTS[a.ratio]; openGrp = null; setSelection([]); projectPath = null; t = 0; syncSettings(); return { w: P.w, h: P.h }; },
  set_project: a => {
    if (a.ratio) { if (!ASPECTS[a.ratio]) throw new Error('ratio must be one of ' + Object.keys(ASPECTS).join(', ')); [P.w, P.h] = ASPECTS[a.ratio]; }
    if (a.fps) P.fps = clamp(Math.round(a.fps), 12, 120);
    if (a.name) P.name = a.name;
    syncSettings(); return { w: P.w, h: P.h, fps: P.fps };
  },
  import_media: async a => {
    const ids = addToBin(await inv('probe', { paths: a.paths }));
    const items = a.add ? ids.map(id => addMedia(id, null, null).id) : [];
    return { media: ids, items };
  },
  add_items: a => a.items.map(x => {
    const { type, start, dur, style_id, style, kind, fx, preset, media: mid, track, ...rest } = x;
    let it;
    if (type === 'text') {
      const d = num(dur, 3), slot = atT(start, () => textSlot(d));
      it = { id: uid(), type: 'text', ...slot, dur: d, text: String(x.text ?? ''), style: { ...presetStyle(style_id), ...(style || {}) }, x: 0.5, y: 0.5, anim: 'fade', out: 'fade' };
      addTimelineItem(it);
    } else if (type === 'clip') {
      if (!P.media[mid]) throw new Error('unknown media id ' + mid + ' (import_media first)');
      it = addMedia(mid, track, start == null ? null : +start);
      if (dur != null) it.dur = +dur;
    } else if (type === 'layer') {
      if (!LAYERS[kind]) throw new Error('layer kind must be one of ' + Object.keys(LAYERS).join(', '));
      atT(start, () => addFill(kind));
      it = item(sel); it.dur = num(dur, 5); mergeSet(it.fill, x.fill);
    } else if (type === 'effect') {
      if (fx ? !S.FX.includes(fx) : !S.PRESETS[preset]) throw new Error('unknown effect; see catalog fx / filters');
      atT(start, () => addAdj(fx ? 'fx' : 'preset', fx || preset));
      it = item(sel); it.dur = num(dur, 3);
    } else throw new Error('type must be text, clip, layer or effect');
    delete rest.text; delete rest.fill;
    mergeSet(it, rest);
    return it.id;
  }),
  update_items: a => a.updates.map(u => { const it = item(u.id); if (!it) throw new Error('no item ' + u.id); mergeSet(it, u.set); return it.id; }),
  set_keyframes: a => {
    const it = item(a.id);
    if (!it) throw new Error('no item ' + a.id);
    for (const [k, keys] of Object.entries(a.props)) {
      if (!S.KF.includes(k)) throw new Error('keyframe props: ' + S.KF.join(', '));
      it.kf ??= {};
      if (keys && keys.length) it.kf[k] = keys.map(([x, v]) => [+(+x).toFixed(4), +v]).sort((p, q) => p[0] - q[0]); else delete it.kf[k];
    }
    if (!S.hasKf(it)) delete it.kf;
    return it.id;
  },
  voice_over: async ({ text, voice, start = t, length_scale = 1, pause = 0.2 }) => {
    if (!text?.trim() || !Number.isFinite(start) || start < 0) throw new Error('Invalid voice-over text or start time');
    try {
      const [id] = await makeVoiceOver([{ text }], { voice, lengthScale: length_scale, pause }, [start]);
      return { id };
    } catch (e) { throw new Error(piperErrorText(e)); }
  },
  voice_clean: ({ id, on, strength, room }) => {
    const it = item(id), m = media(it);
    if (!hasSound(m) || m.angles) throw new Error(tr('capPick'));
    it.voiceClean = S.voiceSettings({ ...it.voiceClean, on, ...(strength == null ? {} : { strength }), ...(room == null ? {} : { room }) });
    if (on) tryVoiceClean(it);
    return it.voiceClean;
  },
  depth_effects: async ({ id, ...settings }) => {
    const it = item(id);
    if (!upscaleMedia(it)) throw new Error(tr('upscalePick'));
    const depth = depthSettings({ depth: { ...depthSettings(it), ...settings } });
    return { id, ...await prepareDepth(it, depth, false) };
  },
  upscale_clip: async ({ id, scale, model }) => {
    const it = item(id);
    if (!upscaleMedia(it)) throw new Error(tr('upscalePick'));
    const settings = { scale, model: model || upscaleType(it) };
    if (!scale) { setUpscale(it, settings); return { id, scale }; }
    const result = await prepareUpscale(it, settings, false);
    return { id, scale, ...result };
  },
  remove_object: async ({ id, smooth }) => {
    const it = item(id), m = objectMedia(it), project = P;
    if (!m || !it.objectMask?.key) throw new Error(tr('samCacheMissing'));
    const original = it.objectMask, range = [num(it.in, 0), S.srcLen(it)];
    const objectMask = { ...original, mode: 'fill', smooth: smooth ?? original.smooth ?? true };
    const state = fillState({ ...it, objectMask }, m, true);
    if (!state) throw new Error(tr('fillRenderFailed'));
    const current = state.cancelled ? fillState({ ...it, objectMask }, m, true, true) : state;
    const rendered = await current.wait;
    if (!rendered) throw new Error(fillError(current));
    if (project !== P || item(id) !== it || media(it) !== m || it.objectMask !== original ||
        num(it.in, 0) !== range[0] || S.srcLen(it) !== range[1]) throw new Error(tr('fillRenderFailed'));
    snapshot(); it.objectMask = objectMask; dirty = true;
    return { id, frames: rendered.times.length };
  },
  get_object_mask: async ({ id, time }) => {
    const it = item(id);
    if (!it) throw new Error('No clip with id ' + id);
    if (!it.objectMask?.key) throw new Error(tr('samCacheMissing'));
    const data = new Uint8Array(await inv('sam2_mask_for_frame', { key: it.objectMask.key, source: media(it)?.path, time }));
    const width = data[0] + 256 * data[1], height = data[2] + 256 * data[3];
    return { width, height, ...S.objectMaskGeometry(data.subarray(4), width, height) };
  },
  translate_captions: async a => {
    const clips = [...new Set(a.ids)].map(item);
    if (!clips.length || !clips.every(isTranslatable)) throw new Error(tr('translationPick'));
    if (a.output !== 'replace' && a.output !== 'track') throw new Error('Choose replace or track');
    if (a.output === 'replace' && clips.some(it => lockedTrack(it.track))) throw new Error(tr('translationLocked'));
    const direction = a.direction ?? S.captionDirection(clips.map(it => it.text));
    if (!await inv('translation_ready', { direction })) throw new Error(tr('translationMissing'));
    const translated = await translateCaptionItems(clips, direction, { id: uid() });
    return { ids: applyCaptionTranslation(clips, translated, direction, a.output) };
  },
  generate_ducking: a => generateDucking(item(a.id)),
  remove_silences: async a => {
    const { ranges } = await scanSilences(speechTargets(), silenceOptions(a));
    return { cuts: applySpeechCuts(ranges) };
  },
  transcript_cut: a => {
    if (Array.isArray(a.indices)) return { cuts: cutTranscript(visibleTranscript(), a.indices.filter(Number.isInteger)) };
    if (!Number.isFinite(a.start) || !Number.isFinite(a.end) || a.start < 0 || a.end <= a.start) throw new Error('Provide word indices or a valid start and end');
    const ranges = new Map();
    for (const it of speechTargets()) {
      const start = Math.max(a.start, it.start), end = Math.min(a.end, it.start + it.dur);
      if (end > start) addSpeechRanges(ranges, it, [[start, end]]);
    }
    return { cuts: applySpeechCuts(ranges) };
  },
  delete_items: a => { const ids = new Set(a.ids); P.items = P.items.filter(i => !ids.has(i.id)); return a.ids; },
  set_marker: a => {
    const m = markerAt(a.time);
    if (!m && (!Number.isFinite(a.time) || a.time < 0 || a.time > total())) throw new Error('Marker time is outside the timeline');
    if (a.color != null && !Object.hasOwn(MARKER_COLORS, a.color)) throw new Error('Invalid marker color');
    const [marker] = S.normalizeMarkers([{
      time: m?.time ?? a.time, name: a.name ?? m?.name, note: a.note ?? m?.note, color: a.color ?? m?.color,
    }]);
    if (m) Object.assign(m, marker);
    else { P.markers.push(marker); P.markers.sort((a, b) => a.time - b.time); }
    return marker;
  },
  delete_marker: a => {
    const m = markerAt(a.time);
    if (m) P.markers.splice(P.markers.indexOf(m), 1);
    return { deleted: !!m };
  },
  play: a => { if (a.stop) setPlaying(false); else { if (a.from != null) seek(+a.from); setPlaying(true); } return { playing }; },
  undo: a => { restore(a.redo ? redoStack : undoStack, a.redo ? undoStack : redoStack); return { undo: undoStack.length, redo: redoStack.length }; },
  export: async a => { setPlaying(false); await doExport(P, { k: 1, fps: a.fps || P.fps, codec: 'h264', quality: 'rec' }, { video: a.path }); return { path: a.path, exists: await inv('path_exists', { path: a.path }) }; },
  export_timeline: a => writeTimeline(a.format, a.path),
};
const MCP_NO_SNAPSHOT = new Set(['get_project', 'get_object_mask', 'remove_object', 'upscale_clip', 'depth_effects', 'catalog', 'preview', 'play', 'undo', 'export', 'export_timeline', 'generate_ducking', 'remove_silences', 'transcript_cut', 'translate_captions', 'voice_over']);
async function mcpCall(method, p) {
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: MCP_TOOLS };
  const name = p && p.name, a = (p && p.arguments) || {};
  if (!transcribing && !captionTranslationJob) hideModal();
  if (name === 'preview') return { content: [{ type: 'image', data: await mcpPic(+a.time || 0), mimeType: 'image/jpeg' }, { type: 'text', text: `frame at ${fmt(t)}` }] };
  if (!MCP[name]) throw new Error('unknown tool ' + name);
  const n = undoStack.length;
  if (!MCP_NO_SNAPSHOT.has(name)) snapshot();
  try {
    const r = await MCP[name](a);
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } finally {
    if (!MCP_NO_SNAPSHOT.has(name)) { undoStack.length = Math.min(undoStack.length, n + 1); dirty = true; } // one undo step per call
    refresh(); needsDraw = true;
  }
}
/* ---------- assistant: the user's own Claude Code drives the editor through the MCP tools above ---------- */
const asst = { session: '', job: null, el: null, failed: false };
const LOGIN_RE = /Not logged in|Please run \/login|Failed to authenticate|OAuth session expired/i;
function asstPanel() {
  if (asst.el) return asst.el;
  const el = asst.el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'asst', hidden: true }));
  el.innerHTML = `<header><b>${icon('sparkles')}${tr('asst')}</b><span class="flex"></span><button class="ib" id="asNew" title="${tr('asstNew')}">${icon('plus')}</button><button class="ib" id="asClose">${icon('x')}</button></header>
    <div id="asLog"><p class="hint">${tr('asstHello')}</p></div>
    <form id="asForm"><textarea id="asIn" rows="2" dir="auto" placeholder="${tr('asstPh')}"></textarea><button class="primary" id="asGo">${icon('arrow-up')}</button></form>`;
  paintIcons(el);
  $('#asClose').onclick = () => (el.hidden = true);
  $('#asNew').onclick = () => { if (asst.job) return; asst.session = ''; $('#asLog').innerHTML = `<p class="hint">${tr('asstHello')}</p>`; };
  $('#asIn').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); asstSend(); } });
  $('#asForm').onsubmit = e => { e.preventDefault(); asst.job ? inv('assistant_stop', { job: asst.job }) : asstSend(); };
  return el;
}
const asstMsg = (cls, html) => { const log = $('#asLog'), d = log.appendChild(Object.assign(document.createElement('div'), { className: 'am ' + cls })); d.innerHTML = html; log.scrollTop = log.scrollHeight; return d; };
const asstBusy = on => { const b = $('#asGo'); b.innerHTML = icon(on ? 'square' : 'arrow-up'); paintIcons(b); asst.el.classList.toggle('busy', on); };
async function asstSend() {
  const q = $('#asIn').value.trim();
  if (!q || asst.job) return;
  if (!(await inv('assistant_ready'))) return asstMsg('err', tr('asstMissing'));
  $('#asIn').value = '';
  asstMsg('me', esc(q));
  const job = asst.job = uid(), wait = asstMsg('ai work', `<i></i><i></i><i></i>`);
  asstBusy(true);
  asst.failed = false;
  try { await inv('assistant_ask', { prompt: q, session: asst.session, job }); }
  catch (e) { if (!asst.failed) asstMsg('err', esc(cleanErr(e))); } // the result event already said why
  wait.remove();
  asst.job = null; asstBusy(false);
}
TA.event.listen('assistant-ev', e => {
  const { job, ev } = e.payload;
  if (job !== asst.job) return;
  if (ev.session_id) asst.session = ev.session_id;
  const wait = $('#asLog .work');
  if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
    if (c.type === 'text' && c.text.trim() && !LOGIN_RE.test(c.text)) asstMsg('ai', esc(c.text.trim()).replace(/\n/g, '<br>'));
    else if (c.type === 'tool_use') asstMsg('tool', `${icon('wand-sparkles')}<span>${esc(String(c.name).replace(/^mcp__maqto__/, '').replace(/_/g, ' '))}</span>`);
    if (wait) $('#asLog').appendChild(wait);
  }
  if (ev.type === 'result' && LOGIN_RE.test(ev.result || '')) { asst.failed = true; asstMsg('err', tr('asstLogin')); }
  else if (ev.type === 'result' && (ev.is_error || ev.subtype !== 'success')) { asst.failed = true; asstMsg('err', esc(ev.result || ev.subtype)); }
  paintIcons($('#asLog'));
});
$('#bAsst').onclick = () => { const el = asstPanel(); el.hidden = !el.hidden; if (!el.hidden) $('#asIn').focus(); };

TA.event.listen('mcp-call', async e => {
  const { id, method, params } = e.payload;
  let out;
  try { out = { result: await mcpCall(method, params) }; } catch (err) { out = { error: cleanErr(err) }; }
  inv('mcp_reply', { id, result: out });
});

inv('dev_demo').then(async d => {
  if (!d.paths || !d.paths.length) return (await openPending()) || newProj(true); // always the start screen; unsaved work waits there as a card
  const ids = addToBin(await inv('probe', { paths: d.paths }));
  for (const id of ids) addMedia(id, P.media[id].kind === 'image' ? 'v2' : null, P.media[id].kind === 'image' ? 1 : null);
  const pic = P.items.find(i => P.media[i.media]?.kind === 'image');
  if (pic) Object.assign(pic, { scale: 0.3, y: -560 });
  addText('accent');
  seek(1.5);
  P.items.find(i => P.media[i.media]?.kind === 'video').preset = 'bw';
  setTimeout(() => {
    draw();
    const vi = P.items.find(i => P.media[i.media]?.kind === 'video'), ve = elFor(vi);
    inv('dev_log', { msg: `video ready=${ve.readyState} err=${ve.error && ve.error.code} canvas=${view.width}x${view.height}` });
    const px = vctx.getImageData(P.w * 0.25, P.h * 0.4, 1, 1).data; // yellow bar -> gray when B&W preview works
    inv('dev_log', { msg: 'preview pixel ' + Array.from(px).join(',') + ' items ' + P.items.length });
    if (d.export) doExport(P, { k: 1, fps: P.fps, codec: 'h264_hw', quality: 'rec' }, { video: d.export });
  }, 2500);
}).finally(initWhatsNew);
})();

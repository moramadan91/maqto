import gsap from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';
import { ScrollTrigger } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger/+esm';
import Lenis from 'https://cdn.jsdelivr.net/npm/lenis@1.1.13/+esm';

gsap.registerPlugin(ScrollTrigger);
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rtl = () => document.documentElement.dir === 'rtl';
const motionOK = matchMedia('(prefers-reduced-motion: no-preference)').matches;

/* ---------- language: Arabic comes from the page, English from here ---------- */
const EN = {
  skip: 'Skip to content', nDemos: 'What it does', nInside: 'Inside', nClaude: 'Assistant', nInstall: 'Install', nFaq: 'FAQ', nGet: 'Free download',
  tag: 'Completely free · Mac & Windows · no watermark',
  h1: 'Pro video editing, fluent in Arabic.',
  lead: 'Auto captions timed word by word, silence cutting with the assistant, 567 motions and 495 transitions, color, and export up to 4K. Free, and all on your computer.',
  mac: 'Download for Mac', macSub: 'Apple Silicon · M1 and later', win: 'Download for Windows', winSub: 'Windows 10 and 11 · 64-bit', ver: 'Version {v}',
  showAlt: 'The real Maqto window', fl1: 'Auto Arabic captions', fl2: 'HEVC · 60fps', fl3: '“Cut the silences”',
  numsAria: 'Library', n1: 'clip motions', n2: 'transitions', n3: 'filters', n4: 'effects', n5: 'animated icons', n6: 'text animations', n7: 'Google fonts', n8: 'HEVC export',
  dEye: 'See it working', dTitle: 'Six things, each one saves you an hour.', pause: 'Pause motion', prev: 'Previous', next: 'Next', play: 'Play motion',
  d1: 'Auto captions, word by word.', d1p: 'One click turns speech into captions synced to the voice, and the spoken word lights up. It captions only the clips you pick, and one style applies to all of them.', d1c2: 'Every word timed', d1c3: 'On your computer',
  d2: '“Cut the silences.” Done.', d2p: 'Ask the assistant inside Maqto and it finds the pauses, cuts them and closes the gaps, so the video gets tighter. Every step undoes with Cmd/Ctrl+Z.', d2q: 'Cut the silences from the video', d2c1: 'With the assistant (Claude)', d2c2: 'Magnetic cuts', d2c3: 'One-key undo', d2r: '4 silences removed',
  d3: 'A timeline that thinks with you.', d3p: 'A magnetic main track with no gaps, S to split, video, audio and text lanes, draggable keyframes and smooth zoom. Playback sound is sample-exact.', d3c1: 'Magnetic', d3c2: 'Keyframes', d3c3: 'Speed curves', d3tx: 'Flame grilled',
  d4: 'Motion without After Effects.', d4p: '567 clip animations (3D, glitch, device frames, comics) and 70 for text, keyframes for position, scale and rotation, and smooth speed curves with AI slow motion.', d4c1: 'In · Out · Loop', d4c2: 'AI slow-mo', d4c3: 'Motion tracking', d4w1: 'Flame', d4w2: 'grilled', d4cv: 'Speed curve',
  d5: '495 transitions. 455 filters. 328 effects.', d5p: 'A full library with live previews: shader transitions, cinematic filters and LUTs, chroma key, AI background removal and WebGL color. The preview matches the export exactly.', d5c1: 'LUTs', d5c2: 'Chroma key', d5c3: 'AI background removal',
  d6: 'Drag. Click. Export.', d6p: 'A calm glass interface in Arabic and English, 9:16, 16:9 and 1:1, TikTok, Instagram and Snapchat safe zones, autosave, and updates that arrive on their own.', d6c1: 'English + عربي', d6c2: 'Safe zones', d6c3: 'Autosave', exp: 'Export',
  iEye2: 'Inside the app', iTitle2: 'Real screens, not mockups.', iSub2: 'This is Maqto as you will open it: the captions panel, the effects library with live previews, animated stickers and icons, and the timeline.',
  il1: 'Captions', il1p: 'Pick the spoken language and the speech model, then press Auto captions.', il2: 'Effects', il2p: 'Sort by trending and favourites; click again to remove an effect.', il3: 'Stickers', il3p: 'Animated emoji and 646 icons in your colour and line width.',
  mEye: 'And also', mTitle: 'Everything you look for, in one app.',
  m1: 'Color and LUTs', m1p: 'Color wheels, curves and LUTs. The preview matches the export.', m2: 'Chroma key', m2p: 'Drop the green screen and put any background behind it.', m3: 'AI background removal', m3p: 'For people and products, with no green screen and no internet.', m4: 'Smooth slow motion', m4p: 'AI in-between frames (RIFE) so slow motion never stutters.', m5: 'Voiceover and clean audio', m5p: 'Record in the app and remove noise with RNNoise.', m6: 'Motion tracking', m6p: 'Text or a sticker follows what moves in the frame.', m7: 'Safe zones', m7p: 'See where TikTok, Instagram and Snapchat put their buttons before you post.', m8: 'Export up to 4K', m8p: 'H.264 and HEVC, hardware accelerated on Mac, up to 60 fps.', m9: 'Hundreds of fonts', m9p: 'Every Arabic Google font ready, plus your own, with Arabic shaped right.', m10: 'Automatic updates', m10p: 'Every new version reaches you on its own, signed and verified.', m11: 'Autosave', m11p: '.maqto files with their own icon, and recovery if the computer shuts down.', m12: 'Stays on your computer', m12p: 'Your files, audio and transcripts are never uploaded anywhere.',
  cEye: 'Maqto + Claude', cTitle: 'Write the idea, watch the video build itself.', cSub: 'Maqto has an assistant inside the app and an MCP server. Claude works on your timeline live: it cuts, adds text, motion and transitions, looks at the frame to check, and exports.',
  aTag: 'The assistant inside the app', aTitle: 'No terminal, no commands.',
  as1: 'Install <a href="https://claude.com/claude-code" target="_blank" rel="noopener"><b>Claude Code</b></a> and sign in with your Claude account.',
  as2: 'In Maqto, press <b>Assistant</b> at the top.', as3: 'Write what you want, like <b>“cut the silences”</b> or <b>“put a title in the first 3 seconds”</b>, and watch it happen.',
  aNote: 'Needs a <b>Claude Pro</b> plan or higher. The assistant runs on your own account and can\'t touch any files on your computer beyond the open project.',
  aUiT: 'Assistant', aUiQ: 'Cut the silences and put a “Today\'s deal” title in the first 3 seconds', aUiA: 'Done: I removed 4 silences (9.4 s) and put “Today\'s deal” from 0 to 3 s, then checked the frame.', aUiPh: 'What should I do?',
  aOr: 'Or connect Maqto to Claude Code from the terminal:', cSteps: 'Connect in 4 steps',
  c1: 'Get Maqto <b>1.0.6</b> or newer. On a Mac it must be in <b>Applications</b>.',
  c2: 'Install <a href="https://claude.com/claude-code" target="_blank" rel="noopener"><b>Claude Code</b></a> and sign in with your account.',
  c3: 'Open the terminal and run the connect command once.',
  c4: 'Start a new Claude Code session and write your request, saying <b>in Maqto</b>. The first time it asks for permission, choose <b>Allow always</b>.',
  cNote: 'No slash command and no need to say MCP. If the tools don\'t show up, type <b>/mcp</b> in the session and check that <b>maqto</b> is <b>connected</b>.',
  cCmd: 'Connect command', cMac: 'Mac (Terminal)', cWin: 'Windows (PowerShell)', cTry: 'Try writing', copy: 'Copy', copied: 'Copied',
  cEx: 'In Maqto, make an 8-second 9:16 motion video for a burger place: gradient background, 3 lines coming in one after another with motion, then export it to the Desktop.',
  cUndo: 'Maqto opens by itself if it is closed, and every step Claude takes can be undone with Cmd/Ctrl+Z.',
  iEye: 'Install', iTitle: 'One minute and you are in.', iSub: 'Maqto is free and not sold through the Apple or Microsoft stores, so your system asks once.', iMac: 'Mac', iWin: 'Windows',
  m1i: 'Open the <b>.dmg</b> file and drag Maqto into <b>Applications</b>.',
  m2i: 'Open Maqto. If it says the developer cannot be verified, click <b>Done</b>.',
  m3i: 'Go to <b>System Settings → Privacy &amp; Security</b>, scroll down and click <b>Open Anyway</b>.',
  mA: 'In <b>System Settings</b>, pick <b>Privacy &amp; Security</b> in the sidebar.',
  mB: 'Scroll to <b>Security</b> and find <b>“Maqto” was blocked</b>. Click <b>Open Anyway</b> and confirm with your password or Touch ID. You only do this once.',
  mNote: 'A Mac with Apple silicon (M1 or later) and macOS 13.4 or later.',
  w1: 'Run the <b>setup.exe</b> file.', w2: 'If you see <b>Windows protected your PC</b>, click <b>More info</b>, then <b>Run anyway</b>.', w3: 'Pick a language and finish the setup.', wNote: 'Windows 10 or 11, 64-bit.',
  bTitle: 'If your browser blocks the download',
  bSub: 'Browsers sometimes hold back free apps that are not from the Apple or Microsoft stores, especially when the browser\'s protection is turned off. The file comes from Maqto\'s official GitHub page; finish the download in two steps:',
  b1: 'Open your downloads list and click the Maqto file marked <b>Unverified download blocked</b>.',
  b2: 'Click <b>Download unverified file</b> and the download finishes. Then follow the install steps above.',
  qEye: 'FAQ', qTitle: 'Before you ask.',
  q1: 'Is it really free?', a1: 'Yes. No subscription, no ads, and no watermark on your videos.',
  q2: 'Do I need internet?', a2: 'No. Editing and export work offline. You only need internet for updates and to download the caption model once (about 550 MB for the recommended one).',
  q3: 'Which computers does it run on?', a3: 'Macs with Apple silicon (M1 or later) on macOS 13.4 or later, and Windows 10 or 11, 64-bit.',
  q6: 'How does silence cutting work?', a6: 'Through the assistant inside Maqto: write “cut the silences” and Claude finds the pauses and cuts them on the timeline. It needs Claude Code and a Claude Pro plan or higher.',
  q4: 'How do updates arrive?', a4: 'When you open Maqto it checks for a new version and asks you. Say yes and it downloads, restarts and opens the new version.',
  q5: 'Are my videos uploaded anywhere?', a5: 'No. Your files, audio and transcription all stay on your computer.',
  endT: 'Try Maqto today.', endS: 'Free, no account, no watermark.', foot: 'Maqto · free, no ads', all: 'All versions',
};
const AR = { prev: 'السابق', next: 'التالي', ver: 'نسخة {v}', pause: 'وقّف الحركة', play: 'شغّل الحركة', copied: 'تم النسخ', showAlt: 'شاشة ماكتو الحقيقية', numsAria: 'المكتبة'};
$$('[data-t]').forEach(el => (AR[el.dataset.t] ??= el.hasAttribute('data-html') ? el.innerHTML : el.textContent));
const T = { ar: AR, en: EN };
let lang = 'ar', version = '';
try { lang = localStorage.getItem('maqto.lang') || 'ar'; } catch (e) {}

// Word-level split: Arabic letters must stay joined. Words after the first comma get the accent.
const splitWords = el => {
  let after = false;
  el.innerHTML = el.textContent.trim().split(/\s+/).map(w => {
    const h = `<span class="w${after ? ' acc' : ''}"><span class="wi">${w}</span></span>`;
    if (/[،,]$/.test(w)) after = true;
    return h;
  }).join(' ');
};

function applyLang() {
  const d = T[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $$('[data-t]').forEach(el => {
    const v = d[el.dataset.t];
    if (v == null) return;
    if (el.hasAttribute('data-html')) el.innerHTML = lang === 'ar' ? v : v.replace(/<b>/g, '<b><bdi>').replace(/<\/b>/g, '</bdi></b>');
    else el.textContent = v;
    if (el.classList.contains('split')) splitWords(el);
  });
  $$('[data-t-aria]').forEach(el => el.setAttribute('aria-label', d[el.dataset.tAria]));
  $$('[data-t-alt]').forEach(el => (el.alt = d[el.dataset.tAlt]));
  $('#lang span').textContent = lang === 'ar' ? 'English' : 'عربي';
  $('#pz span').textContent = paused ? d.play : d.pause;
  document.title = lang === 'ar' ? 'ماكتو — محرر فيديو مجاني للماك والويندوز' : 'Maqto — free video editor for Mac and Windows';
  showVer();
}
function showVer() {
  $$('#download [data-v]').forEach(el => (el.textContent = version ? T[lang].ver.replace('{v}', version) : ''));
  $('#dl2').innerHTML = $('#download').innerHTML.replace(/ id="(mac|win)"/g, '');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('.cp');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.previousElementSibling.textContent.trim()); } catch (err) { return; }
  b.textContent = T[lang].copied;
  setTimeout(() => (b.textContent = T[lang].copy), 1500);
});

// The visitor's own OS goes first.
const first = $(/Windows/i.test(navigator.userAgent) ? '#win' : '#mac').parentNode;
first.parentNode.prepend(first);

fetch('https://api.github.com/repos/moramadan91/maqto/releases/latest')
  .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
  .then(rel => {
    for (const [id, re] of [['#mac', /\.dmg$/i], ['#win', /setup\.exe$/i]]) {
      const a = rel.assets.find(x => re.test(x.name));
      if (a) $(id).href = a.browser_download_url;
    }
    version = rel.tag_name.replace(/^v/, '');
    showVer();
  })
  .catch(() => {}); // buttons already open the releases page

/* ---------- looping demos: play only while on screen and not paused ---------- */
let paused = !motionOK;
const loops = new Map(); // element -> { tl, vis }
const sync = () => loops.forEach(l => (l.vis && !paused ? l.tl.play() : l.tl.pause()));
const io = new IntersectionObserver(es => es.forEach(e => {
  const l = loops.get(e.target);
  if (l) { l.vis = e.isIntersecting; sync(); }
}), { threshold: 0.15 });
const loop = (el, tl) => {
  const old = loops.get(el);
  if (old) old.tl.kill();
  loops.set(el, { tl: tl.pause(), vis: old ? old.vis : false });
  if (!old) io.observe(el);
};

// seeded waveform bars (mulberry32) so every visit looks the same
const mulberry = a => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
$$('.wave[data-bars]').forEach((w, k) => {
  const r = mulberry(11 + k);
  w.innerHTML = Array.from({ length: +w.dataset.bars }, (_, i) => `<i style="--h:${(0.18 + 0.82 * Math.abs(Math.sin(i * 0.45)) * (0.45 + r() * 0.55)).toFixed(2)}"></i>`).join('');
});

function buildLoops() {
  const P = s => $(`[data-demo="${s}"]`);

  // 1. captions: playhead runs, bars light, words appear one by one with the spoken one in turquoise
  {
    const el = P('cap'), words = $$('.capw span', el), bars = $$('.wavebox i', el), lab = $('.wlab', el);
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    tl.set(words, { opacity: 0, y: 8 }).set(bars, { backgroundColor: '#4a5056' }).set($('.wph', el), { left: 12 })
      .to($('.wph', el), { left: () => $('.wavebox', el).clientWidth - 14, duration: 4, ease: 'none', onUpdate() { lab.textContent = `00:0${(this.progress() * 4.2).toFixed(1)}`; } }, 0)
      .to(bars, { backgroundColor: '#5cd3c6', duration: 0.05, stagger: 4 / bars.length, ease: 'none' }, 0)
      .to($('.rec', el), { opacity: 0.2, duration: 0.5, yoyo: true, repeat: 7 }, 0);
    words.forEach((w, i) => {
      tl.to(w, { opacity: 1, y: 0, duration: 0.25, ease: 'back.out(3)' }, 0.3 + i * 0.9)
        .call(() => words.forEach((x, j) => x.classList.toggle('on', i === j)), null, 0.3 + i * 0.9);
    });
    tl.to(words, { opacity: 0, duration: 0.3 }, 4.5).call(() => words.forEach(x => x.classList.remove('on')), null, 4.8);
    loop(el, tl);
  }

  // 2. silences: the prompt types itself, gaps flash red, then collapse and the total drops
  {
    const el = P('sil'), gaps = $$('.gap', el), res = $('.sil-res', el), b = $('.sil-res b', el);
    const hidden = rtl() ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)';
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });
    tl.set($('.typed', el), { clipPath: hidden }).set(gaps, { flexGrow: (i, g) => g.style.getPropertyValue('--w'), opacity: 1, backgroundColor: 'rgba(255,255,255,.04)', borderColor: 'rgba(255,255,255,.18)' }).set(res, { autoAlpha: 0, y: 10 })
      .to($('.typed', el), { clipPath: 'inset(0 0 0 0)', duration: 1.2, ease: 'steps(22)' })
      .to($('.bub', el), { scale: 0.97, duration: 0.1, yoyo: true, repeat: 1 })
      .to(gaps, { backgroundColor: 'rgba(255,90,90,.2)', borderColor: 'rgba(255,120,120,.75)', duration: 0.2, stagger: 0.18 }, '+=0.2')
      .to(gaps, { flexGrow: 0, opacity: 0, duration: 0.6, ease: 'power3.inOut', stagger: 0.08 }, '+=0.4')
      .to(res, { autoAlpha: 1, y: 0, duration: 0.4 }, '-=0.2')
      .fromTo(b, { textContent: '0.0' }, { textContent: 9.4, duration: 0.8, snap: { textContent: 0.1 }, modifiers: { textContent: v => `−${(+v).toFixed(1)}s` } }, '<')
      .to({}, { duration: 1.6 });
    loop(el, tl);
  }

  // 3. timeline: playhead to the cut, scissors snap, the piece goes and the rest closes up
  {
    const el = P('tl'), ph = $('.mph', el), sc = $('.sc', el);
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8, defaults: { ease: 'power3.out' } });
    tl.set(ph, { left: '4%' }).set(sc, { scale: 0 }).set($('.c2b', el), { width: '16%', opacity: 1, scaleY: 1 })
      .set($('.tx', el), { y: -30, opacity: 0 }).set($$('.kf', el), { scale: 0 }).set($('kbd', el), { y: 0, backgroundColor: 'rgba(255,255,255,.08)' })
      .to(ph, { left: '47%', duration: 1.2, ease: 'power2.inOut' })
      .to(sc, { scale: 1, duration: 0.3, ease: 'back.out(3)' })
      .to($('kbd', el), { y: 2, backgroundColor: 'rgba(92,211,198,.4)', duration: 0.1, yoyo: true, repeat: 1 }, '<0.1')
      .to(sc, { rotate: -30, duration: 0.1, yoyo: true, repeat: 1 })
      .to($('.c2b', el), { scaleY: 0.2, opacity: 0, duration: 0.3 }, '+=0.2')
      .to($('.c2b', el), { width: 0, duration: 0.45, ease: 'power3.inOut' })
      .to(sc, { scale: 0, duration: 0.2 }, '<')
      .to($('.tx', el), { y: 0, opacity: 1, duration: 0.5, ease: 'bounce.out' }, '+=0.1')
      .to($$('.kf', el), { scale: 1, duration: 0.3, ease: 'back.out(3)', stagger: 0.15 })
      .to(ph, { left: '96%', duration: 2.2, ease: 'none' }, '+=0.2')
      .to($$('.kf, .tx', el), { opacity: 0, duration: 0.3 });
    loop(el, tl);
  }

  // 4. motion: the same words play four different in-animations; a dot rides the speed curve
  {
    const el = P('mo'), ws = $$('.mtext span', el), name = $('.aname', el);
    const tl = gsap.timeline({ repeat: -1 });
    const anim = (label, at, from, opts = {}) => tl.call(() => (name.textContent = label), null, at)
      .fromTo(ws, from, { x: 0, y: 0, scale: 1, rotationX: 0, opacity: 1, textShadow: '0 3px 16px rgba(0,0,0,.6)', duration: 0.7, stagger: 0.15, ease: 'back.out(2.5)', ...opts }, at)
      .to(ws, { opacity: 0, duration: 0.25 }, at + 1.7);
    anim('wordPop', 0, { scale: 0, opacity: 0 });
    anim('glitchIn', 2, { x: -14, opacity: 0, textShadow: '4px 0 #ff3d6e, -4px 0 #5cd3c6' }, { ease: 'steps(5)', duration: 0.5 });
    anim('bounceIn', 4, { y: -160, opacity: 0 }, { ease: 'bounce.out', duration: 0.9 });
    anim('flipIn', 6, { rotationX: -100, opacity: 0, transformOrigin: '50% 100%' }, { ease: 'power3.out' });
    tl.fromTo($('.cdot', el), { offsetDistance: '0%' }, { offsetDistance: '100%', duration: 2, ease: 'power2.inOut', repeat: 3, yoyo: true }, 0);
    tl.to({}, { duration: 0.2 }, 7.8);
    loop(el, tl);
  }

  // 5. effects: four real frames swap with four transitions while the filter list changes
  {
    const el = P('fx'), imgs = $$('.fxs img', el), name = $('.tname', el), chips = $$('.flt i', el);
    const F = ['none', 'saturate(1.35) hue-rotate(-12deg) contrast(1.1)', 'sepia(.35) saturate(1.5) brightness(1.05)', 'grayscale(1) contrast(1.35)'];
    const T = [['Iris', 'circle(0% at 50% 50%)', 'circle(75% at 50% 50%)'], ['Wipe', 'inset(0% 100% 0% 0%)', 'inset(0% 0% 0% 0%)'],
      ['Diagonal', 'polygon(0% 0%, 0% 0%, 0% 0%)', 'polygon(0% 0%, 220% 0%, 0% 220%)'], ['Split', 'inset(50% 0% 50% 0%)', 'inset(0% 0% 0% 0%)']];
    const tl = gsap.timeline({ repeat: -1 });
    tl.set(imgs, { clipPath: 'none', filter: 'none', zIndex: 0 }).set(imgs[0], { zIndex: 1 });
    T.forEach(([n, a, b], i) => {
      const img = imgs[(i + 1) % 4];
      tl.call(() => { name.textContent = n; chips.forEach((c, j) => c.classList.toggle('on', j === (i + 1) % 4)); }, null, i * 2 + 0.4)
        .set(img, { zIndex: i + 2, clipPath: a, filter: F[(i + 1) % 4] }, i * 2 + 0.4)
        .to(img, { clipPath: b, duration: 0.9, ease: 'power3.inOut' }, i * 2 + 0.4)
        .fromTo(name, { scale: 0.8 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' }, i * 2 + 0.4);
    });
    tl.to({}, { duration: 0.1 }, 8);
    loop(el, tl);
  }

  // 6. easy: drag a clip in, it fills the preview, then export runs to 100%
  {
    const el = P('easy'), cur = $('.cur', el), gh = $('.ghost', el), bar = $('.ez-bar', el);
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, defaults: { ease: 'power2.inOut' } });
    tl.set(cur, { left: '70%', top: '70%' }).set(gh, { left: '5%', top: '6%', opacity: 0, scale: 1 }).set($('.ez-drop', el), { width: 0 })
      .set($('.ez-pvi', el), { opacity: 0 }).set($('.sz', el), { opacity: 0 }).set(bar, { opacity: 0 }).set($('.ez-bar b', el), { scaleX: 0 })
      .to(cur, { left: '12%', top: '14%', duration: 0.8 })
      .to(cur, { scale: 0.85, duration: 0.1 })
      .to(gh, { opacity: 0.9, duration: 0.1 }, '<')
      .to([cur, gh], { left: (i) => (i ? '6%' : '12%'), top: (i) => (i ? '72%' : '80%'), duration: 0.9 })
      .to(cur, { scale: 1, duration: 0.1 })
      .to(gh, { opacity: 0, scale: 0.6, duration: 0.2 }, '<')
      .to($('.ez-drop', el), { width: '78%', duration: 0.6, ease: 'power3.out' }, '<')
      .to($('.ez-pvi', el), { opacity: 1, duration: 0.4 }, '<0.2')
      .to($('.sz', el), { opacity: 1, duration: 0.3, yoyo: true, repeat: 3 })
      .to(cur, { left: '90%', top: '2%', duration: 0.8 }, '<')
      .to($('.ez-exp', el), { scale: 0.92, duration: 0.1, yoyo: true, repeat: 1 })
      .to(bar, { opacity: 1, duration: 0.25 })
      .to($('.ez-bar b', el), { scaleX: 1, duration: 1.4, ease: 'power1.inOut' })
      .to(bar, { opacity: 0, duration: 0.3 }, '+=0.5');
    loop(el, tl);
  }

  // assistant chat in the Claude section
  {
    const el = $('.asst-ui'), parts = $$('.au-log > *', el);
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 2 });
    tl.set(parts, { autoAlpha: 0, y: 10 })
      .to(parts[0], { autoAlpha: 1, y: 0, duration: 0.4 }, 0.3)
      .to(parts.slice(1, -1), { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.45 }, '+=0.5')
      .to(parts.at(-1), { autoAlpha: 1, y: 0, duration: 0.4 }, '+=0.4')
      .to(parts, { autoAlpha: 0, duration: 0.3 }, '+=3');
    loop(el, tl);
  }

  // bento icons: each one acts out its feature
  const ic = {
    color: s => gsap.timeline({ repeat: -1 }).to($('.wheel', s), { rotation: 360, svgOrigin: '24 24', duration: 6, ease: 'none' }, 0).to($('.pk', s), { rotation: 360, svgOrigin: '24 24', duration: 3, ease: 'power1.inOut' }, 0),
    key: s => gsap.timeline({ repeat: -1, yoyo: true, repeatDelay: 0.6 }).to($('.gscr', s), { fill: '#2b7f77', duration: 0.6 }),
    cutout: s => gsap.timeline({ repeat: -1, yoyo: true }).fromTo($('.scan', s), { y: 0 }, { y: 30, duration: 1.4, ease: 'sine.inOut' }),
    slow: s => gsap.timeline({ repeat: -1 }).to($$('.d', s), { y: -10, duration: 0.6, ease: 'sine.inOut', yoyo: true, repeat: 1, stagger: 0.25 }),
    mic: s => gsap.timeline({ repeat: -1, yoyo: true }).to($$('.lv path', s), { opacity: 0.2, duration: 0.4, stagger: 0.12 }),
    track: s => gsap.timeline({ repeat: -1 }).to($('.tb', s), { keyframes: { x: [0, 16, 10, 0], y: [0, 4, 12, 0] }, duration: 3, ease: 'sine.inOut' }),
    safe: s => gsap.timeline({ repeat: -1, yoyo: true, repeatDelay: 0.5 }).to($('.zone', s), { opacity: 0.15, duration: 0.5 }).to($('.ui', s), { x: -2, duration: 0.5 }, 0),
    exp: s => gsap.timeline({ repeat: -1, repeatDelay: 0.5 }).fromTo($('.bar', s), { scaleX: 0 }, { scaleX: 1, duration: 1.6, ease: 'power1.inOut' }),
    font: s => { const t = $('.fa', s), f = ['Aa', 'عر', 'Bb', 'كـ']; const tl = gsap.timeline({ repeat: -1 }); f.forEach((x, i) => tl.call(() => (t.textContent = x), null, i * 0.9).fromTo(t, { scale: 0.6, opacity: 0, transformOrigin: '50% 60%' }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(3)' }, i * 0.9)); return tl.to({}, { duration: 0.1 }, 3.5); },
    upd: s => gsap.timeline({ repeat: -1, repeatDelay: 0.8 }).to($('.rot', s), { rotation: 360, svgOrigin: '24 24', duration: 1.2, ease: 'power3.inOut' }),
    save: s => gsap.timeline({ repeat: -1, repeatDelay: 1 }).fromTo($('.tick', s), { strokeDasharray: 24, strokeDashoffset: 24 }, { strokeDashoffset: 0, duration: 0.6, ease: 'power2.out' }),
    lock: s => gsap.timeline({ repeat: -1, repeatDelay: 1.4 }).to($('.shk', s), { y: -3, duration: 0.25, yoyo: true, repeat: 1, ease: 'power2.out' }),
  };
  $$('.fc').forEach(c => loop(c, ic[c.dataset.ic](c)));

  // number marquee
  {
    const el = $('.nums');
    const tl = gsap.timeline({ repeat: -1 }).fromTo('.mq-in', { xPercent: 0 }, { xPercent: rtl() ? 100 : -100, duration: 36, ease: 'none' });
    loop(el, tl);
  }
  // closing card: light runs down the grid lines
  loop($('.end'), gsap.timeline({ repeat: -1 }).fromTo('.end-bg i', { yPercent: -100 }, { yPercent: 100, duration: 3, ease: 'none', stagger: { each: 0.5, from: 'random', repeat: -1 } }));
  sync();
}

/* ---------- pause control for every loop and the hero clip ---------- */
const live = $('#live');
$('#pz').onclick = () => {
  paused = !paused;
  $('#pz').setAttribute('aria-pressed', paused);
  $('#pz use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  $('#pz span').textContent = paused ? T[lang].play : T[lang].pause;
  paused ? live.pause() : live.play().catch(() => {});
  sync();
};

$('#lang').onclick = () => {
  lang = lang === 'ar' ? 'en' : 'ar';
  try { localStorage.setItem('maqto.lang', lang); } catch (e) {}
  applyLang();
  buildLoops();
  $('#reel').scrollLeft = 0;
  ScrollTrigger.refresh();
};

$('.mq-in').after($('.mq-in').cloneNode(true));
$$('.mq-in')[1].setAttribute('aria-hidden', 'true');
applyLang();
buildLoops();
if (paused) { live.removeAttribute('autoplay'); live.pause(); $('#pz').setAttribute('aria-pressed', 'true'); $('#pz use').setAttribute('href', '#i-play'); $('#pz span').textContent = T[lang].play; }

/* ---------- hero clip drives the playhead and the timecode, like the real app ---------- */
{
  const ph = $('#lph'), tc = $('.tc');
  const pad = n => String(n).padStart(2, '0');
  gsap.ticker.add(() => {
    const t = 5 + (live.currentTime || 2.6); // the clip is seconds 5–16 of the exported project
    ph.style.left = `${8.8 + t * 3.193}%`; // the screenshot's timeline shows 0–28 s
    tc.textContent = `00:00:${pad(Math.floor(t))}:${pad(Math.floor((t % 1) * 30))}`;
  });
}

/* ---------- Lenis drives scroll, GSAP everything else, one loop ---------- */
// demos reel: arrows, mouse drag, arrows disabled at the ends
{
  const reel = $('#reel'), prev = $('#prev'), next = $('#next');
  const step = () => $('.panel').offsetWidth + 24;
  // RTL scrollLeft runs 0 → negative, so "forward" is left there
  const go = d => reel.scrollBy({ left: d * step() * (rtl() ? -1 : 1), behavior: 'smooth' });
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  const ends = () => {
    const x = Math.abs(reel.scrollLeft), max = reel.scrollWidth - reel.clientWidth;
    prev.disabled = x < 8; next.disabled = x > max - 8;
  };
  reel.addEventListener('scroll', ends, { passive: true });
  addEventListener('resize', ends); ends();
  let sx = 0, sl = 0, moved = false;
  reel.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button) return;
    sx = e.clientX; sl = reel.scrollLeft; moved = false;
    reel.classList.add('drag'); reel.setPointerCapture(e.pointerId);
  });
  reel.addEventListener('pointermove', e => {
    if (!reel.classList.contains('drag')) return;
    if (Math.abs(e.clientX - sx) > 4) moved = true;
    reel.scrollLeft = sl - (e.clientX - sx);
  });
  const up = () => {
    if (!reel.classList.contains('drag')) return;
    reel.classList.remove('drag'); // snap returns and settles on the nearest panel
  };
  reel.addEventListener('pointerup', up); reel.addEventListener('pointercancel', up);
  reel.addEventListener('click', e => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
}

const lenis = new Lenis({ lerp: 0.1 });
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add(t => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]'), id = a && a.getAttribute('href');
  const el = id && id.length > 1 && document.querySelector(id);
  if (!el) return;
  e.preventDefault();
  lenis.scrollTo(el, { offset: -80 });
  history.replaceState(null, '', id);
});

// Counters run once when the numbers come into view.
$$('.mq-in:first-child b[data-n]').forEach(b => {
  const twin = $$(`.mq-in b[data-n="${b.dataset.n}"]`);
  ScrollTrigger.create({ trigger: '.nums', start: 'top 90%', once: true, onEnter: () => motionOK && gsap.fromTo(twin, { textContent: 0 }, { textContent: +b.dataset.n, duration: 1.6, ease: 'power2.out', snap: { textContent: 1 } }) });
});

const mm = gsap.matchMedia();
mm.add({ motion: '(prefers-reduced-motion: no-preference)', wide: '(min-width: 1001px)' }, ctx => {
  const { motion } = ctx.conditions;
  if (!motion) return; // reduced motion: everything is visible and still

  // intro
  gsap.timeline({ defaults: { ease: 'power4.out' } })
    .from('.hero h1 .wi', { yPercent: 115, rotate: 4, duration: 1, stagger: 0.07 })
    .from('.hero .tag, .hero .lead, .hero .dlc', { y: 20, autoAlpha: 0, duration: 0.7, stagger: 0.08 }, '-=0.6')
    .from('.win', { y: 120, autoAlpha: 0, duration: 1.2 }, '-=0.7')
    .from('.float', { scale: 0.6, autoAlpha: 0, duration: 0.6, stagger: 0.12, ease: 'back.out(2)' }, '-=0.5');

  // the app window lies back, then stands up as you scroll to it
  gsap.to('.win', { rotateX: 0, scale: 1, ease: 'none', scrollTrigger: { trigger: '.show', start: 'top 85%', end: 'top 20%', scrub: true } });
  gsap.to('.f1', { y: -70, ease: 'none', scrollTrigger: { trigger: '.show', start: 'top bottom', end: 'bottom top', scrub: true } });
  gsap.to('.f2', { y: -140, ease: 'none', scrollTrigger: { trigger: '.show', start: 'top bottom', end: 'bottom top', scrub: true } });
  gsap.to('.f3', { y: -40, ease: 'none', scrollTrigger: { trigger: '.show', start: 'top bottom', end: 'bottom top', scrub: true } });

  // headings: words rise on enter
  $$('.sec h2.split, .demos h2.split').forEach(h => gsap.from(h.querySelectorAll('.wi'), { yPercent: 115, duration: 0.9, ease: 'power4.out', stagger: 0.06, scrollTrigger: { trigger: h, start: 'top 86%' } }));

  // demos: panels rise in; the reel itself scrolls sideways by swipe, drag or arrows
  gsap.from('.panel', { y: 60, autoAlpha: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, scrollTrigger: { trigger: '.pin', start: 'top 85%' } });

  // inside: the three real panels fan out from one stack
  gsap.from('.pan', { x: 0, y: 80, rotation: 0, ease: 'none', stagger: 0.05, scrollTrigger: { trigger: '.fan', start: 'top 85%', end: 'center 45%', scrub: true } });
  // cards in batches
  gsap.set('.grid .card, .os-grid .card, .faq details, .asst, .brw', { y: 30, autoAlpha: 0 });
  ScrollTrigger.batch('.grid .card, .os-grid .card, .faq details, .asst, .brw', {
    start: 'top 92%',
    onEnter: b => gsap.to(b, { y: 0, autoAlpha: 1, duration: 0.6, ease: 'power3.out', stagger: 0.07, overwrite: true }),
  });
  ScrollTrigger.addEventListener('scrollEnd', () => $$('.grid .card, .os-grid .card, .faq details, .asst, .brw').forEach(c => {
    const r = c.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0 && +getComputedStyle(c).opacity < 0.05) gsap.to(c, { y: 0, autoAlpha: 1, duration: 0.5 });
  }));

  // closing card: the mark spins in
  gsap.from('.end-mark', { rotation: -180, scale: 0, duration: 1, ease: 'back.out(1.8)', scrollTrigger: { trigger: '.end', start: 'top 80%' } });
});

window.addEventListener('load', () => ScrollTrigger.refresh());
document.fonts.ready.then(() => ScrollTrigger.refresh());

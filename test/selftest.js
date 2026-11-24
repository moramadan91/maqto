// node test/selftest.js — checks shared logic and runs a real export through ffmpeg.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('@ffprobe-installer/ffprobe').path;
const S = require('../src/shared');
const interchange = require('../src/interchange');
const WN = require('../src/whatsnew');
const vm = require('node:vm');
const { buildArgs, concatText, chapterMetadata, atempo, loudnormFilter, LOUDNESS_TARGETS, ENCODERS } = require('../src/graph');
const writeConcat = (d, list, fps) => { const f = path.join(d, 'text.ffconcat'); fs.writeFileSync(f, concatText(list, fps)); return f; };

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maqto-multicam-'));
  try {
    const binary = path.join(dir, process.platform === 'win32' ? 'sync.exe' : 'sync');
    execFileSync('rustc', ['--edition=2021', '--test', path.join(__dirname, '../src-tauri/src/multicam_sync.rs'), '-o', binary]);
    execFileSync(binary, { stdio: 'inherit' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const base = [{ t: 0, angle: 0 }, { t: 5, angle: 1 }];
  assert.strictEqual(S.recordCut(base, 2, 0), base);
  assert.deepStrictEqual(S.recordCut(base, 2, 1), [{ t: 0, angle: 0 }, { t: 2, angle: 1 }, { t: 5, angle: 1 }]);
  assert.deepStrictEqual(S.recordCut(base, 5, 0), [{ t: 0, angle: 0 }, { t: 5, angle: 0 }]);
  assert.deepStrictEqual(S.switchSegment(base, 6, 2), [{ t: 0, angle: 0 }, { t: 5, angle: 2 }]);
  assert.strictEqual(S.switchSegment(base, 4, 0), base);
  assert.deepStrictEqual(base, [{ t: 0, angle: 0 }, { t: 5, angle: 1 }]);

  const source = { angles: [{ media: 'left', offset: -1 }, { media: 'right', offset: 2, in: 1, out: 6 }], defaultAngle: 0, audioAngle: 0 };
  const clip = { id: 'switch', media: 'mc', track: 'v1', start: 10, in: 2, dur: 4, speed: 2, cuts: base };
  const media = { mc: source, left: { kind: 'video', dur: 12, hasAudio: true }, right: { kind: 'video', dur: 12 } };
  assert.deepStrictEqual(S.cutsToSegments(clip, source), [
    { a: 2, b: 5, angle: 0, index: 0 }, { a: 5, b: 10, angle: 1, index: 1 },
  ]);
  const { video, audio } = S.multicamClips(clip, source, media);
  const range = i => [i.media, i.start, i.in, i.in + S.srcLen(i), i.dur];
  assert.deepStrictEqual(video.map(range), [['left', 10, 3, 6, 1.5], ['right', 11.5, 3, 6, 1.5]]);
  assert.ok(video.every(i => i.muted && !i.cuts));
  assert.deepStrictEqual(range(audio), ['left', 10, 3, 11, 4]);
  assert.ok(audio.audioOnly && !audio.muted);
  assert.strictEqual(S.projectDur(S.expandMulticam({ media, items: [clip] })), 14);
  assert.strictEqual(S.projectDur(S.expandMulticam({ media: { ...media, mc: { ...source, audioAngle: null } }, items: [clip] })), 14);
  console.log('Multicam cut and source range assertions passed');
}

{
  const { frameTime, framesAt, seconds, edlTimecode, exportTimeline, importOTIO } = interchange;
  for (const [fps, frame] of [[24, '1/24s'], [25, '1/25s'], [29.97, '1001/30000s'], [30, '1/30s'], [60, '1/60s']]) {
    assert.strictEqual(frameTime(1, fps), frame);
    assert.strictEqual(framesAt(seconds(frameTime(1801, fps)), fps), 1801);
    assert.strictEqual(frameTime(0, fps), '0s');
  }
  assert.strictEqual(edlTimecode(24 * 3600 + 25, 24), '01:00:01:01');
  assert.strictEqual(edlTimecode(1798, 29.97), '00:00:59:28');
  assert.strictEqual(edlTimecode(1800, 29.97), '00:01:00:00');

  const project = {
    name: 'Cut & review', fps: 25, w: 1920, h: 1080,
    tracks: [{ id: 'v2', kind: 'video' }, { id: 'v1', kind: 'video' }],
    media: {
      main: { kind: 'video', path: '/Media/Interview long.mov', name: 'Interview & camera', dur: 20, fps: 25, hasAudio: true, audioChannels: 2 },
      insert: { kind: 'video', path: '/Media/لقطة #1.mov', name: 'Cutaway', dur: 12, fps: 25, hasAudio: false },
    },
    items: [
      { id: 'main', media: 'main', track: 'v1', start: 1, in: 5, dur: 4, volume: 0.5 },
      { id: 'insert', media: 'insert', track: 'v2', start: 2, in: 0.4, dur: 1, speed: 2, trans: { id: 'fade', dur: 0.2 } },
      { id: 'last', media: 'main', track: 'v1', start: 6, in: 12, dur: 2, muted: true },
      { id: 'title', type: 'text', track: 't1', text: 'Opening title', start: 0, dur: 1 },
    ],
    markers: [{ time: 2.5, name: 'Check', note: 'Take 2', color: 'green' }],
  };
  const fcp = exportTimeline(project, 'fcpxml');
  assert.ok(fcp.text.includes('<fcpxml version="1.10">'));
  assert.ok(fcp.text.includes('name="Interview &amp; camera" ref="a1" offset="1s" start="5s" duration="4s"'));
  assert.ok(fcp.text.includes('name="Cutaway" ref="a2" offset="6s" start="10/25s" duration="1s" lane="1"'));
  assert.ok(fcp.text.includes('offset="6s" start="12s" duration="2s"'));
  assert.ok(fcp.text.includes('<gap offset="5s" start="0s" duration="1s">'));
  assert.ok(fcp.text.includes('src="file:///Media/Interview%20long.mov"'));
  assert.ok(fcp.text.includes('<adjust-volume amount="-6.020600dB"/>'));
  assert.ok(fcp.text.includes('<timeMap><timept time="10/25s" value="10/25s" interp="linear"/>'));
  assert.ok(fcp.text.includes('value="Check" note="Take 2"'));
  assert.deepStrictEqual(fcp.warnings.titles, ['Opening title']);
  assert.deepStrictEqual(fcp.warnings.transitions, ['Cutaway']);

  const edl = exportTimeline(project, 'edl');
  assert.ok(edl.text.includes('FCM: NON-DROP FRAME'));
  assert.ok(edl.text.includes('001  INTERVIE AA/V C        00:00:05:00 00:00:09:00 00:00:01:00 00:00:05:00'));
  assert.ok(edl.text.includes('* FROM CLIP NAME: Interview long.mov'));
  assert.ok(edl.text.includes('002  INTERVIE V    C'));
  assert.deepStrictEqual(edl.warnings.tracks, ['Cutaway']);
  const mono = { ...project, media: { ...project.media, main: { ...project.media.main, audioChannels: 1 } } };
  assert.ok(exportTimeline(mono, 'edl').text.includes('001  INTERVIE B    C'));

  const otio = exportTimeline(project, 'otio');
  const otioJSON = JSON.parse(otio.text);
  const imported = importOTIO(otioJSON, '/Media/edit.otio').project;
  const timings = (p, clips) => clips.map(({ media, track, start, in: source, dur }) => [p.media[media].path, track, start, source, dur])
    .sort((a, b) => a[2] - b[2]);
  assert.deepStrictEqual(timings(imported, imported.items), timings(project, project.items.filter(it => it.media)));
  assert.deepStrictEqual(imported.markers, project.markers);
  assert.strictEqual(imported.items.find(it => it.start === 6).muted, true);
  assert.deepStrictEqual(otio.warnings.speed, ['Cutaway']);
  const videoTrack = otioJSON.tracks.children[0];
  const firstClip = videoTrack.children.find(it => it.OTIO_SCHEMA === 'Clip.2');
  const reference = firstClip.media_references.DEFAULT_MEDIA;
  videoTrack.children = [firstClip];
  firstClip.OTIO_SCHEMA = 'Clip.1';
  firstClip.media_reference = { ...reference, target_url: 'Interview%20long.mov' };
  assert.strictEqual(Object.values(importOTIO(otioJSON, '/Media/edit.otio').project.media)[0].path, '/Media/Interview long.mov');
  console.log('Timeline interchange assertions passed');
}

// Run the desktop-only picker helpers without booting the editor or the Tauri bridge.
{
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const helper = (start, end, expression) => vm.runInThisContext(app.slice(app.indexOf(start), app.indexOf(end)) + '\n' + expression);
  const range = helper('const FONT_ROW_HEIGHT', 'let fontTab', 'fontPickerRange');
  assert.deepStrictEqual(range(0, 0, 300, 5), [0, 0]);
  assert.deepStrictEqual(range(3000, 0, 280, 5), [0, 15]);
  assert.deepStrictEqual(range(3000, 281, 280, 5), [5, 26]);
  assert.deepStrictEqual(range(3000, 281, 280), [10, 21]);
  assert.deepStrictEqual(range(3000, 2990 * 28, 280, 5), [2985, 3000]);

  const unpack = helper('function unpackFontFace', 'const collectionReads', 'unpackFontFace');
  const collection = new DataView(new ArrayBuffer(100));
  collection.setUint32(0, 0x74746366); // ttcf
  collection.setUint32(4, 0x00010000);
  collection.setUint32(8, 2);
  for (const [index, faceOffset, tableOffset] of [[0, 20, 76], [1, 48, 88]]) {
    collection.setUint32(12 + index * 4, faceOffset);
    collection.setUint32(faceOffset, 0x00010000);
    collection.setUint16(faceOffset + 4, 1);
    collection.setUint32(faceOffset + 12, 0x68656164); // head
    collection.setUint32(faceOffset + 20, tableOffset);
    collection.setUint32(faceOffset + 24, 12);
    collection.setUint32(tableOffset, index + 1);
  }
  const face = new DataView(unpack(collection.buffer, 1).buffer);
  assert.strictEqual(face.getUint32(20), 28);
  assert.strictEqual(face.getUint32(28), 2);
  let checksum = 0;
  for (let i = 0; i < face.byteLength; i += 4) checksum = (checksum + face.getUint32(i)) >>> 0;
  assert.strictEqual(checksum, 0xb1b0afba);
  assert.throws(() => unpack(collection.buffer, 2), /Invalid font collection/);
  console.log('Font picker assertions passed');
}

// shared logic
{
  const raw = [[0, 0.5, 0.5], [0.25, 0.57, 0.43], [0.5, 1, 0], [0.75, 0, 1, true], [1, 0.06, 0.95]];
  const smooth = S.smoothPath(raw, { maxSpeed: 0.2 });
  assert.deepStrictEqual(smooth[1].slice(1, 3), [0.5, 0.5]);
  assert.deepStrictEqual(smooth[2].slice(1, 3), [0.55, 0.45]);
  assert.deepStrictEqual(smooth[3], raw[3]);
  assert.deepStrictEqual(smooth[4].slice(1, 3), [0, 1]);
  assert.ok(S.smoothPath([[0, 0.5, 0.5], [0.25, 0.55, 0.5]], { frame: [0.3, 1] })[1][1] > 0.5);

  const dense = Array.from({ length: 9 }, (_, i) => [i / 4, i / 10, 0.5]);
  assert.deepStrictEqual(S.thinKeys(dense).map(q => q[0]), [0, 0.5, 1, 1.5, 2]);
  assert.deepStrictEqual(S.thinKeys([[0, 0.5, 0.5], [0.6, 0.501, 0.5], [0.7, 0.9, 0.5, true]]).map(q => q[0]), [0, 0.7]);
  const still = Array.from({ length: 9 }, (_, i) => [i / 4, i < 8 ? 0.5 : 0.9, 0.5]);
  assert.deepStrictEqual(S.thinKeys(still).map(q => q[0]), [0, 1.5, 2]);

  const centres = [[0, 0, 0], [0.5, 0.5, 0.5], [0.75, 1, 1, true]];
  const keys = S.cropKeyframes(centres, 1920, 1080, 1080, 1920);
  const it = { fit: 'contain', kf: keys };
  const layoutAt = t => S.layout(S.animAt(it, t), { w: 1920, h: 1080 }, 1080, 1920);
  const left = layoutAt(0), right = layoutAt(0.75);
  assert.strictEqual(keys.scale[0][1], (1920 / 1080) / (1080 / 1920));
  assert.strictEqual(left.ox, 0);
  assert.strictEqual(right.ox + right.cw, 1080);
  assert.deepStrictEqual(layoutAt(0.749), layoutAt(0.5));
  for (const time of [0, 0.25, 0.5, 0.74, 0.75, 1]) {
    const L = layoutAt(time);
    assert.ok(L.ox <= 0 && L.ox + L.cw >= 1080 && L.oy === 0 && L.ch === 1920);
  }
  const vertical = S.cropKeyframes(centres, 1080, 1920, 1920, 1080);
  assert.strictEqual(vertical.x[0][1], 0);
  assert.strictEqual(vertical.y[0][1], left.cw / 2 - 540);
  assert.strictEqual(vertical.y.at(-1)[1], 540 - left.cw / 2);
  const baked = S.bakeVa({ ...it, dur: 1, anim: 'fade' }, 1080, 1920);
  assert.ok(baked.kf.x.some(q => q[0] === 0.75 && q[2] === 'cut'));
  const trimmed = { ...it, kf: structuredClone(keys), dur: 1, anim: 'fade' };
  S.shiftTimes(trimmed, 1);
  assert.strictEqual(S.bakeVa(trimmed, 1080, 1920).x, keys.x.at(-1)[1]);
  console.log('Smart reframe assertions passed');
}
assert.strictEqual(S.normalizeKey({ code: 'KeyK', key: 'ن', metaKey: true, shiftKey: true }, true), 'Mod+Shift+K');
assert.strictEqual(S.normalizeKey({ code: 'Digit0', key: '٠', ctrlKey: true }, false), 'Mod+0');
assert.strictEqual(S.normalizeKey({ code: 'KeyK', ctrlKey: true }, true), 'Ctrl+K');
assert.strictEqual(S.normalizeKey({ code: 'Backspace' }, true), 'Delete');
assert.strictEqual(S.normalizeKey({ code: 'Comma', metaKey: true }, true), 'Mod+,');
assert.strictEqual(S.normalizeKey({ code: 'ShiftLeft', shiftKey: true }, false), '');
assert.strictEqual(S.normalizeKey({ code: 'KeyK', isComposing: true }, false), '');
assert.strictEqual(S.normalizeKey({ code: 'KeyK', getModifierState: m => m === 'AltGraph' }, false), '');
{
  const m = new Map([['Mod+S', 'a'], ['Mod+Alt+K', 'b'], ['Ctrl+Q', 'c']]);
  assert.strictEqual(S.lookupKey(m, 'Ctrl+S', true), 'a');
  assert.strictEqual(S.lookupKey(m, 'Ctrl+Alt+K', true), 'b');
  assert.strictEqual(S.lookupKey(m, 'Ctrl+Q', true), 'c');
  assert.strictEqual(S.lookupKey(m, 'Ctrl+S', false), undefined);
}
assert.strictEqual(S.validShortcut('Mod+Shift+K'), true);
assert.strictEqual(S.validShortcut('Shift+Mod+K'), false);
const shortcutCommands = { split: { default: ['C', 'Mod+B'] }, blade: { default: ['B'] }, select: { default: ['V'] } };
const premiereKeys = { blade: ['C'], split: ['Mod+K'], missing: ['I'] };
const mergedKeys = S.mergeKeymap(shortcutCommands, premiereKeys);
assert.deepStrictEqual(mergedKeys, { blade: ['C'], split: ['Mod+K'], select: ['V'] });
assert.deepStrictEqual(S.mergeKeymap(shortcutCommands, { blade: ['C'] }), { blade: ['C'], split: ['Mod+B'], select: ['V'] });
assert.deepStrictEqual(S.mergeKeymap(shortcutCommands, premiereKeys, { select: ['C'], split: [] }),
  { select: ['C'], split: [], blade: [] });
assert.strictEqual(S.shortcutConflict(mergedKeys, 'split', 'C'), 'blade');
assert.strictEqual(S.shortcutConflict(mergedKeys, 'blade', 'C'), undefined);
assert.strictEqual(S.shortcutConflict(mergedKeys, 'split', 'B'), undefined);
assert.deepStrictEqual(shortcutCommands.split.default, ['C', 'Mod+B']);
console.log('Keyboard shortcut assertions passed');

{
  const a = { id: 'a', start: 2, dur: 4, in: 2, speed: 2, mediaDur: 14 };
  const b = { id: 'b', start: 6, dur: 3, in: 3, speed: 0.5, mediaDur: 5, kf: { volume: [[2, 0.8]] } };
  const c = { id: 'c', start: 9, dur: 3, in: 1, mediaDur: 8 };
  const title = { id: 'title', start: 14, dur: 2 };
  const row = [b, title, c, a];
  const sourceDuration = clip => clip.mediaDur ?? Infinity;
  const min = 0.25;
  const timing = ({ clips }, id) => { const clip = clips.find(c => c.id === id); return [clip.start, clip.dur, clip.in]; };

  let edit = S.rollEdit(row, 'a', 'out', 10, sourceDuration, min);
  assert.strictEqual(edit.delta, 2);
  assert.deepStrictEqual(timing(edit, 'a'), [2, 6, 2]);
  assert.deepStrictEqual(timing(edit, 'b'), [8, 1, 4]);
  assert.deepStrictEqual(edit.clips[0].kf.volume, [[0, 0.8]]);
  edit = S.rollEdit(row, 'b', 'in', -10, sourceDuration, min);
  assert.strictEqual(edit.delta, -3.75);
  assert.deepStrictEqual(timing(edit, 'a'), [2, 0.25, 2]);
  assert.deepStrictEqual(timing(edit, 'b'), [2.25, 6.75, 1.125]);
  assert.strictEqual(S.rollEdit(row, 'c', 'out', 1, sourceDuration, min).clips, row);

  edit = S.slipClip(row, 'a', 10, sourceDuration);
  assert.strictEqual(edit.delta, 2);
  assert.deepStrictEqual(timing(edit, 'a'), [2, 4, 6]);
  edit = S.slipClip(row, 'b', -10, sourceDuration);
  assert.strictEqual(edit.delta, -6);
  assert.deepStrictEqual(timing(edit, 'b'), [6, 3, 0]);
  assert.strictEqual(edit.clips[0].kf, b.kf);
  assert.strictEqual(S.slipClip(row, 'title', 1, sourceDuration).clips, row);

  edit = S.slideClip(row, 'b', 10, sourceDuration, min);
  assert.strictEqual(edit.delta, 2);
  assert.deepStrictEqual(timing(edit, 'a'), [2, 6, 2]);
  assert.deepStrictEqual(timing(edit, 'b'), [8, 3, 3]);
  assert.deepStrictEqual(timing(edit, 'c'), [11, 1, 3]);
  edit = S.slideClip(row, 'b', -10, sourceDuration, min);
  assert.strictEqual(edit.delta, -1);
  assert.deepStrictEqual(timing(edit, 'a'), [2, 3, 2]);
  assert.deepStrictEqual(timing(edit, 'b'), [5, 3, 3]);
  assert.deepStrictEqual(timing(edit, 'c'), [8, 4, 0]);
  assert.strictEqual(S.slideClip(row, 'c', 1, sourceDuration, min).clips, row);

  edit = S.rippleTrim(row, 'b', 'in', -10, sourceDuration, min);
  assert.strictEqual(edit.delta, -6);
  assert.deepStrictEqual(timing(edit, 'b'), [6, 9, 0]);
  assert.deepStrictEqual(timing(edit, 'c'), [15, 3, 1]);
  assert.deepStrictEqual(timing(edit, 'title'), [20, 2, undefined]);
  assert.strictEqual(edit.clips[3], a);
  edit = S.rippleTrim(row, 'b', 'out', 10, sourceDuration, min);
  assert.strictEqual(edit.delta, 1);
  assert.deepStrictEqual(timing(edit, 'b'), [6, 4, 3]);
  assert.deepStrictEqual(timing(edit, 'c'), [10, 3, 1]);
  assert.deepStrictEqual(timing(edit, 'title'), [15, 2, undefined]);
  edit = S.rippleTrim(row, 'b', 'out', -10, sourceDuration, min);
  assert.strictEqual(edit.delta, -2.75);
  assert.deepStrictEqual(timing(edit, 'c'), [6.25, 3, 1]);
  const obstacle = { id: 'fixed', start: 13, dur: 0.5, fixed: true };
  edit = S.rippleTrim([...row, obstacle], 'b', 'in', 10, sourceDuration, min);
  assert.strictEqual(edit.delta, 0.5);
  assert.deepStrictEqual(timing(edit, 'b'), [6, 2.5, 3.25]);
  assert.deepStrictEqual(timing(edit, 'title'), [13.5, 2, undefined]);
  assert.strictEqual(edit.clips[4], obstacle);

  const curved = { ...a, curve: { id: 'custom', pts: [[0, 2], [1, 2]], src: 8 } };
  assert.strictEqual(S.slipClip([curved], 'a', 1, sourceDuration).clips[0], curved);
  assert.strictEqual(S.rippleTrim([curved], 'a', 'out', 1, sourceDuration, min).clips[0], curved);
  edit = S.rippleTrim([curved, b], 'a', 'in', 1, sourceDuration, min);
  assert.deepStrictEqual(timing(edit, 'a').slice(0, 2), [2, 3]);
  assert.ok(Math.abs(edit.clips[0].in - 4) < 1e-9);
  assert.strictEqual(edit.clips[0].curve.src, 6);
  edit = S.rollEdit([curved, b], 'a', 'out', -1, sourceDuration, min);
  assert.strictEqual(edit.clips[0].curve.src, 6);
  assert.deepStrictEqual(timing(edit, 'b'), [5, 4, 2.5]);

  const audio = { ...b, start: 7 };
  const next = { ...c, start: 10.5 };
  edit = S.trimAudioEdge([a, audio, next], 'b', 'in', -10, sourceDuration, min);
  assert.deepStrictEqual(timing(edit, 'b'), [6, 4, 2.5]);
  edit = S.trimAudioEdge([a, audio, next], 'b', 'out', 10, sourceDuration, min);
  assert.deepStrictEqual(timing(edit, 'b'), [7, 3.5, 3]);
  assert.strictEqual(edit.clips[0], a);
  assert.strictEqual(edit.clips[2], next);
  assert.deepStrictEqual(timing({ clips: row }, 'b'), [6, 3, 3]);
  assert.deepStrictEqual(b.kf.volume, [[2, 0.8]]);
}
console.log('Pro trim assertions passed');

const exportPresets = S.SOCIAL_EXPORT_PRESETS;
const presetProject = { w: 1920, h: 1080, fps: 25 };
assert.deepStrictEqual(S.exportPresetSettings(exportPresets.youtube1080, presetProject, ENCODERS), {
  settings: { video: true, audio: false, format: 'mp4', afmt: 'mp3', quality: 'high', res: 1080, fps: 25, loudnessTarget: -14, chapters: true, codec: 'h264' },
  aspectHint: '',
});
assert.strictEqual(S.exportPresetSettings(exportPresets.youtube4k, presetProject, ENCODERS).settings.codec, 'hevc');
assert.strictEqual(S.exportPresetSettings(exportPresets.youtube4k, presetProject, { h264: ENCODERS.h264 }).settings.codec, 'h264');
assert.strictEqual(S.exportPresetSettings(exportPresets.youtube4k, presetProject, ENCODERS).settings.res, 2160);
assert.strictEqual(S.exportPresetSettings(exportPresets.youtube4k, presetProject, ENCODERS).settings.hw, false);
assert.strictEqual(S.exportPresetSettings(exportPresets.shorts, presetProject, ENCODERS).aspectHint, '9:16');
const shorts = S.exportPresetSettings(exportPresets.shorts, { w: 1080, h: 1920, fps: 29.97 }, ENCODERS);
assert.deepStrictEqual([shorts.settings.res, shorts.settings.fps, shorts.settings.codec, shorts.settings.loudnessTarget, shorts.aspectHint], [1080, 29.97, 'h264', -14, '']);
assert.strictEqual(S.exportPresetSettings(exportPresets.instagram, { w: 1080, h: 1350, fps: 30 }, ENCODERS).aspectHint, '');
const podcast = S.exportPresetSettings(exportPresets.podcast, presetProject, ENCODERS);
assert.deepStrictEqual([podcast.settings.video, podcast.settings.audio, podcast.settings.loudnessTarget, podcast.aspectHint], [false, true, -16, '']);
assert.strictEqual(S.exportPresetSettings(exportPresets.master, presetProject, ENCODERS).settings.format, 'mov');
const savedPreset = { ...podcast.settings, afmt: 'wav', loudnessTarget: -23 };
assert.deepStrictEqual(S.exportPresetSettings(savedPreset, { ...presetProject, fps: 60 }, ENCODERS).settings, savedPreset);

const queueSource = { ...presetProject, items: [{ id: 'title', style: { size: 48 } }], media: { v: { path: '/video.mp4' } },
  markers: [{ time: 1, name: 'Intro' }], loudnessTarget: -14 };
const queueSettings = { loudnessTarget: -16, extra: { quality: 'high' } };
const queuePaths = { video: '/draft.mp4', audio: '/draft.mp3' };
const queuedExport = S.snapshotExport(queueSource, queueSettings, queuePaths);
queueSource.items[0].style.size = 72;
queueSource.media.v.path = '/new.mp4';
queueSource.markers[0].name = 'Edited';
queueSource.loudnessTarget = -23;
queueSettings.extra.quality = 'low';
queuePaths.video = '/new-draft.mp4';
assert.strictEqual(queuedExport.project.items[0].style.size, 48);
assert.strictEqual(queuedExport.project.media.v.path, '/video.mp4');
assert.strictEqual(queuedExport.project.markers[0].name, 'Intro');
assert.strictEqual(queuedExport.project.loudnessTarget, -14);
assert.deepStrictEqual(queuedExport.settings, { loudnessTarget: -16, extra: { quality: 'high' } });
assert.deepStrictEqual(queuedExport.paths, { video: '/draft.mp4', audio: '/draft.mp3' });
console.log('Export preset and queue snapshot assertions passed');

assert.deepStrictEqual(S.normalizeMarkers([12.5, { time: 0, name: 'Start', note: 'One\nTwo', color: 'red' }]), [
  { time: 0, name: 'Start', note: 'One\nTwo', color: 'red' },
  { time: 12.5, name: '', note: '', color: 'accent' },
]);
assert.deepStrictEqual(S.youtubeChapters([{ time: 83.4, name: 'Last' }, { time: 12, name: 'First\nsection' }], 100), {
  text: '0:00 Intro\n0:12 First section\n1:23 Last', valid: true,
});
assert.deepStrictEqual(S.youtubeChapters([20, { time: 0, name: 'Start' }, 10], 3600), {
  text: '0:00:00 Start\n0:00:10 Marker\n0:00:20 Marker', valid: true,
});
assert.deepStrictEqual(S.youtubeChapters([], 600, 'المقدمة'), { text: '0:00 المقدمة', valid: false });
assert.strictEqual(S.youtubeChapters([9, 20], 31).valid, false);
assert.strictEqual(S.youtubeChapters([10, 20], 29.99).valid, false);
assert.strictEqual(S.youtubeChapters([10, 20, 31], 30).valid, false);
assert.strictEqual(chapterMetadata([{ time: 2.5, name: 'A=B; #1\\' }, { time: 0, name: 'Start' }, 6], 6),
  ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2500\ntitle=Start\n'
  + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=2500\nEND=6000\ntitle=A\\=B\\; \\#1\\\\\0\n');
assert.strictEqual(chapterMetadata([2], 6),
  ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Intro\n'
  + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=6000\ntitle=Marker\n');
assert.strictEqual(chapterMetadata([6], 6), '');
assert.strictEqual(S.groupSpan([]), null);
assert.deepStrictEqual(S.groupSpan([{ start: 6, dur: 2 }]), { start: 6, dur: 2 });
assert.deepStrictEqual(S.groupSpan([{ start: 8, dur: 1 }, { start: 2, dur: 2 }, { start: 4, dur: 7 }]), { start: 2, dur: 9 });
assert.deepStrictEqual(atempo(1), []);
assert.deepStrictEqual(atempo(4), ['atempo=2', 'atempo=2']);
assert.deepStrictEqual(atempo(0.25), ['atempo=0.5', 'atempo=0.5']);
assert.strictEqual(loudnormFilter(0), '');
assert.strictEqual(loudnormFilter(-14), 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json');
assert.strictEqual(loudnormFilter(-16, {
  input_i: '-23.04', input_tp: '-21.07', input_lra: '5.00', input_thresh: '-33.04', target_offset: '-1.91',
}), 'loudnorm=I=-16:TP=-1:LRA=11:measured_I=-23.04:measured_TP=-21.07:measured_LRA=5:measured_thresh=-33.04:offset=-1.91:linear=true');
assert.strictEqual(loudnormFilter(-23, { input_i: '-inf' }), '');
const duckGain = 10 ** (-12 / 20);
assert.deepStrictEqual(S.duckGainKeys([[2, 3], [1, 1.7], [5, 6]], 7), [
  [0.85, 1], [1, duckGain], [3, duckGain], [3.4, 1],
  [4.85, 1], [5, duckGain], [6, duckGain], [6.4, 1],
]);
const customGain = 10 ** (-6 / 20);
assert.deepStrictEqual(S.duckGainKeys([[-1, 2], [3, 8]], 5, { amount: -6, attack: 0.25, release: 0.5 }), [
  [0, customGain], [2, customGain], [2.5, 1], [2.75, 1], [3, customGain], [5, customGain],
]);
assert.deepStrictEqual(S.duckGainKeys([[-2, -1], [6, 7]], 5), []);
const edgeKeys = S.duckGainKeys([[1, 2]], 1.5, { attack: 2 });
assert.strictEqual(edgeKeys[0][0], 0);
assert.ok(Math.abs(edgeKeys[0][1] - (1 + duckGain) / 2) < 1e-10);
assert.deepStrictEqual(S.speechTimelineRegions({ start: 10, in: 2, dur: 2, speed: 2 }, [[0, 1], [1, 4], [5, 7]]), [[10, 11], [11.5, 12]]);
const curvedSpeech = { start: 10, in: 2, dur: 3, curve: { src: 4, pts: [[0, 0.5], [1, 2]] } };
assert.deepStrictEqual(S.speechTimelineRegions(curvedSpeech, [[1, 3], [5, 7]]), [
  [10, 10 + S.ltAt(curvedSpeech, 1)], [10 + S.ltAt(curvedSpeech, 3), 13],
]);
const manualVolume = [0, 0.8], duckClip = { kf: { volume: [manualVolume] } };
assert.strictEqual(S.writeDuckKeys(duckClip, S.duckGainKeys([[1, 2]], 3)), 4);
assert.strictEqual(S.volumeAt(duckClip, 1.5), 0.8 * duckGain);
S.shiftTimes(duckClip, 0.5);
assert.strictEqual(duckClip.kf.volume[1][2], 'duck');
S.writeDuckKeys(duckClip, S.duckGainKeys([[2, 3]], 4));
assert.strictEqual(duckClip.kf.volume.length, 5);
S.writeDuckKeys(duckClip, []);
assert.deepStrictEqual(duckClip.kf.volume, [[-0.5, 0.8]]);
const sharedTime = { kf: { volume: [[1, 0.65]] } };
S.writeDuckKeys(sharedTime, S.duckGainKeys([[1, 2]], 3));
assert.deepStrictEqual(sharedTime.kf.volume.filter(q => q[0] === 1), [[1, 0.65]]);
console.log('Ducking assertions passed');
assert.ok(S.grade({}).identity);
assert.strictEqual(S.trVal('-2*-3+(1-4)/2+mod(7,3)', 0), 5.5); // transition formula evaluator (no eval under the CSP)
assert.ok(!S.grade({ preset: 'warm' }).identity);
const L = S.layout({ fit: 'cover' }, { w: 1920, h: 1080 }, 1080, 1920);
assert.strictEqual(L.cw, 1080); assert.strictEqual(L.ch, 1920); assert.strictEqual(L.ox, 0);
const C = S.layout({ fit: 'contain' }, { w: 1920, h: 1080 }, 1080, 1920);
assert.strictEqual(C.cw, 1080); assert.strictEqual(C.ch, 608); assert.strictEqual(C.oy, 656);
const words = S.parseWhisper({ transcription: [
  { text: ' السلام', offsets: { from: 0, to: 400 } }, { text: ' عليكم', offsets: { from: 400, to: 800 } },
  { text: '،', offsets: { from: 800, to: 850 } }, { text: ' [موسيقى]', offsets: { from: 900, to: 1000 } },
  { text: ' كيف', offsets: { from: 2000, to: 2300 } }, { text: ' حالكم', offsets: { from: 2300, to: 2700 } },
] });
assert.deepStrictEqual(words.map(w => w.w), ['السلام', 'عليكم،', 'كيف', 'حالكم']);
const groups = S.groupWords(words);
assert.deepStrictEqual(groups.map(g => g.text), ['السلام عليكم،', 'كيف حالكم']);

assert.strictEqual(S.normalizeArabic('إِمْـم، أَهْ آه ٱيه ا\u0654ه'), 'امم، اه اه ايه اه');
assert.deepStrictEqual(S.wordsToRanges([{ s: 3, e: 4 }, { s: 1, e: 2 }, { s: 2, e: 2.5 }], 0.25, 1, 4), [[1, 4]]);
assert.deepStrictEqual(S.wordsToRanges([{ s: 0.1, e: 0.2 }, { s: 0.6, e: 0.7 }]), [[0.1, 0.2], [0.6, 0.7]]);
assert.deepStrictEqual(S.silencesToCuts([[0, 1], [2, 2.25], [3, 4], [5, 7]], 0, 6, 0.5, 0.125),
  [[0, 0.875], [3.125, 3.875], [5.125, 6]]);
assert.deepStrictEqual(S.silencesToCuts([[0, 6]], 1, 5), [[1, 5]]);
assert.deepStrictEqual(S.silencesToCuts([[1, 1.5]], 0, 3, 0.5, 0.25), []);
const fastClip = { id: 'cut-fast', start: 0, in: 2, dur: 4, speed: 2, transcript: [{ s: 2.2, e: 2.8, w: 'قبل' }, { s: 4, e: 6, w: 'يعني' }, { s: 7, e: 8, w: 'بعد' }],
  kf: { volume: [[3, 1]] } };
const nextClip = { id: 'cut-next', start: 4, in: 0, dur: 2 };
const cutInput = [fastClip, nextClip];
const portions = S.cutRanges(cutInput, [[1, 2], [3.98, 3.99]], 1 / 30, () => 20);
assert.deepStrictEqual(portions.map(c => [c.start, c.in, c.dur]), [[0, 2, 1], [1, 6, 1.98], [2.98, 0, 2]]);
assert.deepStrictEqual(portions[0].transcript.map(w => w.w), ['قبل']);
assert.deepStrictEqual(portions[1].transcript.map(w => w.w), ['بعد']);
assert.strictEqual(fastClip.transcript.length, 3);
assert.deepStrictEqual(portions[1].kf.volume, [[1, 1]]);
assert.deepStrictEqual(fastClip.kf.volume, [[3, 1]]);
assert.strictEqual(S.cutRanges(cutInput, [[10, 11]], 1 / 30), cutInput);
const barrier = { id: 'compound', start: 5, dur: 2, fixed: true };
const afterBarrier = { id: 'after', start: 7, dur: 1 };
assert.deepStrictEqual(S.cutRanges([fastClip, barrier, afterBarrier], [[0, 2, fastClip.id]], 1 / 30, () => 20)
  .map(c => [c.id, c.start, c.dur]), [[fastClip.id, 0, 2], ['compound', 5, 2], ['after', 7, 1]]);
const curvedCut = { id: 'curved-cut', start: 1, in: 2, dur: 4, curve: { pts: [[0, 0.5], [1, 2]], src: 5 } };
const curvedPieces = S.cutRanges([curvedCut], [[2, 3]], 1 / 30, () => 20);
assert.ok(Math.abs(curvedPieces[1].in - (2 + S.srcAt(curvedCut, 2))) < 1e-6);
assert.ok(Math.abs(S.srcLen(curvedPieces[1]) - (5 - S.srcAt(curvedCut, 2))) < 1e-5);
assert.deepStrictEqual(curvedPieces.map(c => [c.start, c.dur]), [[1, 1], [2, 2]]);
{
  // Multi-track ripple: the cut closes on every track, even where a track has a gap under it.
  const cap = { id: 'cap', track: 'c1', start: 1.2, dur: 0.5 }, music = { id: 'mu', track: 'm1', start: 0, dur: 6 };
  const late = { id: 'late', track: 'b1', start: 3, dur: 1 }, gapRow = [late];
  const capOut = S.cutRanges([cap, { id: 'cap2', track: 'c1', start: 3, dur: 1 }], [[1, 2]], 1 / 30, () => Infinity, true);
  assert.deepStrictEqual(capOut.map(c => [c.id, c.start, c.dur]), [['cap2', 2, 1]]);
  const musicOut = S.cutRanges([music], [[1, 2]], 1 / 30, () => Infinity, true);
  assert.deepStrictEqual(musicOut.map(c => [c.start, c.dur]), [[0, 1], [1, 4]]);
  assert.deepStrictEqual(S.cutRanges(gapRow, [[1, 2]], 1 / 30, () => Infinity, true).map(c => c.start), [2]);
  assert.strictEqual(S.cutRanges(gapRow, [[1, 2]], 1 / 30, () => Infinity), gapRow);
  const marks = S.cutMarkers([{ time: 0.5 }, { time: 1 }, { time: 1.5 }, { time: 2 }, { time: 3 }], [[1, 2]]);
  assert.deepStrictEqual(marks.map(m => m.time), [0.5, 1, 1, 2]);
}
console.log('Transcript and silence cut assertions passed');

// Docking moves the original panel IDs through tab groups and nested splits.
const W = require('../src/workspace');
const allTabs = W.group(...W.panels);
const detached = W.move(allTabs, 'media', 'media', 'start');
assert.deepStrictEqual(detached.sizes, [0.5, 0.5]);
assert.deepStrictEqual(detached.children[0], W.group('media'));
assert.strictEqual(detached.children[1].active, 'text');
assert.strictEqual(detached.split, 'row');
const beside = W.move(detached, 'effects', 'media', 'bottom');
assert.strictEqual(beside.children[0].split, 'col');
assert.deepStrictEqual(beside.children[0].children[1], W.group('effects'));
const rejoined = W.move(beside, 'media', 'text', 'center');
assert.strictEqual(rejoined.children[0].active, 'effects');
assert.strictEqual(rejoined.children[1].active, 'media');
assert.ok(rejoined.children[1].tabs.includes('media'));
const collapsed = W.move(rejoined, 'effects', 'media', 'center');
assert.strictEqual(collapsed.active, 'effects');
assert.ok(W.valid(collapsed));
assert.strictEqual(W.move(collapsed, 'media', 'effects', 'center'), collapsed);
assert.ok(!W.valid({ ...collapsed, tabs: [...collapsed.tabs, 'media'] }));
assert.deepStrictEqual(allTabs, W.group(...W.panels));
const oldLayout = {
  split: 'row', sizes: [0.4, 0.6], children: [
    W.group(...W.library), W.group('player', 'insp', 'tl'),
  ],
};
assert.ok(!W.valid(oldLayout));
assert.ok(W.valid(W.withPanels(oldLayout)));
assert.deepStrictEqual(oldLayout.sizes, [0.4, 0.6]);
assert.deepStrictEqual(W.find(oldLayout, 'scopes'), { tabs: ['player', 'insp', 'tl', 'scopes', 'transcript', 'multicam'], active: 'player' });
assert.ok(W.valid(W.withPanels(oldLayout)));
const scopesLayout = W.group(...W.panels.filter(id => id !== 'transcript' && id !== 'multicam'));
scopesLayout.active = 'scopes';
assert.ok(W.valid(W.withPanels(scopesLayout)));
assert.strictEqual(W.find(scopesLayout, 'transcript').active, 'scopes');
const transcriptLayout = W.group(...W.panels.filter(id => id !== 'multicam'));
transcriptLayout.active = 'transcript';
assert.ok(W.valid(W.withPanels(transcriptLayout)));
assert.strictEqual(W.find(transcriptLayout, 'multicam').active, 'transcript');
console.log('Workspace tree assertions passed');

const { accumulate, rgbToCbCr } = require('../src/scopes');
const scopePixels = new Uint8ClampedArray([
  0, 0, 0, 255, 255, 0, 0, 255,
  0, 0, 0, 255, 255, 255, 255, 255,
]);
const occupiedBins = bins => Array.from(bins.entries()).filter(([, count]) => count);
assert.deepStrictEqual(occupiedBins(accumulate('waveform', scopePixels, 2)), [
  [1, 1], [(255 - 54) * 2 + 1, 1], [255 * 2, 2],
]);
assert.deepStrictEqual(occupiedBins(accumulate('parade', scopePixels, 2)), [
  [1, 2], [3, 1], [5, 1], [255 * 6, 2], [255 * 6 + 2, 2], [255 * 6 + 3, 1], [255 * 6 + 4, 2], [255 * 6 + 5, 1],
]);
assert.deepStrictEqual(occupiedBins(accumulate('histogram', scopePixels, 2)), [
  [0, 2], [255, 2], [256, 3], [511, 1], [512, 3], [767, 1], [768, 2], [822, 1], [1023, 1],
]);
const [redCb, redCr] = rgbToCbCr(255, 0, 0);
assert.ok(Math.abs(redCb + 0.114572) < 1e-6);
assert.ok(Math.abs(redCr - 0.5) < 1e-6);
assert.deepStrictEqual(rgbToCbCr(128, 128, 128).map(v => Math.abs(v) < 1e-12), [true, true]);
assert.deepStrictEqual(occupiedBins(accumulate('vector', scopePixels, 2)), [[98, 1], [128 * 256 + 128, 3]]);
console.log('Video scope assertions passed');

// real export
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maqto-test-'));
const run = (bin, a) => execFileSync(bin, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
{
  const input = path.join(dir, 'reframe-source.mp4'), out = path.join(dir, 'reframe-out.mp4');
  run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=192x108:r=8:d=2,drawbox=x=96:w=96:h=108:c=blue:t=fill',
    '-c:v', 'libx264', input]);
  const kf = S.cropKeyframes([[0, 0, 0.5], [1, 1, 0.5, true]], 192, 108, 54, 96);
  const project = {
    w: 54, h: 96, fps: 8, tracks: [{ id: 'v1', kind: 'video' }],
    media: { src: { path: input, kind: 'video', w: 192, h: 108 } },
    items: [{ id: 'clip', track: 'v1', media: 'src', start: 0, dur: 2, fit: 'contain', kf }],
  };
  const scaled = S.scaleProject(project, 2), { w, h } = scaled;
  run(ffmpeg, buildArgs(scaled, { out }).args);
  const frames = execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  for (const [frame, channel] of [[0, 0], [7, 0], [8, 2], [15, 2]]) {
    for (const pixel of [0, w - 1, w * (h - 1), w * h - 1]) {
      const i = (frame * w * h + pixel) * 3;
      assert.ok(frames[i + channel] > 200 && frames[i + 2 - channel] < 30);
    }
  }
  console.log('Smart reframe FFmpeg export passed');
}
const clip = path.join(dir, 'clip.mp4'), img = path.join(dir, 'img.png'), tone = path.join(dir, 'tone.wav');
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=400x400', '-frames:v', '1', img]);
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=f=220:d=3', tone]);
const txt = n => { const f = path.join(dir, n); run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=white@0.0:s=1080x1920,format=rgba', '-frames:v', '1', f]); return n; };
const textList = writeConcat(dir, [{ name: txt('f00000.png'), frames: 30 }, { name: txt('f00001.png'), frames: 60 }], 30);

const p = {
  w: 1080, h: 1920, fps: 30,
  media: {
    m1: { path: clip, kind: 'video', w: 1280, h: 720, dur: 6, hasAudio: true },
    m2: { path: img, kind: 'image', w: 400, h: 400 },
    m3: { path: tone, kind: 'audio', dur: 3, hasAudio: true },
  },
  tracks: [{ id: 'c1', kind: 'text' }, { id: 't1', kind: 'text' }, { id: 'v2', kind: 'video' }, { id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
  items: [
    { id: 'i1', track: 'v1', media: 'm1', start: 0, dur: 2, in: 0, speed: 1, preset: 'warm', fadeIn: 0.3 },
    { id: 'i2', track: 'v1', media: 'm1', start: 2, dur: 1.5, in: 3, speed: 2, fit: 'contain', brightness: 1.2, fadeOut: 0.5, flipH: true, crop: { l: 0.1, t: 0.2 }, opacity: 0.8 },
    { id: 'i3', track: 'v2', media: 'm2', start: 0.5, dur: 2, scale: 0.3, x: 200, y: -400 },
    { id: 'i4', track: 'a1', media: 'm3', start: 1, dur: 2, volume: 0.5, fadeIn: 0.2 },
  ],
};
{
  const hd = { kind: 'video', w: 1920, h: 1080, codec: 'h264', bitrate: 50_000_000 };
  assert.strictEqual(S.needsProxy(hd), false);
  assert.strictEqual(S.needsProxy({ ...hd, w: 1080, h: 1920 }, 'auto'), false);
  assert.strictEqual(S.needsProxy({ ...hd, w: 1921 }, 'auto'), true);
  assert.strictEqual(S.needsProxy({ ...hd, h: 1081 }, 'auto'), true);
  assert.strictEqual(S.needsProxy({ ...hd, bitrate: 50_000_001 }, 'auto'), true);
  for (const codec of ['hevc', 'prores']) {
    const uhd = { ...hd, codec, w: 2160, h: 3840 };
    assert.strictEqual(S.needsProxy(uhd, 'auto'), true);
    assert.strictEqual(S.needsProxy(uhd, 'off'), false);
  }
  assert.strictEqual(S.needsProxy(hd, 'always'), true);
  assert.strictEqual(S.needsProxy({ ...hd, kind: 'image' }, 'always'), false);
  assert.strictEqual(S.needsProxy({ ...hd, kind: 'audio' }, 'always'), false);

  const proxyPath = path.join(dir, 'media-proxies', 'preview.mp4');
  const withProxy = { ...p, media: { ...p.media, m1: { ...p.media.m1, proxyPath } } };
  for (const opts of [{ out: 'test.mp4' }, { out: 'test.wav', audioExport: 'wav' }, { loudnessAnalysis: true, loudnessTarget: -14 }]) {
    const result = buildArgs(withProxy, opts);
    const inputs = result.args.flatMap((arg, index) => arg === '-i' ? [result.args[index + 1]] : []);
    assert.ok(inputs.includes(clip));
    assert.ok(!inputs.includes(proxyPath));
    assert.deepStrictEqual(result, buildArgs(p, opts));
  }
  console.log('Media proxy eligibility and original export path assertions passed');
}
const grouped = { ...p, groups: { g1: { name: 'Group 1' } }, items: p.items.map((it, i) => i ? { ...it, grp: 'g1' } : it) };
assert.strictEqual(S.projectDur(grouped), S.projectDur(p));
assert.deepStrictEqual(buildArgs(grouped, { out: clip }), buildArgs(p, { out: clip }));

const out = path.join(dir, 'out.mp4');
{
  const bed = path.join(dir, 'loudness-source.wav'), wav = path.join(dir, 'normalized.wav'), mp4 = path.join(dir, 'normalized.mp4');
  run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=f=440:d=8', bed]);
  const project = {
    ...p, w: 320, h: 240,
    media: { bed: { path: bed, kind: 'audio' }, overlay: p.media.m3 },
    items: [
      { id: 'bed', track: 'a1', media: 'bed', start: 0, dur: 8, kf: { volume: [[0, 0.45], [3, 0.45], [4, 1], [8, 1]] } },
      { id: 'overlay', track: 'v1', media: 'overlay', start: 5, dur: 2, volume: 0.25, afIn: 0.2 },
    ],
  };
  const analyze = args => {
    const { status, stderr } = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    assert.strictEqual(status, 0, stderr);
    const end = stderr.lastIndexOf('\n}') + 1, start = stderr.lastIndexOf('\n{', end) + 1;
    return JSON.parse(stderr.slice(start, end + 1));
  };
  const read = file => analyze(['-nostats', '-i', file, '-vn', '-af', loudnormFilter(-14), '-f', 'null', '-']);
  const checkTarget = (file, target) => {
    const stats = read(file);
    assert.ok(Math.abs(+stats.input_i - target) <= 1, JSON.stringify(stats));
    assert.ok(+stats.input_tp <= -1, JSON.stringify(stats));
  };
  const measure = loudnessTarget => analyze(buildArgs(project, { loudnessAnalysis: true, loudnessTarget }).args);
  const original = measure(-14);
  assert.ok(+original.input_i < -20 && +original.input_tp < -18 && +original.input_lra > 0, JSON.stringify(original));
  assert.deepStrictEqual(buildArgs(project, { out: wav, audioExport: 'wav', loudnessTarget: 0 }), buildArgs(project, { out: wav, audioExport: 'wav' }));
  for (const loudnessTarget of LOUDNESS_TARGETS) {
    const loudnessStats = measure(loudnessTarget);
    run(ffmpeg, buildArgs(project, { out: wav, audioExport: 'wav', loudnessTarget, loudnessStats }).args);
    checkTarget(wav, loudnessTarget);
    if (loudnessTarget === -14) {
      run(ffmpeg, buildArgs(project, { out: mp4, loudnessTarget, loudnessStats }).args);
      checkTarget(mp4, loudnessTarget);
    }
  }
  const silent = { ...project, items: project.items.map(it => ({ ...it, muted: true })) };
  const loudnessStats = analyze(buildArgs(silent, { loudnessAnalysis: true, loudnessTarget: -14 }).args);
  assert.strictEqual(loudnessStats.input_i, '-inf');
  assert.deepStrictEqual(buildArgs(silent, { out: wav, audioExport: 'wav', loudnessTarget: -14, loudnessStats }), buildArgs(silent, { out: wav, audioExport: 'wav' }));
  console.log('Master loudness assertions passed');
}
{
  const hdr = { ...p, media: { ...p.media, m1: { ...p.media.m1, hdr: true, trc: 'arib-std-b67', primaries: 'bt2020', matrix: 'bt2020nc' } } };
  const filters = (project, opts = {}) => {
    const { args } = buildArgs(project, { out, ...opts });
    return args[args.indexOf('-filter_complex') + 1];
  };
  assert.ok(!filters(p).includes('tonemap='));
  assert.ok(filters(hdr).includes('[0:v]zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap='));
  assert.ok(filters(hdr, { codec: 'proxy' }).includes('tonemap='));
  const matte = filters(hdr, { mattes: { i1: clip } });
  assert.ok(matte.includes('tonemap=') && !matte.split(';').find(f => f.endsWith('[bgm0]')).includes('tonemap='));
  const rife = filters({ ...hdr, items: [hdr.items[0]] }, { rife: { i1: clip } });
  assert.ok(rife.includes('[0:v]zscale=min=170m:m=709,') && !rife.includes('tonemap='));
}
run(ffmpeg, buildArgs(p, { out, textList }).args);
const pr = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]));
const v = pr.streams.find(s => s.codec_type === 'video');
assert.strictEqual(v.width, 1080); assert.strictEqual(v.height, 1920); assert.strictEqual(v.pix_fmt, 'yuv420p');
assert.deepStrictEqual([v.color_primaries, v.color_transfer, v.color_space, v.color_range], ['bt709', 'bt709', 'bt709', 'tv']);
assert.ok(pr.streams.some(s => s.codec_type === 'audio'));
assert.ok(Math.abs(+pr.format.duration - 3.5) < 0.1, 'duration ' + pr.format.duration);

{
  const out = path.join(dir, 'multicam.mp4'), fps = 8, size = 64;
  const camera = (color, frequency) => {
    const file = path.join(dir, color + '-angle.mp4');
    run(ffmpeg, ['-f', 'lavfi', '-i', 'color=' + color + ':s=64x64:r=8:d=2',
      '-f', 'lavfi', '-i', 'sine=f=' + frequency + ':d=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file]);
    return { kind: 'video', w: size, h: size, dur: 2, hasAudio: true, path: file, proxyPath: file + '.proxy' };
  };
  const red = camera('red', 440), blue = camera('blue', 880);
  const media = { red, blue, mc: { kind: 'video', path: '', defaultAngle: 0, audioAngle: 1,
    angles: [{ media: 'red', offset: 0 }, { media: 'blue', offset: -0.5 }] } };
  const multicam = { w: size, h: size, fps, tracks: [{ id: 'v1', kind: 'video' }], media, items: [
    { id: 'mc', track: 'v1', media: 'mc', start: 0, in: 0, dur: 1.5, cuts: [{ t: 0, angle: 0 }, { t: 0.75, angle: 1 }] },
  ] };
  const { args } = buildArgs(multicam, { out });
  assert.deepStrictEqual(args.flatMap((arg, i) => arg === '-i' ? [args[i + 1]] : []), [red.path, blue.path, blue.path]);
  run(ffmpeg, args);
  const frames = execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  for (let i = 0; i < 12; i++) {
    const n = i * size * size * 3, active = i < 6 ? 0 : 2;
    assert.ok(frames[n + active] > 200 && frames[n + 2 - active] < 30, 'multicam frame ' + i);
  }
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  for (const second of [0.2, 0.7, 0.8, 1.2]) {
    let crossings = 0;
    for (let i = 8000 * second; i < 8000 * second + 800; i++) {
      if (pcm.readInt16LE(2 * i) < 0 && pcm.readInt16LE(2 * i + 2) >= 0) crossings++;
    }
    assert.ok(Math.abs(crossings - 88) <= 1, 'multicam audio at ' + second + 's');
  }
  console.log('Multicam FFmpeg angle switches and continuous audio passed');
}

const out4k = path.join(dir, 'out4k.mp4');
run(ffmpeg, buildArgs(S.scaleProject(p, 2), { out: out4k, textList, codec: process.platform === 'darwin' ? 'hevc_hw' : 'hevc' }).args);
const v4 = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', out4k])).streams.find(s => s.codec_type === 'video');
assert.strictEqual(v4.width, 2160); assert.strictEqual(v4.height, 3840); assert.strictEqual(v4.codec_name, 'hevc');

const wav = path.join(dir, 'mix.wav');
run(ffmpeg, buildArgs(p, { out: wav, audioOnly: true }).args);
assert.ok(fs.statSync(wav).size > 16000 * 2 * 3);

// rotation + ProRes, and a separate MP3
p.items[2].rotate = 30;
const mov = path.join(dir, 'out.mov');
run(ffmpeg, buildArgs(p, { out: mov, textList, codec: 'prores', quality: 'high' }).args);
const prores = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', mov])).streams.find(s => s.codec_type === 'video');
assert.strictEqual(prores.codec_name, 'prores');
assert.deepStrictEqual([prores.color_primaries, prores.color_transfer, prores.color_space], ['bt709', 'bt709', 'bt709']); // ffprobe on Windows leaves ProRes range unset
const mp3 = path.join(dir, 'out.mp3');
run(ffmpeg, buildArgs(p, { out: mp3, audioExport: 'mp3' }).args);
const a3 = JSON.parse(run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp3]));
assert.strictEqual(a3.streams.length, 1); assert.strictEqual(a3.streams[0].codec_name, 'mp3');
assert.ok(Math.abs(+a3.format.duration - 3.5) < 0.15, 'mp3 duration ' + a3.format.duration);

// tracked overlay: expression offsets match trkAt
const trk = { start: 1, trk: { pts: [[0, 0, 0], [1, 0.1, -0.05], [2, 0.3, 0]] } };
assert.deepStrictEqual(S.trkAt(trk, 0.5).map(v => +v.toFixed(4)), [0.05, -0.025]);
assert.deepStrictEqual(S.trkAt(trk, 9), [0.3, 0]);
p.items[2].trk = { pts: [[0, 0, 0], [2, 0.2, 0.1]] };
const tmov = path.join(dir, 'trk.mp4');
run(ffmpeg, buildArgs(p, { out: tmov, textList }).args);
assert.ok(fs.statSync(tmov).size > 1000);

// keyframes: shared curve + export moves/fades the image
const kfi = { kf: { x: [[0, -300], [1.9, 300]], opacity: [[0, 1], [1.9, 0.3]] } };
assert.strictEqual(S.kfVal(kfi.kf.x, 0.95), 0);
assert.strictEqual(S.animAt(kfi, 3).x, 300);
assert.ok(/gte\(t,1\.0000\)/.test(S.pwExpr(kfi.kf.x, 1, true)));
const volumeKeys = [[0, 1], [2, 0.4]];
assert.strictEqual(S.kfVal(volumeKeys, 0.5), 0.90625);
const sound = { ...p.items[3], volume: 0, kf: { volume: volumeKeys } };
const keyedWav = buildArgs({ ...p, items: [sound] }, { out: path.join(dir, 'keyed.wav'), audioOnly: true }).args;
assert.ok(keyedWav[keyedWav.indexOf('-filter_complex') + 1].includes(`volume='${S.pwExpr(volumeKeys, 0, true)}':eval=frame`));
run(ffmpeg, keyedWav);
S.shiftTimes(sound, 0.5);
assert.strictEqual(S.volumeAt(sound, 0), 0.90625);
delete p.items[2].trk;
Object.assign(p.items[2], { rotate: 0, x: 0, y: -400, kf: { x: [[0, -300], [1.9, 300]], scale: [[0, 0.2], [1.9, 0.35]], rotate: [[0, 0], [1.9, 45]], opacity: [[0, 1], [1.9, 0.5]] } });
const kmov = path.join(dir, 'kf.mp4');
run(ffmpeg, buildArgs(p, { out: kmov, textList }).args);
const px = (time, x, y) => { const b = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', kmov, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [...b.subarray(0, 3)]; };
const isRed = c => c[0] > 180 && c[1] < 90 && c[2] < 90;
assert.ok(isRed(px(0.55, 540 - 300, 960 - 400)), 'early: image on the left ' + px(0.55, 240, 560));
assert.ok(!isRed(px(2.35, 540 - 300, 960 - 400)), 'late: image moved away');
const late = px(2.35, 540 + 290, 960 - 400);
assert.ok(late[0] > late[1] + 40 && late[0] > late[2] + 40, 'late: half-opaque red on the right ' + late);

// rich animations (anims.js): every in ends at rest, the clip is hidden under its rendered stretch, then shows
{
  const A = require('../src/anims');
  assert.ok(Object.keys(A.IN).length + Object.keys(A.OUT).length + Object.keys(A.LOOP).length >= 200);
  for (const k in A.IN) { const q = A.IN[k](1); for (const c of ['dx', 'dy', 'r', 'ry', 'rx', 'blur', 'rgb', 'glitch']) assert.ok(!q[c] || Math.abs(q[c]) < 1e-3, `${k} ends at rest (${c})`); }
  const it = { type: 'image', dur: 2, anim: 'flip3dY', inDur: 0.5, out: 'tilesFall', outDur: 0.4 };
  assert.deepStrictEqual(S.richSegs(it), [[0, 0.5], [1.6, 2]]);
  assert.ok(S.vaFx(it, 0.1).ry > 10 && !S.vaFx(it, 1));
  Object.assign(p.items[2], { kf: undefined, x: 0, y: -400, scale: 0.35, rotate: 0, opacity: 1, anim: 'flip3dY', inDur: 0.8 });
  delete p.items[2].kf;
  const rmov = path.join(dir, 'rich.mp4');
  run(ffmpeg, buildArgs(p, { out: rmov, textList }).args);
  const at = (time) => { const b = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', rmov, '-frames:v', '1', '-vf', 'crop=2:2:540:560', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [...b.subarray(0, 3)]; };
  assert.ok(!isRed(at(0.8)), 'hidden while its frames would play ' + at(0.8));
  assert.ok(isRed(at(1.8)), 'shown after the in animation ' + at(1.8));
  delete p.items[2].anim;
}

// speed curves: time maps round-trip, a split keeps the source range, visual animations resolve
{
  const curve = { id: 'hero', pts: S.CURVES.hero, src: 6 }, c = { dur: S.curveDur(curve), curve };
  for (const lt of [0, 1, 2.5, c.dur]) assert.ok(Math.abs(S.ltAt(c, S.srcAt(c, lt)) - lt) < 1e-3, 'curve round trip ' + lt);
  const a = S.subCurve(c, 0, 2), b = S.subCurve(c, 2, c.dur);
  assert.ok(Math.abs(a.src + b.src - 6) < 1e-3, 'split keeps source');
  assert.ok(S.rateAt(c, S.ltAt(c, 3)) < 1, 'hero is slow in the middle');
  const v = S.withVa({ type: 'image', dur: 4, anim: 'slideLeft', inDur: 1, x: 0, scale: 1 }, 0, 1000, 1000);
  assert.ok(Math.abs(v.x - 600) < 1e-6, 'slide starts 0.6 frame right ' + v.x);
}

// denoise (bundled RNNoise model, same filter as denoise_audio) + logo removal export
{
  const dn = path.join(dir, 'tone.dn.flac');
  execFileSync(ffmpeg, ['-y', '-i', tone, '-vn', '-af', 'highpass=f=70,arnndn=m=rnnoise.rnnn', '-c:a', 'flac', dn], { cwd: path.join(__dirname, '../src-tauri/resources'), stdio: 'ignore' });
  p.media.m3.fx = { d: dn }; p.items[3].denoise = true; p.items[0].afIn = 0.5;
  p.items[0].logo = { on: true, x: 0.95, y: 0, w: 0.2, h: 0.1 }; // past the edge: clamped inside the frame
  const b = S.logoBox(p.items[0].logo, p.media.m1);
  assert.ok(b.x >= 1 && b.x + b.w <= 1278 && b.y >= 1, 'logo box inside frame ' + JSON.stringify(b));
  const a = buildArgs(p, { out: path.join(dir, 'clean.mp4'), textList }).args;
  assert.ok(a.includes(dn) && a.join(' ').includes('delogo='), 'denoised input + delogo in graph');
  assert.strictEqual(S.audioFade(p.items[0], 0.25), 0.5, 'sound-only fade in');
  run(ffmpeg, a);
}

// advanced colour: baked 3D LUT written as .cube, applied with lut3d
{
  const it = p.items[0];
  it.color = { look: 'tealOrange', hsl: { red: { s: 0.4 } }, curves: { l: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]] }, wheels: { lift: { x: 0.1, y: 0, l: 0 } }, lut: { file: 'x.cube', mix: 1 } };
  assert.ok(S.hasColor(it), 'advanced colour detected');
  const ident = S.parseCube(S.cubeText(S.bakeLut({ id: 'z' }, null)));
  for (const c of [[0.1, 0.5, 0.9], [0.7, 0.2, 0.4]]) S.sampleLut(ident, ...c).forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 0.01, 'identity LUT ' + v));
  const user = S.parseCube(S.cubeText(S.bakeLut({ id: 'u', color: { look: 'mono' } }, null)));
  const cube = path.join(dir, 'lut_i1.cube');
  fs.writeFileSync(cube, S.cubeText(S.bakeLut(it, user)));
  const a = buildArgs(p, { out: path.join(dir, 'graded.mp4'), textList, luts: { i1: cube } }).args;
  assert.ok(a.join(' ').includes('lut3d=file='), 'lut3d in graph');
  run(ffmpeg, a);
  delete it.color;
}

// mask (grey PNG through alphamerge) + chroma key
{
  const mk = path.join(dir, 'mask.png');
  run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=200x200,geq=lum=\'255*lt(hypot(X-100,Y-100),80)\'', '-frames:v', '1', mk]);
  p.items[0].mask = { type: 'circle', x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0.1 };
  p.items[1].chroma = { on: true, color: '#00ff00', sim: 0.3, blend: 0.1 };
  assert.ok(S.hasMask(p.items[0]) && S.hasKey(p.items[1]), 'mask + key detected');
  const a = buildArgs(p, { out: path.join(dir, 'masked.mp4'), textList, masks: { i1: mk } }).args, j = a.join(' ');
  assert.ok(j.includes('alphamerge') && j.includes('chromakey=color=0x00ff00'), 'mask + key in graph');
  run(ffmpeg, a);
  delete p.items[0].mask; delete p.items[1].chroma;
}

// transitions: red clip, then blue clip with each transition; sample the middle of it
{
  const blue = path.join(dir, 'blue.png');
  run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=400x400', '-frames:v', '1', blue]);
  const tp = { w: 200, h: 200, fps: 30, media: { r: { kind: 'image', path: img, w: 400, h: 400 }, b: { kind: 'image', path: blue, w: 400, h: 400 } },
    tracks: [{ id: 'v1', kind: 'video' }], items: [{ id: 'A', track: 'v1', media: 'r', start: 0, dur: 2 }, { id: 'B', track: 'v1', media: 'b', start: 2, dur: 2 }] };
  assert.strictEqual(S.transIn(tp, tp.items[1]), null, 'no transition set');
  const red = c => c[0] > 150 && c[2] < 90, blu = c => c[2] > 150 && c[0] < 90, out = path.join(dir, 'tr.mp4');
  const at = (time, x, y) => [...execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).subarray(0, 3)];
  const want = { fade: () => { const c = at(2.5, 100, 100); return c[0] > 60 && c[2] > 60; }, black: () => Math.max(...at(2.47, 100, 100)) < 60, white: () => Math.min(...at(2.47, 100, 100)) > 190,
    slideL: () => blu(at(2.5, 160, 100)) && red(at(2.5, 30, 100)), slideU: () => blu(at(2.5, 100, 160)) && red(at(2.5, 100, 30)),
    wipeL: () => blu(at(2.5, 170, 100)) && red(at(2.5, 30, 100)), wipeR: () => blu(at(2.5, 30, 100)) && red(at(2.5, 170, 100)),
    zoomIn: () => red(at(2.25, 100, 100)) && blu(at(2.75, 100, 100)), spin: () => red(at(2.25, 100, 100)) && blu(at(2.75, 100, 100)),
    circle: () => blu(at(2.5, 100, 100)) && red(at(2.5, 2, 2)), split: () => blu(at(2.5, 100, 100)) && red(at(2.5, 4, 100)) };
  for (const id of S.TRANS) {
    tp.items[1].trans = { id, dur: 1 };
    const T = S.transIn(tp, tp.items[1]);
    assert.ok(T && T.prev === tp.items[0] && S.transOut(tp, tp.items[0]).next === tp.items[1], 'pairing ' + id);
    run(ffmpeg, buildArgs(tp, { out }).args);
    assert.ok(red(at(1.5, 100, 100)) && blu(at(3.5, 100, 100)), 'before/after ' + id);
    if (want[id]) assert.ok(want[id](), 'mid ' + id + ' ' + at(2.5, 100, 100));
  }
  // shader transition: the app's rendered frames (here plain green) sit over the cut, B stays hidden under them
  {
    const green = path.join(dir, 'green.png'), clear = path.join(dir, 'clear.png');
    run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=200x200', '-frames:v', '1', green]);
    run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=200x200,format=rgba', '-frames:v', '1', clear]);
    const list = path.join(dir, 'gl.ffconcat');
    fs.writeFileSync(list, concatText([{ name: 'green.png', frames: 30 }, { name: 'clear.png', frames: 1 }], 30));
    tp.items[1].trans = { id: S.GLT[0], dur: 1 };
    assert.ok(S.transIn(tp, tp.items[1]), 'shader transition pairs');
    run(ffmpeg, buildArgs(tp, { out, transLists: [{ track: 'v1', start: 1.5, path: list }] }).args); // centred on the cut at 2
    const g = at(2.2, 100, 100);
    assert.ok(g[1] > 90 && g[0] < 60 && g[2] < 60, 'shader transition frames on top ' + g);
    assert.ok(red(at(1.2, 100, 100)) && blu(at(2.8, 100, 100)), 'shader transition before/after');
  }
  // clip effects: every one renders; a few checked by colour on the red clip
  delete tp.items[1].trans;
  for (const id of S.FX) {
    tp.items[0].fx = { id, a: 0.8 };
    const a = buildArgs(tp, { out }).args;
    assert.ok(a.join(' ').includes(S.fxChain(tp.items[0], 200, 200)[0]), 'fx in graph ' + id);
    assert.ok(S.fxVals(tp.items[0], 0.5, 200, 200).i === S.FX.indexOf(id) + 1, 'fx preview id ' + id);
    run(ffmpeg, a);
    if (id === 'invert') { const c = at(1, 100, 100); assert.ok(c[0] < 90 && c[1] > 150 && c[2] > 150, 'invert ' + c); }
    if (id === 'letterbox') assert.ok(Math.max(...at(1, 100, 4)) < 30 && red(at(1, 100, 100)), 'letterbox');
    if (id === 'vignette') assert.ok(at(1, 1, 1)[0] < at(1, 100, 100)[0] - 40, 'vignette corner ' + at(1, 1, 1));
  }
  delete tp.items[0].fx;
  // adjustment layer (effect clip on its own track): inverts only what is under it, only during its time
  tp.tracks.unshift({ id: 'v2', kind: 'video' });
  tp.media.adj = { kind: 'image', adj: true, path: '', w: 200, h: 200 };
  tp.items.push({ id: 'J', track: 'v2', media: 'adj', start: 0.5, dur: 1, fx: { id: 'invert', a: 0.5 } });
  run(ffmpeg, buildArgs(tp, { out }).args);
  { const c = at(1, 100, 100); assert.ok(c[0] < 90 && c[1] > 150 && c[2] > 150, 'adjustment layer inverts ' + c); }
  assert.ok(red(at(0.2, 100, 100)) && red(at(1.8, 100, 100)), 'adjustment layer only during its time');
  tp.items.pop(); tp.tracks.shift(); delete tp.media.adj;
  // blend modes: half-size blue layer over the red clip; outside it the red stays as it was
  tp.tracks.unshift({ id: 'v2', kind: 'video' });
  tp.items.push({ id: 'L', track: 'v2', media: 'b', start: 0, dur: 2, scale: 0.5 });
  for (const [mode, ok] of [['screen', c => c[0] > 200 && c[2] > 200 && c[1] < 60], ['multiply', c => Math.max(...c) < 40], ['dodge', c => c[0] > 200 && c[1] < 60]]) {
    tp.items[2].blend = mode;
    run(ffmpeg, buildArgs(tp, { out }).args);
    assert.ok(ok(at(1, 100, 100)), 'blend ' + mode + ' ' + at(1, 100, 100));
    assert.ok(red(at(1, 5, 5)), 'blend ' + mode + ' leaves the rest ' + at(1, 5, 5));
  }
  tp.items.pop(); tp.tracks.shift();
  tp.items[0].hidden = true;
  assert.strictEqual(S.transIn(tp, tp.items[1]), null, 'hidden clip: no transition');
  assert.ok(!buildArgs(tp, { out }).args.includes(img), 'hidden clip is not exported');
}

fs.rmSync(dir, { recursive: true, force: true });
// DTW token times win over segment offsets (whisper's run early); words run on to the next start
{
  const tk = (txt, d) => ({ text: txt, t_dtw: d });
  const w = S.parseWhisper({ transcription: [
    { text: ' a', offsets: { from: 800, to: 900 }, tokens: [tk('[_BEG_]', -1), tk(' a', 154)] },
    { text: ' b', offsets: { from: 900, to: 1200 }, tokens: [tk(' b', 178), tk('c', 186)] },
  ] });
  assert.ok(Math.abs(w[0].s - 1.44) < 1e-6 && Math.abs(w[0].e - w[1].s) < 1e-6 && Math.abs(w[1].s - 1.68) < 1e-6, JSON.stringify(w));
}
console.log('selftest ok');

{
  const E = [{ version: '1.0.40', steps: ['a'] }, { version: '1.0.41', steps: ['b', 'c'] }, { version: '1.0.9', steps: ['old'] }, { version: '1.0.42', steps: ['future'] }];
  assert.deepStrictEqual(WN.pendingSteps(E, '', '1.0.41'), []); // fresh install
  assert.deepStrictEqual(WN.pendingSteps(E, '1.0.40', '1.0.41'), ['b', 'c']);
  assert.deepStrictEqual(WN.pendingSteps(E, '1.0.39', '1.0.41'), ['a', 'b', 'c']); // sorted, 1.0.9 < 1.0.39 so excluded, 1.0.42 not yet
  assert.deepStrictEqual(WN.pendingSteps(E, '1.0.41', '1.0.41'), []);
  assert.deepStrictEqual(WN.pendingSteps(E, '1.0.8', '1.0.40'), ['old', 'a']); // numeric, not string, compare
  assert.deepStrictEqual(WN.replaySteps(E, '1.0.41'), ['b', 'c']);
  assert.ok(WN.WHATS_NEW.every(e => e.steps.every(x => x.ar.title && x.ar.body && x.en.title && x.en.body)));
}

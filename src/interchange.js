(function (root) {
  const S = typeof module === 'undefined' ? root.MaqtoShared : require('./shared');
  const formats = Object.freeze({ fcpxml: 'FCPXML 1.10', edl: 'CMX3600 EDL', otio: 'OpenTimelineIO' });
  const basename = path => path.split(/[\\/]/).pop();
  const stem = path => basename(path).replace(/\.[^.]+$/, '');
  const fpsRatio = fps => {
    for (const rate of [24, 30, 60, 120]) {
      if (Math.abs(fps - rate * 1000 / 1001) < 0.001) return [rate * 1000, 1001];
    }
    return Number.isInteger(fps) ? [fps, 1] : [Math.round(fps * 1000), 1000];
  };
  const seconds = (value, fallback = 0) => {
    if (!value) return fallback;
    const [num, den = 1] = value.replace(/s$/, '').split('/');
    const time = Number(num) / Number(den);
    return Number.isFinite(time) ? time : fallback;
  };
  const rational = (num, den) => num % den === 0 ? `${num / den}s` : `${num}/${den}s`;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const addTime = (base, delta) => {
    const [a, b = 1] = base.slice(0, -1).split('/').map(Number);
    const [c, d = 1] = delta.slice(0, -1).split('/').map(Number);
    const den = b / gcd(b, d) * d;
    return rational(a * (den / b) + c * (den / d), den);
  };
  const frameTime = (frames, fps) => {
    const [num, den] = fpsRatio(fps);
    return rational(frames * den, num);
  };
  const framesAt = (time, fps) => {
    const [num, den] = fpsRatio(fps);
    return Math.round(time * num / den);
  };
  const edlTimecode = (frames, fps) => {
    const rate = Math.round(fps);
    const fields = [Math.floor(frames / rate / 3600) % 24, Math.floor(frames / rate / 60) % 60,
      Math.floor(frames / rate) % 60, frames % rate];
    return fields.map(value => String(value).padStart(2, '0')).join(':');
  };
  const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"'\t\r\n]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\r': '&#13;', '\n': '&#10;' })[c]);

  function fileURL(path) {
    const normalized = /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replaceAll('\\', '/') : path;
    const drive = /^[a-z]:\//i.test(normalized);
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    if (normalized.startsWith('//')) return 'file:' + encoded;
    return 'file://' + (drive ? '/' + encoded.replace('%3A', ':') : encoded);
  }

  function localPath(ref, timelinePath) {
    if (typeof ref !== 'string' || !ref || ref.includes('\0')) return null;
    if (/^[a-z]:[\\/]|^\\\\/i.test(ref) || (ref.startsWith('/') && !ref.startsWith('//'))) return ref;
    if (!timelinePath && !/^(file:|\/\/)/i.test(ref)) return null;
    try {
      const target = ref.replaceAll('\\', '/');
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(target) ? target : target.replaceAll('#', '%23').replaceAll('?', '%3F'),
        timelinePath ? fileURL(timelinePath) : 'file:///');
      if (url.protocol !== 'file:') return null;
      const path = decodeURIComponent(url.pathname);
      if (path.includes('\0')) return null;
      if (url.hostname) return '//' + url.hostname + path;
      return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
    } catch { return null; }
  }

  function warningList() {
    const warnings = {};
    return { warnings, warn(key, name) { const names = warnings[key] ??= []; if (!names.includes(name)) names.push(name); } };
  }

  function exportRows(project, format, warn) {
    const video = project.tracks.filter(track => track.kind === 'video').reverse();
    const main = video.find(track => track.id === 'v1') || video[0];
    const audio = project.tracks.filter(track => track.kind === 'audio');
    const tracks = format === 'otio' ? [...video, ...audio] : [main, ...video.filter(track => track !== main), ...audio].filter(Boolean);
    const rows = new Map(tracks.map(track => [track.id, { ...track, clips: [] }]));
    for (const it of project.items) {
      const m = project.media[it.media], row = rows.get(it.track);
      const name = it.type === 'text' ? it.text : m?.name || (m?.path && basename(m.path)) || it.id;
      if (it.type === 'text') { warn('titles', name); continue; }
      if (m?.adj) { warn('effects', name); continue; }
      if (m?.fill || (m?.kind === 'image' && format !== 'otio')) { warn('graphics', name); continue; }
      if (!m?.path || !row) { warn('media', name); continue; }
      if (it.hidden) { warn('hidden', name); continue; }
      if (format === 'edl' && (row.id !== main?.id || m.kind !== 'video')) { warn('tracks', name); continue; }
      const hasAudio = m.kind === 'audio' || !!m.hasAudio;
      const audioOnly = row.kind === 'audio' || m.kind === 'audio';
      const volume = it.muted ? 0 : S.num(it.volume, 1);
      const speed = it.curve ? 1 : S.num(it.speed, 1);
      if (it.trans) warn('transitions', name);
      if (it.curve) warn('curves', name);
      if (format !== 'fcpxml' && speed !== 1) warn('speed', name);
      if (hasAudio && volume !== 1 && volume !== 0 && format !== 'fcpxml') warn('volume', name);
      if (S.hasKf(it) || S.hasVa(it) || S.fxOf(it) || S.hasColor(it) || S.hasMask(it) || S.hasKey(it) ||
          it.trk || it.fadeIn || it.fadeOut || it.afIn || it.afOut || it.duck?.on || it.denoise || it.norm || it.pitch ||
          it.crop || it.flipH || it.flipV || it.rotate || it.x || it.y || (it.fit && it.fit !== 'contain') ||
          (it.blend && it.blend !== 'normal') || S.num(it.scale, 1) !== 1 || S.num(it.opacity, 1) !== 1) warn('effects', name);
      if (it.grp) warn('groups', project.groups?.[it.grp]?.name || name);
      if (audioOnly && !hasAudio) { warn('tracks', name); continue; }
      row.clips.push({ it, m, name, hasAudio, audioOnly, speed, volume });
    }
    for (const row of rows.values()) row.clips.sort((a, b) => a.it.start - b.it.start);
    return [...rows.values()];
  }

  function exportFCPXML(project, rows, warn) {
    const { fps, w, h, name = 'Maqto' } = project;
    const format = (id, rate, width, height) => `<format id="${id}" frameDuration="${frameTime(1, rate)}" width="${width}" height="${height}"/>`;
    const projectFormat = format('r1', fps, w, h);
    const formats = new Map([[projectFormat, projectFormat]]);
    const assets = new Map();
    const primary = rows.find(row => row.kind === 'video');
    const segments = [];
    const anchors = [];
    const markers = S.normalizeMarkers(project.markers);
    const q = time => framesAt(time, fps);
    const ft = frames => frameTime(frames, fps);
    const videoLanes = rows.filter(row => row.kind === 'video');
    const audioLanes = rows.filter(row => row.kind === 'audio');

    for (const row of rows) {
      for (const clip of row.clips) {
        const { it, m, hasAudio } = clip;
        const start = q(it.start), end = q(it.start + it.dur);
        if (end <= start) { warn('short', clip.name); continue; }
        if (row === primary && segments.length && start < segments.at(-1).end) {
          warn('overlaps', clip.name); continue;
        }
        let asset = assets.get(m.path);
        if (!asset) {
          asset = { id: 'a' + (assets.size + 1), m, hasAudio, hasVideo: m.kind === 'video' || m.w > 0 && m.h > 0, duration: 0 };
          assets.set(m.path, asset);
        }
        if (m.kind === 'video') { asset.m = m; asset.hasVideo = true; }
        asset.hasAudio ||= hasAudio;
        asset.duration = Math.max(asset.duration, m.dur || 0, (it.in || 0) + (end - start) * seconds(ft(1)) * clip.speed);
        const lane = row === primary ? 0 : row.kind === 'video' ? videoLanes.indexOf(row) : -audioLanes.indexOf(row) - 1;
        const segment = { ...clip, asset, start, end, lane, children: [], markers: [] };
        if (!lane) segments.push(segment);
        else anchors.push(segment);
      }
    }
    for (const asset of assets.values()) {
      const { m, hasVideo } = asset;
      const rate = hasVideo && m.fps > 0 ? m.fps : fps;
      const width = hasVideo && m.w > 0 ? m.w : w, height = hasVideo && m.h > 0 ? m.h : h;
      const key = format('r1', rate, width, height);
      if (!formats.has(key)) formats.set(key, format('r' + (formats.size + 1), rate, width, height));
      asset.format = 'r' + ([...formats.keys()].indexOf(key) + 1);
      asset.rate = rate;
    }
    const gap = (start, end) => ({ start, end, children: [], markers: [] });
    const spine = [];
    let cursor = 0;
    for (const segment of segments) {
      if (cursor < segment.start) spine.push(gap(cursor, segment.start));
      spine.push(segment);
      cursor = segment.end;
    }
    const duration = Math.max(0, q(S.projectDur(project)), markers.length ? q(markers.at(-1).time) + 1 : 0);
    if (cursor < duration) spine.push(gap(cursor, duration));
    const host = frame => spine.find(segment => frame >= segment.start && frame < segment.end);
    for (const anchor of anchors) host(anchor.start).children.push(anchor);
    for (const marker of markers) {
      host(q(marker.time)).markers.push(marker);
      if (marker.color !== 'accent') warn('markerColors', marker.name);
    }

    function story(segment, parent) {
      const { asset, it, children, markers: marks, start, end, speed, volume, lane } = segment;
      const offsetTime = parent ? addTime(parent.localStart, ft(start - parent.start)) : ft(start);
      const sourceIn = asset ? frameTime(framesAt(it.in || 0, asset.rate), asset.rate) : '0s';
      const localStart = asset && speed !== 1 ? ft(q(it.in || 0)) : sourceIn;
      const dur = ft(end - start);
      const nested = children.map(child => story(child, { start, localStart })).join('');
      const markerXML = marks.map(mark => `<marker start="${addTime(localStart, ft(q(mark.time) - start))}" duration="${ft(1)}" value="${xml(mark.name)}"${mark.note ? ` note="${xml(mark.note)}"` : ''}/>`).join('');
      if (!asset) return `<gap offset="${offsetTime}" start="0s" duration="${dur}">${nested}${markerXML}</gap>`;
      const timeMap = speed === 1 ? '' : `<timeMap><timept time="${localStart}" value="${sourceIn}" interp="linear"/><timept time="${ft(q(it.in || 0) + end - start)}" value="${preciseTime(seconds(sourceIn) + seconds(dur) * speed, asset.rate)}" interp="linear"/></timeMap>`;
      const gain = segment.hasAudio ? `<adjust-volume amount="${volume > 0 ? (20 * Math.log10(volume)).toFixed(6) : '-96'}dB"/>` : '';
      const audioOnly = segment.audioOnly ? ' srcEnable="audio"' : '';
      return `<asset-clip name="${xml(segment.name)}" ref="${asset.id}" offset="${offsetTime}" start="${localStart}" duration="${dur}"${lane ? ` lane="${lane}"` : ''}${audioOnly}>${timeMap}${gain}${nested}${markerXML}</asset-clip>`;
    }

    const resources = [...assets.entries()].map(([path, { id, m, hasAudio, hasVideo, duration, rate, format }]) =>
      `<asset id="${id}" name="${xml(m.name || basename(path))}" start="0s" duration="${frameTime(Math.max(1, framesAt(duration, rate)), rate)}" hasVideo="${+hasVideo}" hasAudio="${+hasAudio}"${hasVideo ? ` format="${format}"` : ''}${hasAudio && m.audioChannels > 0 ? ` audioSources="1" audioChannels="${m.audioChannels}"` : ''}><media-rep kind="original-media" src="${xml(fileURL(path))}"/></asset>`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    ${[...formats.values(), ...resources].join('\n    ')}
  </resources>
  <library><event name="${xml(name)}"><project name="${xml(name)}">
    <sequence format="r1" duration="${ft(duration)}" tcStart="0s" tcFormat="NDF"><spine>
      ${spine.map(segment => story(segment)).join('\n      ')}
    </spine></sequence>
  </project></event></library>
</fcpxml>
`;
  }

  function preciseTime(time, fps) {
    const frames = framesAt(time, fps);
    if (Math.abs(time - seconds(frameTime(frames, fps))) < 1e-8) return frameTime(frames, fps);
    return rational(Math.round(time * 1e9), 1e9);
  }

  function exportEDL(project, rows, warn) {
    const { fps } = project;
    const line = value => String(value).replace(/[\r\n]+/g, ' ');
    const tc = frame => edlTimecode(frame, fps);
    const lines = ['TITLE: ' + line(project.name || 'Maqto'), 'FCM: NON-DROP FRAME', ''];
    for (const marker of S.normalizeMarkers(project.markers)) warn('markers', marker.name || tc(framesAt(marker.time, fps)));
    const reels = new Map(), used = new Set();
    let count = 0, cursor = 0;
    for (const { it, m, name, hasAudio, volume } of rows.find(row => row.kind === 'video')?.clips || []) {
      const start = framesAt(it.start, fps), end = framesAt(it.start + it.dur, fps);
      if (end <= start) { warn('short', name); continue; }
      if (start < cursor) { warn('overlaps', name); continue; }
      if (count === 999) { warn('edlLimit', name); continue; }
      cursor = end;
      if (!reels.has(m.path)) {
        const base = stem(m.path).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'REEL';
        let reel = base.slice(0, 8);
        for (let suffix = 2; used.has(reel); suffix++) reel = base.slice(0, 8 - String(suffix).length) + suffix;
        reels.set(m.path, reel);
        used.add(reel);
      }
      const reel = reels.get(m.path);
      const channel = hasAudio && volume > 0 ? (m.audioChannels > 1 ? 'AA/V' : 'B') : 'V';
      if (hasAudio && volume > 0 && m.audioChannels > 2) warn('channels', name);
      const source = framesAt(it.in || 0, fps);
      lines.push(`${String(++count).padStart(3, '0')}  ${reel.padEnd(8)} ${channel.padEnd(4)} C        ${tc(source)} ${tc(source + end - start)} ${tc(start)} ${tc(end)}`,
        '* FROM CLIP NAME: ' + line(basename(m.path)), '');
    }
    return lines.join('\n') + '\n';
  }

  const schema = (type, fields) => ({ OTIO_SCHEMA: type, ...fields });
  const item = (type, name, fields) => schema(type, { name, metadata: {}, effects: [], markers: [], source_range: null, ...fields });

  function exportOTIO(project, rows, warn) {
    const [num, den] = fpsRatio(project.fps);
    const rate = num / den;
    const rt = time => schema('RationalTime.1', { value: time * rate, rate });
    const range = (start, duration) => schema('TimeRange.1', { start_time: rt(start), duration: rt(duration) });
    const duration = S.projectDur(project);
    const tracks = [];
    function track(row, companion = false) {
      let cursor = 0;
      const children = [];
      const gap = dur => children.push(item('Gap.1', '', { source_range: range(0, dur) }));
      for (const { it, m, name, hasAudio, volume } of row.clips) {
        if (companion && (!hasAudio || !volume)) continue;
        if (it.start < cursor - 1e-8) { warn('overlaps', name); continue; }
        if (it.start > cursor + 1e-8) gap(it.start - cursor);
        const reference = schema('ExternalReference.1', { name: m.name || '', metadata: { maqto: { kind: m.kind, hasAudio } },
          target_url: fileURL(m.path), available_range: m.dur ? range(0, m.dur) : null, available_image_bounds: null });
        children.push(item('Clip.2', name, { source_range: range(it.in || 0, it.dur),
          metadata: { maqto: { muted: !volume } }, enabled: row.kind !== 'audio' || volume > 0,
          active_media_reference_key: 'DEFAULT_MEDIA', media_references: { DEFAULT_MEDIA: reference } }));
        cursor = it.start + it.dur;
      }
      if (duration > cursor + 1e-8) gap(duration - cursor);
      return item('Track.1', companion ? row.id + ' audio' : row.id, {
        kind: companion || row.kind === 'audio' ? 'Audio' : 'Video', children,
        metadata: { maqto: companion ? { embeddedAudio: true } : { track: row.id } } });
    }
    for (const row of rows) {
      tracks.push(track(row));
      if (row.kind === 'video' && row.clips.some(clip => clip.hasAudio && clip.volume)) tracks.push(track(row, true));
    }
    const markers = S.normalizeMarkers(project.markers).map(mark => schema('Marker.2', {
      name: mark.name, color: ({ red: 'RED', orange: 'ORANGE', yellow: 'YELLOW', green: 'GREEN', blue: 'BLUE', purple: 'PURPLE' })[mark.color] || 'RED',
      metadata: { maqto: { color: mark.color, note: mark.note } }, marked_range: range(mark.time, 0),
    }));
    return schema('Timeline.1', { name: project.name || 'Maqto', metadata: { maqto: { width: project.w, height: project.h } },
      global_start_time: rt(0), tracks: item('Stack.1', 'Tracks', { children: tracks, markers }) });
  }

  function exportTimeline(project, format) {
    if (!Object.hasOwn(formats, format)) throw new Error('Unknown timeline format');
    const { warnings, warn } = warningList();
    const rows = exportRows(project, format, warn);
    const content = ({ fcpxml: exportFCPXML, edl: exportEDL, otio: exportOTIO })[format](project, rows, warn);
    return { text: format === 'otio' ? JSON.stringify(content, null, 2) + '\n' : content, warnings };
  }

  const validRate = rate => Number.isFinite(rate) && rate >= 1 && rate <= 240;
  const imagePath = path => /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i.test(path);
  function importedProject(info, clips, markers, timelinePath, warn) {
    const items = [], media = {}, sources = new Map(), lanes = new Map();
    for (const clip of clips) {
      const { ref, name, lane, kind, in: source, start, dur, speed = 1, volume = 1, muted = false, hidden = false } = clip;
      const path = localPath(ref, timelinePath);
      if (!path) { warn('media', name || ref || '—'); continue; }
      const headTrim = Math.max(0, -start);
      if (!(dur > headTrim)) continue;
      const trackKind = kind === 'audio' ? 'audio' : 'video';
      const mediaKind = kind === 'video' && imagePath(path) ? 'image' : kind;
      const key = trackKind + lane;
      if (!lanes.has(key)) lanes.set(key, { kind: trackKind, lane });
      const mediaKey = mediaKind + '\0' + path;
      if (!sources.has(mediaKey)) {
        const id = 'm' + (sources.size + 1);
        sources.set(mediaKey, id);
        media[id] = { path, name: clip.mediaName || basename(path) || name, kind: mediaKind, hasAudio: clip.hasAudio ?? (mediaKind !== 'image'),
          dur: clip.sourceDuration || 0, w: clip.w || info.w || 0, h: clip.h || info.h || 0, fps: clip.fps || info.fps };
      }
      const id = sources.get(mediaKey);
      const sourceStart = Math.max(0, source + headTrim * speed);
      if (mediaKind !== 'image') media[id].dur = Math.max(media[id].dur, clip.sourceDuration || 0, sourceStart + (dur - headTrim) * speed);
      items.push({ id: 'i' + (items.length + 1), media: id, track: key,
        start: Math.max(0, start), in: sourceStart, dur: dur - headTrim, speed, volume, muted, hidden });
    }
    if (!lanes.has('video0')) lanes.set('video0', { kind: 'video', lane: 0 });
    const ordered = [...lanes.entries()].sort(([, a], [, b]) => a.kind.localeCompare(b.kind) || a.lane - b.lane);
    let v = 1, a = 1;
    const tracks = [];
    for (const [key, lane] of ordered) {
      const track = { kind: lane.kind, id: lane.kind === 'video' ? 'v' + v++ : 'a' + a++ };
      lanes.set(key, track);
      if (track.kind === 'video') tracks.unshift(track);
      else tracks.push(track);
    }
    for (const it of items) it.track = lanes.get(it.track).id;
    return { ...info, items, media, tracks, markers: S.normalizeMarkers(markers) };
  }

  const otioType = value => typeof value?.OTIO_SCHEMA === 'string' ? value.OTIO_SCHEMA.split('.')[0] : '';
  const rtSeconds = value => value?.rate > 0 && Number.isFinite(value.value) ? value.value / value.rate : 0;

  function importOTIO(timeline, timelinePath) {
    if (otioType(timeline) !== 'Timeline' || otioType(timeline.tracks) !== 'Stack' || !Array.isArray(timeline.tracks.children)) {
      throw new Error('Invalid OpenTimelineIO timeline');
    }
    const { warnings, warn } = warningList();
    const clips = [], markers = [];
    const rows = timeline.tracks.children.filter(row => {
      if (otioType(row) === 'Track') return !row.metadata?.maqto?.embeddedAudio;
      warn('media', row?.name || otioType(row) || '—');
      return false;
    });
    const hasAudioTrack = rows.some(row => row.kind === 'Audio' && row.children?.some(child => otioType(child) === 'Clip'));
    const rates = [timeline.global_start_time?.rate];
    for (const row of [...rows.filter(row => row.kind !== 'Audio'), ...rows.filter(row => row.kind === 'Audio')]) {
      for (const child of row.children || []) if (otioType(child) === 'Clip') rates.push(child.source_range?.duration?.rate);
    }
    const info = { name: timeline.name || (timelinePath && stem(timelinePath)), fps: rates.find(validRate) || 30 };
    const { width, height } = timeline.metadata?.maqto || {};
    if (width > 0 && height > 0) Object.assign(info, { w: width, h: height });
    function readMarkers(owner, base, origin = 0, limit = Infinity) {
      for (const marker of owner.markers || []) {
        const local = rtSeconds(marker.marked_range?.start_time);
        if (local < origin || local >= limit) continue;
        const meta = marker.metadata?.maqto || {};
        markers.push({ time: base + (local - origin), name: marker.name, note: meta.note,
          color: meta.color || marker.color?.toLowerCase() });
      }
    }
    readMarkers(timeline.tracks, 0);
    let videoLane = 0, audioLane = 0;
    for (const row of rows) {
      const audio = row.kind === 'Audio', lane = audio ? audioLane++ : videoLane++;
      const trim = rtSeconds(row.source_range?.start_time);
      const end = row.source_range ? trim + rtSeconds(row.source_range.duration) : Infinity;
      readMarkers(row, 0, trim, end);
      let cursor = 0;
      for (const child of row.children || []) {
        const type = otioType(child), name = child?.name || type || '—';
        if (type === 'Transition') { warn('transitions', name); continue; }
        const refs = child?.media_references;
        const ref = child?.media_reference || (refs && (refs[child.active_media_reference_key] || refs.DEFAULT_MEDIA || Object.values(refs)[0]));
        const range = child?.source_range || ref?.available_range;
        const childDuration = rtSeconds(range?.duration), childEnd = cursor + childDuration;
        const from = Math.max(cursor, trim), to = Math.min(end, childEnd);
        const sourceStart = rtSeconds(range?.start_time) + (from - cursor);
        const duration = from === cursor && to === childEnd ? childDuration : to - from;
        cursor = childEnd;
        if (to <= from) {
          if (type !== 'Gap' && !range) warn('media', name);
          continue;
        }
        readMarkers(child, from - trim, sourceStart, sourceStart + to - from);
        if (type === 'Gap') continue;
        if (type !== 'Clip' || otioType(ref) !== 'ExternalReference') {
          warn('media', name); continue;
        }
        if (child.effects?.length) warn('effects', name);
        const meta = ref.metadata?.maqto || {};
        clips.push({ ref: ref.target_url, name, mediaName: ref.name, lane, kind: audio ? 'audio' : meta.kind || 'video',
          hasAudio: audio || meta.hasAudio, in: sourceStart - rtSeconds(ref.available_range?.start_time), start: from - trim,
          dur: duration,
          sourceDuration: rtSeconds(ref.available_range?.duration), hidden: !audio && child.enabled === false,
          muted: child.metadata?.maqto?.muted ?? (audio ? child.enabled === false : hasAudioTrack) });
      }
    }
    return { project: importedProject(info, clips, markers, timelinePath, warn), warnings };
  }

  function importFCPXML(text, timelinePath) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const root = doc.documentElement;
    const direct = (node, tag) => node && [...node.children].find(n => n.localName === tag);
    const firstProject = root?.getElementsByTagName('project')[0];
    const sequence = direct(firstProject, 'sequence'), spine = direct(sequence, 'spine');
    if (root?.localName !== 'fcpxml' || root.getElementsByTagName('parsererror').length || !spine) throw new Error('Invalid FCPXML project');
    const { warnings, warn } = warningList();
    const clips = [], markers = [];
    const attr = (node, name) => node?.getAttribute(name);
    const resources = new Map([...(direct(root, 'resources')?.children || [])].map(node => [attr(node, 'id'), node]));
    const time = (node, name, fallback) => seconds(attr(node, name), fallback);
    const format = resources.get(attr(sequence, 'format'));
    const rate = 1 / time(format, 'frameDuration');
    const info = { name: attr(firstProject, 'name') || (timelinePath && stem(timelinePath)), fps: validRate(rate) ? rate : 30 };
    const width = +attr(format, 'width'), height = +attr(format, 'height');
    if (width > 0 && height > 0) Object.assign(info, { w: width, h: height });
    const storyTypes = new Set(['asset-clip', 'clip', 'video', 'audio', 'gap', 'spine', 'title', 'caption', 'transition', 'ref-clip', 'sync-clip', 'mc-clip', 'audition']);
    const tcStart = time(sequence, 'tcStart');
    function readMarkers(node, start, origin) {
      for (const marker of node.children) if (['marker', 'chapter-marker'].includes(marker.localName)) {
        markers.push({ time: start + time(marker, 'start') - origin, name: attr(marker, 'value'), note: attr(marker, 'note') });
      }
    }
    function walk(node, base, origin, inheritedLane, sequential) {
      let cursor = base;
      for (const child of node.children) {
        const type = child.localName;
        if (!storyTypes.has(type)) continue;
        const start = attr(child, 'offset') ? base + time(child, 'offset') - origin : sequential ? cursor : base;
        const lane = inheritedLane + (+attr(child, 'lane') || 0);
        const name = attr(child, 'name') || type;
        if (type === 'transition') { warn('transitions', name); continue; }
        if (type === 'spine') { walk(child, start, 0, lane, true); continue; }
        const children = [...child.children];
        const picture = type === 'clip' && children.find(n => n.localName === 'video' && !+attr(n, 'lane'));
        const sound = type === 'clip' && children.find(n => n.localName === 'audio' && !+attr(n, 'lane'));
        const component = picture || sound || null;
        const asset = resources.get(attr(component || child, 'ref'));
        const assetStart = time(asset, 'start');
        const local = time(child, 'start', time(component, 'start', assetStart));
        const dur = time(child, 'duration', time(component, 'duration', time(asset, 'duration')));
        if (sequential) cursor = Math.max(cursor, start + dur);
        readMarkers(child, start, local);
        if (type === 'gap') { walk(child, start, local, lane, false); continue; }
        if (type === 'title' || type === 'caption') { warn('titles', name); continue; }
        if (asset?.localName !== 'asset') { warn('media', name); continue; }
        const sourceType = (component || child).localName;
        const enabled = attr(child, 'srcEnable');
        const hasAudio = sourceType === 'audio' || attr(asset, 'hasAudio') === '1';
        const kind = sourceType === 'audio' || enabled === 'audio' || (sourceType !== 'video' && attr(asset, 'hasVideo') !== '1' && hasAudio) ? 'audio' : 'video';
        const gain = direct(child, 'adjust-volume') || direct(component, 'adjust-volume');
        const db = Number.parseFloat(attr(gain, 'amount'));
        const silent = enabled === 'video' || type === 'video' || (picture && sound) || db <= -96;
        const map = direct(child, 'timeMap') || direct(component, 'timeMap');
        let source = component ? time(component, 'start', local) + local - time(component, 'offset', local) : local;
        let speed = 1;
        if (map) {
          const points = [...map.children].filter(point => point.localName === 'timept');
          const dx = time(points[1], 'time') - time(points[0], 'time');
          const dy = time(points[1], 'value') - time(points[0], 'value');
          if (points.length === 2 && attr(points[0], 'interp') === 'linear' && dx > 0 && dy > 0) {
            speed = dy / dx;
            source = time(points[0], 'value') + (local - time(points[0], 'time')) * speed;
          } else { warn('curves', name); if (points.length) source = time(points[0], 'value'); }
        }
        if (children.some(n => n.localName.startsWith('filter-') || n.localName.startsWith('adjust-') && n !== gain) ||
            gain?.children.length || attr(child, 'audioStart') || attr(child, 'audioDuration')) warn('effects', name);
        const original = [...asset.children].find(n => n.localName === 'media-rep' && attr(n, 'kind') !== 'proxy-media');
        const assetFormat = resources.get(attr(asset, 'format'));
        clips.push({ ref: attr(original, 'src') || attr(asset, 'src'), name, mediaName: attr(asset, 'name'),
          lane: kind === 'audio' ? Math.abs(lane) : lane, kind, hasAudio, start, dur, in: source - assetStart,
          speed, volume: Number.isFinite(db) && db > -96 ? 10 ** (db / 20) : 1, muted: !!silent || kind === 'audio' && attr(child, 'enabled') === '0',
          hidden: kind !== 'audio' && attr(child, 'enabled') === '0', sourceDuration: time(asset, 'duration'),
          w: +attr(assetFormat, 'width'), h: +attr(assetFormat, 'height'), fps: 1 / time(assetFormat, 'frameDuration', 1 / info.fps) });
        if (component) {
          readMarkers(component, start, source);
          walk(component, start, source, lane, false);
        }
        walk(component ? { children: children.filter(n => n !== component) } : child, start, local, lane, false);
      }
    }
    readMarkers(sequence, 0, tcStart);
    readMarkers(spine, 0, tcStart);
    walk(spine, 0, tcStart, 0, true);
    return { project: importedProject(info, clips, markers, timelinePath, warn), warnings };
  }

  const api = { formats, seconds, frameTime, framesAt, edlTimecode, exportTimeline, importOTIO, importFCPXML };
  if (typeof module !== 'undefined') module.exports = api;
  else root.MaqtoInterchange = api;
})(globalThis);

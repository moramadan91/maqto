'use strict';
// "What's new" tour data. To ship the next release, append ONE entry to WHATS_NEW:
//   { version: '1.0.42', steps: [{ target: '<css selector>', panel: '<dock panel id, optional>', ar: { title, body }, en: { title, body } }] }
// Users who update see the steps of every release newer than the one they last saw. No target = centred card
// (use it for things with no on-screen element, like the native menu bar). Keep each body to 1-2 sentences.
(() => {
  const WHATS_NEW = [{
    version: '1.0.41',
    steps: [
      { target: '#bQueue',
        ar: { title: 'قائمة التصدير', body: 'ضيف كذا تصدير في القائمة وصدّر الكل مرة واحدة وإنت بتكمل شغلك.' },
        en: { title: 'Render queue', body: 'Line up several exports and render them all in one go while you keep working.' } },
      { target: '#bExport',
        ar: { title: 'إعدادات جاهزة وجهارة الصوت', body: 'من شاشة التصدير احفظ إعداداتك كـ Preset واضبط جهارة الصوت النهائية (LUFS) قبل ما تصدّر.' },
        en: { title: 'Export presets and loudness', body: 'In the export dialog, save your settings as a preset and set the master loudness (LUFS) before you export.' } },
      { target: '#markerPanel summary', panel: 'media',
        ar: { title: 'الماركرات وفصول يوتيوب', body: 'كل ماركراتك هنا، وتقدر تنسخ منها فصول يوتيوب جاهزة أو تضمّنها في الفيديو.' },
        en: { title: 'Markers and YouTube chapters', body: 'All your markers live here, and you can copy ready-made YouTube chapters or embed them in the video.' } },
      { target: '#scopes', panel: 'scopes',
        ar: { title: 'مقاييس الفيديو', body: 'شوف الألوان والإضاءة بالأرقام (Waveform وVectorscope) عشان تظبط الكلر بدقة.' },
        en: { title: 'Scopes', body: 'Check color and exposure with waveform and vectorscope plots so your grade is accurate.' } },
      { target: '#transcript', panel: 'transcript',
        ar: { title: 'المونتاج بالنص', body: 'عدّل الفيديو من الكلام المكتوب، وامسح السكتات وكلمات الحشو (إ، ااا) بضغطة.' },
        en: { title: 'Transcript editing', body: 'Edit the video by editing its text, and remove silences and filler words in one click.' } },
      { target: '#multicam', panel: 'multicam',
        ar: { title: 'الكاميرات المتعددة', body: 'زامن كذا زاوية وبدّل بينها وهو شغال، والقطعات بتتسجل على التايملاين.' },
        en: { title: 'Multicam', body: 'Sync several angles and switch between them as it plays; your cuts are recorded to the timeline.' } },
      { target: '#tl .tools .seg',
        ar: { title: 'أدوات القص', body: 'Ripple وRoll وSlip وSlide لضبط القطعات بدقة من غير ما تبوّظ باقي التايملاين.' },
        en: { title: 'Trim tools', body: 'Ripple, Roll, Slip and Slide fine-tune your edits without breaking the rest of the timeline.' } },
      { target: '#bProxy',
        ar: { title: 'البروكسي', body: 'شغّل نسخ خفيفة من الكليبات التقيلة عشان المعاينة تمشي سلسة، والتصدير بيستخدم الأصل.' },
        en: { title: 'Proxies', body: 'Use light copies of heavy clips for smooth playback; the export still uses the originals.' } },
      { target: '#smartReframe',
        ar: { title: 'إعادة تأطير ذكية', body: 'غيّر المقاس (مثلاً 9:16) والبرنامج يتابع الشخص ويبقيه في الكادر.' },
        en: { title: 'Smart reframe', body: 'Change the aspect (say 9:16) and Maqto follows the subject to keep it in frame.' } },
      { target: '#bKeys',
        ar: { title: 'اختصارات الكيبورد', body: 'شوف كل الاختصارات وغيّرها، أو اختار مجموعة جاهزة زي Premiere وFinal Cut.' },
        en: { title: 'Keyboard shortcuts', body: 'Browse and remap every shortcut, or pick a ready set like Premiere or Final Cut.' } },
      { // native menu bar, nothing to point at inside the window
        ar: { title: 'تصدير التايملاين', body: 'من قايمة ملف (File) اختار «تصدير التايملاين» لـ FCPXML أو EDL أو OTIO وكمّل في برنامج تاني.' },
        en: { title: 'Export timeline', body: 'From the File menu choose "Export Timeline As…" to send your edit to other apps as FCPXML, EDL or OTIO.' } },
      { target: '#fontBtn',
        ar: { title: 'كل الخطوط', body: 'اختار أي نص وافتح قايمة الخطوط: كل خطوط جهازك وجوجل ظاهرة وتقدر تدوّر فيها.' },
        en: { title: 'Every font', body: 'Select a text and open the font list: all your system and Google fonts show up and are searchable.' } },
    ],
  }];

  const parts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
  const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; } return 0; };
  // Steps of every release in (seen, current]; a fresh install (no seen) gets none.
  const pendingSteps = (entries, seen, current) => !seen ? [] : entries
    .filter(e => cmp(e.version, seen) > 0 && cmp(e.version, current) <= 0)
    .sort((a, b) => cmp(a.version, b.version)).flatMap(e => e.steps);
  // Replay: the newest entry not above the running version.
  const replaySteps = (entries, current) => (entries.filter(e => cmp(e.version, current) <= 0).sort((a, b) => cmp(b.version, a.version))[0] || { steps: [] }).steps;

  const api = { WHATS_NEW, cmp, pendingSteps, replaySteps };
  if (typeof module === 'object') module.exports = api;
  else window.MaqtoWhatsNew = api;
})();

'use strict';
// Append one { version, steps } entry per release. Give each step a stable id, an icon,
// SVG art, and ar/en title, body and where text. Add a target selector and dock panel
// when Show me can reveal a control in the editor.
(() => {
  const accent = 'stroke="var(--accent)"';
  const rect = (x, y, w, h, attr = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ${attr}/>`;
  const path = (d, attr = '') => `<path d="${d}" ${attr}/>`;
  const bars = (heights, x, y, gap, attr = '') => heights.map((h, i) => path(`M${x + i * gap} ${y - h}v${2 * h}`, attr)).join('');
  const scenes = {
    collect: () => rect(48, 56, 112, 88) + path('M64 78h80M64 98h80M64 118h50') + path('M176 100h40m-8-8 8 8-8 8', 'stroke="var(--accent)"') + rect(232, 70, 82, 60, 'stroke="var(--accent)"') + path('M246 92h54M246 108h34', 'stroke="var(--accent)"'),
    queue: () => [0, 1, 2].map((n) => rect(74, 39 + n * 43, 212, 34, n ? '' : accent) +
      path(`M91 ${55 + n * 43}h58m92 0 7 6 12-12`, n ? '' : accent)).join(''),
    loudness: () => rect(45, 42, 270, 116) + path('M58 100h244', 'opacity=".35"') +
      bars([10, 18, 29, 19, 34, 25, 39, 30, 15, 24, 12, 6, 16, 9, 14, 5], 66, 100, 15, accent),
    voice: () => rect(47, 48, 266, 104) +
      bars([9, 15, 9, 23, 17, 29, 13, 24, 7, 15, 9], 65, 100, 10) +
      path('M176 100h18m-5-5 5 5-5 5') +
      bars([3, 4, 3, 19, 12, 24, 9, 18, 3, 4, 3], 202, 100, 9, accent),
    chapters: () => rect(45, 82, 270, 65) + path('M45 103h270m-183 0v44m94-44v44') +
      [73, 159, 249].map(x => path(`M${x} 124V49h30l-8 9 8 9h-30`, accent)).join(''),
    scopes: () => '<circle cx="180" cy="100" r="65"/><circle cx="180" cy="100" r="41" opacity=".45"/>' +
      path('M115 100h130m-65-65v130', 'opacity=".45"') + path('M139 120q36-13 48-47t29-10l-13 30 28 18-57 4-35 5Z', accent),
    translation: () => rect(66, 48, 228, 44) + rect(66, 108, 228, 44, accent) +
      path('M85 66h106m-106 12h156M85 126h142m-142 12h92', accent),
    transcript: () => rect(70, 38, 220, 124) + path('M93 64h140m-140 24h174m-174 24h43m62 0h48m-153 24h115') +
      rect(143, 101, 47, 22, accent) + path('M149 112h35', accent),
    multicam: () => [0, 1, 2, 3].map(n => {
      const x = 63 + n % 2 * 121, y = 34 + Math.floor(n / 2) * 70;
      const style = n === 1 ? accent : '';
      return rect(x, y, 113, 62, style) + path(`M${x + 9} ${y + 51}l25-24 17 14 17-18 35 28M${x + 10} ${y + 11}h10`, style);
    }).join(''),
    trim: () => rect(44, 81, 124, 53) + rect(172, 81, 144, 53) +
      path('M170 57v99m-12-45h-44l10-10m-10 10 10 10m58-10h44l-10-10m10 10-10 10', accent),
    proxy: () => rect(58, 54, 108, 88) + rect(222, 76, 80, 45, accent) +
      path('M69 130l27-29 19 14 17-24 23 39m20-32h36l-10-10m10 10-10 10') +
      path('M230 112l20-16 13 7 10-10 19 19', accent),
    reframe: () => rect(55, 43, 250, 114) + path('M65 139l55-47 34 25m58 4 44-32 39 50', 'opacity=".5"') +
      rect(141, 34, 76, 132, accent) + '<circle cx="179" cy="80" r="13"/>' + path('M153 135v-8a26 26 0 0 1 52 0v8'),
    keys: () => rect(61, 58, 238, 84) + [0, 1].flatMap(row => Array.from({ length: 8 }, (_, n) =>
      rect(73 + n * 28, 68 + row * 25, 21, 17, n === 3 && row === 0 ? accent : ''))).join('') + path('M126 126h108'),
    interchange: () => rect(54, 63, 121, 77) + path('M64 82h44v14H64zM113 82h51v14h-51zM64 106h65v14H64z') +
      path('M185 102h40m-10-10 10 10-10 10', accent) + path('M240 62h43l22 22v58h-65Zm43 0v22h22m-55 18h44m-44 13h32'),
    fonts: () => rect(57, 46, 246, 108) + path('M79 126l33-57 33 57m-53-21h40', accent) +
      path('M180 75h96m-96 25h75m-75 25h96'),
    object: () => rect(47, 36, 266, 128) + path('M96 134l31-29 20 14 33-46 37 32 21-21 31 50', 'opacity=".4"') +
      rect(135, 63, 91, 70, accent) + path('M173 98h14m-7-7v14m61 11h26m-8-8 8 8-8 8', accent),
    remove: () => rect(46, 46, 119, 108) + rect(195, 46, 119, 108) +
      path('M54 137l42-42 21 21 20-20 20 24m46 17 42-42 21 21 20-20 20 24', 'opacity=".55"') +
      rect(83, 75, 46, 38, accent) + path('M171 100h18m-6-6 6 6-6 6', accent),
    depth: () => rect(49, 40, 262, 120) + path('M50 127l66-52 47 34 47-44 100 75', 'opacity=".35"') +
      path('M50 147l64-31 49 18 47-22 100 38', 'opacity=".6"') + rect(136, 72, 86, 60, accent) +
      path('M173 102h14m-7-7v14', accent),
    upscale: () => rect(51, 69, 100, 66) + rect(195, 40, 117, 124, accent) +
      path('M164 102h19m-7-7 7 7-7 7', accent) + path('M59 123l29-28 28 21 27-16M204 148l29-43 27 24 43-47', accent),
    scenes: () => rect(40, 70, 280, 60) + [0, 1, 2, 3, 4, 5, 6].map(n => path(`M${52 + n * 40} 76h12m-12 48h12`)).join('') +
      path('M130 70v60m100-60v60', accent) + path('M130 58v-12m100 12v-12m-111 0h22m89 0h22', accent) + path('M150 90h60m-60 20h40', 'opacity=".45"'),
    shorts: () => rect(30, 30, 300, 36) + path('M70 30v36m80-36v36m80-36v36', 'opacity=".45"') + rect(70, 30, 80, 36, accent) +
      path('M110 76v10m-9-3 9 9 9-9', accent) +
      [0, 1, 2].map(n => rect(62 + n * 80, 100, 56, 86, n === 0 ? accent : '') + path(`M${74 + n * 80} 168h32`, n === 0 ? accent : '') + `<circle cx="${90 + n * 80}" cy="130" r="8"/>`).join(''),
    grade: () => rect(40, 44, 130, 112) + path('M50 146C90 140 120 60 160 54', accent) + path('M50 146h110M50 100h110', 'opacity=".25"') +
      '<circle cx="105" cy="98" r="5" fill="var(--accent)"/>' + rect(196, 44, 124, 112) + path('M206 70l30 30-30 30M244 70v60', 'opacity=".4"') +
      path('M262 66h46M262 100h46M262 134h46', accent) + '<circle cx="262" cy="66" r="4"/><circle cx="296" cy="100" r="4"/><circle cx="278" cy="134" r="4"/>',
    ai: () => rect(56, 63, 79, 79, accent) + path('M72 63v-11m23 11v-11m23 11v-11m-46 90v11m23-11v11m23-11v11m17-74h11m-11 23h11m-11 23h11m-90-46H45m11 23H45m11 23H45') +
      path('M95 80l6 16 16 6-16 6-6 16-6-16-16-6 16-6Z', accent) +
      [0, 1, 2].map(n => rect(171, 42 + n * 42, 144, 32) + path(`M184 ${58 + n * 42}h65m36 0h16`, n === 0 ? accent : '')).join(''),
    record: () => rect(40, 48, 190, 112) + '<circle cx="135" cy="104" r="22" stroke="var(--accent)"/><circle cx="135" cy="104" r="8" fill="var(--accent)"/>' +
      rect(246, 98, 74, 52, accent) + path('M258 132h50', 'opacity=".5"') + path('M60 70h40', 'opacity=".35"'),
    alpha: () => rect(45, 45, 270, 110) + path('M45 100h270M180 45v110', 'opacity=".25"') +
      '<circle cx="180" cy="100" r="34" stroke="var(--accent)"/>' + path('M84 128l26-24 18 14m92-30 22-14', 'opacity=".5"') + path('M166 100h28m-14-14v28', accent),
  };
  const art = kind => `<svg viewBox="0 0 360 200" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${scenes[kind]()}</svg>`;

  const WHATS_NEW = [{
    version: '1.0.41',
    steps: [
      { id: 'queue', icon: 'list', art: art('queue'), target: '#bQueue',
        where: { ar: 'الشريط العلوي ← قائمة التصدير', en: 'Top bar → Render queue' },
        ar: { title: 'قائمة التصدير', body: 'ضيف كذا تصدير في القائمة وصدّر الكل مرة واحدة وإنت بتكمل شغلك.' },
        en: { title: 'Render queue', body: 'Line up several exports and render them all in one go while you keep working.' } },
      { id: 'loudness', icon: 'volume-2', art: art('loudness'), target: '#bExport',
        where: { ar: 'الشريط العلوي ← تصدير', en: 'Top bar → Export' },
        ar: { title: 'إعدادات جاهزة وجهارة الصوت', body: 'من شاشة التصدير احفظ إعداداتك كـ Preset واضبط جهارة الصوت النهائية (LUFS) قبل ما تصدّر.' },
        en: { title: 'Export presets and loudness', body: 'In the export dialog, save your settings as a preset and set the master loudness (LUFS) before you export.' } },
      { id: 'chapters', icon: 'bookmark', art: art('chapters'), target: '#markerPanel summary', panel: 'media',
        where: { ar: 'المكتبة ← الوسائط ← الماركرات', en: 'Library → Media → Markers' },
        ar: { title: 'الماركرات وفصول يوتيوب', body: 'كل ماركراتك هنا، وتقدر تنسخ منها فصول يوتيوب جاهزة أو تضمّنها في الفيديو.' },
        en: { title: 'Markers and YouTube chapters', body: 'All your markers live here, and you can copy ready-made YouTube chapters or embed them in the video.' } },
      { id: 'scopes', icon: 'scan', art: art('scopes'), target: '#scopes', panel: 'scopes',
        where: { ar: 'لوحة مقاييس الفيديو', en: 'Scopes dock panel' },
        ar: { title: 'مقاييس الفيديو', body: 'شوف الألوان والإضاءة بالأرقام (Waveform وVectorscope) عشان تظبط الكلر بدقة.' },
        en: { title: 'Scopes', body: 'Check color and exposure with waveform and vectorscope plots so your grade is accurate.' } },
      { id: 'transcript', icon: 'captions', art: art('transcript'), target: '#transcript', panel: 'transcript',
        where: { ar: 'لوحة المونتاج بالنص', en: 'Transcript dock panel' },
        ar: { title: 'المونتاج بالنص', body: 'عدّل الفيديو من الكلام المكتوب، وامسح السكتات وكلمات الحشو (إ، ااا) بضغطة.' },
        en: { title: 'Transcript editing', body: 'Edit the video by editing its text, and remove silences and filler words in one click.' } },
      { id: 'multicam', icon: 'layout-grid', art: art('multicam'), target: '#multicam', panel: 'multicam',
        where: { ar: 'لوحة الكاميرات المتعددة', en: 'Multicam dock panel' },
        ar: { title: 'الكاميرات المتعددة', body: 'زامن كذا زاوية وبدّل بينها وهو شغال، والقطعات بتتسجل على التايملاين.' },
        en: { title: 'Multicam', body: 'Sync several angles and switch between them as it plays; your cuts are recorded to the timeline.' } },
      { id: 'trim', icon: 'scissors', art: art('trim'), target: '#tl .tools .seg', panel: 'tl',
        where: { ar: 'التايملاين ← أدوات القص', en: 'Timeline → Trim tools' },
        ar: { title: 'أدوات القص', body: 'Ripple وRoll وSlip وSlide لضبط القطعات بدقة من غير ما تبوّظ باقي التايملاين.' },
        en: { title: 'Trim tools', body: 'Ripple, Roll, Slip and Slide fine-tune your edits without breaking the rest of the timeline.' } },
      { id: 'proxy', icon: 'film', art: art('proxy'), target: '#bProxy', panel: 'player',
        where: { ar: 'المعاينة ← البروكسي', en: 'Preview → Proxies' },
        ar: { title: 'البروكسي', body: 'شغّل نسخ خفيفة من الكليبات التقيلة عشان المعاينة تمشي سلسة، والتصدير بيستخدم الأصل.' },
        en: { title: 'Proxies', body: 'Use light copies of heavy clips for smooth playback; the export still uses the originals.' } },
      { id: 'reframe', icon: 'crop', art: art('reframe'), target: '#smartReframe', panel: 'player',
        where: { ar: 'المعاينة ← المقاس ← إعادة تأطير ذكية', en: 'Preview → Aspect → Smart reframe' },
        ar: { title: 'إعادة تأطير ذكية', body: 'غيّر المقاس (مثلاً 9:16) والبرنامج يتابع الشخص ويبقيه في الكادر.' },
        en: { title: 'Smart reframe', body: 'Change the aspect (say 9:16) and Maqto follows the subject to keep it in frame.' } },
      { id: 'keys', icon: 'keyboard', art: art('keys'), target: '#bKeys',
        where: { ar: 'الشريط العلوي ← اختصارات الكيبورد', en: 'Top bar → Keyboard shortcuts' },
        ar: { title: 'اختصارات الكيبورد', body: 'شوف كل الاختصارات وغيّرها، أو اختار مجموعة جاهزة زي Premiere وFinal Cut.' },
        en: { title: 'Keyboard shortcuts', body: 'Browse and remap every shortcut, or pick a ready set like Premiere or Final Cut.' } },
      { id: 'interchange', icon: 'share', art: art('interchange'),
        where: { ar: 'ملف ← تصدير التايملاين', en: 'File → Export Timeline As…' },
        ar: { title: 'تصدير التايملاين', body: 'من قايمة ملف (File) اختار «تصدير التايملاين» لـ FCPXML أو EDL أو OTIO وكمّل في برنامج تاني.' },
        en: { title: 'Export timeline', body: 'From the File menu choose "Export Timeline As…" to send your edit to other apps as FCPXML, EDL or OTIO.' } },
      { id: 'fonts', icon: 'type', art: art('fonts'), target: '#fontBtn', panel: 'insp',
        where: { ar: 'اختار نص ← الخصائص ← الخط', en: 'Select a text clip → Inspector → Font' },
        ar: { title: 'كل الخطوط', body: 'اختار أي نص وافتح قايمة الخطوط: كل خطوط جهازك وجوجل ظاهرة وتقدر تدوّر فيها.' },
        en: { title: 'Every font', body: 'Select a text and open the font list: all your system and Google fonts show up and are searchable.' } },
    ],
  }, {
    version: '1.0.42',
    steps: [
      { id: 'aiTools', icon: 'sparkles', art: art('ai'), target: '[data-dock-tab="aiTools"]', panel: 'aiTools',
        where: { ar: 'المكتبة ← أدوات الذكاء الاصطناعي', en: 'Library → AI Tools' },
        ar: { title: 'أدوات الذكاء الاصطناعي', body: 'كل أدوات الذكاء الاصطناعي في لوحة واحدة. شوف حالة النماذج، نزّل اللي تحتاجه، وافتح الأداة للكليب اللي اخترته.' },
        en: { title: 'AI Tools', body: 'Find Maqto’s AI editing tools in one panel. Check model status, download the models you need, and open a tool for your selected clips.' } },
      { id: 'selectObject', icon: 'crosshair', art: art('object'), target: '[data-ai-tool="select-object"]', panel: 'aiTools',
        where: { ar: 'الخصائص ← الفيديو ← تحديد عنصر', en: 'Inspector → Video → Select object' },
        ar: { title: 'تحديد عنصر', body: 'اضغط على عنصر أو ارسم مربع حواليه، وتتبّعه في الكليب. اعزله أو بكسله أو خلّي لونه بارز.' },
        en: { title: 'Select object', body: 'Click an object or draw a box around it, then track it through the clip. Cut it out, pixelate it, or keep its colour against a greyscale background.' } },
      { id: 'removeObject', icon: 'wand-sparkles', art: art('remove'), target: '[data-ai-tool="remove-object"]', panel: 'aiTools',
        where: { ar: 'الخصائص ← الفيديو ← تحديد عنصر', en: 'Inspector → Video → Select object' },
        ar: { title: 'إزالة عنصر وملء مكانه', body: 'حدّد العنصر أو لوّن المنطقة بالفرشاة. استخدم إزالة العلامة المائية للعلامات الثابتة، وقلّل الوميض في الفيديو.' },
        en: { title: 'Remove an object and fill the gap', body: 'Select an object or paint the area with Brush. Use Remove watermark for fixed logos and Smooth flicker for video.' } },
      { id: 'depth', icon: 'layers', art: art('depth'), target: '[data-ai-tool="depth"]', panel: 'aiTools',
        where: { ar: 'الخصائص ← الفيديو ← تأثيرات العمق', en: 'Inspector → Video → Depth effects (AI)' },
        ar: { title: 'تأثيرات العمق', body: 'اختار نقطة التركيز واعزل الخلفية بالتمويه، أضف ضبابًا حسب المسافة، أو اعمل حركة كاميرا على صورة أو فيديو.' },
        en: { title: 'Depth effects', body: 'Pick a focus point for portrait blur, add fog that builds with distance, or add camera motion to a photo or video.' } },
      { id: 'upscale', icon: 'maximize-2', art: art('upscale'), target: '[data-ai-tool="upscale"]', panel: 'aiTools',
        where: { ar: 'الخصائص ← الفيديو ← رفع الدقة بالذكاء الاصطناعي', en: 'Inspector → Video → AI upscale' },
        ar: { title: 'رفع الدقة بالذكاء الاصطناعي', body: 'كبّر كليب فيديو أو صورة إلى ضعفين أو أربعة أضعاف. من شاشة التصدير تقدر ترفع دقة مشروع لحد 1080p إلى 4K.' },
        en: { title: 'AI upscale', body: 'Prepare a 2× or 4× copy of a video or image clip. In the export dialog, upscale projects up to 1080p to 4K.' } },
      { id: 'captionTranslation', icon: 'languages', art: art('translation'), target: '[data-ai-tool="caption-translation"]', panel: 'aiTools',
        where: { ar: 'كابشن ← ترجمة الكابشن', en: 'Captions → Translate captions' },
        ar: { title: 'ترجمة الكابشن', body: 'ترجم بين العربي والإنجليزي على جهازك. استبدل النص، أضف مسار ترجمة بنفس التوقيت، أو صدّر ملف SRT.' },
        en: { title: 'Caption translation', body: 'Translate between Arabic and English on your device. Replace text, add a second track with the same timings, or export an SRT.' } },
      { id: 'piper', icon: 'volume-2', art: art('voice'), target: '#piperPanel > summary', panel: 'text',
        where: { ar: 'النص أو الأصوات ← تعليق صوتي بالذكاء الاصطناعي', en: 'Text or Sounds → Voice-over (AI)' },
        ar: { title: 'تعليق صوتي بالذكاء الاصطناعي', body: 'نزّل صوتًا عربيًا أو إنجليزيًا، اسمع المعاينة، وأضف الصوت للتايملاين. تقدر تقرأ مسار الكابشن كله حسب توقيت كل جملة.' },
        en: { title: 'Voice-over (AI)', body: 'Download an Arabic or English voice, preview speech, and add it to the timeline. Read a caption track aloud to generate audio at each caption’s start.' } },
      { id: 'voiceClean', icon: 'volume-2', art: art('voice'), target: '[data-ai-tool="voice-clean"]', panel: 'aiTools',
        where: { ar: 'الخصائص ← الصوت ← تنقية الكلام بالذكاء الاصطناعي', en: 'Inspector → Audio → Voice clean-up (AI)' },
        ar: { title: 'تنقية الكلام بالذكاء الاصطناعي', body: 'قلّل ضوضاء الخلفية باستخدام DeepFilterNet3. اختار قوة التنقية وارجع جزء من صوت المكان لو محتاجه.' },
        en: { title: 'Voice clean-up (AI)', body: 'Reduce background noise with DeepFilterNet3. Choose a strength and blend back some room tone if you want it.' } },
      { id: 'scenes', icon: 'film', art: art('scenes'), target: '[data-ai-tool="scenes"]', panel: 'aiTools',
        where: { ar: 'المكتبة ← الوسائط ← كليك يمين ← اكتشف المشاهد', en: 'Library → Media → right-click → Detect scenes' },
        ar: { title: 'كشف المشاهد', body: 'اكتشف أماكن القطع في الفيديو بـ TransNetV2 على جهازك، وبعدين كليك يمين على الكليب واختار «قسّم عند قطعات المشاهد».' },
        en: { title: 'Scene detection', body: 'Find the cuts in a video with TransNetV2 on your device, then right-click a clip and choose Split at scene cuts.' } },
      { id: 'highlights', icon: 'film', art: art('shorts'), target: '[data-ai-tool="highlights"]', panel: 'aiTools',
        where: { ar: 'المكتبة ← أدوات الذكاء الاصطناعي ← من فيديو طويل لشورتس', en: 'Library → AI Tools → Highlights to Shorts' },
        ar: { title: 'من فيديو طويل لشورتس', body: 'دوّر على أقوى اللحظات في الكلام (15 إلى 60 ثانية)، علّم اللي عجبك، وكل واحدة تبقى شورت 9:16 بدون سكتات ومتأطّر على الشخص وعليه كابشن.' },
        en: { title: 'Highlights to Shorts', body: 'Find the strongest moments in a long talking video (15 to 60 s), tick the ones you like, and each becomes a 9:16 short with silences removed, reframed on the speaker and captioned.' } },
      { id: 'colorGrade', icon: 'pipette', art: art('grade'), target: '[data-csub="qual"]', panel: 'insp',
        where: { ar: 'الخصائص ← تعديل ← منحنيات / تحديد لون / مطابقة لون', en: 'Inspector → Adjust → Curves / Qualifier / Color match' },
        ar: { title: 'منحنيات وتحديد لون ومطابقة لون', body: 'اتحكم في اللون بمنحنيات RGB، واختار مدى لون بالقطّارة وعدّله لوحده، أو طابق ألوان كليب على كليب تاني بنسبة تختارها.' },
        en: { title: 'Curves, qualifier and color match', body: 'Shape tone with RGB curves, pick a color range with the eyedropper and adjust only that, or match a clip to another clip by an amount you choose.' } },
      { id: 'collect', icon: 'folder-open', art: art('collect'), target: '#bSave',
        where: { ar: 'اختصارات (Shift+/) ← ملف ← تجميع المشروع', en: 'Shortcuts (Shift+/) → File → Collect project' },
        ar: { title: 'تجميع المشروع وربط الميديا', body: 'انسخ المشروع وكل ميدياه في فولدر واحد (أو zip) للأرشفة أو النقل. ولو فتحت مشروع وميدياه ناقصة، اربطها بنفسك أو دوّر عليها في فولدر مرة واحدة.' },
        en: { title: 'Collect project and relink media', body: 'Copy the project and all its media into one folder (or a zip) to archive or move it. If you open a project with missing media, locate files one by one or search a folder to relink them at once.' } },
      { id: 'recordScreen', icon: 'monitor', art: art('record'), target: '#bRecScreen', panel: 'media',
        where: { ar: 'المكتبة ← الميديا ← تسجيل الشاشة والكاميرا', en: 'Library → Media → Record screen & camera' },
        ar: { title: 'تسجيل الشاشة والكاميرا', body: 'سجّل شاشتك وكاميرتك وميكروفونك من جوه Maqto. كل مصدر في ملف لوحده وبنفس التوقيت، والكاميرا تنزل على التايملاين كصورة صغيرة في الركن.' },
        en: { title: 'Record screen & camera', body: 'Record your screen, camera and microphone inside Maqto. Each source is its own file, recorded in sync, and the camera lands on the timeline as a small corner picture.' } },
      { id: 'alphaExport', icon: 'layers', art: art('alpha'), target: '#bExport',
        where: { ar: 'تصدير ← الترميز (كوديك)', en: 'Export → Format' },
        ar: { title: 'تصدير بخلفية شفافة وGIF وصور', body: 'اختار ProRes 4444 أو WebM بخلفية شفافة، أو GIF، أو سلسلة صور PNG/JPG. وتقدر تصدّر الفريم الحالي كصورة PNG من الاختصارات.' },
        en: { title: 'Transparent, GIF and image export', body: 'Pick ProRes 4444 or WebM with a transparent background, a GIF, or a PNG/JPG sequence. You can also export the current frame as a PNG from the shortcuts list.' } },
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

  function whatsNewFrom(seen, hasOldState, entries) {
    if (seen || !hasOldState || !entries.length) return seen;
    const [latest, previous] = entries.map(e => e.version).sort((a, b) => cmp(b, a));
    if (previous) return previous;
    const [major, minor, patch] = parts(latest);
    return patch > 0 ? `${major}.${minor}.${patch - 1}` : '0';
  }

  const api = { WHATS_NEW, cmp, pendingSteps, replaySteps, whatsNewFrom };
  if (typeof module === 'object') module.exports = api;
  else window.MaqtoWhatsNew = api;
})();

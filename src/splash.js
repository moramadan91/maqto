// The splash window starts hidden: show it, wait a beat, then run the canvas intro (intro-timeline.js)
// off one rAF clock and hand over to the editor when it ends.
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const { DUR, render } = window.introTimeline;
const W = 640, H = 360;
const inv = c => window.__TAURI__ ? window.__TAURI__.core.invoke(c) : Promise.resolve();
const fit = () => {
  const d = window.devicePixelRatio || 1;
  cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d);
  ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
};
fit(); addEventListener('resize', fit);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
inv('splash_show').then(() => setTimeout(() => {
  if (reduced) { render(ctx, 1.9, W, H); setTimeout(() => inv('splash_done'), 600); return; }
  const t0 = performance.now();
  const tick = now => {
    const t = (now - t0) / 1000;
    if (t >= DUR) { ctx.clearRect(0, 0, W, H); inv('splash_done'); return; }
    render(ctx, t, W, H); requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, 120));

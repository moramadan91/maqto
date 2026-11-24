'use strict';
(() => {
  const LEVELS = 256, MAX = LEVELS - 1;
  // The preview is full-range RGB. Use BT.709 luma and signed chroma.
  const luma = (r, g, b) => g + 0.2126 * (r - g) + 0.0722 * (b - g);
  const cb = (b, y) => (b - y) / (1.8556 * MAX);
  const cr = (r, y) => (r - y) / (1.5748 * MAX);
  function rgbToCbCr(r, g, b) {
    const y = luma(r, g, b);
    return [cb(b, y), cr(r, y)];
  }

  const binCount = (mode, width) => LEVELS * (
    mode === 'histogram' ? 4 : mode === 'vector' ? LEVELS : width * (mode === 'parade' ? 3 : 1));
  function accumulate(mode, rgba, width, bins = new Uint32Array(binCount(mode, width))) {
    bins.fill(0);
    if (mode === 'histogram') {
      for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        bins[r]++;
        bins[LEVELS + g]++;
        bins[2 * LEVELS + b]++;
        bins[3 * LEVELS + Math.round(luma(r, g, b))]++;
      }
    } else if (mode === 'vector') {
      for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], y = luma(r, g, b);
        const xBin = Math.round((0.5 + cb(b, y)) * MAX);
        const yBin = Math.round((0.5 - cr(r, y)) * MAX);
        bins[yBin * LEVELS + xBin]++;
      }
    } else if (mode === 'parade') {
      const stride = 3 * width;
      for (let i = 0, x = 0; i < rgba.length; i += 4) {
        bins[(MAX - rgba[i]) * stride + x]++;
        bins[(MAX - rgba[i + 1]) * stride + width + x]++;
        bins[(MAX - rgba[i + 2]) * stride + 2 * width + x]++;
        if (++x === width) x = 0;
      }
    } else {
      for (let i = 0, x = 0; i < rgba.length; i += 4) {
        const y = Math.round(luma(rgba[i], rgba[i + 1], rgba[i + 2]));
        bins[(MAX - y) * width + x]++;
        if (++x === width) x = 0;
      }
    }
    return bins;
  }

  const rgb = [[255, 87, 87], [82, 236, 128], [108, 157, 255], [237, 240, 243]];
  const density = [0, ...Array.from({ length: 36 }, (_, i) => Math.round(255 * Math.sqrt((i + 1) / 36)))];
  const palettes = rgb.map(color => {
    const bytes = new Uint8Array(density.length * 4);
    for (let i = 1; i < density.length; i++) bytes.set([...color, density[i]], 4 * i);
    return new Uint32Array(bytes.buffer);
  });
  const targets = [
    ['R', 1, 0, 0], ['Mg', 1, 0, 1], ['B', 0, 0, 1],
    ['Cy', 0, 1, 1], ['G', 0, 1, 0], ['Yl', 1, 1, 0],
  ].map(([name, r, g, b]) => [name, ...rgbToCbCr(r * MAX * 0.75, g * MAX * 0.75, b * MAX * 0.75)]);

  function densityImage(layer, bins, mode, width) {
    const { raster, ctx } = layer;
    const w = bins.length / LEVELS;
    if (raster.width !== w || !layer.image) {
      raster.width = w;
      layer.image = ctx.createImageData(w, LEVELS);
      layer.pixels = new Uint32Array(layer.image.data.buffer);
    }
    const data = layer.pixels, palette = palettes[mode === 'waveform' ? 3 : 1];
    data.fill(0);
    for (let i = 0; i < bins.length; i++) {
      const count = bins[i];
      if (!count) continue;
      const colors = mode === 'parade' ? palettes[Math.floor(i % w / width)] : palette;
      data[i] = colors[Math.min(count, colors.length - 1)];
    }
    ctx.putImageData(layer.image, 0, 0);
    return raster;
  }

  function gridLine(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawVector(ctx, w, h, raster) {
    const x = w / 2, y = h / 2, size = Math.min(w, h) - 22, radius = size / 2;
    ctx.textAlign = 'center';
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.arc(x, y, radius * fraction, 0, 2 * Math.PI);
      ctx.stroke();
    }
    gridLine(ctx, x - radius, y, x + radius, y);
    gridLine(ctx, x, y - radius, x, y + radius);
    ctx.fillText('Cb', x + radius + 2, y + 12);
    ctx.fillText('Cr', x - 10, y - radius - 2);
    const angle = 123 * Math.PI / 180;
    ctx.strokeStyle = '#665b46';
    gridLine(ctx, x, y, x + radius * Math.cos(angle), y - radius * Math.sin(angle));
    ctx.strokeStyle = '#45494d';
    for (const [name, u, v] of targets) {
      const px = x + u * size, py = y - v * size;
      ctx.strokeRect(px - 3, py - 3, 6, 6);
      ctx.fillText(name, px, py + (v < -0.04 ? 14 : -6));
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(raster, x - radius, y - radius, size, size);
  }

  function drawHistogram(ctx, bins, w, h) {
    const x = 10, y = h - 19, dx = (w - 2 * x) / MAX;
    let peak = 1;
    for (const count of bins) peak = Math.max(peak, count);
    for (const fraction of [0, 0.5, 1]) gridLine(ctx, x, y - fraction * (y - 8), w - x, y - fraction * (y - 8));
    ctx.fillText('0', x, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText('255', w - x, h - 5);
    ctx.globalCompositeOperation = 'lighter';
    rgb.forEach((color, c) => {
      ctx.strokeStyle = 'rgb(' + color.join(',') + ')';
      ctx.beginPath();
      for (let i = 0; i < LEVELS; i++) {
        const py = y - bins[c * LEVELS + i] / peak * (y - 8);
        if (i) ctx.lineTo(x + i * dx, py); else ctx.moveTo(x, py);
      }
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.lineTo(w - x, y);
      ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = 0.14;
      ctx.fill();
    });
  }

  function drawWaveform(ctx, mode, w, h, raster) {
    const x = 43, top = 10, width = w - x - 7, height = h - top - (mode === 'parade' ? 19 : 10);
    for (const ire of [100, 50, 0]) {
      const y = top + height * (1 - ire / 100);
      ctx.fillText(ire + ' IRE', 6, y + 3);
      gridLine(ctx, x, y, x + width, y);
    }
    if (mode === 'parade') {
      ctx.textAlign = 'center';
      ['R', 'G', 'B'].forEach((label, i) => {
        const left = x + i * width / 3;
        if (i) gridLine(ctx, left, top, left, top + height);
        ctx.fillStyle = 'rgb(' + rgb[i].join(',') + ')';
        ctx.fillText(label, left + width / 6, h - 5);
      });
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(raster, x, top, width, height);
  }

  function drawPlot(plot, rgba, sampleWidth) {
    const { canvas, select, w, h } = plot;
    const mode = select.value, dpr = window.devicePixelRatio || 1;
    const width = Math.round(w * dpr), height = Math.round(h * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(width / w, 0, 0, height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (w < 60 || h < 36) return;
    ctx.save();
    ctx.font = '10px system-ui';
    ctx.direction = 'ltr';
    ctx.fillStyle = '#8c9299';
    ctx.strokeStyle = '#2c3034';
    ctx.imageSmoothingEnabled = false;
    const size = binCount(mode, sampleWidth);
    if (plot.bins?.length !== size) plot.bins = new Uint32Array(size);
    const bins = accumulate(mode, rgba, sampleWidth, plot.bins);
    if (mode === 'histogram') drawHistogram(ctx, bins, w, h);
    else {
      if (!plot.layer) {
        const raster = document.createElement('canvas');
        raster.height = LEVELS;
        plot.layer = { raster, ctx: raster.getContext('2d') };
      }
      const raster = densityImage(plot.layer, bins, mode, sampleWidth);
      if (mode === 'vector') drawVector(ctx, w, h, raster);
      else drawWaveform(ctx, mode, w, h, raster);
    }
    ctx.restore();
  }

  function mount(panel, invalidate) {
    const selects = [...panel.querySelectorAll('select')];
    selects[1].append(...Array.from(selects[0].options, option => option.cloneNode(true)));
    selects[1].value = '';
    const plots = [...panel.querySelectorAll('canvas')].map((canvas, i) => ({ canvas, select: selects[i], w: 0, h: 0 }));
    const resize = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries) {
        const plot = plots.find(p => p.canvas === target);
        plot.w = contentRect.width;
        plot.h = contentRect.height;
      }
      if (!panel.hidden) invalidate();
    });
    for (const { canvas, select } of plots) {
      resize.observe(canvas);
      select.addEventListener('change', () => { canvas.hidden = !select.value; invalidate(); });
    }

    let sample, ctx, last = -Infinity, warned = false;
    return (source, playing) => {
      if (panel.hidden) return;
      const now = performance.now();
      if (playing && now - last < 1000 / 15) return;
      const visible = plots.filter(p => !p.canvas.hidden && p.w && p.h);
      if (!visible.length) return;
      last = now;
      if (!sample) {
        sample = document.createElement('canvas');
        ctx = sample.getContext('2d', { alpha: false, willReadFrequently: true });
      }
      const w = Math.min(LEVELS, source.width);
      const h = Math.max(1, Math.min(LEVELS, Math.round(source.height * w / source.width)));
      if (sample.width !== w) sample.width = w;
      if (sample.height !== h) sample.height = h;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, 0, 0, w, h);
      let rgba;
      try {
        rgba = ctx.getImageData(0, 0, w, h).data;
      } catch (error) {
        if (error.name !== 'SecurityError') throw error;
        if (!warned) console.warn('Scopes could not read the preview canvas', error);
        warned = true;
        sample.width = w;
        rgba = new Uint8Array(0);
      }
      for (const plot of visible) drawPlot(plot, rgba, w);
    };
  }

  if (typeof module === 'object') module.exports = { accumulate, rgbToCbCr };
  else window.MaqtoScopes = { mount };
})();

/* Animated stage background (classic script, exposes window.StageBackground).
 * Same palette/art as publish.html's drawStageBackground(), pulled out so a page that doesn't publish
 * a video (view.html) can still show the same "live background" behind its own locally-rendered avatar.
 * Runs its own requestAnimationFrame loop; call .setTheme(name) / .pulse(0..1) to drive it live. */
(function () {
  'use strict';
  const THEMES = ['aurora', 'midnight', 'sunset', 'studio', 'neon', 'bokeh'];
  const BG_THEMES = {
    aurora:   ['#1b1440', '#4a2f86', '#1a355e'],
    midnight: ['#0a0c1c', '#141a33', '#050611'],
    sunset:   ['#3a1240', '#a3315a', '#e08a3c'],
    studio:   ['#12151a', '#262c36', '#0b0d10'],
    neon:     ['#08041a', '#2a0b5e', '#0b1d4a'],
    bokeh:    ['#0d1b2a', '#1b3a5c', '#3a1c5c'],
  };
  const PARTS = Array.from({ length: 46 }, () => ({
    x: Math.random(), y: Math.random(), r: 0.006 + Math.random() * 0.02,
    sp: 0.01 + Math.random() * 0.03, ph: Math.random() * 6, hue: 180 + Math.random() * 120,
  }));

  function draw(ctx, W, H, t, themeName, pulse) {
    const c = BG_THEMES[themeName] || BG_THEMES.aurora, P = pulse;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c[0]); g.addColorStop(0.55, c[1]); g.addColorStop(1, c[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) {
      const ang = t * (0.12 + i * 0.05) + i * 2.4;
      const bx = W * (0.5 + 0.38 * Math.cos(ang)), by = H * (0.48 + 0.30 * Math.sin(ang * 1.3));
      const r = Math.min(W, H) * (0.32 + 0.06 * Math.sin(t * 0.35 + i) + 0.05 * P);
      const rg = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      rg.addColorStop(0, `rgba(255,255,255,${0.10 + 0.06 * P})`); rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    }
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    if (themeName === 'aurora') {
      for (let k = 0; k < 3; k++) {
        const hue = 160 + k * 55 + 20 * Math.sin(t * 0.2), y0 = H * (0.25 + 0.17 * k);
        const rb = ctx.createLinearGradient(0, y0 - H * 0.2, 0, y0 + H * 0.2);
        rb.addColorStop(0, 'hsla(' + hue + ',90%,60%,0)'); rb.addColorStop(0.5, `hsla(${hue},90%,60%,${0.16 + 0.12 * P})`); rb.addColorStop(1, 'hsla(' + hue + ',90%,60%,0)');
        ctx.fillStyle = rb; ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 20) ctx.lineTo(x, y0 + Math.sin(x / W * 5 + t * (0.5 + k * 0.2) + k) * H * (0.07 + 0.04 * P));
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
    } else if (themeName === 'neon') {
      const hz = H * 0.62, sun = ctx.createRadialGradient(W / 2, hz, 0, W / 2, hz, H * (0.34 + 0.04 * P));
      sun.addColorStop(0, 'rgba(255,90,200,0.55)'); sun.addColorStop(1, 'rgba(255,90,200,0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = `rgba(90,220,255,${0.35 + 0.3 * P})`; ctx.lineWidth = 2;
      for (let i = -14; i <= 14; i++) { ctx.beginPath(); ctx.moveTo(W / 2 + i * 12, hz); ctx.lineTo(W / 2 + i * W * 0.14, H); ctx.stroke(); }
      for (let i = 0; i < 10; i++) { const f = ((i + (t * 0.35) % 1) / 10), y = hz + (H - hz) * f * f; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (themeName === 'bokeh') {
      for (const q of PARTS) {
        const y = ((q.y - t * q.sp) % 1 + 1) % 1, x = q.x + Math.sin(t * 0.3 + q.ph) * 0.03, r = H * q.r * (1 + 0.6 * P);
        const og = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * 3);
        og.addColorStop(0, `hsla(${q.hue},90%,70%,${0.35 + 0.3 * P})`); og.addColorStop(1, 'hsla(' + q.hue + ',90%,70%,0)');
        ctx.fillStyle = og; ctx.fillRect(x * W - r * 3, y * H - r * 3, r * 6, r * 6);
      }
    }
    ctx.restore();
    const floor = ctx.createRadialGradient(W / 2, H * 1.02, 0, W / 2, H * 1.02, W * 0.55);
    floor.addColorStop(0, 'rgba(255,255,255,0.14)'); floor.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = floor; ctx.fillRect(0, 0, W, H);
  }

  /* ---- "camera" parallax: drift the CANVAS ELEMENT ITSELF a few % via a CSS transform (not a
     redraw), so it's compositor/GPU work, not more per-frame canvas drawing. Two sources feed the
     same target offset, whichever the device actually has:
       - anything with a real cursor (`pointer: fine`, i.e. desktop): mouse position, on by default.
       - phones (`pointer: coarse`): device tilt via `deviceorientation`. iOS 13+ gates that event
         behind a permission prompt that MUST be triggered from a user tap, so it's opt-in - call
         enableDeviceTilt() from a click/touchend handler (e.g. a "tap to enable tilt" hint).
         Android needs no prompt; the listener just attaches on first call.
     A plain lerp (not the OU/spring machinery in avatar-orchestra.js - this is two numbers, a full
     damped-spring integrator would be overkill) keeps it from snapping frame to frame. */
  const PARALLAX_SCALE = 1.05;      // headroom so the translate below never shows the container edge
  const PARALLAX_PX = 3.2;          // max horizontal drift, % of the canvas's own box
  const PARALLAX_PY = 2.0;          // max vertical drift, %

  class StageBackground {
    constructor(canvas, theme, opts) {
      opts = opts || {};
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.theme = THEMES.includes(theme) ? theme : 'aurora';
      this._pulse = 0; this._start = performance.now(); this._raf = null;
      this._tx = 0; this._ty = 0; this._px = 0; this._py = 0;     // parallax target / smoothed
      this._tiltBase = null; this._tiltOn = false;
      this.canvas.style.transformOrigin = '50% 50%';
      this.canvas.style.willChange = 'transform';
      this._loop = this._loop.bind(this);
      this._raf = requestAnimationFrame(this._loop);
      if (opts.parallax !== false) this._initMouseParallax();
    }
    setTheme(name) { if (THEMES.includes(name)) this.theme = name; }
    pulse(v) { this._pulse = Math.max(0, Math.min(1, v)); }   // 0..1, e.g. 1 while the avatar is speaking

    /* Desktop / anything with a real cursor: no permission needed, safe to attach right away. */
    _initMouseParallax() {
      if (!(window.matchMedia && window.matchMedia('(pointer: fine)').matches)) return;
      window.addEventListener('pointermove', e => {
        this._tx = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
        this._ty = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1));
      }, { passive: true });
    }

    /* Phones: device tilt. Must be called from inside a user-gesture handler (a tap) on iOS 13+
       because of the permission prompt it triggers - e.g.
         stage.addEventListener('click', () => bg.enableDeviceTilt(), { once: true })
       Returns a promise resolving true/false so the caller can show/hide a "tap to enable tilt" hint. */
    async enableDeviceTilt() {
      if (this._tiltOn) return true;
      if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return false;
      if (typeof DeviceOrientationEvent === 'undefined') return false;
      try {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
          const r = await DeviceOrientationEvent.requestPermission();
          if (r !== 'granted') return false;
        }
      } catch (e) { return false; }
      window.addEventListener('deviceorientation', e => {
        if (e.beta === null || e.gamma === null) return;
        // first reading becomes the baseline (however the phone happens to be held), so tilt reads
        // relative to "wherever you started" instead of an absolute angle nobody calibrated for.
        if (!this._tiltBase) this._tiltBase = { beta: e.beta, gamma: e.gamma };
        this._tx = Math.max(-1, Math.min(1, (e.gamma - this._tiltBase.gamma) / 22));
        this._ty = Math.max(-1, Math.min(1, (e.beta - this._tiltBase.beta) / 22));
      }, { passive: true });
      this._tiltOn = true;
      return true;
    }

    _loop(now) {
      const c = this.canvas;
      const w = c.clientWidth || c.width, h = c.clientHeight || c.height;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      draw(this.ctx, c.width, c.height, (now - this._start) / 1000, this.theme, this._pulse);
      this._px += (this._tx - this._px) * 0.06; this._py += (this._ty - this._py) * 0.06;   // cheap lerp
      c.style.transform = 'scale(' + PARALLAX_SCALE + ') translate(' + (this._px * PARALLAX_PX).toFixed(2) + '%,' + (this._py * PARALLAX_PY).toFixed(2) + '%)';
      this._raf = requestAnimationFrame(this._loop);
    }
    stop() { if (this._raf) cancelAnimationFrame(this._raf); }
  }

  window.StageBackground = { StageBackground, THEMES };
})();

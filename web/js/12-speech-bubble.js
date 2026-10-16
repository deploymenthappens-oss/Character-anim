// =====================================================================
//  12-speech-bubble.js — soft "cinematic typing" speech bubble.
//
//  One core, two renderers:
//    • publish.html  → SpeechBubble.draw(ctx, W, H, mouthX, mouthY)   (canvas, baked into the broadcast)
//    • view.html     → SpeechBubble.frame(now) drives the DOM bubble   (see startDomBubbleLoop)
//
//  API (unchanged for callers in avatar.js / 04-render.js):
//    SpeechBubble.begin(text, words, getT)   words = [{t,d,w}] Edge TTS timestamps or null
//    SpeechBubble.end()
//
//  Behaviour
//  ─────────
//  • The bubble is laid out ONCE for the whole page of text, so it never resizes/reflows while typing.
//  • Characters are revealed continuously in step with the voice (word timestamps when available, an
//    estimated speaking rate otherwise), eased so it types smoothly instead of jumping word-to-word.
//    The last few characters fade in; a soft caret blinks while typing.
//  • Long replies are split into short pages (≤ PAGE_MAX chars, at sentence/word boundaries) that
//    cross-fade, so text stays big and readable instead of shrinking or scrolling.
//  • RTL (Arabic) is revealed as whole prefixes so letter shaping is never broken.
//  • A new begin() always wins: the old fade-out timer can no longer kill the next bubble (that race
//    is what used to make a reply's bubble vanish right after the quick "Hi <name>!" ack).
// =====================================================================
(function () {
  'use strict';

  const PAGE_MAX   = 96;     // chars per page
  const FONT_SIZE  = 17;     // px at 1280-wide canvas
  const FADE_IN_S  = 0.30;
  const FADE_OUT_S = 0.55;
  const TAIL_CHARS = 3;      // trailing characters that fade in softly
  const EASE_RATE  = 14;     // typing smoothing (higher = snappier)
  const RTL_RE     = /[\u0590-\u08FF]/;

  let _active = false, _text = '', _words = null, _getT = null;
  let _startedAt = 0, _endedAt = null, _gen = 0;
  let _pages = [], _pageStart = [], _offs = null;
  let _shown = 0, _lastFrame = 0, _pageIdx = -1, _pageSince = 0;

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  function chunk(text) {
    const out = []; let rest = text;
    while (rest.length > PAGE_MAX) {
      const win = rest.slice(0, PAGE_MAX + 1);
      let cut = -1;
      const ends = [...win.matchAll(/[.!?؟…]\s/g)];
      if (ends.length) { const e = ends[ends.length - 1].index + 1; if (e >= PAGE_MAX * 0.4) cut = e; }
      if (cut < 0) { cut = win.lastIndexOf(' '); if (cut < PAGE_MAX * 0.4) cut = PAGE_MAX; }
      out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  function mapWords(text, words) {
    const offs = []; let cur = 0;
    for (const w of words) {
      const token = String(w.w || '');
      let i = text.indexOf(token, cur);
      if (i < 0) i = text.toLowerCase().indexOf(token.toLowerCase(), cur);
      if (i < 0 || i - cur > 40) i = Math.min(cur, text.length);
      offs.push(i); cur = Math.min(text.length, i + token.length);
    }
    return offs;
  }

  // how many characters of the full text should be visible at audio time t
  function targetChars(t) {
    const len = _text.length;
    if (_endedAt !== null) return len;
    if (_words && _offs) {
      let i = -1;
      for (let k = 0; k < _words.length; k++) { if (t >= _words[k].t) i = k; else break; }
      if (i < 0) return 0;
      const w = _words[i], wl = String(w.w || '').length;
      const p = Math.max(0, Math.min(1, (t - w.t) / Math.max(0.12, (w.d || 0.3) * 0.92)));
      const c = _offs[i] + wl * p;
      return i === _words.length - 1 && t >= w.t + (w.d || 0.3) ? len : Math.min(len, c);
    }
    const wc = _text.split(' ').length;
    const dur = Math.max(1.0, Math.min(30, wc * 0.38));
    return len * Math.min(1, ((performance.now() - _startedAt) / 1000) / dur);
  }

  const SpeechBubble = {
    begin(text, words, getT) {
      _gen++;                                   // invalidates any pending end() timer from the previous line
      _text = norm(text);
      _words = words && words.length ? words : null;
      _getT = getT;
      _pages = chunk(_text);
      _pageStart = []; { let c = 0; for (const p of _pages) { const i = _text.indexOf(p, c); _pageStart.push(i < 0 ? c : i); c = (i < 0 ? c : i) + p.length; } }
      _offs = _words ? mapWords(_text, _words) : null;
      _startedAt = performance.now(); _endedAt = null;
      _shown = 0; _lastFrame = 0; _pageIdx = -1; _pageSince = _startedAt;
      _active = !!_text;
    },
    end() {
      if (!_active) return;
      _endedAt = performance.now();
      const gen = _gen;
      const hold = 0.7 + Math.min(2.2, _text.length / 45);          // reading time after the voice stops
      setTimeout(() => { if (gen === _gen) _active = false; }, (hold + FADE_OUT_S) * 1000 + 80);
    },

    // Shared per-frame state for both renderers. Returns null when nothing should be visible.
    frame(now) {
      if (!_active || !_text) return null;
      now = now || performance.now();
      const dt = _lastFrame ? Math.max(0, Math.min(0.1, (now - _lastFrame) / 1000)) : 0;
      _lastFrame = now;

      const age = (now - _startedAt) / 1000;
      let alpha = Math.min(1, age / FADE_IN_S);
      alpha = alpha * alpha * (3 - 2 * alpha);                     // smoothstep
      if (_endedAt !== null) {
        const hold = 0.7 + Math.min(2.2, _text.length / 45);
        const done = (now - _endedAt) / 1000;
        if (done > hold) alpha *= 1 - Math.min(1, (done - hold) / FADE_OUT_S);
        if (alpha <= 0.001) return null;
      }
      const rise = (1 - Math.min(1, age / FADE_IN_S)) * 8;         // gentle upward settle

      const t = (_getT && _endedAt === null) ? Math.max(0, _getT()) : Infinity;
      const target = targetChars(t);
      const k = 1 - Math.exp(-dt * EASE_RATE);
      _shown = Math.max(_shown, _shown + (target - _shown) * k);
      if (target >= _text.length && _text.length - _shown < 0.25) _shown = _text.length;

      let pi = 0;
      for (let i = 0; i < _pages.length; i++) if (_pageStart[i] <= Math.floor(_shown) + (i === 0 ? 0 : 0)) pi = i;
      if (pi !== _pageIdx) { _pageIdx = pi; _pageSince = now; }
      const pageAlpha = _pageIdx === 0 ? 1 : Math.min(1, (now - _pageSince) / 220);

      const page = _pages[pi] || '';
      const local = Math.max(0, Math.min(page.length, _shown - _pageStart[pi]));
      const typing = _endedAt === null && _shown < _text.length - 0.5;
      return { alpha, rise, page, pageIdx: pi, pageCount: _pages.length, pageAlpha,
               shown: local, rtl: RTL_RE.test(page), typing, caret: 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 170)) };
    },

    // Canvas renderer (publish.html) — called every frame from 04-render.js after the avatar is drawn.
    draw(ctx, W, H, mouthX, mouthY) {
      const f = this.frame(performance.now());
      if (!f) return;

      const scale = Math.max(0.6, Math.min(1.4, W / 1280));
      const fSize = Math.round(FONT_SIZE * scale), padX = Math.round(16 * scale), padY = Math.round(12 * scale);
      const tailH = Math.round(12 * scale), radius = Math.round(16 * scale), lineH = fSize * 1.42;

      ctx.save();
      ctx.font = `600 ${fSize}px system-ui, "Segoe UI", Tahoma, sans-serif`;
      const maxW = Math.min(W * 0.40, 430 * scale);
      const lines = wrap(ctx, f.page, maxW);
      const bW = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width))) + padX * 2;
      const bH = lines.length * lineH + padY * 2 - fSize * 0.12;

      const bottom = mouthY - tailH - 6 + f.rise;
      const top = bottom - bH;
      const left = Math.max(10, Math.min(W - bW - 10, mouthX - bW / 2));
      const tailW = 9 * scale;
      const tailX = Math.max(left + radius + tailW, Math.min(left + bW - radius - tailW, mouthX));

      ctx.globalAlpha = f.alpha;
      // body: soft vertical gradient + diffuse shadow
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, 'rgba(26,29,46,0.90)'); g.addColorStop(1, 'rgba(12,14,24,0.93)');
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 22 * scale; ctx.shadowOffsetY = 8 * scale;
      ctx.fillStyle = g; rr(ctx, left, top, bW, bH, radius); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; rr(ctx, left, top, bW, bH, radius); ctx.stroke();
      // tail (quadratic, soft)
      ctx.fillStyle = 'rgba(12,14,24,0.93)';
      ctx.beginPath(); ctx.moveTo(tailX - tailW, bottom - 0.5);
      ctx.quadraticCurveTo(tailX - 1, bottom + tailH * 0.35, mouthX < left || mouthX > left + bW ? tailX : tailX + 1, bottom + tailH);
      ctx.quadraticCurveTo(tailX + 1, bottom + tailH * 0.35, tailX + tailW, bottom - 0.5);
      ctx.closePath(); ctx.fill();

      // typed text
      ctx.globalAlpha = f.alpha * f.pageAlpha;
      ctx.textBaseline = 'alphabetic';
      const base = top + padY + fSize;
      let consumed = 0;
      lines.forEach((line, li) => {
        const y = base + li * lineH, rc = Math.max(0, Math.min(line.length, Math.floor(f.shown - consumed + 0.0001)));
        const frac = f.shown - consumed;
        if (f.rtl) {
          ctx.direction = 'rtl'; ctx.textAlign = 'right';
          ctx.fillStyle = '#f4f6ff';
          if (rc > 0) ctx.fillText(line.slice(0, rc), left + bW - padX, y);
          ctx.direction = 'ltr';
        } else {
          ctx.textAlign = 'left';
          const x0 = left + padX, solidN = Math.max(0, Math.min(rc, Math.floor(frac - TAIL_CHARS + 1)));
          ctx.fillStyle = '#f4f6ff';
          if (solidN > 0) ctx.fillText(line.slice(0, solidN), x0, y);
          for (let c = solidN; c < rc; c++) {
            ctx.globalAlpha = f.alpha * f.pageAlpha * Math.max(0.05, Math.min(1, (frac - c) / TAIL_CHARS));
            ctx.fillStyle = '#dfe6ff';
            ctx.fillText(line[c], x0 + ctx.measureText(line.slice(0, c)).width, y);
          }
          ctx.globalAlpha = f.alpha * f.pageAlpha;
          if (f.typing && frac > 0 && frac <= line.length + 1) {         // soft caret at the typing edge
            const cx = x0 + ctx.measureText(line.slice(0, rc)).width + 2;
            ctx.save(); ctx.globalAlpha *= f.caret * 0.85; ctx.fillStyle = '#ffe066';
            ctx.shadowColor = 'rgba(255,224,102,0.7)'; ctx.shadowBlur = 8 * scale;
            rr(ctx, cx, y - fSize * 0.82, 2 * scale, fSize * 0.95, 1); ctx.fill(); ctx.restore();
          }
        }
        consumed += line.length + 1;
      });
      ctx.restore();
    },
  };

  function wrap(ctx, text, maxWidth) {
    const words = text.split(' '), lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);         ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  Object.defineProperties(SpeechBubble, {
    _active: { get: () => _active }, _text: { get: () => _text },
    _words:  { get: () => _words },  _getT: { get: () => _getT },
  });
  window.SpeechBubble = SpeechBubble;
})();

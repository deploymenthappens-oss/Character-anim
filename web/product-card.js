/*
 * product-card.js — animated wall-monitor product spotlight overlay ("Level 2")
 *
 * Creates a fixed DOM overlay in the bottom-right corner showing the current product:
 * name, price, optional note, an optional "best seller" badge, an optional countdown
 * timer, and a QR code for the product URL. Driven by SSE 'product' events from the
 * server (see chat/server.js) and mirrored on the publisher's own stage (10-product.js).
 *
 * Animation on show():
 *   1. Card springs in from the right with a slight overshoot (no Rive needed).
 *   2. The price counts up digit-by-digit from 0 to its real value.
 *   3. A neon border pulses once to draw the eye.
 *   4. If bestSeller is set, a "🔥 BEST SELLER" ribbon drops in with its own pulse.
 *   5. If dealEndsAt (or dealSeconds) is set, a countdown ticks down live and turns red
 *      in the final minute.
 *
 * This is a drop-in replacement for the static v1 card — same constructor and public
 * methods (show/hide/update), same stageEl usage — so publish.html and view.html need
 * no changes to use it.
 *
 * Usage:
 *   const card = new ProductCard({ stageEl: document.querySelector('.stage') });
 *   card.show({ name, price, note, url, bestSeller, dealEndsAt });
 *   card.hide();
 */
(function () {
  'use strict';

  // Inject the keyframes/animation CSS once per page, shared by every card instance.
  function ensureStyles() {
    if (document.getElementById('pc-styles')) return;
    const style = document.createElement('style');
    style.id = 'pc-styles';
    style.textContent = `
      @keyframes pc-spring-in {
        0%   { opacity: 0; transform: translateX(56px) translateY(10px) scale(0.92); }
        55%  { opacity: 1; transform: translateX(-6px) translateY(0)    scale(1.015); }
        100% { opacity: 1; transform: translateX(0)     translateY(0)    scale(1); }
      }
      @keyframes pc-spring-out {
        0%   { opacity: 1; transform: translateX(0)    translateY(0)   scale(1); }
        100% { opacity: 0; transform: translateX(40px) translateY(10px) scale(0.95); }
      }
      @keyframes pc-neon-pulse {
        0%   { box-shadow: 0 8px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05), 0 0 0px 0 rgba(167,139,250,0); }
        30%  { box-shadow: 0 8px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(167,139,250,0.9),  0 0 26px 6px rgba(167,139,250,0.55); }
        100% { box-shadow: 0 8px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05), 0 0 0px 0 rgba(167,139,250,0); }
      }
      @keyframes pc-ribbon-drop {
        0%   { opacity: 0; transform: translateY(-10px) rotate(-2deg); }
        60%  { opacity: 1; transform: translateY(2px)   rotate(-2deg); }
        100% { opacity: 1; transform: translateY(0)      rotate(-2deg); }
      }
      @keyframes pc-ribbon-glow {
        0%, 100% { filter: brightness(1);   }
        50%      { filter: brightness(1.35); }
      }
      .pc-card.pc-anim-in  { animation: pc-spring-in 0.62s cubic-bezier(.34,1.2,.64,1) forwards, pc-neon-pulse 1.1s ease-out 0.05s 1; }
      .pc-card.pc-anim-out { animation: pc-spring-out 0.32s cubic-bezier(.4,0,.7,1) forwards; }
      .pc-ribbon { animation: pc-ribbon-drop 0.5s cubic-bezier(.34,1.4,.64,1) 0.3s both, pc-ribbon-glow 1.6s ease-in-out 0.9s infinite; }
      .pc-countdown.pc-hot { color: #f87171 !important; }
      @media (prefers-reduced-motion: reduce) {
        .pc-card.pc-anim-in, .pc-card.pc-anim-out, .pc-ribbon { animation: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  // Animate a price string's numbers counting up from 0 to their real value, preserving
  // all non-numeric characters (currency symbols, "/", commas, trailing currency text).
  function animateCountUp(el, finalText, duration) {
    duration = duration || 700;
    const matches = [...String(finalText).matchAll(/[\d,]+(\.\d+)?/g)];
    if (!matches.length) { el.textContent = finalText; return; }

    const targets = matches.map(m => parseFloat(m[0].replace(/,/g, '')));
    const t0 = performance.now();
    const ease = x => 1 - Math.pow(1 - x, 3); // ease-out cubic, settles with a little snap

    function frame(now) {
      const p = Math.min(1, (now - t0) / duration);
      const e = ease(p);
      let out = '', cursor = 0;
      matches.forEach((m, i) => {
        out += finalText.slice(cursor, m.index);
        const val = targets[i] * e;
        const hasDecimal = /\.\d+/.test(m[0]);
        const rounded = hasDecimal ? val.toFixed(2) : Math.round(val).toString();
        out += Number(rounded).toLocaleString('en-US', hasDecimal ? { minimumFractionDigits: 2 } : {});
        cursor = m.index + m[0].length;
      });
      out += finalText.slice(cursor);
      el.textContent = out;
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = finalText; // guarantee exact final text regardless of formatting quirks
    }
    requestAnimationFrame(frame);
  }

  function fmtClock(totalSec) {
    totalSec = Math.max(0, Math.round(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  class ProductCard {
    constructor({ stageEl }) {
      this._stage = stageEl || document.body;
      this._el = null;
      this._visible = false;
      this._fadeTimer = null;
      this._countdownTimer = null;
      ensureStyles();
      this._build();
    }

    _build() {
      const wrap = document.createElement('div');
      wrap.className = 'pc-wrap';
      wrap.style.cssText = [
        'position:absolute', 'inset:0', 'pointer-events:none', 'z-index:120',
        'display:flex', 'align-items:flex-end', 'justify-content:flex-end',
        'padding:clamp(12px,2.5vw,28px)', 'box-sizing:border-box',
      ].join(';');

      const card = document.createElement('div');
      card.className = 'pc-card';
      card.style.cssText = [
        'position:relative',
        'background:rgba(10,10,20,0.82)',
        'backdrop-filter:blur(18px) saturate(1.6)',
        '-webkit-backdrop-filter:blur(18px) saturate(1.6)',
        'border:1px solid rgba(255,255,255,0.13)',
        'border-radius:18px',
        'padding:18px 20px',
        'min-width:220px',
        'max-width:clamp(220px,32vw,320px)',
        'box-shadow:0 8px 40px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.05)',
        'display:flex', 'flex-direction:column', 'gap:10px',
        'opacity:0',
        'pointer-events:auto',
        'font-family:system-ui,sans-serif',
        'color:#f0f0f5',
      ].join(';');

      // 🔥 Best-seller ribbon — hidden unless data.bestSeller is truthy
      const ribbon = document.createElement('div');
      ribbon.className = 'pc-ribbon';
      ribbon.style.cssText = [
        'position:absolute', 'top:-11px', 'left:14px',
        'background:linear-gradient(135deg,#f59e0b,#ef4444)',
        'color:#fff', 'font-size:0.68em', 'font-weight:800',
        'letter-spacing:0.04em', 'padding:4px 10px', 'border-radius:999px',
        'box-shadow:0 4px 14px rgba(239,68,68,0.45)',
        'display:none',
      ].join(';');
      ribbon.textContent = '🔥 BEST SELLER';

      const badge = document.createElement('div');
      badge.style.cssText = [
        'font-size:0.65em', 'font-weight:700', 'letter-spacing:0.12em',
        'text-transform:uppercase', 'color:#a78bfa', 'opacity:0.85', 'margin-bottom:-4px',
      ].join(';');
      badge.textContent = '📦 Product spotlight';

      const name = document.createElement('div');
      name.className = 'pc-name';
      name.style.cssText = 'font-size:1.05em;font-weight:700;line-height:1.25;color:#fff;';

      const price = document.createElement('div');
      price.className = 'pc-price';
      price.style.cssText = 'font-size:1.45em;font-weight:800;color:#4ade80;letter-spacing:-0.01em;line-height:1;';

      const note = document.createElement('div');
      note.className = 'pc-note';
      note.style.cssText = 'font-size:0.78em;color:#c4b5fd;line-height:1.4;opacity:0.92;';

      // Countdown row — hidden unless a deal deadline is set
      const countdown = document.createElement('div');
      countdown.className = 'pc-countdown';
      countdown.style.cssText = 'font-size:0.78em;font-weight:700;color:#facc15;display:none;align-items:center;gap:5px;';

      const qrRow = document.createElement('div');
      qrRow.className = 'pc-qr-row';
      qrRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:4px;';

      const qrImg = document.createElement('img');
      qrImg.className = 'pc-qr';
      qrImg.style.cssText = 'width:72px;height:72px;border-radius:8px;background:#fff;padding:4px;box-sizing:border-box;flex-shrink:0;display:none;';
      qrImg.alt = 'QR code';

      const qrLabel = document.createElement('div');
      qrLabel.style.cssText = 'font-size:0.7em;color:#e2e8f0;opacity:0.7;line-height:1.4;';
      qrLabel.textContent = 'Scan to shop';

      qrRow.append(qrImg, qrLabel);
      card.append(ribbon, badge, name, price, note, countdown, qrRow);
      wrap.appendChild(card);

      this._el = wrap;
      this._card = card;
      this._ribbon = ribbon;
      this._name = name;
      this._price = price;
      this._note = note;
      this._countdown = countdown;
      this._qrImg = qrImg;
      this._qrRow = qrRow;

      const s = this._stage;
      if (getComputedStyle(s).position === 'static') s.style.position = 'relative';
      s.appendChild(wrap);
    }

    _startCountdown(dealEndsAt) {
      clearInterval(this._countdownTimer);
      const tick = () => {
        const remaining = (dealEndsAt - Date.now()) / 1000;
        if (remaining <= 0) {
          this._countdown.textContent = '⏰ Deal ended';
          this._countdown.classList.add('pc-hot');
          clearInterval(this._countdownTimer);
          return;
        }
        this._countdown.textContent = `⏰ Ends in ${fmtClock(remaining)}`;
        this._countdown.classList.toggle('pc-hot', remaining <= 60);
      };
      tick();
      this._countdownTimer = setInterval(tick, 1000);
    }

    /**
     * Show the card with the given product data.
     * @param {{ name:string, price:string, note:string, url:string,
     *           bestSeller?:boolean, dealEndsAt?:number, dealSeconds?:number }} data
     */
    show(data) {
      data = data || {};
      this._name.textContent = data.name || '';
      this._note.textContent = data.note || '';
      this._note.style.display = data.note ? '' : 'none';

      this._ribbon.style.display = data.bestSeller ? '' : 'none';

      if (data.url) {
        this._qrImg.src = 'product/qr.svg?_=' + encodeURIComponent(data.url).slice(0, 40);
        this._qrImg.style.display = '';
        this._qrRow.style.display = '';
      } else {
        this._qrImg.src = '';
        this._qrImg.style.display = 'none';
        this._qrRow.style.display = 'none';
      }

      // Countdown: accept either an absolute deadline (dealEndsAt, from the server) or a
      // relative duration (dealSeconds, for local/publisher-only previews).
      const dealEndsAt = data.dealEndsAt || (data.dealSeconds ? Date.now() + data.dealSeconds * 1000 : null);
      clearInterval(this._countdownTimer);
      if (dealEndsAt && dealEndsAt > Date.now()) {
        this._countdown.style.display = 'flex';
        this._startCountdown(dealEndsAt);
      } else {
        this._countdown.style.display = 'none';
      }

      clearTimeout(this._fadeTimer);
      this._el.style.display = '';
      this._card.classList.remove('pc-anim-out');
      // Force reflow so the animation restarts even when the same product is re-pushed.
      void this._card.offsetWidth;
      this._card.classList.add('pc-anim-in');
      this._card.style.opacity = '1';

      // Count the price up rather than setting it instantly.
      animateCountUp(this._price, data.price || '', 700);

      this._visible = true;
    }

    /** Hide the card with a spring-out. */
    hide() {
      if (!this._visible) return;
      this._card.classList.remove('pc-anim-in');
      this._card.classList.add('pc-anim-out');
      this._visible = false;
      clearInterval(this._countdownTimer);
      clearTimeout(this._fadeTimer);
      this._fadeTimer = setTimeout(() => {
        this._el.style.display = 'none';
        this._card.classList.remove('pc-anim-out');
        this._card.style.opacity = '0';
      }, 340);
    }

    /**
     * Convenience: call with a server 'product' SSE payload.
     * { visible, name, price, note, url, bestSeller, dealEndsAt }
     */
    update(data) {
      if (data && data.visible) this.show(data);
      else this.hide();
    }
  }

  window.ProductCard = ProductCard;
})();

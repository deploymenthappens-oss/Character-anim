/*
 * 10-product.js — publisher-side product spotlight control panel
 *
 * Wires the "Product spotlight" panel in publish.html:
 *   - "Push to scene" / "Hide card" buttons -> POST /product
 *   - Quick-swap preset buttons (edit PRODUCT_PRESETS below to match your catalog)
 *   - 🔥 Best seller checkbox + ⏱ deal-timer minutes field
 *   - Live QR preview in the sidebar when a URL is filled in
 *   - State label showing what's currently on screen
 *   - Also mounts a ProductCard on the publisher's own stage so the streamer
 *     sees exactly what viewers see (same component, same CSS, real-time).
 *
 * Avatar + room reactions on push (no Rive editing required — this is all done
 * with the existing gesture library in avatar-orchestra.js and the Hawkins room
 * inputs already exposed by hawkins-room.js):
 *   - Every push: 'present' gesture (arm out toward camera) + a lean-in + a camera
 *     punch-in, so the character visibly "sells" the card that just appeared.
 *   - The FIRST push of the session, or any push marked 🔥 Best seller: 'celebrate'
 *     (two-handed hop) instead of 'present' — reserved so it reads as a genuine
 *     highlight rather than firing on every single swap.
 *   - Every push also fires a quick candle flicker + a brief lava-lamp color pulse
 *     in the room, purely cosmetic and reverted automatically a couple seconds later.
 * All of the above is broadcast (broadcastGesture / broadcastRoomInput, both from
 * 05-speech.js / 02-room.js) so every viewer's avatar and room react in sync, not
 * just the publisher's own preview.
 *
 * Depends on: window.ADMIN_TOKEN (set by 09-init-boot.js), window.ProductCard (product-card.js),
 *             globals rig, room, camPunch, cueOrchestra, broadcastRoomInput (defined in
 *             00-state.js / 02-room.js / 03-background.js / 05-speech.js, all loaded earlier),
 *             DOM ids: productName, productPrice, productNote, productUrl, productBestSeller,
 *             productDealMin, productPush, productHide, productPresetRow, productQrPreview,
 *             productQrImg, productState.
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  //  EDIT THESE to match your own catalog. Each preset fills the form
  //  and can be one-click pushed. Keep to 4–6 for a tidy button row.
  //  Set bestSeller:true on your top mover — it gets the bigger avatar
  //  celebration + the 🔥 ribbon on the card every time it's pushed.
  //  Set dealMinutes on a preset to auto-fill a countdown timer.
  //  URLs are intentionally blank — paste your real product links in.
  // ──────────────────────────────────────────────────────────────────
  const PRODUCT_PRESETS = [
    {
      label: '👟 Sneaker',
      name:  'Canvas High-Top Sneaker',
      price: '$49 / 1,500 EGP',
      note:  'Sizes 38–46 · Ships same day',
      url:   '',   // ← paste your product URL here
      bestSeller: false,
      dealMinutes: 0,
    },
    {
      label: '👜 Bag',
      name:  'Leather Crossbody Bag',
      price: '$89 / 2,750 EGP',
      note:  'Black & tan · Limited stock',
      url:   '',
      bestSeller: false,
      dealMinutes: 0,
    },
    {
      label: '🕶️ Shades',
      name:  'Polarized Aviator Sunglasses',
      price: '$35 / 1,100 EGP',
      note:  'UV400 · 3 colors available',
      url:   '',
      bestSeller: false,
      dealMinutes: 0,
    },
    {
      label: '⌚ Watch',
      name:  'Minimalist Leather Watch',
      price: '$120 / 3,700 EGP',
      note:  'Water-resistant · 2-yr warranty',
      url:   '',
      bestSeller: false,
      dealMinutes: 0,
    },
  ];

  // ── helpers ─────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  function adminHeaders() {
    const tok = (window.ADMIN_TOKEN || '').trim();
    const h = { 'Content-Type': 'application/json' };
    if (tok) h['Authorization'] = 'Bearer ' + tok;
    return h;
  }
  function setStatus(msg, ok) {
    const el = $('productState');
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok === false ? '#f87171' : ok === true ? '#4ade80' : '';
  }

  // ── QR preview (sidebar only — not the viewer card) ─────────────
  let qrDebounce = null;
  function refreshQrPreview() {
    const url = ($('productUrl').value || '').trim();
    const prev = $('productQrPreview');
    const img  = $('productQrImg');
    if (!prev || !img) return;
    if (!url) { prev.style.display = 'none'; img.src = ''; return; }
    clearTimeout(qrDebounce);
    qrDebounce = setTimeout(() => {
      // Use Google Charts API — same as the server's makeQrSvg()
      const qrUrl = 'https://chart.googleapis.com/chart?chs=128x128&cht=qr&chl='
        + encodeURIComponent(url) + '&choe=UTF-8';
      img.src = qrUrl;
      prev.style.display = '';
    }, 420);
  }

  // ── fill form fields from a preset or data object ───────────────
  function fillForm(p) {
    $('productName').value  = p.name  || '';
    $('productPrice').value = p.price || '';
    $('productNote').value  = p.note  || '';
    $('productUrl').value   = p.url   || '';
    const bs = $('productBestSeller'); if (bs) bs.checked = !!p.bestSeller;
    const dm = $('productDealMin');    if (dm) dm.value   = p.dealMinutes ? p.dealMinutes : '';
    refreshQrPreview();
  }

  // ── avatar + room "sell it" reactions ────────────────────────────
  // Tracks whether we've already done the big celebration this page session, so
  // routine swaps don't all get the two-handed hop — only the first reveal does.
  let hasCelebratedThisSession = false;

  function reactAvatar(isHighlight) {
    if (!rig || !rig.ready) return;
    try {
      if (typeof camPunch === 'function') camPunch(isHighlight ? 1 : 0.75);
      if (isHighlight && typeof cueOrchestra === 'function') {
        cueOrchestra('celebrate');
      } else {
        if (typeof cueOrchestra === 'function') cueOrchestra('present');
        if (typeof rig.leanCue === 'function') rig.leanCue();
      }
    } catch (e) { /* non-fatal — avatar reaction is a bonus, not required for the push to work */ }
  }

  function reactRoom() {
    if (typeof room === 'undefined' || !room || !room.ready) return;
    try {
      // Quick candle flicker across three candles, staggered.
      ['Candle1Click', 'Candle3Click', 'Candle5Click'].forEach((n, i) => {
        setTimeout(() => {
          room.fire(n);
          if (typeof broadcastRoomInput === 'function') broadcastRoomInput('trigger', n);
        }, i * 140);
      });
      // Brief lava-lamp color pulse — only if it isn't already on, and only for ~2.5s.
      if (room.getBool && room.toggleBool && !room.getBool('GreenRUN-boolean')) {
        room.toggleBool('GreenRUN-boolean');
        if (typeof broadcastRoomInput === 'function') broadcastRoomInput('bool', 'GreenRUN-boolean', true);
        setTimeout(() => {
          if (!room.ready) return;
          room.toggleBool('GreenRUN-boolean');
          if (typeof broadcastRoomInput === 'function') broadcastRoomInput('bool', 'GreenRUN-boolean', false);
        }, 2500);
      }
    } catch (e) { /* non-fatal */ }
  }

  // ── push to server → all viewers ────────────────────────────────
  async function pushProduct() {
    const name  = ($('productName').value  || '').trim();
    const price = ($('productPrice').value || '').trim();
    const note  = ($('productNote').value  || '').trim();
    const url   = ($('productUrl').value   || '').trim();
    const bestSeller = !!($('productBestSeller') && $('productBestSeller').checked);
    const dealMin = Number(($('productDealMin') && $('productDealMin').value) || 0);
    const dealSeconds = dealMin > 0 ? Math.round(dealMin * 60) : 0;

    if (!name && !price) { setStatus('Enter at least a product name or price.', false); return; }

    setStatus('Pushing…');
    try {
      const r = await fetch('product', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name, price, note, url, bestSeller, dealSeconds }),
      });
      if (r.ok) {
        const body = await r.json().catch(() => null);
        const state = (body && body.product) || { name, price, note, url, bestSeller, dealEndsAt: dealSeconds ? Date.now() + dealSeconds * 1000 : null };
        setStatus(`✓ On screen: ${name || price}${bestSeller ? ' 🔥' : ''}`, true);
        // Also update the publisher's own preview card
        if (window._publisherProductCard) window._publisherProductCard.show({ ...state, visible: true });

        const isHighlight = bestSeller || !hasCelebratedThisSession;
        hasCelebratedThisSession = true;
        reactAvatar(isHighlight);
        reactRoom();
      } else {
        const txt = await r.text().catch(() => r.status);
        setStatus(`Error ${r.status}: ${txt}`, false);
      }
    } catch (e) { setStatus('Network error: ' + e.message, false); }
  }

  async function hideProduct() {
    setStatus('Hiding…');
    try {
      const r = await fetch('product', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ visible: false }),
      });
      if (r.ok) {
        setStatus('Card hidden.', true);
        if (window._publisherProductCard) window._publisherProductCard.hide();
      } else {
        setStatus('Error ' + r.status, false);
      }
    } catch (e) { setStatus('Network error: ' + e.message, false); }
  }

  // ── preset buttons ───────────────────────────────────────────────
  function buildPresets() {
    const row = $('productPresetRow');
    if (!row) return;
    PRODUCT_PRESETS.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = (p.bestSeller ? '🔥 ' : '') + p.label;
      btn.title = `Fill form: ${p.name} — ${p.price}`;
      btn.style.cssText = 'font-size:0.82em;padding:4px 10px;border-radius:20px;white-space:nowrap;';
      btn.addEventListener('click', () => {
        fillForm(p);
        btn.style.outline = '2px solid #a78bfa';
        setTimeout(() => { btn.style.outline = ''; }, 900);
      });
      // Double-click → fill AND push immediately
      btn.addEventListener('dblclick', async () => {
        fillForm(p);
        await pushProduct();
      });
      row.appendChild(btn);
    });
    if (PRODUCT_PRESETS.length) {
      const hint = document.createElement('span');
      hint.className = 'note';
      hint.style.cssText = 'font-size:0.7em;align-self:center;white-space:nowrap;';
      hint.textContent = '(dbl-click = push instantly)';
      row.appendChild(hint);
    }
  }

  // ── publisher preview card on the stage ─────────────────────────
  // The streamer sees the same card viewers see, live on the publisher's own stage.
  function mountPublisherCard() {
    const stage = document.querySelector('.avatar-stage, #stage, .stage');
    if (!stage || !window.ProductCard) return;
    window._publisherProductCard = new ProductCard({ stageEl: stage });
    // Restore current server state on page load
    fetch('product').then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.visible) window._publisherProductCard.show(d);
    }).catch(() => {});
  }

  // ── also handle the SSE onProduct event in the publisher's chat instance ──
  // The chat instance is created in 09-init-boot.js; we patch onProduct after the fact.
  function patchChatOnProduct() {
    // Try immediately; if the chat object isn't ready yet, wait for DOMContentLoaded flush.
    const tryPatch = () => {
      if (window._chat && typeof window._chat.onProduct !== 'undefined') {
        window._chat.onProduct = d => {
          if (window._publisherProductCard) window._publisherProductCard.update(d);
          if (d && d.visible) setStatus(`✓ On screen: ${d.name || d.price || 'product'}`, true);
          else setStatus('Card hidden.', true);
        };
      }
    };
    tryPatch();
    // Belt-and-suspenders: also patch after a short delay in case init-boot runs after us
    setTimeout(tryPatch, 800);
  }

  // ── init ────────────────────────────────────────────────────────
  function init() {
    const push = $('productPush');
    const hide = $('productHide');
    const urlInput = $('productUrl');

    if (push) push.addEventListener('click', pushProduct);
    if (hide) hide.addEventListener('click', hideProduct);
    if (urlInput) urlInput.addEventListener('input', refreshQrPreview);

    // Also push on Enter inside any product field
    ['productName', 'productPrice', 'productNote', 'productDealMin'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pushProduct(); } });
    });
    if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pushProduct(); } });

    buildPresets();
    mountPublisherCard();
    patchChatOnProduct();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

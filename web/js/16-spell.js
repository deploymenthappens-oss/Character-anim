// =====================================================================
//  16-spell.js — "The Upside Down spell": a movie scene.
//
//  Loaded by BOTH pages (after 15-game.js). The admin's button POSTs /spell once; the server tells every viewer; each screen runs
//  the SAME timeline locally (the same way the wand vanish works), so nothing streams frame by frame:
//
//     0.0 s  the camera pushes in on the character (slow ease, background moves less -> depth, edges darken) while he raises the wand
//     0.9 s  he CONJURES: the wand traces circles with a sparkle trail, the room's lights surge with the building magic
//     3.2 s  the big flick - white flash + sub-bass hit, and the room flips (TunnelBoolean) at that exact instant
//     3.5 s  the camera PULLS OUT (a small punch first) so the viewer watches the room transform, then settles back to normal
//
//  Camera backends: publish.html drives the existing CINE virtual camera (Spell forces its targets; the composited stream shows it);
//  view.html has no camera, so the stage layers get CSS transforms (--cb* background, --ca* character, see style.css) about a pivot
//  between his face and the wand circles. Everything is cleaned up at the end - no lasting state.
//
//  If the wand can't be used (arm rig missing, a wave in progress, another cast running) the same scene plays with a timed flick.
//  Tune live: Spell.cfg   |   Spell.play({on:true, dry:true}) = run the scene on THIS screen without changing the room.
// =====================================================================
window.Spell = (() => {
  'use strict';
  const isPublish = typeof CINE !== 'undefined';           // publish.html has the CINE camera; view.html does not
  const cfg = {
    inMs: 1500,          // push-in duration
    swirlMs: 2400,       // conjuring
    turns: 2.5,          // circles traced
    zoomIn: 1.5,         // camera push (1 = none)
    creep: 0.18,         // extra slow push during the conjuring, as a fraction of (zoomIn-1)
    outDelayMs: 260,     // hold after the flick before pulling out (lets the flash land)
    outMs: 2100,         // pull-out duration
    parallax: 0.35,      // viewers: the background zooms this fraction of the character's zoom (depth)
    pubPivot: { x: 0.47, y: 0.34 },   // publish: the point (fraction of the frame) the camera pushes toward
    tilt: 1.4,           // publish: dutch angle in degrees while building
    wand: true,          // use the wand (false = camera + room only)
    audio: !isPublish,   // sub-bass hit + whoosh at the flick (off on publish so it can't feed back into the mic)
  };
  const S = { active: false, phase: 'idle', on: true, dry: false, t0: 0, flickAt: 0, zFlick: 1, energy: 0, flash: 0, pv: null, raf: 0, timers: [], beatAt: 0, ac: null };
  const clamp01 = k => Math.max(0, Math.min(1, k));
  const eio = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const sm = k => k * k * (3 - 2 * k);
  const later = (f, ms) => { const t = setTimeout(f, ms); S.timers.push(t); return t; };
  const roomObj = () => (typeof room !== 'undefined' ? room : null);

  // ── viewer overlay (flash + darkening edges) and CSS camera ──────────────────────────────────
  let stageEl = null, fx = null;
  function viewSetup() {
    if (isPublish) return;
    stageEl = document.getElementById('stage');
    if (!stageEl || fx) return;
    const mk = css => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;' + css; stageEl.appendChild(d); return d; };
    fx = {
      vign: mk('z-index:6;background:radial-gradient(ellipse at 50% 46%,rgba(90,0,20,0) 38%,rgba(90,0,20,.85) 100%)'),
      flash: mk('z-index:7;background:radial-gradient(circle at 50% 46%,#fff 0%,rgba(255,238,225,.92) 55%,rgba(255,200,180,.75) 100%)'),
    };
  }
  function viewCamera(z, pv) {                              // pv = pivot in stage px
    const W = stageEl.clientWidth, H = stageEl.clientHeight, sb = 1 + (z - 1) * cfg.parallax, set = (k, v) => stageEl.style.setProperty(k, v);
    // scaling about a pivot Q by s for a layer whose transform-origin is o:  translate = (Q - o) * (1 - s)
    set('--cbs', sb.toFixed(4)); set('--cbx', ((pv.x - W / 2) * (1 - sb)).toFixed(1) + 'px'); set('--cby', ((pv.y - H / 2) * (1 - sb)).toFixed(1) + 'px');   // background: origin 50% 50%
    set('--cas', z.toFixed(4));  set('--cax', ((pv.x - W / 2) * (1 - z)).toFixed(1) + 'px');  set('--cay', ((pv.y - H) * (1 - z)).toFixed(1) + 'px');       // character: origin 50% 100%
  }
  function viewClear() { ['--cbs', '--cbx', '--cby', '--cas', '--cax', '--cay'].forEach(k => stageEl.style.removeProperty(k)); }

  // pivot between his face and the wand circles, in stage px (view) - so both stay in frame while we push in
  function viewPivot() {
    const r = window.__avatarRig, fr = r && r.handFrame && r.handFrame(), c = window.WandCast && window.WandCast.swirlCenter && window.WandCast.swirlCenter(r);
    const b = stageEl.getBoundingClientRect();
    if (!fr || !c) return { x: b.width * 0.46, y: b.height * 0.4 };
    const u = fr.unit, head = { x: fr.shoulder.x + 60 * u, y: fr.shoulder.y - 70 * u };
    return { x: (head.x + c.x) / 2 - b.left, y: (head.y + c.y) / 2 - b.top };
  }

  // ── the timeline ─────────────────────────────────────────────────────────────────────────────
  function frame(now) {
    S.raf = 0;
    if (!S.active) return;
    const t = now - S.t0;
    let z, tilt = 0;
    if (S.phase === 'build') {
      const b = clamp01((t - cfg.inMs) / cfg.swirlMs);
      z = 1 + (cfg.zoomIn - 1) * (eio(clamp01(t / cfg.inMs)) + cfg.creep * sm(b));
      S.zFlick = z; tilt = cfg.tilt * sm(clamp01(t / cfg.inMs));
      S.energy = 0.92 * sm(clamp01(t / (cfg.inMs + cfg.swirlMs)));
      S.flash = 0;
      if (t - S.beatAt > 380 && t > cfg.inMs * 0.6) {                  // the room's lights pulse with the building magic
        S.beatAt = t; const r = roomObj();
        try { r && r.reactToBeat && r.reactToBeat(0.5 + 0.5 * S.energy); } catch (e) {}
      }
    } else {                                                              // 'out': after the flick
      const dt = now - S.flickAt, q = clamp01((dt - cfg.outDelayMs) / cfg.outMs);
      const punch = 0.06 * Math.exp(-dt / 170);                            // a small kick at the flick, then the pull-out
      z = 1 + (S.zFlick - 1) * (1 - eio(q)) + punch * (1 - q);
      tilt = cfg.tilt * (1 - eio(q));
      S.energy = 0.92 * Math.max(0, 1 - dt / (cfg.outDelayMs + cfg.outMs * 0.9));
      S.flash = Math.max(0, Math.exp(-dt / 260) * 1.0);
      if (q >= 1 && dt > cfg.outDelayMs + cfg.outMs) { finish(); return; }
    }
    if (isPublish) {
      const W = stage.width, H = stage.height, Fx = W / 2, Fy = H * ($('frameMode').value === 'half' ? 0.40 : 0.28);
      const pvx = W * cfg.pubPivot.x, pvy = H * cfg.pubPivot.y;
      CINE.force = { z, x: (pvx - Fx) * (1 - z) / W, y: (pvy - Fy) * (1 - z) / H, r: tilt };
    } else {
      if (!S.pv) S.pv = viewPivot();
      viewCamera(z, S.pv);
      if (fx) { fx.vign.style.opacity = (S.energy * 0.8).toFixed(3); fx.flash.style.opacity = (S.flash * 0.9).toFixed(3); }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function flick() {                                                       // the wand snaps forward: the room changes NOW
    if (S.phase !== 'build') return;
    S.phase = 'out'; S.flickAt = performance.now(); S.flash = 1;
    sting();
    if (!S.dry) applyRoom(S.on);
    const r = roomObj(); try { r && r.reactToBeat && r.reactToBeat(1); } catch (e) {}
  }

  function applyRoom(on) {
    const go = () => {
      const r = roomObj(); if (!r || !r.ready) return;
      if (r.getBool('TunnelBoolean') !== on) r.toggleUpsideDown();          // also resets DemVisible when turning it off
      if (typeof syncUpsideDownBadge === 'function') { syncUpsideDownBadge(on); if (typeof syncDemVisibleBtn === 'function') syncDemVisibleBtn(); }
    };
    const r = roomObj();
    if (r && !r.ready && typeof ensureRoomLoaded === 'function') ensureRoomLoaded().then(go).catch(() => {}); else go();
  }

  function finish() {
    S.timers.forEach(clearTimeout); S.timers = [];
    if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0;
    S.active = false; S.phase = 'idle'; S.energy = 0; S.flash = 0; S.pv = null;
    if (isPublish) CINE.force = null;
    else if (stageEl) { viewClear(); stageEl.classList.remove('spell-cine'); if (fx) { fx.vign.style.opacity = 0; fx.flash.style.opacity = 0; } }
  }

  // opts: {on: true|false (the state to end in), dry: true = visuals only, no room change}
  function play(opts) {
    opts = opts || {};
    if (S.active) return false;
    viewSetup();
    S.active = true; S.phase = 'build'; S.on = opts.on !== false; S.dry = !!opts.dry; S.t0 = performance.now(); S.flickAt = 0; S.zFlick = 1; S.beatAt = 0; S.pv = null;
    if (stageEl) stageEl.classList.add('spell-cine');                      // hides the speech bubble / game card while the camera moves
    const b = isPublish ? null : (stageEl || document.body).getBoundingClientRect(), WC = window.WandCast;
    const centre = b ? { x: b.left + b.width / 2, y: b.top + b.height * 0.45 } : { x: innerWidth / 2, y: innerHeight * 0.45 };
    if (cfg.wand && WC && !WC.busy && WC.available()) WC.cast(centre, flick, { arriveMs: 0, swirl: { ms: cfg.swirlMs, turns: cfg.turns } });
    else later(flick, cfg.inMs + 700 + cfg.swirlMs * 0.8);                  // no wand: same scene, timed flick
    later(() => { if (S.phase === 'build') flick(); }, cfg.inMs + cfg.swirlMs + 3500);           // never hang if the wand stalls
    later(() => { if (S.active) finish(); }, cfg.inMs + cfg.swirlMs + cfg.outDelayMs + cfg.outMs + 7000);
    S.raf = requestAnimationFrame(frame);
    return true;
  }

  // sub-bass drop + filtered whoosh, synthesized (no audio files). Silent if the browser hasn't allowed audio yet.
  function sting() {
    if (!cfg.audio) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const c = S.ac || (S.ac = new AC()); if (c.state === 'suspended') c.resume();
      const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.9);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 1.2);
      const n = Math.floor(c.sampleRate * 0.9), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const ns = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
      f.type = 'bandpass'; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.5); gn.gain.value = 0.22;
      ns.buffer = buf; ns.connect(f); f.connect(gn); gn.connect(c.destination); ns.start(t);
    } catch (e) { /* audio is decoration only */ }
  }

  // publish page: flash + darkening edges drawn onto the composited stream frame (called at the end of drawFrame)
  function drawOverlay(ctx, W, H) {
    if (S.energy > 0.02) {
      const g = ctx.createRadialGradient(W / 2, H * 0.48, H * 0.25, W / 2, H * 0.5, H * 0.95);
      g.addColorStop(0, 'rgba(90,0,20,0)'); g.addColorStop(1, `rgba(90,0,20,${(S.energy * 0.6).toFixed(3)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (S.flash > 0.01) { ctx.fillStyle = `rgba(255,238,225,${(S.flash * 0.9).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }

  return { cfg, play, drawOverlay, get energy() { return S.energy; }, get active() { return S.active; } };
})();

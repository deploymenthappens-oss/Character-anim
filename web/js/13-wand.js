// =====================================================================
//  13-wand.js — the magic wand: the character raises her/his arm, points a wand at the object and flicks it away.
//
//  Loaded by BOTH publish.html and view.html (after 11-office-scene.js). OfficeScene.hide() calls
//  WandCast.cast(clientPoint, fn) instead of vanishing the object at once; fn (the existing flash + cut) runs at the
//  moment of the flick. If the wand can't be used (no arm FK, a wave in progress, canvas hidden, cfg.on = false, a late-join
//  snapshot) OfficeScene skips this and vanishes the object exactly as before.
//
//  How it stays "touching" the hand: every frame the wand is laid on the live right-hand bone (rig.handFrame()) - its
//  grip point sits on hand_R and it is rotated with the hand's world angle - so it follows the arm through the raise,
//  the follow-smoothing and any walk / zoom / lean-in CSS transform. The arm itself is aimed by the existing
//  point-at-cursor forward kinematics (rig.aimAtClient / rig.setCast), so nothing in the .riv changes.
//
//  Tuning: WandCast.cfg (all live). Console test: WandCast.test()   |   turn off: WandCast.cfg.on = false
//  Art: LottieFiles "Magic Animation" (stick only, animation stripped) - check its licence before streaming with it.
// =====================================================================
window.WandCast = (() => {
  'use strict';

  const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" height=\"100%\" width=\"100%\" viewBox=\"30 30 540 540\"><g visibility=\"visible\" id=\"Stick Outlines\"><g transform=\"translate(294.441,297.05)\"><g transform=\"rotate(0)\"><g transform=\"scale(1,1) translate(-256.086,-254.669)\"><g id=\"Group 5\" transform=\"matrix(1,0,0,1,327.986,184.88)\"><path fill=\"#ef8c33\" fill-opacity=\"1\" d=\"M170.948,-153.969C170.948,-153.969,-3.583,28.766,-3.583,28.766C-3.583,28.766,8.031,40.38,8.031,40.38C8.031,40.38,-43.74,71.956,-61.228,90.766C-61.228,90.766,-139.526,174.967,-139.526,174.967C-139.526,174.967,-160.546,153.957,-160.546,153.957C-160.546,153.957,-175.519,138.984,-175.519,138.984C-175.519,138.984,-156.84,121.618,-156.84,121.618C-138.874,103.652,-125.132,68.442,-125.132,68.442C-125.132,68.442,-112.856,80.719,-112.856,80.719C-112.856,80.719,153.43,-171.558,153.43,-171.558C155.832,-173.828,158.896,-174.967,161.97,-174.967C165.156,-174.967,168.332,-173.747,170.755,-171.324C170.979,-171.1,171.193,-170.865,171.396,-170.631C175.519,-165.837,175.396,-158.621,170.948,-153.969Z\" /></g><g id=\"Group 4\" transform=\"matrix(1,0,0,1,101.105,408.341)\"><path fill=\"#ef8c33\" fill-opacity=\"1\" d=\"M93.113,-42.729C76.319,-59.523,59.524,-76.318,42.73,-93.112C2.57,-42.985,-42.985,2.569,-93.113,42.729C-76.319,59.523,-59.524,76.318,-42.73,93.112C-2.569,42.984,42.986,-2.57,93.113,-42.729Z\" /></g><g id=\"Group 3\" transform=\"matrix(1,0,0,1,83.801,391.037)\"><path fill=\"#d87625\" fill-opacity=\"1\" d=\"M75.811,-60.032C70.551,-65.292,65.293,-70.55,60.033,-75.81C19.873,-25.682,-25.683,19.873,-75.811,60.033C-70.551,65.293,-65.293,70.551,-60.033,75.811C-9.905,35.651,35.652,-9.904,75.811,-60.032Z\" /></g><g id=\"Group 2\" transform=\"matrix(1,0,0,1,325.926,174.377)\"><path fill=\"#d87625\" fill-opacity=\"1\" d=\"M173.456,-160.128C173.456,-160.128,-87.556,96.253,-87.556,96.253C-87.556,96.253,-158.484,164.463,-158.484,164.463C-158.484,164.463,-173.457,149.49,-173.457,149.49C-173.457,149.49,-154.778,132.124,-154.778,132.124C-136.812,114.158,-123.07,78.949,-123.07,78.949C-123.07,78.949,-110.794,91.224,-110.794,91.224C-110.794,91.224,155.49,-161.053,155.49,-161.053C157.892,-163.323,160.956,-164.464,164.03,-164.464C167.216,-164.464,170.392,-163.242,172.815,-160.819C173.039,-160.595,173.252,-160.362,173.456,-160.128Z\" /></g><g id=\"Group 1\" transform=\"matrix(1,0,0,1,256.085,254.67)\"><path fill=\"#000000\" fill-opacity=\"1\" fill-rule=\"evenodd\" d=\"M87.508,-28.508C87.785,-30.833,86.981,-33.157,85.326,-34.812C85.326,-34.812,78.993,-41.144,78.993,-41.144C78.993,-41.144,248.372,-218.484,248.372,-218.484C255.835,-226.298,255.692,-238.873,248.051,-246.513C240.312,-254.251,228.025,-254.42,220.079,-246.892C220.079,-246.892,-40.81,0.281,-40.81,0.281C-40.81,0.281,-47.831,-6.74,-47.831,-6.74C-49.654,-8.563,-52.272,-9.343,-54.796,-8.813C-57.318,-8.284,-59.404,-6.519,-60.342,-4.117C-60.473,-3.78,-73.642,29.659,-90.238,46.334C-90.238,46.334,-103.422,58.593,-103.422,58.593C-103.422,58.593,-106.853,55.162,-106.853,55.162C-108.388,53.627,-110.507,52.821,-112.67,52.937C-114.837,53.056,-116.852,54.092,-118.208,55.786C-157.953,105.394,-203.258,150.7,-252.867,190.444C-254.561,191.801,-255.597,193.815,-255.716,195.982C-255.835,198.149,-255.026,200.265,-253.491,201.799C-253.491,201.799,-203.107,252.183,-203.107,252.183C-201.672,253.619,-199.729,254.419,-197.709,254.419C-197.57,254.419,-197.429,254.415,-197.289,254.408C-195.122,254.289,-193.107,253.253,-191.751,251.559C-152.007,201.95,-106.701,156.645,-57.093,116.902C-55.399,115.545,-54.363,113.53,-54.244,111.363C-54.125,109.196,-54.934,107.08,-56.469,105.546C-56.469,105.546,-57.022,104.993,-57.022,104.993C-57.022,104.993,16.263,26.176,16.263,26.176C32.838,8.35,83.393,-22.584,83.902,-22.894C85.901,-24.115,87.231,-26.183,87.508,-28.508ZM-179.177,212.789C-179.177,212.789,-198.796,193.169,-198.796,193.169C-201.777,190.188,-206.612,190.188,-209.592,193.169C-212.573,196.15,-212.573,200.985,-209.592,203.965C-209.592,203.965,-189.158,224.399,-189.158,224.399C-192.234,228.041,-195.292,231.697,-198.307,235.388C-198.307,235.388,-236.695,197,-236.695,197C-197.601,165.052,-161.222,129.685,-128.139,91.521C-128.139,91.521,-106.164,113.496,-106.164,113.496C-104.674,114.986,-102.719,115.732,-100.766,115.732C-98.813,115.732,-96.858,114.987,-95.368,113.496C-92.387,110.515,-92.387,105.68,-95.368,102.7C-95.368,102.7,-118.2,79.868,-118.2,79.868C-116.002,77.242,-113.816,74.605,-111.649,71.954C-111.649,71.954,-73.261,110.342,-73.261,110.342C-111.319,141.442,-146.802,175.784,-179.177,212.789ZM5.083,15.777C5.083,15.777,-67.825,94.187,-67.825,94.187C-67.825,94.187,-92.617,69.395,-92.617,69.395C-92.617,69.395,-79.736,57.418,-79.736,57.418C-79.668,57.355,-79.602,57.291,-79.536,57.226C-66.824,44.514,-56.346,24.311,-50.677,12.006C-50.677,12.006,-46.351,16.332,-46.351,16.332C-46.351,16.332,-37.309,25.374,-37.309,25.374C-35.819,26.864,-33.863,27.61,-31.91,27.61C-29.957,27.61,-28.002,26.865,-26.512,25.374C-23.531,22.393,-23.531,17.559,-26.512,14.579C-26.512,14.579,-30.01,11.08,-30.01,11.08C-30.01,11.08,230.58,-235.807,230.58,-235.807C232.475,-237.603,235.405,-237.563,237.253,-235.716C239.076,-233.893,239.11,-230.895,237.329,-229.03C237.329,-229.03,68.194,-51.943,68.194,-51.943C68.194,-51.943,64.28,-55.857,64.28,-55.857C61.3,-58.839,56.466,-58.838,53.484,-55.857C50.503,-52.876,50.502,-48.042,53.484,-45.061C53.484,-45.061,62.911,-35.635,62.911,-35.635C62.914,-35.632,62.918,-35.627,62.921,-35.624C62.921,-35.624,67.738,-30.807,67.738,-30.807C52.187,-20.951,18.942,0.872,5.083,15.777Z\" /></g></g></g></g></g></svg>";

  const cfg = {
    on: true,
    trick: 'hide',      // WHEN the trick (wand + camera shot) plays: 'hide' = when an object disappears, 'show' = when it appears, 'both'
    lenUnits: 210,      // wand length from grip to tip, in avatar artboard units (the hand bone is 82)
    grip: { x: 0.222, y: 0.759 },   // where the hand holds it, as a fraction of the (square) art
    raiseMs: 620,       // wait for the arm to come up before the first flick (POINT.raise is 0.5 s)
    windMs: 130,        // wind-up (wand tips back)
    flickMs: 90,        // the flick itself - the vanish is triggered at its start
    settleMs: 170,      // wand settles
    holdMs: 550,        // keep the arm up this long after the last flick, then lower it
    fadeMs: 260,        // wand fades in / out
    batch: 4,           // objects vanished by ONE flick (so "hide all" doesn't take forever)
    windDeg: -16, flickDeg: 13,
    gaze: true,         // eyes follow the object being vanished, rest on the empty spot, then flick back to the viewers
    gazeMs: 1100,       // how long she keeps looking at the empty spot after the wand is lowered
  };

  let el = null, spark = null, raf = 0, last = 0;
  const S = { active: false, phase: 'idle', t: 0, vis: 0, q: [], target: null, ft: 0, fired: false, batch: [], hold: 0, arrive: 0, trk: [], sw: 0, spell: null, sparkAt: 0 };

  const rig = () => window.__avatarRig || null;
  const ease = k => k * k * (3 - 2 * k);

  // can a cast happen right now? (OfficeScene asks before it delays anything)
  function available() {
    const r = rig();
    if (!cfg.on || !r || !r.fkOk || r.waving || !r._arm) return false;
    if (document.hidden) return false;            // rAF is paused in a hidden tab - never hold a vanish hostage to it
    const b = r.canvas && r.canvas.getBoundingClientRect();
    return !!(b && b.width > 20 && b.height > 20) && !!r.handFrame();
  }

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:60;opacity:0;will-change:transform,opacity;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
    el.innerHTML = SVG;
    document.body.appendChild(el);
    spark = document.createElement('div');
    spark.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:61';
    document.body.appendChild(spark);
  }

  // a small glint at the wand tip at the instant of the flick (the bigger flash is OfficeScene's, at the object)
  function glint(x, y, size) {
    if (!spark || !spark.animate) return;
    const d = document.createElement('div'), s = Math.max(24, size);
    d.style.cssText = `position:fixed;left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;border-radius:50%;` +
      'pointer-events:none;background:radial-gradient(circle,rgba(255,255,255,.95) 0%,rgba(255,244,214,.6) 35%,rgba(255,240,200,0) 70%);mix-blend-mode:screen';
    spark.appendChild(d);
    const a = d.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1)', offset: .3 }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 420, easing: 'ease-out' });
    a.onfinish = () => d.remove();
  }

  function safe(fn) { try { fn && fn(); } catch (e) { console.warn('WandCast: vanish callback failed - ' + e.message); } }

  // ask for a vanish: pt = {x,y} client pixels of the object. fn = the real vanish (flash + cut), run at the flick.
  // pt = {x,y} client px; pt.track (optional, from OfficeScene.trackPoint) = live projection, re-read every frame so the wand and
  // eyes keep following an object while the camera moves. opts.arriveMs = how long the auto-pilot camera needs to arrive:
  // the first flick waits for it.
  function cast(pt, fn, opts) {
    if (!available() || !pt) { safe(fn); return; }
    S.q.push({ pt, fn });
    S.target = pt;
    if (pt.track) S.trk.push(pt.track);
    if (!S.active) start(opts);
    else if (S.phase === 'drop') { rig().setCast(true); S.phase = 'raise'; S.t = cfg.raiseMs * 0.5; }
  }

  function start(opts) {
    build();
    S.arrive = Math.max(cfg.raiseMs, (opts && opts.arriveMs) || 0);
    // opts.swirl {ms, turns}: before the flick the wand CONJURES - the arm traces circles up and out to the side with a sparkle trail
    // (used by 16-spell.js for the Upside Down scene). The queued cast's fn still fires at the final flick.
    S.spell = opts && opts.swirl ? { ms: opts.swirl.ms || 2400, turns: opts.swirl.turns || 2.5, center: null } : null; S.sw = 0;
    S.active = true; S.phase = 'raise'; S.t = 0; S.hold = 0; S.fired = false; S.batch = [];
    rig().setCast(true);
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function finish() {
    S.active = false; S.phase = 'idle'; S.vis = 0;
    try { rig() && rig().setCast(false); } catch (e) {}
    if (el) el.style.opacity = '0';
    S.trk.splice(0).forEach(t => t.stop());
    if (cfg.gaze) setTimeout(() => { const r = rig(); if (r && !S.active) r.lookAt(0, 0); }, cfg.gazeMs);   // the double-take: back to the viewers
    // anything still queued (should not happen) is not left hanging
    const rest = S.q.splice(0); rest.forEach(b => safe(b.fn));
  }

  function tick(now) {
    raf = 0;
    if (!S.active) return;
    const r = rig();
    const dt = Math.min(100, now - last); last = now;
    // the wand can't be honoured any more (a wave took the arm, tab hidden, layout gone): flush the vanishes and stop
    if (!r || r.waving || document.hidden) {
      const rest = S.batch.splice(0).concat(S.q.splice(0));
      rest.forEach(b => safe(b.fn));
      finish(); return;
    }
    const tp = (S.batch[0] || S.q[0] || { pt: S.target }).pt;
    let tgt = (tp && tp.track && tp.track.get()) || tp;   // live position if tracked
    const sp = S.spell;
    if (sp && (S.phase === 'raise' || S.phase === 'ready' || S.phase === 'swirl')) {   // conjuring: orbit a point up-and-out from the shoulder
      const c = sp.center || (sp.center = swirlCenter(r));
      if (c) { const th = -Math.PI / 2 + Math.PI * 2 * sp.turns * ease(Math.min(1, S.sw / sp.ms)); tgt = { x: c.x + c.rx * Math.cos(th), y: c.y + c.ry * Math.sin(th) }; }
    }
    if (tgt) {
      r.aimAtClient(tgt.x, tgt.y);
      if (cfg.gaze) r.lookAt(Math.max(-1, Math.min(1, tgt.x / innerWidth * 2 - 1)), Math.max(-1, Math.min(1, tgt.y / innerHeight * 2 - 1)));
    }

    let flick = 0;
    switch (S.phase) {
      case 'raise':
        S.vis = Math.min(1, S.vis + dt / cfg.fadeMs);
        S.t += dt;
        if (S.t >= S.arrive) S.phase = 'ready';
        break;
      case 'ready':
        S.vis = 1;
        if (S.spell && !S.spell.done) { S.phase = 'swirl'; S.sw = 0; S.sparkAt = 0; break; }
        if (S.q.length) { S.batch = S.q.splice(0, cfg.batch); S.phase = 'flick'; S.ft = 0; S.fired = false; S.hold = 0; }
        else { S.hold += dt; if (S.hold >= cfg.holdMs) { S.phase = 'drop'; r.setCast(false); } }
        break;
      case 'swirl': {
        S.vis = 1; S.sw += dt;
        const p = Math.min(1, S.sw / S.spell.ms), env = Math.sin(Math.PI * p);
        flick = 11 * env * Math.sin(S.sw / 95);                                   // the wrist shakes while conjuring
        if (S.sw - S.sparkAt > 170) {                                             // sparkle trail at the wand tip, growing as the spell builds
          S.sparkAt = S.sw;
          const fr = r.handFrame();
          if (fr) { const rad = (fr.angle + flick) * Math.PI / 180, L = cfg.lenUnits * fr.unit; glint(fr.grip.x + Math.cos(rad) * L, fr.grip.y + Math.sin(rad) * L, L * (0.16 + 0.22 * p)); }
        }
        if (S.sw >= S.spell.ms) { S.spell.done = true; S.phase = 'ready'; S.hold = 0; }
        break;
      }
      case 'flick': {
        S.ft += dt;
        const w = cfg.windMs, f = cfg.flickMs, st = cfg.settleMs;
        if (S.ft < w) flick = cfg.windDeg * ease(S.ft / w);
        else if (S.ft < w + f) flick = cfg.windDeg + (cfg.flickDeg - cfg.windDeg) * ease((S.ft - w) / f);
        else flick = cfg.flickDeg * (1 - ease(Math.min(1, (S.ft - w - f) / st)));
        if (!S.fired && S.ft >= w) {                 // the moment the wand snaps forward: the object goes
          S.fired = true;
          const fr = r.handFrame();
          if (fr) {
            const rad = (fr.angle + flick) * Math.PI / 180, L = cfg.lenUnits * fr.unit;
            glint(fr.grip.x + Math.cos(rad) * L, fr.grip.y + Math.sin(rad) * L, L * 0.35);
          }
          S.batch.splice(0).forEach(b => safe(b.fn));
        }
        if (S.ft >= w + f + st) { S.phase = 'ready'; S.hold = 0; }
        break;
      }
      case 'drop':
        S.vis = Math.max(0, S.vis - dt / cfg.fadeMs);
        if (S.vis <= 0) { finish(); return; }
        break;
    }

    // lay the wand on the live hand
    const fr = r.handFrame();
    if (fr && el) {
      const W = cfg.lenUnits * fr.unit * 540 / 542, g = cfg.grip;
      el.style.width = el.style.height = W + 'px';
      el.style.transformOrigin = (g.x * 100) + '% ' + (g.y * 100) + '%';
      // the art's grip->tip axis points up-right (-45 deg on screen); turn it onto the hand's direction
      el.style.transform = `translate(${fr.grip.x - g.x * W}px,${fr.grip.y - g.y * W}px) rotate(${fr.angle + 45 + flick}deg) scale(${0.72 + 0.28 * ease(S.vis)})`;
      el.style.opacity = String(ease(S.vis));
    }
    raf = requestAnimationFrame(tick);
  }

  // where the conjuring circles are drawn, in client px: up and out to the side of the wand shoulder (the rig's right arm swings
  // out on screen-left), scaled by the avatar's on-screen size. null if the arm frame is unavailable.
  function swirlCenter(r) {
    const fr = (r || rig()) && (r || rig()).handFrame();
    if (!fr) return null;
    const u = fr.unit;
    return { x: fr.shoulder.x - 230 * u, y: fr.shoulder.y - 170 * u, rx: 95 * u, ry: 70 * u };
  }

  // console helper: vanish-style flick at a point to the left of the avatar (or at x,y)
  function test(x, y) {
    const pt = { x: x ?? innerWidth * 0.35, y: y ?? innerHeight * 0.4 };
    cast(pt, () => glint(pt.x, pt.y, 140));
  }

  // does the wand play for this kind of change? (kind = 'hide' | 'show'; the spell / console tests ignore this)
  const allows = kind => cfg.trick === 'both' || (cfg.trick || 'hide') === kind;

  return { cfg, cast, available, allows, test, swirlCenter, get busy() { return S.active; } };
})();

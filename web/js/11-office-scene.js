// =====================================================================
//  11-office-scene.js — Sketchfab Viewer API for studio-office-3d.
//
//  Gives every mesh, material, camera preset and animation in the 3D
//  office scene the same programmable panel that Hawkins room has.
//  Loaded by BOTH publish.html (admin → broadcast) and view.html
//  (viewers → receive & apply).
//
//  Usage:
//    OfficeScene.activate(iframeEl, onReady)
//      — call once the iframe src has been set. onReady() fires when
//        the Sketchfab API is initialised AND all discovery is done.
//
//  All node/material/animation IDs are auto-discovered from the live
//  model; no hard-coding required. The admin panel in publish.html
//  calls the methods below and broadcasts via POST /office-input;
//  view.html receives 'office-input' SSE and mirrors every change.
// =====================================================================

/* global Sketchfab */

// IMPORTANT: assigned to window explicitly - a plain top-level `const` in a
// classic <script> does NOT become a window property (unlike `var`), but
// every caller in this codebase (03-background.js, view.html) checks
// `window.OfficeScene`. Without this line that check silently fails forever
// and OfficeScene.activate() is never called by anything - which was the
// actual root cause of every "no connection / no control / no room" symptom.
window.OfficeScene = (() => {
  'use strict';

  const MODEL_UID = '6e41320708f74a6ba974ff8c26746ed8';

  let _api        = null;
  let _ready      = false;
  let _nodes      = {};   // instanceID(num) → {name, type, visible}
  let _materials  = [];   // [{id, name, channels, …}]
  let _animations = [];   // [[uid, name, duration], …]
  let _visMap     = {};   // instanceID → bool
  let _presets    = {};   // presetName → {eye:[x,y,z], target:[x,y,z]}
  let _animPlaying = false;

  // ── persist camera presets ─────────────────────────────────────────
  try {
    const s = localStorage.getItem('officePresets.v2');
    if (s) _presets = JSON.parse(s);
  } catch { /* storage blocked */ }

  function _savePresets() {
    try { localStorage.setItem('officePresets.v2', JSON.stringify(_presets)); } catch { /* ignored */ }
  }

  function _log(msg) { try { window.log?.(msg); } catch {} }

  // ── ACTIVATE ───────────────────────────────────────────────────────
  // Call after the iframe src is set. The Sketchfab SDK's init() can be
  // called immediately; it waits internally for the iframe to post back.
  function activate(iframeEl, onReady, opts) {
    // navigation: 'fps' = first-person walk (WASD/arrows + drag to look), 'orbit' = turntable.
    // Sketchfab's viewer reads this as the `navigation` embed parameter (no runtime API exists
    // to change it after load, so switching means re-running activate()).
    const navigation = (opts && opts.navigation) === 'orbit' ? 'orbit' : 'fps';
    stopWatchCamera();
    _api   = null;
    _ready = false;
    _nodes = {};
    _materials  = [];
    _animations = [];
    _visMap = {};
    _resetFx(iframeEl);

    if (!window.Sketchfab) {
      _log('OfficeScene: Sketchfab SDK not loaded — cannot init Viewer API');
      return;
    }

    const client = new window.Sketchfab(iframeEl);
    client.init(MODEL_UID, {
      autostart: 1,
      preload: 1,
      navigation,
      camera: 0,   // skip the intro fly-in so the scene opens at its saved view (matters for camera sync)
      ui_theme: 'dark',
      ui_infos: 0,
      ui_watermark: 0,        // logo itself   (Premium/Enterprise only - see --sf-crop in style.css for other plans)
      ui_watermark_link: 0,   // logo's link to the model page (same plan limit)
      ui_ar: 0,
      ui_vr: 0,
      ui_help: 0,
      ui_annotations: 0,
      ui_inspector: 0,
      ui_stop: 0,
      ui_hint: 0,
      // Hide ALL Sketchfab chrome: bottom control bar (settings gear, layers,
      // VR, fullscreen, help), title/author/share header, loading bar, etc.
      // The stream shows only the scene itself. What viewers see is driven by
      // the admin's camera (see watchCamera below), not by Sketchfab's own UI.
      ui_controls: 0,
      ui_settings: 0,
      ui_fullscreen: 0,
      ui_animations: 0,
      ui_loading: 0,
      ui_general_controls: 0,
      ui_sound: 0,
      transparent: 0,
      dnt: 1,

      success(api) {
        api.start();
        api.addEventListener('viewerready', () => {
          _api = api;
          _log('OfficeScene: viewer ready — running discovery…');
          _discover(onReady);
        });
      },

      error() {
        _log('OfficeScene: Sketchfab client.init() failed');
      },
    });
  }

  // ── LIVE CAMERA MIRROR ───────────────────────────────────────────
  // Polls the current camera and calls cb({eye,target}) whenever it has
  // moved. The admin uses this to broadcast whatever they are looking at in
  // publish, so every viewer's (non-interactive) scene matches it.
  let _watchTimer = null, _lastCam = '';
  function stopWatchCamera() { if (_watchTimer) clearInterval(_watchTimer); _watchTimer = null; _lastCam = ''; }
  function watchCamera(cb, intervalMs) {
    stopWatchCamera();
    _watchTimer = setInterval(() => {
      if (!_api || !_ready) return;
      _api.getCameraLookAt((err, cam) => {
        if (err || !cam) return;
        const key = [...cam.position, ...cam.target].map(n => n.toFixed(3)).join(',');
        if (key === _lastCam) return;
        _lastCam = key;
        cb({ eye: cam.position, target: cam.target });
      });
    }, intervalMs || 250);
  }

  // ── MANUAL WALKING ───────────────────────────────────────────────
  // Sketchfab has no "move" call, so we walk by shifting eye+target along the horizontal look
  // direction (Sketchfab world is Z-up) and writing the camera back.
  // Game-style: real-time delta (speed independent of frame rate/latency), diagonal input is
  // normalised (no sqrt2 speed boost), turning happens BEFORE moving (so you go where you face),
  // pitch is preserved, and the camera is integrated locally while keys are held (read once
  // at start, never per tick) so there is no round-trip stutter. Shift = sprint.
  // Keys: fwd back left right up down turnL turnR sprint.
  const _held = {};
  let _speed = 2;              // world units per second
  const TURN_RATE = 1.8;       // radians per second
  const SPRINT = 2;
  let _moveTimer = null, _cam = null, _reading = false, _last = 0;
  function setMoveSpeed(v) { _speed = Math.max(0.1, +v || 2); }
  function _anyMove() { return ['fwd','back','left','right','up','down','turnL','turnR'].some(k => _held[k]); }
  function _stopLoop() { if (_moveTimer) clearInterval(_moveTimer); _moveTimer = null; _cam = null; _reading = false; }
  function setMoveKey(k, down) {
    if (down) _held[k] = true; else delete _held[k];
    if (_anyMove() && !_moveTimer) { _last = performance.now(); _moveTimer = setInterval(_moveTick, 16); }
    if (!_anyMove()) _stopLoop();   // next press re-reads the camera, picking up any mouse drag in between
  }
  function clearMoveKeys() { for (const k in _held) delete _held[k]; _stopLoop(); }
  function _moveTick() {
    if (!_api || !_ready) return;
    if (!_cam) {                                        // one read per walk, then integrate locally
      if (_reading) return;
      _reading = true;
      _api.getCameraLookAt((err, cam) => {
        _reading = false;
        if (err || !cam || !_moveTimer) return;
        _cam = { e: cam.position.slice(), f: cam.target.map((v, i) => v - cam.position[i]) };
        _last = performance.now();
      });
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - _last) / 1000);     // clamp so a tab stall can't teleport you
    _last = now;
    let [fx, fy, fz] = _cam.f;
    const turn = (_held.turnR ? 1 : 0) - (_held.turnL ? 1 : 0);
    if (turn) {                                         // yaw around Z; right = clockwise seen from above
      const a = -turn * TURN_RATE * dt, c = Math.cos(a), sn = Math.sin(a);
      [fx, fy] = [fx * c - fy * sn, fx * sn + fy * c];
      _cam.f = [fx, fy, fz];                            // pitch (fz) and horizontal length unchanged
    }
    let fwd = (_held.fwd ? 1 : 0) - (_held.back ? 1 : 0);
    let str = (_held.right ? 1 : 0) - (_held.left ? 1 : 0);
    const len = Math.hypot(fwd, str);
    if (len > 1) { fwd /= len; str /= len; }            // diagonal = same speed as straight
    const up = (_held.up ? 1 : 0) - (_held.down ? 1 : 0);
    const hl = Math.hypot(fx, fy) || 1, hx = fx / hl, hy = fy / hl;
    const step = _speed * (_held.sprint ? SPRINT : 1) * dt;
    const e = _cam.e;
    e[0] += (hx * fwd + hy * str) * step;               // right vector = forward × Z-up = (hy, -hx)
    e[1] += (hy * fwd - hx * str) * step;
    e[2] += up * step;
    if (fwd || str || up || turn) _api.setCameraLookAt(e, [e[0] + fx, e[1] + fy, e[2] + fz], 0, () => {});
  }

  // ── DISCOVERY ─────────────────────────────────────────────────────
  // Runs getNodeMap → getMaterialList → getAnimations in sequence.
  // All three are needed before the admin panel can be fully populated.
  function _discover(onReady) {
    _api.getNodeMap((err, nodeMap) => {
      if (err) {
        _log('OfficeScene: getNodeMap error — ' + err);
      } else {
        _nodes = {};
        _visMap = {};
        _meta = {};
        _trace = {};
        for (const node of Object.values(nodeMap)) {
          // remember the scene-graph links (tolerant of the shapes the API has returned) - the "poof" effect
          // animates the MatrixTransform that owns a mesh, so a Geometry chip can borrow its parent's transform
          const kids = (node.children || []).map(c => (c && typeof c === 'object') ? c.instanceID : c).filter(Number.isFinite);
          _meta[node.instanceID] = { type: node.type, parent: node.parentId ?? node.parent ?? null, kids };
        }
        for (const [pid, m] of Object.entries(_meta)) for (const k of m.kids) if (_meta[k] && _meta[k].parent == null) _meta[k].parent = Number(pid);
        for (const node of Object.values(nodeMap)) {
          // Skip unnamed nodes and scene-graph helpers.
          // MatrixTransform = named object; Geometry = leaf mesh.
          if (!node.name) continue;
          if (node.type !== 'MatrixTransform' && node.type !== 'Geometry') continue;
          _nodes[node.instanceID] = {
            name:    node.name,
            type:    node.type,
            visible: true,
          };
          _visMap[node.instanceID] = true;
        }
        _log(`OfficeScene: ${Object.keys(_nodes).length} nodes (${
          Object.values(_nodes).filter(n => n.type === 'Geometry').length
        } geometry, ${
          Object.values(_nodes).filter(n => n.type === 'MatrixTransform').length
        } transforms)`);
      }

      _api.getMaterialList((err2, mats) => {
        if (!err2) {
          _materials = mats;
          _log(`OfficeScene: ${mats.length} materials`);
        }

        _api.getAnimations((err3, anims) => {
          if (!err3) {
            _animations = anims;
            _log(`OfficeScene: ${anims.length} animations`);
          }
          _ready = true;
          onReady?.();
        });
      });
    });
  }

  // ── VISIBILITY (sleight-of-hand transition) ──────────────────────────
  // The old version was an obvious game-UI "poof" (squash + sparkle burst). This one is a magician's trick instead:
  //   DISAPPEAR — a short, bright misdirection flash blooms at the object; the object itself is cut to invisible
  //   exactly at the flash's brightest instant, hidden inside the overexposure, then the flash clears on empty
  //   space. The eye registers "there was a flash" a beat before it registers "and now it's just... gone" — the
  //   actual cut is never seen. Total runtime is short and mostly linear (nothing "winds up" first) so there's no
  //   tell to watch for.
  //   APPEAR — a soft glint of light catches the eye and sweeps past the spot; the object is already sitting there
  //   solid by the time the glint clears it, like it caught the light and you only just noticed it. No bounce, no
  //   wobble, no "pop" - it should read as "was that there before?" rather than an animation happening.
  // Sketchfab's show()/hide() are instant, so the motion is our own tween on the node's local matrix (setMatrix),
  // always restored to the PRISTINE matrix at the end so nothing ever drifts, and interrupted cleanly if the admin
  // toggles again mid-flight. Viewers run the exact same code from the same event, so it's in sync everywhere.
  // Late-join snapshots pass {instant:true}: no trick for old changes, the state is just already what it is.
  // FX.on = false gives the plain instant behaviour.
  const FX = { on: true, hideMs: 260, showMs: 300 };
  let _meta = {};                  // id → {type, parent, kids[]}
  const _orig = {}, _origWorld = {}, _run = {}, _scaleOf = {};
  let _frameEl = null, _fxCv = null, _fxCtx = null, _parts = [], _fxRaf = 0;

  // cut happens at this fraction of hideMs / showMs — the flash/glint is built to peak right around here
  const HIDE_CUT = 0.34, SHOW_CUT = 0.42;

  function _resetFx(frameEl) {
    for (const k of Object.keys(_run)) delete _run[k];
    for (const o of [_orig, _origWorld, _scaleOf]) for (const k of Object.keys(o)) delete o[k];
    _frameEl = frameEl || _frameEl; _parts = [];
    if (_fxCv && _fxCv.parentNode) _fxCv.parentNode.removeChild(_fxCv);
    _fxCv = _fxCtx = null;
  }

  // uniform-scale the node's own axes about its origin — plain, no squash/wobble; the trick is in the timing/light,
  // not in the object visibly deforming (a deforming object is exactly what gives a "trick" away as an animation)
  function _scaleMat(m, s) {
    const o = m.slice(), k = Math.max(1e-4, s);
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) o[i] = m[i] * k;
    return o;
  }
  function _readMatrix(id, cb) {
    try {
      _api.getMatrix(id, (err, m) => {
        if (err || !m) return cb(null, null);
        const local = Array.isArray(m) ? m : (m.local || m.matrix || null);
        const world = (!Array.isArray(m) && m.world) || null;
        cb(local && local.length === 16 ? Array.from(local) : null, world && world.length === 16 ? Array.from(world) : null);
      });
    } catch (e) { cb(null, null); }
  }
  // which node do we animate for this chip? the node itself if it is a MatrixTransform, else its owning transform
  function _fxNode(id) {
    const m = _meta[id]; if (!m) return null;
    if (m.type === 'MatrixTransform') return id;
    const par = m.parent != null ? _meta[m.parent] : null;
    if (par && par.type === 'MatrixTransform' && par.kids.length === 1) return m.parent;
    return null;
  }
  function _withBase(nid, cb) {
    if (_orig[nid]) return cb(_orig[nid]);
    _readMatrix(nid, (l, w) => { if (l) { _orig[nid] = l; _origWorld[nid] = w || l; } cb(l); });
  }
  function _cancel(nid) { const had = _run[nid]; delete _run[nid]; return had ? _scaleOf[nid] : undefined; }

  function _tween(nid, base, ms, cutAt, fn, atCut, done) {
    const tok = {}; _run[nid] = tok;
    let finished = false, cutDone = false;
    const finish = () => { if (finished || _run[nid] !== tok) return; finished = true; delete _run[nid]; done(); };
    const t0 = performance.now();
    (function step(now) {
      if (_run[nid] !== tok || finished) return;
      const p = Math.min(1, Math.max(0, (now - t0) / ms));
      if (!cutDone && p >= cutAt) { cutDone = true; atCut(); }                 // the actual visibility change, timed to the light
      const sc = fn(p, cutDone);
      _scaleOf[nid] = sc;
      try { _api.setMatrix(nid, _scaleMat(base, sc), () => {}); } catch (e) {}
      if (p < 1) requestAnimationFrame(step); else finish();
    })(t0);
    setTimeout(() => { if (!cutDone) atCut(); finish(); }, ms + 300);   // a hidden tab pauses rAF - still land right
  }

  // ── the light: one soft radial bloom, drawn on a transparent canvas laid over the room iframe.
  // No particles, no debris — a single believable flash/glint is far less "look at this animation" than confetti.
  function _ensureOverlay() {
    if (!_frameEl || !_frameEl.parentElement) return null;
    const par = _frameEl.parentElement;
    if (!_fxCv) {
      _fxCv = document.createElement('canvas');
      _fxCv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
      par.insertBefore(_fxCv, _frameEl.nextSibling);
      _fxCtx = _fxCv.getContext('2d');
    }
    const d = Math.min(window.devicePixelRatio || 1, 2), w = Math.round(par.clientWidth * d), h = Math.round(par.clientHeight * d);
    if (_fxCv.width !== w || _fxCv.height !== h) { _fxCv.width = w; _fxCv.height = h; }
    return { par, d };
  }
  // kind 'out': quick bright flash, peaks early then clears fast (the vanish hides inside the peak).
  // kind 'in':  gentler glint that sweeps through and settles, like a catch of light — no hard peak to notice.
  function _spawn(kind, x, y, d, W) {
    const u = Math.max(5, W / 130) * d, out = kind === 'out';
    _parts.push({ t: 'bloom', x, y, out,
      rMax: u * (out ? 5.2 : 3.4),
      life: out ? 0.42 : 0.62,
      age: 0,
      peak: out ? 0.28 : 0.5,             // fraction of life where brightness is highest
      amp: out ? 1 : 0.55,
    });
    if (!_fxRaf) { let last = performance.now(); const loop = now => { _fxRaf = 0; const dt = Math.min(.05, (now - last) / 1000); last = now; _drawFx(dt); if (_parts.length) _fxRaf = requestAnimationFrame(loop); }; _fxRaf = requestAnimationFrame(loop); }
  }
  function _drawFx(dt) {
    const c = _fxCtx; if (!c || !_fxCv) { _parts = []; return; }
    c.clearRect(0, 0, _fxCv.width, _fxCv.height);
    c.globalCompositeOperation = 'lighter';
    _parts = _parts.filter(p => (p.age += dt) < p.life);
    for (const p of _parts) {
      const k = p.age / p.life;
      // brightness envelope: fast rise to `peak`, then decay — asymmetric so the flash reads as a single instant
      const bri = k < p.peak ? (k / p.peak) : Math.pow(1 - (k - p.peak) / (1 - p.peak), 1.6);
      const r = p.rMax * (0.35 + 0.65 * Math.min(1, k / p.peak));
      const a = p.amp * bri;
      const gr = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      if (p.out) {
        gr.addColorStop(0, `rgba(255,255,255,${(a).toFixed(3)})`);
        gr.addColorStop(.35, `rgba(255,250,235,${(a * .75).toFixed(3)})`);
        gr.addColorStop(1, 'rgba(255,240,200,0)');
      } else {
        gr.addColorStop(0, `rgba(255,255,255,${(a * .9).toFixed(3)})`);
        gr.addColorStop(.4, `rgba(210,225,255,${(a * .45).toFixed(3)})`);
        gr.addColorStop(1, 'rgba(210,225,255,0)');
      }
      c.fillStyle = gr; c.beginPath(); c.arc(p.x, p.y, r, 0, 6.2832); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }
  // world position -> overlay pixels (iframe may be scaled + shifted by CSS: see the crop / --sf-scale rules)
  function _light(nid, kind, cb) {
    const w = _origWorld[nid]; if (!w || !_api || !_frameEl) return cb();
    const ov = _ensureOverlay(); if (!ov) return cb();
    try {
      _api.getWorldToScreenCoordinates([w[12], w[13], w[14]], coord => {
        const cc = coord && coord.canvasCoord;
        if (cc) {
          const fr = _frameEl.getBoundingClientRect(), pr = ov.par.getBoundingClientRect();
          const sx = fr.width / (_frameEl.offsetWidth || fr.width), sy = fr.height / (_frameEl.offsetHeight || fr.height);
          const x = fr.left - pr.left + cc[0] * sx, y = fr.top - pr.top + cc[1] * sy;
          if (!(x < -20 || y < -20 || x > pr.width + 20 || y > pr.height + 20)) _spawn(kind, x * ov.d, y * ov.d, ov.d, pr.width);
        }
        cb();
      });
    } catch (e) { cb(); }
  }

  // world position of a node -> client (page) pixels; null if it can't be projected. Used to aim the wand (13-wand.js).
  function _clientPoint(nid, cb) {
    const w = _origWorld[nid]; if (!w || !_api || !_frameEl) return cb(null);
    try {
      _api.getWorldToScreenCoordinates([w[12], w[13], w[14]], coord => {
        const cc = coord && coord.canvasCoord; if (!cc) return cb(null);
        const fr = _frameEl.getBoundingClientRect();
        const sx = fr.width / (_frameEl.offsetWidth || fr.width), sy = fr.height / (_frameEl.offsetHeight || fr.height);
        cb({ x: fr.left + cc[0] * sx, y: fr.top + cc[1] * sy });
      });
    } catch (e) { cb(null); }
  }

  // ── auto-pilot + game support (14-autopilot.js, 15-game.js) ─────────────────────────────────────
  function getCamera(cb) {
    if (!_api) return cb(null);
    try { _api.getCameraLookAt((err, c) => cb(err || !c ? null : { eye: c.position, target: c.target })); } catch (e) { cb(null); }
  }
  // Project one object to client pixels (reads its pristine world matrix first if needed): cb({pt, world:[x,y,z]}) or cb(null).
  function probe(id, cb) {
    const nid = _fxNode(id);
    if (nid == null || _visMap[id] === false || !_api) return cb(null);
    _withBase(nid, b => {
      const w = _origWorld[nid];
      if (!b || !w) return cb(null);
      _clientPoint(nid, pt => cb(pt ? { pt, world: [w[12], w[13], w[14]] } : null));
    });
  }
  // Keep re-projecting an object's screen position (client px) while the camera moves. `every` = min ms between samples
  // (0 = every frame). get() returns the newest point (null until the first answer). Stops itself after `ms`.
  function trackPoint(id, ms, every) {
    const nid = _fxNode(id), T = { on: true, pt: null, get() { return T.pt; }, stop() { T.on = false; } };
    if (nid == null) return T;
    const t0 = performance.now(); let asked = 0, lastAt = 0;
    const loop = now => {
      if (!T.on || now - t0 > (ms || 8000)) { T.on = false; return; }
      if (now - asked > 250 && now - lastAt >= (every || 0)) {         // one request in flight at a time (a lost answer is retried after 250 ms)
        asked = lastAt = now;
        _clientPoint(nid, p => { asked = 0; if (p) T.pt = p; });
      }
      requestAnimationFrame(loop);
    };
    _withBase(nid, b => { if (b && T.on) requestAnimationFrame(loop); });
    return T;
  }
  // Objects that are safe to vanish for a game round: visible transforms whose children are ONLY meshes (never a group that
  // contains the room), falling back to single-mesh objects if the node map carries no child links.
  function leafObjects() {
    const ids = Object.keys(_nodes).map(Number);
    const leaf = ids.filter(id => {
      const m = _meta[id];
      return m && m.type === 'MatrixTransform' && _visMap[id] !== false && m.kids.length && m.kids.every(k => _meta[k] && _meta[k].type === 'Geometry');
    });
    return leaf.length ? leaf : ids.filter(id => _meta[id] && _meta[id].type === 'Geometry' && _visMap[id] !== false && _fxNode(id) != null);
  }

  function _setState(id, v) { if (_nodes[id]) _nodes[id].visible = v; _visMap[id] = v; }

  // ── TRACES: what a vanished object leaves behind ─────────────────────────────────────────────────────────────
  // Hiding a mesh does not hide its baked/contact shadow, decal or ambient-occlusion patch - those are separate nodes, and they stay
  // on the floor as a dark square of the same shape ("something was here"). So a vanish/appear also takes the object's TRACE nodes:
  //   1. by name  - shadow-like nodes (shadow / contact / occlusion / ao / blob / decal / stain ...) that carry the object's own name
  //   2. by place - failing that, shadow-like nodes standing within traceCfg.radius (world units) of the object
  //   3. by hand  - OfficeScene.linkTrace(id, [ids]) for anything the two rules miss. OfficeScene.nearby(id) lists what sits there.
  const TRACE_RX = /shadow|contact|occlu|(^|[^a-z])ao([^a-z]|$)|blob|decal|stain|dirt|smudge|footprint|dust/i;
  const traceCfg = { on: true, radius: 1.2 };
  let _trace = {}, _manual = {};
  const _nm = n => (_nodes[n] && _nodes[n].name) || '';
  const _base = n => String(n || '').toLowerCase().split('_')[0].replace(TRACE_RX, ' ').replace(/[\-\.]+/g, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  const _tnode = n => { const m = _meta[n], par = m && m.parent != null ? _meta[m.parent] : null; return (m && m.type === 'Geometry' && par && par.type === 'MatrixTransform' && par.kids.length === 1) ? m.parent : n; };
  function _worldOf(id, cb) {
    if (_origWorld[id]) return cb(_origWorld[id]);
    _readMatrix(id, (l, w) => cb(w || l));
  }
  function _findTraces(id, cb) {
    if (_trace[id]) return cb(_trace[id]);
    const done = list => { _trace[id] = [...new Set(list.concat(_manual[id] || []))].filter(t => t !== id); cb(_trace[id]); };
    if (!traceCfg.on || !_api) return done([]);
    const sub = new Set(); (function walk(i) { sub.add(i); ((_meta[i] && _meta[i].kids) || []).forEach(walk); })(id);
    const cands = Object.keys(_nodes).map(Number).filter(n => !sub.has(n) && TRACE_RX.test(_nm(n)));
    const b = _base(_nm(id));
    const byName = b.length >= 3 ? cands.filter(c => { const cb2 = _base(_nm(c)); return cb2.length >= 3 && cb2 === b; }) : [];
    if (byName.length) return done(byName.map(_tnode));
    if (!cands.length) return done([]);
    _worldOf(id, w => {
      if (!w) return done([]);
      const near = []; let left = Math.min(cands.length, 80);
      cands.slice(0, 80).forEach(c => _worldOf(c, cw => {
        if (cw && Math.hypot(cw[12] - w[12], cw[13] - w[13], cw[14] - w[14]) <= traceCfg.radius) near.push(_tnode(c));
        if (--left === 0) done(near);
      }));
    });
  }
  function _applyTraces(list, visible) {
    for (const t of list) { try { visible ? _api.show(t, () => {}) : _api.hide(t, () => {}); } catch (e) {} if (t in _visMap) _visMap[t] = visible; }
  }
  // console helpers ------------------------------------------------------------------------------------------------
  function linkTrace(id, ids) { _manual[id] = [...new Set((_manual[id] || []).concat(ids))]; delete _trace[id]; return _manual[id]; }
  function nearby(id, radius, cb) {                     // what stands around an object? logs a table, nearest first
    const R = radius || traceCfg.radius * 2;
    _worldOf(id, w => {
      if (!w) return console.warn('OfficeScene.nearby: cannot read that object');
      const ids = Object.keys(_nodes).map(Number).filter(n => n !== id && _nodes[n].type === 'MatrixTransform'), out = []; let left = ids.length;
      if (!left) return;
      ids.forEach(n => _worldOf(n, nw => {
        if (nw) { const d = Math.hypot(nw[12] - w[12], nw[13] - w[13], nw[14] - w[14]); if (d <= R) out.push({ id: n, name: _nm(n), dist: +d.toFixed(3), looksLikeTrace: TRACE_RX.test(_nm(n)) }); }
        if (--left === 0) { out.sort((a, b2) => a.dist - b2.dist); console.table(out.slice(0, 25)); if (cb) cb(out); }
      }));
    });
  }

  // Is the wand (13-wand.js) to be used for this kind of change right now?
  const _wandFor = kind => !!(window.WandCast && window.WandCast.allows(kind) && window.WandCast.available());

  function hide(instanceID, opts) {
    if (!_api) return;
    const was = _visMap[instanceID] ?? true;
    _setState(instanceID, false);
    const nid = (FX.on && !(opts && opts.instant)) ? _fxNode(instanceID) : null;
    if (nid == null) { _cancelAny(instanceID); _api.hide(instanceID, () => {}); _findTraces(instanceID, t => _applyTraces(t, false)); return; }
    const cur = _cancel(nid);
    if (!was && cur === undefined) return;                       // already hidden
    _withBase(nid, base => {
      if (!base) { _api.hide(instanceID, () => {}); return; }
      _findTraces(instanceID, traces => {
      const from = cur ?? 1;
      const go = () => _tween(nid, base, FX.hideMs, HIDE_CUT,
        (p, cut) => cut ? 1e-4 : from,                            // holds full size right up to the flash peak, then the cut fires
        () => { _api.hide(instanceID, () => {}); _applyTraces(traces, false); },   // the actual cut (object AND its shadow/decal together): masked by the flash overexposure
        () => setTimeout(() => { if (!_run[nid]) { try { _api.setMatrix(nid, base, () => {}); } catch (e) {} delete _scaleOf[nid]; } }, 60));
      const vanish = () => {
        if (_visMap[instanceID] !== false) return;               // shown again while the wand was on its way: cancel the vanish
        if (cur === undefined) _light(nid, 'out', go); else go();
      };
      // Wand (13-wand.js): the character aims a wand at the object and the existing flash + cut fires at the flick.
      // Only when the trick is set to play on disappearing ('hide' or 'both'), not for late-join snapshots (opts.instant never
      // reaches here), a tween already in flight, or when the wand is off/unavailable.
      if (cur === undefined && _wandFor('hide')) {
        const AP = window.Autopilot, w = _origWorld[nid];
        // Auto-pilot: the admin frames the object and broadcasts ONE shot; viewers only learn how long the glide takes
        // (so the flick waits for the camera to arrive) and then play the shot when it reaches them.
        const arrive = AP ? AP.onHide(w ? [w[12], w[13], w[14]] : null) : 0;
        _clientPoint(nid, pt => {
          if (!pt) return vanish();
          pt.track = trackPoint(nid, 9000);          // wand + eyes follow the object's screen position while the camera moves
          window.WandCast.cast(pt, vanish, { arriveMs: arrive });
        });
      } else vanish();
      });
    });
  }

  function show(instanceID, opts) {
    if (!_api) return;
    const was = _visMap[instanceID] ?? true;
    _setState(instanceID, true);
    const nid = (FX.on && !(opts && opts.instant)) ? _fxNode(instanceID) : null;
    if (nid == null) { _cancelAny(instanceID); _api.show(instanceID, () => {}); _findTraces(instanceID, t => _applyTraces(t, true)); return; }
    const cur = _cancel(nid);
    if (was && cur === undefined) return;                        // already visible and settled
    _withBase(nid, base => {
      if (!base) { _api.show(instanceID, () => {}); return; }
      _findTraces(instanceID, traces => {
      const from = cur ?? 1e-4;
      const go = () => {
        try { _api.setMatrix(nid, _scaleMat(base, from), () => {}); } catch (e) {}
        _tween(nid, base, FX.showMs, SHOW_CUT,
          (p, cut) => cut ? 1 : from,                              // stays as-is until the glint is over it, then it's just... there
          () => { _api.show(instanceID, () => {}); _applyTraces(traces, true); },
          () => { try { _api.setMatrix(nid, base, () => {}); } catch (e) {} delete _scaleOf[nid]; });
      };
      const appear = () => {
        if (_visMap[instanceID] !== true) return;                // hidden again while the wand was on its way: cancel
        if (cur === undefined) _light(nid, 'in', go); else go();
      };
      // Wand on APPEARING ('show' or 'both'): same choreography as the vanish - the arm comes up, the camera frames the empty
      // spot, and at the flick the object materialises there.
      if (cur === undefined && _wandFor('show')) {
        const AP = window.Autopilot, w = _origWorld[nid];
        const arrive = AP ? AP.onHide(w ? [w[12], w[13], w[14]] : null) : 0;
        _clientPoint(nid, pt => {
          if (!pt) return appear();
          pt.track = trackPoint(nid, 9000);
          window.WandCast.cast(pt, appear, { arriveMs: arrive });
        });
      } else appear();
      });
    });
  }
  function _cancelAny(id) { const nid = _fxNode(id); if (nid != null && _run[nid]) { delete _run[nid]; if (_orig[nid]) { try { _api.setMatrix(nid, _orig[nid], () => {}); } catch (e) {} } delete _scaleOf[nid]; } }

  function toggle(instanceID) {
    const v = !(_visMap[instanceID] ?? true);
    v ? show(instanceID) : hide(instanceID);
    return v;
  }

  // Apply a boolean to a node — used by view.html when it receives the 'office-input' SSE event broadcast from the
  // admin (animated) and when it replays the join-time snapshot (opts.instant = true).
  function applyVisibility(instanceID, visible, opts) {
    visible ? show(instanceID, opts) : hide(instanceID, opts);
  }

  // ── CAMERA ─────────────────────────────────────────────────────────
  function setCameraLookAt(eye, target, duration) {
    if (!_api) return;
    _api.setCameraLookAt(eye, target, duration ?? 1.5, () => {});
  }

  // Capture the current camera position and save it under `name`.
  function saveCurrentCamera(name, cb) {
    if (!_api) { _log('OfficeScene: API not ready for saveCurrentCamera'); return; }
    _api.getCameraLookAt((err, cam) => {
      if (err) { _log('OfficeScene: getCameraLookAt error — ' + err); return; }
      _presets[name] = { eye: cam.position, target: cam.target };
      _savePresets();
      _log(`OfficeScene: saved preset "${name}" eye=${JSON.stringify(cam.position)}`);
      cb?.(_presets[name]);
    });
  }

  function gotoPreset(name, duration) {
    const p = _presets[name];
    if (!p) { _log(`OfficeScene: preset "${name}" not found`); return; }
    setCameraLookAt(p.eye, p.target, duration);
  }

  function deletePreset(name) {
    delete _presets[name];
    _savePresets();
  }

  // ── MATERIALS ──────────────────────────────────────────────────────
  // color: [r, g, b] each 0.0–1.0  (no alpha needed for PBR albedo)
  function setMaterialColor(matName, color) {
    if (!_api) return;
    const mat = _materials.find(m => m.name === matName);
    if (!mat) { _log(`OfficeScene: material "${matName}" not found`); return; }

    const updated = JSON.parse(JSON.stringify(mat));
    const ch = updated.channels;
    // Try PBR albedo first, fall back to classic Diffuse.
    if (ch?.AlbedoPBR) {
      ch.AlbedoPBR.color  = color;
      ch.AlbedoPBR.enable = true;
    } else if (ch?.DiffusePBR) {
      ch.DiffusePBR.color  = color;
      ch.DiffusePBR.enable = true;
    } else if (ch?.Diffuse) {
      ch.Diffuse.color  = color;
      ch.Diffuse.enable = true;
    }
    _api.setMaterial(updated, () => {});
    // Update our cached copy so a re-broadcast gets the right base.
    const idx = _materials.findIndex(m => m.name === matName);
    if (idx !== -1) _materials[idx] = updated;
  }

  // ── ANIMATIONS ─────────────────────────────────────────────────────
  function playAnim()  { _api?.play();    _animPlaying = true;  }
  function pauseAnim() { _api?.pause();   _animPlaying = false; }
  function seekAnim(t) { _api?.seekTo(t); }

  // ── PUBLIC ─────────────────────────────────────────────────────────
  return {
    get ready()       { return _ready;      },
    get nodes()       { return _nodes;      },
    get materials()   { return _materials;  },
    get animations()  { return _animations; },
    get presets()     { return _presets;    },
    get visMap()      { return _visMap;     },
    get animPlaying() { return _animPlaying; },

    activate,
    show, hide, toggle, applyVisibility, fx: FX,
    watchCamera, stopWatchCamera, setMoveKey, clearMoveKeys, setMoveSpeed,
    setCameraLookAt, saveCurrentCamera, gotoPreset, deletePreset,
    getCamera, probe, trackPoint, leafObjects,
    traceCfg, linkTrace, nearby,
    setMaterialColor,
    playAnim, pauseAnim, seekAnim,
  };
})();

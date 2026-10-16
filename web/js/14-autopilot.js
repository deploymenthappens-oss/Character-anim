// =====================================================================
//  14-autopilot.js — a cinematic camera for the vanish trick.
//
//  Loaded by BOTH publish.html and view.html (after 13-wand.js).
//
//   1. Frame the object   - on a hide the ADMIN computes a shot: pull in toward the object along (mostly) the current viewing
//                           direction and glide there in glideMs while the arm rises. The wand's first flick waits for it.
//   2. One broadcast      - the admin sends that shot ONCE (office-input kind 'shot'); every viewer plays the same move
//                           instead of working it out separately. Viewers in free-roam are never yanked (canFly()).
//   3. Return             - holdMs after arriving (flick, vanish, the avatar's double-take) the camera glides back to the
//                           camera it started from (sent in the shot, so everyone returns to the same place).
//   4. Aim at the object  - not here: OfficeScene.trackPoint() re-projects the object every frame and WandCast follows it.
//   5. Gaze               - WandCast (eyes follow the spot, then flick to the viewers).
//
//  A "hide all" cascade: hides that arrive within retargetMs of the last shot only extend the hold (no camera ping-pong);
//  a later hide re-frames from the ORIGINAL camera, so the return always goes back to where the shot began.
//  While a shot runs the admin's live camera stream is paused (Autopilot.busy) so it cannot fight the move.
//
//  Tune live: Autopilot.cfg   |   try it (local only, hides nothing): Autopilot.test()   |   off: Autopilot.cfg.on = false
//  Auto-pilot only runs together with the wand (no wand cast = no shot).
// =====================================================================
window.Autopilot = (() => {
  'use strict';
  const cfg = {
    on: true,
    glideMs: 900,        // camera flies to the object
    holdMs: 2400,        // stays framed after arriving: covers wind-up, flick, vanish, hold and the eyes' double-take
    returnMs: 1200,      // glide back to the previous camera
    retargetMs: 1200,    // a hide this long after the last shot re-frames; sooner ones just extend the hold
    pull: 0.72,          // pull in to this fraction of the current distance to the object (1 = don't move, 0.5 = the old, very close shot)...
    minDist: 1.7, maxDist: 5.5,   // ...clamped to these (Sketchfab world units)
    keep: 0.6,           // 1 = keep the current viewing direction exactly; 0 = look straight along the line of sight to the object
    side: 0.16,          // shift the shot sideways (fraction of the distance) so the object clears the docked avatar; negative = other side
  };
  // admin page = the one with the object panel; viewers just play what they are sent
  const S = { role: document.getElementById('officeNodeGrid') ? 'admin' : 'viewer', broadcast: null,
    busy: false, returning: false, from: null, timer: 0, until: 0, lastAt: -1e9 };

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : null; };
  const r4 = a => a.map(n => Math.round(n * 1e4) / 1e4);

  // the shot: where the camera should be so `P` is framed, given the camera it starts from
  function plan(from, P) {
    const d = norm(sub(from.target, from.eye)), toObj = sub(P, from.eye), cur = len(toObj);
    if (!d || cur < 1e-4) return null;
    const u = mul(toObj, 1 / cur);                                            // line of sight to the object
    const dir = norm(add(mul(d, cfg.keep), mul(u, 1 - cfg.keep))) || u;       // mostly the current view direction
    const dist = Math.min(cur, Math.max(cfg.minDist, Math.min(cfg.maxDist, cur * cfg.pull)));
    const right = norm([dir[1], -dir[0], 0]) || [1, 0, 0];                    // Z-up world: right = forward x Z
    const target = add(P, mul(right, dist * cfg.side));                       // aim slightly right of the object -> object sits left of centre
    const eye = sub(target, mul(dir, dist));
    return { eye: r4(eye), target: r4(target), glideMs: cfg.glideMs, holdMs: cfg.holdMs, returnMs: cfg.returnMs,
      from: { eye: r4(from.eye), target: r4(from.target) } };
  }

  function hold(ms) { clearTimeout(S.timer); S.until = performance.now() + ms; S.timer = setTimeout(back, ms); }
  function extend() { if (S.busy && !S.returning && S.timer) hold(Math.max(S.until - performance.now(), cfg.holdMs)); }
  function back() {
    if (!S.from) { S.busy = false; return; }
    S.returning = true;
    OfficeScene.setCameraLookAt(S.from.eye, S.from.target, cfg.returnMs / 1000);
    S.timer = setTimeout(() => { S.busy = false; S.returning = false; S.from = null; S.timer = 0; }, cfg.returnMs + 150);
  }

  // fly the camera (local). Called by the admin for its own shot and by viewers for the broadcast one.
  function play(shot) {
    if (!cfg.on || !shot || !shot.eye || !shot.from || !window.OfficeScene || !OfficeScene.ready) { if (S.role === 'admin') { S.busy = false; } return; }
    if (!api.canFly()) { S.busy = false; return; }
    if (!S.busy || !S.from) S.from = shot.from;                               // a re-frame keeps the ORIGINAL camera to return to
    S.busy = true; S.returning = false; S.lastAt = performance.now();
    OfficeScene.setCameraLookAt(shot.eye, shot.target, (shot.glideMs || cfg.glideMs) / 1000);
    hold((shot.glideMs || cfg.glideMs) + (shot.holdMs || cfg.holdMs));
  }

  // The admin's own shot: claim the camera synchronously (so a cascade of hides plans once), read it, plan, fly, broadcast.
  function fly(P) {
    S.busy = true; S.lastAt = performance.now();
    const go = from => {
      const shot = from && plan(from, P);
      if (!shot) { if (!S.timer) S.busy = false; return; }
      if (S.from) shot.from = S.from;                                         // re-frame: return to the camera we first left
      play(shot);
      if (S.busy && S.broadcast) S.broadcast(shot);
    };
    if (S.from) go(S.from); else OfficeScene.getCamera(go);
  }

  // OfficeScene.hide() calls this for every wand vanish (both roles). Returns how long the wand must wait for the camera.
  function onHide(P) {
    if (!cfg.on || !window.OfficeScene) return 0;
    const fresh = !S.busy || (!S.returning && performance.now() - S.lastAt > cfg.retargetMs);
    if (!fresh) { extend(); return 0; }                                       // cascade: camera is already there
    if (S.role === 'admin' && P && api.canFly()) fly(P);
    return cfg.glideMs;
  }

  // console: fly to a random (or given) object and back - on THIS screen only, nothing is hidden or broadcast
  function test(id) {
    const ids = id != null ? [id] : OfficeScene.leafObjects(), pick = ids[Math.floor(Math.random() * ids.length)];
    if (pick == null) return console.warn('Autopilot.test: no objects found');
    OfficeScene.probe(pick, r => {
      if (!r) return console.warn('Autopilot.test: that object cannot be projected');
      OfficeScene.getCamera(from => { const shot = from && plan(from, r.world); if (shot) play(shot); });
    });
  }

  const api = {
    cfg, plan, play, onHide, test, S,
    canFly: () => true,                        // view.html overrides: never move a viewer who is in free-roam
    get busy() { return S.busy; },
    get role() { return S.role; }, set role(v) { S.role = v; },
    set broadcast(fn) { S.broadcast = fn; },   // publish page: shot => POST office-input kind 'shot'
  };
  return api;
})();

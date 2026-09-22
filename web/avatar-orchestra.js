/* =====================================================================
   AVATAR ORCHESTRA  -  motion & gesture orchestrator for a Rive rig
   ---------------------------------------------------------------------
   Classic script (window.Orchestra) or CommonJS. No dependencies.

   WHAT IT DOES
   Every frame it turns "intent" (look here, speak this, wave) into a
   set of bone-rotation / node-offset / pose-weight values, using models
   taken from human motor control, then RigDriver writes them into the
   Rive artboard on top of whatever the state machine produced.

   THE MATHEMATICAL SPINE
   1. Minimum-jerk quintic with *arbitrary boundary state*
        x(t) = sum c_k t^k,  k=0..5,  matched to (x0,v0,a0) -> (xf,vf,af)
      Retargeting mid-motion starts the new quintic from the CURRENT
      (position, velocity, acceleration), so motion stays C2-continuous:
      there is no pop, no velocity jump, and a command takes effect on
      the very frame it is issued (Flash & Hogan 1985; Hoff & Arbib 1993).
   2. Exact damped-spring integrator (closed form, unconditionally
      stable for any dt) for passive / secondary motion.
   3. Ornstein-Uhlenbeck processes (exact discretisation) for the 1/f-ish
      variability of sway and breathing, instead of white noise or sines.
   4. Coordinated gaze: eye saccade (main sequence) -> head -> torso with
      vestibulo-ocular compensation  (eye-in-head = gaze - head).
   5. Head-in-space stabilisation: the neck counter-rotates the torso.
   6. Soft 2-bone IK on Cartesian minimum-jerk paths (straight hand
      paths, bell-shaped speed; Morasso 1981) with a soft reach limit.
   7. Speech beats are scheduled from the audio envelope AHEAD of time,
      so the gesture apex lands on the stressed syllable (McNeill 1992).
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Orchestra = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------------------------------------------------------------- 1. math */
const PI = Math.PI, TAU = PI * 2, D2R = PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapPi = a => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
const minJerk = s => { s = clamp(s, 0, 1); return s * s * s * (10 + s * (-15 + 6 * s)); };   // 10s^3 - 15s^4 + 6s^5

/* 0 below `dz`, then rescaled 0..1 over the rest of the 0..1 range. Used so a pose that should only
   read as "on" for a clear, deliberate motion (e.g. eyebrows/eyelids following a look-up) doesn't
   flicker on for every tiny, constant micro-glance a live gaze naturally makes. */
function deadzone(v, dz) { return v <= dz ? 0 : (v - dz) / (1 - dz); }

/* linear inside [lo+knee, hi-knee], tanh-saturating toward the hard limit: C1 at the knee */
function softLimit(x, lo, hi, knee) {
  const a = lo + knee, b = hi - knee;
  if (x > b) return b + knee * Math.tanh((x - b) / knee);
  if (x < a) return a - knee * Math.tanh((a - x) / knee);
  return x;
}

function makeRng(seed) {                       // mulberry32 + Box-Muller: deterministic, testable
  let s = seed >>> 0, spare = null;
  const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { if (spare !== null) { const v = spare; spare = null; return v; } let a = 0, b = 0; while (a < 1e-12) a = u(); b = u(); const r = Math.sqrt(-2 * Math.log(a)); spare = r * Math.sin(TAU * b); return r * Math.cos(TAU * b); };
  return { u, n };
}

/* Ornstein-Uhlenbeck with stationary std `std` and correlation time `tau` (exact step) */
class OU {
  constructor(std, tau, rng) { this.std = std; this.tau = tau; this.rng = rng; this.x = std * rng.n(); }
  step(dt) { const e = Math.exp(-dt / this.tau); this.x = this.x * e + this.std * Math.sqrt(1 - e * e) * this.rng.n(); return this.x; }
}

/* closed-form damped spring toward `target`; s = {x, v}. exact for constant target over dt */
function springStep(s, target, dt, w, z) {
  const d = s.x - target, v = s.v;
  if (z >= 0.9999) {
    const e = Math.exp(-w * dt), q = v + w * d;
    s.x = target + (d + q * dt) * e; s.v = (v - w * q * dt) * e;
  } else {
    const a = z * w, b = w * Math.sqrt(1 - z * z), e = Math.exp(-a * dt), c = Math.cos(b * dt), sn = Math.sin(b * dt);
    s.x = target + e * (d * c + ((v + a * d) / b) * sn);
    s.v = e * (v * c - ((a * v + w * w * d) / b) * sn);
  }
  return s;
}

/* quintic coefficients c0..c5 for x0,v0,a0 -> xf,vf,af in T seconds */
function quintic(x0, v0, a0, xf, vf, af, T) {
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T, T5 = T4 * T, d = xf - x0;
  return [
    x0, v0, a0 / 2,
    (20 * d - (8 * vf + 12 * v0) * T - (3 * a0 - af) * T2) / (2 * T3),
    (-30 * d + (14 * vf + 16 * v0) * T + (3 * a0 - 2 * af) * T2) / (2 * T4),
    (12 * d - 6 * (vf + v0) * T - (a0 - af) * T2) / (2 * T5),
  ];
}
function quinticEval(c, t) {
  return {
    x: c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5])))),
    v: c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + 5 * c[5] * t))),
    a: 2 * c[2] + t * (6 * c[3] + t * (12 * c[4] + 20 * c[5] * t)),
  };
}

/* ---------------------------------------------------------------- 2. Motor
   One degree of freedom that always moves along a minimum-jerk quintic.
   interrupt(): replan from the current (x,v,a) now.  schedule(): plan for later. */
class Motor {
  constructor(x = 0) { this.x = x; this.v = 0; this.a = 0; this.seg = null; this.q = []; this.clock = 0; }
  get busy() { return !!this.seg || this.q.length > 0; }
  clear() { this.q.length = 0; return this; }
  _launch(e) { this.seg = { c: quintic(this.x, this.v, this.a, e.xf, e.vf, e.af, e.T), t: 0, T: e.T, xf: e.xf, vf: e.vf, af: e.af }; }
  interrupt(xf, T, o) { o = o || {}; this.q.length = 0; this._launch({ xf, T: Math.max(T, 1e-3), vf: o.vf || 0, af: o.af || 0 }); return this; }
  schedule(delay, xf, T, o) {
    o = o || {};
    const e = { at: this.clock + delay, xf, T: Math.max(T, 1e-3), vf: o.vf || 0, af: o.af || 0 };
    let i = this.q.length; while (i > 0 && this.q[i - 1].at > e.at) i--; this.q.splice(i, 0, e); return this;
  }
  _advance(h) {
    const s = this.seg; if (!s) return;
    s.t += h;
    if (s.t >= s.T) { this.x = s.xf; this.v = s.vf; this.a = s.af; this.seg = null; return; }
    const p = quinticEval(s.c, s.t); this.x = p.x; this.v = p.v; this.a = p.a;
  }
  step(dt) {
    let rem = dt;
    while (rem > 1e-12) {
      const nxt = this.q.length ? this.q[0].at - this.clock : Infinity;
      if (nxt <= 1e-12) { this._launch(this.q.shift()); continue; }
      const h = Math.min(rem, nxt);
      this._advance(h); this.clock += h; rem -= h;
    }
    while (this.q.length && this.q[0].at - this.clock <= 1e-12) this._launch(this.q.shift());
    if (!this.seg && (this.v !== 0 || this.a !== 0) && !(this.q.length && this.q[0].at - this.clock < 1e-6)) { this.v = 0; this.a = 0; }
    return this.x;
  }
}

/* ---------------------------------------------------------------- 3. arm IK */
/* 2-bone analytic IK with "soft" reach (exponential compression near full extension, C1),
   which removes the classic pop when a target crosses the reach limit.
   bend = +1 / -1 chooses the elbow side.  Returns world angles of the two bones. */
function solveArm2(dx, dy, l1, l2, bend, soft) {
  const d = Math.hypot(dx, dy), dmax = l1 + l2, dmin = Math.abs(l1 - l2) + 1e-3, ds = dmax - soft;
  let dd = d;
  if (soft > 0 && d > ds) dd = ds + soft * (1 - Math.exp(-(d - ds) / soft));
  dd = clamp(dd, dmin, dmax - 1e-6);
  const B = Math.acos(clamp((l1 * l1 + dd * dd - l2 * l2) / (2 * l1 * dd), -1, 1));   // shoulder angle off the line to target
  const E = Math.acos(clamp((l1 * l1 + l2 * l2 - dd * dd) / (2 * l1 * l2), -1, 1));   // interior elbow angle
  const th1 = Math.atan2(dy, dx) + bend * B;
  return { th1, th2: th1 - bend * (PI - E), d: dd };
}

/* ---------------------------------------------------------------- 4. rig tables (this avatar.riv) */
/* Joint limits in degrees relative to the rest pose. + = clockwise on screen (y down).
   Right arm: raising = +, elbow flexion = +. Left arm mirrors (raising = -, flexion = -). */
const JOINTS = {
  hips: [-4, 4], chest: [-6, 6], neck: [-5, 5], head: [-7, 7],
  shoulder_R: [-45, 190], arm_R: [-14, 158], hand_R: [-65, 65], palm_R: [-35, 35],
  shoulder_L: [-190, 45], arm_L: [-158, 14], hand_L: [-65, 65], palm_L: [-35, 35],
};
/* Node-offset channels, in artboard units (px). y is DOWN-positive everywhere, so a raised foot is a negative y.
     hips.x / hips.y : the TORSO moves; the feet ride along vertically, so the legs stay straight (a breath or a nod
                       never makes a knee pop out).
     squat           : hips drop with the feet PLANTED -> the knees bend (px of drop, always >= 0).
     air             : the whole body leaves the ground (px up, always >= 0).
     IK_R.* / IK_L.* : one foot target. R foot "out" is -x, L foot "out" is +x.
   NOTE: this rig's legs are exactly straight at rest (hip-to-ankle == thigh + shin), so a 1 px hip drop already
   pushes each knee out by ~12 px. That is why squat/foot lifts are always deliberate, never ambient noise. */
const NODE_CH = { 'hips.x': [-7, 7], 'hips.y': [-6, 6],
  'IK_R.x': [-50, 32], 'IK_R.y': [-70, 12], 'IK_L.x': [-32, 50], 'IK_L.y': [-70, 12],
  squat: [-26, 26], air: [-6, 50] };
const ARM_JOINTS = { R: ['shoulder_R', 'arm_R', 'hand_R', 'palm_R'], L: ['shoulder_L', 'arm_L', 'hand_L', 'palm_L'] };
const POSE_KEYS = ['pose.eyesRight', 'pose.eyesLeft', 'pose.lookUp', 'pose.lookDown', 'pose.blink', 'pose.smile', 'pose.surpriseO'];
const CHANNELS = Object.keys(JOINTS).concat(Object.keys(NODE_CH), POSE_KEYS);
const LEG_JOINTS = { R: ['IK_R.x', 'IK_R.y'], L: ['IK_L.x', 'IK_L.y'] };
const LEG_SHARED = ['hips.x', 'hips', 'chest', 'squat', 'air'];   // torso channels a two-leg gesture owns

/* a run of `n` pulses to `peak`: [at, value, T] steps, one pulse per `period` seconds */
function pulses(n, t0, period, peak, o) {
  o = o || {}; const up = o.up || period * 0.42, dn = o.down || period * 0.5, out = [];
  for (let i = 0; i < n; i++) { const t = t0 + i * period; out.push([t, peak, up]); out.push([t + up + (o.hold || 0), 0, dn]); }
  return out;
}
/* alternating side-to-side values: +a, -a, +a ... every `period`, then back to 0 */
function alternate(n, t0, period, a, T, end) {
  const out = []; for (let i = 0; i < n; i++) out.push([t0 + i * period, (i % 2 ? -1 : 1) * a, T]);
  out.push([end, 0, 0.5]); return out;
}
/* one jump: crouch, push off (body AND feet leave the ground), tuck the knees, fall, absorb the landing */
function jumpSpec(h, crouch, prio) {
  const s = h / 30;
  return { arm: null, leg: 'both', dur: 1.3, prio: prio || 6,
    tracks: {
      squat: [[0, crouch, .2], [.2, 0, .16], [.68, crouch * 1.1, .12], [.8, 0, .38]],
      air: [[.22, h, .17], [.5, 0, .2]],
      'IK_R.y': [[.3, -9 * s, .14], [.52, 0, .14]], 'IK_L.y': [[.3, -9 * s, .14], [.52, 0, .14]],
      head: [[.05, 1.6, .2], [.5, 0, .3]],
    } };
}
const GAZE_ROLL = 2.5 * D2R, GAZE_LEAN = 1.2 * D2R;   // head roll / chest lean at gaze = 1 (= 30 deg of gaze)

/* ---------------------------------------------------------------- 5. gesture library
   track step = [at(s), value, T(s)]   value: degrees for joints, px for hips.x/y and IK_R/IK_L.x/y, unitless otherwise
   Written for the RIGHT arm; cue(name,{side:'L'}) mirrors it (names swap, angles flip sign).       */
const GESTURES = {
  wave: { arm: 'R', dur: 3.6, prio: 5,
    tracks: {
      shoulder_R: [[0, 28.6, .58], [3.0, 0, .6]],
      arm_R: [[.06, 98.5, .58], [3.0, 0, .62]],
      head: [[0, -2.9, .5], [3.0, 0, .6]],
    },
    osc: [
      { ch: 'arm_R', from: .62, to: 3.0, amp: 15.5, hz: 2.4, ph: 0, ramp: .25 },
      { ch: 'palm_R', from: .62, to: 3.0, amp: 11.5, hz: 2.4, ph: 1.2, ramp: .25 },
      { ch: 'hand_R', from: .62, to: 3.0, amp: 5.7, hz: 2.4, ph: 2.0, ramp: .25 },
    ] },
  glasses: { arm: 'R', dur: 3.4, prio: 5,
    reach: { target: { node: 'eyeglass', dx: -112, dy: -22 }, hand: -60, at: 0, T: .85, hold: 1.4, back: .8, nudge: { at: 1.0, dy: -7, up: .15, down: .22 } },
    tracks: { head: [[.1, -2.2, .55], [2.4, 0, .6]] },
    fallback: { shoulder_R: [[0, 49.3, .58], [2.2, 0, .6]], arm_R: [[.05, 113.4, .6], [2.2, 0, .6]], head: [[.1, -2.2, .5], [2.2, 0, .6]] } },
  present: { arm: 'R', dur: 2.6, prio: 5,
    tracks: {
      shoulder_R: [[0, 62, .6], [2.0, 0, .6]], arm_R: [[.06, 24, .6], [2.0, 0, .6]], hand_R: [[.12, 12, .5], [2.0, 0, .5]],
      head: [[0, 2.2, .5], [2.0, 0, .6]], chest: [[0, -.8, .5], [2.0, 0, .6]],
    } },
  nod: { arm: null, dur: 1.3, prio: 4,
    tracks: { 'gaze.y': [[0, .75, .16], [.2, -.1, .16], [.42, .75, .16], [.64, 0, .24]], 'hips.y': [[0, 1.6, .16], [.2, -.3, .16], [.42, 1.6, .16], [.64, 0, .24]] } },
  shake: { arm: null, dur: 1.6, prio: 4,
    // A "no" shake has to turn the actual head bone (deg, auto-radians via JOINTS) - hair, ears, etc.
    // are rigged to that bone, so once it truly rotates they turn with it instead of staying put while
    // only the eyes dart side to side. The eyes lead the turn by a hair (~90ms) the way a real head
    // shake works, at a smaller amplitude than the head itself.
    osc: [
      { ch: 'head', from: 0, to: 1.5, amp: 7.5, hz: 1.7, ph: 0, ramp: .14 },
      { ch: 'gaze.x', from: 0, to: 1.5, amp: .4, hz: 1.7, ph: .15, ramp: .14 },
    ] },
  surprise: { arm: null, leg: 'both', dur: 2.0, prio: 6, kick: { y: -110, sh: 2.6, roll: 1.3 },
    tracks: { 'pose.lookUp': [[0, .55, .1], [1.3, 0, .7]], 'pose.surpriseO': [[0, .8, .08], [1.2, 0, .7]],
      air: [[0, 7, .1], [.14, 0, .18]], 'IK_R.y': [[.02, -3, .1], [.16, 0, .2]], 'IK_L.y': [[.02, -3, .1], [.16, 0, .2]], squat: [[.3, 4, .1], [.4, 0, .25]] } },
  shrug: { arm: 'both', dur: 1.9, prio: 5,
    tracks: {
      shoulder_R: [[0, 7, .35], [1.2, 0, .5]], shoulder_L: [[0, -7, .35], [1.2, 0, .5]],
      arm_R: [[.04, 12, .4], [1.2, 0, .5]], arm_L: [[.04, -12, .4], [1.2, 0, .5]],
      hand_R: [[.1, 9, .4], [1.2, 0, .5]], hand_L: [[.1, -9, .4], [1.2, 0, .5]],
      head: [[.1, 2.4, .45], [1.3, 0, .6]], 'hips.y': [[0, -1.6, .3], [1.2, 0, .5]], 'pose.lookUp': [[.1, .25, .4], [1.2, 0, .5]],
    } },
  celebrate: { arm: 'both', leg: 'both', dur: 2.8, prio: 6,
    tracks: {
      // two hops with the arms up: crouch, spring, land
      air: [[.45, 14, .15], [.62, 0, .16], [1.2, 14, .15], [1.37, 0, .16]],
      squat: [[.3, 5, .15], [.45, 0, .12], [.78, 6, .1], [.9, 0, .25], [1.05, 5, .15], [1.2, 0, .12], [1.53, 6, .1], [1.65, 0, .3]],
      shoulder_R: [[0, 150, .5], [2.1, 0, .7]], shoulder_L: [[.05, -150, .5], [2.1, 0, .7]],
      arm_R: [[.05, 20, .5], [2.1, 0, .7]], arm_L: [[.1, -20, .5], [2.1, 0, .7]],
      head: [[0, -2, .5], [2.1, 0, .6]],
    },
    osc: [
      { ch: 'hand_R', from: .6, to: 2.1, amp: 8, hz: 3, ph: 0, ramp: .2 }, { ch: 'hand_L', from: .6, to: 2.1, amp: 8, hz: 3, ph: 1.6, ramp: .2 },
      { ch: 'hips.y', from: .5, to: 2.1, amp: 2.2, hz: 3, ph: 0, ramp: .25 }, { ch: 'head', from: .5, to: 2.1, amp: 2.6, hz: 1.5, ph: 0, ramp: .3 },
    ] },
  // ---- legs (the artboard is extended at load so the whole leg shows - see LEGS in avatar.js) ----
  // leg: 'R' = written for the right leg, cue(name,{side:'L'}) mirrors it. leg: 'both' owns both legs.
  footTap: { arm: null, leg: 'R', dur: 1.5, prio: 2,
    tracks: { 'IK_R.y': [[0, -9, .08], [.1, 0, .09], [.33, -9, .08], [.43, 0, .09], [.66, -9, .08], [.76, 0, .1]],
              'hips.x': [[0, 2.2, .3], [1.0, 0, .45]], 'IK_R.x': [[0, -3, .2], [1.0, 0, .3]] } },
  // body over the left leg, right foot unloaded and turned out a little: the classic relaxed stance
  weightShift: { arm: null, leg: 'R', dur: 2.6, prio: 2,
    tracks: { 'hips.x': [[0, 4.5, .55], [1.8, 0, .7]], hips: [[0, 1.2, .55], [1.8, 0, .7]], chest: [[0, -.8, .55], [1.8, 0, .7]],
              'IK_R.y': [[.15, -6, .45], [1.7, 0, .55]], 'IK_R.x': [[.15, -4, .45], [1.7, 0, .55]] } },
  // little knee bounces, shoulders and head riding along (happy / laughing / excited)
  bounce: { arm: null, leg: 'both', dur: 2.6, prio: 3,
    tracks: { squat: pulses(5, 0, .5, 7) },
    osc: [{ ch: 'head', from: 0, to: 2.4, amp: 1.6, hz: 2, ph: 0, ramp: .25 },
          { ch: 'shoulder_R', from: 0, to: 2.4, amp: 2.2, hz: 2, ph: 1.0, ramp: .25 }, { ch: 'shoulder_L', from: 0, to: 2.4, amp: 2.2, hz: 2, ph: 1.0, ramp: .25 }] },
  jump: jumpSpec(30, 11, 6),
  hop: jumpSpec(12, 5, 4),
  // walking on the spot, alternate knee lifts with the weight passing over the standing leg
  march: { arm: null, leg: 'both', dur: 3.2, prio: 3,
    tracks: { 'IK_R.y': pulses(3, 0, 1.0, -13, { up: .22, hold: .06, down: .3 }), 'IK_L.y': pulses(3, .5, 1.0, -13, { up: .22, hold: .06, down: .3 }),
              'hips.x': alternate(6, 0, .5, 3, .4, 3.0), hips: alternate(6, 0, .5, 1.1, .4, 3.0), squat: pulses(6, .05, .5, 1.5) },
    osc: [{ ch: 'shoulder_R', from: 0, to: 3.0, amp: 4, hz: 1, ph: 0, ramp: .3 }, { ch: 'shoulder_L', from: 0, to: 3.0, amp: 4, hz: 1, ph: PI, ramp: .3 }] },
  // a straight-legged kick out to the side (the foot rides an arc around the hip, so the leg never buckles)
  kick: { arm: null, leg: 'R', dur: 1.3, prio: 4,
    tracks: { 'IK_R.x': [[0, -8, .14], [.16, -64, .18], [.62, 0, .38]], 'IK_R.y': [[0, -3, .14], [.16, -14, .18], [.62, 0, .38]],
              'hips.x': [[0, 4, .3], [.9, 0, .5]], hips: [[0, 1.5, .3], [.9, 0, .5]], head: [[.05, -1.5, .3], [.9, 0, .4]] } },
  // impatient / emphatic: foot up, then down hard
  stomp: { arm: null, leg: 'R', dur: 1.0, prio: 4, kick: { y: 60, sh: 0, roll: .8 },
    tracks: { 'IK_R.y': [[0, -16, .16], [.2, 0, .07]], 'hips.x': [[0, 2.5, .2], [.8, 0, .4]] } },
  // a groove: knee bounce, hips side to side, feet alternately off the floor, shoulders and head in time
  dance: { arm: null, leg: 'both', dur: 5.2, prio: 3,
    tracks: { squat: pulses(10, 0, .5, 6), 'hips.x': alternate(10, 0, .5, 4, .45, 5.0), hips: alternate(10, 0, .5, 2, .45, 5.0),
              'IK_R.y': pulses(5, 0, 1.0, -8, { up: .2, down: .25 }), 'IK_L.y': pulses(5, .5, 1.0, -8, { up: .2, down: .25 }) },
    osc: [{ ch: 'head', from: 0, to: 5.0, amp: 2.4, hz: 1, ph: 0, ramp: .3 },
          { ch: 'shoulder_R', from: 0, to: 5.0, amp: 6, hz: 1, ph: 0, ramp: .3 }, { ch: 'shoulder_L', from: 0, to: 5.0, amp: 6, hz: 1, ph: PI, ramp: .3 }] },
  // ambient leg life, cued by the LegLife layer while idle (prio 1: anything else wins)
  fidgetFoot: { arm: null, leg: 'R', dur: 1.3, prio: 1,
    tracks: { 'IK_R.y': [[0, -5, .3], [.7, 0, .4]], 'IK_R.x': [[0, -7, .3], [.6, 0, .45]], 'hips.x': [[0, 1.5, .35], [.8, 0, .5]] } },
  fidgetTap: { arm: null, leg: 'R', dur: 1.0, prio: 1,
    tracks: { 'IK_R.y': [[0, -4, .1], [.12, 0, .1], [.34, -4, .1], [.46, 0, .12]] } },
  // Elbow up, hand toward the chin, head tipped, eyes wander up-left then settle down-right (mental
  // arithmetic / reading chat). Plain tracks only, no reach target - this works even on rigs with no
  // named prop nodes.
  thinking: { arm: 'R', dur: 2.6, prio: 4,
    tracks: {
      shoulder_R: [[0, 108, .5], [2.1, 0, .55]], arm_R: [[.08, 96, .55], [2.1, 0, .55]],
      hand_R: [[.14, -22, .45], [2.1, 0, .5]], head: [[.1, -3, .5], [2.1, 0, .6]],
      'gaze.x': [[.2, -.5, .3], [1.1, .5, .35], [1.9, 0, .4]],
      'gaze.y': [[.2, -.35, .3], [1.1, .15, .35], [1.9, 0, .4]],
    } },
};

/* ---------------------------------------------------------------- 6. layers */
class Breath {          // asymmetric inhale/exhale, OU-varied rate, pre-speech inspiration
  constructor(o) { this.o = o; this.m = new Motor(); this.state = 'exhale'; this.timer = 1.0; this.rate = new OU(0.14, 6, o.rng); }
  inhaleNow(depth = 1.5, T = 0.28) { this.state = 'inhale'; this.m.interrupt(depth, T); this.timer = T + 0.05; }
  update(dt, speaking) {
    const o = this.o, k = Math.exp(this.rate.step(dt)) * (1 + 0.6 * o.arousal);
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.state === 'exhale') { const T = (1.5 / k) * (0.9 + 0.2 * o.rng.u()); this.state = 'inhale'; this.m.interrupt(1 + 0.25 * o.arousal + 0.2 * (o.rng.u() - .5), T); this.timer = T + 0.08; }
      else { const T = (2.4 / k) * (speaking ? 1.8 : 1) * (0.9 + 0.2 * o.rng.u()); this.state = 'exhale'; this.m.interrupt(0, T); this.timer = T + 0.25; }
    }
    return this.m.step(dt);
  }
}

class Sway {            // quiet-stance sway + occasional weight shift (contrapposto)
  constructor(o) { const r = o.rng; this.o = o; this.tilt = new OU(0.32 * D2R, 1.7, r); this.cx = new OU(0.9, 2.3, r); this.cy = new OU(0.25, 1.4, r); this.shift = new Motor(); this.shiftT = 5 + 9 * r.u(); this.dir = 1; }
  update(dt) {
    const o = this.o, amp = 1 + 0.4 * o.arousal;
    this.shiftT -= dt;
    if (this.shiftT <= 0) { this.dir = -this.dir; this.shift.interrupt(this.o.rng.u() < 0.25 ? 0 : this.dir, 1.3); this.shiftT = 6 + 12 * o.rng.u(); }
    this.shift.step(dt);
    return { tilt: this.tilt.step(dt) * amp, cx: this.cx.step(dt) * amp, cy: this.cy.step(dt), sh: this.shift.x };
  }
}

class Blink {
  constructor(o) { this.o = o; this.m = new Motor(); this.next = 2.4; }
  trigger(delay = 0) { if (this.m.busy) return; this.m.clear(); this.m.schedule(delay, 1, 0.07); this.m.schedule(delay + 0.095, 0, 0.15); }   // close fast, open ~2x slower
  update(dt, life, rate) {
    this.next -= dt;
    if (this.next <= 0) { if (life) this.trigger(); this.next = (2.2 + 4.2 * this.o.rng.u()) / rate; if (this.o.rng.u() < 0.12) this.next = 0.35; }
    return this.m.step(dt);
  }
}

class Gaze {
  constructor(o) {
    this.o = o; this.gx = new Motor(); this.gy = new Motor(); this.hx = new Motor(); this.cx = new Motor();
    this.tx = 0; this.ty = 0; this.cursorAge = 99; this.goalX = 0; this.goalY = 0; this.hGoal = 0; this.cGoal = 0;
    this.refr = 0; this.wanderT = 1.5; this.wx = 0; this.wy = 0; this.tremor = new OU(0.012, 0.15, o.rng); this.lastSaccade = 0;
  }
  setTarget(x, y) { this.tx = clamp(x, -1, 1); this.ty = clamp(y, -1, 1); this.cursorAge = 0; }
  _head(des) {                                    // head joins only beyond the eye-only range (~13 deg)
    const hT = Math.sign(des) * clamp((Math.abs(des) - 0.45) * 0.75, 0, 0.5);
    if (Math.abs(hT - this.hGoal) > 0.02) {
      const Th = 0.22 + 0.30 * Math.abs(hT - this.hx.x);
      this.hx.clear().schedule(0.04, hT, Th);      // head lags the eye by ~40 ms
      this.cx.clear().schedule(0.09, 0.3 * hT, 0.45);
      this.hGoal = hT;
    }
  }
  _axis(m, key, des) {
    const A = Math.abs(des - m.x), rng = this.o.rng;
    if (this.refr <= 0) {
      if (A > 0.16) {                              // saccade: duration from the main sequence, ~21 ms + 2.2 ms/deg
        const T = clamp(0.021 + 0.066 * A, 0.028, 0.11);
        m.interrupt(des, T); this.refr = T + 0.13; this.lastSaccade = A;
        if (A > 0.4 && rng.u() < 0.55) this.o.blink.trigger(0.03);      // blinks ride on big gaze shifts
      } else if (A > 0.003) m.interrupt(des, 0.30);   // smooth pursuit = receding-horizon min-jerk tracker
    }
  }
  update(dt, life, speaking, off) {
    const rng = this.o.rng;
    this.cursorAge += dt; this.refr -= dt; this.wanderT -= dt;
    const away = this.cursorAge > 6;
    if (this.wanderT <= 0) {
      const s = speaking ? 0.5 : 1;
      this.wx = (rng.u() * 2 - 1) * (away ? 0.85 : 0.18) * s; this.wy = (rng.u() * 2 - 1) * (away ? 0.5 : 0.12) * s;
      this.wanderT = away ? 1.4 + rng.u() * 2.2 : 1.8 + rng.u() * 3;
    }
    const k = away ? 1 : 0.6;
    const dx = clamp((away ? 0 : this.tx) + (life ? this.wx * k : 0), -1, 1), dy = clamp((away ? 0 : this.ty) + (life ? this.wy * k : 0), -1, 1);
    this._axis(this.gx, 'x', dx); this._axis(this.gy, 'y', dy); this._head(dx);
    this.gx.step(dt); this.gy.step(dt); this.hx.step(dt); this.cx.step(dt);
    const eye = clamp(this.gx.x - this.hx.x, -1, 1) + (life ? this.tremor.step(dt) : 0);   // VOR: eye-in-head = gaze - head
    return { eye: clamp(eye + off.x, -1, 1), up: clamp(this.gy.x + off.y, -1, 1), head: this.hx.x + 0.6 * off.x, chest: this.cx.x };
  }
}

/* speech beats -------------------------------------------------------- */
function detectBeats(env, rate, o) {
  o = Object.assign({ minGap: 0.32, prom: 0.18, thr: 0.35, smooth: 0.06 }, o || {});
  const n = env.length, w = Math.max(1, Math.round(o.smooth * rate)), e = new Float32Array(n);
  let mx = 1e-9;
  for (let i = 0, acc = 0; i < n + w; i++) {                       // moving average (causal sum, centred write)
    if (i < n) acc += env[i]; if (i >= w) acc -= env[i - w];
    const j = i - (w >> 1); if (j >= 0 && j < n) { e[j] = acc / w; if (e[j] > mx) mx = e[j]; }
  }
  for (let i = 0; i < n; i++) e[i] /= mx;
  const look = Math.round(0.25 * rate), peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (e[i] < o.thr || e[i] < e[i - 1] || e[i] < e[i + 1]) continue;
    let mn = e[i]; for (let k = Math.max(0, i - look); k < i; k++) if (e[k] < mn) mn = e[k];
    if (e[i] - mn >= o.prom) peaks.push({ t: i / rate, s: e[i] });
  }
  const out = [];
  for (const p of peaks) {
    const last = out[out.length - 1];
    if (last && p.t - last.t < o.minGap) { if (p.s > last.s) out[out.length - 1] = p; } else out.push(p);
  }
  return out;
}
function energyFromVisemes(events, total, rate = 100) {           // fallback when no audio envelope is available
  const n = Math.max(1, Math.ceil(total * rate)), env = new Float32Array(n);
  for (const ev of events) {
    const a = ev.id === 0 ? 0 : (ev.id === 1 || ev.id === 9 || ev.id === 10 || ev.id === 11) ? 1 : 0.45;
    for (let i = Math.floor(ev.t0 * rate); i < Math.min(n, Math.ceil((ev.t0 + ev.dur) * rate)); i++) env[i] = a;
  }
  return env;
}

class Prosody {
  constructor(o) {
    this.o = o; this.plan = []; this.speaking = false; this.endT = 0; this.sign = 1;
    this.env = 0; this.prev = 0; this.armed = 0; this.lastBeat = -9;
    this.mh = new Motor(); this.mc = new Motor(); this.tilt = new OU(0.5 * D2R, 2.5, o.rng);
    this.arm = { R: { sh: new Motor(), el: new Motor(), wr: new Motor() }, L: { sh: new Motor(), el: new Motor(), wr: new Motor() } };
  }
  speak(p) {
    const o = this.o, rate = p.rate || 100, t0 = p.t0 !== undefined ? p.t0 : o.t;
    let env = p.energy;
    if (!env && p.visemes) env = energyFromVisemes(p.visemes, p.duration || 3, rate);
    this.plan = env ? detectBeats(env, rate).map(b => ({ t: t0 + b.t, s: b.s })) : [];
    this.speaking = true; this.endT = t0 + (p.duration || 3) + 0.3;
    o.breath.inhaleNow();                                            // people breathe in just before speaking
    return this.plan.length;
  }
  end() { this.speaking = false; this.plan.length = 0; }
  level(v, dt) {                                                     // online mode (no plan): causal peak picking
    this.env += (v - this.env) * (1 - Math.exp(-dt / 0.05));
    if (this.env > 0.45 && this.env > this.prev) this.armed = Math.max(this.armed, this.env);
    if (this.armed && this.env < 0.8 * this.armed && this.o.t - this.lastBeat > 0.32) { this.fire(this.armed); this.armed = 0; }
    if (this.env < 0.2) this.armed = 0;
    this.prev = this.env;
  }
  fire(s) {
    const o = this.o, amp = 0.6 + 0.8 * s; this.lastBeat = o.t; this.sign = -this.sign;
    this.mh.interrupt(this.sign * amp * 1.6 * D2R, 0.1); this.mh.schedule(0.1, 0, 0.26);
    this.mc.interrupt(0.4 * amp * D2R, 0.1); this.mc.schedule(0.1, 0, 0.3);
    const r = o.rng.u(), sides = r < 0.45 ? ['L'] : r < 0.65 ? ['R'] : r < 0.8 ? ['L', 'R'] : [];
    for (const side of sides) {
      if (!o.armFree(side, 1)) continue;
      const sg = side === 'R' ? 1 : -1, a = this.arm[side];
      a.sh.interrupt(sg * (1.5 + 3 * s) * D2R, 0.11); a.sh.schedule(0.11, 0, 0.3);
      a.el.interrupt(sg * (4 + 8 * s) * D2R, 0.11); a.el.schedule(0.11, 0, 0.32);
      a.wr.interrupt(sg * (2 + 5 * s) * D2R, 0.13); a.wr.schedule(0.13, 0, 0.34);
      o.hold(side, 1, 0.5);
    }
  }
  update(dt) {
    const o = this.o;
    while (this.plan.length && this.plan[0].t - 0.1 <= o.t) this.fire(this.plan.shift().s);   // start 0.1 s early: apex on the beat
    if (this.speaking && o.t > this.endT) this.end();
    this.mh.step(dt); this.mc.step(dt);
    for (const s of ['R', 'L']) { const a = this.arm[s]; a.sh.step(dt); a.el.step(dt); a.wr.step(dt); }
    return this.speaking ? this.tilt.step(dt) : 0;                   // slow phrase-level head tilt while talking
  }
}

/* Cartesian reach: straight-line min-jerk hand path + per-frame soft IK ------------------ */
class Reach {
  constructor(o, side) { this.o = o; this.side = side; this.s = new Motor(); this.active = false; this.nudge = new Motor(); }
  start(r, kk) {
    const geo = this.o.geo, g = geo && geo.arm(this.side), k = kk.k;
    if (!g) return false;
    this.def = r; this.kk = kk; this.g0 = g;
    const rest = g.rest, th1 = g.parent + rest[0], th2 = th1 + rest[1], th3 = th2 + rest[2];
    this.p0 = [g.S[0] + g.l1 * Math.cos(th1) + g.l2 * Math.cos(th2), g.S[1] + g.l1 * Math.sin(th1) + g.l2 * Math.sin(th2)];   // rest wrist
    this.h0 = th3;
    const sol = this._solve(g, this.p0, th3, 0);                        // IK at the rest wrist: the mismatch is faded out so s=0 has no pop
    this.err0 = sol.loc.map((v, i) => wrapPi(v - rest[i]));
    this.active = true;
    const T = r.T / k, hold = r.hold / k, back = r.back / k;
    this.s.interrupt(1, T); this.s.schedule(T + hold, 0, back);
    this.nudge.interrupt(0, 0.01);
    if (r.nudge) { const n = r.nudge; this.nudge.schedule(n.at / k, n.dy, n.up / k); this.nudge.schedule((n.at + n.up) / k, 0, n.down / k); }
    return true;
  }
  cancel(T = 0.35) { this.s.interrupt(0, T); }
  _solve(g, wrist, handWorld, s) {
    const bend = this.side === 'R' ? -1 : 1, soft = 0.06 * (g.l1 + g.l2);
    const ik = solveArm2(wrist[0] - g.S[0], wrist[1] - g.S[1], g.l1, g.l2, bend, soft);
    return { loc: [wrapPi(ik.th1 - g.parent), wrapPi(ik.th2 - ik.th1), wrapPi(handWorld - ik.th2)], ik };
  }
  update(dt, ch) {
    if (!this.active) return;
    this.s.step(dt); this.nudge.step(dt);
    const s = this.s.x, geo = this.o.geo, g = geo && geo.arm(this.side);
    if (!g) return;
    if (!this.s.busy && s < 1e-4) { this.active = false; return; }
    const r = this.def;
    const tp = geo.point(r.target);                                     // dynamic target: follows head sway
    const tip1 = [tp[0], tp[1] + this.nudge.x];
    const handAng = this.kk.mir ? PI - r.hand * D2R : r.hand * D2R;
    const hw = this.h0 + wrapPi(handAng - this.h0) * s;                 // hand direction: shortest path from rest
    const tipRest = [this.p0[0] + g.l3 * Math.cos(this.h0), this.p0[1] + g.l3 * Math.sin(this.h0)];
    const tip = [lerp(tipRest[0], tip1[0], s), lerp(tipRest[1], tip1[1], s)];   // straight line in Cartesian space
    const wrist = [tip[0] - g.l3 * Math.cos(hw), tip[1] - g.l3 * Math.sin(hw)];
    const sol = this._solve(g, wrist, hw, s), names = ARM_JOINTS[this.side], rest = g.rest;
    for (let i = 0; i < 3; i++) ch[names[i]] += wrapPi(sol.loc[i] - rest[i]) - (1 - s) * this.err0[i];
    this.lastTip = tip;
  }
}

/* Ambient leg life: (1) when the body's weight shifts over one leg, the other foot is unloaded a touch;
   (2) every 7-17 s of idling a small foot adjustment, toe tap or weight shift is cued (prio 1, so any
   real gesture wins). Never while speaking, never with life off. */
class LegLife {
  constructor(o) { this.o = o; this.next = 5 + 7 * o.rng.u(); this.a = { R: 1, L: 1 }; }
  ambient(dt, sh) {
    const o = this.o, k = 1 - Math.exp(-dt / 0.25);
    for (const s of ['R', 'L']) this.a[s] += ((o.legFree(s, 1) ? 1 : 0) - this.a[s]) * k;
    return { R: 1.6 * Math.max(0, sh) * this.a.R, L: 1.6 * Math.max(0, -sh) * this.a.L };
  }
  update(dt, speaking) {
    const o = this.o; this.next -= dt; if (this.next > 0) return;
    this.next = 7 + 10 * o.rng.u();
    if (speaking || !o.life || !o.on.legs || !o.legFree('R', 1) || !o.legFree('L', 1)) return;
    const r = o.rng.u(), name = r < 0.45 ? 'fidgetFoot' : r < 0.75 ? 'fidgetTap' : 'weightShift';
    o.cue(name, { side: o.rng.u() < 0.5 ? 'R' : 'L', prio: 1, speed: 0.9 + 0.3 * o.rng.u() });
  }
}

/* ---------------------------------------------------------------- 7. the Orchestra */
class Orchestra {
  constructor(opts) {
    const o = this.opts = Object.assign({ seed: 20260921, life: true }, opts || {});
    this.rng = makeRng(o.seed); this.t = 0; this.geo = o.geometry || null; this.life = !!o.life;
    this.arousal = 0.3; this.valence = 0.3;
    this.on = { breath: true, sway: true, gaze: true, blink: true, prosody: true, secondary: true, com: true, legs: true };
    this.gm = {}; this.osc = []; this.hold_ = { R: { prio: 0, until: 0 }, L: { prio: 0, until: 0 } };
    this.legHold_ = { R: { prio: 0, until: 0 }, L: { prio: 0, until: 0 } };
    this.breath = new Breath(this); this.sway = new Sway(this); this.gaze = new Gaze(this); this.blink = new Blink(this); this.prosody = new Prosody(this);
    this.reach = { R: new Reach(this, 'R'), L: new Reach(this, 'L') };
    this.legLife = new LegLife(this);
    this.follow = { R: { x: 0, v: 0 }, L: { x: 0, v: 0 } };
    this.jolt = { y: { x: 0, v: 0 }, sh: { x: 0, v: 0 }, roll: { x: 0, v: 0 } };
    this.gestures = Object.assign({}, GESTURES);
    this.gazeOff = { x: 0, y: 0 };
    this.frame = { ch: {}, t: 0 };
    for (const c of CHANNELS) this.frame.ch[c] = 0;
  }

  /* ---- public API ---- */
  setMood(m) { if (m.arousal !== undefined) this.arousal = clamp(m.arousal, 0, 1); if (m.valence !== undefined) this.valence = clamp(m.valence, -1, 1); }
  setLife(v) { this.life = !!v; }
  enable(layer, v) { this.on[layer] = !!v; }
  lookAt(x, y) { this.gaze.setTarget(x, y); }
  blinkNow() { this.blink.trigger(); }
  speak(plan) { return this.prosody.speak(plan); }
  speechLevel(v, dt) { this.prosody.speaking = true; this.prosody.endT = this.t + 0.5; this.prosody.level(v, dt); }
  endSpeech() { this.prosody.end(); }
  defineGesture(name, spec) { this.gestures[name] = spec; }
  armFree(side, prio) { const h = this.hold_[side]; return h.until <= this.t || h.prio <= prio; }
  hold(side, prio, dur) { this.hold_[side] = { prio, until: this.t + dur }; }
  legFree(side, prio) { const h = this.legHold_[side]; return h.until <= this.t || h.prio <= prio; }
  holdLeg(side, prio, dur) { this.legHold_[side] = { prio, until: this.t + dur }; }
  /* how far off the ground the body is right now (artboard px) - publish.html shrinks the floor shadow with it */
  get airborne() { return this.frame.ch.air || 0; }
  kick(k) { this.jolt.y.v += k.y || 0; this.jolt.sh.v += (k.sh || 0); this.jolt.roll.v += (k.roll || 0); }

  _motor(ch) { return this.gm[ch] || (this.gm[ch] = new Motor()); }
  _releaseArm(side) {
    for (const j of ARM_JOINTS[side]) { const m = this._motor(j); m.clear(); if (Math.abs(m.x) > 1e-4 || m.busy) m.interrupt(0, 0.3); }
    for (const os of this.osc) if (ARM_JOINTS[side].includes(os.ch) && os.fade === undefined) os.fade = this.t;
    this.reach[side].cancel(0.3);
  }

  /* ease the given legs back to neutral (their foot targets, and the torso channels a two-leg gesture owns) */
  _releaseLegs(sides) {
    const chs = []; for (const s of sides) chs.push(...LEG_JOINTS[s]);
    if (sides.length === 2) chs.push(...LEG_SHARED);
    for (const c of chs) { const m = this.gm[c]; if (!m) continue; m.clear(); if (Math.abs(m.x) > 1e-4 || m.busy) m.interrupt(0, 0.3); }
    for (const os of this.osc) if (chs.includes(os.ch) && os.fade === undefined) os.fade = this.t;
  }
  /* "Stop motion": put both legs back on the ground and forget who owned them */
  stopLegs() { this._releaseLegs(['R', 'L']); this.legHold_ = { R: { prio: 0, until: 0 }, L: { prio: 0, until: 0 } }; }

  /* start a gesture NOW. Returns false only if a higher-priority gesture owns the arm. */
  cue(name, o) {
    o = o || {};
    const spec = this.gestures[name]; if (!spec) return false;
    const side = o.side || 'R', mir = side === 'L' && (spec.arm === 'R' || spec.leg === 'R');
    const arms = spec.arm === 'both' ? ['R', 'L'] : spec.arm === 'R' ? [mir ? 'L' : 'R'] : [];
    const legs = spec.leg === 'both' ? ['R', 'L'] : spec.leg === 'R' ? [mir ? 'L' : 'R'] : [];
    const prio = o.prio !== undefined ? o.prio : spec.prio !== undefined ? spec.prio : 5;
    for (const a of arms) if (!o.force && !this.armFree(a, prio)) return false;
    for (const l of legs) if (!o.force && !this.legFree(l, prio)) return false;
    const k = o.speed || (1 + 0.5 * (this.arousal - 0.3)), amp = o.amp || 1;
    for (const a of arms) { this._releaseArm(a); this.hold(a, prio, spec.dur / k); }
    if (legs.length) { this._releaseLegs(legs); for (const l of legs) this.holdLeg(l, prio, spec.dur / k); }

    const useReach = spec.reach && this.geo && this.geo.fkOk && this.geo.arm(mir ? 'L' : 'R')
      && this.geo.hasNode && this.geo.hasNode(spec.reach.target.node);
    const tracks = useReach || !spec.fallback ? spec.tracks : Object.assign({}, spec.tracks, spec.fallback);
    const mapName = n => { if (!mir) return n; if (/_R$/.test(n)) return n.slice(0, -2) + '_L'; if (/^IK_R\./.test(n)) return 'IK_L.' + n.slice(5); return n; };
    const flip = n => mir && (n in JOINTS || n === 'hips.x' || n === 'gaze.x' || /^IK_.\.x$/.test(n)) ? -1 : 1;
    const unit = n => (n in JOINTS ? D2R : 1);
    for (const n in tracks) {
      const ch = mapName(n), m = this._motor(ch), f = flip(n) * unit(n) * amp;
      m.clear();
      for (const [at, v, T] of tracks[n]) { if (at <= 1e-9) m.interrupt(v * f, T / k); else m.schedule(at / k, v * f, T / k); }
    }
    for (const os of spec.osc || []) {
      const ch = mapName(os.ch);
      this.osc.push({ ch, t0: this.t + os.from / k, t1: this.t + os.to / k, ramp: os.ramp / k, amp: os.amp * flip(os.ch) * unit(os.ch) * amp, w: TAU * os.hz * k, ph: os.ph, fade: undefined });
    }
    if (useReach) {
      const r = spec.reach, r2 = mir ? Object.assign({}, r, { target: Object.assign({}, r.target, { dx: -r.target.dx }) }) : r;
      this.reach[mir ? 'L' : 'R'].start(r2, { k, mir });
    }
    if (spec.kick) this.kick(spec.kick);
    if (name === 'surprise') this.blink.m.clear().interrupt(0, 0.05);
    return true;
  }

  /* ---- the per-frame update ---- */
  step(dt) {
    dt = clamp(dt, 0, 0.05); this.t += dt;
    const ch = this.frame.ch, on = this.on, life = this.life, sp = this.prosody.speaking, ar = this.arousal;
    for (const c in ch) ch[c] = 0;

    // breathing
    const b = on.breath ? this.breath.update(dt, sp) : 0;
    ch.chest += 0.55 * D2R * b * (1 + ar); ch.shoulder_R += 0.9 * D2R * b; ch.shoulder_L -= 0.9 * D2R * b;
    ch.head -= 0.18 * D2R * b; ch['hips.y'] -= 0.6 * b;
    let stab = 0.55 * D2R * b * (1 + ar);                                       // unintentional torso rotation

    // balance
    let legSh = 0;
    if (on.sway && life) {
      const s = this.sway.update(dt);
      const hipsR = s.tilt + 1.1 * D2R * s.sh, chestR = 0.5 * s.tilt - 0.7 * D2R * s.sh;
      ch.hips += hipsR; ch.chest += chestR; stab += hipsR + chestR;
      if (on.com) { ch['hips.x'] += s.cx + 3.2 * s.sh; ch['hips.y'] += s.cy; }
      legSh = s.sh;
    }
    if (on.legs) {                               // the unloaded foot lifts and turns out a little while the weight is over the other leg
      const a = this.legLife.ambient(dt, legSh);
      ch['IK_R.y'] -= a.R; ch['IK_R.x'] -= 1.8 * a.R; ch['IK_L.y'] -= a.L; ch['IK_L.x'] += 1.8 * a.L;
      this.legLife.update(dt, sp);
    }

    // gaze + blink
    const gOff = this.gazeOff; gOff.x = 0; gOff.y = 0;
    for (const c of ['gaze.x', 'gaze.y']) { const m = this.gm[c]; if (m) { m.step(dt); (c === 'gaze.x' ? (gOff.x = m.x) : (gOff.y = m.x)); } }
    for (const os of this.osc) if (os.ch === 'gaze.x' || os.ch === 'gaze.y') { const v = this._oscVal(os); if (os.ch === 'gaze.x') gOff.x += v; else gOff.y += v; }
    if (on.gaze) {
      const g = this.gaze.update(dt, life, sp, gOff);
      ch['pose.eyesRight'] += clamp(g.eye, 0, 1) * 0.95; ch['pose.eyesLeft'] += clamp(-g.eye, 0, 1) * 0.95;
      // deadzone: small, constant ambient wander (which happens most of the time) must stay eyes-only -
      // the brow/eyelid "look up/down" pose is reserved for a genuinely large, sustained glance, so it
      // doesn't flicker on with every idle micro-movement (previously linear from the very first degree
      // of movement, which read as the eyes/brows "popping" up on almost every action).
      ch['pose.lookUp'] += deadzone(clamp(-g.up, 0, 1), 0.35) * 0.75; ch['pose.lookDown'] += deadzone(clamp(g.up, 0, 1), 0.35) * 0.7;
      ch.head += g.head * GAZE_ROLL; ch.chest += g.chest * GAZE_LEAN;
    }
    if (on.blink) ch['pose.blink'] += this.blink.update(dt, life, (1 + 0.4 * ar) * (sp ? 1.3 : 1));
    ch['pose.smile'] += clamp(this.valence, 0, 1);

    // jolts (spring impulses: overshoot and settle)
    springStep(this.jolt.y, 0, dt, 24, 0.32); springStep(this.jolt.sh, 0, dt, 22, 0.34); springStep(this.jolt.roll, 0, dt, 20, 0.34);
    ch['hips.y'] += this.jolt.y.x; ch.shoulder_R += this.jolt.sh.x; ch.shoulder_L -= this.jolt.sh.x; ch.head += this.jolt.roll.x;

    // speech beats
    if (on.prosody) {
      const p = this.prosody, tilt = p.update(dt);
      ch.head += p.mh.x + tilt; ch.chest += p.mc.x; stab += p.mc.x;
      for (const side of ['R', 'L']) { const a = p.arm[side], J = ARM_JOINTS[side]; ch[J[0]] += a.sh.x; ch[J[1]] += a.el.x; ch[J[2]] += a.wr.x; }
    }

    // scripted gestures (per-channel minimum-jerk motors) + oscillators + reach
    for (const c in this.gm) { if (c === 'gaze.x' || c === 'gaze.y') continue; const m = this.gm[c]; m.step(dt); if (c in ch) ch[c] += m.x; }
    for (const os of this.osc) if (os.ch !== 'gaze.x' && os.ch !== 'gaze.y' && os.ch in ch) ch[os.ch] += this._oscVal(os);
    this.osc = this.osc.filter(os => this.t < os.t1 + os.ramp + 0.05 && !(os.fade !== undefined && this.t > os.fade + 0.3));
    try { this.reach.R.update(dt, ch); } catch (e) { this.reach.R.active = false; }
    try { this.reach.L.update(dt, ch); } catch (e) { this.reach.L.active = false; }

    // head-in-space stabilisation: neck counter-rotates the unintentional torso motion
    ch.neck += -0.75 * stab; ch.head += -0.2 * stab;

    // secondary motion: hanging arms lag the torso (spring in the world frame)
    if (on.secondary) {
      const psi = ch.hips + ch.chest;
      springStep(this.follow.R, psi, dt, 10, 0.30); springStep(this.follow.L, psi, dt, 9, 0.32);
      ch.shoulder_R += this.follow.R.x - psi; ch.shoulder_L += this.follow.L.x - psi;
    }

    // anatomical limits (soft)
    for (const j in JOINTS) { const [lo, hi] = JOINTS[j], kn = 0.12 * (hi - lo) * D2R; ch[j] = softLimit(ch[j], lo * D2R, hi * D2R, kn); }
    for (const n in NODE_CH) {                   // knee kept inside the range so 0 is never pushed off 0 (a 0.1 px foot offset = a visible knee)
      const [lo, hi] = NODE_CH[n]; ch[n] = softLimit(ch[n], lo, hi, Math.min(0.12 * (hi - lo), 0.8 * Math.min(-lo, hi)));
    }
    if (ch.squat < 0) ch.squat = 0;
    if (ch.air < 0) ch.air = 0;
    for (const p of POSE_KEYS) ch[p] = clamp(ch[p], 0, 1);
    this.frame.t = this.t;
    return this.frame;
  }

  _oscVal(os) {
    const t = this.t, up = minJerk((t - os.t0) / os.ramp), dn = 1 - minJerk((t - (os.t1 - os.ramp)) / os.ramp);
    let env = up * dn; if (os.fade !== undefined) env *= 1 - minJerk((t - os.fade) / 0.3);
    return t < os.t0 ? 0 : os.amp * env * Math.sin(os.w * (t - os.t0) + os.ph);
  }

  info() {
    const g = this.gaze;
    return { t: +this.t.toFixed(2), gaze: +g.gx.x.toFixed(2), head: +g.hx.x.toFixed(2), speaking: this.prosody.speaking,
      arms: { R: this.hold_.R.until > this.t, L: this.hold_.L.until > this.t }, osc: this.osc.length };
  }
}

/* ---------------------------------------------------------------- 8. Rive driver */
const VISEME_ANIMS = ['Lips_Idle', 'A,E,I', 'L', 'Q,W', 'TH', 'N', 'C,D,G,K,N,R,S,T,X,Y,Z', 'B,M,P', 'F,V', 'EE', 'O', 'U', 'Ch,J,Sh'];
/* frames of the artist's own clips reused as poses: [clip, seconds, neutralSeconds]
   neutralSeconds is the frame of the SAME clip that means "not doing this" (the rest face).
   It is what the pose is blended back to when its weight falls, which is what stops a pose
   (a look-up, a glance) from staying on the face for ever - see applyPoses(). */
const DEFAULT_POSES = {
  'pose.eyesRight': ['idle', 1.75, 0], 'pose.eyesLeft': ['idle', 3.5, 0],
  'pose.lookUp': ['action', 5.0, 0], 'pose.lookDown': ['action', 6.5, 0],
  'pose.blink': ['idle', 2.133, 0],
};

class RigDriver {
  constructor(rive, artboard, opts) {
    opts = opts || {};
    this.rive = rive; this.ab = artboard; this.poses = opts.poses || DEFAULT_POSES; this.log = opts.log || (() => {});
    this.ch = {}; this.nd = {}; this.anims = {}; this.fkOk = false; this.len = {};
    this.held = {};                        // pose key -> how much of that pose is believed to be on the rig
  }
  _get(n) { const ab = this.ab; try { return ab.transformComponent(n) || ab.bone(n) || ab.node(n) || null; } catch (e) { return null; } }
  /* call once, AFTER the state machine has been advanced at least once */
  bind() {
    const ab = this.ab;
    for (const n in JOINTS) { const o = this._get(n); if (o) this.ch[n] = { o, base: o.rotation, last: null }; else this.log('joint not found: ' + n); }
    // hips is a ROOT BONE in this rig (artboard.node('hips') would hand back a wrongly-typed object with junk x/y),
    // the two foot targets are plain nodes.
    { let o = null; try { o = ab.rootBone('hips'); } catch (e) {}
      if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && Math.abs(o.x) < 1e4 && Math.abs(o.y) < 1e4) this.nd.hips = { o, bx: o.x, by: o.y, lx: null, ly: null };
      else this.log('node offsets unavailable: hips'); }
    for (const n of ['IK_R', 'IK_L']) { let o = null; try { o = ab.node(n); } catch (e) {} if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) this.nd[n] = { o, bx: o.x, by: o.y, lx: null, ly: null }; else this.log('node offsets unavailable: ' + n); }
    for (const s of ['R', 'L']) {
      const b = j => { try { const x = ab.bone(j); return x ? x.length : 0; } catch (e) { return 0; } };
      this.len[s] = [b('shoulder_' + s), b('arm_' + s), b('hand_' + s)];
    }
    ab.advance(0);
    // FK probe (as in your v5 rig): the arm bones only obey their rotation if the arm IK constraint is off
    const sh = this.ch.shoulder_R && this.ch.shoulder_R.o;
    if (sh) {
      const ang = () => { const m = sh.worldTransform(); return Math.atan2(m.xy, m.xx); };
      const a0 = ang(), r0 = sh.rotation; sh.rotation = r0 + 0.4; ab.advance(0);
      this.fkOk = Math.abs(wrapPi(ang() - a0)) > 0.3; sh.rotation = r0; ab.advance(0);
    }
    if (!this.fkOk) this.log('right-arm IK constraint is active: arm gestures disabled (use the patched avatar.riv)');
    // The artist's "action" clip (used for the look-up / look-down poses and the head-tilt gesture) also keys the ROOT
    // node boy1: it sinks ~35 units and grows 5% (a camera push-in). With only the upper body on screen that was
    // invisible; with legs on screen it makes the whole character sink through the floor. pinRoot() puts it back.
    this.root = null; this.pin = false;
    try { const o = ab.node('boy1'); if (o && Number.isFinite(o.y) && Number.isFinite(o.scaleX)) this.root = { o, x: o.x, y: o.y, sx: o.scaleX, sy: o.scaleY }; } catch (e) {}
    this._probeLegs();
    return this;
  }
  /* Leg probe: nudge a foot target and the hips and check that the ankle / head really follow. If not (a rig
     without leg IK) the corresponding channel is dropped, so nothing writes to nodes that do nothing. */
  _probeLegs() {
    const ab = this.ab, ft = this._get('foot_R'), hd = this._get('head'), ik = this.nd.IK_R, hp = this.nd.hips;
    this.legsOk = false; this.hipsOk = false;
    try {
      if (ik && ft) { const y0 = ft.worldTransform().ty, by = ik.o.y; ik.o.y = by - 10; ab.advance(0); this.legsOk = Math.abs(ft.worldTransform().ty - y0) > 4; ik.o.y = by; ab.advance(0); }
      if (hp && hd) { const y0 = hd.worldTransform().ty, by = hp.o.y; hp.o.y = by + 10; ab.advance(0); this.hipsOk = Math.abs(hd.worldTransform().ty - y0) > 4; hp.o.y = by; ab.advance(0); }
    } catch (e) {}
    if (!this.hipsOk) { delete this.nd.hips; this.log('hips root bone does not move the body: torso offsets off'); }
    if (!this.legsOk) { delete this.nd.IK_R; delete this.nd.IK_L; this.log('leg IK targets do not move the feet: leg gestures off'); }
  }
  /* call once per frame AFTER every clip / pose / gesture has been applied and BEFORE artboard.advance() */
  pinRoot() { const r = this.root; if (!this.pin || !r) return; const o = r.o; o.x = r.x; o.y = r.y; o.scaleX = r.sx; o.scaleY = r.sy; }
  /* geometry provider used by Reach */
  arm(side) {
    const k = this.ch['shoulder_' + side], f = this.ch['arm_' + side], h = this.ch['hand_' + side], L = this.len[side];
    if (!k || !f || !h || !L || !L[0]) return null;
    const m = k.o.worldTransform(), pm = k.o.parentWorldTransform();
    return { S: [m.tx, m.ty], parent: Math.atan2(pm.xy, pm.xx), l1: L[0], l2: L[1], l3: L[2], rest: [k.base, f.base, h.base] };
  }
  point(spec) {
    const o = this._get(spec.node), m = o.worldTransform();
    return [m.tx + (spec.dx || 0), m.ty + (spec.dy || 0)];
  }
  /* Whether a named node exists on THIS rig. A gesture whose reach target is missing (this rig has no
     prop node for it) must fall back to a plain keyframed track rather than throw when Reach later
     asks point() for that node - see cue()'s useReach check. */
  hasNode(name) { try { return !!this._get(name); } catch (e) { return false; } }
  tip(side) {                                                           // measured fingertip (for tests / HUD)
    const h = this.ch['hand_' + side].o, m = h.worldTransform(), L = this.len[side][2];
    const a = Math.atan2(m.xy, m.xx); return [m.tx + L * Math.cos(a), m.ty + L * Math.sin(a)];
  }
  _anim(clip) {
    if (this.anims[clip] !== undefined) return this.anims[clip];
    let a = null;
    try { const def = this.ab.animationByName(clip); if (def) a = new this.rive.LinearAnimationInstance(def, this.ab); } catch (e) {}
    if (!a) this.log('animation not found: ' + clip);
    return (this.anims[clip] = a);
  }

  /* Poses are frames of the artist's clips blended on top of the state machine.
     apply(mix) moves a bone from where it is TOWARD the pose - it never puts it back. For a bone the
     state machine rewrites every frame (anything in the idle clip) that is fine, but a bone only keyed
     by another clip (the look-up in "action") keeps whatever the last apply() left on it: the pose then
     sticks for ever, which is why the face could stay looking up after a gesture was over.
     So every pose remembers how much of it is believed to be on the rig (`held`) and, as soon as the
     wanted weight drops, the clip's NEUTRAL frame is blended in to take it off again - a little each
     frame (RELEASE_MIX), so the return is a smooth ~0.2 s fade and never a one-frame snap. */
  applyPoses(ch) {
    const RELEASE_MIX = 0.3;
    for (const k in this.poses) {
      const spec = this.poses[k];
      const clip = spec[0], t = spec[1], t0 = spec.length > 2 ? spec[2] : 0;
      let want = ch[k] || 0;
      want = want < 0 ? 0 : want > 1 ? 1 : want;
      const held = this.held[k] || 0;
      if (want <= 0.004 && held <= 0.004) { this.held[k] = 0; continue; }
      const a = this._anim(clip);
      if (!a) { this.held[k] = 0; continue; }
      let now = held;
      if (want < held) {                                   // let go of what is still on the rig
        const m = Math.min(RELEASE_MIX, (held - want) / Math.max(held, 1e-6));
        a.time = t0; a.apply(m);
        now = held - m * held;
        if (now < 0.004) now = 0;
      }
      if (want > 0.004) { a.time = t; a.apply(want); now = Math.max(now, want); }
      this.held[k] = now;
    }
  }

  /* Take every pose off the rig over the next frames (used when all motion is stopped). */
  releasePoses() { for (const k in this.held) if (this.held[k] > 0) this.held[k] = Math.max(this.held[k], 0.35); }

  /* Whether this rig actually ships the named per-viseme-group clips ('A,E,I', 'L', ...) as top-level
     animations, as opposed to only exposing mouth shape through the state machine's own internal
     "Lipsync" blend. Call once after bind(); if this is false, applyViseme() has nothing to draw on and
     the caller should keep driving the state machine's Lipsync number input directly instead. */
  hasVisemeClips() {
    if (this._mouthOk !== undefined) return this._mouthOk;
    let n = 0; for (const name of VISEME_ANIMS) if (this.ab.animationByName(name)) n++;
    return (this._mouthOk = n >= VISEME_ANIMS.length - 1);   // tolerate one missing/renamed clip
  }

  /* Smooth mouth mixer: crossfades from whatever viseme was showing to the new one over `xfade`
     seconds instead of the previous version's hard per-frame cut (which is what made a fast run of
     letters look like the mouth was chattering/glitching rather than talking). Call every frame with
     the CURRENT target id, even if it hasn't changed - it self-tracks the transition.
       id    : target viseme id (0 = rest)
       dt    : seconds since the previous call (drives the crossfade's own clock)
       xfade : seconds for a shape-to-shape transition; ~45-70ms matches real articulator speed -
               fast enough to read as speech, slow enough that consecutive letters don't strobe */
  applyViseme(id, dt, xfade) {
    xfade = xfade === undefined ? 0.055 : xfade;
    const mv = this._mouth || (this._mouth = { cur: 0, prev: 0, t: xfade, dur: xfade });
    if (id !== mv.cur) { mv.prev = mv.cur; mv.cur = id; mv.t = 0; mv.dur = Math.max(0.001, xfade); }
    else mv.t += dt || 0;
    const k = Math.min(1, mv.t / mv.dur), w = k * k * (3 - 2 * k);        // smoothstep: cheap, plenty for <70ms
    const stamp = (vid, weight) => {
      if (weight < 0.004) return;
      const name = VISEME_ANIMS[vid]; if (!name) return;
      const a = this.anims[name] || (this.anims[name] = (() => { const def = this.ab.animationByName(name); return def ? new this.rive.LinearAnimationInstance(def, this.ab) : null; })());
      if (!a) return;
      a.time = 0; a.apply(Math.min(1, weight));
    };
    if (w < 1) stamp(mv.prev, 1 - w);
    stamp(mv.cur, w > 0 ? w : 1);
  }
  /* write "base + delta"; base is whatever the state machine left there this frame */
  apply(frame) {
    const c = frame.ch;
    for (const n in this.ch) {
      const k = this.ch[n], cur = k.o.rotation;
      if (!(k.last !== null && cur === k.last)) k.base = cur;
      k.o.rotation = k.base + (c[n] || 0); k.last = k.o.rotation;        // read back: the runtime stores float32
    }
    // Vertical bookkeeping: hips.y = torso only (feet ride along, legs stay straight), squat = hips down with the
    // feet planted (knees bend), air = everything up (a jump). Down is +y.
    const hy = c['hips.y'] || 0, squat = c.squat || 0, air = c.air || 0, torso = !!this.nd.hips;
    for (const n in this.nd) {
      const k = this.nd[n], cx = k.o.x, cy = k.o.y;
      if (!(k.lx !== null && cx === k.lx)) k.bx = cx;
      if (!(k.ly !== null && cy === k.ly)) k.by = cy;
      const dy = n === 'hips' ? hy + squat - air : (c[n + '.y'] || 0) + (torso ? hy - air : 0);
      k.o.x = k.bx + (c[n + '.x'] || 0); k.o.y = k.by + dy; k.lx = k.o.x; k.ly = k.o.y;
    }
  }
}

return { Orchestra, RigDriver, Motor, OU, GESTURES, JOINTS, NODE_CH, ARM_JOINTS, LEG_JOINTS, DEFAULT_POSES, VISEME_ANIMS,
  math: { clamp, lerp, wrapPi, minJerk, softLimit, deadzone, springStep, quintic, quinticEval, solveArm2, makeRng, detectBeats, energyFromVisemes, D2R } };
});

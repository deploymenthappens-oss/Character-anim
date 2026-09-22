// Headless check of the leg rig + Orchestra leg gestures against the real avatar.riv (no browser needed).
//   node tools/legs-check.mjs            -> table of every leg gesture (pops, planting, knee flare, return to rest)
//   node tools/legs-check.mjs --dump     -> also writes /tmp/legs-frames.json (joint positions per frame, for plotting)
// It stubs the tiny bit of DOM the Rive wasm loader touches; nothing is drawn.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'; import { createRequire } from 'module';
const here = path.dirname(fileURLToPath(import.meta.url)), web = path.join(here, '..', 'web'), require = createRequire(import.meta.url);
globalThis.document = { createElement: () => ({ getContext: () => null, addEventListener() {}, style: {}, getBoundingClientRect() { return {}; } }), body: { appendChild() {}, removeChild() {} }, currentScript: null };
const log0 = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('No WebGL')) log0(...a); };
const RiveCanvas = (await import(path.join(web, 'vendor/canvas_advanced.mjs'))).default;
const rt = await RiveCanvas({ wasmBinary: fs.readFileSync(path.join(web, 'vendor/rive.wasm')), locateFile: f => path.join(web, 'vendor', f) });
const Orch = require(path.join(web, 'avatar-orchestra.js'));
const file = await rt.load(new Uint8Array(fs.readFileSync(path.join(web, 'avatar.riv'))));

function makeRig() {
  const ab = file.artboardByName('screen') || file.defaultArtboard();
  ab.height = 905;
  const sm = new rt.StateMachineInstance(ab.stateMachineByName('State Machine_call'), ab);
  sm.advanceAndApply(0); ab.advance(0);
  const notes = []; const drv = new Orch.RigDriver(rt, ab, { log: m => notes.push(m) }); drv.bind();
  const orch = new Orch.Orchestra({ geometry: drv, seed: 7, life: false });
  const W = n => { const m = ab.transformComponent(n).worldTransform(); return { x: m.tx, y: m.ty, a: Math.atan2(m.xy, m.xx) }; };
  const T1 = 87.48;
  const snap = () => {
    const o = { head: W('head'), hips: W('hips') };
    for (const s of ['R', 'L']) { const th = W('thigh_' + s), ft = W('foot_' + s);
      o['hip' + s] = { x: th.x, y: th.y }; o['knee' + s] = { x: th.x + T1 * Math.cos(th.a), y: th.y + T1 * Math.sin(th.a) }; o['ankle' + s] = { x: ft.x, y: ft.y };
      const tip = W('IK_' + s); o['toe' + s] = { x: tip.x, y: tip.y }; }
    return o;
  };
  drv.pin = true;
  const step = dt => { sm.advanceAndApply(dt); const fr = orch.step(dt); drv.applyPoses(fr.ch); drv.apply(fr); drv.pinRoot(); ab.advance(dt); return fr; };
  return { ab, drv, orch, notes, snap, step };
}
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const out = {}, dump = process.argv.includes('--dump');
const probe = makeRig();
console.log('driver notes:', probe.notes.length ? probe.notes.join(' | ') : '(none - hips, IK_R, IK_L all bound)', '| legsOk', probe.drv.legsOk, 'hipsOk', probe.drv.hipsOk);
for (let i = 0; i < 30; i++) probe.step(1 / 60);
const rest = probe.snap();
console.log('rest: ankleL', rest.ankleL.y.toFixed(1), 'ankleR', rest.ankleR.y.toFixed(1), '| hip->ankle', d(rest.hipR, rest.ankleR).toFixed(1), '(thigh+shin ~ 172.9)');

const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
const list = names.length ? names : ['footTap', 'weightShift', 'bounce', 'hop', 'jump', 'march', 'kick', 'stomp', 'dance', 'celebrate', 'surprise', 'fidgetFoot', 'fidgetTap'];
console.log('\ngesture      frames  maxAnkleStep  minAnkleY  maxKneeOut  maxAir  maxSquat  residual  NaN');
for (const g of list) for (const side of (Orch.GESTURES[g] && Orch.GESTURES[g].leg === 'R') ? ['R', 'L'] : ['R']) {
  const r = makeRig(); for (let i = 0; i < 30; i++) r.step(1 / 60);
  const base = r.snap(); r.orch.cue(g, { side, speed: 1, force: true });
  const dur = Orch.GESTURES[g].dur + 1.2, N = Math.round(dur * 60), frames = [];
  let prev = base, maxStep = 0, minY = 1e9, knee = 0, air = 0, sq = 0, nan = false;
  for (let i = 0; i < N; i++) {
    const fr = r.step(1 / 60), s = r.snap(); frames.push(s);
    for (const k in s) if (!Number.isFinite(s[k].x) || !Number.isFinite(s[k].y)) nan = true;
    for (const k of ['ankleR', 'ankleL']) { maxStep = Math.max(maxStep, d(s[k], prev[k])); minY = Math.min(minY, s[k].y); }
    knee = Math.max(knee, Math.abs(s.kneeR.x - base.kneeR.x), Math.abs(s.kneeL.x - base.kneeL.x));
    air = Math.max(air, fr.ch.air); sq = Math.max(sq, fr.ch.squat); prev = s;
  }
  const end = frames[frames.length - 1], res = Math.max(d(end.ankleR, base.ankleR), d(end.ankleL, base.ankleL), d(end.head, base.head));
  console.log((g + (side === 'L' ? ' (L)' : '')).padEnd(13), String(N).padEnd(7), maxStep.toFixed(2).padEnd(13), minY.toFixed(1).padEnd(10), knee.toFixed(1).padEnd(11), air.toFixed(1).padEnd(7), sq.toFixed(1).padEnd(9), res.toFixed(2).padEnd(9), nan ? 'YES' : 'no');
  out[g + (side === 'L' ? '_L' : '')] = frames;
}
// ambient: 90 s of idle life, everything the legs do on their own
const r = makeRig(); r.orch.setLife(true); for (let i = 0; i < 30; i++) r.step(1 / 60);
const base = r.snap(); let kneeMax = 0, ankleMax = 0, fired = 0; const oc = r.orch.cue.bind(r.orch); r.orch.cue = (n, o) => { if (/^fidget|weightShift/.test(n)) fired++; return oc(n, o); };
for (let i = 0; i < 90 * 60; i++) { r.step(1 / 60); const s = r.snap(); kneeMax = Math.max(kneeMax, Math.abs(s.kneeR.x - base.kneeR.x), Math.abs(s.kneeL.x - base.kneeL.x)); ankleMax = Math.max(ankleMax, d(s.ankleR, base.ankleR), d(s.ankleL, base.ankleL)); }
console.log('\nidle life, 90 s: leg fidgets cued', fired, '| max knee shift', kneeMax.toFixed(1), '| max ankle shift', ankleMax.toFixed(1));
if (dump) { fs.writeFileSync('/tmp/legs-frames.json', JSON.stringify({ rest, out })); console.log('wrote /tmp/legs-frames.json'); }

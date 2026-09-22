/*
 * Avatar helpers (classic script, exposes window.AvatarRig / window.Speaker)
 *
 * Uses Rive's low-level ("advanced") canvas API (vendor/canvas_advanced.mjs + vendor/rive.wasm)
 * because it lets us drive named nodes and animations from code, which the simple wrapper cannot.
 *
 * State machine "State Machine_call" (used only for the mouth and the idle loop):
 *   Lipsync (number)  0 = rest, 1 A,E,I | 2 L | 3 Q,W | 4 TH | 5 N | 6 C,D,G,K,R,S,T... |
 *                     7 B,M,P | 8 F,V | 9 EE | 10 O | 11 U | 12 Ch,J,Sh
 *   The state machine's own "talk" trigger is NOT used any more: it plays the whole 14 s "action"
 *   animation (head tilt, then a look-up at ~4-5.5 s, eye wanders, a wink) and cannot be stopped smoothly.
 *
 * Movement is layered on top of the state machine, every frame, AFTER it has applied idle + lip-sync:
 *   1. gesture: the first ~3 s of the rig's "action" animation (head tilt + small arm shift, no look-up),
 *      blended in, then rewound smoothly to the rest pose when it ends or when speech ends.
 *   2. wave: forward kinematics on the right arm's three bones (shoulder_R = upper arm, arm_R = forearm,
 *      hand_R = hand). avatar.riv is patched so the right-hand IK constraint has strength 0: with the IK on, the
 *      solver always overrode the bones and chose an unnatural elbow. Angles are world angles in degrees.
 *
 * Who owns a movement decides who may stop it:
 *   - started by a reply ("speech"): stopped when the last reply finishes (rig.stopSpeechMotion()).
 *   - started by an incoming comment ("comment"): plays out its own ~2.7 s and is not cut by speech ending.
 */
(function () {
  'use strict';

  // ---------- text -> visemes ----------
  // Viseme ids match the rig's own grouping (see the class comment above): 0 rest, 1 A/E/I, 2 L, 3 Q/W,
  // 4 TH, 5 N, 6 hard consonants, 7 B/M/P, 8 F/V, 9 EE, 10 O, 11 U, 12 Ch/J/Sh. -1 is a *pause* marker
  // (closed/rest mouth held for a deliberate stretch, e.g. across a comma or period) - visemeAt() below
  // turns it into 0 same as silence, but it carries its own weight instead of just vanishing between
  // two letters, so the mouth actually closes at punctuation instead of coasting on whatever letter
  // came right before it.
  const EN_DIGRAPHS = { th: 4, ch: 12, sh: 12, ph: 8, ee: 9, ea: 9, ie: 9, oo: 11, ou: 11, ow: 11, oa: 10, oi: 10, oy: 10,
                         qu: 3, ai: 1, ay: 1, ng: 5, ck: 6, wh: 3, augh: 10, ough: 10, eigh: 1, tion: 12, sion: 12, dge: 12 };
  // longer patterns must be tried before their shorter substrings (e.g. "tion" before "ti"/"io")
  const EN_DIGRAPH_KEYS = Object.keys(EN_DIGRAPHS).sort((a, b) => b.length - a.length);
  const EN_SINGLE = { a: 1, e: 1, i: 1, o: 10, u: 11, l: 2, n: 5, w: 3, q: 3, f: 8, v: 8, b: 7, m: 7, p: 7, j: 12,
                      c: 6, d: 6, g: 6, k: 6, r: 6, s: 6, t: 6, x: 6, y: 6, z: 6 };
  const AR = { 'ب': 7, 'م': 7, 'ف': 8, 'و': 3, 'ؤ': 3, 'ا': 1, 'أ': 1, 'إ': 1, 'آ': 1, 'ع': 1, 'ه': 1, 'ح': 1, 'ء': 1, 'ة': 1,
               'ي': 9, 'ى': 9, 'ئ': 9, 'ل': 2, 'ن': 5, 'ش': 12, 'ج': 12, 'ث': 4, 'ذ': 4, 'ظ': 4,
               'ق': 6, 'ك': 6, 'غ': 6, 'خ': 6, 'ر': 6, 'س': 6, 'ز': 6, 'ص': 6, 'ض': 6, 'ط': 6, 'ت': 6, 'د': 6 };
  const isVowel = v => v === 1 || v === 9 || v === 10 || v === 11;
  // Relative HOLD time per viseme class, roughly after published phoneme-duration studies (open vowels
  // and rounded/held vowels run longest; stop-plosives B/M/P are the shortest thing a mouth does; the
  // rest sit in between). This replaces the old flat "vowel = 1.5, consonant = 0.8" guess with something
  // that actually differentiates *which* consonant or vowel it is.
  const HOLD = { 1: 1.5, 2: 1.0, 3: 1.15, 4: 1.05, 5: 0.95, 6: 0.72, 7: 0.62, 8: 0.95, 9: 1.3, 10: 1.5, 11: 1.6, 12: 1.05 };
  // Pause weight by punctuation "strength" - a comma is a short catch, a period/question/exclaim is a
  // full close. Longer runs (\"...\", \"--\") get the strongest close.
  const PAUSE_W = { ',': 0.55, ';': 0.7, ':': 0.7, '.': 1.3, '!': 1.3, '?': 1.4, '\n': 1.6 };

  function textToVisemes(text) {
    const s = String(text).toLowerCase();
    const raw = [];   // {v, hold} in reading order; v === -1 marks an explicit pause
    for (let i = 0; i < s.length;) {
      let matched = false;
      for (const k of EN_DIGRAPH_KEYS) {
        if (s.startsWith(k, i)) { raw.push({ v: EN_DIGRAPHS[k], hold: HOLD[EN_DIGRAPHS[k]] || 1 }); i += k.length; matched = true; break; }
      }
      if (matched) continue;
      const c = s[i];
      if (PAUSE_W[c] !== undefined) { raw.push({ v: -1, hold: PAUSE_W[c] }); i++; continue; }
      const v = EN_SINGLE[c] !== undefined ? EN_SINGLE[c] : AR[c];
      if (v !== undefined) raw.push({ v, hold: HOLD[v] || 1 });
      i++;
    }
    const seq = [];
    for (const e of raw) {
      const w = e.hold * (isVowel(e.v) ? 1 : 0.75);   // consonant clusters still move a little quicker than vowels
      if (seq.length && seq[seq.length - 1].v === e.v) seq[seq.length - 1].w += w * 0.5;   // repeats/doubled letters just extend the same shape
      else seq.push({ v: e.v, w });
    }
    return seq;
  }

  // ---------- audio -> "is the voice making sound at time t?" plus a stress-aware effective clock ----------
  function analyzeVoicing(data, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate * 0.01));
    const n = Math.floor(data.length / hop);
    const rms = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < hop; j++) { const x = data[i * hop + j]; sum += x * x; }
      rms[i] = Math.sqrt(sum / hop);
      if (rms[i] > max) max = rms[i];
    }
    const thr = Math.max(0.004, max * 0.06);
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) voiced[i] = rms[i] > thr ? 1 : 0;
    for (let i = 0; i < n;) {
      if (voiced[i]) { i++; continue; }
      let j = i; while (j < n && !voiced[j]) j++;
      if (i > 0 && j < n && j - i < 4) voiced.fill(1, i, j);
      i = j;
    }
    // Effective ("perceptual") clock: every voiced frame advances it, but a LOUD frame - almost always
    // the open, stressed part of a syllable - advances it a bit less than a quiet one. A flat count-of-
    // voiced-frames clock (the old behaviour) implicitly assumes every letter takes the same slice of
    // real audio time no matter how it was actually spoken; weighting by energy lets the mapping track
    // genuine emphasis instead - the mouth lingers on a stressed vowel instead of racing through it at
    // the same rate as the syllable next to it. This is a real, cheap DSP signal to lean on; it is not a
    // substitute for a true forced phoneme aligner (which would need timestamps from the TTS engine
    // itself - espeak-ng's WAV output here carries none), so it improves *where the emphasis lands*
    // rather than guaranteeing every consonant burst is frame-accurate.
    const cum = new Float32Array(n + 1);
    const LINGER = 0.35;                                   // 0 = old flat clock, 1 = fully proportional to loudness
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + voiced[i] * (1 - LINGER * (max > 0 ? rms[i] / max : 0));
    return { voiced, cum, n, total: cum[n], rms, rate: Math.round(1 / 0.01) };   // rms/rate: real speech envelope, for Orchestra's beat detection
  }

  // ---------- lip-sync plan: prefers the rich word-aligned Arabic/English engine (web/lipsync.js) ----------
  // window.Lipsync (loaded before this script) knows every Arabic letter's real place of articulation
  // plus MSA/Egyptian dialect differences, and - when the server handed back Edge TTS's word timestamps
  // (opts.words) - aligns each mouth shape to the actual word instead of just the text's overall length.
  // Falls back to the smaller built-in table above if lipsync.js didn't load or throws, so a reply is
  // never left mouth-frozen because of it.
  let AR_DIALECT = 'egy';   // updated live from the server's /events "history" (voice.dialect)
  function makePlan(text, audioBuffer, opts) {
    opts = opts || {};
    if (window.Lipsync) {
      try { return window.Lipsync.makePlan(text, audioBuffer, { words: opts.words || null, dialect: opts.dialect || AR_DIALECT }); }
      catch (e) { console.warn('Lipsync.makePlan failed, falling back to the built-in mapper:', e.message); }
    }
    const seq = textToVisemes(text);
    const a = analyzeVoicing(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
    const cumW = []; let W = 0;
    for (const e of seq) { W += e.w; cumW.push(W); }
    return {
      visemeAt(t) {
        if (!seq.length || !a.total) return 0;
        const i = Math.floor(t * 100);
        if (i < 0 || i >= a.n || !a.voiced[i]) return 0;
        const target = ((a.cum[i] + 0.5) / a.total) * W;
        let lo = 0, hi = cumW.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cumW[mid] < target) lo = mid + 1; else hi = mid; }
        const v = seq[lo].v;
        return v < 0 ? 0 : v;   // an explicit pause marker still just closes the mouth (id 0)
      },
      env: a.rms, rate: a.rate,   // handed to Orchestra.speak() so its gesture beats land on the real stressed syllables
    };
  }


  // ---------- Rive wrapper (low-level / advanced API) ----------
  // Wave = joint angles of the right arm (world angles in degrees, y points down on screen:
  // 0 = right, 90 = down, 180 or -180 = left, -90 = up).
  //   pose   : the raised pose. upper -180 = upper arm straight out to the side; fore -90 = forearm vertical
  //            (below -90 tilts the hand outward, away from the face); hand = orientation of the hand bone.
  //   swing  : side-to-side swing in degrees. The hand bone is a child of the forearm, so its swing adds to the forearm's.
  //   lag    : seconds the wrist trails the forearm (wrist "flick").
  //   stagger: fraction of the raise each joint waits before it starts (shoulder first, wrist last; reversed on lowering).
  const WAVE = {
    pose: { upper: -197, fore: -150, hand: -141 },
    swing: { upper: 4.5, fore: 16, hand: 19 },
    freq: 2.1,                         // swings per second
    lag: 0.06,
    raise: 0.5, hold: 0.8, lower: 0.65, stop: 0.4,   // seconds
    stagger: { upper: 0, fore: 0.12, hand: 0.17 },
  };
  const DEFAULT_WAVE = JSON.parse(JSON.stringify(WAVE));
  const RAD = Math.PI / 180;
  const clamp01 = k => Math.max(0, Math.min(1, k));
  const minJerk = k => k * k * k * (10 - 15 * k + 6 * k * k);          // smooth start and stop, bell-shaped speed
  const wrapPi = d => Math.atan2(Math.sin(d), Math.cos(d));            // shortest signed angle
  const lerpAngle = (a, b, k) => a + wrapPi(b - a) * k;
  // Gesture = the start of the "action" animation. `to` is how many seconds of it are played (the look-up
  // starts at ~4 s, so keep this below that). rewind = seconds to return to the rest pose, settle = final fade.
  // speakCap: "action" is a full-artboard clip - whatever mouth shape the artist happened to key into it
  // rides along with the head-tilt/arm-shift we actually want, and since this clip's own blend weight
  // (w0 below) is what gesture() ramps to nearly 1.0 within blendIn seconds, at full weight it can crowd
  // out the state machine's own Lipsync-driven mouth shape for as long as the gesture is playing. Because
  // gesture() fires on every single reply, that reads as "the mouth doesn't move while it talks/waves".
  // Capping the weight while actually speaking leaves headroom for the real lipsync value to still show
  // through the blend; it does not touch it at all outside of speech (comment-only gestures stay full-strength).
  const GESTURE = { anim: 'action', to: 2.6, blendIn: 0.35, rewind: 0.5, settle: 0.15, speakCap: 0.55 };
  // How long the wave/gesture gets to lead before the voice actually starts. In life you see someone's
  // hand start to rise a beat before "hi" leaves their mouth - the motion is what makes the words feel
  // caused, not coincidental. Applied only when a reply actually triggers a gesture/wave; a bare reply
  // with no motion starts talking immediately so replies never feel sluggish.
  const SPEECH_PREROLL = 0.32;
  // "Lean-in": not a bone gesture - the avatar's own overlay box grows and the background behind it
  // softens for a couple of seconds, and the eyes look straight at the viewer instead of wandering,
  // the way a presenter leans toward camera for a secret code or a personal answer. publish.html reads
  // rig.leanAmount (0..1) each frame to scale/blur the picture; nothing here touches bones.
  //   scale : how much bigger the avatar box gets at full lean (0.28 = 28% larger)
  //   blur  : background blur in px at full lean
  //   raise/hold/lower : seconds to lean in, stay, and ease back
  const LEAN = { scale: 0.4, blur: 6, raise: 0.6, hold: 3.0, lower: 0.9 };   // slower ease = more cinematic
  const DEFAULT_LEAN = JSON.parse(JSON.stringify(LEAN));
  // Empty room around the artboard, as a fraction of its own width/height, so nothing the character does
  // is cut off by the canvas edge: a raised arm, a pointing arm held out to the side, a celebrate, a hand
  // above the head. The canvas keeps its height and grows in width to match, and publish.html scales the
  // whole frame, so a bigger frame shows more of the character's reach, not a bigger character.
  // How much empty margin (as a fraction of the character's body height) to reserve around him at rest,
  // purely so a gesture's arm-swing has room before the frame needs to grow. Kept tight on purpose: the
  // reach-probe below (_growView) already grows the canvas on demand the first time a gesture actually
  // needs more room, so there's no need to permanently reserve a huge empty margin just in case - that
  // was the #1 cause of the character looking small / not filling the box at rest.
  const VIEW = { padLeft: 0.23, padRight: 0.23, padTop: 0.16, padBottom: 0.03 };
  // Legs. In avatar.riv the artboard ends at y = 765, about mid-thigh: hips sit at y ~ 703, the knees at ~ 775 and the
  // shoes at ~ 860-885 hang BELOW it. Two things hid them: (1) the canvas view stopped at the artboard's bottom edge, and
  // (2) the whole character sits under a clipping mask - the rectangle of the shape named "screen", 555 x 741 units, whose
  // bottom edge is at y = 764.5. (2) is fixed inside web/avatar.riv itself (that rectangle is now 892 tall, bottom at 915);
  // (1) is fixed here: the artboard is grown downward at load (its origin is the top-left corner, so nothing moves).
  //   height : new artboard height, in artboard units (must cover the shoes; 905 leaves ~20 units below the soles)
  //   sole   : where the bottom of the shoes is, so the stage can stand the character on a floor line + shadow
  //   bones  : only extended if the rig really has these leg bones (so another .riv is left alone)
  //   enabled: false = old behaviour (legs cut off at the artboard edge)
  // The clipping mask that hides the legs is one rectangle inside avatar.riv (shape "screen", child path "Path"):
  // y = 0.75, width 555.5, height 741.5 (bottom edge y = 764.5). The v5.1+ avatar.riv has it at y = 76, height 892
  // (bottom edge y = 915). If the server hands out an OLDER avatar.riv (cached / not redeployed / a stale copy), the same
  // 10 bytes are rewritten in memory before the file is loaded, so the legs show either way.
  const LEG_MASK_OLD = [0x0d, 0x00, 0x00, 0x80, 0xbe, 0x0e, 0x00, 0x00, 0x40, 0x3f, 0x14, 0x00, 0xe0, 0x0a, 0x44, 0x15, 0x00, 0x60, 0x39, 0x44];
  const LEG_MASK_NEW = [0x0d, 0x00, 0x00, 0x80, 0xbe, 0x0e, 0x00, 0x00, 0x98, 0x42, 0x14, 0x00, 0xe0, 0x0a, 0x44, 0x15, 0x00, 0x00, 0x5f, 0x44];
  function findBytes(hay, needle) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; }
    return -1;
  }
  function patchLegMask(bytes) {
    if (findBytes(bytes, LEG_MASK_NEW) >= 0) return 'already';
    const i = findBytes(bytes, LEG_MASK_OLD);
    if (i < 0) return 'not-found';
    for (let j = 0; j < LEG_MASK_NEW.length; j++) bytes[i + j] = LEG_MASK_NEW[j];
    return 'patched-in-memory';
  }
  const LEGS = { enabled: true, height: 905, sole: 884, bones: ['thigh_L', 'thigh_R', 'foot_L', 'foot_R'] };
  // Pointing at the mouse. Angles are WORLD angles of the right arm in degrees, but written in the
  // 0-360 convention that is easiest to picture here: 90 = arm straight down, 180 = straight out to the
  // side, 270 = straight up. (Internally they are the same angles the wave uses; -182 there is 178 here.)
  //   pivot  : where the character's shoulder sits in the page, in normalized coordinates
  //            (-1 = left/top edge, +1 = right/bottom edge). The direction to point is measured from it.
  //   range  : how far the arm is allowed to swing. A target outside it is clamped to the nearest end.
  //   elbow  : degrees the upper arm sits behind the forearm, so the arm is not a dead straight stick.
  //   follow : seconds of smoothing; the hand eases toward the cursor instead of snapping to it.
  //   raise / drop : seconds to lift the arm into the point and to put it back down at rest.
  //   idle   : seconds without any cursor movement after which the arm goes back down by itself.
  const POINT = {
    pivot: { x: -0.12, y: -0.05 },
    range: { min: 62, max: 288 },
    elbow: 17, wrist: 7,
    follow: 0.22, raise: 0.5, drop: 0.55, idle: 8,
  };
  const DEFAULT_POINT = JSON.parse(JSON.stringify(POINT));
  // The synthesized voice, shaped in the browser before it goes into the stream. espeak-ng is thin and
  // buzzy; this makes it warmer and, above all, clearly audible next to the microphone.
  //   gain     : how much louder than the raw file (1 = unchanged)
  //   warmth   : low-shelf lift under 250 Hz, in dB (body of the voice)
  //   presence : lift around 2.6 kHz, in dB (consonants: makes the words obvious)
  //   edge     : cut around 4.2 kHz, in dB (takes the metallic rasp off)
  //   compress : even out loud and quiet parts, so nothing is lost under the microphone
  const VOICE = { gain: 1.9, warmth: 5, presence: 3.5, edge: -4.5, hpf: 85, lpf: 7600, compress: true, filter: true };
  const DEFAULT_VOICE = JSON.parse(JSON.stringify(VOICE));
  const VERSION = 'motion v7.3 (energy + camera parallax)';

  // Cheap, one-time device read - no benchmark, just the signals a browser actually exposes.
  // `lite` means "skip the purely-cosmetic Orchestra layers and cap their update rate"; it is
  // deliberately conservative (a false positive just means a capable phone stays at full quality).
  function detectPerfTier() {
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const ua = navigator.userAgent || '';
    const mobile = coarse || /Android|iPhone|iPad|iPod/i.test(ua);
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory;              // undefined on iOS Safari/Firefox - only count it when present
    const saveData = !!(navigator.connection && navigator.connection.saveData);
    const lite = mobile && (cores <= 4 || (mem !== undefined && mem <= 4) || saveData);
    return { mobile, lite };
  }
  const ease = k => k * k * (3 - 2 * k);
  const deg = r => r * 180 / Math.PI;
  // Shortest way to put an angle (deg) inside [lo,hi]: try it a turn down and a turn up as well.
  function nearestInRange(a, lo, hi) {
    let best = null, bestD = Infinity;
    for (const c of [a - 360, a, a + 360]) {
      const d = c < lo ? lo - c : c > hi ? c - hi : 0;
      if (d < bestD) { bestD = d; best = Math.max(lo, Math.min(hi, c)); }
    }
    return best;
  }

  class AvatarRig {
    constructor({ canvas, src = 'avatar.riv', stateMachine = 'State Machine_call', artboard = 'Artboard' }) {
      this.canvas = canvas; this.src = src; this.smName = stateMachine; this.abName = artboard;
      this.ready = false; this.current = 0;
      this.bodyState = 'idle';          // 'idle' | 'gesture' (read by tests / UI)
      this._wave = null; this._gest = null; this._lastTime = 0; this._clock = 0;
      this._point = null; this.pointOn = false; this.lookOn = true;
      this._lean = null; this.leanAmount = 0;
      this.speaking = false;
      this.version = VERSION;
    }

    // Called by Speaker around each utterance so gesture() knows to cap its blend weight (see GESTURE.speakCap).
    setSpeaking(v) {
      v = !!v;
      // The instant speech actually stops, force the "lean in" back out - regardless of whether the
      // cinematic-camera bookkeeping (publish.html) happens to notice in the same frame. Leaning in zooms
      // the frame and pushes the legs out of shot on purpose while talking (that part is fine/intended);
      // this was the fix for the legs then staying hidden "forever" - the zoom-out had no guaranteed
      // trigger of its own before, only a best-effort one tied to the camera-shot picker.
      if (this.speaking && !v) this.stopLean();
      this.speaking = v;
    }

    async load() {
      let RiveCanvas;
      try {
        ({ default: RiveCanvas } = await import('./vendor/canvas_advanced.mjs'));
      } catch (e) {
        throw new Error('Rive runtime (vendor/canvas_advanced.mjs) did not load: ' + e.message);
      }
      // the module asks for its own .wasm name; always serve the bundled rive.wasm
      this.riveRT = await RiveCanvas({ locateFile: f => f.endsWith('.wasm') ? 'vendor/rive.wasm' : 'vendor/' + f });

      // cache-busted: a stale avatar.riv (from before the legs fix) is the #1 reason the legs stay hidden
      const res = await fetch(this.src + (this.src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(VERSION) + '.' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load ' + this.src + ': HTTP ' + res.status);
      const rivBytes = new Uint8Array(await res.arrayBuffer());
      this.rivPatch = LEGS.enabled ? patchLegMask(rivBytes) : 'disabled';   // 'already' | 'patched-in-memory' | 'not-found' | 'disabled'
      if (this.rivPatch === 'patched-in-memory') console.warn('avatar.riv on the server still has the OLD legs mask - patched in memory so the legs show anyway. Copy web/avatar.riv from the v5.1+ zip over the server copy to make it permanent.');
      this.file = await this.riveRT.load(rivBytes);
      this.artboard = this.file.artboardByName(this.abName) || this.file.defaultArtboard();
      // The canvas shows the artboard plus VIEW.padLeft/padRight units of empty space (transparent), so its
      // width follows from its height. publish.html reads canvas.width/height, so it adapts by itself.
      this.baseHeight = this.artboard.bounds.maxY;           // artboard height as authored (waist/bust crops are measured on it)
      this.legsShown = false;
      if (LEGS.enabled && this.artboard.height < LEGS.height && LEGS.bones.every(n => { try { return !!this.artboard.transformComponent(n); } catch (e) { return false; } })) {
        try { this.artboard.height = LEGS.height; this.artboard.advance(0); this.legsShown = this.artboard.bounds.maxY >= LEGS.height - 1; }
        catch (e) { console.warn('could not extend the artboard to show the legs: ' + e.message); }
      }
      const bd = this.artboard.bounds;
      const bw = bd.maxX - bd.minX, bh = bd.maxY - bd.minY;
      const bh0 = this.baseHeight - bd.minY;                  // pads are measured on the authored height, so a taller artboard adds legs, not headroom
      // keep the character just as sharp: the canvas grows with the artboard
      if (this.legsShown) this.canvas.height = Math.round(this.canvas.height * bh / bh0);
      const pad = p => (Math.abs(p) <= 3 ? p : p / bw);      // <=3 is read as a fraction, bigger as old-style units
      this._view = {
        minX: bd.minX - bw * pad(VIEW.padLeft), maxX: bd.maxX + bw * pad(VIEW.padRight),
        minY: bd.minY - bh0 * (Math.abs(VIEW.padTop) <= 3 ? VIEW.padTop : VIEW.padTop / bh0),
        maxY: bd.maxY + bh0 * (Math.abs(VIEW.padBottom) <= 3 ? VIEW.padBottom : VIEW.padBottom / bh0),
      };
      this.canvas.width = Math.round(this.canvas.height * (this._view.maxX - this._view.minX) / (this._view.maxY - this._view.minY));
      // where the character sits INSIDE the canvas (fractions) - publish.html uses it to truly centre it / crop it
      const vw_ = this._view.maxX - this._view.minX, vh_ = this._view.maxY - this._view.minY;
      this.frac = { cx: ((bd.minX + bd.maxX) / 2 - this._view.minX) / vw_, top: (bd.minY - this._view.minY) / vh_,
                    bottom: (bd.maxY - this._view.minY) / vh_, base: (this.baseHeight - this._view.minY) / vh_,
                    sole: ((this.legsShown ? LEGS.sole : bd.maxY) - this._view.minY) / vh_, left: (bd.minX - this._view.minX) / vw_, right: (bd.maxX - this._view.minX) / vw_ };
      this.frac.at = y => (y - this._view.minY) / vh_;         // artboard y (units) -> fraction of the canvas height
      this.legsClipped = null;                                 // null = not checked yet, true = legs are being cut off by the .riv, false = legs are drawn
      this._legTry = 0;
      this.unitPx = this.canvas.height / vh_;                 // canvas pixels per artboard unit (publish.html scales the jump shadow with it)
      this.renderer = this.riveRT.makeRenderer(this.canvas);
      this.smDef = this.artboard.stateMachineByName(this.smName);
      if (!this.smDef) throw new Error('State machine "' + this.smName + '" not found');
      this.sm = new this.riveRT.StateMachineInstance(this.smDef, this.artboard);
      // Any OTHER number input this .riv happens to expose (this rig currently ships only "Lipsync" -
      // there is no ViewModel/Data Binding authored in it yet, so nothing else shows up here today).
      // If/when one is added in the Rive Editor (a "Energy" or "Mood" number driving a blend state
      // directly, GPU-composited, no JS math) setEnergy() below picks it up automatically with no
      // code change here - that's the forward-compatible hook the mobile-perf work wants.
      this.extraInputs = {};
      for (let i = 0; i < this.sm.inputCount(); i++) {
        const inp = this.sm.input(i);
        if (inp.name === 'Lipsync') this.lip = inp.asNumber();      // low-level API: convert before use
        else { try { this.extraInputs[inp.name] = inp.asNumber(); } catch (e) { /* not a number input (bool/trigger) - not ours to drive */ } }
      }
      if (!this.lip) throw new Error('Expected input "Lipsync" not found');
      this.lip.value = this.current;
      if (Object.keys(this.extraInputs).length) console.info('Avatar: extra state-machine number input(s) found: ' + Object.keys(this.extraInputs).join(', ') + ' - setEnergy()/setMood() will drive them directly.');

      // ---- mobile performance tier ----------------------------------------------------------
      // Everything Orchestra computes (breathing, sway, gaze, secondary spring-lag...) is CPU-side
      // JS math, run every frame, regardless of how it eventually gets onto the rig - there is no
      // "GPU blend" path for it because this .riv has no state-machine blend tree to hand it to (see
      // the note above). On a lower-power phone that's real, measurable per-frame cost. Two cheap,
      // safe-by-construction levers instead of a rewrite:
      //   1. drop layers that are pure secondary polish (arm-lag spring, center-of-mass hip drift) -
      //      you can't visually tell they're off, they just cost a spring/OU step per frame.
      //   2. cap Orchestra's own update rate on lite devices (still draws every rAF; the values it
      //      computed simply persist between steps, same trick real engines use for expensive systems).
      // Neither touches lip-sync, gaze, blink, breathing, or gestures - only the ambient "flavor" layers.
      this.perf = detectPerfTier();
      this._orchHz = this.perf.lite ? 30 : 0;   // 0 = step every frame (desktop / capable phones)
      this._orchAcc = 0; this._orchFrame = null;

      this.gestAnim = this.artboard.animationByName(GESTURE.anim);
      if (!this.gestAnim) console.warn('animation "' + GESTURE.anim + '" not found - gesture() will do nothing');

      // Right arm bones (forward kinematics). Their resting rotations are captured once: idle never animates them.
      this._arm = null; this.fkOk = false;
      try {
        const t = n => this.artboard.transformComponent(n);
        const arm = { sh: t('shoulder_R'), fo: t('arm_R'), ha: t('hand_R'), chest: t('chest') };
        if (arm.sh && arm.fo && arm.ha && arm.chest) {
          this.sm.advanceAndApply(0); this.artboard.advance(0);
          arm.rest = { sh: arm.sh.rotation, fo: arm.fo.rotation, ha: arm.ha.rotation };
          this._arm = arm;
          // The bones only obey their rotation if the IK constraint on this arm is off (patched avatar.riv).
          const ang = () => { const m = arm.sh.worldTransform(); return Math.atan2(m.xy, m.xx); };
          const before = ang();
          arm.sh.rotation = arm.rest.sh + 0.5; this.artboard.advance(0);
          this.fkOk = Math.abs(wrapPi(ang() - before)) > 0.4;
          arm.sh.rotation = arm.rest.sh; this.artboard.advance(0);
        }
      } catch (e) { console.warn('arm bones not available: ' + e.message); }
      if (!this.fkOk) console.warn('Right-arm IK is still active (old avatar.riv?) - wave() is disabled. Use the avatar.riv from the v5 zip.');

      // Orchestra (avatar-orchestra.js, optional): ambient breathing/sway/gaze/blink + speech-timed body
      // language, written as small deltas *on top of* whatever the state machine + legacy gesture/wave
      // already set this frame. It never overrides the legacy wave/gesture bones outright: apply() reads
      // back whatever rotation is currently on a bone as its "base", so when the legacy code writes an
      // absolute rotation later in the same frame it simply wins. Missing bones/animations (this rig has
      // no per-viseme clips, no hips/IK node offsets) are skipped by RigDriver, not fatal.
      this.orchestra = null; this.orchestraDriver = null;
      if (window.Orchestra) {
        try {
          this.sm.advanceAndApply(0); this.artboard.advance(0);   // RigDriver.bind() requires this to have run at least once
          const missing = [];
          this.orchestraDriver = new window.Orchestra.RigDriver(this.riveRT, this.artboard, { log: m => missing.push(m) });
          this.orchestraDriver.bind();
          this._bindHair();
          this.orchestra = new window.Orchestra.Orchestra({ geometry: this.orchestraDriver, seed: (Date.now() >>> 0) });
          if (this.perf.lite) { this.orchestra.enable('secondary', false); this.orchestra.enable('com', false); }   // see "mobile performance tier" above
          if (missing.length) console.info('Orchestra: using whatever rig channels exist (' + missing.length + ' not in this .riv).');
        } catch (e) { console.warn('Orchestra disabled: ' + e.message); this.orchestra = null; this.orchestraDriver = null; }
      }
      // If this rig ships the named per-viseme clips ('A,E,I', 'L', ...) as top-level animations, drive
      // the mouth directly through them (crossfaded, see RigDriver.applyViseme) instead of the state
      // machine's own coarse "Lipsync" number blend - it gives us the actual per-letter/per-sound timing
      // and smoothing described above, and, being applied dead last every frame, nothing else (gesture,
      // poses) can ever steal the mouth back from it. This rig (per the original comment above) does not
      // ship those clips, so this safely stays off and setViseme() keeps using the Lipsync input, now
      // also protected by GESTURE.speakCap.
      this.mouthDirect = !!(this.orchestraDriver && this.orchestraDriver.hasVisemeClips());
      if (this.mouthDirect) this.lip.value = 0;   // freeze the state machine's own mouth output; ours is authoritative now
      console.info('Avatar mouth driving: ' + (this.mouthDirect ? 'direct per-viseme clips (Orchestra)' : 'state machine Lipsync input'));

      // Reach probe (hand-clipping safety net): the static VIEW padding above is a guess at how far the
      // arm swings; if the real wave/point poses reach further than that guess, the hand gets drawn past
      // the canvas edge and is cut off - looking like it doesn't belong to the character. Actually posing
      // the arm at its known extremes once here and measuring the artboard's real bounds catches that
      // before the first frame is ever drawn, and grows the frame (never shrinks it) to fit. This only
      // covers the two continuous, parametrized arm motions (wave, point-at-cursor); the gesture library's
      // own keyframed poses (present/celebrate/shrug, in avatar-orchestra.js) are not simulated here - watch
      // the console/preview after adding a new one, and raise VIEW.padTop/padLeft/padRight above if needed.
      try { const probe = this._probeReach(); if (probe) this._growViewIfNeeded(probe); }
      catch (e) { console.warn('reach probe failed (falling back to the static VIEW padding): ' + e.message); }

      this.ready = true;
      this._startLoop();
    }

    // Poses the right arm at its wave-apex and both point-at-cursor extremes, measuring the artboard's
    // real bounding box at each, then restores the rest pose. Returns {minX,maxX,minY,maxY} (the union
    // across every pose tried) or null if there is no working arm FK to pose (see this.fkOk).
    _probeReach() {
      if (!this._arm || !this.fkOk) return null;
      const arm = this._arm;
      const rest = { sh: arm.sh.rotation, fo: arm.fo.rotation, ha: arm.ha.rotation };
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const measure = () => {
        this.artboard.advance(0);
        const b = this.artboard.bounds;
        minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
        minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
      };
      try {
        const W = WAVE, cw = arm.chest.worldTransform(), parent = Math.atan2(cw.xy, cw.xx);
        const P = W.pose, S = W.swing;
        const poseU = P.upper * RAD - parent, poseF = (P.fore - P.upper) * RAD, poseH = (P.hand - P.fore) * RAD;
        for (const sgn of [-1, 1]) {                 // both ends of the wave's side-to-side swing
          arm.sh.rotation = poseU + sgn * S.upper * RAD;
          arm.fo.rotation = poseF + sgn * S.fore * RAD;
          arm.ha.rotation = poseH + sgn * S.hand * RAD;
          measure();
        }
        for (const a of [POINT.range.min, POINT.range.max]) { this._probeArmPose(a); measure(); }
      } catch (e) { console.warn('reach probe: could not pose wave/point extremes (' + e.message + ')'); }
      arm.sh.rotation = rest.sh; arm.fo.rotation = rest.fo; arm.ha.rotation = rest.ha;
      this.artboard.advance(0);
      return minX === Infinity ? null : { minX, maxX, minY, maxY };
    }
    // Same forward-kinematics as _applyPoint, at full extension (k=1, no smoothing) toward a fixed world angle.
    _probeArmPose(angleDeg) {
      const arm = this._arm, P = POINT;
      const cw = arm.chest.worldTransform(), parent = Math.atan2(cw.xy, cw.xx);
      const upper = angleDeg - P.elbow, fore = angleDeg, hand = angleDeg + P.wrist;
      let restU = deg(parent + arm.rest.sh) % 360; if (restU < 0) restU += 360;
      arm.sh.rotation = arm.rest.sh + (upper - restU) * RAD;
      arm.fo.rotation = (fore - upper) * RAD;
      arm.ha.rotation = (hand - fore) * RAD;
    }
    // Grows this._view (and the canvas + frac mapping derived from it) to cover a measured bounding box,
    // if the static VIEW padding didn't already. Never shrinks the frame. This is the actual fix for a
    // hand/arm getting cut off at the canvas edge during a wave or a point-at-cursor gesture.
    _growViewIfNeeded(probe) {
      const v = this._view, bd = this.artboard.bounds, bw = bd.maxX - bd.minX, margin = bw * 0.03;
      let changed = false;
      if (probe.minX - margin < v.minX) { v.minX = probe.minX - margin; changed = true; }
      if (probe.maxX + margin > v.maxX) { v.maxX = probe.maxX + margin; changed = true; }
      if (probe.minY - margin < v.minY) { v.minY = probe.minY - margin; changed = true; }
      if (probe.maxY + margin > v.maxY) { v.maxY = probe.maxY + margin; changed = true; }
      if (!changed) { console.info('reach probe: the wave/point extremes fit inside the existing VIEW padding.'); return; }
      const oldW = this.canvas.width;
      this.canvas.width = Math.round(this.canvas.height * (v.maxX - v.minX) / (v.maxY - v.minY));
      const vw_ = v.maxX - v.minX, vh_ = v.maxY - v.minY;
      this.frac = {
        cx: ((bd.minX + bd.maxX) / 2 - v.minX) / vw_, top: (bd.minY - v.minY) / vh_,
        bottom: (bd.maxY - v.minY) / vh_, base: (this.baseHeight - v.minY) / vh_,
        sole: ((this.legsShown ? LEGS.sole : bd.maxY) - v.minY) / vh_, left: (bd.minX - v.minX) / vw_, right: (bd.maxX - v.minX) / vw_,
      };
      this.frac.at = y => (y - v.minY) / vh_;
      this.unitPx = this.canvas.height / vh_;
      console.warn('reach probe: grew the avatar frame (' + oldW + 'px -> ' + this.canvas.width
        + 'px wide) because a wave/point pose reaches past the static VIEW padding - this is the "hand gets '
        + 'cut off" bug. If you still see clipping on a gesture-library pose (present/celebrate/...), raise '
        + 'VIEW.padLeft/padRight/padTop in web/avatar.js by hand.');
    }

    // ---------- mouse interaction ----------
    // Aim the idle gaze (Orchestra only). x,y in [-1,1]; call from a mousemove/touch handler. No-op otherwise.
    lookAt(x, y) { if (this.lookOn && this.orchestra) this.orchestra.lookAt(x, y); }

    // Single-number "energy" knob (0 quiet/low-key .. 1 animated/energetic), the thing this rig's
    // whole ambient-motion system (breathing rate/depth, sway amplitude, blink rate, gesture speed -
    // see the `arousal` reads across avatar-orchestra.js) is already built to take. Two things happen
    // when you call it:
    //   1. Orchestra.setMood({arousal}) - always. This is the real driver today: every ambient layer
    //      already reads `arousal`, so this alone measurably changes how "on" the character feels.
    //   2. any extra state-machine number input this.extraInputs picked up at load (see load()) whose
    //      name looks like energy/mood/intensity also gets written the SAME value. Today that object
    //      is empty (this .riv has none), so this is a no-op - it's the forward-compatible half: add
    //      a number input + blend states to the .riv in the Rive Editor later, and this rig starts
    //      using it with zero code changes, moving that part of the blend from JS math onto Rive's
    //      own GPU-composited state machine.
    // `valence` (-1 sad/negative .. 1 happy/positive) is optional; omit it to leave mood unchanged.
    setEnergy(level, valence) {
      const v = Math.max(0, Math.min(1, level));
      if (this.orchestra) this.orchestra.setMood(valence === undefined ? { arousal: v } : { arousal: v, valence });
      for (const name in this.extraInputs) { if (/energy|arousal|mood|intensity/i.test(name)) { try { this.extraInputs[name].value = v; } catch (e) {} } }
    }
    setLooking(on) { this.lookOn = !!on; }
    // Turn the pointing arm on or off. Off lowers the arm back to rest over POINT.drop seconds.
    setPointing(on) { this.pointOn = !!on; if (this.pointOn) this._pt(); }
    // Where the cursor (or finger) is, in the same [-1,1] page coordinates as lookAt().
    pointAt(x, y) {
      const p = this._pt();
      p.tx = Math.max(-1, Math.min(1, x)); p.ty = Math.max(-1, Math.min(1, y)); p.seen = this._clock;
    }
    // Follow the cursor with both the eyes and the arm in one call.
    trackCursor(x, y) { this.lookAt(x, y); this.pointAt(x, y); }
    get pointingNow() { return !!(this._point && this._point.b > 0.02); }
    _pt() { return this._point || (this._point = { b: 0, ang: null, tx: 0, ty: 0, seen: -1e9, wrote: false }); }

    // The arm is aimed by forward kinematics, exactly like the wave: the direction from the character's
    // shoulder to the cursor becomes a world angle, the three bones are set to it (with a slight elbow
    // bend so it reads as an arm, not a stick), and the whole thing is blended in from - and back to -
    // the rest pose, so the arm is never left hanging in mid-air.
    _applyPoint(dt) {
      const p = this._point;
      if (!p || !this._arm || !this.fkOk) return;
      const P = POINT;
      const fresh = P.idle > 0 ? (this._clock - p.seen) < P.idle : true;
      const want = this.pointOn && fresh && !this._wave ? 1 : 0;      // a wave always takes the arm
      p.b = want ? Math.min(1, p.b + dt / Math.max(0.05, P.raise)) : Math.max(0, p.b - dt / Math.max(0.05, P.drop));
      if (p.b <= 0) { if (p.wrote) { this._restArm(); p.wrote = false; } return; }

      let a = deg(Math.atan2(p.ty - P.pivot.y, p.tx - P.pivot.x));    // 90 = down, 180 = out to the side, 270 = up
      a = ((a % 360) + 360) % 360;
      const lo = Math.min(P.range.min, P.range.max), hi = Math.max(P.range.min, P.range.max);
      const tgt = nearestInRange(a, lo, hi);
      // Both angles are inside the same window, so a plain lerp follows the cursor the short way round
      // the arm's own arc - never the way that would sweep the hand through the body.
      if (p.ang === null) p.ang = tgt;
      else p.ang += (tgt - p.ang) * (1 - Math.exp(-dt / Math.max(0.01, P.follow)));

      const arm = this._arm, k = ease(p.b);
      const cw = arm.chest.worldTransform(), parent = Math.atan2(cw.xy, cw.xx);
      const upper = p.ang - P.elbow, fore = p.ang, hand = p.ang + P.wrist;
      // The upper arm is raised from its resting world angle by the real difference (not the shortest
      // signed angle): the arm lifts out and up the way a shoulder actually moves.
      let restU = deg(parent + arm.rest.sh) % 360; if (restU < 0) restU += 360;
      arm.sh.rotation = arm.rest.sh + (upper - restU) * RAD * k;
      arm.fo.rotation = lerpAngle(arm.rest.fo, (fore - upper) * RAD, k);
      arm.ha.rotation = lerpAngle(arm.rest.ha, (hand - fore) * RAD, k);
      p.wrote = true;
      if (this.orchestra) this.orchestra.hold('R', 8, 0.25);          // keep speech beats off the pointing arm
    }

    _restArm() { const a = this._arm; if (!a) return; a.sh.rotation = a.rest.sh; a.fo.rotation = a.rest.fo; a.ha.rotation = a.rest.ha; }

    // "Lean in": grow the overlay box and center the gaze for LEAN.hold seconds (see the LEAN comment
    // above), then ease back. Call again to restart it (e.g. from the "Lean in" button); it will not
    // stack past 1.0. stopLean() eases it back out early (used by stopMotion()).
    leanCue() {
      if (this._lean && !this._lean.stopping) {
        // Already leaning in: just extend the hold instead of restarting the ease-in from 0. Restarting used
        // to make leanAmount visibly snap back down and re-ramp every time the cinematic camera picked a
        // close-up shot again mid-reply, which is what made it look like it randomly "re-leaned" instead of
        // smoothly staying in.
        if (this._lean.p >= 0.98) { this._lean.t = LEAN.raise; return; }
        return;
      }
      this._lean = { t: 0, p: 0, stopping: false, stopT: 0, fromP: 0 };
    }
    stopLean() { const l = this._lean; if (l && !l.stopping) { l.stopping = true; l.stopT = 0; l.fromP = l.p; } }
    // ---- hair secondary motion: hair bones lag the head with a damped spring (overshoots, settles) ----
    // Bone names come from avatar.riv; any that don't exist are silently skipped (this rig's own lookup,
    // RigDriver._get, is an exact-name match with no enumeration API available at runtime, so this can only
    // try candidate names, not discover unknown ones). k = how strongly each piece lags the head.
    // The list covers the exact names this project's own rig uses (hair/hair1/hair2/bangs/...) plus the
    // common naming variants seen across other Mixamo/VRoid/hand-rigged characters (L/R pairs, capitalized,
    // "_bone" suffixed, ponytail/braid/fringe/twin-tail) so a hair rig named slightly differently than the
    // original still gets driven instead of sitting frozen as a static, separate-looking part.
    _bindHair() {
      const K = {
        hair: 0.55, hair1: 0.7, hair2: 0.85, hair3: 0.9, bangs: 0.45, bang: 0.45,
        hair_front: 0.45, hair_back: 0.8, hair_side: 0.6, hair_tie: 1.0,
        hair_L: 0.6, hair_R: 0.6, hair_L1: 0.7, hair_R1: 0.7, hair_L2: 0.85, hair_R2: 0.85,
        Hair: 0.55, Hair1: 0.7, Hair2: 0.85, Bangs: 0.45,
        bangs_L: 0.45, bangs_R: 0.45, fringe: 0.45, fringe_L: 0.45, fringe_R: 0.45,
        ponytail: 0.8, ponytail1: 0.85, ponytail2: 0.95, braid: 0.8, braid1: 0.85, braid2: 0.95,
        pigtail_L: 0.75, pigtail_R: 0.75, twintail_L: 0.75, twintail_R: 0.75,
        sidehair_L: 0.6, sidehair_R: 0.6, backhair: 0.8, hair_bone: 0.6, hairBone: 0.6,
      };
      this.hair = [];
      const seen = new Set();
      for (const n in K) {
        if (seen.has(n)) continue;
        const o = this.orchestraDriver._get(n);
        if (o && typeof o.rotation === 'number') { seen.add(n); this.hair.push({ n, o, k: K[n], base: o.rotation, wrote: null, ph: Math.random() * 6 }); }
      }
      this._hs = { x: 0, v: 0 }; this._hPrev = 0; this._hT = 0;
      if (this.hair.length) console.info('hair bones driven: ' + this.hair.map(h => h.n).join(', '));
      else console.warn('hair bones: none of the known candidate names exist on this rig, so the hair will stay a '
        + 'static, non-moving part while the head turns. Fix: in the Rive editor, select the hair bone(s), '
        + 'Hierarchy -> right-click -> Export Name, name it (or add its exact name to the K list at the top of '
        + '_bindHair() in web/avatar.js), then redeploy avatar.riv. This cannot be guessed further from code alone.');
    }
    _applyHair(dt) {
      if (!this.hair || !this.hair.length || !this.orchestraDriver) return;
      const c = this.orchestraDriver.ch; this._hT += dt;
      const head = ((c.head && c.head.o.rotation) || 0) + ((c.neck && c.neck.o.rotation) || 0) + ((c.chest && c.chest.o.rotation) || 0);
      const bob = this.orchestraDriver.nd.hips ? (this.orchestraDriver.nd.hips.o.y - this.orchestraDriver.nd.hips.by) * 0.004 : 0;
      const w = 9, z = 0.28, s = this._hs;                    // spring: freq (rad/s), damping ratio (<1 = bouncy)
      const target = head + bob;
      const acc = -2 * z * w * s.v - w * w * (s.x - target); s.v += acc * dt; s.x += s.v * dt;
      const lag = Math.max(-0.5, Math.min(0.5, s.x - target));              // radians the hair is behind the head
      const sway = Math.sin(this._hT * 1.3) * 0.012 + (this.speaking ? Math.sin(this._hT * 6) * 0.01 : 0);
      for (const h of this.hair) {
        const cur = h.o.rotation;
        if (h.wrote === null || Math.abs(cur - h.wrote) > 1e-6) h.base = cur;   // animation rewrote it -> new base
        const v = h.base + h.k * (lag * 1.6 + sway * Math.sin(this._hT + h.ph));
        h.o.rotation = v; h.wrote = v;
      }
    }
    _applyLean(dt) {
      const l = this._lean;
      if (!l) { this.leanAmount = 0; return; }
      const L = LEAN;
      if (l.stopping) {
        l.stopT += dt; l.p = l.fromP * (1 - clamp01(l.stopT / L.lower));
        if (l.stopT >= L.lower) { this._lean = null; this.leanAmount = 0; return; }
      } else {
        l.t += dt;
        if (l.t < L.raise) l.p = minJerk(l.t / L.raise);
        else if (l.t < L.raise + L.hold) l.p = 1;
        else if (l.t < L.raise + L.hold + L.lower) l.p = 1 - minJerk((l.t - L.raise - L.hold) / L.lower);
        else { this._lean = null; this.leanAmount = 0; return; }
      }
      this.leanAmount = l.p;
      if (this.orchestra && l.p > 0.05) this.orchestra.lookAt(0, 0);   // look straight at the viewer while leaning in
    }

    _startLoop() {
      const loop = time => {
        if (!this._lastTime) this._lastTime = time;
        const dt = Math.min(0.05, (time - this._lastTime) / 1000);   // clamp gaps (tab was in background)
        this._lastTime = time;
        this._clock += dt;

        this.sm.advanceAndApply(dt);              // idle + lip-sync write their values first...
        if (this.orchestra) {                     // ...then Orchestra's ambient life + speech beats...
          let frame = null;
          // Lite tier: only actually run Orchestra's math at ~_orchHz, still every rAF for the draw
          // itself - the bones just hold last frame's values in between (see "mobile performance
          // tier" in load()). At full tier this.orchestra.step(dt) runs every frame as before.
          if (this._orchHz) {
            this._orchAcc += dt;
            const step = 1 / this._orchHz;
            if (this._orchAcc >= step) {
              try { frame = this._orchFrame = this.orchestra.step(this._orchAcc); }
              catch (e) { console.warn('Orchestra disabled after a runtime error: ' + e.message); this.orchestra = null; this.orchestraDriver = null; }
              this._orchAcc = 0;
            } else frame = this._orchFrame;
          } else {
            try { frame = this.orchestra.step(dt); }
            catch (e) { console.warn('Orchestra disabled after a runtime error: ' + e.message); this.orchestra = null; this.orchestraDriver = null; }
          }
          if (frame) { try { this.orchestraDriver.applyPoses(frame.ch); this.orchestraDriver.apply(frame); } catch (e) {} }
        }
        if (this._gest) this._applyGesture(dt);   // ...then the gesture is layered on top...
        this._applyPoint(dt);                     // ...then pointing aims the arm at the cursor...
        this._applyHair(dt);                      // ...hair lags the head (spring)...
        this._applyLean(dt);                      // ...lean-in centers the gaze and reports leanAmount...
        if (this._wave) this._applyWave(dt);      // ...and the wave sets the arm bones last (it wins)
        if (this.mouthDirect) this.orchestraDriver.applyViseme(this.current, dt);   // ...mouth is the true last word, every frame
        this.bodyState = this._gest ? 'gesture' : 'idle';
        if (this.orchestraDriver && this.legsShown) { this.orchestraDriver.pin = true; this.orchestraDriver.pinRoot(); }   // legs on screen: no root sink/zoom from the artist's clips
        this.artboard.advance(dt);                // IK solves with the final target

        this.renderer.clear();
        this.renderer.save();
        this.renderer.align(
          this.riveRT.Fit.contain, this.riveRT.Alignment.bottomCenter,
          { minX: 0, minY: 0, maxX: this.canvas.width, maxY: this.canvas.height }, this._view);
        this.artboard.draw(this.renderer);
        this.renderer.restore();
        if (this.legsShown && this.legsClipped === null && ++this._legTry % 20 === 0) this._legPixelCheck();
        this.riveRT.requestAnimationFrame(loop);
      };
      this.riveRT.requestAnimationFrame(loop);
    }

    // Self-test: are the shoes actually in the picture? Looks at the pixels where the soles are (x 195-335, y 862-884 in
    // artboard units). If the .riv still masks the legs (old file served from cache / not redeployed) they stay transparent.
    _legPixelCheck() {
      try {
        const s = this.unitPx, v = this._view, ctx = this.canvas.getContext('2d');
        const x0 = Math.round((195 - v.minX) * s), y0 = Math.round((862 - v.minY) * s), w = Math.round(140 * s), h = Math.round(22 * s);
        const d = ctx.getImageData(x0, y0, w, h).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
        const frac = n / (w * h);
        if (frac > 0.04) { this.legsClipped = false; console.info('legs: shoes are drawn (' + (frac * 100).toFixed(0) + '% of the sole area is painted)'); }
        else if (this._legTry >= 100) { this.legsClipped = true; console.warn('legs: NOT drawn - the loaded avatar.riv still masks everything below the thighs. Deploy web/avatar.riv from the v5.1+ zip and hard-refresh.'); }
      } catch (e) { this.legsClipped = false; }      // cannot read the canvas: say nothing rather than a false alarm
    }

    // Phases: play (0 -> GESTURE.to seconds of "action") -> back (rewind to the rest pose) -> settle (fade the
    // layer out). Rewinding, rather than just lowering the blend weight, matters: the head/arm bones are only keyed by
    // "action", so a layer that is faded out mid-pose would leave them stuck in that pose.
    _applyGesture(dt) {
      const g = this._gest;
      let time, w;
      if (g.phase === 'play') {
        g.t += dt;
        const cap = this.speaking ? GESTURE.speakCap : 1;
        g.w0 = ease(Math.min(1, g.t / GESTURE.blendIn)) * cap;
        if (g.t >= GESTURE.to) g.stop();
        time = g.t; w = g.w0;
      }
      if (g.phase === 'back') {
        g.pt += dt;
        const k = Math.min(1, g.pt / GESTURE.rewind);
        time = g.from * (1 - ease(k)); w = g.w0;
        if (k >= 1) { g.phase = 'settle'; g.pt = 0; }
      } else if (g.phase === 'settle') {
        g.pt += dt;
        const k = Math.min(1, g.pt / GESTURE.settle);
        time = 0; w = g.w0 * (1 - ease(k));
        if (k >= 1) { try { g.li.delete(); } catch {} this._gest = null; return; }
      }
      g.li.time = time; g.li.apply(w);
    }

    // p (0..1) is how far the arm is into the wave. Each joint follows p with its own delay and a minimum-jerk curve,
    // so the shoulder leads and the wrist trails. Once p is close to 1 the swing fades in; it fades out as p drops.
    _applyWave(dt) {
      const w = this._wave, W = WAVE, arm = this._arm;
      w.t += dt;
      if (w.stopping) {
        w.stopT += dt;
        w.p = w.fromP * (1 - clamp01(w.stopT / W.stop));
        if (w.stopT >= W.stop) return this._endWave();
      } else if (w.t < W.raise) w.p = w.t / W.raise;
      else if (w.t < W.raise + W.hold) w.p = 1;
      else if (w.t < W.raise + W.hold + W.lower) w.p = 1 - (w.t - W.raise - W.hold) / W.lower;
      else return this._endWave();

      const J = d => minJerk(clamp01((w.p - d) / (1 - d)));               // per-joint progress
      const E = minJerk(clamp01((w.p - 0.8) / 0.2));                      // swing envelope
      const ph = 2 * Math.PI * W.freq * (w.t - W.raise * 0.8);
      const cw = arm.chest.worldTransform(), parent = Math.atan2(cw.xy, cw.xx);
      const P = W.pose, S = W.swing;
      const poseU = P.upper * RAD - parent, poseF = (P.fore - P.upper) * RAD, poseH = (P.hand - P.fore) * RAD;
      arm.sh.rotation = lerpAngle(arm.rest.sh, poseU, J(W.stagger.upper)) + S.upper * RAD * E * Math.sin(ph + 0.6);
      arm.fo.rotation = lerpAngle(arm.rest.fo, poseF, J(W.stagger.fore)) + S.fore * RAD * E * Math.sin(ph);
      arm.ha.rotation = lerpAngle(arm.rest.ha, poseH, J(W.stagger.hand)) + S.hand * RAD * E * Math.sin(ph - 2 * Math.PI * W.freq * W.lag);
      w.lastP = w.p;
    }

    _endWave() {
      const arm = this._arm;
      arm.sh.rotation = arm.rest.sh; arm.fo.rotation = arm.rest.fo; arm.ha.rotation = arm.rest.ha;
      this._wave = null;
    }

    setViseme(v) {
      if (v === this.current) return;
      this.current = v;
      if (!this.mouthDirect && this.lip) this.lip.value = v;   // direct mode reads this.current itself, every frame, in _startLoop
    }

    // owner: 'speech' (stopped when speech ends) or 'comment' / 'test' (plays out on its own)
    gesture(owner = 'speech') {
      if (!this.gestAnim || this._gest) return;
      const g = { li: new this.riveRT.LinearAnimationInstance(this.gestAnim, this.artboard),
                  phase: 'play', t: 0, pt: 0, from: 0, w0: 0, owner };
      g.stop = () => { if (g.phase === 'play') { g.phase = 'back'; g.pt = 0; g.from = g.t; } };
      this._gest = g;
    }

    wave(owner = 'speech') {
      if (!this._arm || !this.fkOk) return;
      if (this._wave && !this._wave.stopping) {              // already waving: a reply takes over ownership
        if (owner === 'speech') this._wave.owner = 'speech';
        return;
      }
      this._wave = { t: 0, p: 0, lastP: 0, stopping: false, stopT: 0, fromP: 0, owner };
      // the weight goes onto the far leg while the near arm is up (skipped if the legs are busy with something else)
      if (this.orchestra) { try { this.orchestra.cue('weightShift', { prio: 1, speed: 0.8 }); } catch (e) {} }
    }

    _stopWave() {
      const w = this._wave;
      if (w && !w.stopping) { w.stopping = true; w.stopT = 0; w.fromP = w.lastP; }
    }

    // The last reply finished: end what the reply started. A wave that a comment started keeps going.
    stopSpeechMotion() {
      if (this._gest && this._gest.owner === 'speech') this._gest.stop();
      if (this._wave && this._wave.owner === 'speech') this._stopWave();
      this.speaking = false;
    }

    // Ends every movement (the "Stop motion" button): the gesture rewinds, the wave lowers, the pointing
    // arm goes down (it lifts again on the next cursor move) and any face pose still held by Orchestra
    // - a look-up, a glance - is taken back off, so nothing at all is left switched on.
    stopMotion() {
      if (this._gest) this._gest.stop();
      this._stopWave();
      if (this._point) this._point.seen = -1e9;
      this.stopLean();
      this.speaking = false;
      if (this.orchestra && this.orchestra.stopLegs) this.orchestra.stopLegs();
      if (this.orchestraDriver && this.orchestraDriver.releasePoses) this.orchestraDriver.releasePoses();
    }
  }

  // ---------- speaks a WAV through WebAudio and drives the mouth ----------
  class Speaker {
    // motion(): returns {gesture: bool, wave: bool} - read at the start of every reply
    constructor({ rig, ctx, destination, monitor = () => false, motion = () => ({ gesture: true, wave: true }) }) {
      this.rig = rig; this.ctx = ctx; this.dest = destination; this.monitor = monitor; this.motion = motion;
      this._build();
    }

    // One chain, built once and reused: high-pass -> warmth -> presence -> de-rasp -> low-pass ->
    // compressor -> volume. espeak-ng on its own is thin and buzzy; this gives it some body, lifts the
    // consonants so the words are easy to make out over the microphone, and evens out the level.
    _build() {
      const c = this.ctx, n = {};
      n.in = c.createGain();
      n.hp = c.createBiquadFilter(); n.hp.type = 'highpass';
      n.low = c.createBiquadFilter(); n.low.type = 'lowshelf'; n.low.frequency.value = 240;
      n.pres = c.createBiquadFilter(); n.pres.type = 'peaking'; n.pres.frequency.value = 2600; n.pres.Q.value = 1.1;
      n.edge = c.createBiquadFilter(); n.edge.type = 'peaking'; n.edge.frequency.value = 4200; n.edge.Q.value = 1.6;
      n.lp = c.createBiquadFilter(); n.lp.type = 'lowpass';
      n.comp = c.createDynamicsCompressor();
      n.gain = c.createGain();
      n.in.connect(n.hp); n.hp.connect(n.low); n.low.connect(n.pres); n.pres.connect(n.edge);
      n.edge.connect(n.lp); n.lp.connect(n.comp); n.comp.connect(n.gain);
      n.gain.connect(this.dest);
      if (this.dest !== c.destination) {               // optional monitoring on this device (headphones)
        n.mon = c.createGain(); n.mon.gain.value = 0;
        n.gain.connect(n.mon); n.mon.connect(c.destination);
      }
      this.nodes = n;
      this.tune();
    }

    setMuted(v) { this.muted = !!v; if (this.nodes) this.tune(); }

    // Re-read VOICE. Called before every reply, so the controls on the page take effect immediately.
    tune() {
      const n = this.nodes, V = VOICE, on = V.filter !== false;
      n.hp.frequency.value = on ? V.hpf : 10;
      n.low.gain.value = on ? V.warmth : 0;
      n.pres.gain.value = on ? V.presence : 0;
      n.edge.gain.value = on ? V.edge : 0;
      n.lp.frequency.value = on ? V.lpf : 20000;
      n.comp.threshold.value = V.compress ? -20 : 0;
      n.comp.knee.value = 26; n.comp.ratio.value = V.compress ? 3.2 : 1;
      n.comp.attack.value = 0.006; n.comp.release.value = 0.2;
      n.gain.gain.value = this.muted ? 0 : Math.max(0, Math.min(6, V.gain));
    }

    async say(wavBytes, text, opts) {
      opts = opts || {};
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
      // An interruption that lands while the previous reply is still decoding/spinning up must still
      // win: capture the token now and bail out before touching the mouth if we were stopped meanwhile.
      const token = (this._token = (this._token || 0) + 1);
      const buf = await this.ctx.decodeAudioData(wavBytes.slice(0));
      if (token !== this._token) return;                 // stop() was called while we awaited decode
      const plan = makePlan(text, buf, { words: opts.words, dialect: opts.dialect });
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      this.tune();
      src.connect(this.nodes.in);
      if (this.nodes.mon) this.nodes.mon.gain.value = this.monitor() ? 1 : 0;

      const m = Object.assign({}, this.motion(), opts.motion);   // per-reply override (e.g. force a wave on a real comment reply)
      if (m.gesture) this.rig.gesture('speech');
      if (m.wave) this.rig.wave('speech');
      this.rig.setSpeaking(true);
      // Only a reply that actually moves the avatar earns the pre-roll - it's there to let a wave read as
      // the cause of the words that follow it, not to add lag to every single reply.
      const preRoll = (m.wave || m.gesture) ? SPEECH_PREROLL : 0;
      const t0 = this.ctx.currentTime + 0.05 + preRoll;
      src.start(t0);
      const wall0 = performance.now();
      const orch = this.rig.orchestra;
      // Speech beats are scheduled on the same delay so the first gesture beat still lands on the first
      // stressed syllable instead of firing early, into the silent pre-roll.
      if (orch) orch.speak({ energy: plan.env, rate: plan.rate, duration: buf.duration, t0: orch.t + preRoll });
      return new Promise(resolve => {
        const finish = () => {
          clearInterval(timer);
          if (this._active && this._active.token === token) this._active = null;
          this.rig.setViseme(0); this.rig.setSpeaking(false); if (orch) orch.endSpeech(); resolve();
        };
        const timer = setInterval(() => {
          const t = this.ctx.currentTime - t0;
          const wall = (performance.now() - wall0) / 1000;
          // The audio clock stalls if the browser keeps the AudioContext suspended (no tap yet). The wall clock
          // guarantees the reply still ends, so movement can never get stuck waiting for it.
          if (t > buf.duration + 0.1 || wall > preRoll + buf.duration + 1.5) {
            finish();
          } else {
            // t < 0 during the pre-roll: mouth stays at rest while the wave leads in, then the mouth mixer's
            // own crossfade eases it into the first real viseme the instant t reaches 0 - no snap.
            this.rig.setViseme(t < 0 ? 0 : plan.visemeAt(t));
          }
        }, 25);
        // Tracked so an event-driven interruption (stop()) can cut this exact utterance off mid-sentence,
        // even though the chain that called say() awaits the promise this executor belongs to.
        this._active = { token, src, timer, resolve: finish, orch };
      });
    }

    // Event-driven interruption: abort whatever is currently being spoken (baseline script or a reply),
    // snap the mouth back to rest immediately, and resolve the in-flight say() so the caller's queue can
    // move straight on to the interrupting line. Safe to call when nothing is playing.
    stop() {
      this._token = (this._token || 0) + 1;               // invalidate any say() still mid-decode
      const a = this._active;
      if (!a) { this.rig.setViseme(0); this.rig.setSpeaking(false); return; }
      this._active = null;
      try { a.src.stop(); } catch {}
      try { a.src.disconnect(); } catch {}
      a.resolve();
    }
  }

  window.AvatarRig = AvatarRig;
  window.Speaker = Speaker;
  // WAVE / POINT / VOICE / GESTURE are plain objects: editable live from the console or from the page's controls
  window.AvatarInternals = { textToVisemes, analyzeVoicing, makePlan, WAVE, DEFAULT_WAVE,
    POINT, DEFAULT_POINT, VOICE, DEFAULT_VOICE, LEAN, DEFAULT_LEAN, GESTURE, SPEECH_PREROLL, VIEW, LEGS, patchLegMask, nearestInRange,
    setDialect: d => { AR_DIALECT = d === 'msa' ? 'msa' : 'egy'; } };
})();

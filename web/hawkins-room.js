/* =====================================================================
   web/hawkins-room.js  —  Hawkins room live background
   =====================================================================
   ROOT CAUSE — verified 2026-09-27 by loading hawkins-room.riv into the
   real Rive runtime (headless, outside the browser) and driving its
   actual State Machine, instead of guessing from behavior:

     • This .riv build has only 2 artboards. Neither is literally named
       "Stage" or "AudioPlayer" — that old theory doesn't apply to this
       export. The room artboard is unnamed; findRoomArtboardAndSM()
       below already finds it correctly by its known inputs, so that
       part was never the bug and is unchanged.

     • The credits/"Title" screen has exactly ONE reachable path in the
       whole state machine (confirmed by driving every input alone and
       in every pairing): RedRUN-boolean AND GreenRUN-boolean AND
       BlueRUN-boolean all TRUE AT THE SAME TIME — the 3 lava-lamp
       "run" toggles, all on together. Any single one, or any 2 of the
       3, do nothing. So the toggles genuinely are the cause — just not
       necessarily a person clicking all 3: autopilot (_tickAutopilot)
       randomly flips these same 3 booleans while idling on stream, so
       the combo eventually happens on its own with nobody touching
       the sidebar.

     • Once that combo is set, the machine advances Title-Music (0s) →
       Title-Intro (~2s) → Title (~9-10s) on its own timeline — there
       is no way to jump straight to "Title", and TitleClick only does
       anything once the machine has actually arrived at "Title". A
       watchdog that only retries TitleClick for a fixed few seconds
       after the combo is *set* can easily expire before the machine
       ever reaches the one state where the click works — so it looks
       "unfixable" even though the click itself is fine.

     • Worse: successfully firing TitleClick to exit "Title" re-plays
       that state's own timeline on the way out, and the artist's
       original (unblanked) credits text is baked into that timeline —
       so the moment the escape actually works, it *re-writes* our
       blanked text run back to the full "Art: ..." credits text. A
       one-time blank at load() can't survive that.

   FIX (permanent, verified against the real .riv, not time-based):
     1. The 3 lamp "run" booleans are now mutually exclusive at the one
        place every caller (buttons, autopilot, speech reactivity) goes
        through — setBool()/toggleBool(). Turning a 3rd one on forces
        the least-recently-turned-on of the other two off FIRST, so all
        three can never be true at once. This makes the credits state
        structurally unreachable — nothing to detect or recover from.
     2. Defense in depth, in case a future .riv re-export adds another
        path in: the render loop watches the state machine's own
        stateChanged events (not a timer) and, if "Title" is ever
        actually entered, fires TitleClick every frame — with no
        arbitrary cutoff — until "Title-Off" is observed, then forces
        a lamp off and re-blanks text immediately.
     3. Text runs are re-blanked every frame (3 runs, negligible cost)
        instead of once at load, so even a successful escape can't
        leave the re-baked credits text visible afterward.

   TunnelBoolean / TunnelClick  →  normal room  ↔  Upside Down + Demogorgon
   All prop inputs (candles, TV, radio, lamps, Demogorgon) now work.

   DEMOGORGON VISIBILITY GATE (DemVisible):
   Verified 2026-09-27 against the re-exported hawkins-room.riv: DemVisible
   now exists for real, declared as a bool input in "State Machine 1" (it
   did not exist in the prior export — see old note below, kept for
   history). The .riv's DEMOGORGON-In transition requires BOTH:
     TunnelBoolean == true  AND  DemVisible == true
   DemVisible (bool, default false) is a gate — the Demogorgon is INVISIBLE
   by default even when the Upside Down is on. Behaviour:
   - Toggling Upside Down ON  → DemVisible stays false (Demogorgon hidden).
   - Toggling Upside Down OFF → DemVisible forced false (Demogorgon disappears).
   - fire('DemEnter') → sets DemVisible=true then fires trigger (shows + enters).
   - fire('DemExit')  → sets DemVisible=false then fires trigger (exits + hides).
   - '👁 Visible toggle' button lets the streamer manually open/close the gate.
   (Old note, kept for history: in the previous .riv export DemVisible did
   not exist at all, so every setBool('DemVisible', ...) call below was a
   silent no-op — the code was already written for a gate the asset didn't
   have yet. That is exactly what the new export now provides.)

   CINEMATIC DEMOGORGON FX (added 2026-09-27):
   The .riv's own DEMOGORGON-In / DEMOGORGON-Out state transitions already
   animate the puppet; this layer adds a punchy, streamer-facing 2D overlay
   on top of that so the moment reads as an "event" rather than a prop
   quietly appearing. It runs entirely inside draw() — no other file needs
   to change. Every path that flips DemVisible (DemEnter/DemExit triggers,
   the sidebar 👁 toggle, and the TunnelBoolean-off auto-reset) is funneled
   through _applyDemVisible() so the fx always fires consistently, however
   the gate got flipped.
   - Enter (DemVisible false → true): camera shake + a hot white flash that
     collapses into a red pulse + vignette, plus a brief chromatic-
     aberration ghost pass. ~700ms, syncing with DEMOGORGON-In.
   - Exit  (DemVisible true → false): a slice-glitch (horizontal frame
     tearing) + fade-to-black vignette + a lighter shake. 900ms, matching
     the DEMOGORGON-Out clip length.
   - A short procedural (no audio files, synthesized on the fly) stinger
     plays alongside each transition — a sub-bass hit + noise burst on
     enter, a filtered noise sweep on exit. Set `room.demFxAudio = false`
     to mute just the stinger and keep the visual fx.

   BUGFIX — "Exit doesn't dismiss the Demogorgon" (2026-09-27):
   The first cut of the DemVisible wiring forced DemVisible=false in the
   same synchronous call as firing the DemExit trigger. That's wrong: the
   .riv re-checks DemVisible at the instant DemExit is evaluated, so by
   the time the engine looked, the gate had already slammed shut and the
   Real→Out transition's own guard failed — the trigger fired but nothing
   happened, and the Demogorgon just stood there. Fix: fire('DemExit') now
   fires the trigger with the gate still open, plays the cinematic fx
   immediately (so it still visually syncs with the DEMOGORGON-Out9 clip),
   and only writes DemVisible=false ~900ms later once the clip has had
   time to actually finish — see fire() and _applyDemVisible()'s skipFx.

   RENDERING NOTES:
   1. Rive Renderer is a command queue → explicit flush() after draw().
   2. renderer.align() not available → hand-computed Cover-fit transform.
   3. WebGL backbuffer cleared after present → preserveDrawingBuffer:true.
   4. Artboard doesn't auto-resize → Cover-fit affine each frame.
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HawkinsRoom = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SRC    = 'hawkins-room.riv';
  const DEFAULT_SM     = 'State Machine 1';
  const ROOM_ARTBOARD  = 'Stage';   // preferred name if a future re-export has it

  // ── Button groups exported for the sidebar grid ───────────────────
  const BUTTON_GROUPS = [
    {
      label: '🌀 Tunnel (Upside Down)',
      items: [
        { name: 'TunnelBoolean', label: '🌀 Toggle Upside Down', kind: 'bool' },
        { name: 'TunnelClick',   label: '⚡ Tunnel flash',       kind: 'trigger' },
      ],
    },
    {
      label: '👾 Demogorgon',
      items: [
        { name: 'DemVisible', label: '👁 Visible toggle', kind: 'bool'    },
        { name: 'DemEnter',   label: '🚪 Enter',          kind: 'trigger' },
        { name: 'DemClick',   label: '👾 Attack',         kind: 'trigger' },
        { name: 'DemExit',    label: '💨 Exit',           kind: 'trigger' },
      ],
    },
    {
      label: '📺 TV',
      items: [
        { name: 'TVClick',    label: '📺 TV click',  kind: 'trigger' },
        { name: 'TV-Boolean', label: '📺 TV toggle', kind: 'bool'    },
      ],
    },
    {
      label: '🪩 Lava lamps',
      items: [
        { name: 'RedRUN-Click',     label: '🔴 Red click',    kind: 'trigger' },
        { name: 'RedRUN-boolean',   label: '🔴 Red toggle',   kind: 'bool'    },
        { name: 'GreenRUN-Click',   label: '🟢 Green click',  kind: 'trigger' },
        { name: 'GreenRUN-boolean', label: '🟢 Green toggle', kind: 'bool'    },
        { name: 'BlueRUN-Click',    label: '🔵 Blue click',   kind: 'trigger' },
        { name: 'BlueRUN-boolean',  label: '🔵 Blue toggle',  kind: 'bool'    },
      ],
    },
    {
      label: '🕯 Candles',
      items: [
        { name: 'Candle1Click', label: '🕯 1', kind: 'trigger' },
        { name: 'Candle2Click', label: '🕯 2', kind: 'trigger' },
        { name: 'Candle3Click', label: '🕯 3', kind: 'trigger' },
        { name: 'Candle4Click', label: '🕯 4', kind: 'trigger' },
        { name: 'Candle5Click', label: '🕯 5', kind: 'trigger' },
        { name: 'Candle6Click', label: '🕯 6', kind: 'trigger' },
      ],
    },
    {
      label: '🏠 Room props',
      items: [
        { name: 'DoorClick',    label: '🚪 Door',    kind: 'trigger' },
        { name: 'RadioClick',   label: '📻 Radio',   kind: 'trigger' },
        { name: 'PictureClick', label: '🖼 Picture', kind: 'trigger' },
        // Confirmed via the .riv's own state machine: this is the ONLY
        // input that ever exits "Title" (Title -> Title-Off). Kept as a
        // manual backup; harmless no-op when credits aren't showing.
        { name: 'TitleClick',   label: '🆘 Close credits', kind: 'trigger' },
        { name: 'Lamp-L-Click', label: '💡 Lamp L',  kind: 'trigger' },
        { name: 'LampR-Click',  label: '💡 Lamp R',  kind: 'trigger' },
      ],
    },
  ];

  // Flat lookup for groupOf() used by list()
  const GROUPS = BUTTON_GROUPS.map(g => ({
    label: g.label,
    names: g.items.map(i => i.name),
  }));
  function groupOf(name) {
    for (const g of GROUPS) if (g.names.includes(name)) return g.label;
    return 'Other';
  }

  const AMBIENT_TRIGGERS = ['TVClick','RadioClick','RedRUN-Click','GreenRUN-Click','BlueRUN-Click'];
  const AMBIENT_BOOLS    = ['TV-Boolean','RedRUN-boolean','GreenRUN-boolean','BlueRUN-boolean'];

  // The 3 inputs whose simultaneous TRUE is the one confirmed path into
  // the credits/"Title" state. See the file header for how this was
  // verified. Order matters only for readability here.
  const LAMP_RUN_BOOLS = ['RedRUN-boolean', 'GreenRUN-boolean', 'BlueRUN-boolean'];

  // TitleEnter/TitleExit: confirmed unused by the actual state-machine graph
  // (fired alone, in isolation, they produce zero state changes). Blocked
  // since exposing them would be a pure no-op button.
  const BLOCKED_INPUTS = new Set(['TitleEnter', 'TitleExit']);

  // ── Auto-detect the room artboard by its controls, not just its name ──
  // This .riv's room artboard isn't literally named "Stage" (see header).
  // Scan every artboard in the file and use the first one whose state
  // machine actually exposes at least one of the room's own known inputs.
  const KNOWN_ROOM_INPUTS = new Set(BUTTON_GROUPS.flatMap(g => g.items.map(i => i.name)));

  function findRoomArtboardAndSM(file, riveRT, smName) {
    const tryOne = (ab) => {
      let smDef; try { smDef = ab.stateMachineByName(smName); } catch (e) { smDef = null; }
      if (!smDef) { try { smDef = ab.stateMachineByIndex(0); } catch (e) {} }
      if (!smDef) return null;
      try { return new riveRT.StateMachineInstance(smDef, ab); } catch (e) { return null; }
    };

    // 1) Preferred: an artboard literally named ROOM_ARTBOARD ('Stage'),
    //    in case a future re-export names it that way.
    try {
      const byName = file.artboardByName(ROOM_ARTBOARD);
      if (byName) {
        const inst = tryOne(byName);
        if (inst) return { artboard: byName, sm: inst, usedName: ROOM_ARTBOARD };
      }
    } catch (e) {}

    // 2) Fallback (what this .riv actually needs): whichever artboard has
    //    the room's own controls.
    const names = [];
    let count = 0; try { count = file.artboardCount(); } catch (e) {}
    for (let i = 0; i < count; i++) {
      let ab; try { ab = file.artboardByIndex(i); } catch (e) { continue; }
      names.push(ab && ab.name);
      const inst = tryOne(ab);
      if (!inst) continue;
      let matched = false;
      for (let k = 0; k < inst.inputCount(); k++) { if (KNOWN_ROOM_INPUTS.has(inst.input(k).name)) { matched = true; break; } }
      if (matched) return { artboard: ab, sm: inst, usedName: ab && ab.name };
      try { inst.delete && inst.delete(); } catch (e) {}
    }

    throw new Error('No artboard with the expected room controls (TunnelBoolean, DemEnter, TVClick, ...) was found. Available artboards: [' + names.join(', ') + ']');
  }

  // ── HawkinsRoom class ──────────────────────────────────────────────
  class HawkinsRoom {
    constructor() {
      this.ready     = false;
      this.canvas    = null;
      this.riveRT    = null;
      this.file      = null;
      this.artboard  = null;
      this.sm        = null;
      this.renderer  = null;
      this.smName    = DEFAULT_SM;
      this.inputs    = {};   // { name: { kind, input, group } }
      this._clock    = 0;
      this._last     = 0;
      this._pulse    = 0;
      this._auto     = false;
      this._autoNext = 0;
      this._disposed = false;
      this._raf      = null;
      this._upsideDown = false;
      this._lastTransformLog = 0;

      // Cinematic Demogorgon fx (see header). Purely visual/audio state —
      // never touched by anything except _applyDemVisible()/draw().
      this._demFx      = null;   // { type:'enter'|'exit', start, duration } | null
      this.demFxAudio  = true;   // set false to mute the procedural stinger only
      this._audioCtx   = null;
      this._demExitToken = 0;    // invalidates a pending deferred DemExit gate-close (see fire())

      // Permanent-fix state: recency order of currently-on lamp bools,
      // for the mutual-exclusion guard (see _guardLampCombo).
      this._lampOnOrder = [];
      // Cached text runs, re-blanked every frame (fix #3 in header).
      this._textRuns = [];
      // Defense-in-depth escape hatch (fix #2 in header) — event driven,
      // not time-boxed.
      this._inTitle = false;
    }

    async load({ src=DEFAULT_SRC, stateMachine=DEFAULT_SM, riveRT=null, width=640, height=360 } = {}) {
      this.smName       = stateMachine;
      this.canvas       = document.createElement('canvas');
      this.canvas.width = width; this.canvas.height = height;

      // Fix #3: preserveDrawingBuffer so ctx.drawImage() reads a live frame
      const origGetContext = this.canvas.getContext.bind(this.canvas);
      this.canvas.getContext = (type, attrs) => {
        const t = String(type||'').toLowerCase();
        if ((t==='webgl'||t==='webgl2'||t==='experimental-webgl'||t==='webgpu') && !attrs)
          attrs = { preserveDrawingBuffer:true, antialias:true, alpha:true, premultipliedAlpha:true };
        return origGetContext(type, attrs);
      };

      this.riveRT = riveRT;
      if (!this.riveRT) {
        let RiveCanvas;
        try { ({ default: RiveCanvas } = await import('./vendor/canvas_advanced.mjs')); }
        catch (e) { throw new Error('Rive runtime did not load: ' + e.message); }
        this.riveRT = await RiveCanvas({
          locateFile: f => f.endsWith('.wasm') ? 'vendor/rive.wasm' : 'vendor/' + f,
        });
      }

      const res = await fetch(src + (src.includes('?')? '&':'?') + 'v=' + Date.now(), {cache:'no-store'});
      if (!res.ok) throw new Error('Could not load ' + src + ': HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());

      this.file     = await this.riveRT.load(bytes);

      const picked  = findRoomArtboardAndSM(this.file, this.riveRT, this.smName);
      this.artboard = picked.artboard;
      this.sm       = picked.sm;
      if (picked.usedName !== ROOM_ARTBOARD) {
        console.info('[hawkins-room] artboard "' + ROOM_ARTBOARD + '" not found by name in ' + src + '; auto-detected "' + picked.usedName + '" instead (matched by its room-prop inputs).');
      }

      // Cache the artboard's text runs once (blanked every frame in the
      // loop below — see header fix #3). Logged once so a future .riv
      // re-export that adds/removes stray text is visible in the console.
      this._textRuns = [];
      try {
        const tc = this.artboard.textValueRunCount();
        for (let i = 0; i < tc; i++) {
          const run = this.artboard.textValueRunByIndex(i);
          if (run.text) {
            console.warn('[hawkins-room] GUARD: found stray text run #' + i + ' on "' + picked.usedName +
              '" (should only ever show room props, never text) — blanking every frame: ' + JSON.stringify(run.text));
          }
          this._textRuns.push(run);
        }
      } catch (e) {
        console.warn('[hawkins-room] GUARD: text-run scan skipped:', e.message);
      }

      this.renderer = this.riveRT.makeRenderer(this.canvas);

      // Discover all inputs generically
      this.inputs = {};
      for (let i=0; i<this.sm.inputCount(); i++) {
        const raw=this.sm.input(i), name=raw.name;
        if (BLOCKED_INPUTS.has(name)) continue; // confirmed no-op — never expose this
        let kind=null, input=null;
        try { input=raw.asTrigger(); kind='trigger'; } catch(e) {}
        if (!input) { try { input=raw.asBool();   kind='bool';   } catch(e) {} }
        if (!input) { try { input=raw.asNumber(); kind='number'; } catch(e) {} }
        if (input) this.inputs[name] = { kind, input, group:groupOf(name) };
      }

      try {
        this.artboard.advance(0); this.sm.advanceAndApply(0);
        const b=this.artboard.bounds;
        console.info('[hawkins-room] artboard:', picked.usedName,
          (b.maxX-b.minX).toFixed(1)+'×'+(b.maxY-b.minY).toFixed(1),
          '→', width+'×'+height, '| inputs:', Object.keys(this.inputs).length);
      } catch(e) { console.warn('[hawkins-room] bounds:', e.message); }

      // Blank text runs immediately (also re-blanked every frame below).
      this._blankTextRuns();

      this._last = performance.now();
      this.ready = true;

      // Self-driving RAF loop: advance → draw → flush (all in same tick)
      const loop = (time) => {
        if (this._disposed) return;
        const dt = Math.min(0.05, (time-this._last)/1000);
        this._last=time; this._clock+=dt;
        this._tickAutopilot(time);
        this.sm.advanceAndApply(dt);
        this.artboard.advance(dt);

        // ── Defense-in-depth escape hatch (header fix #2) ──────────────
        // Structurally the "Title" combo can no longer be set (see
        // _guardLampCombo), so this should never fire in normal use.
        // Kept as a safety net driven by the state machine's own reported
        // state changes — not a timer — so it can't expire early and
        // can't miss a slower/faster future .riv re-export's timing.
        try {
          const n = this.sm.stateChangedCount ? this.sm.stateChangedCount() : 0;
          for (let i=0; i<n; i++) {
            const name = this.sm.stateChangedNameByIndex(i);
            if (name === 'Title') {
              if (!this._inTitle) console.warn('[hawkins-room] GUARD: credits state reached unexpectedly — forcing exit.');
              this._inTitle = true;
            } else if (this._inTitle && name === 'Title-Off') {
              this._inTitle = false;
              this._blankTextRuns(); // exiting re-bakes the credits text — re-blank right away
            }
          }
        } catch (e) {}
        if (this._inTitle) {
          this.fire('TitleClick');
          // Belt-and-braces: also break the combo that got us here.
          for (const n of LAMP_RUN_BOOLS) { this.setBool(n, false); }
        }

        // Re-blank every frame — cheap (≤ a few runs) and makes the
        // once-per-escape re-bake (header note) a non-issue.
        this._blankTextRuns();

        this.renderer.clear(); this.renderer.save();
        // Fix #4: Cover-fit the artboard into the off-DOM canvas
        try {
          const b=this.artboard.bounds, aw=b.maxX-b.minX, ah=b.maxY-b.minY;
          if (aw>0&&ah>0&&isFinite(aw)&&isFinite(ah)) {
            const cw=this.canvas.width, ch=this.canvas.height;
            const s=Math.max(cw/aw,ch/ah);
            const tx=(cw-aw*s)/2-b.minX*s, ty=(ch-ah*s)/2-b.minY*s;
            if (typeof this.renderer.transform==='function') this.renderer.transform(s,0,0,s,tx,ty);
          }
        } catch(e) {
          if (this._clock-this._lastTransformLog>5) { this._lastTransformLog=this._clock; console.warn('[hawkins-room] transform:',e.message); }
        }
        this.artboard.draw(this.renderer);
        this.renderer.restore();
        this.renderer.flush(); // Fix #1: submit command queue
        this._raf=this.riveRT.requestAnimationFrame(loop);
      };
      this._raf=this.riveRT.requestAnimationFrame(loop);
      return this;
    }

    _blankTextRuns() {
      for (const run of this._textRuns) {
        try { if (run.text) run.text = ''; } catch (e) {}
      }
    }

    // Permanent fix (header #1): the 3 lamp "run" booleans are mutually
    // exclusive. Called before applying any bool=true so the 3rd one can
    // never complete the triple that reaches the credits state.
    _guardLampCombo(name, nextValue) {
      if (!nextValue || !LAMP_RUN_BOOLS.includes(name)) return;
      const others = LAMP_RUN_BOOLS.filter(n => n !== name);
      const onOthers = others.filter(n => this.getBool(n));
      if (onOthers.length >= 2) {
        // Would complete the triple — force off whichever of the other
        // two was turned on longest ago (falls back to the first if we
        // somehow don't have recency data for it).
        const victim = this._lampOnOrder.find(n => onOthers.includes(n)) || onOthers[0];
        const e = this.inputs[victim];
        if (e && e.kind === 'bool') e.input.value = false;
        this._lampOnOrder = this._lampOnOrder.filter(n => n !== victim);
        console.info('[hawkins-room] GUARD: ' + name + ' would complete the Red+Green+Blue combo — turned ' + victim + ' off first.');
      }
    }
    _noteLampOn(name) {
      if (!LAMP_RUN_BOOLS.includes(name)) return;
      this._lampOnOrder = this._lampOnOrder.filter(n => n !== name);
      this._lampOnOrder.push(name);
    }
    _noteLampOff(name) {
      if (!LAMP_RUN_BOOLS.includes(name)) return;
      this._lampOnOrder = this._lampOnOrder.filter(n => n !== name);
    }

    // ── Input manifest ──────────────────────────────────────────────
    list() {
      const out={triggers:[],bools:[],numbers:[]};
      for (const name in this.inputs) {
        const e=this.inputs[name];
        (e.kind==='trigger'?out.triggers:e.kind==='bool'?out.bools:out.numbers).push({name,group:e.group});
      }
      return out;
    }

    fire(name) {
      const e=this.inputs[name];
      if(e&&e.kind==='trigger') {
        // DemEnter → set DemVisible true so DEMOGORGON-In condition fires,
        // then fire. Safe to do synchronously: the gate only needs to be
        // open *before* the trigger is evaluated, which it is here.
        if (name === 'DemEnter') this.setBool('DemVisible', true);
        e.input.fire();
        // DemExit → do NOT close the gate synchronously. Root cause of the
        // "Exit doesn't dismiss the Demogorgon" bug: forcing DemVisible
        // false in the same tick as firing DemExit means the .riv's own
        // exit transition re-checks DemVisible at the instant the trigger
        // is evaluated and finds it already false — so the guard fails and
        // the Real→Out transition never happens; the Demogorgon just sits
        // there. Fire the trigger with the gate still open, let the
        // DEMOGORGON-Out9 clip (~0.9s) actually play, THEN close the gate.
        // The cinematic fx still plays immediately (synced to the clip);
        // only the underlying bool write is deferred (skipFx:true so it
        // doesn't replay the fx a second time once it lands).
        if (name === 'DemExit') {
          this._triggerDemFx('exit');
          const myToken = ++this._demExitToken;
          setTimeout(() => {
            if (this._demExitToken === myToken) this._applyDemVisible(false, {skipFx:true});
          }, 900);
        }
      }
      return !!e;
    }
    getBool(name)     { const e=this.inputs[name]; return e&&e.kind==='bool'?!!e.input.value:undefined; }
    setBool(name,v) {
      const e=this.inputs[name]; if(!e||e.kind!=='bool') return false;
      v=!!v;
      // DemVisible always routes through _applyDemVisible so the cinematic
      // fx fires no matter which caller flips the gate.
      if (name === 'DemVisible') return this._applyDemVisible(v);
      this._guardLampCombo(name, v);
      e.input.value=v;
      if (v) this._noteLampOn(name); else this._noteLampOff(name);
      // Turning the Upside Down off always resets the Demogorgon visibility
      // gate so it is hidden by default next time Upside Down is turned on.
      if (name === 'TunnelBoolean' && !v) this._applyDemVisible(false);
      return true;
    }
    toggleBool(name) {
      if (name === 'DemVisible') { this._applyDemVisible(!this.getBool('DemVisible')); return this.getBool('DemVisible'); }
      const e=this.inputs[name];
      if (e&&e.kind==='bool') {
        const next=!e.input.value;
        this._guardLampCombo(name, next);
        e.input.value=next;
        if (next) this._noteLampOn(name); else this._noteLampOff(name);
        if (name==='TunnelBoolean') {
          this._upsideDown = e.input.value;
          // Toggling the Upside Down OFF always hides the Demogorgon.
          // Toggling it ON keeps DemVisible=false — Demogorgon stays
          // hidden until DemEnter (or the Visible toggle) is pressed.
          if (!e.input.value) this.setBool('DemVisible', false);
        }
      }
      return e?e.input.value:undefined;
    }

    // ── Demogorgon visibility gate — single choke point (header) ──────
    // Every caller that flips DemVisible goes through here, so the
    // cinematic fx + stinger fire exactly once per real transition and
    // never on a no-op (setting it to the value it already has).
    // `opts.skipFx` lets fire()'s deferred DemExit close apply the bool
    // write without replaying an fx that was already triggered up front.
    _applyDemVisible(v, opts) {
      const skipFx = !!(opts && opts.skipFx);
      v = !!v;
      const dv = this.inputs['DemVisible'];
      if (!dv || dv.kind !== 'bool') return false;
      // Any real gate change invalidates a still-pending deferred DemExit
      // close scheduled by an earlier fire('DemExit') — see fire() above.
      this._demExitToken++;
      const changed = !!dv.input.value !== v;
      dv.input.value = v;
      if (changed && !skipFx) this._triggerDemFx(v ? 'enter' : 'exit');
      return true;
    }

    _triggerDemFx(type) {
      // Exit duration matches the DEMOGORGON-Out9 clip (~0.9s); enter is a
      // snappier punch-in tuned to feel simultaneous with DEMOGORGON-In.
      const duration = type === 'enter' ? 700 : 900;
      this._demFx = { type, start: performance.now(), duration };
      if (this.demFxAudio) this._playDemStinger(type);
    }

    // Procedural stinger — synthesized on the fly (no audio assets to ship
    // or license). Wrapped in try/catch: audio is a bonus, never allowed
    // to break rendering if AudioContext is unavailable/blocked.
    _playDemStinger(type) {
      try {
        if (!this._audioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          this._audioCtx = new AC();
        }
        const ac = this._audioCtx;
        if (ac.state === 'suspended') ac.resume().catch(()=>{});
        const now = ac.currentTime;

        if (type === 'enter') {
          // Sub-bass impact hit.
          const o = ac.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(95, now);
          o.frequency.exponentialRampToValueAtTime(28, now + 0.5);
          const og = ac.createGain();
          og.gain.setValueAtTime(0.0001, now);
          og.gain.exponentialRampToValueAtTime(0.5, now + 0.03);
          og.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
          o.connect(og); og.connect(ac.destination);
          o.start(now); o.stop(now + 0.65);

          // Low-passed noise burst layered under the hit for texture.
          const buf = ac.createBuffer(1, Math.floor(ac.sampleRate*0.35), ac.sampleRate);
          const d = buf.getChannelData(0);
          for (let i=0;i<d.length;i++) d[i] = (Math.random()*2-1) * (1 - i/d.length);
          const n = ac.createBufferSource(); n.buffer = buf;
          const nf = ac.createBiquadFilter(); nf.type='lowpass'; nf.frequency.setValueAtTime(1100, now);
          const ng = ac.createGain(); ng.gain.setValueAtTime(0.22, now); ng.gain.exponentialRampToValueAtTime(0.0001, now+0.35);
          n.connect(nf); nf.connect(ng); ng.connect(ac.destination); n.start(now);
        } else {
          // High-passed noise sweep for the exit "power-down" glitch.
          const buf = ac.createBuffer(1, Math.floor(ac.sampleRate*0.5), ac.sampleRate);
          const d = buf.getChannelData(0);
          for (let i=0;i<d.length;i++) d[i] = (Math.random()*2-1) * (1 - i/d.length);
          const n = ac.createBufferSource(); n.buffer = buf;
          const nf = ac.createBiquadFilter(); nf.type='highpass'; nf.frequency.setValueAtTime(700, now);
          nf.frequency.exponentialRampToValueAtTime(4000, now + 0.4);
          const ng = ac.createGain(); ng.gain.setValueAtTime(0.16, now); ng.gain.exponentialRampToValueAtTime(0.0001, now+0.5);
          n.connect(nf); nf.connect(ng); ng.connect(ac.destination); n.start(now);
        }
      } catch (e) { /* stinger is best-effort only */ }
    }
    getNumber(name)   { const e=this.inputs[name]; return e&&e.kind==='number'?e.input.value:undefined; }
    setNumber(name,v) { const e=this.inputs[name]; if(e&&e.kind==='number') e.input.value=+v; return !!e; }

    // Convenience: toggle Upside Down (TunnelBoolean)
    toggleUpsideDown() { return this.toggleBool('TunnelBoolean'); }
    get upsideDown()   { return this._upsideDown; }

    // ── Speech reactivity ───────────────────────────────────────────
    // level: 0..1, continuous. Callers should feed the REAL per-frame speech envelope
    // (rig.orchestra.voiceLevel, see avatar-orchestra.js) rather than a plain speaking on/off flag —
    // this is what lets a rising-edge below actually land on a loud/stressed moment in the voice
    // instead of firing at a roughly-fixed cadence for as long as *any* audio happens to be playing.
    reactToSpeech(level) {
      const prev=this._pulse; this._pulse=Math.max(0,Math.min(1,level));
      if (!this.ready) return;
      if (prev<0.5&&this._pulse>=0.5&&performance.now()>(this._speechCooldown||0)&&Math.random()<0.6) {
        this.fire(AMBIENT_TRIGGERS[(Math.random()*AMBIENT_TRIGGERS.length)|0]);
        this._speechCooldown=performance.now()+1200;
      }
    }
    // NEW — a crisper, discrete counterpart to reactToSpeech(): call this once per detected speech
    // "beat" (emphasis on a stressed syllable), e.g. wired as `rig.orchestra.onBeat = s =>
    // room.reactToBeat(s)`. Unlike reactToSpeech's level-crossing, this fires exactly on emphasis, not
    // on "still talking" — a stronger `strength` (0..1) is simply more likely to visibly react. Same
    // trigger pool and a slightly shorter cooldown, so it can layer with reactToSpeech without flooding.
    reactToBeat(strength) {
      if (!this.ready) return;
      const now=performance.now();
      if (now<(this._beatCooldown||0)) return;
      this._beatCooldown=now+900;
      if (Math.random()<0.35+0.4*Math.max(0,Math.min(1,strength))) {
        this.fire(AMBIENT_TRIGGERS[(Math.random()*AMBIENT_TRIGGERS.length)|0]);
      }
    }

    // ── Ambient idle life ───────────────────────────────────────────
    autopilot(on) {
      this._auto=!!on;
      if (this._auto&&!this._autoNext) this._autoNext=performance.now()+2000+Math.random()*3000;
    }
    _tickAutopilot(nowMs) {
      if (!this._auto||nowMs<this._autoNext) return;
      this._autoNext=nowMs+4000+Math.random()*6000;
      if (Math.random()<0.5) this.fire(AMBIENT_TRIGGERS[(Math.random()*AMBIENT_TRIGGERS.length)|0]);
      else this.toggleBool(AMBIENT_BOOLS[(Math.random()*AMBIENT_BOOLS.length)|0]);
    }

    // ── Blit onto host 2D context, Cover-fit, + cinematic Demogorgon fx ─
    draw(ctx, W, H) {
      if (!this.ready||!this.canvas||!this.canvas.width||!this.canvas.height) return false;
      const cw=this.canvas.width, ch=this.canvas.height;
      const s=Math.max(W/cw,H/ch);
      const dw=cw*s, dh=ch*s;
      const ox=(W-dw)/2, oy=(H-dh)/2;

      // Resolve current fx progress (0..1) once per frame; clear when done.
      let fxType=null, p=0;
      if (this._demFx) {
        p = (performance.now()-this._demFx.start)/this._demFx.duration;
        if (p>=1) this._demFx=null; else fxType=this._demFx.type;
      }

      ctx.save();
      try {
        if (fxType) {
          // Punchy at impact, settling out over the fx duration.
          const shakeEnv = fxType==='enter' ? Math.max(0,1-p*2.2) : Math.max(0,1-p*1.6);
          const mag = (fxType==='enter'?9:5) * shakeEnv;
          ctx.translate((Math.random()*2-1)*mag, (Math.random()*2-1)*mag);
        }

        try { ctx.drawImage(this.canvas,0,0,cw,ch,ox,oy,dw,dh); }
        catch(e) { ctx.restore(); return false; }

        if (fxType === 'enter') {
          // Hot white flash (first ~250ms) collapsing into a red pulse.
          const flash = Math.max(0, 1-p*4);
          if (flash>0) { ctx.fillStyle='rgba(255,255,255,'+(flash*0.85).toFixed(3)+')'; ctx.fillRect(0,0,W,H); }
          const redPulse = Math.sin(Math.min(1,p*3)*Math.PI) * (1-p);
          if (redPulse>0) { ctx.fillStyle='rgba(180,0,20,'+(redPulse*0.35).toFixed(3)+')'; ctx.fillRect(0,0,W,H); }
          this._drawVignette(ctx,W,H,(1-p)*0.55,'rgba(120,0,10,');
          // Brief chromatic-aberration ghost pass, fading fast.
          const ab = Math.max(0,1-p*2.5);
          if (ab>0.02) {
            ctx.globalCompositeOperation='screen';
            ctx.globalAlpha = ab*0.5;
            ctx.drawImage(this.canvas,0,0,cw,ch, ox-4*ab, oy, dw, dh);
            ctx.drawImage(this.canvas,0,0,cw,ch, ox+4*ab, oy, dw, dh);
            ctx.globalAlpha = 1; ctx.globalCompositeOperation='source-over';
          }
        } else if (fxType === 'exit') {
          // Slice-glitch (frame tearing) fading into a black vignette.
          const glitchEnv = Math.max(0, 1-p*1.4);
          if (glitchEnv>0.03) {
            const slices=7, sh=ch/slices;
            for (let i=0;i<slices;i++) {
              if (Math.random()>0.55) continue;
              const off=(Math.random()*2-1)*26*glitchEnv*s;
              try { ctx.drawImage(this.canvas,0,i*sh,cw,sh, ox+off,oy+i*sh*s, dw,sh*s); } catch(e) {}
            }
          }
          ctx.fillStyle='rgba(0,0,0,'+(p*p*0.6).toFixed(3)+')'; ctx.fillRect(0,0,W,H);
          this._drawVignette(ctx,W,H,(1-p)*0.4,'rgba(0,0,0,');
        }
      } finally { ctx.restore(); }

      return true;
    }

    _drawVignette(ctx,W,H,strength,rgbaPrefix) {
      if (strength<=0) return;
      const g = ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.25, W/2,H/2,Math.max(W,H)*0.75);
      g.addColorStop(0, rgbaPrefix+'0)');
      g.addColorStop(1, rgbaPrefix+strength.toFixed(3)+')');
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    }

    dispose() {
      this._disposed=true; this._auto=false;
      if (this._raf&&this.riveRT&&this.riveRT.cancelAnimationFrame)
        try { this.riveRT.cancelAnimationFrame(this._raf); } catch(e) {}
      this._raf=null; this.ready=false;
      this.canvas=null; this.artboard=null; this.sm=null; this.renderer=null; this.file=null;
    }
  }

  function wireToRig(room, rig, opts) {
    opts=opts||{}; let pulse=0, beatWired=false;
    return function tick() {
      // One-time: forward Orchestra's real per-beat emphasis events into the room, if/when the
      // orchestra shows up (it loads after the rig in some pages, so this is checked every tick
      // until it succeeds once, then left alone).
      if (!beatWired && rig && rig.orchestra) {
        rig.orchestra.onBeat = s => room.reactToBeat(s);
        beatWired = true;
      }
      if (!rig||!rig.ready) { room.reactToSpeech((pulse*=0.9)); return; }
      // Prefer the real speech envelope (rig.orchestra.voiceLevel) over the old on/off rig.speaking
      // flag — same smoothing, but now the pulse actually rises and falls with the loud/quiet parts
      // of the voice instead of just tracking "audio is playing at all". Falls back to the flag if
      // Orchestra isn't loaded, so this still degrades gracefully like everything else in this file.
      const level = rig.orchestra ? rig.orchestra.voiceLevel : (rig.speaking ? 1 : 0);
      pulse+=(level-pulse)*(opts.smoothing||0.08);
      room.reactToSpeech(pulse);
    };
  }

  return { HawkinsRoom, wireToRig, GROUPS, BUTTON_GROUPS };
});

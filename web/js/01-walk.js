// =====================================================================
//  01-walk.js — walk-in / walk-out animation.
//
//  Changes from the original inline version ("more handled"):
//   - Tracks a `dir` ('in' | 'out') on the in-flight animation so a
//     second click on the SAME button while already walking that way
//     is a no-op, instead of restarting the tween from wherever it
//     currently is (which used to cause a visible stutter).
//   - A click on the OTHER button still reverses cleanly mid-walk
//     (fromX is always wherever the character currently is).
//   - The Walk in / Walk out buttons are disabled while their own
//     animation is in flight and re-labelled ("Walking in…"), so you
//     can't double-fire the same walk or lose track of what's playing.
//   - Logs a clear "walk-in/out complete" line and stops the march cue
//     once the character arrives, instead of leaving the leg-cycle
//     cue dangling.
// =====================================================================
const DOOR_X   = 0.05;  // the room's door — both ends of "in"/"out" live here
const CORNER_X = 0.87;  // where the character rests after walking in
const CENTER_X = 0.50;  // recenter target — the middle of the stage

const WALK_IN     = {toX: CORNER_X, dur: 3.6};  // always starts at the door
const WALK_OUT    = {toX: DOOR_X,   dur: 2.8};  // always ends at the door
const WALK_CENTER = {toX: CENTER_X, dur: 2.4};  // recenter from wherever they are

let walkAnim = null;  // { t0, fromX, toX, dur, dir, marchAt } while animating, else null
let restX    = 0.5;   // resting X fraction (0=left edge, 1=right edge), persists between walks

function setWalkButtonsUI(dir) {
  // dir: 'in' | 'out' | 'center' | null (idle)
  const enter = $('bEnter'), exit = $('bExit'), center = $('bCenter');
  if (!enter || !exit) return;
  enter.disabled = dir === 'in';
  exit.disabled  = dir === 'out';
  enter.textContent = dir === 'in'  ? '🚪 Walking in…' : '🚪 Walk in';
  exit.textContent  = dir === 'out' ? '👋 Walking out…' : '👋 Walk out';
  if (center) {
    center.disabled  = dir === 'center';
    center.textContent = dir === 'center' ? '🎯 Recentering…' : '🎯 Recenter';
  }
}

// fromXOverride forces the animation's start point instead of "wherever the
// character currently rests" — used by walk-in so it always emerges from the
// door, even if the character was last left centered or mid-corner.
function startWalkAnim(toX, dur, dir, fromXOverride) {
  // Already walking this exact direction — ignore the repeat click.
  if (walkAnim && walkAnim.dir === dir) return;
  const fromX = fromXOverride != null ? fromXOverride : restX;
  // Already resting at the destination and not walking — nothing to do.
  if (!walkAnim && Math.abs(fromX - toX) < 0.001) return;

  walkAnim = {t0: performance.now(), fromX, toX, dur, dir, marchAt: -Infinity};
  setWalkButtonsUI(dir);
  if (rig.ready && rig.orchestra) { try { rig.orchestra.cue('march', {force: true}); } catch(e) {} }
}
// Walk in always emerges from the door (DOOR_X), regardless of where the
// character currently rests — "in through the door", not "slide over".
function startWalkIn()     { startWalkAnim(WALK_IN.toX,     WALK_IN.dur,     'in',     DOOR_X); }
function startWalkOut()    { startWalkAnim(WALK_OUT.toX,    WALK_OUT.dur,    'out'); }
function startWalkCenter() { startWalkAnim(WALK_CENTER.toX, WALK_CENTER.dur, 'center'); }

// Returns the character's current stage-X fraction (0..1) during a walk,
// null when at rest. On completion, commits toX into restX, clears the
// buttons/march state, and logs completion.
function tickWalkAnim(nowMs) {
  if (!walkAnim) return null;
  const t = (nowMs - walkAnim.t0) / 1000;
  // Re-cue march every 3s so the legs keep cycling through longer walks.
  if (rig.ready && rig.orchestra && t - walkAnim.marchAt >= 3.0) {
    try { rig.orchestra.cue('march', {prio: 3}); } catch(e) {}
    walkAnim.marchAt = t;
  }
  const k    = Math.min(1, t / walkAnim.dur);
  const frac = walkAnim.fromX + (walkAnim.toX - walkAnim.fromX) * easeInOutCubic(k);
  if (k >= 1) {
    restX = walkAnim.toX;
    const dir = walkAnim.dir;
    walkAnim = null;
    setWalkButtonsUI(null);
    if (rig.ready && rig.orchestra && rig.orchestra.stop) { try { rig.orchestra.stop('march'); } catch(e) {} }
    log(dir === 'in' ? 'walk-in complete — resting at the corner'
      : dir === 'out' ? 'walk-out complete — through the door'
      : 'recenter complete — resting at centre stage');
    return null;
  }
  return frac;
}

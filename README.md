# Phone -> livestream with a talking Rive avatar that answers comments

    Phone camera + mic ─┐
    Rive avatar (canvas)─┼─► publish.html composites one canvas ──WHIP──► MediaMTX ──WHEP──► view.html
    Avatar voice ────────┘   and mixes mic + avatar voice into one audio track
                               ▲
    comments (SSE) ─► chat server ─► reply (your keys → free keyless LLM gateways → rules, llm.js)
                        │              ─► Edge neural voice, EN/AR (→ espeak-ng fallback, edge.js)
                        └─► idle: recites a reference script on loop, interrupted the instant a comment arrives

Because the avatar is baked into the published video, every viewer sees it (view.html, VLC over RTSP/HLS, OBS...).

> **Two deploy modes now exist.** The diagram above is the original camera+MediaMTX setup (needs a
> UDP-capable host). For Railway or anywhere without UDP ingress, see **"Railway deploy: pure-virtual
> character, no MediaMTX / no UDP"** near the bottom - `view.html` renders the avatar locally per viewer
> instead of receiving baked video, so the whole thing runs as one plain-HTTPS container.


## What's new in this update: moderation, memory & framing fixes
- **Comments vs. script, cleanly separated, with a memory/approval queue.** The publisher sidebar now has
  a **Moderation & voice** panel: a reply mode with a new **"Hold every comment for my approval"** option
  (`repliesMode: 'review'`) that queues incoming comments in server-side memory (`chat/server.js`'s
  `pending` list) instead of auto-speaking them; a **"Don't let comments interrupt the script"** toggle
  (`scriptProtect`) so a comment arriving mid-line never cuts the script off - it's held in the same queue
  and only handled once the current line finishes. A **"Held for approval"** panel lists every pending
  comment with an editable reply box, **Approve & speak** (goes through the normal reply pipeline, spoken
  and captioned) and **Reject** (dropped silently) - `GET /pending`, `POST /pending/:id/approve|reject`.
- **Independent voice switches for script vs. replies.** `voiceScript` / `voiceReplies` (checkboxes in the
  same panel): when off, that channel still appears as a text caption in the log but is never synthesized
  or played as audio - e.g. run a silent script with spoken replies, or the reverse.
- **The two "stop it" switches are the same ones as before, just clearer:** *Script speaking: loop when
  idle* (was "Loop when idle") turns the reference script off entirely; *Stop commenting entirely* (was
  "Replies: off") turns comment replies off entirely. Nothing new here - just surfaced next to the new
  moderation controls instead of only in the quick bar.
- **Script changes are moderated too.** "Save script" is now **"Review changes…"**: it shows a plain
  old-vs-new diff of the lines and only POSTs to the server once you click **Apply** (or discard with
  **Cancel**) - so a script's topic can't change live without a deliberate accept step.
- **Hair now actually follows the head on more rigs.** `avatar.js`'s hair secondary-motion (a damped
  spring that lags the head bone) only matched one exact bone-naming scheme; it now also tries the common
  L/R, capitalized, and ponytail/braid/fringe/twin-tail variants, and logs exactly which bone names it
  found (or didn't) on load - check the browser console (`hair bones driven: ...`) after deploying. If it
  still says "none of the known candidate names exist", the hair bones need an **Export Name** set in the
  Rive editor matching (or added to) the list at the top of `_bindHair()`; that can't be guessed from code.
- **Fixed the "hand gets cut off" bug.** The canvas's padding around the character was sized once from the
  character's *rest pose*; a wave or a point-at-cursor gesture that reaches further than that guess drew
  the hand past the canvas edge, where it's clipped - looking like a separate piece cut off from the rest
  of the character. `avatar.js` now poses the arm at its wave-apex and both point-at-cursor extremes right
  at load, measures the real bounds, and grows the frame (never shrinks it) to fit before the first frame
  ever renders - watch for `reach probe: grew the avatar frame ...` in the console. This covers wave/point;
  it does not simulate the gesture-library poses (present/celebrate/shrug in `avatar-orchestra.js`), so
  check the console/preview after using one of those for the first time, and raise `VIEW.padTop/padLeft/
  padRight` in `avatar.js` by hand if you see clipping there.
- **Z-order checked, not the culprit.** `publish.html`'s `drawFrame()` always draws the avatar canvas last,
  on top of the camera/background, in both the camera-corner and centered layouts - so the hand-cut issue
  above was framing/clipping inside the avatar's own canvas, not a layering/z-index problem between the
  avatar and the background.
- **Known limits of this pass:** none of the above could be visually confirmed in a running browser from
  here (this environment has no display/WebGL/WASM canvas to actually load `avatar.riv` in) - the fixes
  are reasoned from the code paths (the actual `VIEW`/bounds math, the actual bone-lookup function) rather
  than from a screenshot. Deploy, hard-refresh, and check the browser console lines named above; they're
  written to tell you plainly whether each fix actually engaged on your rig.

## Earlier update: legs
- **The legs are on screen now.** In `avatar.riv` the artboard ends at y = 765, roughly mid-thigh, while the knees sit at ~775 and the
  shoes at ~860-885. Two things hid them: the canvas view stopped at the artboard's bottom edge, and the whole character sits
  under a *clipping mask* - the rectangle of the shape named `screen` (555 x 741 units, bottom edge at y = 764.5). Both are fixed:
  `avatar.js` grows the artboard downward at load (`AvatarInternals.LEGS.height`, 905; the origin is the artboard's top-left corner,
  so nothing else moves, and the canvas grows with it so the character stays as sharp), and **`web/avatar.riv` is patched**: the
  `screen` rectangle is now 892 units tall (bottom at y = 915) - 10 bytes changed, nothing else touched. If you re-export the .riv
  from Rive, make the `screen` rectangle (it's a clipping source) taller again, or the legs will be cut at the knees.
  Set `LEGS.enabled = false` for the old cut-off look.
- **Stale-file proof (v7.2).** `avatar.js` now checks the `avatar.riv` it downloaded and, if it is an older copy (mask still ends at the
  thighs), rewrites those 10 bytes in memory before loading it - so the legs show even if the server or a cache hands out an old file.
  The log says which case you're in: `avatar.riv legs mask: v5.1+ file (ok)` or `OLD file on the server - patched in memory`.
  The file is requested with a fresh cache-busting URL and `no-store` on every load.
- **Legs toggle + self-test (v7.1).** A *Legs: on/off* button appears in the dock in the Full body frame (remembered in this browser); off
  = the picture ends at the thighs with a soft fade and no floor shadow. The page also checks the actual pixels where the shoes
  should be: if the served `avatar.riv` still has the old mask you get `LEGS MASKED` in the Avatar line and log - that always means
  the old `web/avatar.riv` is still on the server (it is bind-mounted from `./web`, so copy the new file over it and hard-refresh).
  The half-body (desk) frame was mis-cropped (cut at the eyes); it now cuts at the belt line (`HALF.cutY = 700` in publish.html).
- **Full body is the default frame** (dock dropdown: *Full body (legs)* / *Half body (desk)*). The character stands on a floor line
  with a soft contact shadow that shrinks while it is in the air. Half body crops at the same waist as before.
- **New leg motions** (buttons under Motion): Weight shift, Bounce, Hop, Jump, March, Side kick, Stomp, Dance - plus legs added
  to Celebrate (two hops), Shocked (startle hop) and Foot tap (now shifts the weight). Waves shift the weight onto the far leg.
  The keyword auto-cues also learned: congrats/yay -> Celebrate, party/dance -> Dance, "waiting/hurry up" -> Foot tap.
- **Leg life while idle** (checkbox *Leg life while idle*): the unloaded foot lifts a touch when the weight shifts, and every
  7-17 s of idling a small foot adjustment / toe tap / weight shift plays - never while speaking.
- **Two bugs fixed on the way** (both invisible while the legs were hidden):
  1. `hips` is a *root bone* in this rig, but the driver asked for it as a plain node (`artboard.node('hips')`), which returns
     an object with junk x/y. Torso sway/bob is now written to the real root bone.
  2. The artist's `action` clip (used for the look-up / look-down poses and the head-tilt gesture) also keys the root node
     `boy1`: it sinks ~35 units and grows 5%. With legs on screen that made the whole character sink through the floor on
     every glance, so the root is pinned back each frame (`RigDriver.pinRoot()`, only when legs are shown).

### How the legs are driven
Each leg is a 3-bone IK chain (`thigh` -> `leg` -> `foot`) whose toe tip follows a node: `IK_R` / `IK_L`. The Orchestra writes offsets
to those nodes and to the `hips` root bone (channels in `NODE_CH`; down is +y, R foot "out" is -x, L foot "out" is +x):
`hips.x/hips.y` = torso only (feet ride along, legs stay straight), `squat` = hips down with the feet planted (knees bend),
`air` = the whole body up (jump), `IK_*.x/y` = one foot. **Design constraint you'll notice:** the legs are exactly straight at rest
(hip-to-ankle 172.9 = thigh 87.5 + shin 85.4), so a 1 px hip drop pushes each knee out ~12 px, and a 10 px foot lift ~30 px. That's
why leg motion is always deliberate; ambient torso motion (breath, nods) deliberately doesn't bend the knees. A sideways kick keeps
the leg straight by swinging the foot on an arc around the hip (`kick`).
Write your own with `rig.orchestra.defineGesture('name', {leg:'R'|'both', prio, dur, tracks:{'IK_R.y':[[t,px,T],...], squat:[...], air:[...]}})`.

`node tools/legs-check.mjs` runs every leg gesture headlessly against the real `avatar.riv` (no browser) and prints ankle pops,
foot planting, knee flare, and whether everything returns to rest; use it after editing gestures or swapping the .riv.

## Earlier update
- **Free neural voices, real Arabic, no API key** (`chat/edge.js`) - Microsoft's "Read Aloud" voices, picked
  per-language and choosable live from a dropdown (`GET /voices` / `POST /voice`); falls straight back to
  the old self-hosted espeak-ng voice if the unofficial endpoint is ever unreachable. See **Voice** below.
- **Free LLM reply chain with no signup** (`chat/llm.js`) - your own keys first if you set them, then three
  free keyless gateways, then built-in rules; never silent-fails to nothing. See **Replies** below.
- **Word-accurate lip-sync, letter by letter** (`web/lipsync.js`) - a full Arabic phoneme table (every
  letter's place of articulation, short/long vowels, tashkeel, sun-letter assimilation, MSA vs. Egyptian) plus
  an English digraph table, aligned to Edge's real per-word timestamps when available. See **How the avatar
  is driven**.
- **"Hi {name}!" the instant a comment lands** - the avatar waves and speaks a near-zero-latency ack while
  the real reply is still being generated, then speaks the full reply right after - no dead air waiting on
  an LLM round-trip. See **Event-driven interruption**.
- **Landscape layout that never needs scrolling to see the character** - on a landscape phone/tablet or a
  desktop window, the stage pins to one side via CSS (`position:sticky`) while only the controls column
  scrolls. See **Modern glass UI**.
- **Token-aware reply cache** - identical/near-identical comments ("hi", "price?") within ~45s reuse the
  last reply instead of re-spending LLM tokens (`REPLY_CACHE_MS` in `.env`).

## Run
    sudo apt install -y unzip
    unzip stream-avatar.zip && cd stream-avatar
    bash setup.sh                # or: bash setup.sh 192.168.1.150

First run builds the chat container (downloads Node, espeak-ng and the `ws` package, a few hundred MB).

## Use
1. Phone (same Wi-Fi): https://<VM_IP>:8443/publish.html -> accept the certificate warning -> Start streaming.
2. VM browser:         https://<VM_IP>:8443/view.html    -> accept the warning -> Start watching, tap Unmute.
3. Type a comment on either page. The avatar speaks its reply and it is heard/seen in the stream.

Publisher page controls: stage layout (camera-corner or centered-with-live-background) and the corner position/size within
it, a minimize button in the on-stage admin dock, "play avatar voice on this phone" (use headphones, otherwise the mic
re-hears it), whether the avatar follows and points at your mouse, which free voice to speak with, the voice's
volume and tone, and a live-editable reference script for the idle loop.

## Replies: your keys, then free keyless gateways, then rules (`chat/llm.js`)
Edit `.env` (created by setup.sh) to use your own keys, in priority order:

    OPENAI_BASE_URL=...          # any OpenAI-compatible endpoint (checked first)
    OPENAI_API_KEY=...
    OPENAI_MODEL=...
    GROQ_API_KEY=gsk_...
    GROQ_MODEL=openai/gpt-oss-20b     # current fast Groq production model
    ANTHROPIC_API_KEY=sk-ant-...
    AVATAR_PERSONA=a sarcastic pirate co-host

then `docker compose up -d`. If none of those are set (or all fail for a given comment), the chain falls
through to **three free, keyless gateways** with no signup (`llm7`, `ovh`, `kilo` - see `chat/llm.js` for
their rate limits), and only then to simple built-in keyword rules - so replies never go silent even with
zero configuration. `FREE_LLM=off` disables the free chain entirely (keys-or-rules only);
`FREE_LLM_ORDER=llm7,ovh,kilo` reorders/narrows it. Comments are treated as untrusted input; replies are
capped at ~30 words, and comments are limited to 200 chars and 1 per ~second per person.

**On model names:** Groq periodically retires model IDs (`llama-3.1-8b-instant` and
`llama-3.3-70b-versatile` were both retired 2026-08-16). `GROQ_MODEL` defaults to `openai/gpt-oss-20b`,
Groq's recommended fast replacement; check https://console.groq.com/docs/models before pinning a
different one, and https://console.groq.com/docs/deprecations if replies suddenly start failing.

## Event-driven interruption & the reference script loop
While nobody is chatting, the avatar doesn't just sit idle - it recites a short **reference script**
on repeat (the product pitch / "keep talking" loop), one line at a time. The moment a real comment

comes in:
1. The server bumps an internal generation counter and broadcasts an `interrupt` SSE event to every
   connected page - no polling, this fires the instant the comment is posted.
2. Every page's `Speaker.stop()` (`web/avatar.js`) cuts the currently-playing audio off immediately and
   snaps the mouth back to rest, exactly like a human stopping mid-sentence.
3. Any baseline line still queued or mid-synthesis on the server is dropped (checked against the same
   counter). **In parallel**, the server speaks a near-instant "Hi {name}!" acknowledgement (waving,
   no network call - it's a small rotating rules-based bank) while it asks the reply chain above for
   the real answer, so there's no dead air waiting on an LLM round-trip.
4. The full reply is told a greeting already happened (`greeted: true`, `llm.js`), so it never says
   hello twice, then it's spoken right after the ack with full lip-sync.
5. Once the reply finishes and nothing else is queued, the script quietly resumes from the next line
   after a short pause (`AVATAR_IDLE_MS`, default 1100 ms).

Edit the script live from the **"Reference script"** panel on `publish.html` (persona and the loop
on/off toggle are editable from the same panel, no server restart needed), or set it once via
`AVATAR_SCRIPT` (a JSON array of strings) and `AVATAR_LOOP=off` in `.env`.

## Modern glass UI, centered stage & live background
`publish.html` and `view.html` share a glassmorphism theme (`web/style.css` + `web/theme.js`): frosted
panels, a light/dark toggle in the top bar that's synced across both pages via `localStorage`, and a
floating "admin dock" over the video stage on `publish.html` with:
- **Center stage / Camera corner** - switches the composited output between the original camera-with-
  avatar-in-the-corner layout and a new layout where the **character is the main focus**, standing
  centered over an animated live background (a slowly drifting gradient + light blobs, redrawn every
  frame - not a static image), with an optional small camera picture-in-picture in the corner.
- A **background theme** picker (Aurora / Midnight / Sunset / Studio) for the centered layout.
- **Minimize** - shrinks the character to a small corner badge on demand (e.g. to let the camera or a
  product shot take over), with one click to restore it to full size.
- **Landscape layout, character always in view** - on a landscape phone/tablet or a desktop window
  (`web/style.css`, a `:has()`-scoped CSS grid, no markup restructuring needed), the stage pins to the
  left via `position:sticky` and only the right-hand controls column scrolls, so manipulating the
  character or watching it react to a comment never needs scrolling it off-screen to reach a control.
  Portrait phones keep the original single-column, top-to-bottom layout unchanged.

All of this only changes what's baked into the published video (`drawFrame()` in `publish.html`); WHIP/
WHEP streaming, the Rive rig, and lip-sync are unaffected.

## How the avatar is driven (from avatar.riv)
State machine `State Machine_call`:
- `Lipsync` (number): 0 rest, 1 A/E/I, 2 L, 3 Q/W, 4 TH, 5 N, 6 C/D/G/K/R/S/T.., 7 B/M/P, 8 F/V, 9 EE, 10 O, 11 U, 12 Ch/J/Sh
- `talk` (trigger): plays the ~12 s gesture animation, then back to idle

**Lip-sync (`web/lipsync.js`, driven from `web/avatar.js`'s `Speaker.say()`):** every Arabic letter is
mapped to its real place of articulation (bilabial, interdental, pharyngeal, emphatic/uvular spreading,
sun-letter assimilation, short/long vowels and tanween from the tashkeel marks, MSA vs. Egyptian dialect
overrides for ج/ث/ذ/ظ) plus an English digraph table, and the whole sequence is aligned to the *real*
voice audio: word-by-word when Edge TTS's own timestamps are available (`GET /audio/<id>/words`), or by
the audio's real pauses otherwise. The mouth is only ever open during the real voiced parts of the audio,
lips lead the sound by ~35ms the way real lips do, and every closure/shape is held long enough to
actually be seen at 30fps. `web/avatar.js` falls back to its own smaller built-in English+Arabic mapper
if `lipsync.js` fails to load, so a reply is never left mouth-frozen.

## Avatar movement (motion v6)

`avatar.riv` is a full-body rigged character. What moves it:
- **Mouth** - the `Lipsync` number input (0-12), driven from the reply text and the voice audio.
- **Gesture** - the first ~3.2 s of the rig's `action` animation (head tilt + small arm shift), layered on top of the idle loop by `avatar.js`.
  The state machine's own `talk` trigger is not used: it plays the whole 14 s animation, including a look-up at ~4-5.5 s.
  When the reply ends (or the gesture reaches 3.2 s) the pose is rewound to rest over 0.5 s, so nothing snaps or gets stuck.
- **Wave** - forward kinematics on the right arm's bones: `shoulder_R` (upper arm, 109 units), `arm_R` (forearm, 137), `hand_R` (hand, 82).
  You set joint angles in degrees; there is no IK involved.
- **Pointing** - the same three bones, aimed at the mouse pointer instead of at a fixed pose (see below).

**Why `avatar.riv` is patched.** The original file has a 3-bone IK constraint on the right hand. It always overrides the bones and picks an
unnatural elbow (up and inward), so a real wave (elbow out, forearm up) was impossible. The v5 `avatar.riv` differs from the original by
one property: that constraint's `strength` is 0 (6 bytes added). The legs' IK is untouched. At rest the arm now hangs in the artist's own
pose. If the page shows `old avatar.riv: arm/wave disabled`, the browser or the server still has the old file.

**How the wave is built** (`WAVE` in `web/avatar.js`, all numbers editable):
- `pose`: world angles in degrees of the raised arm (0 = right, 90 = down, +-180 = left, -90 = up). Default: upper arm -182 (straight out to
  the side), forearm -112 (up and slightly outward, hand clear of the face), hand -120.
- Raise: each joint follows a minimum-jerk curve; the shoulder starts first, then the elbow (`stagger.fore`), then the wrist (`stagger.hand`).
- Swing: forearm +-16 deg, wrist +-14 deg (trailing the forearm by `lag` = 0.06 s), upper arm +-2 deg, at 2.1 swings per second. The swing fades
  in only once the arm is up and fades out as it lowers (wrist first, shoulder last).
- Total default: raise 0.7 s, wave 2.0 s, lower 0.65 s. If speech ends early the arm lowers in 0.4 s from wherever it is.

**Wave controls** (panel on publish.html): sliders and number boxes for every value above, plus Play wave, Reset and Copy values. Settings are
kept in this browser. Copy values gives a `const WAVE = {...}` block to paste over the constant in `web/avatar.js` for a permanent change.

## The frame around the character
`AvatarInternals.VIEW` is the empty space kept around the artboard, as a fraction of the artboard's own size:
`padLeft 0.62`, `padRight 0.42`, `padTop 0.42`, `padBottom 0.03`. It is deliberately generous, so nothing the character
does is cut off at the canvas edge - an arm straight out to the side, a hand pointing above the head, a celebrate, a wave.
The avatar canvas keeps its height and works out its own width from this, and publish.html scales the whole frame into the
video, so a bigger frame shows **more of the character's reach, not a bigger character**; the Size slider (default 66) sets how
much of the picture it takes. To crop in tighter, lower those four numbers.

## Pointing at the mouse
Two independent checkboxes on publish.html, both on by default:
- **Follow the mouse with the eyes and head** - the existing Orchestra gaze, now switchable. Off, the avatar looks around on its own.
- **Point at the mouse with the arm** - the right arm is aimed at the pointer with the same forward kinematics as the wave.

The direction from the character's shoulder to the pointer becomes a world angle, in the convention used by the
`POINT` constant in `web/avatar.js`: **90 = arm straight down, 180 = straight out to the side, 270 = straight up**.
- `pivot` - where the shoulder sits in the page, in -1..1 page coordinates; the angle is measured from there.
- `range` - how far the arm may swing (default 62 to 288). A pointer outside it is clamped to the nearest end, never flipped,
  so the arm cannot swing through the body. The right arm cannot point far to the screen-right; it lowers instead.
- `elbow` / `wrist` - the arm keeps a slight bend so it reads as an arm and not a stick.
- `follow` - smoothing; the hand eases toward the pointer instead of snapping.
- `raise` / `drop` - the arm blends up from, and back down to, the rest pose. It is never left hanging.
- `idle` - after this many seconds with no pointer movement the arm goes back down by itself; it lifts again on the next move.

A wave always takes the arm: while one is playing, pointing fades out and returns afterwards. Speech beats are kept off the
arm that is pointing. Sliders for all of the above are under **Pointing controls**, with Copy values, like the wave.
On a touch screen, dragging a finger does the same as moving the mouse.

**When it moves**
- The pointer moves: the eyes follow it, and the arm points at it (both switchable).
- A comment arrives (from any page): wave right away ("Wave as soon as a comment arrives").
- The avatar starts a reply: wave (if not already waving) + gesture.
- The last queued reply finishes: the reply's gesture and wave ease out. A wave started by a comment plays out on its own.
- If the browser keeps the AudioContext suspended, the reply still ends on a wall-clock timer (duration + 1.5 s).

The blink and small eye glances belong to the always-running idle loop, not to the gesture.

## Gesture library and buttons
Every gesture is now on its own button on publish.html, under **Motion**, in addition to the existing wave and the
head/arm gesture:

| Button | What it does |
|---|---|
| Glasses push | Right hand touches the bridge of the glasses; narrows the eyes slightly. |
| Lean in | The avatar's own overlay box grows about 28% and the camera behind it softens a little for ~2 s, eyes look straight at the viewer instead of wandering, then it eases back. This is an overlay/compositing effect, not a bone gesture - see "Lean-in" below. |
| Shocked | Wide eyes, small pupils, mouth open, both hands up, a small screen jolt. |
| Thinking | Elbow up, hand toward the chin, head tipped, eyes wander up-left then settle - built from plain keyframes, so it works even on a rig with no chin prop node. |
| Weight shift / Bounce / Hop / Jump / March / Side kick / Stomp / Dance | The leg gestures (see "What's new: legs"). Foot tap and Side kick / Weight shift / Stomp also work mirrored: `rig.orchestra.cue('kick', {side: 'L'})`. |
| Nod / Shake head / Shrug / Present / Celebrate / Foot tap | The rest of `avatar-orchestra.js`'s built-in gesture library (`GESTURES` in that file), now wired up instead of only callable from the console. |

They all go through `rig.orchestra.cue(name)` (Lean in is `rig.leanCue()`, a separate mechanism - see below) and follow the
same rules as any other Orchestra gesture: minimum-jerk motion, C2-continuous retargeting, graceful degradation if a bone or
node this rig doesn't have is referenced, and no leftover pose once it ends (the fix described further down).

### Lean-in
Unlike the other gestures, "lean in" doesn't move any bones - a Live2D/Spine-style character occupies the whole frame and
can be scaled/translated as a unit, but here the avatar is a small overlay in the corner of the phone's real camera feed, so
there is no single "root bone" to scale. `rig.leanAmount` (0..1, in `web/avatar.js`) is read every drawn frame by
`publish.html`: the avatar's own box grows (`LEAN.scale`) and the camera picture behind it gets a light blur (`LEAN.blur`) for
the push-in read, while the eyes are pointed straight at the viewer instead of wandering. It is its own small state machine
(raise/hold/lower, easing, restartable, cancellable) parallel to wave/gesture/point, exported as `AvatarInternals.LEAN`.

### Auto-playing a gesture from what the avatar is about to say
The **"Auto-play a matching gesture for keywords in replies"** checkbox (on by default) scans the reply text the moment a
reply starts speaking - the same moment its wave/head-gesture would start - for a short list of phrases, and cues the first
matching gesture (`SPEECH_CUES` in `publish.html`, checked in this priority order so only one extra gesture plays per line):

| Says something like... | Plays |
|---|---|
| "spec", "discount", "warranty", "material", "30% off" | Glasses push |
| "secret", "code", "exclusive", "only ... to the X people watching" | Lean in |
| "sold out", "out of stock", "units left", "wow", "no way" | Shocked |
| a question mark, "let me think", "good question" | Thinking |

This works for both the rule-based replies and Claude's AI replies, since it reads the reply text the server already sends -
no server changes were needed. It is a client-side approximation of a voice-recognition / keyword trigger, not literal speech
recognition: it reads the same text that is about to be spoken, which is exact and has no false negatives from mishearing,
but it can't fire mid-sentence at the exact word - it fires once, right as the line starts.

**What from the four-gesture brief this build does NOT do, and why:** this project has no Shopify/TikTok Shop webhook, no
Stream Deck, and no Twitch channel points or TikTok gifts integration - none of that infrastructure exists here, and adding
it is out of scope for a local demo. The buttons and the keyword auto-cue above are this project's equivalent trigger
surface: a real e-commerce/channel-points integration would call `rig.orchestra.cue('surprise')` (or POST to a small new
server endpoint that does the same over a WebSocket) from wherever that event arrives - happy to wire that up if you tell me
which platform's webhook you're integrating with. An idle-timeout that auto-plays "Thinking" after a few seconds of silence
(as in the brief's state-machine idea) was deliberately left out for now: with a chat avatar that goes idle between comments
far more than a talking-head does, firing it automatically risked being exactly the repetitive "constant gesture" the wave/
point/pose logic elsewhere in this file was written to avoid. Easy to add as an opt-in checkbox if you want it.

## Testing motion without streaming
Open `https://<VM_IP>:8443/publish.html`. The avatar shows on a dark preview even with the camera off.
- **Test gesture**, **Test wave**, **Stop motion** buttons trigger each movement directly. The "Motion" line shows the live state
  (`body: idle + pointing + leaning in + speaking` and so on). **Stop motion** also lowers the pointing arm, eases any lean
  back out, and takes off any face pose still held.
- Move the mouse around the page: the head and eyes follow, and the arm points where you are.
- The gesture library buttons (Glasses push, Lean in, Shocked, Thinking, Nod, Shake head, Shrug, Present, Celebrate, Foot
  tap) each play one gesture on its own, so you can preview and pick which ones fit your character before wiring them to
  keywords or, for a real integration, to a webhook.
- Type a comment: the avatar waves, then speaks the reply through this device's speakers and moves. Untick a checkbox to test movements separately.
- Tap anywhere on the page once so the browser allows sound.

## Orchestra (ambient life + speech-synced body language)
`web/avatar-orchestra.js`, loaded on `publish.html` before `avatar.js`, adds a second motion layer that runs
every frame on top of the state machine and the legacy gesture/wave code — it never replaces them:
- Always on: breathing, weight-shift sway, blinking, and idle gaze (follows your cursor on the publisher page;
  wanders on its own after ~6 s of no movement).
- During a reply: `Speaker.say()` feeds it the same voiced/silent envelope already used for lip-sync
  (`web/avatar.js`'s `analyzeVoicing`), so small head-tilt/chest/arm beats land on the real stressed
  syllables of the synthesized voice, not a fixed rhythm.
- It writes bone rotations as *deltas on top of whatever is already there that frame*. Concretely: the
  legacy `gesture()`/`wave()` still own `shoulder_R`/`arm_R`/`hand_R` outright (they write absolute angles
  after Orchestra runs, so they always win); Orchestra's own gesture library (`nod`, `shrug`, `celebrate`,
  `present`, `glasses`, ...) is loaded but not wired to any button, to avoid two systems fighting over the
  same arm. Call `rig.orchestra.cue('nod')` (etc., see `avatar-orchestra.js`'s `GESTURES` table) from the
  console or a new button if you want to trigger one manually.
- Poses (a look-up, an eye glance) are frames of the artist's clips blended on top of the state machine. Rive's `apply(mix)`
  only ever moves a bone **toward** a pose, so a bone that the state machine does not rewrite every frame used to keep the last
  value it was given: the face could stay looking up after the gesture that caused it was long over. Each pose now remembers how
  much of it is on the rig and blends the clip's neutral frame back in as soon as it is no longer wanted, over about 0.2 s. No
  movement is left switched on.
- Everything degrades gracefully: the `hips` root bone and the `IK_R`/`IK_L` foot nodes are bound (probed at load, dropped if they don't move the body); this rig has no
  per-viseme animation clips, and no `neck`/`palm_*` bones — Orchestra only drives what actually exists
  (check the browser console after load for a one-line summary), and the mouth keeps being driven by the
  existing `Lipsync` state-machine number, unchanged.
- If `avatar-orchestra.js` fails to load or throws, `rig.orchestra` stays `null` and everything behaves
  exactly as before (no code path depends on it being present).

## Runtime files
`web/vendor/canvas_advanced.mjs` + `rive.wasm` are the Rive low-level canvas runtime (@rive-app/canvas-advanced), bundled so nothing loads
from a CDN. nginx must serve `.mjs` as JavaScript (already set in nginx.conf).

To use another .riv: keep (or rename in avatar.js) the state machine `State Machine_call` with inputs `Lipsync` and `talk`, and, for
code-driven bones like `IK_handR`, export their names in the Rive editor (Hierarchy -> right-click -> Export Name).

## Voice
By default the voice is **Edge's free neural TTS** (`chat/edge.js` - real Microsoft "Read Aloud" voices,
no API key, genuine Arabic voices), shaped in three places, with the old self-hosted espeak-ng voice kept
as an automatic, zero-config fallback if the unofficial Edge endpoint is ever unreachable.

**Which voice speaks** - choosable, not cloned: pick a name from the **Voice** panel on `publish.html`
(dropdowns for English and Arabic; `GET /voices` lists the free catalog, `POST /voice {en, ar}` sets it
live, no restart) or set the defaults in `.env`: `TTS_VOICE_EN_EDGE=en-US-AriaNeural`,
`TTS_VOICE_AR_EDGE=ar-EG-SalmaNeural` (Egyptian; `ar-SA-HamedNeural`/`ar-SA-ZariyahNeural` for Saudi). There
is no reference-audio upload or voice cloning in this project - "choosable" means picking one of Edge's
own named voices, nothing more. `TTS_ENGINE=espeak` forces the old offline-only path if you'd rather not
depend on the unofficial endpoint at all; `AVATAR_AR_DIALECT=msa` (default `egy`) switches the *lip-sync*
letter table (not the voice) between Modern Standard and Egyptian pronunciation rules.

**The espeak-ng fallback** (`chat/server.js`, all overridable in `.env`): `TTS_VOICE_EN=en-us+f3`,
`TTS_VOICE_AR=ar+f3`, `TTS_SPEED=138` words per minute, `TTS_PITCH=72`, `TTS_AMP=190` (of 200) and
`TTS_GAP=4` (a 40 ms pause between words). If a voice variant is not installed, the base voice is used
instead.

**In the browser** (`VOICE` in `web/avatar.js`), before the voice is mixed into the stream: a high-pass, a low-shelf lift for
body, a lift around 2.6 kHz so the consonants carry, a cut around 4.2 kHz to take off the metallic rasp, a low-pass, a
compressor to even out loud and quiet parts, and a volume boost (1.9x by default) so the avatar is clearly audible next to the
microphone. The **Voice** panel on publish.html has Volume, Warmth, Clarity, "Take off the rasp", both switches, and a
**Test voice** button that replays the last reply with the current settings - so you can A/B it without sending a new comment.

## Troubleshooting
- Camera blocked: use the https:// URL and accept the certificate warning first.
- Black video / stuck on "Connecting": UDP 8189 can't reach the VM. VMware adapter must be Bridged (your real Wi-Fi/Ethernet adapter). If ufw is on:
  sudo ufw allow 8443/tcp && sudo ufw allow 8189/udp && sudo ufw allow 8189/tcp
- Avatar doesn't talk: check the "Avatar" line on publish.html says "ready" and you tapped Start streaming (it only speaks while live). Logs: docker compose logs -f chat
- Avatar's voice sounds like the old robotic one even though Edge is enabled: Edge's endpoint is
  unofficial and can be blocked by some networks/firewalls - check `docker compose logs -f chat` for
  "Edge TTS failed"; it's falling back to espeak-ng automatically, which is expected behavior, not a bug.
- Slow phone / choppy video: pick 360p or 720p and make the avatar smaller. The phone renders the avatar and composites everything itself.
- Logs: docker compose logs -f mediamtx ; Stop: docker compose down

## Notes
- No authentication anywhere: anyone on the network can publish, read and comment. Test only. Add auth before exposing it.
- Keep the publisher tab open and the screen on. Mobile browsers pause the camera and the avatar when the page is hidden.
- The Rive runtime (web/vendor) is bundled so nothing loads from a CDN.
- Both Edge TTS (`chat/edge.js`) and the free LLM gateways (`chat/llm.js`) are unofficial/best-effort
  third-party services with no SLA - that's the tradeoff for "free, no signup". Viewer comments are sent
  to whichever free LLM gateway answers; set your own `OPENAI_*`/`GROQ_API_KEY`/`ANTHROPIC_API_KEY`, or
  `FREE_LLM=off`, if that's not acceptable for your use case.

## Railway deploy: pure-virtual character, no MediaMTX / no UDP

The setup above (`docker-compose.yml`, `chat/Dockerfile`, `nginx.conf`) bakes the avatar into one WebRTC
video track over WHIP, which needs MediaMTX and UDP - fine on a VM you control, a dead end on Railway
(no UDP ingress). The **root `Dockerfile`** in this repo is a second, independent deploy target: it drops
video entirely. Every viewer's browser renders its own copy of the Rive avatar locally (`web/view.html`)
and reacts to small JSON events broadcast over the same `/events` SSE stream the chat already uses -
gesture, background theme and layout changes included. One Node process serves both the static `web/`
files and the API/SSE routes, so it's one container, one port, one Railway service.

```
Admin (publish.html) ──POST /gesture,/background,/motion,/speech/pause,/script,/voice,/pending/*,/chat──►
                                                    chat server (server.js)
                                                          │
                                                   SSE broadcast /events
                              ┌───────────────────────────┼───────────────────────────┐
                        viewer's browser              viewer's browser           another viewer...
                   (Rive avatar rendered            (same, independent
                    locally, view.html)               local render)
                              │ fetches /audio/<id> for the spoken line, in sync with the event
```

### Deploy steps
1. **Push this repo to GitHub.** Railway builds straight from a GitHub repo; it does not need a zip upload.
   From the top of this project folder (the one containing `Dockerfile`, `web/`, `chat/`):
   ```
   git init
   git add -A
   git commit -m "stream-avatar: Railway-ready event-driven avatar"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Railway → New Project → Deploy from GitHub repo**, pick that repo. Railway finds the root `Dockerfile`
   and `railway.json` automatically (build: Dockerfile, healthcheck: `/health`) - no other config needed.
3. **Set environment variables** on the Railway service (Settings → Variables). At minimum:
   - `ADMIN_TOKEN` - a long random string. **Set this before going live** - without it every admin
     endpoint (`/script`, `/voice`, `/pending/*/approve|reject`, `/gesture`, `/background`, `/motion`,
     `/speech/pause|resume`, `/state`) has no auth at all (dev-mode fallback). Paste the same value into
     `publish.html`'s new "Admin access" panel (stored in the browser's `localStorage`, sent as
     `Authorization: Bearer <token>`).
   - Optional LLM keys (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_*`) - without any, replies fall back
     to the free keyless gateways, then built-in rules (see `chat/llm.js`).
   - Anything from the existing `.env`/`docker-compose.yml` list (`AVATAR_PERSONA`, `AVATAR_SCRIPT`,
     `AVATAR_LOOP`, `AVATAR_REPLIES`, `TTS_ENGINE`, voice choices, etc.) - all still read the same way.
   - `GESTURE_TEST_LIMIT` (default `5`) - how many free, unauthenticated "test the character" gesture
     triggers a viewer gets from `view.html`'s test row / `POST /gesture/test`, per IP, before a 429.
   - `AVATAR_BACKGROUND` (default `aurora`) - the theme new viewers start on; one of `aurora`, `midnight`,
     `sunset`, `studio`, `neon`, `bokeh`.
4. **Generate a public domain** (Settings → Networking → Generate Domain). Railway terminates HTTPS for
   you - no certs to manage, unlike the LAN setup's self-signed `certs/`.
5. Open `https://<your-app>.up.railway.app/publish.html` to run the show, and share
   `https://<your-app>.up.railway.app/view.html` with viewers. `index.html` links both.
6. **Redeploys**: `git push` to the connected branch; Railway rebuilds the Dockerfile automatically.

### What you lose vs. the MediaMTX setup
No real camera/webcam picture rides along - viewers see the animated character only, not the publisher's
face. If you want both, keep the original `docker-compose.yml` stack (camera + avatar composited, needs a
UDP-capable host such as your own VM/Oracle box) running alongside this Railway deployment; they don't
conflict, since Railway's copy never touches MediaMTX/WHIP at all.

## The queue, moderation and toggles, in depth

Everything the avatar ever says passes through one in-memory FIFO (`queue` in `chat/server.js`) drained by
a single `pump()` loop - so the avatar is provably never speaking two things at once, and every line (script
or reply) is fully synthesized and spoken before the next one starts.

**What can put something in the queue:**
- The **baseline script loop** (`scheduleBaseline()`), one line at a time, only while `loopEnabled` is on
  and the queue is otherwise empty - each queued baseline line is tagged with the `generation` counter it
  was scheduled under, so it silently evaporates if a real comment interrupts before it's spoken.
- A **comment that's allowed to speak immediately** (`admitComment()`) - either a fresh `POST /chat` that
  passes the current `repliesMode`/`scriptProtect` gates, or the admin clicking **Approve & speak** on a
  held item (`POST /pending/:id/approve`), which always bypasses the gates (an explicit human decision
  overrides the automatic ones).

**What diverts a comment into the `pending` review list instead** (`addPending()` - capped at 40, oldest
dropped first, broadcast to every admin panel over the `pending` SSE event):
- `repliesMode === 'review'` - "hold every comment for my approval", set from the Moderation panel or the
  quick-bar **Replies** dropdown.
- `scriptProtect` is on **and** a script line is actively being spoken (`speakingBaseline`) - the comment
  waits for the current line to finish rather than cutting it off.
- The new global kill switch, `speechPaused` (`POST /speech/pause` / `/speech/resume`, wired to
  publish.html's **Stop talking** button) - while paused, *every* comment is held, regardless of
  `repliesMode`, and every connected viewer's audio is cut immediately (`generation++`, queue cleared,
  `interrupt` broadcast). This is the "admin toggled it off" switch: comments keep arriving and appear in
  the panel, nothing is ever auto-spoken, until the admin flips it back or approves individual items.
- `repliesMode === 'mention'` is different: it doesn't hold anything, it just silently drops comments that
  aren't questions/@-mentions/greetings (`shouldReply()`) - nothing lands in `pending` for those.
- `repliesMode === 'off'` similarly drops every comment before it reaches either the queue or `pending`.

**Resolving a held comment** (`POST /pending/:id/approve` with an optional edited `text`, or
`/reject`): approve always speaks it - through the *exact* same pipeline as a live comment (quick "Hi
{name}!" ack spoken instantly while the real reply generates in parallel, then the full reply, AI-generated
or your hand-edited text verbatim) - a manual reply is simply `approve` with `text` set to whatever the
admin typed instead of the original comment/AI suggestion. Reject drops it silently, nothing is ever spoken
or logged as an avatar line.

**Interruption is instant and global, not polled.** The moment a comment is admitted (`admitComment()`):
`generation` is incremented, any in-flight script line or reply is invalidated (every async step checks
`myGen !== generation` before it's allowed to broadcast audio), a `interrupt` SSE event fires to every
connected page (cutting whatever's currently playing there, mouth snapping to rest), and any queued
baseline lines are dropped. This is why a real comment always wins the moment it's allowed to speak at all -
there's no polling loop checking "is anyone talking", it's event-driven end to end.

**`GET /state`** (admin-only) gives the whole picture in one call - queue depth (and how much of it is
baseline vs. real), whether something is speaking right now, the full `pending` list, current background/
motion/toggle state, and how many viewers are connected (`clients.size`) - what `publish.html`'s new
"Queue" readout under **Held for approval** polls every few seconds.

## Motion engine v7.3: energy control, mobile perf tier, camera parallax

**Energy/mood knob.** `rig.setEnergy(level, valence?)` (avatar.js) drives the character's overall
"how animated" feel from a single 0..1 number - it forwards to `Orchestra.setMood({arousal, valence})`,
which every ambient layer already reads (breathing rate/depth, sway amplitude, blink rate, gesture
speed - see `arousal` throughout avatar-orchestra.js). view.html now calls it automatically: energetic
while replying to a real comment, a touch calmer for the idle baseline script, settling back to a quiet
baseline once speech ends.

**On real Rive Data Binding.** The current `avatar.riv` only exposes one state-machine input,
`Lipsync` - there's no ViewModel/blend-tree authored in it, so today's ambient motion is necessarily
CPU-side JS math (Orchestra), not GPU-composited state-machine blending. That has to be authored in the
Rive Editor (a number property bound to blend-state thresholds) - it isn't something that can be added
by patching the exported `.riv` from code. `setEnergy()` is written to be forward-compatible with that:
at load, avatar.js records any state-machine number input besides `Lipsync` into `rig.extraInputs`;
`setEnergy()` already writes the same value into any input whose name looks like energy/mood/intensity.
Add that input + blend states in the Editor later and this rig picks it up with zero code changes -
whatever part of the blend it covers moves off JS math onto Rive's own GPU compositor for free.

**Mobile performance tier.** `detectPerfTier()` (avatar.js) reads `pointer: coarse`, `hardwareConcurrency`,
`deviceMemory` (where the browser exposes it) and `navigator.connection.saveData` once at load - no
benchmarking. On a "lite" device: the two purely-cosmetic Orchestra layers (`secondary` arm-lag spring,
`com` center-of-mass hip drift) are switched off, and Orchestra's own step rate is capped to ~30Hz (the
character still draws every frame; the ambient bone values just hold between steps, the same trick used
for other expensive per-frame systems). Lip-sync, gaze, blink, breathing and gestures are untouched.

**Camera parallax.** `stage-bg.js`'s `StageBackground` now drifts its own canvas a few % via a CSS
`transform` (compositor work, not a redraw) - mouse position on desktop (`pointer: fine`, on by
default), device tilt on phones via `enableDeviceTilt()`. iOS gates `deviceorientation` behind a
permission prompt that must start from a tap, so view.html shows a small "🧭 Tap for tilt" badge on
coarse-pointer devices that calls it and then hides itself; Android attaches immediately, no prompt.

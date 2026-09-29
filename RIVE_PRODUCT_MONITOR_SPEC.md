# Wall-monitor product prop — Rive authoring spec ("Level 3")

This is the spec for adding an **in-world** product prop to `hawkins-room.riv` — a wall
monitor that lights up and shows the product inside the scene itself, instead of (or in
addition to) the HTML overlay card. Author this in the Rive editor against a copy of
`hawkins-room.riv`; nothing here can be done by editing the `.riv` binary directly.

Everything on the avatar/HTML side (gestures, room lighting pulses, the animated card)
already works today without this — see `web/js/10-product.js` and `web/product-card.js`.
This document only covers the new in-world prop.

## 1. Artboard changes

Add a new prop group to the existing `hawkins-room` artboard (don't make a separate
artboard — it needs to composite behind/around the existing candles, TV, lamps):

- A monitor body (screen + bezel) placed on an empty section of wall.
- A screen-content layer, split into:
  - `MonitorGlow` — a solid fill or gradient behind the text, driven by opacity/brightness.
  - `MonitorProductName` — a **text run** (Rive text, not an image) for the product name.
  - `MonitorProductPrice` — a text run for the price.
  - `MonitorProductNote` — a text run for the note (hide/collapse when empty — see State
    notes below).
- Optional: a subtle CRT scanline or static-noise overlay layer (`MonitorNoise`) used only
  during the `idle`→`reveal` transition, for the "screen flickering to life" beat.

Keep every screen-content layer inside its own group so the state machine can drive group
opacity independently of the monitor body (the body/bezel should always be visible; only
the screen content should animate in/out).

## 2. Inputs (State Machine: name it `MonitorSM`, mirroring `TunnelBoolean` etc. naming)

| Input name          | Type    | Purpose                                                                 |
|----------------------|---------|--------------------------------------------------------------------------|
| `ProductVisible`     | Boolean | Mirrors the HTML card's visible flag. `true` → play reveal → showing.  |
| `ProductBestSeller`  | Boolean | When true, `showing` uses the hotter/brighter loop (see State notes).  |
| `ProductPulse`       | Trigger | Fire once per push, even if `ProductVisible` was already `true` (i.e. swapping products) — replays the flicker/reveal beat without a full hide/show. |

Three inputs, deliberately matching the three fields the server already tracks
(`visible`, `bestSeller`, and "a push just happened") — no new server work needed beyond
wiring these three through `wireToRig`-style code (see §4).

## 3. States & transitions

```
        ProductVisible=false
   ┌───────────────────────────────┐
   │                                ▼
┌──────┐  ProductVisible=true   ┌─────────┐  (anim ends)   ┌─────────┐
│ idle │ ─────────────────────▶ │ reveal  │ ─────────────▶ │ showing │
└──────┘                        └─────────┘                └────┬────┘
   ▲                                                             │
   │              ProductVisible=false                           │
   └─────────────────────────────────────────────────────────────┘
                          (via `hide` state, below)

showing ── ProductPulse (trigger) ──▶ pulse ── (anim ends) ──▶ showing
showing ── ProductVisible=false ──▶ hide ── (anim ends) ──▶ idle
```

- **idle** — screen off. `MonitorGlow` opacity 0, text layers hidden/collapsed. Static,
  no timeline needed (or a very slow ambient CRT-off flicker, optional, ~0.5s loop at low
  amplitude — keep it subtle, this is a background prop).
- **reveal** (~0.6–0.9s, one-shot) — screen "powers on": `MonitorNoise` flashes briefly,
  `MonitorGlow` opacity ramps 0→1 with 1-2 flicker dips (classic CRT power-on), text runs
  fade/scale in slightly after the glow settles (stagger name → price → note by ~0.1s each,
  matching the HTML card's cascade). Transitions to `showing` automatically on completion.
- **showing** (looping) — steady state. Two variants selected by `ProductBestSeller`:
  - normal: gentle glow breathing (opacity 0.92↔1.0, ~3s period).
  - best-seller: same breathing plus a warm color-temperature shift and a faster,
    slightly brighter pulse (~1.8s period) — reuse the same rig, just tighten the timing
    and add a color keyframe, so you're not maintaining two separate animations.
- **pulse** (~0.4s, one-shot) — a single brighter flash + tiny scale-bump on the whole
  screen-content group, for re-emphasizing the same product without a full hide/reveal
  (e.g. the streamer says the price again). Returns to `showing` on completion.
- **hide** (~0.4–0.5s, one-shot) — reverse of reveal: text fades first, then glow drops to
  0 with a quick static flicker. Transitions to `idle` on completion.

## 4. Wiring it into the existing JS (once the `.riv` is authored)

`hawkins-room.js` already has the pattern for this — every existing prop (candles, lamps,
the TV) is just a named input fired/toggled through `room.fire()` / `room.setBool()` /
`room.toggleBool()`, discovered automatically from the `.riv`'s state machine and listed in
`BUTTON_GROUPS`. Once `MonitorSM`'s three inputs above exist in the file, add one group:

```js
// in hawkins-room.js, alongside the other BUTTON_GROUPS entries
{
  label: '🖥 Product monitor',
  items: [
    { name: 'ProductVisible',    label: '🖥 Monitor on/off', kind: 'bool'    },
    { name: 'ProductBestSeller', label: '🔥 Best-seller glow', kind: 'bool' },
    { name: 'ProductPulse',      label: '✨ Re-pulse',        kind: 'trigger' },
  ],
},
```

That alone gets it into the manual test grid. For it to react automatically to the same
push/hide/best-seller events the HTML card reacts to, mirror the three calls inside
`pushProduct()` / `hideProduct()` in `web/js/10-product.js`, right next to the existing
`reactRoom()` call:

```js
// inside reactRoom(), after the candle/lamp flicker:
if (room.setBool)  room.setBool('ProductVisible', true);
if (room.setBool)  room.setBool('ProductBestSeller', bestSeller);
if (room.fire)      room.fire('ProductPulse');
// and inside hideProduct(): room.setBool('ProductVisible', false);
```

Setting the text runs (`MonitorProductName` / `MonitorProductPrice` / `MonitorProductNote`)
from JS uses Rive's text run API, the same shape already used nowhere else in this repo
(everything else here is numeric/boolean/trigger inputs) — roughly:

```js
const artboard = room._artboard; // however HawkinsRoom exposes it internally
artboard.textRun('MonitorProductName').text  = name;
artboard.textRun('MonitorProductPrice').text = price;
artboard.textRun('MonitorProductNote').text  = note;
```

(Exact accessor depends on the Rive runtime version pinned in `web/vendor/` — check
`canvas_advanced.mjs`'s exposed API before wiring this part; the state-machine inputs above
don't depend on that detail and can be authored and tested standalone in the Rive editor
first.)

## 5. Suggested build order

1. Author the artboard layers + `MonitorSM` states/inputs in the Rive editor, test entirely
   inside the editor's state machine preview (no code needed for this step).
2. Export, drop into `web/hawkins-room.riv`, add the `BUTTON_GROUPS` entry above, confirm
   the three inputs show up in the room's manual test grid in `publish.html`.
3. Wire the three inputs into `reactRoom()`/`hideProduct()` in `10-product.js`.
4. Wire the text runs last — it's the part most likely to need runtime-specific glue code.

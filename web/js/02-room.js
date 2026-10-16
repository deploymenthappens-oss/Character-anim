// =====================================================================
//  02-room.js — Hawkins room (Rive background).
//  This is the patch you supplied, merged directly into ensureRoomLoaded
//  (rather than monkey-patching window.ensureRoomLoaded from the outside)
//  since this file now owns that function outright.
// =====================================================================
const room = new HawkinsRoom.HawkinsRoom();
let roomLoading = null;

function ensureRoomLoaded() {
  if (roomLoading) return roomLoading;
  $('roomInputStatus').textContent = 'loading…';
  const q = QUALITY[$('quality').value] || QUALITY['720'];
  const width = Math.min(1920, q.w), height = Math.min(1080, q.h);
  roomLoading = room.load({src: 'hawkins-room.riv', width, height})
    .then(() => {
      populateRoomDropdown();
      buildRoomGrid();
      syncUpsideDownBadge(!!(room.getBool && room.getBool('TunnelBoolean')));
      // Ensure DemVisible starts false (gate is closed — Demogorgon won't
      // enter just because TunnelBoolean is toggled on).
      if (room.setBool) room.setBool('DemVisible', false);
      syncDemVisibleBtn();
      $('roomInputStatus').textContent = 'ready';
      room.autopilot(true);
      log('Hawkins room loaded (' + Object.keys(room.inputs).length + ' inputs, ' + width + 'x' + height + ') | DemVisible gate: closed');
    })
    .catch(e => { $('roomInputStatus').textContent = 'failed to load'; log('HAWKINS ROOM ERROR: ' + e.message); });
  return roomLoading;
}

// ── per-group button grid — mirrors whatever the .riv actually exposes ─
function buildRoomGrid() {
  const grid = $('roomButtonGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const groups = window.HawkinsRoom && HawkinsRoom.BUTTON_GROUPS;
  if (!groups) return; // hawkins-room.js not loaded yet

  const filtered = groups.filter(g => !g.label.includes('Tunnel')); // Tunnel has its own full-width button

  for (const group of filtered) {
    const heading = document.createElement('p');
    heading.className = 'note';
    heading.style.cssText = 'margin:8px 0 3px;font-weight:600;';
    heading.textContent = group.label;
    grid.appendChild(heading);

    const btnRow = document.createElement('div');
    btnRow.className = 'gesture-grid'; // reuse the character-gesture grid style
    grid.appendChild(btnRow);

    for (const item of group.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      btn.dataset.inputName = item.name;
      btn.dataset.inputKind = item.kind;
      btn.title = item.kind === 'bool' ? `Toggle ${item.name} on/off` : `Fire trigger: ${item.name}`;

      btn.addEventListener('click', () => {
        if (!room.ready) return log('Hawkins room not loaded yet');
        if (item.kind === 'bool') {
          const v = room.toggleBool(item.name);
          btn.classList.toggle('active', !!v);
          broadcastRoomInput('bool', item.name, v);
          if (item.name === 'TunnelBoolean') syncUpsideDownBadge(!!v);
          if (item.name === 'DemVisible') syncDemVisibleBtn();
        } else {
          room.fire(item.name);
          broadcastRoomInput('trigger', item.name);
          // DemEnter/DemExit auto-set DemVisible — keep the toggle button in sync
          if (item.name === 'DemEnter' || item.name === 'DemExit') syncDemVisibleBtn();
        }
      });

      btnRow.appendChild(btn);
    }
  }
}

// ── Upside Down badge + tunnel button ──────────────────────────────────
function syncUpsideDownBadge(on) {
  const badge = $('roomUpsideDownBadge');
  const btn   = $('roomBtnTunnel');
  if (badge) badge.style.display = on ? '' : 'none';
  if (btn)   btn.classList.toggle('active', on);
}

// ── DemVisible button sync ─────────────────────────────────────────────
// Keeps the '👁 Visible toggle' button's active class in sync whenever
// DemEnter or DemExit indirectly change the DemVisible boolean.
function syncDemVisibleBtn() {
  const grid = $('roomButtonGrid');
  if (!grid || !room.ready) return;
  const val = room.getBool('DemVisible');
  grid.querySelectorAll('button[data-input-name="DemVisible"]').forEach(b => {
    b.classList.toggle('active', !!val);
  });
}

// ── legacy "fire any input by name" dropdown (server broadcast) ───────
function populateRoomDropdown() {
  const sel = $('roomInputSelect');
  sel.innerHTML = '';
  const { triggers, bools, numbers } = room.list();
  const addGroup = (label, items, kind) => {
    if (!items.length) return;
    const og = document.createElement('optgroup'); og.label = label;
    for (const it of items.sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name))) {
      const o = document.createElement('option');
      o.value = kind + ':' + it.name;
      o.textContent = it.group + ' — ' + it.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  };
  addGroup('Triggers', triggers, 'trigger');
  addGroup('Booleans', bools,    'bool');
  addGroup('Numbers',  numbers,  'number');
  syncRoomInputUI();
}

function syncRoomInputUI() {
  const v = $('roomInputSelect').value;
  if (!v || !v.includes(':')) return;
  const [kind, name] = v.split(':');
  const isNum = kind === 'number';
  $('roomSliderRow').style.display = isNum ? '' : 'none';
  $('roomInputFire').style.display = isNum ? 'none' : '';
  if (isNum) $('roomInputSlider').value = room.getNumber(name) ?? 0;
}

function broadcastRoomInput(kind, name, value) {
  adminFetch('room-input', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind, name, value})})
    .then(r => { if (r.status===401) log('room input not broadcast: admin token missing/invalid'); })
    .catch(e => log('room input broadcast failed: '+e.message));
}

// ── wiring: tunnel button, autopilot, legacy dropdown, auto-load ──────
function initRoom() {
  $('roomSection').addEventListener('toggle', () => {
    if ($('roomSection').open && $('bgTheme').value === 'hawkins-room') ensureRoomLoaded();
  });

  $('roomBtnTunnel').addEventListener('click', () => {
    if (!room.ready) return log('Hawkins room not loaded yet');
    const v = room.toggleUpsideDown();
    syncUpsideDownBadge(v);
    syncDemVisibleBtn(); // TunnelBoolean OFF resets DemVisible=false — keep UI in sync
    broadcastRoomInput('bool', 'TunnelBoolean', v);
    if (!v) broadcastRoomInput('bool', 'DemVisible', false); // also broadcast the reset
    log('Upside Down: ' + (v ? 'ON — Demogorgon hidden until 🚪 Enter or 👁 Visible toggle' : 'OFF — normal room (Demogorgon hidden)'));
  });

  // 🪄 the cinematic version of the button above: ONE event to the server, every screen (this one too) runs the same scene
  $('roomBtnSpell').addEventListener('click', () => {
    if (!room.ready) return log('Hawkins room not loaded yet');
    if (!window.Spell || window.Spell.active) return;
    const on = !room.getBool('TunnelBoolean');
    window.Spell.play({ on });
    adminFetch('spell', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({on})})
      .then(r => { if (!r.ok) log('spell not broadcast (HTTP ' + r.status + ')'); }).catch(e => log('spell broadcast failed: ' + e.message));
    log('Upside Down spell: ' + (on ? 'opening it' : 'closing it'));
  });
  $('roomBtnSpellPreview').addEventListener('click', () => { if (window.Spell) window.Spell.play({ on: !room.getBool('TunnelBoolean'), dry: true }); });

  $('roomAutopilot').addEventListener('click', () => {
    room._auto = !room._auto;
    room.autopilot(room._auto);
    $('roomAutopilot').textContent = room._auto ? '🌀 Autopilot: on' : '🌀 Autopilot: off';
    $('roomAutopilot').classList.toggle('active', room._auto);
  });

  $('roomInputSelect').addEventListener('change', syncRoomInputUI);

  $('roomInputFire').addEventListener('click', () => {
    if (!$('roomInputSelect').value.includes(':')) return;
    const [kind, name] = $('roomInputSelect').value.split(':');
    if (kind === 'trigger') { room.fire(name); broadcastRoomInput('trigger', name); }
    else if (kind === 'bool') {
      const v = room.toggleBool(name);
      broadcastRoomInput('bool', name, v);
      if (name === 'TunnelBoolean') syncUpsideDownBadge(!!v);
    }
    syncRoomInputUI();
  });

  let roomInputDebounce = null;
  $('roomInputSlider').addEventListener('input', e => {
    if (!$('roomInputSelect').value.includes(':')) return;
    const [, name] = $('roomInputSelect').value.split(':');
    room.setNumber(name, e.target.value);
    clearTimeout(roomInputDebounce);
    roomInputDebounce = setTimeout(() => broadcastRoomInput('number', name, Number(e.target.value)), 100);
  });

  // If the room is already loaded by the time initRoom() runs, build now.
  if (room.ready) { buildRoomGrid(); syncUpsideDownBadge(false); }
}

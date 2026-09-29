// =====================================================================
//  15-game.js — "Magician's Tell": a live prediction game built on the wand + auto-pilot camera.
//
//  Loaded by BOTH pages (after 14-autopilot.js):   view.html -> Game.init({role:'viewer'})   publish.html -> Game.init({role:'host'})
//
//  THE GAME. Each round the avatar secretly picks one of 3 objects in the room to vanish. For ~15 s her eyes drift between them
//  (a numbered badge sits on each object and a little 👁 hops to the one she is looking at), and the longer the round runs the
//  more her eyes give the real pick away. Viewers lock in a guess by tapping a button or typing 1 / 2 / 3 in chat.
//    - risk vs reward: a correct guess pays 50..150 pts - the EARLIER you lock in the more it pays (the tell is weakest early)
//    - streaks:        each consecutive correct round adds +25% (max x2); a wrong guess resets it
//    - the payoff:     time's up -> the auto-pilot camera dives onto the picked object, the wand flicks, it vanishes,
//                      the avatar double-takes and reacts to how many people read her eyes; the object returns a few seconds later.
//
//  WHO DOES WHAT. The server (chat/game.js) owns timing, votes, scoring and keeps the pick secret until the reveal.
//  The publisher's browser (role 'host') has the 3D scene, so it supplies the options + secret pick + the gaze schedule
//  and, on `reveal`, vanishes the picked object through the normal object-chip path (so wand, camera shot and viewers
//  all behave exactly as for a manual hide). Viewers only render + vote.
//
//  Tune live: Game.cfg   |   host: 🎩 controls in Office -> Objects   |   console (host): Game.startRound()
// =====================================================================
window.Game = (() => {
  'use strict';
  const cfg = {
    options: 3,             // candidates per round (2..4)
    secs: 15,               // voting time
    resultDelayMs: 2600,    // after "time's up": camera glide + flick + vanish, then the result appears
    restoreMs: 6500,        // host: the vanished object comes back (a glint, ta-da) this long after the reveal
    appearMs: 3800,         // host, trick on 'appearing': the pick comes back (with the wand) this long after the reveal
    gapMs: 2500,            // host, auto rounds: pause once the object is back
    auto: false,            // host: start the next round by itself
    skip: /wall|floor|ceil|room|door|window|glass|ground|plane|camera|scene|root|collision|shadow|base$/i,   // never offered as a candidate
  };
  const $ = id => document.getElementById(id);
  const ICON = ['①', '②', '③', '④'];
  const clamp = v => Math.max(-1, Math.min(1, v));
  let role = 'viewer', st = null, mine = null, deadline = 0, shownRound = -1, ui = null, trk = [], timers = [], raf = 0, eye = -1, live = false;
  let hostSecret = null, pid;
  const hostTimers = [];   // the host's vanish / restore / next-round timers - deliberately NOT cleared when a new round starts (an object must always come back)
  try { pid = localStorage.getItem('gamePid'); if (!pid) localStorage.setItem('gamePid', pid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4)); }
  catch (e) { pid = Math.random().toString(36).slice(2, 12); }

  const CSS = `
.gm-layer{position:absolute;inset:0;pointer-events:none;z-index:5;font:600 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif}
.gm-card{position:absolute;left:8px;right:36%;bottom:8px;max-width:540px;padding:10px 12px;border-radius:14px;background:rgba(14,16,28,.84);color:#fff;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);pointer-events:auto;box-shadow:0 8px 28px rgba(0,0,0,.45);display:none}
.gm-card.on{display:block;animation:gmIn .25s ease-out}
@keyframes gmIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.gm-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}
.gm-time{font-variant-numeric:tabular-nums;padding:2px 10px;border-radius:99px;background:rgba(255,255,255,.14);min-width:34px;text-align:center}
.gm-time.low{background:#e0453a}
.gm-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:6px}
.gm-opt{position:relative;overflow:hidden;text-align:left;padding:8px 9px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:inherit;cursor:pointer;font:inherit}
.gm-opt:hover:not(:disabled){background:rgba(255,255,255,.16)}
.gm-opt:disabled{cursor:default}
.gm-opt .pc{opacity:.7;font-style:normal;margin-left:4px}
.gm-opt .bar{position:absolute;left:0;bottom:0;height:3px;background:#ffd166;width:0;transition:width .4s}
.gm-opt.mine{border-color:#ffd166;box-shadow:0 0 0 2px rgba(255,209,102,.35) inset}
.gm-opt.win{background:rgba(72,199,116,.38);border-color:#48c774}
.gm-opt.lose{opacity:.45}
.gm-foot{margin-top:7px;opacity:.9;font-weight:500;font-size:12px}
.gm-board{margin-top:5px;font-weight:500;font-size:12px;white-space:pre-line;opacity:.9}
.gm-badge{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;display:none;place-items:center;background:rgba(255,209,102,.94);
  color:#241c00;font-weight:800;box-shadow:0 0 0 3px rgba(0,0,0,.35),0 4px 14px rgba(0,0,0,.4);transition:transform .14s,box-shadow .14s}
.gm-badge.eye{transform:scale(1.35);box-shadow:0 0 0 3px #fff,0 0 22px 7px rgba(255,209,102,.9)}
.gm-badge.eye::after{content:'\\1F441';position:absolute;top:-24px;font-size:17px}
.gm-badge.win{background:#48c774;color:#fff}
@media (max-width:640px){.gm-card{right:8px;bottom:auto;top:8px}}`;

  // ───────────────────────────── viewer UI ─────────────────────────────
  function build() {
    if (ui) return ui;
    const frame = $('scene3dFrame'), par = frame && frame.parentElement;
    if (!par) return null;
    const css = document.createElement('style'); css.textContent = CSS; document.head.appendChild(css);
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const layer = mk('div', 'gm-layer'), card = mk('div', 'gm-card'), head = mk('div', 'gm-head'), title = mk('b'), time = mk('span', 'gm-time'),
      opts = mk('div', 'gm-opts'), foot = mk('div', 'gm-foot'), board = mk('div', 'gm-board');
    head.append(title, time); card.append(head, opts, foot, board); layer.appendChild(card); par.appendChild(layer);
    ui = { par, layer, card, title, time, opts, foot, board, btns: [], badges: [], mk };
    return ui;
  }

  function layout(d) {
    ui.opts.textContent = ''; ui.badges.forEach(b => b.remove()); ui.btns = []; ui.badges = [];
    d.options.forEach((o, i) => {
      const b = ui.mk('button', 'gm-opt'), bar = ui.mk('i', 'bar'), pc = ui.mk('em', 'pc');
      b.type = 'button'; b.append(ui.mk('b', '', ICON[i] + ' '), ui.mk('span', '', o.label), pc, bar);
      b.addEventListener('click', () => castVote(i));
      ui.opts.appendChild(b); ui.btns.push({ b, bar, pc });
      const g = ui.mk('div', 'gm-badge', String(i + 1)); ui.layer.appendChild(g); ui.badges.push(g);
    });
  }

  function paint() {
    if (!ui || !st || !st.options) return;
    const vote = st.phase === 'vote', cnt = st.counts || [], total = Math.max(1, cnt.reduce((a, b) => a + b, 0));
    ui.title.textContent = `🎩 Round ${st.round} · which one will she vanish?`;
    ui.btns.forEach((x, i) => {
      x.b.disabled = !vote || mine !== null || role !== 'viewer';
      x.b.classList.toggle('mine', mine === i);
      x.bar.style.width = (100 * (cnt[i] || 0) / total) + '%';
      x.pc.textContent = st.voters ? String(cnt[i] || 0) : '';
    });
    if (!vote) return;
    if (role === 'host') ui.foot.textContent = `👑 You know it${hostSecret && hostSecret.round === st.round ? ': ' + ICON[hostSecret.idx] + ' ' + hostSecret.label : ''} — her eyes give it away a little more every second · ${st.voters || 0} voted`;
    else if (mine !== null) ui.foot.textContent = `🔒 Locked in ${ICON[mine]} · ${st.voters || 0} players in`;
    else ui.foot.textContent = '👀 Watch her eyes! Tap a button or type 1 / 2 / 3 in chat — the earlier you lock in, the more it pays.';
  }

  function paintTime() {
    const left = Math.max(0, deadline - performance.now());
    ui.time.textContent = Math.ceil(left / 1000) + 's';
    ui.time.classList.toggle('low', left < 4000);
    if (role === 'viewer' && mine === null && st && st.phase === 'vote') ui.time.title = `Lock in now: +${Math.round(50 + 100 * left / (st.ms || 15000))} pts`;
  }

  function ensureTrackers() {
    if (trk.length || !st || !st.options || !window.OfficeScene || !OfficeScene.ready) return;
    trk = st.options.map(o => OfficeScene.trackPoint(Number(o.id), (st.ms || 15000) + 8000, 90));   // ~11 samples/s each - light on the iframe
  }

  function frame() {
    raf = 0;
    if (!ui || !st || !live) return;
    if (st.phase === 'vote') { ensureTrackers(); paintTime(); }
    const pr = ui.par.getBoundingClientRect();
    ui.badges.forEach((g, i) => {
      const p = trk[i] && trk[i].get();
      const x = p ? p.x - pr.left : -99, y = p ? p.y - pr.top : -99;
      if (!p || x < -10 || y < -10 || x > pr.width + 10 || y > pr.height + 10) { g.style.display = 'none'; return; }
      g.style.display = 'grid'; g.style.left = x + 'px'; g.style.top = y + 'px';
    });
    raf = requestAnimationFrame(frame);
  }

  function stopAll() {
    timers.forEach(clearTimeout); timers = [];
    trk.forEach(t => t.stop()); trk = []; eye = -1; live = false;
  }

  // her eyes: play the schedule the host generated. Same schedule on every screen, so everyone sees the same glances.
  function playTell(d, elapsed) {
    (d.tell || []).forEach(([t, i]) => { if (t >= elapsed - 40) timers.push(setTimeout(() => look(i), Math.max(0, t - elapsed))); });
  }
  function look(i) {
    if (!ui || !st || st.phase !== 'vote') return;
    eye = i; ui.badges.forEach((g, k) => g.classList.toggle('eye', k === i));
    const p = trk[i] && trk[i].get(), r = window.__avatarRig;
    if (p && r && r.lookAt) r.lookAt(clamp(p.x / innerWidth * 2 - 1), clamp(p.y / innerHeight * 2 - 1));
    timers.push(setTimeout(() => { if (eye === i) { eye = -1; ui && ui.badges.forEach(g => g.classList.remove('eye')); } }, 800));   // a blink between glances
  }

  function begin(d) {
    stopAll();
    const b = build(); if (!b) return;
    shownRound = d.round; mine = null; live = true;
    deadline = performance.now() + Math.max(0, d.endsAt - d.serverNow);          // server-relative, immune to clock skew
    layout(d); b.card.classList.add('on'); b.board.textContent = '';
    playTell(d, d.ms - (deadline - performance.now()));                           // a late joiner starts mid-schedule
    paint(); if (!raf) raf = requestAnimationFrame(frame);
  }

  function reveal(d) {
    const late = shownRound !== d.round;                                          // joined after the vanish: no show to wait for
    timers.forEach(clearTimeout); timers = []; eye = -1;
    if (late) { stopAll(); const b = build(); if (!b) return; shownRound = d.round; mine = null; layout(d); b.card.classList.add('on'); }
    if (!ui) return;
    ui.badges.forEach(g => g.classList.remove('eye'));
    ui.time.textContent = 'GO!'; ui.time.classList.remove('low');
    ui.foot.textContent = late ? '' : '🎩 Time’s up… watch closely!';
    paint();
    if (!late && role === 'host') hostVanish(d);
    timers.push(setTimeout(() => showResult(d), late ? 0 : cfg.resultDelayMs));
  }

  function showResult(d) {
    if (!ui || !st || st.round !== d.round) return;
    const w = d.winnerIdx, label = d.options[w].label, hit = mine === w;
    ui.btns.forEach((x, i) => { x.b.classList.toggle('win', i === w); x.b.classList.toggle('lose', i !== w); x.b.disabled = true; });
    ui.badges.forEach((g, i) => g.classList.toggle('win', i === w));
    ui.time.textContent = '✨';
    ui.foot.textContent = role !== 'viewer' ? `It was ${ICON[w]} ${label}.`
      : mine === null ? `It was ${ICON[w]} ${label}. You sat this one out — jump in next round!`
      : hit ? `✅ ${ICON[w]} ${label} — you read her eyes!` : `❌ It was ${ICON[w]} ${label}. Watch her eyes next time.`;
    const top = (d.top || []).slice(0, 3).map((p, i) => `${i + 1}. ${p.name} ${p.score}`).join('  ·  ');
    const won = (d.winners || []).map(x => `${x.name} +${x.pts}${x.streak > 1 ? ' 🔥' + x.streak : ''}`).join(', ');
    ui.board.textContent = (won ? `⭐ Called it: ${won}\n` : '') + (top ? `🏆 ${top}` : '');
    if (role === 'viewer' && mine !== null) {
      fetch('game/me?pid=' + encodeURIComponent(pid)).then(r => r.json()).then(m => {
        if (m && m.score != null && ui && st && st.round === d.round) ui.board.textContent += `\n🙋 You: ${m.score} pts · #${m.rank}${m.streak > 1 ? ' · 🔥 ' + m.streak + ' in a row' : ''}`;
      }).catch(() => {});
    }
    timers.push(setTimeout(() => { const r = window.__avatarRig; if (r && r.lookAt) r.lookAt(0, 0); }, 1500));   // eyes back on the viewers (no-op if the wand already did it)
    timers.push(setTimeout(() => { live = false; ui.badges.forEach(g => { g.style.display = 'none'; }); }, 4500));
    timers.push(setTimeout(() => { if (ui) ui.card.classList.remove('on'); }, 14000));
  }

  function castVote(i) {
    if (role !== 'viewer' || mine !== null || !st || st.phase !== 'vote') return;
    mine = i; paint();
    const name = (($('chatname') && $('chatname').value) || 'guest').trim();
    fetch('game/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, name, opt: i }) })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) { mine = (j.err === 'locked' && j.opt != null) ? j.opt : null; paint(); }   // e.g. already voted from chat / another tab
      }).catch(() => { mine = null; paint(); });
  }

  function onEvent(d) {
    if (!d || !d.phase) return;
    if (d.phase === 'tally') {
      if (st && st.round === d.round && st.phase === 'vote') { st.counts = d.counts; st.voters = d.voters; paint(); }
      return;
    }
    const prev = st; st = d;
    if (d.phase === 'vote') {
      if (prev && prev.phase === 'vote' && prev.round === d.round) { deadline = performance.now() + Math.max(0, d.endsAt - d.serverNow); paint(); }   // SSE reconnect
      else begin(d);
    } else if (d.phase === 'reveal') {
      if (!(prev && prev.phase === 'reveal' && prev.round === d.round)) reveal(d);
    }
    // 'idle': the round is over - the result card fades on its own
  }

  // ───────────────────────────── host (publish.html) ─────────────────────────────
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const label = nm => (window.humanObjectName ? window.humanObjectName(nm) : String(nm || '').replace(/[_.\-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());
  const note = t => { const e = $('gmNote'); if (e) e.textContent = t; };

  // Her tell: glances that drift onto the real pick. The odds she looks at it start at chance (1/n) and climb to ~82%.
  function makeTell(n, chosen, ms) {
    const out = []; let t = 800;
    while (t < ms - 700) {
      const k = t / ms, pC = 1 / n + (0.82 - 1 / n) * Math.pow(k, 1.4);
      let i = chosen;
      if (Math.random() >= pC) { const others = [...Array(n).keys()].filter(x => x !== chosen); i = others[Math.floor(Math.random() * others.length)]; }
      out.push([Math.round(t), i]);
      t += 850 + Math.random() * 500;
    }
    return out;
  }

  // Candidates must be: leaf objects (never a group that holds the room), not structural, on screen, clear of the avatar, apart from each other.
  function pickCandidates(n) {
    const f = $('scene3dFrame').getBoundingClientRect(), mx = f.width * 0.12, my = f.height * 0.14;
    const box = { l: f.left + mx, r: f.right - mx, t: f.top + my, b: f.bottom - my };
    const rig = window.__avatarRig, a = rig && rig.canvas && rig.canvas.getBoundingClientRect();
    const av = a && a.width < f.width * 0.6 && a.height < f.height * 0.9 ? { l: a.left - 40, r: a.right + 40, t: a.top - 20, b: a.bottom + 20 } : null;
    const sample = shuffle(OfficeScene.leafObjects().filter(id => { const l = label(OfficeScene.nodes[id] && OfficeScene.nodes[id].name); return l.length >= 3 && !cfg.skip.test(l); })).slice(0, 18);
    return Promise.all(sample.map(id => new Promise(res => OfficeScene.probe(id, r => res(r ? { id, label: label(OfficeScene.nodes[id].name), pt: r.pt } : null)))))
      .then(all => {
        const out = [];
        for (const c of all.filter(Boolean)) {
          const { x, y } = c.pt;
          if (x < box.l || x > box.r || y < box.t || y > box.b) continue;
          if (av && x > av.l && x < av.r && y > av.t && y < av.b) continue;
          if (out.some(o => o.label === c.label || Math.hypot(o.pt.x - x, o.pt.y - y) < 110)) continue;
          out.push(c); if (out.length >= n) break;
        }
        return out;
      });
  }

  async function startRound() {
    if (role !== 'host') return;
    if (!window.OfficeScene || !OfficeScene.ready) return note('3D office not ready — pick the Studio Office background first');
    if (st && st.phase === 'vote') return note('a round is already running');
    note('picking objects…');
    const c = await pickCandidates(Math.max(2, Math.min(4, cfg.options)));
    if (c.length < 2) return note('Need 2+ visible objects in frame — point the camera at a busier corner.');
    const chosen = Math.floor(Math.random() * c.length), ms = cfg.secs * 1000;
    hostSecret = { round: (st ? st.round : 0) + 1, idx: chosen, label: c[chosen].label };
    try {
      const r = await adminFetch('game/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: c.map(x => ({ id: String(x.id), label: x.label })), chosen, ms, tell: makeTell(c.length, chosen, ms) }) });
      if (!r.ok) { hostSecret = null; return note('server refused: ' + (await r.text())); }
      note(`round live — secret pick: ${c[chosen].label}`);
    } catch (e) { hostSecret = null; note('start failed: ' + e.message); }
  }

  // on `reveal`: vanish the pick through the normal chip path (wand + camera shot + broadcast), and bring it back later
  function hostVanish(d) {
    const id = Number(d.winner), chip = () => document.querySelector(`#officeNodeGrid .ochip[data-instance-id="${id}"]`);
    // The wand trick follows the admin's "🎩 Trick on" switch: 'hide' = the wand vanishes the pick (then it just comes back),
    // 'show' = the pick disappears with a plain flash and the wand conjures it BACK a moment later (so the trick is the appearing),
    // 'both' = wand both ways.
    const trick = (window.WandCast && window.WandCast.cfg.trick) || 'hide', backMs = trick === 'show' ? cfg.appearMs : cfg.restoreMs;
    hostTimers.push(setTimeout(() => { const c = chip(); if (c && OfficeScene.visMap[id] !== false) c.click(); else note('could not vanish the pick (chip not found)'); }, 700));
    hostTimers.push(setTimeout(() => { const c = chip(); if (c && OfficeScene.visMap[id] === false) c.click(); }, backMs));   // ta-da
    if (cfg.auto) hostTimers.push(setTimeout(() => { if (cfg.auto) startRound(); }, backMs + cfg.gapMs));
  }

  function hostInit() {
    const anchor = $('wandTools');
    if (!anchor || $('gmStart')) return;
    const box = document.createElement('div');
    box.className = 'office-tools'; box.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:8px 0';
    box.innerHTML = '<b title="Viewers guess which object she will vanish by reading her eyes">🎩 Magician’s Tell</b>' +
      '<button type="button" class="go" id="gmStart" style="width:auto">▶ Start round</button>' +
      '<label title="Start the next round automatically"><input type="checkbox" id="gmAuto"> auto rounds</label>' +
      '<label>voting <input type="number" id="gmSecs" min="8" max="40" value="15" style="width:56px"> s</label>' +
      '<button type="button" class="ghost" id="gmReset" title="Clear the leaderboard">Reset scores</button>' +
      '<span class="note" id="gmNote"></span>';
    anchor.after(box);
    $('gmStart').onclick = startRound;
    $('gmAuto').onchange = e => { cfg.auto = e.target.checked; if (cfg.auto && !(st && st.phase === 'vote')) startRound(); };
    $('gmSecs').onchange = e => { cfg.secs = Math.max(8, Math.min(40, Number(e.target.value) || 15)); e.target.value = cfg.secs; };
    $('gmReset').onclick = () => adminFetch('game/reset', { method: 'POST' }).then(() => note('scores cleared')).catch(() => note('reset failed'));
    if (window._chat) window._chat.onGame = onEvent;
  }

  function init(o) { role = (o && o.role) === 'host' ? 'host' : 'viewer'; if (role === 'host') hostInit(); }

  return { cfg, init, onEvent, startRound, makeTell, pickCandidates, get state() { return st; } };
})();

'use strict';
/*
 * Magician's Tell - round engine (authoritative: timing, votes, scoring, leaderboard).
 *
 * The publisher's browser owns the 3D scene, so IT supplies each round: the candidate objects, the SECRET pick and the
 * gaze "tell" (a schedule of glances that drifts onto the real pick as time runs out). The server keeps the pick private
 * until the timer ends, then broadcasts `reveal`; the publisher's browser reacts by vanishing that object (wand + auto-pilot
 * camera), so every viewer sees the same trick.
 *
 * Scoring: a correct vote is worth 50..150 (the earlier you lock in, the more - the tell is weakest at the start),
 * multiplied by 1 + 0.25 per consecutive correct round (max x2). A wrong vote resets the streak; sitting out does not.
 *
 * SSE event `game` payloads: {phase:'vote'|'reveal'|'idle', round, options:[{id,label}], ms, endsAt, serverNow, tell, counts,
 * voters, top, [winner, winnerIdx, winners, hits]} and a light {phase:'tally', round, counts, voters}.
 */
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function createGame({ broadcast, say, now = Date.now }) {
  const players = new Map();                 // pid -> {name, score, streak, best, hits, rounds, last}
  let round = 0, S = null, timer = 0, tallyTimer = 0, idleTimer = 0;

  const counts = () => { const c = S.options.map(() => 0); for (const v of S.votes.values()) c[v.opt]++; return c; };
  const top = n => [...players.values()].filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score || b.best - a.best).slice(0, n).map(p => ({ name: p.name, score: p.score, streak: p.streak }));

  // What every client may see. The secret pick is only included once the round is over.
  function pub() {
    if (!S) return { phase: 'idle', round, top: top(5), serverNow: now() };
    const o = { phase: S.phase, round: S.round, options: S.options, ms: S.ms, endsAt: S.endsAt, tell: S.tell,
      counts: counts(), voters: S.votes.size, top: top(5), serverNow: now() };
    if (S.phase !== 'vote') { o.winnerIdx = S.chosen; o.winner = S.options[S.chosen].id; }
    return o;
  }

  function start(b) {
    if (S && S.phase === 'vote') throw new Error('a round is already running');
    const options = (Array.isArray(b.options) ? b.options : []).slice(0, 4)
      .map(o => ({ id: clean(o && o.id, 20), label: clean(o && o.label, 30) })).filter(o => o.id && o.label);
    if (options.length < 2) throw new Error('need at least 2 options');
    const chosen = Math.floor(Number(b.chosen));
    if (!(chosen >= 0 && chosen < options.length)) throw new Error('bad chosen index');
    const ms = Math.max(6000, Math.min(45000, Number(b.ms) || 15000));
    const tell = (Array.isArray(b.tell) ? b.tell : []).slice(0, 80)
      .map(x => [Math.max(0, Math.min(ms, Number(x && x[0]) | 0)), Number(x && x[1]) | 0])
      .filter(x => x[1] >= 0 && x[1] < options.length);
    clearTimeout(timer); clearTimeout(idleTimer);
    S = { round: ++round, phase: 'vote', options, chosen, tell, ms, startedAt: now(), endsAt: now() + ms, votes: new Map(), names: new Set(), revealAt: 0 };
    timer = setTimeout(reveal, ms);
    broadcast('game', pub());
    return S.round;
  }

  // pid: stable id of the voter. name: display name. opt: option index. Returns {ok} or {ok:false, err, opt?}
  function vote(pid, name, opt) {
    if (!S || S.phase !== 'vote') return { ok: false, err: 'closed' };
    pid = clean(pid, 40); opt = Number(opt); name = clean(name, 24) || 'guest';
    if (!pid || !Number.isInteger(opt) || opt < 0 || opt >= S.options.length) return { ok: false, err: 'bad' };
    const key = name.toLowerCase();
    if (S.votes.has(pid)) return { ok: false, err: 'locked', opt: S.votes.get(pid).opt };
    if (S.names.has(key)) return { ok: false, err: 'locked' };          // same name from another channel (chat vs button)
    if (S.votes.size >= 5000) return { ok: false, err: 'full' };
    S.votes.set(pid, { opt, at: now() - S.startedAt, name });
    S.names.add(key);
    if (!players.has(pid)) players.set(pid, { name, score: 0, streak: 0, best: 0, hits: 0, rounds: 0, last: null });
    if (!tallyTimer) tallyTimer = setTimeout(() => {                   // throttled: at most 2 tally broadcasts a second
      tallyTimer = 0;
      if (S && S.phase === 'vote') broadcast('game', { phase: 'tally', round: S.round, counts: counts(), voters: S.votes.size });
    }, 500);
    return { ok: true };
  }

  // Typing "1".."4" (or "#2", "2!") in chat is a vote. Returns true when the message was consumed as a vote.
  function chatVote(name, text) {
    if (!S || S.phase !== 'vote') return false;
    const m = /^\s*#?\s*([1-4])\s*[!.]*\s*$/.exec(String(text || ''));
    if (!m || +m[1] > S.options.length) return false;
    vote('chat:' + clean(name, 24).toLowerCase(), name, +m[1] - 1);
    return true;
  }

  function reveal() {
    if (!S || S.phase !== 'vote') return;
    clearTimeout(timer); clearTimeout(tallyTimer); tallyTimer = 0;
    S.phase = 'reveal'; S.revealAt = now();
    const won = [];
    for (const [pid, v] of S.votes) {
      const p = players.get(pid) || { name: v.name, score: 0, streak: 0, best: 0, hits: 0, rounds: 0, last: null };
      players.set(pid, p); p.name = v.name; p.rounds++;
      if (v.opt === S.chosen) {
        const pts = Math.round((50 + 100 * (1 - Math.min(1, v.at / S.ms))) * (1 + 0.25 * Math.min(4, p.streak)));
        p.score += pts; p.streak++; p.best = Math.max(p.best, p.streak); p.hits++; p.last = { round: S.round, hit: true, pts };
        won.push({ name: v.name, pts, streak: p.streak });
      } else { p.streak = 0; p.last = { round: S.round, hit: false, pts: 0 }; }
    }
    won.sort((a, b) => b.pts - a.pts);
    if (players.size > 2000) {                                          // keep memory bounded on a big stream
      const keep = [...players.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 1000);
      players.clear(); keep.forEach(([k, v]) => players.set(k, v));
    }
    broadcast('game', Object.assign(pub(), { winners: won.slice(0, 5), hits: won.length }));

    // the avatar reacts (server/narration side decides whether she may speak)
    const n = S.votes.size, k = won.length, label = S.options[S.chosen].label;
    const text = !n ? `Nobody was watching my eyes! The ${label} is gone anyway.`
      : !k ? `Ha! All ${n} of you missed it. The ${label} is gone!`
      : k === n ? `Wow, everyone spotted the ${label}! Sharp eyes, ${won[0].name}!`
      : `${k} of ${n} read my eyes and caught the ${label}! Nice one, ${won[0].name}!`;
    try { say && say(text); } catch (e) { /* narration is optional */ }

    idleTimer = setTimeout(() => { if (S && S.phase === 'reveal') { S.phase = 'idle'; broadcast('game', pub()); } }, 9000);
  }

  // true while the vanish that follows a reveal is happening - the generic "Whoa, it disappeared!" line stays quiet then
  const claimsVanish = () => !!S && S.phase !== 'vote' && S.revealAt > 0 && now() - S.revealAt < 8000;

  function me(pid) {
    const p = players.get(clean(pid, 40)); if (!p) return null;
    let rank = 1; for (const q of players.values()) if (q.score > p.score) rank++;
    return { name: p.name, score: p.score, streak: p.streak, best: p.best, rank, last: p.last };
  }

  function reset() {
    clearTimeout(timer); clearTimeout(tallyTimer); clearTimeout(idleTimer); tallyTimer = 0;
    players.clear(); S = null; round = 0; broadcast('game', pub());
  }

  return { start, vote, chatVote, reveal, claimsVanish, me, reset, pub };
}

module.exports = { createGame };

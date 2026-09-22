'use strict';
/*
 * Chat + avatar "brain" for the livestream. One npm dependency: `ws` (used by edge.js's TTS socket).
 *
 *   GET  /events          Server-Sent Events: chat lines, avatar replies, and interrupt signals
 *   POST /chat             {name, text}  -> broadcast, then the avatar replies (interrupts the baseline loop)
 *   GET  /audio/<id>       the avatar's spoken reply (mp3 from Edge TTS, or wav from the espeak-ng fallback)
 *   GET  /audio/<id>/words word-timestamp sidecar for lip-sync (Edge TTS only; null for espeak-ng lines)
 *   GET  /voices           the free voice catalog + the two currently selected voices
 *   POST /voice            {en, ar} -> pick a different free Edge voice per language, live
 *   GET  /script           current baseline reference script + persona (for the publisher's editor)
 *   POST /script           {lines:[...], persona, loop} -> update the baseline script at runtime
 *
 * Replies: see llm.js (your keys, then free keyless gateways, then built-in rules). Voice: see edge.js
 * (free neural TTS, real Arabic voices, word timestamps) with an espeak-ng fallback below.
 *
 * Baseline loop: while nobody is chatting, the avatar keeps reciting a short reference script on
 * repeat (the "keep talking" pitch). The instant a real comment arrives, an `interrupt` SSE event
 * is broadcast so every connected page cuts the avatar off mid-sentence (event-driven, no polling),
 * the queued baseline line is dropped, a near-instant "Hi {name}!" ack is spoken while the real reply
 * is generated in parallel, and then the full reply is spoken. Once the queue is empty again the loop
 * quietly resumes from the next line after a short pause.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Brain, isArabic } = require('./llm.js');
const edge = require('./edge.js');

// ---- static web assets (Railway-friendly single-service deploy) ----
// No MediaMTX, no nginx, no UDP: this process alone can serve web/ (index/publish/view.html, the Rive
// runtime, avatar-orchestra.js, etc.) alongside the SSE/API routes above, so Railway (or anywhere else
// that runs one Docker image on one HTTPS port) is all this needs. Set STATIC_ROOT if web/ lives
// somewhere other than ../web relative to this file (the Dockerfile copies it to /app/web).
const STATIC_ROOT = path.resolve(__dirname, process.env.STATIC_ROOT || '../web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.riv': 'application/octet-stream',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(STATIC_ROOT, rel));
  if (!full.startsWith(STATIC_ROOT)) { res.writeHead(403); return res.end(); }   // no ../ escapes
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': path.extname(full) === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const PORT       = Number(process.env.PORT) || 3000;

// ---- admin auth ----
// Every privileged endpoint (script/voice/pending/gesture/background/motion/speech/state) requires
// `Authorization: Bearer <ADMIN_TOKEN>` when ADMIN_TOKEN is set. Unset = dev mode (no auth), matching
// the old behavior on a trusted LAN. On Railway/anywhere public, always set ADMIN_TOKEN.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const h = String(req.headers['authorization'] || '');
  return h === `Bearer ${ADMIN_TOKEN}`;
}
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'admin token required' }));
  return false;
}

// ---- reply brain ----
// Locked to the free llm7 gateway only (Brain.reply skips the custom/Groq/Claude branch entirely for any
// engine other than 'auto', and FREE_LLM_ORDER below already defaults to 'llm7' alone) - so a viewer
// comment's reply always comes from the same single model, never silently swapped for a different one just
// because an OPENAI_/GROQ_/ANTHROPIC_ key happens to be set in the environment. Set LLM_ENGINE=auto to
// restore the your-keys-first behaviour, or LLM_ENGINE=rules to go fully offline (no network at all).
const brain = new Brain(process.env);
const ENGINE = process.env.LLM_ENGINE || 'free';    // 'auto' | 'free' (llm7-only, default) | 'rules'
const PERSONA_DEFAULT = process.env.AVATAR_PERSONA || 'a friendly, witty cartoon co-host';
let PERSONA = PERSONA_DEFAULT;

// A tiny "say something *now*, while the real reply is still being written" greeting, spoken the
// instant a comment interrupts, so there's never dead air waiting on an LLM round-trip. The full
// reply (generated in parallel) is told a greeting already happened (llm.js's `greeted` flag) so it
// never says hello twice - stripLeadingGreeting() also strips one if a provider adds it anyway.
const ACK_EN = ['Hi {n}!', 'Hey {n}!', 'Oh hi {n}!', 'Hey there, {n}!'];
const ACK_AR = ['أهلاً {n}!', 'هاي {n}!', 'يا هلا {n}!', 'أهلاً وسهلاً {n}!'];
let ackIdx = 0;
function quickAck(name, ar) {
  const bank = ar ? ACK_AR : ACK_EN;
  const line = bank[ackIdx % bank.length]; ackIdx++;
  return line.replace('{n}', name);
}

// Tiny in-memory cache so repeated/near-duplicate comments ("hi", "lol", "price?") don't re-spend LLM
// tokens or add latency - a real token/latency optimization for a live chat where the same few things
// get typed by many viewers. Keyed on the normalized text only (not the name), short TTL.
const REPLY_CACHE_MS = Number(process.env.REPLY_CACHE_MS) || 45000;
const replyCache = new Map();   // normalized text -> {text, mode, at}
function cacheKey(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160); }
function cacheGet(text) {
  const e = replyCache.get(cacheKey(text));
  if (e && Date.now() - e.at < REPLY_CACHE_MS) return e;
  return null;
}
function cacheSet(text, text_out, mode) {
  replyCache.set(cacheKey(text), { text: text_out, mode, at: Date.now() });
  if (replyCache.size > 200) replyCache.delete(replyCache.keys().next().value);
}

// ---- baseline reference script (the "keep talking" loop) ----
// AVATAR_SCRIPT may be a JSON array of strings in the environment; otherwise a small default pitch.
let SCRIPT = [];
try { const s = JSON.parse(process.env.AVATAR_SCRIPT || 'null'); if (Array.isArray(s) && s.length) SCRIPT = s.map(String); } catch {}
if (!SCRIPT.length) SCRIPT = [
  "Hey everyone, welcome to the stream! Take a look at what we've got today.",
  "This one's a favorite - great quality, and the price only gets better the longer you stick around.",
  "If you see something you like, just drop a comment and I'll tell you everything about it.",
  "We're restocking fast, so don't wait too long if you want in on this.",
  "Go ahead, ask me anything - sizes, colors, shipping, I'm listening.",
];
let scriptIndex = 0;
// Off by default: the avatar stays quiet until someone actually sends a comment. Set AVATAR_LOOP=on
// to bring back the old "keep talking to a script on repeat" behavior, or flip it live from the
// publisher's "Loop when idle" checkbox / quick-bar "Talk" button.
let loopEnabled = process.env.AVATAR_LOOP === 'on';
// Comment replies: 'all' | 'mention' (questions, @, greetings only) | 'review' (queued for the publisher
// to approve/edit/reject before anything is spoken) | 'off' (comments show up, avatar stays silent)
const REPLY_MODES = ['all', 'mention', 'review', 'off'];
let repliesMode = REPLY_MODES.includes(process.env.AVATAR_REPLIES) ? process.env.AVATAR_REPLIES : 'all';
const shouldReply = t => repliesMode === 'all' || (repliesMode === 'mention' && /[?؟@]|\b(avatar|bot|hey|hi|hello|please)\b/i.test(t));
// Script protection: while on, a comment never cuts the reference script off mid-line - it is queued
// into `pending` (the moderation memory below) instead of interrupting, and only handled once the
// script line currently speaking finishes. With this off, comments always win immediately (old behavior).
let scriptProtect = process.env.AVATAR_SCRIPT_PROTECT === 'on';
let speakingBaseline = false;          // true only while a baseline (script) line's audio is actually being spoken
// Independent voice switches: when off, that category is still *said* in text (chat log / captions) but
// never synthesized/played as audio - lets you run a silent script, or hold replies to text-only.
let voiceScript  = process.env.AVATAR_VOICE_SCRIPT  !== 'off';
let voiceReplies = process.env.AVATAR_VOICE_REPLIES !== 'off';

// ---- pure-virtual viewer state: background theme + layout/motion knobs, broadcast to every viewer so
// each browser's locally-rendered avatar (no video track involved) stays in sync with the admin's choices.
// Keep GESTURE_NAMES in sync with the `GESTURES` keys in web/avatar-orchestra.js - this list is only used
// to reject typos/unknown names early; the actual animation data lives client-side.
const GESTURE_NAMES = ['wave', 'glasses', 'present', 'nod', 'shake', 'surprise', 'shrug', 'celebrate',
  'footTap', 'weightShift', 'bounce', 'march', 'kick', 'stomp', 'dance', 'fidgetFoot', 'fidgetTap', 'thinking'];
const BG_THEMES = ['aurora', 'midnight', 'sunset', 'studio', 'neon', 'bokeh'];
let background = BG_THEMES.includes(process.env.AVATAR_BACKGROUND) ? process.env.AVATAR_BACKGROUND : 'aurora';
let motionState = { frameMode: 'full', stageMode: 'center', size: 66 };   // last-known layout knobs, for late joiners
// Admin "stop the avatar's speech / toggle it off" kill switch: while true, the reply pipeline never
// speaks (script or comment replies) - every comment instead lands in `pending` for the admin to review,
// same as repliesMode:'review'. This is the *global*, server-side version of "Stop talking": it silences
// every connected viewer at once, not just the publisher's own preview.
let speechPaused = process.env.AVATAR_SPEECH_PAUSED === 'on';
// A small number of free "test the character" gesture triggers for anyone who hasn't authenticated as the
// admin (e.g. a hosted trial viewer) - keyed by IP, resets on server restart. Configurable; 5 by default.
const GESTURE_TEST_LIMIT = Number(process.env.GESTURE_TEST_LIMIT) || 5;
const gestureTestCount = new Map();   // ip -> count

// ---- moderation memory: comments held for the publisher to verify before the avatar answers them ----
// Populated when repliesMode === 'review', or when scriptProtect holds a comment back mid-script-line.
// Nothing here is ever auto-spoken; it only leaves this list via /pending/:id/approve or /pending/:id/reject.
const pending = [];                    // [{id, name, text, ts, reason}]
const PENDING_MAX = 40;
function addPending(m, reason) {
  const item = { id: crypto.randomBytes(6).toString('hex'), name: m.name, text: m.text, ts: m.ts || Date.now(), reason };
  pending.push(item);
  while (pending.length > PENDING_MAX) pending.shift();
  broadcast('pending', { items: pending });
  return item;
}
function removePending(id) {
  const i = pending.findIndex(p => p.id === id);
  if (i < 0) return null;
  const [item] = pending.splice(i, 1);
  broadcast('pending', { items: pending });
  return item;
}
const IDLE_RESUME_MS = Number(process.env.AVATAR_IDLE_MS) || 1100;   // pause before the baseline resumes
// Voice. espeak-ng is robotic by nature; these defaults make it as friendly as it gets: a little slower
// than default so the words are easy to follow, a higher pitch (which reads as warm rather than stern),
// close to full amplitude so it carries over the microphone, and a small gap between words so the reply
// does not run together. The browser then adds warmth and clarity (VOICE in web/avatar.js).
const VOICE_EN   = process.env.TTS_VOICE_EN || 'en-us+f3';
const VOICE_AR   = process.env.TTS_VOICE_AR || 'ar+f3';
const TTS_SPEED  = process.env.TTS_SPEED || '138';     // words per minute
const TTS_PITCH  = process.env.TTS_PITCH || '72';      // 0-99
const TTS_AMP    = process.env.TTS_AMP   || '190';     // 0-200
const TTS_GAP    = process.env.TTS_GAP   || '4';       // pause between words, in 10 ms units
const MAX_TEXT   = 200;

// ---- voice engine ----
// Edge (edge.js): free Microsoft neural voices, no API key, real Arabic voices included, and it hands
// back per-word timestamps - which is what lets the browser's lip-sync (web/lipsync.js) land every
// mouth shape on the real audio instead of guessing from text length alone. It's an unofficial endpoint,
// so every call is wrapped: if it fails or times out, this falls straight back to espeak-ng (self-hosted,
// always works, no timestamps) with zero user-visible error. TTS_ENGINE=espeak forces the old path.
const TTS_ENGINE   = process.env.TTS_ENGINE || 'edge';          // 'edge' | 'espeak'
const EDGE_VOICE_EN = process.env.TTS_VOICE_EN_EDGE || 'en-US-AriaNeural';
const EDGE_VOICE_AR = process.env.TTS_VOICE_AR_EDGE || 'ar-EG-SalmaNeural';
const EDGE_VOICE_AR_FALLBACK = 'ar-SA-HamedNeural';
const EDGE_RATE  = process.env.TTS_EDGE_RATE  || 0;    // percent, -50..+50
const EDGE_PITCH = process.env.TTS_EDGE_PITCH || 0;    // Hz, -50..+50
const AR_DIALECT = process.env.AVATAR_AR_DIALECT === 'msa' ? 'msa' : 'egy';   // for the client-side lip-sync table
// A short curated list so the publisher can pick a different free voice without editing .env -
// "choosable" voices, not voice cloning (this project has no reference-audio cloning; Edge only
// exposes its own named neural voices). GET /voices returns this list.
const VOICE_CATALOG = [
  { id: 'en-US-AriaNeural',   lang: 'en', label: 'Aria (US, warm)' },
  { id: 'en-US-GuyNeural',    lang: 'en', label: 'Guy (US, male)' },
  { id: 'en-GB-SoniaNeural',  lang: 'en', label: 'Sonia (UK)' },
  { id: 'ar-EG-SalmaNeural',  lang: 'ar', label: 'سلمى (مصري)' },
  { id: 'ar-EG-ShakirNeural', lang: 'ar', label: 'شاكر (مصري، ذكر)' },
  { id: 'ar-SA-ZariyahNeural',lang: 'ar', label: 'زارية (سعودي)' },
  { id: 'ar-SA-HamedNeural',  lang: 'ar', label: 'حامد (سعودي، ذكر)' },
];
let voiceChoice = { en: EDGE_VOICE_EN, ar: EDGE_VOICE_AR };

const clients = new Set();
const history = [];                 // display-only copy of recent lines
const audioCache = new Map();       // id -> {buf, mime, words, ext}
const lastPost = new Map();         // ip -> timestamp (rate limit)
const queue = [];
let busy = false;
let generation = 0;                 // bumped on every real comment; invalidates stale baseline timers
let resumeTimer = null;
let replyMode = 'rules';            // last provider that actually produced a line: 'groq' | 'claude' | 'rules'

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- SSE ----------
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function pushHistory(m) { history.push(m); while (history.length > 40) history.shift(); }
function broadcast(event, data) { for (const c of clients) { try { sse(c, event, data); } catch {} } }
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch {} } }, 15000);

// ---------- reply logic ----------
function speakable(s) {
  return String(s)
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[^\p{L}\p{N}\s.,!?'’:;\-]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ---------- text to speech ----------
function fixWav(buf) {            // espeak streams a WAV with placeholder sizes; make them correct
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  buf.writeUInt32LE(buf.length - 8, 4);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    if (id === 'data') { buf.writeUInt32LE(buf.length - off - 8, off + 4); break; }
    off += 8 + buf.readUInt32LE(off + 4);
  }
  return buf;
}
function wavDurationMs(buf) {
  try {
    const ch = buf.readUInt16LE(22), sr = buf.readUInt32LE(24), bits = buf.readUInt16LE(34);
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
      if (id === 'data') return Math.round(size / (sr * ch * bits / 8) * 1000);
      off += 8 + size;
    }
  } catch {}
  return 3000;
}
// Rough duration estimate for the fixed-bitrate mp3 Edge returns (48 kbit/s CBR, mono): good enough to
// pace the baseline-loop queue - the browser always uses the *real* decoded duration for playback/lip-sync.
function mp3DurationMsEstimate(buf, kbps = 48) { return Math.round((buf.length * 8 / (kbps * 1000)) * 1000); }

// A voice like "en-us+f3" is a base voice plus a variant. If the installed espeak-ng does not have that
// variant it exits with an error, so the base voice is tried once before giving up.
async function synthEspeak(text) {
  const voice = isArabic(text) ? VOICE_AR : VOICE_EN;
  try { return await synthWith(voice, text); }
  catch (e) {
    if (!voice.includes('+')) throw e;
    console.error(`voice "${voice}" failed (${e.message}); falling back to "${voice.split('+')[0]}"`);
    return synthWith(voice.split('+')[0], text);
  }
}
function synthWith(voice, text) {
  return new Promise((resolve, reject) => {
    const p = spawn('espeak-ng', ['-v', voice, '-s', TTS_SPEED, '-p', TTS_PITCH,
      '-a', TTS_AMP, '-g', TTS_GAP, '--stdin', '--stdout']);
    const chunks = []; let err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(kill); reject(e); });
    p.on('close', code => {
      clearTimeout(kill);
      code === 0 && chunks.length ? resolve(fixWav(Buffer.concat(chunks))) : reject(new Error(`espeak-ng exit ${code} ${err.trim()}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(text);
  });
}

// Unified TTS: Edge neural voice first (free, no key, real Arabic voices, gives word timestamps for
// accurate lip-sync) -> espeak-ng if Edge fails/times out or TTS_ENGINE=espeak. Always resolves to
// {buf, mime, ext, words, durationMs} - callers never need to know which engine actually spoke.
async function synth(text) {
  const ar = isArabic(text);
  if (TTS_ENGINE === 'edge') {
    const voice = ar ? voiceChoice.ar : voiceChoice.en;
    try {
      const r = await edge.synth(text, { voice, rate: EDGE_RATE, pitch: EDGE_PITCH, boundary: 'word', timeoutMs: 9000 });
      const durationMs = r.words && r.words.length
        ? Math.round((r.words[r.words.length - 1].t + r.words[r.words.length - 1].d) * 1000) + 250
        : mp3DurationMsEstimate(r.audio);
      return { buf: r.audio, mime: r.mime, ext: 'mp3', words: r.words, durationMs };
    } catch (e) {
      console.error(`Edge TTS failed (${e.message}); falling back to espeak-ng for this line`);
      if (ar && voiceChoice.ar === EDGE_VOICE_AR) {
        // one more try with the alternate Arabic voice before giving up on Edge entirely for this line
        try {
          const r = await edge.synth(text, { voice: EDGE_VOICE_AR_FALLBACK, rate: EDGE_RATE, pitch: EDGE_PITCH, boundary: 'word', timeoutMs: 7000 });
          const durationMs = r.words && r.words.length
            ? Math.round((r.words[r.words.length - 1].t + r.words[r.words.length - 1].d) * 1000) + 250
            : mp3DurationMsEstimate(r.audio);
          return { buf: r.audio, mime: r.mime, ext: 'mp3', words: r.words, durationMs };
        } catch {}
      }
    }
  }
  const wav = await synthEspeak(text);
  return { buf: wav, mime: 'audio/wav', ext: 'wav', words: null, durationMs: wavDurationMs(wav) };
}

// ---------- pipeline: comment -> reply -> speech -> broadcast ----------
function nextScriptLine() {
  if (!SCRIPT.length) return null;
  const line = SCRIPT[scriptIndex % SCRIPT.length];
  scriptIndex = (scriptIndex + 1) % SCRIPT.length;
  return line;
}

function storeAudio(res) {
  const id = crypto.randomBytes(8).toString('hex');
  audioCache.set(id, res);
  while (audioCache.size > 24) audioCache.delete(audioCache.keys().next().value);
  return id;
}
function broadcastAudio(res, { name, text, baseline = false, ack = false }) {
  const id = storeAudio(res);
  const msg = { id, name, text, ts: Date.now(), avatar: true, durationMs: res.durationMs, baseline, ack, ext: res.ext };
  if (!baseline && !ack) pushHistory({ name: msg.name, text: msg.text, ts: msg.ts, avatar: true });
  broadcast('reply', msg);
  return msg;
}
// Text-only line: the avatar "says" it in the chat log/captions but no audio is synthesized or played -
// used when voiceScript/voiceReplies is switched off for that category. Reading-time estimate paces the
// baseline queue the same way a spoken line would (~2.4 words/sec), so it doesn't just flash by instantly.
function broadcastSilent({ name, text, baseline = false }) {
  const durationMs = Math.max(900, Math.round((text.split(/\s+/).filter(Boolean).length / 2.4) * 1000));
  const msg = { id: null, name, text, ts: Date.now(), avatar: true, durationMs, baseline, ack: false, silent: true };
  if (!baseline) pushHistory({ name: msg.name, text: msg.text, ts: msg.ts, avatar: true });
  broadcast('reply', msg);
  return msg;
}

// The instant a real (non-baseline) comment interrupts, speak a near-instant one-line acknowledgement
// (no network call - rules are free) with the avatar's own wave/gesture, while the full LLM reply is
// generated in parallel below. This is what makes an interruption feel answered immediately instead of
// leaving dead air for the ~1-2s an LLM round-trip can take.
async function speakAck(m, myGen) {
  try {
    const line = quickAck(m.name, isArabic(m.text));
    const res = await synth(line);
    if (myGen !== generation) return false;      // superseded by a newer comment before we finished
    broadcastAudio(res, { name: 'Avatar', text: line, ack: true });
    return true;
  } catch (e) { console.error('ack synth failed:', e.message); return false; }
}

async function handle(m) {
  const myGen = generation;
  let text, mode = 'rules';

  if (m.baseline) {
    text = m.text;                              // reference script lines are spoken verbatim
  } else {
    const cached = cacheGet(m.text);
    const [, replyResult] = await Promise.all([
      speakAck(m, myGen),                                                       // "Hi {name}!" - fires immediately
      cached ? Promise.resolve(cached) : brain.reply(m.name, m.text, { persona: PERSONA, engine: ENGINE, greeted: true }),
    ]);
    if (myGen !== generation) return;            // a newer comment beat both of the above
    text = replyResult.text; mode = replyResult.mode;
    if (!cached) cacheSet(m.text, text, mode);
  }
  if (!m.baseline) replyMode = mode;

  text = clean(text, 400);
  const say = speakable(text);
  if (!say) return;
  if (myGen !== generation) return;             // a real comment interrupted while this was generating

  const useVoice = m.baseline ? voiceScript : voiceReplies;
  if (!useVoice) {
    const msg = broadcastSilent({ name: 'Avatar', text, baseline: !!m.baseline });
    await sleep(Math.min(msg.durationMs, 20000) + 400);
    return;
  }

  if (m.baseline) speakingBaseline = true;
  let res;
  try { res = await synth(say); }
  finally { if (m.baseline) speakingBaseline = false; }
  if (myGen !== generation) return;             // interrupted mid-synthesis: drop it, stay silent

  if (m.baseline) speakingBaseline = true;
  const msg = broadcastAudio(res, { name: 'Avatar', text, baseline: !!m.baseline });
  try { await sleep(Math.min(msg.durationMs, 20000) + 400); }   // let it finish before the next one
  finally { if (m.baseline) speakingBaseline = false; }
}

async function pump() {
  if (busy) return;
  busy = true;
  const myGen = generation;
  try {
    while (queue.length) {
      const m = queue.shift();
      if (m.baseline && m.gen !== generation) continue;   // stale baseline line from before an interrupt
      try { await handle(m); } catch (e) { console.error('handle error:', e.message); }
    }
  } finally {
    busy = false;
    if (loopEnabled && myGen === generation) scheduleBaseline();
  }
}

// Admit a comment into the real reply pipeline (bumps generation, interrupts the baseline, queues it).
// Shared by the normal auto-reply path and by the publisher approving something held in `pending`.
function admitComment(m) {
  generation++;
  clearTimeout(resumeTimer);
  broadcast('interrupt', { ts: Date.now() });
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].baseline) queue.splice(i, 1);
  if (queue.length >= 5) queue.shift();
  queue.push(m);
  pump();
}

// The idle loop: schedules the next reference-script line a short beat after the queue drains, tagged
// with the generation it was scheduled under so a comment arriving in between silently cancels it -
// event-driven, no polling of "is anyone talking".
function scheduleBaseline() {
  clearTimeout(resumeTimer);
  if (!loopEnabled || !SCRIPT.length) return;
  const gen = generation;
  resumeTimer = setTimeout(() => {
    if (gen !== generation || busy || queue.length) return;
    const line = nextScriptLine();
    if (!line) return;
    queue.push({ name: 'Avatar', text: line, ts: Date.now(), baseline: true, gen });
    pump();
  }, IDLE_RESUME_MS);
}

// ---------- HTTP ----------
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', d => { n += d.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sse(res, 'history', {
      items: history,
      mode: replyMode,
      providers: brain.providers(),
      voice: { engine: TTS_ENGINE, ar: voiceChoice.ar, en: voiceChoice.en, dialect: AR_DIALECT },
      loop: loopEnabled, replies: repliesMode,
      scriptProtect, voiceScript, voiceReplies,
      background, motion: motionState, speechPaused,
    });
    sse(res, 'pending', { items: pending });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    if (now - (lastPost.get(ip) || 0) < 800) { res.writeHead(429); return res.end(); }
    lastPost.set(ip, now);
    if (lastPost.size > 500) lastPost.clear();
    try {
      const body = JSON.parse(await readBody(req));
      const name = clean(body.name, 24) || 'guest';
      const text = clean(body.text, MAX_TEXT);
      if (!text) { res.writeHead(400); return res.end(); }
      const m = { name, text, ts: now };
      pushHistory(m);
      broadcast('chat', m);
      if (repliesMode === 'off') { res.writeHead(204); return res.end(); }   // avatar stays silent on comments entirely

      // Moderation: held for the publisher to verify in the control panel instead of auto-speaking -
      // either because "Hold for review" is the chosen mode, because a script line is currently mid-
      // sentence and "don't interrupt the script" is on (comments never cut the script off; they wait),
      // or because the admin has hit the global "stop the avatar's speech" switch.
      if (speechPaused || repliesMode === 'review' || (scriptProtect && speakingBaseline)) {
        addPending(m, speechPaused ? 'speech-paused' : repliesMode === 'review' ? 'review' : 'script-protect');
        res.writeHead(204); return res.end();
      }

      if (!shouldReply(text)) { res.writeHead(204); return res.end(); }     // not addressed to the avatar ('mention' mode)

      // Event-driven interruption: a real comment always wins over the baseline loop (unless held above).
      admitComment(m);
      res.writeHead(204); return res.end();
    } catch { res.writeHead(400); return res.end(); }
  }

  if (req.method === 'GET' && url.pathname === '/script') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      lines: SCRIPT, persona: PERSONA, loop: loopEnabled, replies: repliesMode,
      scriptProtect, voiceScript, voiceReplies,
    }));
  }

  // Lets the publisher's admin panel edit the reference script / persona / loop toggle / moderation and
  // voice switches live, without restarting the server. Same trust boundary as the rest of this demo app
  // (no auth of its own) - the publisher's own control panel is the only thing that can call this.
  // A script-line change here is meant to be reviewed before it goes out: the publish.html editor shows
  // a preview/confirm step client-side before it ever POSTs here, so by the time this runs the publisher
  // has already accepted the new topic/lines.
  if (req.method === 'POST' && url.pathname === '/script') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 8192));
      if (Array.isArray(body.lines)) {
        const lines = body.lines.map(l => clean(l, 400)).filter(Boolean).slice(0, 30);
        if (lines.length) { SCRIPT = lines; scriptIndex = 0; }
      }
      if (typeof body.persona === 'string' && body.persona.trim()) PERSONA = clean(body.persona, 200);
      if (REPLY_MODES.includes(body.replies)) {
        repliesMode = body.replies;
        if (repliesMode === 'off') { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].baseline) queue.splice(i, 1); }
      }
      if (typeof body.loop === 'boolean') {
        loopEnabled = body.loop;
        if (!loopEnabled) { clearTimeout(resumeTimer); for (let i = queue.length - 1; i >= 0; i--) if (queue[i].baseline) queue.splice(i, 1); }
        else scheduleBaseline();
      }
      if (typeof body.scriptProtect === 'boolean') scriptProtect = body.scriptProtect;
      if (typeof body.voiceScript === 'boolean') voiceScript = body.voiceScript;
      if (typeof body.voiceReplies === 'boolean') voiceReplies = body.voiceReplies;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        lines: SCRIPT, persona: PERSONA, loop: loopEnabled, replies: repliesMode,
        scriptProtect, voiceScript, voiceReplies,
      }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  // ---- pure-virtual broadcast controls: gesture / background / motion / speech kill switch ----
  // These exist for the event-driven viewer (web/view.html): instead of one baked video, every viewer
  // renders its own local Rive avatar and reacts to these small JSON events over /events (SSE), so the
  // admin's dashboard drives every connected viewer's character at once, in real time.
  if (req.method === 'POST' && url.pathname === '/gesture') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 512));
      const name = String(body.name || '');
      if (!GESTURE_NAMES.includes(name)) { res.writeHead(400); return res.end('unknown gesture'); }
      const side = body.side === 'L' ? 'L' : 'R';
      broadcast('gesture', { name, side, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, name, side }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  // A small number of unauthenticated "test the character" triggers - e.g. a hosted trial viewer poking
  // the demo before signing up - rate-limited per IP (GESTURE_TEST_LIMIT, default 5). Broadcasts the same
  // way an admin gesture does, so it's visible to every connected viewer (same trust model as /chat).
  if (req.method === 'POST' && url.pathname === '/gesture/test') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const used = gestureTestCount.get(ip) || 0;
    if (used >= GESTURE_TEST_LIMIT) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'test limit reached', limit: GESTURE_TEST_LIMIT }));
    }
    try {
      const body = JSON.parse(await readBody(req, 512));
      const name = String(body.name || '');
      if (!GESTURE_NAMES.includes(name)) { res.writeHead(400); return res.end('unknown gesture'); }
      gestureTestCount.set(ip, used + 1);
      broadcast('gesture', { name, side: 'R', ts: Date.now(), demo: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, name, remaining: GESTURE_TEST_LIMIT - used - 1 }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  if (req.method === 'POST' && url.pathname === '/background') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 256));
      if (!BG_THEMES.includes(body.theme)) { res.writeHead(400); return res.end('unknown theme'); }
      background = body.theme;
      broadcast('background', { theme: background, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, theme: background }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  // Live layout/motion knobs (e.g. how much of the character to show, character size) - merged into the
  // last-known state so a late-joining viewer's /events "history" snapshot starts in the right layout.
  if (req.method === 'POST' && url.pathname === '/motion') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 512));
      if (typeof body.frameMode === 'string') motionState.frameMode = clean(body.frameMode, 20);
      if (typeof body.stageMode === 'string') motionState.stageMode = clean(body.stageMode, 20);
      if (Number.isFinite(body.size)) motionState.size = Math.max(25, Math.min(100, body.size));
      broadcast('motion', { ...motionState, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, motion: motionState }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  // The global "stop the avatar's speech" switch: pauses immediately (cuts whatever is playing on every
  // viewer, empties the queue) and, while on, funnels every comment into `pending` instead of speaking it -
  // same as `repliesMode:'review'`, but a one-button override that doesn't require changing that mode.
  if (req.method === 'POST' && (url.pathname === '/speech/pause' || url.pathname === '/speech/resume')) {
    if (!requireAdmin(req, res)) return;
    speechPaused = url.pathname === '/speech/pause';
    if (speechPaused) {
      generation++;
      clearTimeout(resumeTimer);
      broadcast('interrupt', { ts: Date.now() });
      queue.length = 0;
    } else if (loopEnabled) scheduleBaseline();
    broadcast('speech-state', { paused: speechPaused, ts: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, paused: speechPaused }));
  }

  // A single consolidated snapshot for the admin dashboard: queue depth, pending comments, every toggle,
  // and how many viewers are currently connected - "deep look at the queue" in one call.
  if (req.method === 'GET' && url.pathname === '/state') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      queueLength: queue.length, queuedBaseline: queue.filter(q => q.baseline).length,
      busy, speaking: speakingBaseline, pending, pendingCount: pending.length,
      background, motion: motionState, speechPaused, repliesMode, scriptProtect,
      voiceScript, voiceReplies, loopEnabled, replyMode, connectedViewers: clients.size,
    }));
  }

  // ---- moderation memory: comments held for the publisher to verify before the avatar answers ----
  if (req.method === 'GET' && url.pathname === '/pending') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: pending }));
  }
  const pa = url.pathname.match(/^\/pending\/([a-f0-9]{12})\/(approve|reject)$/);
  if (req.method === 'POST' && pa) {
    if (!requireAdmin(req, res)) return;
    const [, id, action] = pa;
    const item = removePending(id);
    if (!item) { res.writeHead(404); return res.end(); }
    if (action === 'approve') {
      let body = {};
      try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch {}
      const text = clean(typeof body.text === 'string' && body.text.trim() ? body.text : item.text, MAX_TEXT);
      // The publisher may edit the text before sending; it is spoken exactly like any other admitted
      // comment (ack, then the full reply chain), addressed to whoever originally posted it.
      admitComment({ name: item.name, text, ts: Date.now() });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, action, items: pending }));
  }

  // Extension-agnostic: Edge returns mp3, espeak returns wav; the client just asks for /audio/<id> and
  // trusts the Content-Type. /audio/<id>/words is the Edge word-timestamp sidecar the browser's
  // lip-sync (web/lipsync.js) uses for word-accurate mouth shapes; it's simply absent for espeak lines.
  const a = url.pathname.match(/^\/audio\/([a-f0-9]{16})(?:\.\w+)?$/);
  if (req.method === 'GET' && a) {
    const rec = audioCache.get(a[1]);
    if (!rec) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': rec.mime, 'Content-Length': rec.buf.length, 'Cache-Control': 'no-store' });
    return res.end(rec.buf);
  }
  const w = url.pathname.match(/^\/audio\/([a-f0-9]{16})\/words$/);
  if (req.method === 'GET' && w) {
    const rec = audioCache.get(w[1]);
    res.writeHead(rec ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ words: (rec && rec.words) || null }));
  }

  if (req.method === 'GET' && url.pathname === '/voices') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ engine: TTS_ENGINE, catalog: VOICE_CATALOG, current: voiceChoice, dialect: AR_DIALECT }));
  }
  // Lets the publisher pick a different free Edge voice per language, live - a "choosable" voice, not
  // voice cloning (no reference-audio upload here; see README "Voice").
  if (req.method === 'POST' && url.pathname === '/voice') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 1024));
      const known = id => VOICE_CATALOG.some(v => v.id === id);
      if (typeof body.en === 'string' && known(body.en)) voiceChoice.en = body.en;
      if (typeof body.ar === 'string' && known(body.ar)) voiceChoice.ar = body.ar;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ current: voiceChoice }));
    } catch (e) { res.writeHead(400); return res.end(String(e.message || 'bad request')); }
  }

  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  // Everything else: static web/ assets (GET/HEAD only; every API route above already returned by now).
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
  res.writeHead(404); res.end();
}).listen(PORT, () => {
  const p = brain.providers();
  const chain = [p.custom && 'custom', p.groq && 'Groq', p.claude && 'Claude', p.free.length && `free(${p.free.join(',')})`, 'rules'].filter(Boolean).join(' -> ');
  console.log(`chat server on :${PORT} (replies: ${chain}; voice: ${TTS_ENGINE}${TTS_ENGINE === 'edge' ? ` [en=${voiceChoice.en} ar=${voiceChoice.ar}], espeak fallback` : ''}; baseline loop: ${loopEnabled ? SCRIPT.length + ' lines' : 'off'}; replies mode: ${repliesMode}; script-protect: ${scriptProtect ? 'on' : 'off'}; voice[script=${voiceScript ? 'on' : 'off'}, replies=${voiceReplies ? 'on' : 'off'}]; admin auth: ${ADMIN_TOKEN ? 'on' : 'OFF (set ADMIN_TOKEN for any public deploy)'}; static web root: ${STATIC_ROOT})`);
  if (loopEnabled) scheduleBaseline();
});

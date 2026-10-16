'use strict';
/*
 * Client for the VoiceTut TTS microservice (../voicetut/app.py): Egyptian Arabic + English code-switching
 * (https://huggingface.co/mohammedaly22/VoiceTut-TTS). Plain HTTP, no dependencies (Node 18+ fetch).
 *
 *   enabled                      true when VOICETUT_URL is set
 *   synth(text, {speaker, ...})  -> { audio: Buffer(wav 16-bit mono), mime, durationMs, leadMs }
 *   speakers()                   -> [{name, gender, tags}] (cached; falls back to the model-card names)
 *   state()                      -> {enabled, up, lastError, ...} for /voices and the admin panel
 *
 * Failure policy: any error or timeout throws; after a failure the service is skipped for COOLDOWN_MS so a
 * dead GPU box costs one slow line, not one slow line per comment. server.js catches and falls back to Edge/espeak.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const URL_BASE = (process.env.VOICETUT_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VOICETUT_TOKEN || '';
const TIMEOUT_MS = Number(process.env.VOICETUT_TIMEOUT_MS || 90000);
const COOLDOWN_MS = Number(process.env.VOICETUT_COOLDOWN_MS || 5000);
const DEFAULT_SPEAKER = process.env.VOICETUT_SPEAKER || 'Mohamed';
const SPEED = process.env.VOICETUT_SPEED ? Number(process.env.VOICETUT_SPEED) : undefined;

const CARD_SPEAKERS = ['Mohamed', 'Abdelrahman', 'Abdullah', 'Kamal', 'Hossam', 'Omar', 'Sayed', 'Zaki', 'Aly', 'Essam', 'Ahmed',
  'Asmaa', 'Esraa', 'Hanan', 'Sarah', 'Yasmin', 'Omnia'];
const FEMALE = new Set(['Asmaa', 'Esraa', 'Hanan', 'Sarah', 'Yasmin', 'Omnia']);

// ---- "My voice": the publisher's own recording, used for zero-shot cloning (the service never stores anything permanently:
// we keep the reference here and re-send it whenever the service has lost it, e.g. after a Space restart) ----
const MY_NAME = 'My voice';
const MY_DIR = process.env.MYVOICE_DIR || path.join(__dirname, 'voice');
let myRef = null;                     // { id, wav: Buffer, text, ms }
function loadMyRef() {
  try {
    const wav = fs.readFileSync(path.join(MY_DIR, 'my-voice.wav'));
    let text = ''; try { text = fs.readFileSync(path.join(MY_DIR, 'my-voice.txt'), 'utf8').trim(); } catch {}
    if (wav.length > 1000) myRef = { id: crypto.createHash('sha1').update(wav).update(text).digest('hex').slice(0, 20), wav, text };
  } catch {}
}
function setMyRef(wav, text, ms) {
  const id = crypto.createHash('sha1').update(wav).update(text).digest('hex').slice(0, 20);
  myRef = { id, wav, text, ms };
  try { fs.mkdirSync(MY_DIR, { recursive: true }); fs.writeFileSync(path.join(MY_DIR, 'my-voice.wav'), wav); fs.writeFileSync(path.join(MY_DIR, 'my-voice.txt'), text); } catch (e) { console.error('could not save my-voice to disk (kept in memory):', e.message); }
  return id;
}
function clearMyRef() { myRef = null; for (const f of ['my-voice.wav', 'my-voice.txt']) { try { fs.unlinkSync(path.join(MY_DIR, f)); } catch {} } }
loadMyRef();
async function uploadRef() {
  const r = await fetchT('/ref/' + myRef.id, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ audio_b64: myRef.wav.toString('base64'), text: myRef.text }) }, 20000);
  if (!r.ok) throw new Error('VoiceTut reference upload HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
}

let lastFailure = null;                // { msg, at } - kept after a later success so the publisher can still see what went wrong
let downUntil = 0, lastError = '', lastOkAt = 0, lastRtf = null, speakerList = null, lastDurationMs = 0;

const headers = extra => Object.assign(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}, extra || {});
async function fetchT(path, opts, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(URL_BASE + path, Object.assign({ signal: ac.signal }, opts)); }
  finally { clearTimeout(t); }
}

const READY_WAIT_MS = Number(process.env.VOICETUT_READY_WAIT_MS || 90000);
const netText = e => e && e.cause && (e.cause.code || e.cause.message) ? `${e.message} (${e.cause.code || e.cause.message})` : String((e && e.message) || e);
// The voice service takes a while to start (imports PyTorch, loads the model) and the chat server is up long before it: a line spoken in
// that window used to fail instantly ("fetch failed") and fall through to a fallback voice. Wait for /health instead.
async function waitReady() {
  const end = Date.now() + READY_WAIT_MS;
  while (Date.now() < end) {
    try { const r = await fetchT('/health', { headers: headers() }, 4000); const j = await r.json(); if (j && j.ok) return true; } catch {}
    await new Promise(s => setTimeout(s, 1000));
  }
  return false;
}
async function synth(text, { speaker, speed, timeoutMs } = {}) {
  if (!URL_BASE) throw new Error('VOICETUT_URL not set');
  if (Date.now() < downUntil) throw new Error('VoiceTut cooling down after: ' + lastError);
  const t0 = Date.now();
  const mine = speaker === MY_NAME && !!myRef;
  const post = () => fetchT('/tts', {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(mine ? { text, ref_id: myRef.id, speed: speed || SPEED } : { text, speaker: (speaker && speaker !== MY_NAME) ? speaker : DEFAULT_SPEAKER, speed: speed || SPEED }),
  }, timeoutMs || TIMEOUT_MS);
  try {
    let r;
    try { r = await post(); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      console.error('VoiceTut connection failed (' + netText(e) + '): waiting for the voice service to be ready ...');
      if (!(await waitReady())) throw new Error('voice service not ready after ' + READY_WAIT_MS + ' ms (' + netText(e) + ')');
      r = await post();
    }
    if (mine && r.status === 404) { await uploadRef(); r = await post(); }       // the service lost the reference (restart): send it again, once
    if (r.status >= 500 && r.status !== 501) { await new Promise(s => setTimeout(s, 600)); r = await post(); }   // transient server error: one retry before giving up
    if (!r.ok) throw new Error('VoiceTut HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const audio = Buffer.from(await r.arrayBuffer());
    if (audio.length < 100 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('VoiceTut returned non-WAV data');
    const durationMs = Number(r.headers.get('x-duration-ms')) || 0;
    lastOkAt = Date.now(); lastError = ''; downUntil = 0; lastDurationMs = durationMs;
    if (durationMs) lastRtf = +(((Date.now() - t0) / durationMs)).toFixed(2);
    return { audio, mime: 'audio/wav', durationMs, leadMs: Number(r.headers.get('x-trim-lead-ms')) || 0 };
  } catch (e) {
    lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs || TIMEOUT_MS} ms` : netText(e);
    downUntil = Date.now() + COOLDOWN_MS;
    lastFailure = { msg: lastError, at: Date.now() };
    throw new Error(lastError);
  }
}

async function speakers() {
  const base = await baseSpeakers();
  return myRef ? [{ name: MY_NAME, gender: null, tags: ['cloned'] }, ...base] : base;
}
async function baseSpeakers() {
  if (speakerList) return speakerList;
  if (!URL_BASE) return [];
  try {
    const r = await fetchT('/speakers', { headers: headers() }, 8000);
    if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) return (speakerList = j); }
  } catch {}
  return CARD_SPEAKERS.map(name => ({ name, gender: FEMALE.has(name) ? 'female' : 'male', tags: [] }));   // not cached: retry later
}

// one real short generation, with timing or the exact error (GET /voices/test, admin)
async function selftest() {
  if (!URL_BASE) return { ok: false, error: 'VOICETUT_URL not set' };
  const t0 = Date.now();
  try { const r = await synth('اهلا بيكم في اللايف', { speaker: myRef ? MY_NAME : undefined, timeoutMs: 120000 }); return { ok: true, ms: Date.now() - t0, audioMs: r.durationMs, bytes: r.audio.length, voice: myRef ? MY_NAME : DEFAULT_SPEAKER }; }
  catch (e) { return { ok: false, error: e.message, ms: Date.now() - t0 }; }
}

// cheap reachability probe for /voices (never throws)
async function probe() {
  if (!URL_BASE) return false;
  try { const r = await fetchT('/health', { headers: headers() }, 4000); const j = await r.json(); return !!(j && j.ok); }
  catch { return false; }
}

module.exports = {
  get enabled() { return !!URL_BASE; },
  defaultSpeaker: DEFAULT_SPEAKER,
  synth, speakers, probe, selftest,
  MY_NAME, setMyRef, clearMyRef, uploadRef,
  get hasMyRef() { return !!myRef; },
  myRefInfo: () => myRef ? { has: true, text: myRef.text, ms: myRef.ms || null, id: myRef.id } : { has: false },
  state: () => ({ enabled: !!URL_BASE, cooling: Date.now() < downUntil, lastFailure, lastError, lastOkAt, lastRtf, lastDurationMs, timeoutMs: TIMEOUT_MS }),
};

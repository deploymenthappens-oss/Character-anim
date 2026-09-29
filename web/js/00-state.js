// =====================================================================
//  00-state.js — shared constants, mutable state, small utilities.
//  Loaded FIRST. Classic <script> tags share one global scope in the
//  browser, so every let/const declared here is visible to every other
//  js/*.js file loaded after it, in order, on the page.
// =====================================================================
const $ = id => document.getElementById(id);
const ICE_SERVERS = []; // add STUN/TURN here for internet use

const QUALITY = {
  '360':  {w: 640,  h: 360,  kbps: 800},
  '720':  {w: 1280, h: 720,  kbps: 2500},
  '1080': {w: 1920, h: 1080, kbps: 4500},
};

let ADMIN_TOKEN = '';
try { ADMIN_TOKEN = localStorage.getItem('adminToken') || ''; } catch(e) {}

// ── shared mutable state ─────────────────────────────────────────────
let pc = null, sessionUrl = null, facing = 'user';
let camStream = null, outStream = null, audioCtx = null, speaker = null;
let drawTimer = null, statsTimer = null, wakeLock = null;
let wantLive = false, last = {t: 0, b: 0};
let speakChain = Promise.resolve(), pending = 0;
let previewCtx = null, previewSpeaker = null;
let lastReply = null;
let avatarMinimized = false;
let voiceMuted = false;
let talkStopped = false;
let showLegs = true, legsTmp = null;
let bgPulse = 0;
let bgTransition = null, prevBgTheme = 'aurora';
let scene3dFree = false;   // free-roam gate for the 'studio-office-3d' scene, mirrored from /scene3d-free
let currentScriptLines = [];

// ── Scene zoom spring ────────────────────────────────────────────────
// sceneZoomTarget: desired zoom level (1.0 = 100%).
// sceneZoomCurrent: the actual interpolated value used each frame.
// Smooth spring so buttons feel fluid, not snappy.
let sceneZoomTarget  = 1.0;   // set by buttons/slider
let sceneZoomCurrent = 1.0;   // interpolated toward target each frame
const SCENE_ZOOM_MIN = 0.50;
const SCENE_ZOOM_MAX = 2.00;
const SCENE_ZOOM_STEP = 0.10; // per button click
const SCENE_ZOOM_SPRING = 3.5; // lower = softer/slower settle (was 8 → ~120ms snap; this → ~300ms ease)

// ── Room ambient "breathing" zoom (Ken Burns) ──────────────────────────
// A slow, continuous ±amount zoom cycle layered UNDER the manual scene
// zoom, active only while the Hawkins-room background is showing (centered
// stage layout). Purely additive/multiplicative — never fights the user's
// own zoom target, and backs off automatically for prefers-reduced-motion.
const ROOM_AMBIENT_ZOOM_AMOUNT = 0.035; // ±3.5% breathing range
const ROOM_AMBIENT_ZOOM_PERIOD = 16;    // seconds for one full in→out cycle
const prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ── utilities ────────────────────────────────────────────────────────
function adminFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (ADMIN_TOKEN) headers['Authorization'] = 'Bearer ' + ADMIN_TOKEN;
  return fetch(path, Object.assign({}, opts, {headers}));
}
function log(m)               { $('log').textContent = `[${new Date().toLocaleTimeString()}] ${m}\n` + $('log').textContent; }
function setStatus(t, cls='') { $('status').textContent = t; $('status').className = cls; }
function cleanName()          { return ($('name').value||'').trim().replace(/[^A-Za-z0-9_-]/g,'')||'mystream'; }
function setLiveUI(live)      { $('go').textContent = live ? 'Stop streaming' : 'Start streaming'; $('go').className = live ? 'live' : 'go'; $('name').disabled = $('quality').disabled = live; }
function getActiveSpeaker()   { return speaker || previewSpeaker; }

const easeInOutCubic = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x+2, 3)/2;

// ── avatar rig ────────────────────────────────────────────────────────
const rig = new AvatarRig({canvas: $('avatarCanvas')});

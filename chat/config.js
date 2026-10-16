'use strict';
/*
 * ONE PLACE FOR EVERY SETTING.  Nothing needs to be set in Railway: the values below are used as defaults
 * (an environment variable with the same name still wins, if you ever do set one).
 *
 *   >>> This file contains your admin password and (optionally) your Hugging Face token.
 *   >>> Keep the repository PRIVATE.  Change ADMIN_PASSWORD before you deploy if you like.
 */
const CONFIG = {
  // ---- publisher login (the lock screen on /publish.html) -----------------------------------------------------
  ADMIN_TOKEN: 'DDLxp_ueoROuc7uQnyw',

  // ---- Hugging Face (optional; both are only used if you fill them in) ----------------------------------------
  // HF_TOKEN: a "read" token from https://huggingface.co/settings/tokens  (starts with hf_).
  //   - used as the key for Hugging Face's free OpenAI-compatible router, which gives Egyptian replies a stronger
  //     model than the keyless gateways (falls back to the free gateways automatically if it fails);
  //   - used to call your VoiceTut Space when that Space is PRIVATE.
  HF_TOKEN: '',
  HF_LLM_MODEL: 'Qwen/Qwen2.5-72B-Instruct',

  // >>> To speak in YOUR OWN voice (clone), run the CPU service in ./cairo and put its URL below (see CAIRO_SETUP.md).
  // VoiceTut = the most natural Egyptian voice (see HF_VOICE_SETUP.md). Leave the URL empty to use the built-in
  // Egyptian neural voices (Microsoft Edge ar-EG), which need no GPU and no account.
  //   e.g.  VOICETUT_URL: 'https://your-name-voicetut.hf.space'
  VOICETUT_URL: '',
  VOICETUT_TOKEN: '',            // empty = use HF_TOKEN. (Only needed if the Space is public and you set its own secret.)
  VOICETUT_SPEAKER: 'Mohamed',   // Mohamed Abdelrahman Abdullah Kamal Hossam Omar Sayed Zaki Aly Essam Ahmed | Asmaa Esraa Hanan Sarah Yasmin Omnia
  VOICETUT_TIMEOUT_MS: '30000',

  // ---- language: everything the avatar says is Egyptian Arabic -------------------------------------------------
  REPLY_LANG: 'egy',             // 'egy' = always answer in Egyptian Arabic | 'match' = answer in the viewer's language
  AVATAR_AR_DIALECT: 'egy',      // lip-sync letter table: Egyptian pronunciation (hard g, etc.)
  TTS_VOICE_AR_EDGE: 'ar-EG-ShakirNeural',   // male Egyptian.  Female: 'ar-EG-SalmaNeural'
  TTS_VOICE_EN_EDGE: 'en-US-GuyNeural',

  // ---- comments -> magic tricks --------------------------------------------------------------------------------
  COMMENT_MAGIC: 'on',           // a viewer can type "افتح العالم المقلوب" / "ارقص" / "upside down" ... and the avatar does it
  COMMENT_MAGIC_SPELL_COOLDOWN_MS: '30000',
  COMMENT_MAGIC_GESTURE_COOLDOWN_MS: '6000',

  // ---- reply brain ---------------------------------------------------------------------------------------------
  FREE_LLM_ORDER: 'llm7,kilo,ovh',
  AVATAR_PERSONA: 'شخصية كرتونية مصرية ظريفة وخفيفة الدم بتقدم لايف',
  AVATAR_LOOP: 'off',            // 'on' = keep reciting the script while nobody comments
  AVATAR_REPLIES: 'all',         // 'all' | 'mention' | 'review' | 'off'
};

// Where the publisher password comes from (logged at startup by server.js): a Railway variable named ADMIN_TOKEN always wins.
const ADMIN_SOURCE = (process.env.ADMIN_TOKEN || '') !== '' ? 'Railway/environment variable ADMIN_TOKEN' : 'config.js (no ADMIN_TOKEN variable set)';
for (const [k, v] of Object.entries(CONFIG)) {
  if (process.env[k] === undefined || process.env[k] === '') process.env[k] = String(v);
}
// derived defaults (only when not already set)
// the all-in-one Docker image runs Cairo-TTS inside the container (CAIRO_LOCAL=1): use it unless an external URL is configured
// the all-in-one image can run the Egyptian TTS pipeline (../tts) instead: start.sh sets EGY_LOCAL=1 and EGY_PORT when it launches it
if (!process.env.VOICETUT_URL && process.env.EGY_LOCAL === '1') process.env.VOICETUT_URL = 'http://127.0.0.1:' + (process.env.EGY_PORT || 8000);
if (!process.env.VOICETUT_URL && process.env.CAIRO_LOCAL === '1') process.env.VOICETUT_URL = 'http://127.0.0.1:7860';
if (!process.env.VOICETUT_TOKEN && process.env.HF_TOKEN) process.env.VOICETUT_TOKEN = process.env.HF_TOKEN;
if (process.env.HF_TOKEN && !process.env.OPENAI_BASE_URL) {
  process.env.OPENAI_BASE_URL = 'https://router.huggingface.co/v1';
  process.env.OPENAI_API_KEY = process.env.HF_TOKEN;
  process.env.OPENAI_MODEL = process.env.HF_LLM_MODEL;
  if (!process.env.LLM_ENGINE) process.env.LLM_ENGINE = 'auto';       // custom endpoint first, then the free gateways, then rules
}
module.exports = Object.assign(CONFIG, { ADMIN_SOURCE });

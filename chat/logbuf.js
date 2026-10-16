'use strict';
/*
 * In-memory log buffer for the Node stream server. Wraps console.log/info/warn/error/debug (output still goes to
 * stdout/stderr exactly as before) and keeps the last LOG_BUFFER_LINES (default 1000) lines so the admin dashboard's
 * Logs tab can read them through  GET /logs  (guarded by requireAdmin in server.js).
 *
 * Require this file FIRST in server.js so that start-up lines from every other module are captured too.
 * Secrets never enter the buffer: Bearer tokens, common API-key shapes and the value of any environment variable whose
 * name contains TOKEN / KEY / SECRET / PASSWORD / PASS are replaced with ***.
 */
const util = require('util');

const MAX = Math.max(100, Number(process.env.LOG_BUFFER_LINES) || 1000);
const MAX_LINE = 2000;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const BOOT = Date.now().toString(36);          // changes on every restart so a polling client knows its cursor is stale
const buf = [];
let nextId = 1;

const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASS\b/i;
function redact(s) {
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 ***')
       .replace(/\b(sk|gsk|hf|ghp|xox[bp])[-_][A-Za-z0-9_-]{12,}/g, '***')
       .replace(/((?:token|password|passwd|api[_-]?key|secret)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, '$1***');
  for (const [k, v] of Object.entries(process.env)) {       // exact values of configured secrets, wherever they show up
    if (v && v.length >= 8 && SECRET_NAME.test(k) && s.includes(v)) s = s.split(v).join('***');
  }
  return s;
}

function push(level, args) {
  let msg;
  try { msg = util.format(...args); } catch { msg = String(args[0]); }
  msg = redact(msg);
  if (msg.length > MAX_LINE) msg = msg.slice(0, MAX_LINE) + ' …[truncated]';
  buf.push({ id: nextId++, t: Date.now(), level, src: 'node', msg });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

for (const [method, level] of [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error']]) {
  const orig = console[method].bind(console);
  console[method] = (...args) => { try { push(level, args); } catch { /* logging must never break the server */ } orig(...args); };
}

/** Lines newer than `since` (an id), at least `minLevel`, oldest first, at most `limit`. */
function read({ since = 0, level = 'debug', limit = 300 } = {}) {
  const min = LEVELS[level] || 0;
  limit = Math.max(1, Math.min(MAX, Number(limit) || 300));
  const sinceId = Number(since) || 0;
  let items = buf.filter(e => e.id > sinceId && LEVELS[e.level] >= min);
  if (items.length > limit) items = items.slice(items.length - limit);
  return { service: 'node', boot: BOOT, next: nextId - 1, items };
}

module.exports = { read, push, LEVELS };

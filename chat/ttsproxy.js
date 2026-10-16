'use strict';
/*
 * Reverse proxy for the built-in Egyptian TTS service (../tts, Python) so that ONE public port serves everything on Railway:
 *
 *   /admin            TTS admin dashboard            (login = the service's own TTS_ADMIN_TOKEN, NOT the publisher ADMIN_TOKEN)
 *   /admin/docs       API documentation
 *   /admin/api/*      everything the dashboard does, scriptable with  Authorization: Bearer $TTS_ADMIN_TOKEN
 *
 * Only those paths are forwarded. The voice routes themselves (/tts, /ref, /speakers, /metrics) are NOT exposed publicly:
 * the chat server talks to them over 127.0.0.1. Authentication is done by the Python service (this file never sees a token).
 * The existing publisher-lock routes /admin/status, /admin/check, /admin/login stay with server.js (no clash with the paths above).
 *
 * Env: EGY_PORT (8000) or EGY_UPSTREAM (full base URL) tell it where the Python service listens.
 */
const http = require('http');

const upstream = () => {
  const base = (process.env.EGY_UPSTREAM || ('http://127.0.0.1:' + (process.env.EGY_PORT || 8000))).replace(/\/+$/, '');
  return new URL(base);
};
const isTtsAdminPath = p => p === '/admin' || p === '/admin/' || p === '/admin/docs' || p === '/admin/api' || p.startsWith('/admin/api/');
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function handle(req, res, url) {
  if (!isTtsAdminPath(url.pathname)) return false;
  const up = upstream();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  // tell the Python side who the real client is (its login lockout is per IP) and which scheme the browser used (Secure cookie)
  const peer = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] : peer;
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  const pr = http.request({ hostname: up.hostname, port: up.port || 80, path: req.url, method: req.method, headers }, r => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  pr.on('error', e => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'TTS service is not running or still starting', detail: String(e.code || e.message), hint: 'check TTS_BACKEND (egy) and the deploy logs' }));
  });
  req.on('aborted', () => pr.destroy());
  req.pipe(pr);
  return true;
}

module.exports = { handle, isTtsAdminPath };

'use strict';
/*
 * Microsoft Edge "Read Aloud" neural voices - free, no API key, Arabic included.
 * A small clean-room client for the same WebSocket protocol Edge itself uses (MIT, only depends on `ws`).
 *
 * It is an UNOFFICIAL, undocumented endpoint: Microsoft can change it at any time. Everything that calls
 * this must be prepared for it to fail (tts.js falls back to Google, then to the built-in espeak-ng).
 *
 *   synth(text, {voice, rate, pitch, volume, boundary}) -> { audio: Buffer(mp3), mime, words: [{t,d,w}] | null }
 *
 * `words` are the engine's own word timestamps in SECONDS (t = start, d = duration): the lip-sync uses them
 * to place every word exactly, when they line up with the text.
 */
const crypto = require('crypto');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';        // public constant shipped in Edge
const CHROMIUM_FULL = process.env.EDGE_CHROMIUM_VERSION || '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL.split('.')[0];
const WSS_URL = process.env.EDGE_WSS_URL || 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH = 11644473600n;                                           // seconds between 1601 and 1970
const OUTPUT_FORMAT = process.env.EDGE_OUTPUT_FORMAT || 'audio-24khz-48kbitrate-mono-mp3';

let clockSkew = 0;                                                         // seconds: server clock - our clock

// The service wants a token derived from the current time (rounded to 5 minutes) and the client token.
function secMsGec(now = Date.now()) {
  let ticks = BigInt(Math.floor(now / 1000 + clockSkew)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;                                                      // 100-nanosecond units (BigInt: exceeds 2^53)
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

const escapeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// XML 1.0 does not allow most control characters; the service closes the socket if it sees one
const stripBad = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = n => String(n).padStart(2, '0');
// the exact date format Edge sends: "Mon Sep 21 2026 07:30:00 GMT+0000 (Coordinated Universal Time)"
const stamp = () => {
  const d = new Date();
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
};

function ssml(text, { voice, rate = '+0%', pitch = '+0Hz', volume = '+0%' }) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(stripBad(text))}</prosody></voice></speak>`;
}
const pct = n => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;

function connectOnce(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: Math.min(8000, timeoutMs), maxPayload: 8 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => {
      // a 403 usually means our clock is off: the Date header of the answer tells us by how much
      const err = new Error(`Edge TTS HTTP ${res.statusCode}`);
      err.status = res.statusCode;
      if (res.headers.date) {
        const server = Date.parse(res.headers.date);
        if (Number.isFinite(server)) err.skew = (server - Date.now()) / 1000;
      }
      res.resume();
      reject(err);
    });
  });
}

async function connect(timeoutMs) {
  const build = () => {
    const id = crypto.randomUUID().replace(/-/g, '');
    return {
      url: `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${id}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL}`,
      headers: {
        'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br, zstd', 'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Cookie': `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    };
  };
  let b = build();
  try { return await connectOnce(b.url, b.headers, timeoutMs); }
  catch (e) {
    if (e.status === 403 && typeof e.skew === 'number') {                  // correct the clock once and retry
      clockSkew = e.skew; b = build();
      return connectOnce(b.url, b.headers, timeoutMs);
    }
    throw e;
  }
}

function synth(text, opts = {}) {
  const { voice, rate = 0, pitch = 0, volume = 0, boundary = process.env.EDGE_BOUNDARY || 'word', timeoutMs = 15000 } = opts;
  if (!voice) return Promise.reject(new Error('Edge TTS: no voice'));
  const wantWords = boundary === 'word', wantSent = boundary === 'sentence';
  return new Promise(async (resolve, reject) => {
    let ws, done = false;
    const chunks = [], words = [];
    const finish = (err, val) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Edge TTS timed out')), timeoutMs);
    try { ws = await connect(timeoutMs); } catch (e) { return finish(e); }
    if (done) { try { ws.close(); } catch {} return; }

    ws.on('error', e => finish(e));
    ws.on('close', () => finish(chunks.length ? null : new Error('Edge TTS closed without audio'), chunks.length ? result() : undefined));
    const result = () => ({
      audio: Buffer.concat(chunks), mime: /webm/.test(OUTPUT_FORMAT) ? 'audio/webm' : 'audio/mpeg',
      words: words.length ? words : null,
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {                                                       // text frame: headers \r\n\r\n body
        const s = data.toString('utf8');
        const cut = s.indexOf('\r\n\r\n');
        const head = cut < 0 ? s : s.slice(0, cut), body = cut < 0 ? '' : s.slice(cut + 4);
        if (/Path:audio\.metadata/i.test(head)) {
          try {
            for (const m of (JSON.parse(body).Metadata || [])) {
              if ((m.Type === 'WordBoundary' || m.Type === 'SentenceBoundary') && m.Data) {
                words.push({ t: m.Data.Offset / 1e7, d: m.Data.Duration / 1e7, w: (m.Data.text && m.Data.text.Text) || '', type: m.Type });
              }
            }
          } catch {}
        } else if (/Path:turn\.end/i.test(head)) {
          finish(chunks.length ? null : new Error('Edge TTS returned no audio'), chunks.length ? result() : undefined);
        }
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));   // binary frame: 2-byte header length, headers, audio
      if (buf.length < 2) return;
      const hl = buf.readUInt16BE(0);
      if (buf.length < 2 + hl) return;
      if (!/Path:audio\r\n/i.test(buf.toString('utf8', 2, 2 + hl))) return;
      if (buf.length > 2 + hl) chunks.push(buf.subarray(2 + hl));
    });

    const requestId = crypto.randomUUID().replace(/-/g, '');
    const cfg = { context: { synthesis: { audio: {
      metadataoptions: { sentenceBoundaryEnabled: String(wantSent), wordBoundaryEnabled: String(wantWords) },
      outputFormat: OUTPUT_FORMAT } } } };
    ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(cfg)}\r\n`,
      err => { if (err) return finish(err); });
    ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n` +
      ssml(text, { voice, rate: typeof rate === 'number' ? pct(rate) : rate, pitch: typeof pitch === 'number' ? `${pitch >= 0 ? '+' : ''}${pitch}Hz` : pitch, volume: typeof volume === 'number' ? pct(volume) : volume }),
      err => { if (err) return finish(err); });
  });
}

module.exports = { synth, secMsGec, ssml, _setClockSkew: v => { clockSkew = v; } };

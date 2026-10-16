// "My voice": record (or upload) a short clip of the publisher, convert it to 24 kHz mono WAV in the browser,
// send it to the server (POST /myvoice), which uses it to clone the voice for every reply and script line.
(function () {
  const need = ['mvRec', 'mvStop', 'mvPlay', 'mvSave', 'mvClear', 'mvFile', 'mvText', 'mvState'];
  if (!need.every(id => document.getElementById(id))) return;
  const el = id => document.getElementById(id);
  let rec = null, chunks = [], stream = null, wavBlob = null, previewUrl = null, timer = null;
  const MAX_MS = 15000, SR = 24000;

  const say = (t, bad) => { el('mvState').textContent = t; el('mvState').style.color = bad ? '#ff8a80' : ''; };

  async function toWav(blob) {                      // any browser audio -> mono 24 kHz 16-bit WAV, max 15 s
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer()); ctx.close();
    const len = Math.min(buf.length, Math.floor(buf.sampleRate * MAX_MS / 1000));
    const off = new OfflineAudioContext(1, Math.ceil(len * SR / buf.sampleRate), SR);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const out = (await off.startRendering()).getChannelData(0);
    let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const g = peak > 0 ? Math.min(4, 0.9 / peak) : 1;           // normalise the level so a quiet mic still clones well
    const pcm = new DataView(new ArrayBuffer(44 + out.length * 2)), w = (o, s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); pcm.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVEfmt '); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true);
    pcm.setUint16(22, 1, true); pcm.setUint32(24, SR, true); pcm.setUint32(28, SR * 2, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true);
    w(36, 'data'); pcm.setUint32(40, out.length * 2, true);
    for (let i = 0; i < out.length; i++) pcm.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i] * g)) * 32767, true);
    return { blob: new Blob([pcm], { type: 'audio/wav' }), seconds: out.length / SR };
  }

  async function setClip(blob) {
    try {
      const r = await toWav(blob);
      if (r.seconds < 3) { say('Too short (' + r.seconds.toFixed(1) + ' s). Record 8-12 seconds.', true); return; }
      wavBlob = r.blob;
      if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(wavBlob);
      el('mvPlay').disabled = el('mvSave').disabled = false;
      say('Got ' + r.seconds.toFixed(1) + ' s. Press Listen to check it, then "Use my voice".');
    } catch (e) { say('Could not read that audio: ' + e.message, true); }
  }

  el('mvRec').onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
      chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); clearTimeout(timer); el('mvRec').disabled = false; el('mvStop').disabled = true; setClip(new Blob(chunks, { type: rec.mimeType })); };
      rec.start(); el('mvRec').disabled = true; el('mvStop').disabled = false; say('Recording... read the text, then press Stop (auto-stops at 15 s).');
      timer = setTimeout(() => rec && rec.state === 'recording' && rec.stop(), MAX_MS);
    } catch (e) { say('Microphone not available: ' + e.message, true); }
  };
  el('mvStop').onclick = () => rec && rec.state === 'recording' && rec.stop();
  el('mvFile').onchange = e => { const f = e.target.files[0]; if (f) setClip(f); };
  el('mvPlay').onclick = () => previewUrl && new Audio(previewUrl).play();

  el('mvSave').onclick = async () => {
    if (!wavBlob) return;
    say('Cloning... (the first line spoken afterwards can take a few seconds)');
    try {
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error('read failed')); fr.readAsDataURL(wavBlob); });
      const r = await adminFetch('myvoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_b64: b64, text: el('mvText').value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const sel = el('voiceVt'); if (sel && ![...sel.options].some(o => o.value === 'My voice')) sel.add(new Option('My voice (cloned)', 'My voice'), 0);
      if (sel) sel.value = 'My voice'; if (el('voiceVtRow')) el('voiceVtRow').hidden = false;
      say('Done. Replies and the script are now spoken in your voice. Use "Test voice" to hear it.');
      if (typeof log === 'function') log('my voice cloned and active');
    } catch (e) { say('Failed: ' + e.message, true); }
  };
  el('mvClear').onclick = async () => {
    try { await adminFetch('myvoice', { method: 'DELETE' }); const sel = el('voiceVt'); if (sel) [...sel.options].forEach(o => o.value === 'My voice' && o.remove()); say('Forgotten. Back to the stock Egyptian voice.'); }
    catch (e) { say('Failed: ' + e.message, true); }
  };

  fetch('myvoice').then(r => r.json()).then(j => {
    if (!j.enabled) say('Needs the VoiceTut GPU service (see HF_VOICE_SETUP.md). Until then the stock Egyptian voice speaks.', true);
    else if (j.has) { say('Your voice is saved' + (j.active ? ' and active.' : '.')); const sel = el('voiceVt'); if (sel && ![...sel.options].some(o => o.value === 'My voice')) sel.add(new Option('My voice (cloned)', 'My voice'), 0); if (sel && j.active) sel.value = 'My voice'; }
    else say('No voice recorded yet.');
  }).catch(() => say('Could not reach the server.', true));
})();

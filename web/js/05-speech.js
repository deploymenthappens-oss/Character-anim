// =====================================================================
//  05-speech.js — reply/speech playback, speech-triggered gesture cues,
//  provider badge, gesture broadcast helpers, and the pending-approval list.
// =====================================================================
const motion=()=>({gesture:$('mGesture').checked, wave:$('mWave').checked});

function unlockPreviewAudio() {
  if (!previewCtx) { const AC=window.AudioContext||window.webkitAudioContext; previewCtx=new AC(); }
  if (previewCtx.state==='suspended') previewCtx.resume().catch(()=>{});
}
function getSpeaker() {
  if (speaker) return speaker;
  unlockPreviewAudio();
  if (previewCtx.state==='suspended') log('tap anywhere on this page once to allow sound');
  if (!previewSpeaker) previewSpeaker=new Speaker({rig, ctx:previewCtx, destination:previewCtx.destination, motion});
  return previewSpeaker;
}

const SPEECH_CUES=[
  {gesture:'glasses',   re:/\b(spec|specs|discount(ed)?|warrant(y|ies)|material)\b|\d+\s*%\s*off|\bpercent\s+off\b/i},
  {gesture:'lean',      re:/\b(secret|code|between\s+us|exclusive|just\s+for\s+you)\b|\bonly\b[^.!?]{0,60}\b(you|people|viewers|watching|stream)\b/i},
  {gesture:'surprise',  re:/\b(sold\s+out|out\s+of\s+stock|units?\s+left|wow|whoa|no\s+way|can'?t\s+believe)\b/i},
  {gesture:'thinking',  re:/(\?|let me think|good question|hmm)/i},
  {gesture:'celebrate', re:/\b(congrat(s|ulations)?|hooray|yay|woo-?hoo|let'?s\s+go|we\s+did\s+it|best\s+seller|bestseller)\b/i},
  {gesture:'dance',     re:/\b(party|dance|dancing|music\s+time)\b/i},
  {gesture:'footTap',   re:/\b(waiting|hurry\s+up|any\s+(second|moment)\s+now)\b/i},
  // Product-spotlight cues — fire when the reply talks about the card that's on screen,
  // rather than only when the publisher pushes it. Kept separate from 'glasses' above
  // (specs/discount/material) so a plain "check it out" doesn't compete with those.
  {gesture:'present',   re:/\b(link\s+in\s+bio|swipe\s+up|tap\s+the\s+card|scan\s+the\s+(code|qr)|shop\s+now|grab\s+(one|yours)|add\s+to\s+cart|check\s+it\s+out|right\s+(here|there)\s+on\s+(the\s+)?screen)\b/i},
  {gesture:'footTap',   re:/\b(ends?\s+soon|last\s+chance|clock'?s?\s+ticking|almost\s+gone|going\s+fast)\b/i},
];
function pickSpeechCue(text) { for (const c of SPEECH_CUES) if (c.re.test(text)) return c.gesture; return null; }
function fireSpeechCue(text) {
  if (!$('mCue').checked||!rig.ready) return;
  const g=pickSpeechCue(text); if (!g) return;
  camPunch(0.7);
  if (g==='lean') rig.leanCue(); else if (rig.orchestra) rig.orchestra.cue(g);
}

function onReply(msg) {
  if (!rig.ready||talkStopped) return;
  if (msg.silent) {
    const short=msg.text.length>70?msg.text.slice(0,70)+'…':msg.text;
    log(`TEXT-ONLY reply (voice is off) — nothing spoken: "${short}"`);
    if (!msg.ack) fireSpeechCue(msg.text); return;
  }
  const sp=getSpeaker(); sp.setMuted(voiceMuted);
  pending++;
  speakChain=speakChain.then(async()=>{
    try {
      const [r,w]=await Promise.all([fetch(`audio/${msg.id}`), fetch(`audio/${msg.id}/words`).then(x=>x.ok?x.json():{words:null}).catch(()=>({words:null}))]);
      if (!r.ok) throw new Error('audio HTTP '+r.status);
      lastReply={bytes:await r.arrayBuffer(), text:msg.text, words:w.words||null};
      if (!msg.ack) fireSpeechCue(lastReply.text);
      await sp.say(lastReply.bytes, lastReply.text, {words:lastReply.words, motion:{wave:!msg.baseline}});
    } catch(e) { log('avatar speech failed: '+e.message); rig.setViseme(0); }
    finally { pending--; if (pending===0&&$('mStop').checked) rig.stopSpeechMotion(); }
  });
}
function onInterrupt() {
  const sp=getActiveSpeaker(); if (sp) sp.stop(); if (rig.ready) rig.setViseme(0);
}

// ──────────────────── provider badge ─────────────────────────────────
function setProviderBadge(mode) {
  const badge=$('providerBadge');
  const bucket=mode==='rules'?'rules':mode==='claude'?'claude':mode.startsWith('free:')?'free':'groq';
  const label=mode==='rules'?'Built-in rules':mode==='claude'?'Claude':mode==='custom'?'Custom endpoint':mode.startsWith('free:')?`Free (${mode.slice(5)})`:mode==='groq'?'Groq (fast reply)':mode;
  badge.className='stage-badge '+bucket; badge.textContent=label;
}
function onModeInfo(info) {
  const mode=typeof info==='string'?(info==='ai'?'claude':'rules'):(info.mode||'rules');
  setProviderBadge(mode);
  const p=(info&&info.providers)||{};
  const chain=[p.custom&&'a custom endpoint',p.groq&&'Groq',p.claude&&'Claude',p.free&&p.free.length&&`free gateways (${p.free.join(', ')})`].filter(Boolean);
  $('mode').textContent=chain.length?`Replies try: ${chain.join(' -> ')} -> built-in rules.`:'Replies use the free keyless gateways, falling back to simple built-in rules.';
  if (info&&typeof info.loop==='boolean') $('loopToggle').checked=info.loop;
  if (info&&info.replies){$('qReplies').value=info.replies;$('repliesModeSel').value=info.replies;}
  if (info&&typeof info.scriptProtect==='boolean') $('scriptProtectToggle').checked=info.scriptProtect;
  if (info&&typeof info.voiceScript==='boolean') $('scriptVoiceToggle').checked=info.voiceScript;
  if (info&&typeof info.voiceReplies==='boolean') $('repliesVoiceToggle').checked=info.voiceReplies;
}
function onVoiceInfo(v) {
  if (!v) return;
  if (window.AvatarInternals&&v.dialect) AvatarInternals.setDialect(v.dialect);
  const en=$('voiceEn'), ar=$('voiceAr');
  if (en&&v.en) en.value=v.en; if (ar&&v.ar) ar.value=v.ar;
}

// ──────────────────── gesture helpers ────────────────────────────────
function broadcastGesture(name, side) {
  adminFetch('gesture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,side:side||'R'})})
    .then(r=>{if(r.status===401)log('gesture not broadcast: admin token missing/invalid (set it under Admin access)');})
    .catch(e=>log('gesture broadcast failed: '+e.message));
}
function cueOrchestra(name) {
  if (!rig.ready) return log('avatar not ready');
  if (!rig.orchestra) return log('gesture library not loaded (check avatar-orchestra.js)');
  if (!rig.orchestra.cue(name)) log(`"${name}" skipped — arm is busy with something higher-priority`);
  broadcastGesture(name);
}

// ──────────────────── pending approvals ──────────────────────────────
function renderPending(items) {
  const list=$('pendingList'); list.textContent='';
  $('pendingState').textContent=items.length?items.length+' waiting':'nothing waiting';
  for (const it of items) {
    const row=document.createElement('div'); row.className='pending-row';
    const who=document.createElement('b'); who.textContent=it.name+': ';
    const edit=document.createElement('input'); edit.value=it.text; edit.setAttribute('aria-label','Reply text');
    const why=document.createElement('span'); why.className='note'; why.textContent=it.reason==='script-protect'?' (arrived mid-script)':' (held for review)';
    const btns=document.createElement('div'); btns.className='row';
    const okBtn=document.createElement('button'); okBtn.type='button'; okBtn.className='go'; okBtn.textContent='Approve & speak';
    const noBtn=document.createElement('button'); noBtn.type='button'; noBtn.textContent='Reject';
    okBtn.onclick=async()=>{okBtn.disabled=noBtn.disabled=true;try{await adminFetch('pending/'+it.id+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:edit.value})});}catch(e){log('approve failed: '+e.message);okBtn.disabled=noBtn.disabled=false;}};
    noBtn.onclick=async()=>{okBtn.disabled=noBtn.disabled=true;try{await adminFetch('pending/'+it.id+'/reject',{method:'POST'});}catch(e){log('reject failed: '+e.message);okBtn.disabled=noBtn.disabled=false;}};
    btns.append(okBtn,noBtn); row.append(who,why,document.createElement('br'),edit,btns); list.appendChild(row);
  }
}

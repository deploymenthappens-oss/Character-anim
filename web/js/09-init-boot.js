// =====================================================================
//  09-init-boot.js — every init*() function plus the boot sequence.
//  initRoom lives in 02-room.js alongside the Hawkins-room code.
// =====================================================================

function initAdmin() {
  $('adminTokenInput').value=ADMIN_TOKEN;
  $('adminTokenInput').addEventListener('change',()=>{
    ADMIN_TOKEN=$('adminTokenInput').value.trim();
    try{localStorage.setItem('adminToken',ADMIN_TOKEN);}catch(e){}
    $('adminState').textContent=ADMIN_TOKEN?'Token set.':'No token set — admin actions will be rejected if the server requires one.';
  });
  $('adminState').textContent=ADMIN_TOKEN?'Token set.':'No token set — admin actions will be rejected if the server requires one.';
}

function applyPointerToggles() {
  rig.setLooking($('mLook').checked);
  rig.setPointing($('mPoint').checked);
  if (rig.orchestra) rig.orchestra.enable('legs',$('mLegs').checked);
}

function initAvatar() {
  rig.load()
    .then(()=>{
      $('avatarState').textContent='ready ('+rig.version+')'+(rig.fkOk?'':' — old avatar.riv: arm/wave/pointing disabled');
      log('avatar loaded, '+rig.version+(rig.fkOk?'':' | arm control OFF: use avatar.riv from the v5 zip'));
      setTimeout(()=>{
        if(rig.legsClipped){$('avatarState').textContent+=' — LEGS MASKED: redeploy web/avatar.riv from v5.1+';log('LEGS MASKED: redeploy web/avatar.riv from v5.1+ and hard-refresh.');}
        else if(rig.legsClipped===false)log('legs: confirmed drawn (pixel check)');
      },4500);
      log('avatar.riv legs mask: '+({already:'v5.1+ file (ok)','patched-in-memory':'OLD file on server — patched in memory','not-found':'not found','disabled':'disabled'}[rig.rivPatch]||rig.rivPatch));
      log(rig.legsShown?'legs: shown'+(rig.orchestraDriver&&rig.orchestraDriver.legsOk?', leg IK driven':', but leg IK targets not found'):'legs: not shown');
      applyPointerToggles();
      if ($('mAutoEnter').checked) startWalkIn();
    })
    .catch(e=>{$('avatarState').textContent='failed to load';log('AVATAR ERROR: '+e.message);});

  function broadcastWalk(endpoint) {
    adminFetch(endpoint,{method:'POST'})
      .then(r=>{if(r.status===401)log(endpoint+' not broadcast: admin token missing/invalid');})
      .catch(e=>log(endpoint+' broadcast failed: '+e.message));
  }
  $('bEnter').onclick=()=>{ startWalkIn();  broadcastWalk('walk-in');  };
  $('bExit').onclick =()=>{ startWalkOut(); broadcastWalk('walk-out'); };
  $('bCenter').onclick=()=>{ startWalkCenter(); broadcastWalk('walk-center'); };

  setInterval(()=>{
    $('motionState').textContent=rig.ready
      ?`body: ${rig.bodyState}${rig._wave?' + waving':''}${rig.pointingNow?' + pointing':''}${rig.leanAmount>0.05?' + leaning in':''}${pending?' + speaking':''}${walkAnim?' + walking '+walkAnim.dir:''}`:''
  },250);
}

function initPointer() {
  ['pointerdown','touchend','click','keydown'].forEach(ev=>document.addEventListener(ev,unlockPreviewAudio,{passive:true}));
  const track=e=>{
    const x=(e.clientX/innerWidth)*2-1,y=(e.clientY/innerHeight)*2-1;
    if(!rig.ready)return;
    rig.lookAt(x,y); rig.pointAt(x,y);
  };
  ['pointermove','pointerdown'].forEach(ev=>document.addEventListener(ev,track,{passive:true}));
  $('mLegs').onchange=$('mLook').onchange=$('mPoint').onchange=applyPointerToggles;
}

function initGestures() {
  $('btGlasses').onclick  =()=>cueOrchestra('glasses');
  $('btShocked').onclick  =()=>cueOrchestra('surprise');
  $('btThinking').onclick =()=>cueOrchestra('thinking');
  $('btNod').onclick      =()=>cueOrchestra('nod');
  $('btShake').onclick    =()=>cueOrchestra('shake');
  $('btShrug').onclick    =()=>cueOrchestra('shrug');
  $('btPresent').onclick  =()=>cueOrchestra('present');
  $('btCelebrate').onclick=()=>cueOrchestra('celebrate');
  $('btFoot').onclick     =()=>cueOrchestra('footTap');
  $('btShift').onclick    =()=>cueOrchestra('weightShift');
  $('btBounce').onclick   =()=>cueOrchestra('bounce');
  $('btHop').onclick      =()=>cueOrchestra('hop');
  $('btJump').onclick     =()=>cueOrchestra('jump');
  $('btMarch').onclick    =()=>cueOrchestra('march');
  $('btKick').onclick     =()=>cueOrchestra('kick');
  $('btStomp').onclick    =()=>{cueOrchestra('stomp');camPunch(0.5);};
  $('btDance').onclick    =()=>cueOrchestra('dance');
  $('btLean').onclick     =()=>{if(!rig.ready)return log('avatar not ready');rig.leanCue();};
  $('tGesture').onclick   =()=>{if(rig.ready)rig.gesture('test');else log('avatar not ready');};
  $('tWave').onclick      =()=>{if(rig.ready)rig.wave('test');   else log('avatar not ready');};
  $('tStop').onclick      =()=>{if(rig.ready)rig.stopMotion();};
}

function initDock() {
  $('dockLegs').onclick=()=>{showLegs=!showLegs;syncDock();};
  $('frameMode').addEventListener('change',()=>{syncDock();broadcastMotion();});
  $('dockStageMode').onclick=()=>{
    $('stageMode').value=$('stageMode').value==='center'?'camera':'center';
    syncDock(); broadcastMotion();
  };
  $('stageMode').onchange=()=>{syncDock();broadcastMotion();};
  // Sidebar background pickers (Stage layout + Office scene panels): same options as the dock's #bgTheme,
  // and each one just sets #bgTheme and fires its change - so there is exactly one code path for a background switch.
  document.querySelectorAll('.bg-mirror').forEach(m=>{
    m.innerHTML=$('bgTheme').innerHTML; m.value=$('bgTheme').value;
    m.addEventListener('change',()=>{ $('bgTheme').value=m.value; $('bgTheme').dispatchEvent(new Event('change')); });
  });
  $('bgTheme').addEventListener('change',()=>{
    const W=stage.width||1280,H=stage.height||720,t=(performance.now()-stageStart)/1000;
    bgTransition={from:snapshotBackground(W,H,t,prevBgTheme),start:performance.now()};
    prevBgTheme=$('bgTheme').value;
    if ($('bgTheme').value==='hawkins-room') ensureRoomLoaded();
    setScene3DAdmin($('bgTheme').value);   // mirror on the admin's own screen what viewers will see (view.html)
    syncDock();
    adminFetch('background',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:$('bgTheme').value})})
      .then(async r=>{if(r.status===401)log('background not broadcast: admin token missing/invalid');else if(!r.ok)log('background not broadcast ('+r.status+')');})
      .catch(e=>log('background broadcast failed: '+e.message));
  });
  // Chrome (and other browsers) restore a <select>'s chosen option across a
  // plain reload/back-forward-cache navigation WITHOUT firing 'change' - so if
  // "Studio Office (3D)" was already selected before the page reloaded, the
  // listener above never runs and OfficeScene.activate() never gets called.
  // Catch that case explicitly, once, at boot. Deferred with setTimeout(0)
  // because this script (09) runs before js/11-office-scene.js has loaded -
  // by the time this callback fires, every script tag has finished executing.
  setTimeout(() => {
    if ($('bgTheme').value === 'studio-office-3d') setScene3DAdmin('studio-office-3d');
  }, 0);
  // ── walk pad: on-screen buttons + keyboard both drive OfficeScene.setMoveKey ──
  const KEYMAP = { w:'fwd', arrowup:'fwd', s:'back', arrowdown:'back', a:'left', d:'right',
                   q:'turnL', arrowleft:'turnL', e:'turnR', arrowright:'turnR', r:'up', f:'down', shift:'sprint' };
  const walkOn = () => window.OfficeScene && OfficeScene.ready && typeof scene3dAdminActive !== 'undefined' && scene3dAdminActive;
  document.querySelectorAll('#walkPad [data-k]').forEach(b => {
    const k = b.dataset.k;
    const down = e => { e.preventDefault(); if (!walkOn()) return; b.setPointerCapture?.(e.pointerId); b.classList.add('down'); OfficeScene.setMoveKey(k, true); };
    const up   = () => { b.classList.remove('down'); window.OfficeScene && OfficeScene.setMoveKey(k, false); };
    b.addEventListener('pointerdown', down);
    ['pointerup','pointercancel','lostpointercapture'].forEach(ev => b.addEventListener(ev, up));
  });
  $('walkSpeed').addEventListener('input', e => window.OfficeScene && OfficeScene.setMoveSpeed(e.target.value));
  const typing = t => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  document.addEventListener('keydown', e => {
    const k = KEYMAP[e.key.toLowerCase()];
    if (!k || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !walkOn()) return;
    e.preventDefault(); OfficeScene.setMoveKey(k, true);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && window.OfficeScene) OfficeScene.clearMoveKeys(); });
  document.addEventListener('keyup', e => {
    const k = KEYMAP[e.key.toLowerCase()];
    if (k && window.OfficeScene) OfficeScene.setMoveKey(k, false);
  });
  window.addEventListener('blur', () => window.OfficeScene && OfficeScene.clearMoveKeys());
  $('dockScene3DNav').onclick=()=>{
    officeNavMode = officeNavMode === 'fps' ? 'orbit' : 'fps';
    try { localStorage.setItem('officeNav', officeNavMode); } catch {}
    syncDock();
    // No runtime API for this: reload the embed with the new navigation mode.
    if (scene3dAdminActive) {
      const el = $('scene3dFrame'); el.src = '';
      setTimeout(() => OfficeScene.activate(el, () => { window._officeApiReady?.(); }, { navigation: officeNavMode }), 100);
    }
  };
  $('dockScene3DFree').onclick=()=>{
    scene3dFree=!scene3dFree;
    applyScene3DFreeClassAdmin();
    syncDock();
    adminFetch('scene3d-free',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({free:scene3dFree})})
      .then(async r=>{if(r.status===401)log('free-roam not broadcast: admin token missing/invalid');else if(!r.ok)log('free-roam not broadcast ('+r.status+')');})
      .catch(e=>log('free-roam broadcast failed: '+e.message));
  };
  $('asize').addEventListener('change',broadcastMotion);
  $('dockMinimize').onclick=()=>{avatarMinimized=!avatarMinimized;syncDock();};

  // ── Scene zoom: dock buttons (＋ / label / －) ───────────────────
  // Single click: step by SCENE_ZOOM_STEP.
  // Hold: continuous stepping every 120 ms.
  $('dockZoomIn').addEventListener('pointerdown', () => startZoomHold(+SCENE_ZOOM_STEP));
  $('dockZoomIn').addEventListener('pointerup',   stopZoomHold);
  $('dockZoomIn').addEventListener('pointerleave',stopZoomHold);

  $('dockZoomOut').addEventListener('pointerdown', () => startZoomHold(-SCENE_ZOOM_STEP));
  $('dockZoomOut').addEventListener('pointerup',   stopZoomHold);
  $('dockZoomOut').addEventListener('pointerleave',stopZoomHold);

  $('dockZoomReset').addEventListener('click', () => setSceneZoom(1.0));

  // ── Scene zoom: sidebar slider ───────────────────────────────────
  $('sceneZoomSlider').addEventListener('input', e => {
    setSceneZoom(Number(e.target.value) / 100);
  });

  syncDock();
}

function initQuickBar() {
  const post=o=>adminFetch('script',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}).catch(()=>{});
  $('qTalk').onclick=()=>{
    $('loopToggle').checked=!$('loopToggle').checked;
    $('loopToggle').onchange();
    if(!$('loopToggle').checked){try{onInterrupt();}catch(e){}}
    syncQ();
  };
  $('qStop').onclick=()=>{
    talkStopped=!talkStopped;
    if(talkStopped){try{onInterrupt();}catch(e){}if($('loopToggle').checked){$('loopToggle').checked=false;$('loopToggle').onchange();}}
    adminFetch('speech/'+(talkStopped?'pause':'resume'),{method:'POST'})
      .then(r=>{if(r.status===401)log('speech stop not broadcast: admin token missing/invalid');})
      .catch(e=>log('speech stop broadcast failed: '+e.message));
    syncQ();
  };
  $('qReplies').onchange=()=>{post({replies:$('qReplies').value});$('repliesModeSel').value=$('qReplies').value;};
  $('qMute').onclick=()=>{voiceMuted=!voiceMuted;[speaker,previewSpeaker].forEach(s=>s&&s.setMuted(voiceMuted));syncQ();};
  $('qMic').onclick=()=>{const t=camStream&&camStream.getAudioTracks()[0];if(t)t.enabled=!t.enabled;syncQ();};
  $('qIn').onclick=()=>{if(rig.ready)rig.leanCue();camPunch(1);};
  $('qOut').onclick=()=>{if(rig.ready)rig.stopLean();CINE.punch=0;};
  setInterval(syncQ,600); syncQ();
}

function initScript() {
  const postScript=o=>adminFetch('script',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}).catch(()=>{});
  (async()=>{
    try{
      const r=await fetch('script');
      if(r.ok){
        const j=await r.json();
        currentScriptLines=j.lines||[];
        $('scriptText').value=currentScriptLines.join('\n');
        $('personaText').value=j.persona||'';
        $('loopToggle').checked=j.loop!==false;
        if(typeof j.scriptProtect==='boolean')$('scriptProtectToggle').checked=j.scriptProtect;
        if(typeof j.voiceScript==='boolean')$('scriptVoiceToggle').checked=j.voiceScript;
        if(typeof j.voiceReplies==='boolean')$('repliesVoiceToggle').checked=j.voiceReplies;
        if(j.replies)$('repliesModeSel').value=j.replies;
      }
    }catch(e){log('script fetch failed: '+e.message);}
  })();
  function diffLines(o,n){
    const out=[],max=Math.max(o.length,n.length);
    for(let i=0;i<max;i++){
      if(o[i]===n[i])out.push('  '+(n[i]??o[i]));
      else if(o[i]===undefined)out.push('+ '+n[i]);
      else if(n[i]===undefined)out.push('- '+o[i]);
      else out.push('- '+o[i]+'\n+ '+n[i]);
    }
    return out.join('\n');
  }
  $('scriptSave').onclick=()=>{
    const lines=$('scriptText').value.split('\n').map(s=>s.trim()).filter(Boolean);
    if(!lines.length){$('scriptNote').textContent='Add at least one line first.';return;}
    $('scriptDiff').textContent=diffLines(currentScriptLines,lines)||'(no change)';
    $('scriptConfirm').hidden=false; $('scriptNote').textContent='';
  };
  $('scriptCancel').onclick=()=>{$('scriptConfirm').hidden=true;};
  $('scriptApply').onclick=async()=>{
    const lines=$('scriptText').value.split('\n').map(s=>s.trim()).filter(Boolean);
    try{
      const r=await adminFetch('script',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lines,persona:$('personaText').value,loop:$('loopToggle').checked})});
      if(r.ok){currentScriptLines=lines;$('scriptNote').textContent='Applied. The avatar will use it from the next idle line onward.';}
      else $('scriptNote').textContent='Save failed (HTTP '+r.status+')';
    }catch(e){$('scriptNote').textContent='Save failed: '+e.message;}
    $('scriptConfirm').hidden=true;
  };
  $('loopToggle').onchange=()=>adminFetch('script',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loop:$('loopToggle').checked})}).catch(()=>{});
  $('scriptVoiceToggle').onchange =()=>postScript({voiceScript:$('scriptVoiceToggle').checked});
  $('scriptProtectToggle').onchange=()=>postScript({scriptProtect:$('scriptProtectToggle').checked});
  $('repliesVoiceToggle').onchange =()=>postScript({voiceReplies:$('repliesVoiceToggle').checked});
  $('repliesModeSel').onchange     =()=>{postScript({replies:$('repliesModeSel').value});$('qReplies').value=$('repliesModeSel').value;};
}

function initVoice() {
  (async()=>{
    try{
      const r=await fetch('voices');
      if(r.ok){const j=await r.json();onVoiceInfo(j.current);if(j.dialect&&window.AvatarInternals)AvatarInternals.setDialect(j.dialect);}
    }catch(e){log('voices fetch failed: '+e.message);}
  })();
  async function pushVoice(){
    try{await adminFetch('voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({en:$('voiceEn').value,ar:$('voiceAr').value})});}
    catch(e){log('voice save failed: '+e.message);}
  }
  $('voiceEn').onchange=$('voiceAr').onchange=pushVoice;
}

function initTuners() {
  // Wave
  (()=>{
    const W=AvatarInternals.WAVE;
    const SPEC=[['pose.upper','Upper arm angle',-215,-120,1,'°'],['pose.fore','Forearm angle',-150,-60,1,'°'],['pose.hand','Hand angle',-160,-60,1,'°'],['swing.fore','Forearm swing',0,40,1,'°'],['swing.hand','Wrist flick',0,40,1,'°'],['swing.upper','Upper-arm sway',0,10,0.5,'°'],['freq','Swing speed',0.8,4,0.1,'Hz'],['lag','Wrist lag',0,0.2,0.01,'s'],['raise','Raise time',0.3,1.5,0.05,'s'],['hold','Wave duration',0.5,6,0.1,'s'],['lower','Lower time',0.3,1.5,0.05,'s'],['stagger.fore','Elbow delay',0,0.4,0.01,''],['stagger.hand','Wrist delay',0,0.5,0.01,'']];
    const t=buildTuner({target:W,defaults:AvatarInternals.DEFAULT_WAVE,spec:SPEC,rows:$('tuneRows'),key:'waveTuning.v5'});
    $('tPlay').onclick=()=>{if(!rig.ready)return log('avatar not ready');if(rig._wave)rig.stopMotion();setTimeout(()=>rig.wave('test'),rig._wave?450:0);};
    $('tReset').onclick=()=>{t.reset();t.refresh();}; $('tCopy').onclick=()=>copyOut(t.text('WAVE'),'tuneNote','WAVE');
  })();
  // Pointing
  (()=>{
    const P=AvatarInternals.POINT;
    const SPEC=[['range.min','Lowest arm angle',20,140,1,'°'],['range.max','Highest arm angle',200,320,1,'°'],['elbow','Elbow bend',0,45,1,'°'],['wrist','Wrist angle',-30,30,1,'°'],['pivot.x','Shoulder across the page',-1,1,0.02,''],['pivot.y','Shoulder up the page',-1,1,0.02,''],['follow','Follow smoothing',0.02,0.6,0.01,'s'],['raise','Raise time',0.15,1.5,0.05,'s'],['drop','Lower time',0.15,1.5,0.05,'s'],['idle','Lower after no movement',1,60,1,'s']];
    const t=buildTuner({target:P,defaults:AvatarInternals.DEFAULT_POINT,spec:SPEC,rows:$('pointRows'),key:'pointTuning.v6'});
    $('pReset').onclick=()=>{t.reset();t.refresh();}; $('pCopy').onclick=()=>copyOut(t.text('POINT'),'pointNote','POINT');
  })();
  // Voice
  (()=>{
    const V=AvatarInternals.VOICE;
    const SPEC=[['gain','Volume',0.5,4,0.1,'×'],['warmth','Warmth',-6,12,0.5,'dB'],['presence','Clarity',-6,10,0.5,'dB'],['edge','Take off the rasp',-12,6,0.5,'dB']];
    const retune=()=>{if(speaker)speaker.tune();if(previewSpeaker)previewSpeaker.tune();};
    const t=buildTuner({target:V,defaults:AvatarInternals.DEFAULT_VOICE,spec:SPEC,rows:$('voiceRows'),key:'voiceTuning.v6',onChange:retune});
    const flags=()=>{V.filter=$('vFilter').checked;V.compress=$('vComp').checked;t.save();retune();};
    $('vFilter').checked=V.filter!==false; $('vComp').checked=V.compress!==false;
    $('vFilter').onchange=$('vComp').onchange=flags;
    $('vReset').onclick=()=>{t.reset();t.refresh();$('vFilter').checked=AvatarInternals.DEFAULT_VOICE.filter!==false;$('vComp').checked=AvatarInternals.DEFAULT_VOICE.compress!==false;V.filter=$('vFilter').checked;V.compress=$('vComp').checked;t.save();retune();};
    $('vTest').onclick=()=>{if(!lastReply)return log('send a comment first, then "Test voice" replays that reply with the current settings');getSpeaker().say(lastReply.bytes,lastReply.text,{words:lastReply.words}).catch(e=>log('voice test failed: '+e.message));};
  })();
}

function initChat() {
  const chat=new Chat({
    log:$('chatlog'),name:$('chatname'),msg:$('chatmsg'),send:$('chatsend'),status:$('chatState'),
    onReply,
    onComment:()=>{if(rig.ready&&$('mComment').checked)rig.wave('comment');},
    onMode:onModeInfo,
    onInterrupt,
    onVoice:onVoiceInfo,
    onPending:renderPending,
    onProduct: null,   // patched by 10-product.js after both modules load
  });
  chat.init();
  window._chat = chat;  // expose for 10-product.js to wire onProduct
}

function initPending() {
  (async()=>{
    try{const r=await fetch('pending');if(r.ok)renderPending((await r.json()).items||[]);}
    catch(e){log('pending fetch failed: '+e.message);}
  })();
  setInterval(pollState,4000); pollState();
}

function initCamera() {
  if(!window.isSecureContext||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setStatus('Camera blocked: open this page with https://','bad'); $('go').disabled=$('flip').disabled=true; return;
  }
  $('go').onclick=async()=>{
    if(wantLive)return stopLive();
    wantLive=true;setLiveUI(true);setStatus('Starting camera…');
    try{await startCapture();setStatus('Connecting…');await publish();await acquireWakeLock();}
    catch(e){log('ERROR: '+e.message);setStatus(e.name==='NotAllowedError'?'Camera permission denied':e.message,'bad');await stopLive(true);}
  };
  $('flip').onclick=async()=>{
    facing=facing==='user'?'environment':'user'; log('camera: '+(facing==='user'?'front':'back'));
    if(!camStream)return;
    try{
      camStream.getVideoTracks().forEach(t=>{t.stop();camStream.removeTrack(t);});
      const vs=await navigator.mediaDevices.getUserMedia({video:videoConstraints()});
      const nt=vs.getVideoTracks()[0];
      camStream.addTrack(nt);
      cam.srcObject=new MediaStream([nt]);
      await cam.play();
    }catch(e){log('flip failed: '+e.message);}
  };
  document.addEventListener('visibilitychange',()=>{
    if(!wantLive)return;
    if(document.visibilityState==='hidden'){log('page hidden – the browser may pause the camera');return;}
    acquireWakeLock();
    if(camStream&&camStream.getTracks().some(t=>t.readyState==='ended')){log('camera was stopped by the browser');onDropped();}
  });
}

// =====================================================================
//  OFFICE SCENE — build + wire the admin control panel once the
//  Sketchfab Viewer API is ready (called from setScene3DAdmin in
//  03-background.js via window._officeApiReady).
// =====================================================================
function initOfficeScene() {

  // ── show/hide the panel whenever the bg theme changes ────────────
  function syncOfficePanel() {
    const active = $('bgTheme').value === 'studio-office-3d';
    const sec = $('officeSection');
    if (sec) sec.style.display = active ? '' : 'none';
    const bgRow = $('officeBgRow'); if (bgRow) bgRow.style.display = active ? '' : 'none';
  }
  $('bgTheme').addEventListener('change', syncOfficePanel);
  syncOfficePanel();

  // ── tabs ──────────────────────────────────────────────────────────
  const tabs = document.querySelectorAll('#officeSection .otab');
  function showTab(name) {
    tabs.forEach(t => { const on = t.dataset.otab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    document.querySelectorAll('#officeSection .office-pane').forEach(p => p.classList.toggle('active', p.dataset.opane === name));
    try { localStorage.setItem('officeTab', name); } catch {}
  }
  tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.otab)));
  try { const saved = localStorage.getItem('officeTab'); if (saved && document.querySelector(`#officeSection .otab[data-otab="${saved}"]:not([hidden])`)) showTab(saved); } catch {}

  // ── live-sync indicator: every broadcast shows sending → synced (with time) or an error ──
  const sync = $('officeSync');
  function setSync(state, text) { if (sync) { sync.dataset.state = state; } if (text) $('officeApiState').textContent = text; }
  let syncBase = 'API: waiting for scene…', sentTimer = null;
  function broadcastOfficeInput(kind, name, value, extra) {
    setSync('sending');
    return adminFetch('office-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ kind, name, value }, extra || {})),
    }).then(r => {
      if (r.status === 401) { setSync('error'); log('office-input not broadcast: admin token missing/invalid'); $('officeSent').textContent = '⚠ admin token missing'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setSync('ready');
      const label = kind === 'visibility' ? 'visibility' : kind === 'wandcfg' ? 'wand settings' : kind === 'camera' ? 'camera' : kind === 'color' ? 'colour' : 'animation';
      $('officeSent').textContent = `✓ ${label} synced ${new Date().toLocaleTimeString()}`;
      clearTimeout(sentTimer); sentTimer = setTimeout(() => { $('officeSent').textContent = ''; }, 6000);
    }).catch(e => { setSync('error'); log('office-input broadcast failed: ' + e.message); $('officeSent').textContent = '⚠ not synced'; });
  }

  // "Desk_leg_01" -> "desk leg": what the avatar says when it vanishes
  function humanObjectName(nm) {
    return String(nm || '').replace(/[_.\-]+/g, ' ').replace(/\b\d+\b/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
  }
  window.humanObjectName = humanObjectName;   // used by 15-game.js

  // ── wand + narration controls (Objects tab). Saved in this browser; pushed to the server (-> every viewer + late joiners).
  const WAND_KEY = 'wandcfg.v1';
  const wandCfg = { wand: true, narrate: true, delayMs: 250, autopilot: true, trick: 'hide', camPull: 0.72 };
  try { Object.assign(wandCfg, JSON.parse(localStorage.getItem(WAND_KEY) || '{}')); } catch {}
  function applyWandCfgLocal() {
    if (window.WandCast) { window.WandCast.cfg.on = !!wandCfg.wand; window.WandCast.cfg.trick = wandCfg.trick || 'hide'; }
    if (window.Autopilot) { window.Autopilot.cfg.on = !!wandCfg.autopilot; window.Autopilot.cfg.pull = Number(wandCfg.camPull) || 0.72; window.Autopilot.role = 'admin'; window.Autopilot.broadcast = shot => broadcastOfficeInput('shot', 'autopilot', shot); }   // 14-autopilot.js loads after this file
  }
  function pushWandCfg() {
    applyWandCfgLocal();
    try { localStorage.setItem(WAND_KEY, JSON.stringify(wandCfg)); } catch {}
    return broadcastOfficeInput('wandcfg', 'cfg', wandCfg);
  }
  (function wireWandControls() {
    const on = $('wandOn'), nar = $('wandNarrate'), dl = $('wandDelay'), test = $('wandTest'), cam = $('autoCam');
    if (!on) return;
    on.checked = !!wandCfg.wand; nar.checked = !!wandCfg.narrate; dl.value = wandCfg.delayMs; if (cam) cam.checked = wandCfg.autopilot !== false;
    if (cam) cam.addEventListener('change', () => { wandCfg.autopilot = cam.checked; pushWandCfg(); });
    const trk = $('wandTrick'), pull = $('camPull');
    if (trk) { trk.value = wandCfg.trick || 'hide'; trk.addEventListener('change', () => { wandCfg.trick = trk.value; pushWandCfg(); }); }
    if (pull) { pull.value = String(wandCfg.camPull); if (pull.value !== String(wandCfg.camPull)) pull.value = '0.72'; pull.addEventListener('change', () => { wandCfg.camPull = Number(pull.value); pushWandCfg(); }); }
    applyWandCfgLocal(); window.addEventListener('load', applyWandCfgLocal);   // 13-wand.js may load after this file
    on.addEventListener('change', () => { wandCfg.wand = on.checked; pushWandCfg(); });
    nar.addEventListener('change', () => { wandCfg.narrate = nar.checked; pushWandCfg(); });
    dl.addEventListener('change', () => { wandCfg.delayMs = Math.max(0, Math.min(3000, Number(dl.value) || 0)); dl.value = wandCfg.delayMs; pushWandCfg(); });
    test.addEventListener('click', () => {
      if (!window.WandCast) return log('wand script not loaded');
      if (!window.WandCast.available()) return log('wand unavailable: avatar arm not ready (old avatar.riv?), a wave is playing, or the wand is switched off');
      window.WandCast.test();
    });
  })();

  // ── called by 03-background.js once Viewer API is ready ──────────
  window._officeApiReady = function buildOfficePanel() {
    syncBase = `Live · ${Object.keys(OfficeScene.nodes).length} objects · ${OfficeScene.materials.length} materials`
      + (OfficeScene.animations.length ? ` · ${OfficeScene.animations.length} anim` : '');
    setSync('ready', syncBase);
    buildOfficeNodeGrid();
    buildOfficeCameraPresets();
    buildOfficeMaterialGrid();
    buildOfficeAnimGrid();
    // A viewer that joins later is caught up from the server's snapshot; re-push the admin's current
    // hidden/shown state once so a freshly reloaded publisher and every viewer agree.
    $('oCountObjects').textContent = Object.keys(OfficeScene.nodes).length;
    $('oCountColors').textContent = OfficeScene.materials.length;
    pushWandCfg();   // make the server (and so viewers / late joiners) agree with this panel's wand + narration switches
  };

  // ── objects: grouped chips ───────────────────────────────────────
  function buildOfficeNodeGrid() {
    const grid = $('officeNodeGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const nodes = Object.entries(OfficeScene.nodes)
      .map(([id, n]) => ({ id: Number(id), ...n }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!nodes.length) { grid.innerHTML = '<p class="office-empty">No named nodes found in this model.</p>'; return; }

    // Group by first segment of the name (e.g. "Desk_leg_01" → "Desk")
    const groups = {};
    for (const n of nodes) (groups[n.name.split(/[_\s.]/)[0] || n.name] = groups[n.name.split(/[_\s.]/)[0] || n.name] || []).push(n);

    for (const [groupName, items] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
      const det = document.createElement('details'); det.className = 'ogroup';
      const sum = document.createElement('summary');
      const nm = document.createElement('span'); nm.className = 'ogroup-name'; nm.textContent = groupName;
      const cnt = document.createElement('span'); cnt.className = 'ogroup-count';
      const bAll = document.createElement('button'); bAll.type = 'button'; bAll.className = 'ogroup-btn ghost'; bAll.textContent = 'show all';
      const bNone = document.createElement('button'); bNone.type = 'button'; bNone.className = 'ogroup-btn ghost'; bNone.textContent = 'hide all';
      sum.append(nm, cnt, bAll, bNone);
      const chips = document.createElement('div'); chips.className = 'ogroup-chips';
      det.append(sum, chips);
      grid.appendChild(det);

      const btns = [];
      const refreshCount = () => { const on = btns.filter(b => b.classList.contains('active')).length; cnt.textContent = `${on}/${btns.length}`; };

      for (const n of items) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'ochip';
        btn.dataset.instanceId = n.id;
        btn.title = `${n.name}\nID ${n.id} | ${n.type}`;
        btn.textContent = n.name.length > 24 ? n.name.slice(0, 22) + '…' : n.name;
        btn.classList.toggle('active', OfficeScene.visMap[n.id] !== false);
        btn.addEventListener('click', () => {
          if (!OfficeScene.ready) return log('OfficeScene API not ready');
          const visible = OfficeScene.toggle(n.id);            // applies locally right away
          btn.classList.toggle('active', visible);
          btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
          refreshCount();
          broadcastOfficeInput('visibility', String(n.id), visible, { label: humanObjectName(n.name) });   // …and to every viewer (the label lets the avatar name what vanished)
        });
        btns.push(btn); chips.appendChild(btn);
      }
      refreshCount();

      // per-group show / hide all (staggered so the server + viewers are never flooded)
      const setAll = (want) => (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (!OfficeScene.ready) return;
        btns.filter(b => b.classList.contains('active') !== want && b.style.display !== 'none').forEach((b, i) => {
          setTimeout(() => b.click(), i * 70);   // staggered: also makes 'hide all' a cascade of poofs
        });
      };
      bAll.addEventListener('click', setAll(true));
      bNone.addEventListener('click', setAll(false));
    }

    // ── live filter: opens matching groups, hides the rest ──────────
    const search = $('officeNodeSearch');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        $('officeNodeGrid').querySelectorAll('details.ogroup').forEach(det => {
          let any = false;
          det.querySelectorAll('button.ochip').forEach(b => {
            const m = !q || b.textContent.toLowerCase().includes(q) || b.title.toLowerCase().includes(q);
            b.style.display = m ? '' : 'none'; if (m) any = true;
          });
          det.style.display = any ? '' : 'none';
          if (q && any) det.open = true;
        });
      });
    }
  }

  // ── camera presets ───────────────────────────────────────────────
  function buildOfficeCameraPresets() {
    const container = $('officeCameraPresets');
    if (!container) return;
    container.innerHTML = '';
    const entries = Object.entries(OfficeScene.presets);
    $('oCountCameras').textContent = entries.length || '';

    for (const [name, preset] of entries) {
      const wrap = document.createElement('div'); wrap.className = 'opreset';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'go';
      btn.textContent = '📷 ' + name;
      btn.addEventListener('click', () => {
        if (!OfficeScene.ready) return;
        OfficeScene.gotoPreset(name);
        broadcastOfficeInput('camera', name, { eye: preset.eye, target: preset.target });
        log(`office camera → preset "${name}"`);
      });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'del ghost'; del.textContent = '✕'; del.title = 'Delete this preset';
      del.addEventListener('click', () => { OfficeScene.deletePreset(name); buildOfficeCameraPresets(); });
      wrap.append(btn, del);
      container.appendChild(wrap);
    }
    if (!entries.length) container.innerHTML = '<p class="office-empty">No views saved yet. Move the camera where you want it, then save.</p>';

    const saveBtn = $('officeSavePreset');
    if (saveBtn) {
      saveBtn.onclick = () => {
        const name = ($('officePresetName').value || '').trim();
        if (!name) { $('officePresetNote').textContent = 'Enter a name first.'; return; }
        if (!OfficeScene.ready) { $('officePresetNote').textContent = 'API not ready yet.'; return; }
        OfficeScene.saveCurrentCamera(name, (preset) => {
          $('officePresetNote').textContent = `"${name}" saved.`;
          $('officePresetName').value = '';
          buildOfficeCameraPresets();
          broadcastOfficeInput('camera', name, { eye: preset.eye, target: preset.target });
        });
      };
    }
  }

  // ── material colours ─────────────────────────────────────────────
  function buildOfficeMaterialGrid() {
    const grid = $('officeMaterialGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const mats = OfficeScene.materials;
    if (!mats.length) { grid.innerHTML = '<p class="office-empty">No materials found.</p>'; return; }
    const toHex = v => ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2);

    for (const mat of [...mats].sort((a, b) => a.name.localeCompare(b.name))) {
      const ch = mat.channels || {};
      const src = (ch.AlbedoPBR?.color || ch.DiffusePBR?.color || ch.Diffuse?.color || [0.5, 0.5, 0.5]);
      const hex = '#' + toHex(src[0]) + toHex(src[1]) + toHex(src[2]);
      const row = document.createElement('div'); row.className = 'omat'; row.dataset.name = mat.name.toLowerCase();
      const label = document.createElement('span'); label.textContent = mat.name; label.title = mat.name;
      const code = document.createElement('code'); code.textContent = hex;
      const picker = document.createElement('input');
      picker.type = 'color'; picker.value = hex; picker.title = `Colour for "${mat.name}"`;
      let debounce;
      picker.addEventListener('input', () => {
        code.textContent = picker.value;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          const h = picker.value;
          const rgb = [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
          OfficeScene.setMaterialColor(mat.name, rgb);
          broadcastOfficeInput('color', mat.name, rgb);
        }, 80);
      });
      row.append(label, code, picker);
      grid.appendChild(row);
    }
    const ms = $('officeMatSearch');
    if (ms && !ms.dataset.bound) {
      ms.dataset.bound = '1';
      ms.addEventListener('input', () => {
        const q = ms.value.trim().toLowerCase();
        grid.querySelectorAll('.omat').forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; });
      });
    }
  }

  // ── animations ───────────────────────────────────────────────────
  function buildOfficeAnimGrid() {
    const grid = $('officeAnimGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const anims = OfficeScene.animations;
    $('officeAnimTab').hidden = !anims.length;
    for (const [uid, name, duration] of anims) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ochip active';
      btn.textContent = name || uid;
      btn.title = `Duration: ${duration?.toFixed(2)}s`;
      btn.addEventListener('click', () => {
        OfficeScene.seekAnim(0); OfficeScene.playAnim();
        broadcastOfficeInput('anim', uid, { action: 'play' });
        log(`office anim play: "${name}"`);
      });
      grid.appendChild(btn);
    }
    $('officeAnimPlay').onclick  = () => { OfficeScene.playAnim();  broadcastOfficeInput('anim', 'all', { action: 'play'  }); };
    $('officeAnimPause').onclick = () => { OfficeScene.pauseAnim(); broadcastOfficeInput('anim', 'all', { action: 'pause' }); };
  }
}

// =====================================================================
//  BOOT — call every init in dependency order
// =====================================================================
Theme.init('themeBtn');
startDrawing();       // preview runs immediately, before camera

initAdmin();
initAvatar();         // loads rig; auto walk-in if checkbox checked
initPointer();
initGestures();
initRoom();           // wires Hawkins room sidebar controls (02-room.js)
initDock();           // stage layout dock + background switcher + zoom
initQuickBar();       // qbar buttons
initScript();         // script editor + moderation toggles
initVoice();          // voice picker + server sync
initTuners();         // wave / pointing / voice sliders
initChat();           // chat widget + SSE
initPending();        // pending approvals + state poll
initCamera();         // camera capture + WHIP streaming
initOfficeScene();    // Sketchfab Viewer API panel (studio-office-3d)

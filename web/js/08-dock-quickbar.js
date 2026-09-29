// =====================================================================
//  08-dock-quickbar.js — floating dock sync, scene-zoom controls,
//  motion broadcast, quick-bar sync, and server-state polling.
// =====================================================================

// ── syncDock: refreshes every dock button label/state ────────────────
function syncDock() {
  $('dockStageMode').textContent=$('stageMode').value==='center'?'🎬 Center stage':'📷 Camera corner';
  $('dockStageMode').classList.toggle('active',$('stageMode').value==='center');
  $('dockMinimize').textContent=avatarMinimized?'⤢ Restore':'⤡ Minimize';
  $('dockMinimize').classList.toggle('active',avatarMinimized);
  $('bgTheme').style.display=$('frameMode').style.display=$('stageMode').value==='center'?'':'none';
  $('dockLegs').textContent=showLegs?'🦵 Legs: on':'🦵 Legs: off';
  $('dockLegs').classList.toggle('active',showLegs);
  $('dockLegs').style.display=($('stageMode').value==='center'&&$('frameMode').value==='full')?'':'none';
  const on3D = $('bgTheme').value === 'studio-office-3d';
  $('dockScene3DNav').hidden = !on3D;
  $('walkPad').hidden = !on3D;
  if (!on3D && window.OfficeScene) OfficeScene.clearMoveKeys();
  $('dockScene3DNav').textContent = officeNavMode === 'fps' ? '🚶 Walk mode' : '🔄 Orbit mode';
  $('dockScene3DFree').hidden = !on3D;
  $('dockScene3DFree').textContent = scene3dFree ? '🔓 Free-roam: on' : '🔒 Free-roam: off';
  $('dockScene3DFree').classList.toggle('active', scene3dFree);
  document.querySelectorAll('.bg-mirror').forEach(m=>{ if(m.value!==$('bgTheme').value) m.value=$('bgTheme').value; });
  syncZoomUI();
}

// ── Scene zoom helpers ────────────────────────────────────────────────
// setSceneZoom() is the single source of truth: it clamps, commits, and
// syncs every UI element (dock label, sidebar slider, sidebar label).
// The actual visual change happens in drawFrame() via sceneZoomCurrent.
function setSceneZoom(v) {
  sceneZoomTarget = Math.max(SCENE_ZOOM_MIN, Math.min(SCENE_ZOOM_MAX, v));
  syncZoomUI();
  // Broadcast to viewers so the live view.html also zooms in sync.
  broadcastZoom(sceneZoomTarget);
}
function syncZoomUI() {
  const pct = Math.round(sceneZoomTarget * 100);
  const label = pct + '%';
  if ($('dockZoomReset'))  $('dockZoomReset').textContent = label;
  if ($('sceneZoomSlider')) $('sceneZoomSlider').value = pct;
  if ($('sceneZoomLabel'))  $('sceneZoomLabel').textContent = label;
}
function broadcastZoom(zoom) {
  adminFetch('zoom', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({zoom}),
  }).then(r => {
    // 404 = server doesn't have a /zoom endpoint yet — silent, not an error.
    if (r.status === 401) log('zoom not broadcast: admin token missing/invalid');
  }).catch(() => {}); // network error → silent
}

// Hold-to-zoom: track which button is being held and repeat the step.
let _zoomHoldTimer = null;
function startZoomHold(delta) {
  setSceneZoom(sceneZoomTarget + delta);
  _zoomHoldTimer = setInterval(() => setSceneZoom(sceneZoomTarget + delta), 120);
}
function stopZoomHold() {
  clearInterval(_zoomHoldTimer);
  _zoomHoldTimer = null;
}

// ── Motion broadcast ──────────────────────────────────────────────────
let motionDebounce=null;
function broadcastMotion() {
  clearTimeout(motionDebounce);
  motionDebounce=setTimeout(()=>{
    adminFetch('motion',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({frameMode:$('frameMode').value,stageMode:$('stageMode').value,size:Number($('asize').value)})})
      .then(r=>{if(r.status===401)log('motion not broadcast: admin token missing/invalid');})
      .catch(e=>log('motion broadcast failed: '+e.message));
  },150);
}

// ── Quick-bar sync ────────────────────────────────────────────────────
function syncQ() {
  const on=$('loopToggle').checked;
  $('qTalk').textContent=on?'🗣 Talk: ON':'😶 Idle (no talking)'; $('qTalk').classList.toggle('on',on);
  $('qStop').textContent=talkStopped?'🚫 Talking stopped':'🗯 Stop talking'; $('qStop').classList.toggle('off',talkStopped);
  $('qMute').textContent=voiceMuted?'🔇 Voice muted':'🔊 Voice'; $('qMute').classList.toggle('off',voiceMuted);
  const mic=camStream&&camStream.getAudioTracks()[0]; const micOff=!!(mic&&!mic.enabled);
  $('qMic').textContent=micOff?'🎙 Mic muted':'🎙 Mic'; $('qMic').classList.toggle('off',micOff);
}

// ── Server state poll ────────────────────────────────────────────────
async function pollState() {
  try{
    const r=await adminFetch('state');
    if(r.status===401){$('queueState').textContent='Queue/status hidden: set the admin token above to see it.';return;}
    if(!r.ok)return;
    const s=await r.json();
    $('queueState').textContent=`Queue: ${s.queueLength} waiting (${s.queuedBaseline} script) · ${s.speaking?'speaking now':s.busy?'busy':'idle'} · ${s.connectedViewers} viewer(s) connected · speech ${s.speechPaused?'PAUSED':'live'} · background: ${s.background}`;
  }catch(e){}
}

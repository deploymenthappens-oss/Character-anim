// =====================================================================
//  07-camera-whip.js — camera capture + WebRTC WHIP publishing.
// =====================================================================
function videoConstraints() {
  const q=QUALITY[$('quality').value];
  return {facingMode:{ideal:facing},width:{ideal:q.w},height:{ideal:q.h},frameRate:{ideal:30,max:30}};
}
async function startCapture() {
  stopCapture();
  camStream=await navigator.mediaDevices.getUserMedia({video:videoConstraints(), audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  const vt=camStream.getVideoTracks()[0], s=vt.getSettings();
  log(`camera: ${s.width}x${s.height} @ ${Math.round(s.frameRate||0)}fps (${vt.label})`);
  cam.srcObject=new MediaStream([vt]); await cam.play();
  await new Promise(r=>{if(cam.videoWidth)r();else cam.addEventListener('loadedmetadata',r,{once:true});});
  stage.width=cam.videoWidth; stage.height=cam.videoHeight; drawFrame(); startDrawing();
  const AC=window.AudioContext||window.webkitAudioContext; audioCtx=new AC(); await audioCtx.resume();
  const dest=audioCtx.createMediaStreamDestination();
  audioCtx.createMediaStreamSource(new MediaStream(camStream.getAudioTracks())).connect(dest);
  speaker=new Speaker({rig,ctx:audioCtx,destination:dest,monitor:()=>$('monitor').checked,motion});
  outStream=new MediaStream([stage.captureStream(30).getVideoTracks()[0],dest.stream.getAudioTracks()[0]]);
}
function stopCapture() {
  if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;}
  if(outStream){outStream.getTracks().forEach(t=>t.stop());outStream=null;}
  if(audioCtx){audioCtx.close().catch(()=>{});audioCtx=null;}
  speaker=null; rig.setViseme(0); rig.stopMotion(); cam.srcObject=null;
}

function waitIce(p,ms=3000) {
  return new Promise(resolve=>{
    if(p.iceGatheringState==='complete')return resolve();
    const done=()=>{p.removeEventListener('icegatheringstatechange',check);clearTimeout(timer);resolve();};
    const check=()=>{if(p.iceGatheringState==='complete')done();};
    const timer=setTimeout(done,ms); p.addEventListener('icegatheringstatechange',check);
  });
}
function preferH264(tr) {
  try{const caps=RTCRtpSender.getCapabilities('video');if(!caps||!tr.setCodecPreferences)return;const h264=caps.codecs.filter(c=>c.mimeType==='video/H264');if(!h264.length)return;tr.setCodecPreferences([...h264,...caps.codecs.filter(c=>c.mimeType!=='video/H264')]);}catch(e){log('codec preference skipped: '+e.message);}
}
async function publish() {
  const endpoint=`${location.origin}/${cleanName()}/whip`, q=QUALITY[$('quality').value];
  const myPc=new RTCPeerConnection({iceServers:ICE_SERVERS,bundlePolicy:'max-bundle'}); pc=myPc;
  for (const track of outStream.getTracks()) { const tr=myPc.addTransceiver(track,{direction:'sendonly',streams:[outStream]}); if(track.kind==='video')preferH264(tr); }
  myPc.onconnectionstatechange=()=>{
    if(pc!==myPc)return; const s=myPc.connectionState; log('connection: '+s);
    if(s==='connected'){setStatus('● LIVE','live');startStats();} else if(s==='disconnected')setStatus('Connection unstable…','warn'); else if(s==='failed'||s==='closed')onDropped();
  };
  await myPc.setLocalDescription(await myPc.createOffer()); await waitIce(myPc);
  log('POST '+endpoint);
  const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/sdp'},body:myPc.localDescription.sdp});
  if(res.status!==201)throw new Error(`WHIP failed: HTTP ${res.status} ${(await res.text()).slice(0,200)}`);
  const loc=res.headers.get('Location'); sessionUrl=loc?new URL(loc,endpoint).href:null;
  await myPc.setRemoteDescription({type:'answer',sdp:await res.text()});
  try{const snd=myPc.getSenders().find(s=>s.track&&s.track.kind==='video');const p=snd.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=q.kbps*1000;await snd.setParameters(p);}catch(e){log('bitrate cap skipped: '+e.message);}
}
async function teardownPc() {
  stopStats(); const p=pc; pc=null;
  if(sessionUrl){try{await fetch(sessionUrl,{method:'DELETE'});}catch{}sessionUrl=null;}
  if(p){p.onconnectionstatechange=null;p.close();}
}
async function onDropped() {
  if(!wantLive)return; setStatus('Connection lost – retrying…','warn'); log('dropped; retrying in 2s');
  await teardownPc();
  setTimeout(async()=>{if(!wantLive)return;try{const dead=!camStream||camStream.getTracks().some(t=>t.readyState==='ended');if(dead)await startCapture();await publish();}catch(e){log('retry failed: '+e.message);onDropped();}},2000);
}
async function stopLive(keepMessage=false) {
  wantLive=false; await teardownPc(); stopCapture(); releaseWakeLock(); setLiveUI(false); $('stats').textContent='';
  if(!keepMessage)setStatus('Stopped');
}
function startStats(){stopStats();last={t:0,b:0};statsTimer=setInterval(pollStats,1000);}
function stopStats(){clearInterval(statsTimer);statsTimer=null;}
async function pollStats(){
  if(!pc)return; const rep=await pc.getStats(); let out='';
  rep.forEach(r=>{if(r.type==='outbound-rtp'&&r.kind==='video'){const dt=(r.timestamp-last.t)/1000;const kbps=last.t?Math.round((r.bytesSent-last.b)*8/dt/1000):0;last={t:r.timestamp,b:r.bytesSent};out+=`video: ${r.frameWidth||'?'}x${r.frameHeight||'?'} @ ${Math.round(r.framesPerSecond||0)} fps, ${kbps} kbps\n`;}if(r.type==='candidate-pair'&&r.nominated&&r.state==='succeeded'){out+=`round-trip: ${Math.round((r.currentRoundTripTime||0)*1000)} ms\n`;}});
  $('stats').textContent=out;
}
async function acquireWakeLock(){try{if('wakeLock'in navigator&&!wakeLock){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}}catch(e){log('wake lock: '+e.message);}}
function releaseWakeLock(){try{wakeLock&&wakeLock.release();}catch{}wakeLock=null;}

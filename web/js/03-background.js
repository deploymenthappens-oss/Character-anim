// =====================================================================
//  03-background.js — live background rendering + cinematic camera.
// =====================================================================
const BG_THEMES = {
  aurora:   ['#1b1440','#4a2f86','#1a355e'],
  midnight: ['#0a0c1c','#141a33','#050611'],
  sunset:   ['#3a1240','#a3315a','#e08a3c'],
  studio:   ['#12151a','#262c36','#0b0d10'],
  neon:     ['#08041a','#2a0b5e','#0b1d4a'],
  bokeh:    ['#0d1b2a','#1b3a5c','#3a1c5c'],
};
const PARTS = Array.from({length:46}, () => ({x:Math.random(), y:Math.random(), r:0.006+Math.random()*0.02, sp:0.01+Math.random()*0.03, ph:Math.random()*6, hue:180+Math.random()*120}));

function drawStageBackground(ctx, W, H, t, themeName) {
  const c = BG_THEMES[themeName] || BG_THEMES.aurora, P = bgPulse;
  const g = ctx.createLinearGradient(0,0,W,H); g.addColorStop(0,c[0]); g.addColorStop(0.55,c[1]); g.addColorStop(1,c[2]);
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  for (let i=0; i<3; i++) {
    const ang=t*(0.12+i*0.05)+i*2.4, bx=W*(0.5+0.38*Math.cos(ang)), by=H*(0.48+0.30*Math.sin(ang*1.3));
    const r=Math.min(W,H)*(0.32+0.06*Math.sin(t*0.35+i)+0.05*P);
    const rg=ctx.createRadialGradient(bx,by,0,bx,by,r); rg.addColorStop(0,`rgba(255,255,255,${0.10+0.06*P})`); rg.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=rg; ctx.fillRect(0,0,W,H);
  }
  ctx.save(); ctx.globalCompositeOperation='lighter';
  if (themeName==='aurora') {
    for (let k=0; k<3; k++) {
      const hue=160+k*55+20*Math.sin(t*0.2), y0=H*(0.25+0.17*k);
      const rb=ctx.createLinearGradient(0,y0-H*0.2,0,y0+H*0.2); rb.addColorStop(0,'hsla('+hue+',90%,60%,0)'); rb.addColorStop(0.5,`hsla(${hue},90%,60%,${0.16+0.12*P})`); rb.addColorStop(1,'hsla('+hue+',90%,60%,0)');
      ctx.fillStyle=rb; ctx.beginPath(); ctx.moveTo(0,H);
      for (let x=0; x<=W; x+=20) ctx.lineTo(x, y0+Math.sin(x/W*5+t*(0.5+k*0.2)+k)*H*(0.07+0.04*P));
      ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    }
  } else if (themeName==='neon') {
    const hz=H*0.62, sun=ctx.createRadialGradient(W/2,hz,0,W/2,hz,H*(0.34+0.04*P));
    sun.addColorStop(0,'rgba(255,90,200,0.55)'); sun.addColorStop(1,'rgba(255,90,200,0)'); ctx.fillStyle=sun; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle=`rgba(90,220,255,${0.35+0.3*P})`; ctx.lineWidth=2;
    for (let i=-14; i<=14; i++) { ctx.beginPath(); ctx.moveTo(W/2+i*12,hz); ctx.lineTo(W/2+i*W*0.14,H); ctx.stroke(); }
    for (let i=0; i<10; i++) { const f=((i+(t*0.35)%1)/10), y=hz+(H-hz)*f*f; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  } else if (themeName==='bokeh') {
    for (const q of PARTS) {
      const y=((q.y-t*q.sp)%1+1)%1, x=q.x+Math.sin(t*0.3+q.ph)*0.03, r=H*q.r*(1+0.6*P);
      const og=ctx.createRadialGradient(x*W,y*H,0,x*W,y*H,r*3); og.addColorStop(0,`hsla(${q.hue},90%,70%,${0.35+0.3*P})`); og.addColorStop(1,'hsla('+q.hue+',90%,70%,0)');
      ctx.fillStyle=og; ctx.fillRect(x*W-r*3,y*H-r*3,r*6,r*6);
    }
  }
  ctx.restore();
  const floor=ctx.createRadialGradient(W/2,H*1.02,0,W/2,H*1.02,W*0.55); floor.addColorStop(0,'rgba(255,255,255,0.14)'); floor.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=floor; ctx.fillRect(0,0,W,H);
}

// Pre-fill with opaque black before drawing the scene. The parallax
// transform slightly shifts the background canvas, which can expose raw
// transparent canvas pixels at the edges; the oversized black rect covers
// those gaps.
function paintBackground(ctx, w, h, t, theme) {
  ctx.fillStyle = '#000';
  ctx.fillRect(-w, -h, w*3, h*3);   // 3× oversized → parallax can never show a bare canvas edge
  if (theme==='hawkins-room' && room.ready) room.draw(ctx, w, h);
  // 'studio-office-3d' is a Sketchfab <iframe> layer on view.html only (see setScene3D there) -
  // cross-origin iframe content can never be drawn into this canvas, and this canvas is what
  // stage.captureStream() turns into the real outgoing WHIP video (js/07-camera-whip.js). So the
  // actual broadcast just falls back to the closest gradient theme instead of going blank/stale.
  else if (theme==='studio-office-3d') drawStageBackground(ctx, w, h, t, 'studio');
  else drawStageBackground(ctx, w, h, t, theme);
}

const bgBuf = document.createElement('canvas');
function snapshotBackground(w, h, t, theme) {
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  paintBackground(c.getContext('2d'), w, h, t, theme); return c;
}
function drawBackgroundBlended(ctx, W, H, t) {
  const theme=$('bgTheme').value;
  if (!bgTransition) return paintBackground(ctx, W, H, t, theme);
  const dur=380, a=easeInOutCubic(Math.min(1,(performance.now()-bgTransition.start)/dur));
  if (bgBuf.width!==W || bgBuf.height!==H) { bgBuf.width=W; bgBuf.height=H; }
  const bctx=bgBuf.getContext('2d');
  bctx.globalAlpha=1; bctx.clearRect(0,0,W,H); bctx.drawImage(bgTransition.from,0,0,W,H);
  bctx.globalAlpha=a; paintBackground(bctx, W, H, t, theme); bctx.globalAlpha=1;
  ctx.drawImage(bgBuf,0,0,W,H);
  if (a>=1) bgTransition=null;
}

// ── cinematic camera springs ────────────────────────────────────────────
const spr = () => ({x:0, v:0});
const CINE = {z:{x:1,v:0}, x:spr(), y:spr(), r:spr(), next:0, shot:0, punch:0};
const CINE_LEVEL = {off:0, subtle:0.5, cinematic:1, dramatic:1.7};
const SHOTS = [{z:1.00,x:0,y:0},{z:1.10,x:-0.03,y:0.01},{z:1.10,x:0.03,y:0.01},{z:1.22,x:0,y:0.03},{z:1.36,x:0.015,y:0.06}];

function cs(s, target, dt, w) { const a=-2*w*s.v-w*w*(s.x-target); s.v+=a*dt; s.x+=s.v*dt; }
function camPunch(a) { CINE.punch=Math.min(1,CINE.punch+(a||0.6)); }

function cineUpdate(dt, t, speaking, lean, half) {
  // 16-spell.js takes the camera for the Upside Down scene: follow its authored targets, ignore the ambient shot picker
  if (CINE.force) { const f=CINE.force, w=7; cs(CINE.z,f.z,dt,w); cs(CINE.x,f.x,dt,w); cs(CINE.y,f.y,dt,w); cs(CINE.r,f.r,dt,w); CINE.punch*=Math.exp(-dt*1.6); return; }
  const L=CINE_LEVEL[$('qCine').value]||0;
  let tz=1, tx=0, ty=0, tr=0;
  if (L) {
    if (speaking) {
      if (t>=CINE.next) {
        let i; do { i=Math.floor(Math.random()*SHOTS.length); } while (i===CINE.shot && SHOTS.length>1);
        if (i===4 && Math.random()<0.4) i=2;
        CINE.shot=i; CINE.next=t+3+Math.random()*3.5;
        if (rig.ready) { if (i>=3) rig.leanCue(); else rig.stopLean(); }
      }
    } else if (CINE.shot!==0) { CINE.shot=0; CINE.next=0; if (rig.ready) rig.stopLean(); }
    const S=SHOTS[CINE.shot];
    tz=1+(S.z-1)*L+0.04*L*(0.5+0.5*Math.sin(t*0.35))+0.10*L*CINE.punch;
    tx=S.x*L+0.006*L*Math.sin(t*0.6); ty=(half?S.y*0.6:S.y)*L+0.004*L*Math.sin(t*0.8+1);
    tr=L*(0.35*Math.sin(t*0.55)+0.2*Math.sin(t*1.7));
  }
  CINE.punch*=Math.exp(-dt*1.6);
  const w=L?2.2:6;
  cs(CINE.z,tz,dt,w); cs(CINE.x,tx,dt,w); cs(CINE.y,ty,dt,w); cs(CINE.r,tr,dt,w*1.3);
}

function drawVignette(ctx, W, H) {
  const L=CINE_LEVEL[$('qCine').value]||0; if (!L) return;
  const g=ctx.createRadialGradient(W/2,H*0.45,H*0.45,W/2,H*0.5,H*1.0);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,`rgba(0,0,0,${0.32+0.1*Math.min(1,CINE.z.x-1)*3})`);
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
}

// ── 3D scene mirror, admin's own screen only ────────────────────────────
// The same Sketchfab embed viewers get (SCENE3D in view.html) shown here too, so the streamer sees
// what they're about to hand the audience - but this <iframe> is NEVER part of what
// stage.captureStream() turns into the outgoing WHIP video (that keeps using the gradient fallback
// in paintBackground above); it's a local DOM overlay on top of canvas#stage only.
// api_version=1.0.0 enables the Sketchfab Viewer API (postMessage SDK).
// Without it the iframe is a dumb embed with no programmatic access.
const SCENE3D_ADMIN = {
  'studio-office-3d': true,
};
let scene3dAdminActive = false;
// Admin's own navigation mode for the room: 'fps' (walk in) or 'orbit'. Persisted per browser.
let officeNavMode = 'fps';
try { officeNavMode = localStorage.getItem('officeNav') === 'orbit' ? 'orbit' : 'fps'; } catch {}
function applyScene3DFreeClassAdmin() {
  $('scene3dFrame').classList.toggle('free', scene3dAdminActive && scene3dFree);
}
function setScene3DAdmin(theme) {
  const goingTo3D = !!SCENE3D_ADMIN[theme], el = $('scene3dFrame');
  if (goingTo3D === scene3dAdminActive) return;
  if (goingTo3D) {
    el.classList.add('on');
    // Activate the Sketchfab Viewer API so every object/material/camera
    // in the office becomes a programmable variable. IMPORTANT: the iframe
    // must stay empty (no manual .src) until this call — client.init() sets
    // the src itself as part of its postMessage handshake. Pre-setting src
    // to a hand-built embed URL races that handshake and the API never
    // connects (this was the "no connection / no control" bug).
    if (window.OfficeScene) {
      OfficeScene.activate(el, () => {
        window._officeApiReady?.();
        // Mirror what the admin is looking at in publish to every viewer (throttled by the poll interval).
        OfficeScene.watchCamera(cam => {
          if (window.Autopilot && window.Autopilot.busy) return;   // an auto-pilot shot is sending its own single move
          adminFetch('office-input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'camera', name: 'live', value: cam }),
          }).catch(() => {});
        }, 250);
      }, { navigation: officeNavMode });
    }
  } else {
    el.classList.remove('on');
    if (window.OfficeScene) OfficeScene.stopWatchCamera();
    setTimeout(() => { if (!scene3dAdminActive) el.src = ''; }, 400);   // free the WebGL context once faded out
  }
  scene3dAdminActive = goingTo3D;
  applyScene3DFreeClassAdmin();
}

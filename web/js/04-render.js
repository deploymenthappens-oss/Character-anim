// =====================================================================
//  04-render.js — main draw loop and avatar/desk draw helpers.
//
//  DESK FIX: HALF.desk moved 0.82 → 0.90 so the desk sits lower and
//  the character's arms/torso have room to gesture without overlapping
//  the desk graphic. HALF.fill nudged 0.78 → 0.74 to compensate.
//
//  SCENE ZOOM: every frame, sceneZoomCurrent is spring-interpolated
//  toward sceneZoomTarget (set by the dock ＋/－ buttons or sidebar
//  slider). The entire composited canvas — background AND character —
//  is drawn at normal resolution, then the canvas is scaled about its
//  centre with ctx.scale(zoom, zoom) so zoom affects everything
//  uniformly. The zoom transform is applied AFTER the cinematic camera
//  transform so the two compose cleanly (cine zooms the virtual
//  camera; scene zoom zooms the output window).
// =====================================================================
const HALF = {cutY:700, desk:0.90, fill:0.74};
const FULL = {fill:0.86, floor:0.965, shadow:0.34, legsCutY:770, legsFade:45};

const stage=$('stage'), cam=$('cam'), sctx=stage.getContext('2d');
const stageStart=performance.now();

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);     ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function drawAvatarFullBody(W, H, charX, lean, size) {
  const F=rig.frac, cw=rig.canvas.width, ch=rig.canvas.height;
  const k=1+AvatarInternals.LEAN.scale*lean;
  const dh=H*FULL.fill*size*k/(F.sole-F.top);
  const dw=dh*cw/ch;
  const x=W*charX - F.cx*dw;
  const y=H*FULL.floor - F.sole*dh;
  rig._draw={x, y, dw, dh};                       // where the avatar canvas lands on #stage (wand mapping, see wandMapUpdate)
  const floorY=H*FULL.floor;
  if (showLegs) {
    const air=rig.orchestra?rig.orchestra.airborne:0, unit=(rig.unitPx||1)*dh/ch;
    const lift=Math.min(0.6,air/60), sw=300*unit*(1-0.35*lift), sh=sw*0.13;
    const g=sctx.createRadialGradient(W*charX,floorY,0, W*charX,floorY,sw/2);
    g.addColorStop(0,'rgba(0,0,0,'+(FULL.shadow*(1-lift)).toFixed(3)+')'); g.addColorStop(1,'rgba(0,0,0,0)');
    sctx.save(); sctx.translate(0,floorY); sctx.scale(1,sh/(sw/2)); sctx.translate(0,-floorY);
    sctx.fillStyle=g; sctx.beginPath(); sctx.arc(W*charX,floorY,sw/2,0,Math.PI*2); sctx.fill(); sctx.restore();
  }
  if (showLegs) {
    sctx.drawImage(rig.canvas, x, y, dw, dh);
  } else {
    const srcH=Math.round(F.at(FULL.legsCutY)*ch), fade=Math.round(FULL.legsFade*rig.unitPx);
    legsTmp=legsTmp||document.createElement('canvas');
    if (legsTmp.width!==cw||legsTmp.height!==srcH) { legsTmp.width=cw; legsTmp.height=srcH; }
    const t2=legsTmp.getContext('2d'); t2.globalCompositeOperation='source-over'; t2.clearRect(0,0,cw,srcH);
    t2.drawImage(rig.canvas, 0,0,cw,srcH, 0,0,cw,srcH);
    const lg=t2.createLinearGradient(0,srcH-fade,0,srcH); lg.addColorStop(0,'rgba(0,0,0,0)'); lg.addColorStop(1,'rgba(0,0,0,1)');
    t2.globalCompositeOperation='destination-out'; t2.fillStyle=lg; t2.fillRect(0,srcH-fade,cw,fade);
    sctx.drawImage(legsTmp, 0,0,cw,srcH, x,y, dw,srcH*dh/ch);
  }
}

function drawAvatarHalfBody(W, H, lean, size) {
  const F=rig.frac, cw=rig.canvas.width, ch=rig.canvas.height;
  const k=1+AvatarInternals.LEAN.scale*lean;
  const cut=F.at(HALF.cutY), deskY=H*HALF.desk;
  const dh=H*HALF.fill*size*k/(cut-F.top), dw=dh*cw/ch;
  const x=W/2-F.cx*dw, y=deskY-cut*dh;
  rig._draw={x, y, dw, dh};
  sctx.drawImage(rig.canvas, 0,0,cw,Math.round(cut*ch), x,y, dw,cut*dh);
  const dg=sctx.createLinearGradient(0,deskY,0,H); dg.addColorStop(0,'#0a0c12'); dg.addColorStop(1,'#05060a');
  sctx.fillStyle=dg; sctx.fillRect(-W*0.3,deskY,W*1.6,H*2);
  sctx.fillStyle='rgba(255,255,255,0.18)'; sctx.fillRect(-W*0.3,deskY,W*1.6,2);
}

// ── wand support: where do avatar-canvas pixels end up on the ADMIN's screen? ─────────────────────
// The rig's own canvas is off-screen on this page (it is only a source that is drawn onto #stage, or onto the small corner preview
// while the 3D office covers the stage), so 13-wand.js / avatar.js can't read its position from the DOM like view.html does.
// This installs rig.clientMap(px, py) -> {x, y, k, rot}: canvas pixel -> client pixel, k = client px per canvas px, rot = camera tilt.
// `g` = the rectangle the avatar was drawn into on #stage (or null); `cine` = the cinematic-camera transform applied to it (or null).
function wandMapUpdate(W, H, g, cine, ez) {
  const cw=rig.canvas.width, ch=rig.canvas.height;
  const s3=document.getElementById('scene3dFrame'), pc=document.getElementById('localPreviewCanvas');
  if (s3 && s3.classList.contains('on') && pc) {           // 3D office: the admin sees the avatar only in the corner preview
    rig.clientMap=(px,py)=>{ const r=pc.getBoundingClientRect(); return r.width>4 ? {x:r.left+px*r.width/cw, y:r.top+py*r.height/ch, k:r.width/cw, rot:0} : null; };
    return;
  }
  if (!g) { rig.clientMap=()=>null; return; }              // avatar not drawn at all ("off")
  rig.clientMap=(px,py)=>{
    let x=g.x+px*g.dw/cw, y=g.y+py*g.dh/ch, k=g.dh/ch, rot=0;
    if (cine) {
      const dx=x-cine.fx, dy=y-cine.fy, a=cine.r*Math.PI/180, c=Math.cos(a), sn=Math.sin(a);
      x=cine.fx+cine.tx+(dx*c-dy*sn)*cine.z; y=cine.fy+cine.ty+(dx*sn+dy*c)*cine.z; k*=cine.z; rot=cine.r;
    }
    if (Math.abs(ez-1)>0.001) { x=W/2+(x-W/2)*ez; y=H/2+(y-H/2)*ez; k*=ez; }
    const r=stage.getBoundingClientRect(), sx=r.width/W, sy=r.height/H;
    return {x:r.left+x*sx, y:r.top+y*sy, k:k*sx, rot};
  };
}

// ── ZOOM-OUT BACKGROUND EXTENSION ─────────────────────────────────────────────────────────────────
// Below 100% the scene shrinks toward the centre and the canvas edges would show empty. Instead the background is continued past its
// own edges: mirrored copies of it (a mirror is seamless at the join) are laid around the real one, then softened and darkened a
// little so the extension reads as "the room keeps going, out of focus" rather than as a copy. It is built at 1/3 resolution and
// scaled up (the upscale IS the blur, so it costs almost nothing) and drawn UNDER the normal zoomed-out scene, which stays sharp.
const bgTile = document.createElement('canvas'), bgExt = document.createElement('canvas');
const EXT = { scale: 1/3, dark: 0.22 };
function paintZoomOutExtension(W, H, ez, bz, cx, cy) {
  const ew = Math.max(2, Math.round(W*EXT.scale)), eh = Math.max(2, Math.round(H*EXT.scale));
  if (bgExt.width!==ew || bgExt.height!==eh) { bgExt.width=ew; bgExt.height=eh; }
  const c=bgExt.getContext('2d');
  c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,ew,eh);
  c.imageSmoothingEnabled=true; c.imageSmoothingQuality='high';
  c.setTransform(EXT.scale,0,0,EXT.scale,0,0);
  // the same transforms the sharp background gets: scene zoom about the centre, then the cinematic-camera drift of the background
  c.translate(W/2,H/2); c.scale(ez,ez); c.translate(-W/2,-H/2);
  c.translate(W/2-cx*W*0.3, H/2-cy*H*0.3); c.scale(bz,bz); c.translate(-W/2,-H/2);
  for (let j=-1;j<=1;j++) for (let i=-1;i<=1;i++) {
    c.save(); c.translate(i*W+W/2, j*H+H/2); c.scale(i?-1:1, j?-1:1);     // odd neighbours are mirrored, so the seams match
    c.drawImage(bgTile, -W/2, -H/2, W, H); c.restore();
  }
  c.setTransform(1,0,0,1,0,0);
  sctx.save(); sctx.imageSmoothingEnabled=true; sctx.imageSmoothingQuality='high';
  sctx.drawImage(bgExt, 0,0,ew,eh, 0,0,W,H);
  const k=Math.min(1,(1-ez)/0.5);                                          // deeper zoom-out -> the extension fades a bit darker
  sctx.fillStyle='rgba(4,6,14,'+(EXT.dark*(0.5+0.5*k)).toFixed(3)+')'; sctx.fillRect(0,0,W,H);
  sctx.restore();
}

// ── main draw loop ────────────────────────────────────────────────────
function drawFrame() {
  const centered=$('stageMode').value==='center';
  const haveCam=!!camStream && cam.readyState>=2 && cam.videoWidth>0;
  const vw=centered?1280:(haveCam?cam.videoWidth:1280);
  const vh=centered?720: (haveCam?cam.videoHeight:720);
  if (stage.width!==vw||stage.height!==vh) { stage.width=vw; stage.height=vh; }
  const W=stage.width, H=stage.height;
  const lean=rig.ready?rig.leanAmount:0;
  const t=(performance.now()-stageStart)/1000;
  const now=performance.now();

  // Wire the room's beat reactions to Orchestra's real emphasis detector once it's available (safe to
  // call every frame; it's a no-op after the first successful hookup — see wireToRig's own comment).
  if (rig.ready && rig.orchestra && !room._beatWired) { rig.orchestra.onBeat = s => room.reactToBeat(s); room._beatWired = true; }
  // Real per-frame speech envelope (rig.orchestra.voiceLevel), not a plain on/off flag — so the room's
  // light-pulse/prop reactions actually land on the loud/stressed parts of the voice. Falls back to the
  // old speaking flag if Orchestra didn't load.
  const roomTarget = Math.max(rig.ready ? (rig.orchestra ? rig.orchestra.voiceLevel : (rig.speaking ? 1 : 0)) : 0, window.Spell ? window.Spell.energy : 0);   // + the spell's building magic
  bgPulse+=(roomTarget-bgPulse)*0.08;
  room.reactToSpeech(bgPulse);

  const dt=Math.min(0.05,(now-(drawFrame._last||now))/1000);
  cineUpdate(dt, t, rig.ready&&rig.speaking, lean, $('frameMode').value==='half');
  drawFrame._last=now;

  // ── smooth-spring the scene zoom toward its target ────────────────
  // Spring coefficient: higher = snappier, lower = softer. See SCENE_ZOOM_SPRING.
  sceneZoomCurrent += (sceneZoomTarget - sceneZoomCurrent) * Math.min(1, dt * SCENE_ZOOM_SPRING);

  // ── room ambient breathing zoom (Ken Burns), room-scene only ───────
  // Layered on top of (multiplies with) the manual zoom so +/- and the
  // slider still work exactly as before; just adds a slow soft drift
  // while the Hawkins room is the visible background.
  let roomBreath = 1;
  if (!prefersReducedMotion && centered && $('bgTheme').value === 'hawkins-room') {
    roomBreath = 1 + Math.sin((t / ROOM_AMBIENT_ZOOM_PERIOD) * Math.PI * 2) * ROOM_AMBIENT_ZOOM_AMOUNT;
  }
  const effectiveZoom = sceneZoomCurrent * roomBreath;

  // ── apply scene zoom: scale canvas about its centre ───────────────
  // Everything drawn inside this save/restore is zoomed uniformly.
  sctx.save();
  // zoomed OUT in centre-stage mode: paint the background once into a tile and lay the extension under the scene (see above)
  const extendBg = centered && effectiveZoom < 0.995;
  if (extendBg) {
    if (bgTile.width!==W || bgTile.height!==H) { bgTile.width=W; bgTile.height=H; }
    const tc=bgTile.getContext('2d'); tc.clearRect(0,0,W,H);
    drawBackgroundBlended(tc, W, H, t);
    paintZoomOutExtension(W, H, effectiveZoom, 1+(CINE.z.x-1)*0.35, CINE.x.x, CINE.y.x);
  }
  if (Math.abs(effectiveZoom - 1) > 0.001) {
    sctx.translate(W/2, H/2);
    sctx.scale(effectiveZoom, effectiveZoom);
    sctx.translate(-W/2, -H/2);
  }

  // ── background ────────────────────────────────────────────────────
  if (centered) {
    sctx.save();
    const bz=1+(CINE.z.x-1)*0.35;
    sctx.translate(W/2-CINE.x.x*W*0.3, H/2-CINE.y.x*H*0.3); sctx.scale(bz,bz); sctx.translate(-W/2,-H/2);
    const bl=Math.max(lean*AvatarInternals.LEAN.blur,(CINE.z.x-1)*7);
    if (bl>0.4) sctx.filter=`blur(${bl.toFixed(1)}px)`;
    if (extendBg) sctx.drawImage(bgTile,0,0,W,H); else drawBackgroundBlended(sctx, W, H, t);
    sctx.filter='none'; sctx.restore();
    if (haveCam&&$('camPip').checked) {
      const pw=W*0.22, ph=pw*((cam.videoHeight/cam.videoWidth)||9/16);
      sctx.save(); roundRectPath(sctx,W-pw-18,18,pw,ph,12); sctx.clip(); sctx.drawImage(cam,W-pw-18,18,pw,ph); sctx.restore();
    }
  } else if (haveCam) {
    if (lean>0.01) { sctx.filter=`blur(${(lean*AvatarInternals.LEAN.blur).toFixed(1)}px)`; sctx.drawImage(cam,0,0,W,H); sctx.filter='none'; }
    else sctx.drawImage(cam,0,0,W,H);
  } else {
    sctx.fillStyle='#10141a'; sctx.fillRect(0,0,W,H);
    sctx.fillStyle='#6b7788'; sctx.font=`${Math.round(H/24)}px system-ui,sans-serif`;
    sctx.textAlign='left'; sctx.fillText('Camera off — avatar preview', W*0.03, H*0.06);
  }

  // ── character ─────────────────────────────────────────────────────
  if (rig.ready) {
    if (centered && !avatarMinimized) {
      const half=$('frameMode').value==='half', size=$('asize').value/66;
      sctx.save();
      { const fx=W/2, fy=H*(half?0.40:0.28), z=CINE.z.x;
        sctx.translate(fx+CINE.x.x*W, fy+CINE.y.x*H); sctx.rotate(CINE.r.x*Math.PI/180); sctx.scale(z,z); sctx.translate(-fx,-fy); }
      if (half) {
        drawAvatarHalfBody(W, H, lean, size);
      } else {
        const walkFrac = tickWalkAnim(now);
        const charX    = walkFrac !== null ? walkFrac : restX;
        drawAvatarFullBody(W, H, charX, lean, size);
      }
      sctx.restore();
      wandMapUpdate(W, H, rig._draw, {fx:W/2, fy:H*(half?0.40:0.28), tx:CINE.x.x*W, ty:CINE.y.x*H, r:CINE.r.x, z:CINE.z.x}, effectiveZoom);
      drawVignette(sctx, W, H);
    } else {
      const pos=avatarMinimized?'right':$('apos').value;
      if (pos!=='off') {
        const sizePct=avatarMinimized?18:$('asize').value;
        const ah=H*(sizePct/100)*(1+AvatarInternals.LEAN.scale*lean);
        const aw=ah*(rig.canvas.width/rig.canvas.height), margin=W*0.02;
        sctx.drawImage(rig.canvas, pos==='right'?W-aw-margin:margin, H-ah, aw, ah);
        wandMapUpdate(W, H, {x:pos==='right'?W-aw-margin:margin, y:H-ah, dw:aw, dh:ah}, null, effectiveZoom);
      } else wandMapUpdate(W, H, null, null, 1);
    }
  }

  // ── close scene-zoom transform ────────────────────────────────────
  sctx.restore();

  // ── speech bubble ──────────────────────────────────────────────────
  // Drawn AFTER sctx.restore() — canvas is back to identity transform,
  // so the bubble is never scaled/rotated by the cinematic zoom and always
  // appears at a readable, stable size regardless of zoom level.
  // The mouth position is calculated in scene-space then scaled by the
  // current zoom about the canvas centre to match where the zoomed avatar
  // actually sits on screen.
  if (window.SpeechBubble && rig.ready) {
    const F   = rig.frac;
    const cw  = rig.canvas.width, ch = rig.canvas.height;
    // Mouth sits ~16.5% of the way down from the character bounding-box top
    // toward the sole — empirically correct for the JIM rig in all body modes.
    const MOUTH_FRAC_Y = F.top + (F.sole - F.top) * 0.165;
    const isCentered   = centered && !avatarMinimized;
    let mouthX, mouthY;

    if (isCentered) {
      const half = $('frameMode').value === 'half';
      const size = $('asize').value / 66;
      const k    = 1 + AvatarInternals.LEAN.scale * lean;

      if (half) {
        const dh = H * HALF.fill * size * k / (F.at(HALF.cutY) - F.top);
        const dw = dh * cw / ch;
        const x  = W / 2 - F.cx * dw;
        const y  = H * HALF.desk - F.at(HALF.cutY) * dh;
        mouthX = x + F.cx * dw;
        mouthY = y + MOUTH_FRAC_Y * dh;
      } else {
        const walkFrac = (typeof restX !== 'undefined') ? restX : 0.5;
        const dh = H * FULL.fill * size * k / (F.sole - F.top);
        const dw = dh * cw / ch;
        const x  = W * walkFrac - F.cx * dw;
        const y  = H * FULL.floor - F.sole * dh;
        mouthX = x + F.cx * dw;
        mouthY = y + MOUTH_FRAC_Y * dh;
      }
      // Mirror the cinematic-camera transform applied inside the save/restore
      const fx = W / 2, fy = H * ($('frameMode').value === 'half' ? 0.40 : 0.28);
      const z  = CINE.z.x;
      const dx = mouthX - fx, dy = mouthY - fy;
      const r  = CINE.r.x * Math.PI / 180;
      const cosR = Math.cos(r), sinR = Math.sin(r);
      const rx = dx * cosR - dy * sinR, ry = dx * sinR + dy * cosR;
      mouthX = fx + CINE.x.x * W + rx * z;
      mouthY = fy + CINE.y.x * H + ry * z;
      // Then apply the outer scene-zoom (sceneZoomCurrent * roomBreath) about the canvas centre.
      // We use sceneZoomCurrent directly; roomBreath is a tiny breathing oscillation (±1%) that
      // would make the bubble wobble — omitting it is the right call for a speech bubble.
      const ez = sceneZoomCurrent;
      if (Math.abs(ez - 1) > 0.001) {
        mouthX = W / 2 + (mouthX - W / 2) * ez;
        mouthY = H / 2 + (mouthY - H / 2) * ez;
      }
    } else {
      // Corner mode — scene-zoom also affects the corner avatar position
      const pos     = avatarMinimized ? 'right' : ($('apos').value || 'right');
      const sizePct = avatarMinimized ? 18 : Number($('asize').value || 66);
      const ah      = H * (sizePct / 100) * (1 + AvatarInternals.LEAN.scale * lean);
      const aw      = ah * (cw / ch);
      const margin  = W * 0.02;
      const ax      = pos === 'right' ? W - aw - margin : margin;
      const ay      = H - ah;
      mouthX = ax + F.cx * aw;
      mouthY = ay + MOUTH_FRAC_Y * ah;
      // Corner avatar is also inside the scene-zoom save/restore block,
      // so scale the derived mouth position accordingly.
      const ez = sceneZoomCurrent;
      if (Math.abs(ez - 1) > 0.001) {
        mouthX = W / 2 + (mouthX - W / 2) * ez;
        mouthY = H / 2 + (mouthY - H / 2) * ez;
      }
    }

    SpeechBubble.draw(sctx, W, H, mouthX, mouthY);
  }

  // ── local preview corner: mirrors the broadcast corner above the iframe
  //    overlay so the admin always sees what's actually going out. No-op
  //    when the 3D iframe is not active (guard is inside the function).
  if (window.Spell) window.Spell.drawOverlay(sctx, W, H);     // spell flash + darkening edges (in the outgoing stream too)
  if (window.drawLocalPreviewCorner) drawLocalPreviewCorner(W, H);
}

// ── LOCAL PREVIEW CORNER — copies the exact broadcast-corner region from
//    #stage into #localPreviewCanvas so the admin always sees a pixel-
//    accurate representation of what viewers receive, even while the
//    Sketchfab iframe is covering the canvas on their own screen.
//
//    Called at the end of drawFrame() after sctx.restore() so we're
//    reading the fully composited (zoom-applied) canvas.  The preview
//    canvas is sized to ~22% of the stage height to match the broadcast
//    corner size set by the asize slider, and positioned at bottom-right
//    (matching the default "right" apos).  It is hidden by CSS whenever
//    the .scene3d iframe is not .on, so there is zero overhead in the
//    common case.
(function() {
  const previewEl = document.getElementById('localPreviewCorner');
  const previewCanvas = document.getElementById('localPreviewCanvas');
  if (!previewEl || !previewCanvas) return;
  const pctx = previewCanvas.getContext('2d');

  window.drawLocalPreviewCorner = function(W, H) {
    // Only draw if the iframe overlay is actually on and the element is visible.
    const scene3d = document.getElementById('scene3dFrame');
    if (!scene3d || !scene3d.classList.contains('on')) return;
    if (!rig.ready) return;

    // Draw the character itself (not a stage-corner copy: in centered layout the corner of #stage is
    // just empty background, which is why this box used to look blank). Same docked-to-the-side look
    // viewers get in view.html while the 3D room is selected.
    const ch = rig.canvas.height, cw = rig.canvas.width;
    const ph = Math.round(Math.min(H, 720) * 0.34 * (avatarMinimized ? 0.75 : 1));
    const pw = Math.round(ph * cw / ch);
    if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
      previewCanvas.width  = pw;
      previewCanvas.height = ph;
      previewCanvas.style.height = 'auto';
      previewCanvas.style.width  = Math.round(pw * 0.8) + "px";   // CSS size; bitmap stays sharp on HiDPI
    }
    pctx.clearRect(0, 0, pw, ph);
    pctx.drawImage(rig.canvas, 0, 0, cw, ch, 0, 0, pw, ph);
  };
})();

function startDrawing() { stopDrawing(); drawTimer=setInterval(drawFrame,1000/30); }
function stopDrawing()  { clearInterval(drawTimer); drawTimer=null; }

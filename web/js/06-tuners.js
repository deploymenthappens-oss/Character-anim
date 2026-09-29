// =====================================================================
//  06-tuners.js — generic slider-tuner builder used by the wave,
//  pointing, and voice tuning panels, plus the "copy values" helper.
// =====================================================================
function buildTuner({target,defaults,spec,rows,key,onChange}) {
  const get=p=>p.split('.').reduce((o,k)=>o[k],target);
  const set=(p,v)=>{const ks=p.split('.'),last=ks.pop();ks.reduce((o,k)=>o[k],target)[last]=v;};
  const merge=(dst,src)=>{for(const k in src){const v=src[k];if(v&&typeof v==='object')merge(dst[k],v);else if(typeof v==='number'||typeof v==='boolean')dst[k]=v;}};
  try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved)merge(target,saved);}catch{}
  const save=()=>{try{localStorage.setItem(key,JSON.stringify(target));}catch{}};
  const inputs=[];
  for (const [path,label,min,max,step,unit] of spec) {
    const row=document.createElement('div'); row.className='tune';
    const lab=document.createElement('label'); lab.textContent=label+(unit?' ('+unit+')':'');
    const rng=document.createElement('input'); rng.type='range'; rng.min=min; rng.max=max; rng.step=step;
    const num=document.createElement('input'); num.type='number'; num.min=min; num.max=max; num.step=step;
    rng.setAttribute('aria-label',label); num.setAttribute('aria-label',label+' value');
    const apply=v=>{v=Math.min(max,Math.max(min,Number(v)));if(Number.isNaN(v))return;set(path,v);rng.value=num.value=v;save();if(onChange)onChange();};
    rng.oninput=()=>apply(rng.value); num.onchange=()=>apply(num.value);
    rng.value=num.value=get(path); row.append(lab,rng,num); rows.appendChild(row); inputs.push([path,rng,num]);
  }
  return {save, refresh:()=>inputs.forEach(([p,r,n])=>{r.value=n.value=get(p);}), reset:()=>{merge(target,defaults);save();if(onChange)onChange();}, text:name=>'const '+name+' = '+JSON.stringify(target,null,2)+';'};
}
async function copyOut(text,noteId,name) {
  const note=document.getElementById(noteId);
  try{await navigator.clipboard.writeText(text);note.textContent='Copied. Paste it over the '+name+' constant in web/avatar.js to make it permanent.';}
  catch{note.textContent=text;}
}

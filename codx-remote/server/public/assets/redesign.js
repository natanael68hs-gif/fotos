document.documentElement.classList.remove('no-js');
export function toast(message,error=false){
  document.querySelector('.toast-v2')?.remove();
  const el=document.createElement('div');el.className='toast-v2'+(error?' error':'');el.setAttribute('role',error?'alert':'status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),4500);
}
const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}},{threshold:.08}):null;
document.querySelectorAll('.reveal-v2').forEach(el=>observer?observer.observe(el):el.classList.add('visible'));

// Anchor the decorative connections to the actual layout, including mobile widths.
document.querySelectorAll('.connection-scene').forEach(scene=>{
  const svg=scene.querySelector('.network-lines');
  const icons=[...scene.querySelectorAll('.scene-provider .provider-icon')];
  const targets=[...scene.querySelectorAll('.scene-targets > span')];
  const core=scene.querySelector('.core');
  const title=scene.querySelector('.core-title');
  if(!svg||icons.length!==3||targets.length!==3||!core||!title)return;
  let frame;
  const draw=()=>{
    const bounds=svg.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    const rect=el=>{
      const r=el.getBoundingClientRect();
      return {x:r.left-bounds.left,y:r.top-bounds.top,width:r.width,height:r.height};
    };
    const hub=rect(core),label=rect(title);
    const cx=hub.x+hub.width/2,cy=hub.y+hub.height/2;
    svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);
    const paths=icons.map((icon,i)=>{
      const r=rect(icon),x=r.x+r.width/2,y=r.y+r.height-8;
      const dx=i===1?0:(i===0?-55:55),ey=cy-(i===1?80:55);
      return `M${x} ${y} C${x} ${y+55} ${cx+dx} ${ey-35} ${cx+dx} ${ey}`;
    });
    targets.forEach((target,i)=>{
      const r=rect(target),x=r.x+r.width/2,y=r.y+1;
      if(i===1){
        // Leave a clear gap around the name and subtitle instead of crossing them.
        paths.push(`M${cx} ${cy+80} L${cx} ${label.y-7} M${cx} ${label.y+label.height+7} L${x} ${y}`);
      }else{
        const sx=cx+(i===0?-70:70),sy=cy+45;
        paths.push(`M${sx} ${sy} C${x} ${sy+55} ${x} ${y-45} ${x} ${y}`);
      }
    });
    svg.querySelector('path:not(.flow)').setAttribute('d',paths.join(' '));
    svg.querySelector('.flow').setAttribute('d',paths.filter((_,i)=>i!==2).join(' '));
    svg.dataset.ready='true';
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw)};
  if(typeof ResizeObserver==='function'){
    const resize=new ResizeObserver(schedule);
    [scene,core,title,...icons,...targets].forEach(el=>resize.observe(el));
  }
  window.addEventListener('resize',schedule);
  document.fonts?.ready.then(schedule);
  schedule();
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-copy-value]');if(!button)return;
  try{await navigator.clipboard.writeText(button.dataset.copyValue);const old=button.textContent;button.textContent='Copiado ✓';toast('Copiado para a área de transferência.');setTimeout(()=>button.textContent=old,1800)}
  catch{toast('Não foi possível copiar. Selecione e copie o comando acima.',true)}
});

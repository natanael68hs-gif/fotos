document.documentElement.classList.remove('no-js');
export function toast(message,error=false){
  document.querySelector('.toast-v2')?.remove();
  const el=document.createElement('div');el.className='toast-v2'+(error?' error':'');el.setAttribute('role',error?'alert':'status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),4500);
}
const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}},{threshold:.08}):null;
document.querySelectorAll('.reveal-v2').forEach(el=>observer?observer.observe(el):el.classList.add('visible'));
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-copy-value]');if(!button)return;
  try{await navigator.clipboard.writeText(button.dataset.copyValue);const old=button.textContent;button.textContent='Copiado ✓';toast('Copiado para a área de transferência.');setTimeout(()=>button.textContent=old,1800)}
  catch{toast('Não foi possível copiar. Selecione e copie o comando acima.',true)}
});

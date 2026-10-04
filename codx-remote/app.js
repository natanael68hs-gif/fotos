const SITE='https://codx-remote-zrider.vercel.app';
const cmd='irm '+SITE+'/install.ps1 | iex';
const el=document.getElementById('installCommand');
if(el) el.textContent=cmd;

document.getElementById('copyInstall')?.addEventListener('click', async e=>{
  await navigator.clipboard.writeText(cmd);
  e.currentTarget.textContent='Copiado ✓';
  setTimeout(()=>e.currentTarget.textContent='Copiar',1800);
});

function openManager(){
  window.open('http://127.0.0.1:8080/ui','_blank','noopener');
}
document.getElementById('manageTop')?.addEventListener('click',openManager);
document.getElementById('manageHero')?.addEventListener('click',openManager);

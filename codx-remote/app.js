const cmd='irm https://codx-remote-zrider.vercel.app/install.ps1 | iex';
const el=document.getElementById('installCommand');
if(el) el.textContent=cmd;

document.getElementById('copyInstall')?.addEventListener('click', async e=>{
  await navigator.clipboard.writeText(cmd);
  e.currentTarget.textContent='Copiado ✓';
  setTimeout(()=>e.currentTarget.textContent='Copiar',1800);
});

const params=new URLSearchParams(location.search);
const manageKey=params.get('manage');

async function loadManager(){
  const section=document.getElementById('manager');
  const hint=document.getElementById('managerHint');
  if(!manageKey){
    if(hint) hint.textContent='Inicie o Codx Remote e abra o link Manager mostrado no terminal.';
    return;
  }

  try{
    const r=await fetch('/api/manage?key='+encodeURIComponent(manageKey),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'Falha ao carregar Manager');

    const online=(d.devices||[]).filter(x=>x.online).length;
    if(hint) hint.textContent=online+' dispositivo(s) online • '+(d.totalToolCalls||0)+' chamadas totais';

    let box=document.getElementById('managerDevices');
    if(!box){
      box=document.createElement('div');
      box.id='managerDevices';
      box.className='grid2';
      section?.appendChild(box);
    }

    box.innerHTML=(d.devices||[]).map(x=>`
      <article>
        <h3>${escapeHtml(x.deviceName||'PC')} ${x.online?'● Online':'○ Offline'}</h3>
        <p>ID: <code>${escapeHtml(x.deviceId)}</code><br>
        Chamadas: ${Number(x.toolCalls||0)}<br>
        Último sinal: ${x.lastSeen?new Date(x.lastSeen).toLocaleString():'-'}</p>
        ${x.revoked?'':'<button class="btn small" data-revoke="'+escapeHtml(x.deviceId)+'">Revogar</button>'}
      </article>
    `).join('') || '<article><h3>Nenhum dispositivo</h3><p>Inicie o agente no PowerShell.</p></article>';

    box.querySelectorAll('[data-revoke]').forEach(btn=>btn.addEventListener('click',async()=>{
      if(!confirm('Revogar este dispositivo?')) return;
      await fetch('/api/manage?key='+encodeURIComponent(manageKey),{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'revoke',deviceId:btn.dataset.revoke})
      });
      loadManager();
    }));
  }catch(err){
    if(hint) hint.textContent='Manager inválido ou indisponível: '+err.message;
  }
}

function escapeHtml(v){
  return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.getElementById('managerRefresh')?.addEventListener('click',loadManager);
document.getElementById('manageTop')?.addEventListener('click',()=>document.getElementById('manager')?.scrollIntoView());
document.getElementById('manageHero')?.addEventListener('click',()=>document.getElementById('manager')?.scrollIntoView());

if(manageKey){
  document.getElementById('manager')?.scrollIntoView();
  loadManager();
  setInterval(loadManager,5000);
}

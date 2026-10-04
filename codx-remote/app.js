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

function escapeHtml(v){
  return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadAccountLogin(section){
  if(!manageKey) return;
  const r=await fetch('/api/account?key='+encodeURIComponent(manageKey),{cache:'no-store'});
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||'Falha ao carregar conta');

  let card=document.getElementById('accountLoginCard');
  if(!card){
    card=document.createElement('article');
    card.id='accountLoginCard';
    card.className='device-card';
    section?.appendChild(card);
  }

  if(data.hasCredentials){
    card.innerHTML='<div class="device-icon">✓</div><div><strong>Login Codx Remote configurado</strong><span>'+escapeHtml(data.email||'')+'</span></div><span class="btn small ghost">OAuth pronto</span>';
    return;
  }

  card.innerHTML=`
    <div class="device-icon">＠</div>
    <div style="flex:1">
      <strong>Crie seu login Codx Remote</strong>
      <span>Esse login será usado para autorizar o plugin no ChatGPT.</span>
      <form id="credentialForm" style="margin-top:14px;display:grid;gap:9px">
        <input id="credentialEmail" type="email" autocomplete="email" placeholder="seu@email.com" required
          style="padding:11px;border-radius:8px;border:1px solid #344157;background:#0a101a;color:white">
        <input id="credentialPassword" type="password" autocomplete="new-password" placeholder="Senha com 10+ caracteres" minlength="10" required
          style="padding:11px;border-radius:8px;border:1px solid #344157;background:#0a101a;color:white">
        <button class="btn small" type="submit">Criar login</button>
        <span id="credentialMessage"></span>
      </form>
    </div>`;

  document.getElementById('credentialForm')?.addEventListener('submit',async e=>{
    e.preventDefault();
    const msg=document.getElementById('credentialMessage');
    const email=document.getElementById('credentialEmail').value;
    const password=document.getElementById('credentialPassword').value;
    msg.textContent='Salvando...';
    try{
      const rr=await fetch('/api/account?key='+encodeURIComponent(manageKey),{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'set_credentials',email,password})
      });
      const dd=await rr.json();
      if(!rr.ok) throw new Error(dd.error||'Falha');
      msg.textContent='Login criado.';
      loadAccountLogin(section);
    }catch(err){
      msg.textContent='Erro: '+err.message;
    }
  });
}

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

    await loadAccountLogin(section);
  }catch(err){
    if(hint) hint.textContent='Manager inválido ou indisponível: '+err.message;
  }
}

document.getElementById('managerRefresh')?.addEventListener('click',loadManager);
document.getElementById('manageTop')?.addEventListener('click',()=>document.getElementById('manager')?.scrollIntoView());
document.getElementById('manageHero')?.addEventListener('click',()=>document.getElementById('manager')?.scrollIntoView());

if(manageKey){
  document.getElementById('manager')?.scrollIntoView();
  loadManager();
  setInterval(loadManager,5000);
}

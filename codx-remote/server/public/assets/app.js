(()=>{
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}
  }),{threshold:.12});
  document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));

  const toast=document.createElement('div');toast.className='toast';document.body.appendChild(toast);
  const notify=(msg)=>{toast.textContent=msg;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1600)};

  document.querySelectorAll('[data-copy]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const value=btn.dataset.copy==='install-command'
        ? `irm ${location.origin}/install.ps1 | iex`
        : btn.dataset.copy;
      try{await navigator.clipboard.writeText(value);notify('Comando copiado');btn.textContent='Copiado ✓';setTimeout(()=>btn.textContent='Copiar',1500)}
      catch{notify('Não foi possível copiar')}
    });
  });

  document.querySelectorAll('[data-install-command]').forEach(el=>{
    el.textContent=`irm ${location.origin}/install.ps1 | iex`;
  });

  document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',e=>{
    const id=a.getAttribute('href');if(id.length>1){const t=document.querySelector(id);if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'})}}
  }));
})();
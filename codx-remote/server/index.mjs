import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { q, initDb } from './db.mjs';
import {
  now, token, sha, normalizeEmail, validEmail, passwordDigest, verifyPassword,
  monthKey, parseCookies, json, bearer, clip
} from './utils.mjs';

const PORT=Number(process.env.PORT||10000);
const SITE=(process.env.PUBLIC_SITE_URL||'https://codx-remote-zrider.vercel.app').replace(/\/$/,'');
const BACKEND=(process.env.PUBLIC_BACKEND_URL||'https://codx-remote-api-zrider.onrender.com').replace(/\/$/,'');
const MARKETING_SITE=(process.env.MARKETING_SITE_URL||'https://codx-remote.onrender.com').replace(/\/$/,'');
const RESOURCE=BACKEND+'/mcp';
const COOKIE='codx_session';
const SESSION_MS=30*24*60*60*1000;
const app=express();
const SERVER_DIR=path.dirname(fileURLToPath(import.meta.url));
const AGENT_FILE=path.resolve(SERVER_DIR,'../agent/agent.mjs');
const PUBLIC_DIR=path.join(SERVER_DIR,'public');

app.disable('x-powered-by');
app.use(express.json({limit:'6mb'}));
app.use(express.urlencoded({extended:false,limit:'1mb'}));
app.use('/assets',express.static(path.join(PUBLIC_DIR,'assets'),{etag:true,maxAge:'1h'}));
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  next();
});

async function createAccount(){
  const id=crypto.randomUUID(), accountSecret=token(), mcpKey=token(), manageKey=token();
  await q(`INSERT INTO accounts
    (id,account_secret_hash,mcp_key_hash,mcp_key,manage_key_hash,manage_key,usage_month,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,sha(accountSecret),sha(mcpKey),mcpKey,sha(manageKey),manageKey,monthKey(),now()]);
  return {account:await getAccount(id),accountSecret};
}
async function getAccount(id){
  return (await q('SELECT * FROM accounts WHERE id=$1',[id])).rows[0]||null;
}
async function accountBySecret(secret){
  if(!secret)return null;
  return (await q('SELECT * FROM accounts WHERE account_secret_hash=$1',[sha(secret)])).rows[0]||null;
}
async function accountByMcpKey(key){
  if(!key)return null;
  return (await q('SELECT * FROM accounts WHERE mcp_key_hash=$1',[sha(key)])).rows[0]||null;
}
async function accountByManageKey(key){
  if(!key)return null;
  return (await q('SELECT * FROM accounts WHERE manage_key_hash=$1',[sha(key)])).rows[0]||null;
}
async function accountByEmail(email){
  const e=normalizeEmail(email);
  if(!e)return null;
  return (await q('SELECT * FROM accounts WHERE email=$1',[e])).rows[0]||null;
}
async function normalizeUsage(account){
  const current=monthKey();
  if(account.usage_month!==current){
    await q('UPDATE accounts SET usage_month=$1,monthly_tool_calls=0 WHERE id=$2',[current,account.id]);
    account.usage_month=current; account.monthly_tool_calls=0;
  }
  return account;
}
async function setCredentials(account,name,email,password){
  const e=normalizeEmail(email);
  if(!validEmail(e)) throw new Error('invalid_email');
  if(String(password||'').length<10) throw new Error('password_too_short');
  const existing=await accountByEmail(e);
  if(existing && existing.id!==account.id) throw new Error('email_in_use');
  const p=passwordDigest(password);
  await q('UPDATE accounts SET name=$1,email=$2,password_salt=$3,password_hash=$4 WHERE id=$5',
    [String(name||e.split('@')[0]).slice(0,80),e,p.salt,p.hash,account.id]);
  return getAccount(account.id);
}
async function verifyLogin(email,password){
  const a=await accountByEmail(email);
  if(!a?.password_salt||!a?.password_hash)return null;
  return verifyPassword(password,a.password_salt,a.password_hash)?a:null;
}
async function createSession(req,res,accountId){
  const t=token(36), expires=now()+SESSION_MS;
  await q('INSERT INTO sessions(token_hash,account_id,expires_at,created_at) VALUES($1,$2,$3,$4)',
    [sha(t),accountId,expires,now()]);
  res.setHeader('Set-Cookie',COOKIE+'='+encodeURIComponent(t)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+Math.floor(SESSION_MS/1000));
}
async function sessionAccount(req){
  const t=parseCookies(req)[COOKIE];
  if(!t)return null;
  const s=(await q('SELECT * FROM sessions WHERE token_hash=$1',[sha(t)])).rows[0];
  if(!s||now()>Number(s.expires_at||0)){
    if(s)await q('DELETE FROM sessions WHERE token_hash=$1',[sha(t)]);
    return null;
  }
  return getAccount(s.account_id);
}
async function clearSession(req,res){
  const t=parseCookies(req)[COOKIE];
  if(t)await q('DELETE FROM sessions WHERE token_hash=$1',[sha(t)]);
  res.setHeader('Set-Cookie',COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
async function deviceById(id){
  return (await q('SELECT * FROM devices WHERE id=$1',[id])).rows[0]||null;
}
async function authDevice(req,id){
  const d=await deviceById(id);
  if(!d||d.revoked)return null;
  return sha(bearer(req))===d.secret_hash?d:null;
}
async function setupLink(accountId,deviceId){
  const t=token(32);
  await q('INSERT INTO setup_tokens(token_hash,account_id,device_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',
    [sha(t),accountId,deviceId,now()+30*60*1000,now()]);
  return BACKEND+'/setup?token='+encodeURIComponent(t);
}
async function listDevices(accountId){
  const rows=(await q('SELECT * FROM devices WHERE account_id=$1 ORDER BY created_at ASC',[accountId])).rows;
  return rows.map(d=>({
    deviceId:d.id,deviceName:d.device_name,
    online:!d.revoked && now()-Number(d.last_seen||0)<15000,
    lastSeen:Number(d.last_seen||0),revoked:!!d.revoked,toolCalls:Number(d.tool_calls||0)
  }));
}
async function accountForMcp(req){
  const bt=bearer(req);
  if(bt){
    const s=(await q('SELECT * FROM oauth_access WHERE token_hash=$1',[sha(bt)])).rows[0];
    if(s && now()<Number(s.expires_at||0) && s.resource===RESOURCE)return getAccount(s.account_id);
  }
  const key=String(req.query.key||'');
  if(key)return accountByMcpKey(key);
  return null;
}
function rpcResult(id,result){return {jsonrpc:'2.0',id,result}}
function rpcError(id,code,message){return {jsonrpc:'2.0',id:id??null,error:{code,message}}}

const MCP_TOOLS=[
  {name:'list_devices',description:'List Codx Remote devices and online/offline status.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'who_am_i',description:'Show Codx Remote account usage and device summary.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'system_info',description:'Read basic system information from the connected Windows PC.',inputSchema:{type:'object',properties:{deviceId:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'list_directory',description:'List files and folders in a directory on the connected PC.',inputSchema:{type:'object',properties:{path:{type:'string'},deviceId:{type:'string'}},required:['path'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'read_file',description:'Read a UTF-8 text file from the connected PC.',inputSchema:{type:'object',properties:{path:{type:'string'},maxChars:{type:'integer',minimum:1,maximum:250000,default:100000},deviceId:{type:'string'}},required:['path'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
  {name:'write_file',description:'Create, replace, or append UTF-8 text on the connected PC.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},append:{type:'boolean',default:false},deviceId:{type:'string'}},required:['path','content'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true}},
  {name:'run_powershell',description:'Run a PowerShell command on the connected PC and return stdout/stderr.',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'},deviceId:{type:'string'}},required:['command'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true}},
  {name:'list_processes',description:'List running processes on the connected PC.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:300,default:100},deviceId:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}
];

app.get('/agent/agent.mjs',async(_req,res)=>{
  try{
    const code=await fs.readFile(AGENT_FILE,'utf8');
    res.type('text/javascript; charset=utf-8').send(code);
  }catch(e){
    console.error(e);
    res.status(500).type('text/plain').send('Agent unavailable');
  }
});

app.get('/install.ps1',(_req,res)=>{
  const script=`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Join-Path $env:LOCALAPPDATA 'CodxRemote'
$Agent = Join-Path $Root 'agent.mjs'
$Backend = '${BACKEND}'
$AgentUrl = "$Backend/agent/agent.mjs"

function Ok($Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Step($Text) { Write-Host " - $Text" -ForegroundColor DarkGray }

Clear-Host
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                       CODX REMOTE" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Private Remote MCP for Windows" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $Root | Out-Null

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Step "Node.js nao encontrado. Instalando Node.js LTS..."
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw "winget nao encontrado. Instale Node.js LTS e tente novamente." }
    & winget.exe install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js foi instalado. Feche e abra o PowerShell e execute novamente." }
    Ok "Node.js instalado"
} else {
    Ok "Node.js encontrado"
}

Step "Configurando backend Codx Remote..."
[Environment]::SetEnvironmentVariable('CODX_REMOTE_URL',$Backend,'User')
$env:CODX_REMOTE_URL=$Backend
Ok "Backend configurado"

Step "Baixando o agente Codx Remote..."
Invoke-WebRequest -Uri $AgentUrl -OutFile $Agent -UseBasicParsing
if (-not (Test-Path $Agent)) { throw "Falha ao baixar o agente Codx Remote." }
Ok "Agente atualizado"

Write-Host ""
Write-Host "Iniciando Codx Remote..." -ForegroundColor Cyan
Write-Host "Mantenha esta janela aberta. Ctrl+C desconecta." -ForegroundColor DarkGray
Write-Host ""

& node.exe $Agent
`;
  res.type('text/plain; charset=utf-8').send(script);
});

app.get('/health',async(_req,res)=>{
  try{await q('SELECT 1');json(res,200,{ok:true,service:'codx-remote-backend',version:'0.7.1',storage:process.env.DATABASE_URL?'postgres':'memory',site:SITE})}
  catch(e){json(res,500,{ok:false,error:String(e.message||e)})}
});

app.get('/selftest',async(_req,res)=>{
  let account=null;
  try{
    const created=await createAccount();
    account=created.account;
    const deviceId=crypto.randomUUID();
    const deviceSecret=token(32);
    await q(`INSERT INTO devices(id,account_id,device_name,secret_hash,created_at,last_seen)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [deviceId,account.id,'CODX-SELFTEST',sha(deviceSecret),now(),now()]);
    const row=(await q('SELECT id,device_name FROM devices WHERE id=$1 AND account_id=$2',[deviceId,account.id])).rows[0];
    const ok=!!row && row.device_name==='CODX-SELFTEST';
    await q('DELETE FROM accounts WHERE id=$1',[account.id]);
    return json(res,ok?200:500,{ok,write:true,read:true,cleanup:true,version:'0.7.1'});
  }catch(e){
    if(account?.id){try{await q('DELETE FROM accounts WHERE id=$1',[account.id])}catch{}}
    console.error(e);
    return json(res,500,{ok:false,error:'selftest_failed'});
  }
});

app.post('/api/register',async(req,res)=>{
  try{
    const deviceName=String(req.body?.deviceName||'Windows PC').slice(0,120);
    let accountSecret=String(req.body?.accountSecret||'');
    let account=await accountBySecret(accountSecret);
    let createdAccount=false;
    if(!account){
      const created=await createAccount();
      account=created.account; accountSecret=created.accountSecret; createdAccount=true;
    }
    const deviceId=crypto.randomUUID(), deviceSecret=token(32);
    await q(`INSERT INTO devices(id,account_id,device_name,secret_hash,created_at,last_seen)
      VALUES($1,$2,$3,$4,$5,$6)`,[deviceId,account.id,deviceName,sha(deviceSecret),now(),now()]);
    const authorized=!!account.email;
    json(res,200,{
      ok:true,createdAccount,accountSecret,deviceId,deviceSecret,
      authorizeUrl:authorized?SITE+'/dashboard':await setupLink(account.id,deviceId),
      dashboardUrl:BACKEND+'/dashboard'
    });
  }catch(e){console.error(e);json(res,500,{error:'register_failed',detail:String(e.message||e)})}
});

app.post('/api/device',async(req,res)=>{
  try{
    const action=String(req.query.action||'');
    const deviceId=String(req.body?.deviceId||req.query.deviceId||'');
    const d=await authDevice(req,deviceId);
    if(!d)return json(res,401,{error:'unauthorized'});
    if(action==='heartbeat'){
      const account=await getAccount(d.account_id);
      const disconnect=!!d.disconnect_requested;
      await q('UPDATE devices SET last_seen=$1,disconnect_requested=FALSE WHERE id=$2',[now(),deviceId]);
      return json(res,200,{ok:true,revoked:false,disconnect,authorized:!!account?.email});
    }
    if(action==='setup_url'){
      const account=await getAccount(d.account_id);
      return json(res,200,{ok:true,authorized:!!account?.email,url:account?.email?BACKEND+'/dashboard':await setupLink(d.account_id,deviceId)});
    }
    if(action==='rotate_links'){
      const account=await getAccount(d.account_id);
      const mcp=token(32),manage=token(32);
      await q('UPDATE accounts SET mcp_key=$1,mcp_key_hash=$2,manage_key=$3,manage_key_hash=$4 WHERE id=$5',
        [mcp,sha(mcp),manage,sha(manage),account.id]);
      return json(res,200,{ok:true});
    }
    if(action==='poll'){
      await q('UPDATE devices SET last_seen=$1 WHERE id=$2',[now(),deviceId]);
      const cmd=(await q(`SELECT * FROM commands WHERE device_id=$1 AND
        (status='pending' OR (status='running' AND dispatched_at<$2))
        ORDER BY created_at ASC LIMIT 1`,[deviceId,now()-60000])).rows[0];
      if(!cmd)return json(res,200,{command:null});
      await q("UPDATE commands SET status='running',dispatched_at=$1 WHERE id=$2",[now(),cmd.id]);
      return json(res,200,{command:{commandId:cmd.id,deviceId,tool:cmd.tool,args:JSON.parse(cmd.args_json||'{}')}});
    }
    if(action==='result'){
      const commandId=String(req.body?.commandId||'');
      if(!commandId)return json(res,400,{error:'missing_command_id'});
      await q(`INSERT INTO results(command_id,device_id,ok,output,error,duration_ms,finished_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(command_id) DO UPDATE SET ok=EXCLUDED.ok,output=EXCLUDED.output,error=EXCLUDED.error,duration_ms=EXCLUDED.duration_ms,finished_at=EXCLUDED.finished_at`,
        [commandId,deviceId,!!req.body.ok,clip(req.body.output,250000),clip(req.body.error,50000),Number(req.body.durationMs||0),now()]);
      await q('DELETE FROM commands WHERE id=$1',[commandId]);
      await q('UPDATE devices SET tool_calls=tool_calls+1,last_seen=$1 WHERE id=$2',[now(),deviceId]);
      return json(res,200,{ok:true});
    }
    return json(res,400,{error:'unknown_action'});
  }catch(e){console.error(e);json(res,500,{error:'device_failed',detail:String(e.message||e)})}
});

app.all('/api/auth',async(req,res)=>{
  try{
    const action=String(req.query.action||'');
    if(action==='register' && req.method==='POST'){
      const body=req.body||{}, email=String(body.email||''),password=String(body.password||''),name=String(body.name||'').trim();
      if(await accountByEmail(email))return json(res,409,{error:'email_in_use'});
      let account;
      const st=String(body.setupToken||'');
      if(st){
        const setup=(await q('SELECT * FROM setup_tokens WHERE token_hash=$1',[sha(st)])).rows[0];
        if(!setup||now()>Number(setup.expires_at||0))return json(res,400,{error:'invalid_setup'});
        account=await getAccount(setup.account_id);
        await q('DELETE FROM setup_tokens WHERE token_hash=$1',[sha(st)]);
      }else account=(await createAccount()).account;
      account=await setCredentials(account,name,email,password);
      await createSession(req,res,account.id);
      return json(res,200,{ok:true,redirect:'/dashboard'});
    }
    if(action==='login' && req.method==='POST'){
      const a=await verifyLogin(req.body?.email,req.body?.password);
      if(!a)return json(res,401,{error:'invalid_credentials'});
      await createSession(req,res,a.id);
      return json(res,200,{ok:true,redirect:'/dashboard'});
    }
    if(action==='logout' && req.method==='POST'){
      await clearSession(req,res);return json(res,200,{ok:true});
    }
    if(action==='me'){
      let a=await sessionAccount(req);
      if(!a)return json(res,401,{error:'unauthorized'});
      a=await normalizeUsage(a);
      return json(res,200,{account:{
        accountId:a.id,name:a.name||a.email?.split('@')[0]||'Codx User',email:a.email,
        plan:a.plan,monthlyLimit:Number(a.monthly_limit),monthlyToolCalls:Number(a.monthly_tool_calls),
        totalToolCalls:Number(a.total_tool_calls)
      },devices:await listDevices(a.id)});
    }
    return json(res,400,{error:'unknown_action'});
  }catch(e){console.error(e);json(res,500,{error:'auth_failed',detail:String(e.message||e)})}
});

app.post('/api/dashboard-action',async(req,res)=>{
  try{
    const a=await sessionAccount(req);
    if(!a)return json(res,401,{error:'unauthorized'});
    const id=String(req.body?.deviceId||''),action=String(req.body?.action||'');
    const d=(await q('SELECT * FROM devices WHERE id=$1 AND account_id=$2',[id,a.id])).rows[0];
    if(!d)return json(res,404,{error:'device_not_found'});
    if(action==='disconnect'){
      await q('UPDATE devices SET disconnect_requested=TRUE WHERE id=$1',[id]);
      return json(res,200,{ok:true});
    }
    if(action==='revoke'){
      await q('UPDATE devices SET revoked=TRUE WHERE id=$1',[id]);
      return json(res,200,{ok:true});
    }
    if(action==='rename'){
      await q('UPDATE devices SET device_name=$1 WHERE id=$2',[String(req.body?.deviceName||d.device_name).slice(0,120),id]);
      return json(res,200,{ok:true});
    }
    return json(res,400,{error:'unknown_action'});
  }catch(e){console.error(e);json(res,500,{error:'dashboard_action_failed'})}
});


function page(title,body,navAction=''){
  const action=navAction||'<a class="nav-manage" href="/dashboard">Manage devices</a>';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080c13"><title>'+esc(title)+' — Codx Remote</title><link rel="icon" href="/assets/codx-logo.svg"><link rel="stylesheet" href="/assets/styles.css"></head><body><header class="site-nav"><div class="nav-inner"><a class="brand" href="'+MARKETING_SITE+'"><img class="brand-mark" src="/assets/codx-logo.svg" alt=""><span>Codx Remote</span></a><div class="nav-side">'+action+'</div></div></header>'+body+'<script src="/assets/app.js"></script></body></html>';
}

app.get('/setup',async(req,res)=>{
  const tokenValue=String(req.query.token||'');
  const setup=(await q('SELECT * FROM setup_tokens WHERE token_hash=$1',[sha(tokenValue)])).rows[0];
  if(!setup||now()>Number(setup.expires_at||0)){
    return res.status(400).type('html').send(page('Link expirado','<main class="auth-shell"><div class="auth-card"><span class="eyebrow">AUTORIZAÇÃO</span><h1>Link expirado</h1><p>Execute novamente o agente Codx Remote para gerar uma nova autorização.</p><a class="btn secondary" href="/install">Voltar para Install</a></div></main>'));
  }
  return res.type('html').send(page('Autorizar PC','<main class="auth-shell"><form class="auth-card" method="post" action="/setup"><span class="eyebrow"><span class="live-dot"></span> PC DETECTADO</span><h1>Autorize este computador</h1><p>Crie sua conta Codx Remote para vincular este PC e abrir o dashboard.</p><input type="hidden" name="token" value="'+esc(tokenValue)+'"><div class="field"><label>Nome</label><input name="name" autocomplete="name" required></div><div class="field"><label>E-mail</label><input type="email" name="email" autocomplete="email" required></div><div class="field"><label>Senha</label><input type="password" name="password" minlength="10" autocomplete="new-password" required></div><button class="btn" style="width:100%">Autorizar e abrir Dashboard</button><div class="auth-links">Este dispositivo será vinculado somente à sua conta.</div></form></main>','<a class="nav-manage" href="'+MARKETING_SITE+'">Site</a>'));
});

app.post('/setup',async(req,res)=>{
  try{
    const tokenValue=String(req.body?.token||'');
    const setup=(await q('SELECT * FROM setup_tokens WHERE token_hash=$1',[sha(tokenValue)])).rows[0];
    if(!setup||now()>Number(setup.expires_at||0))return res.status(400).send('Link expirado.');
    let account=await getAccount(setup.account_id);
    const existing=await accountByEmail(req.body?.email);
    if(existing&&existing.id!==account.id)return res.status(409).type('html').send(page('E-mail já cadastrado','<main class="auth"><div class="card"><h1>E-mail já cadastrado</h1><p class="muted">Use outro e-mail por enquanto ou entre na sua conta existente.</p><a class="btn" href="/login">Entrar</a></div></main>'));
    account=await setCredentials(account,req.body?.name,req.body?.email,req.body?.password);
    await q('DELETE FROM setup_tokens WHERE token_hash=$1',[sha(tokenValue)]);
    await createSession(req,res,account.id);
    return res.redirect(302,'/dashboard');
  }catch(e){
    console.error(e);
    return res.status(400).type('html').send(page('Erro','<main class="auth"><div class="card"><h1>Não foi possível autorizar</h1><p class="muted">'+esc(String(e.message||e))+'</p></div></main>'));
  }
});

app.get('/',(_req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.get('/install',(_req,res)=>res.sendFile(path.join(PUBLIC_DIR,'install.html')));

app.get('/register',(req,res)=>res.type('html').send(page('Criar conta','<main class="auth-shell"><form class="auth-card" method="post" action="/register"><span class="eyebrow"><span class="live-dot"></span> CONTA CODX REMOTE</span><h1>Criar conta</h1><p>Gerencie computadores, uso mensal e autorizações em um só lugar.</p><div class="field"><label>Nome</label><input name="name" autocomplete="name" required></div><div class="field"><label>E-mail</label><input type="email" name="email" autocomplete="email" required></div><div class="field"><label>Senha</label><input type="password" name="password" minlength="10" autocomplete="new-password" required></div><button class="btn" style="width:100%">Criar conta</button><div class="auth-links">Já tem conta? <a href="/login">Entrar</a></div></form></main>','<a class="nav-manage" href="/login">Entrar</a>')));

app.post('/register',async(req,res)=>{
  try{
    const email=String(req.body?.email||'');
    if(await accountByEmail(email)){
      return res.status(409).type('html').send(page('Conta existente','<main class="auth"><div class="card"><h1>Esse e-mail já está cadastrado</h1><p class="muted">Entre na sua conta para continuar.</p><a class="btn" href="/login">Entrar</a></div></main>'));
    }
    let account=(await createAccount()).account;
    account=await setCredentials(account,req.body?.name,email,req.body?.password);
    await createSession(req,res,account.id);
    return res.redirect(302,'/dashboard');
  }catch(e){
    console.error(e);
    return res.status(400).type('html').send(page('Erro ao criar conta','<main class="auth"><div class="card"><h1>Não foi possível criar a conta</h1><p class="muted">'+esc(String(e.message||e))+'</p><a class="btn" href="/register">Tentar novamente</a></div></main>'));
  }
});

app.get('/login',(req,res)=>res.type('html').send(page('Login','<main class="auth-shell"><form class="auth-card" method="post" action="/login"><span class="eyebrow">WELCOME BACK</span><h1>Entrar no Codx Remote</h1><p>Acesse seus dispositivos e continue de onde parou.</p><div class="field"><label>E-mail</label><input type="email" name="email" autocomplete="email" required></div><div class="field"><label>Senha</label><input type="password" name="password" autocomplete="current-password" required></div><button class="btn" style="width:100%">Entrar</button><div class="auth-links">Ainda não tem conta? <a href="/register">Criar conta</a></div></form></main>','<a class="nav-manage" href="/register">Criar conta</a>')));

app.post('/login',async(req,res)=>{
  const a=await verifyLogin(req.body?.email,req.body?.password);
  if(!a)return res.status(401).type('html').send(page('Login','<main class="auth"><div class="card"><h1>Login incorreto</h1><p class="muted">Confira e-mail e senha.</p><a class="btn" href="/login">Tentar novamente</a></div></main>'));
  await createSession(req,res,a.id);
  res.redirect(302,'/dashboard');
});

app.post('/logout',async(req,res)=>{await clearSession(req,res);res.redirect(302,'/login')});

app.get('/dashboard',async(req,res)=>{
  let a=await sessionAccount(req);
  if(!a)return res.redirect(302,'/login');
  a=await normalizeUsage(a);
  const devices=await listDevices(a.id);
  const pct=Math.min(100,Math.round(Number(a.monthly_tool_calls||0)/Math.max(1,Number(a.monthly_limit||500))*100));
  const rows=devices.map(d=>'<div class="device-card"><div><h3>'+esc(d.deviceName)+' <span class="'+(d.online?'status-online':'status-offline')+'">'+(d.online?'● Online':'○ Offline')+'</span></h3><div class="device-meta">ID: '+esc(d.deviceId)+'<br>Chamadas: '+d.toolCalls+' • Último sinal: '+(d.lastSeen?new Date(d.lastSeen).toLocaleString('pt-BR'):'-')+'</div></div><div class="device-actions">'+(d.revoked?'<span class="status-offline">Revogado</span>':'<form method="post" action="/dashboard/device" style="display:flex;gap:8px;flex-wrap:wrap"><input type="hidden" name="deviceId" value="'+esc(d.deviceId)+'"><button class="btn secondary small" name="action" value="disconnect">Desconectar</button><button class="btn danger small" name="action" value="revoke">Revogar</button></form>')+'</div></div>').join('');
  const body='<main class="container dashboard"><div class="dash-head"><div><span class="eyebrow"><span class="live-dot"></span> CONTA ATIVA</span><h1>Olá, '+esc(a.name||a.email?.split('@')[0]||'Codx User')+'</h1><div class="dash-meta">'+esc(a.email||'')+' • '+esc(a.plan||'Free')+'</div></div><form method="post" action="/logout"><button class="btn secondary small">Sair</button></form></div><div class="dash-grid"><section class="dash-card"><div class="dash-label">Uso mensal</div><div class="dash-value">'+Number(a.monthly_tool_calls||0)+' / '+Number(a.monthly_limit||500)+'</div><div class="usage-bar"><i style="width:'+pct+'%"></i></div></section><section class="dash-card"><div class="dash-label">Total histórico</div><div class="dash-value">'+Number(a.total_tool_calls||0)+'</div><div class="dash-meta">chamadas MCP</div></section></div><div class="devices-title"><div class="kicker">DEVICES</div><h2>Seus computadores</h2><p class="section-lead">Enquanto o agente estiver aberto, o dispositivo aparece como Online.</p></div><div class="device-list">'+(rows||'<div class="dash-card">Nenhum dispositivo conectado.</div>')+'</div></main>';
  res.type('html').send(page('Dashboard',body,'<a class="btn small" href="/install">+ Conectar PC</a>'));
});

app.post('/dashboard/device',async(req,res)=>{
  const a=await sessionAccount(req);
  if(!a)return res.redirect(302,'/login');
  const id=String(req.body?.deviceId||''),action=String(req.body?.action||'');
  const d=(await q('SELECT * FROM devices WHERE id=$1 AND account_id=$2',[id,a.id])).rows[0];
  if(d){
    if(action==='disconnect')await q('UPDATE devices SET disconnect_requested=TRUE WHERE id=$1',[id]);
    if(action==='revoke')await q('UPDATE devices SET revoked=TRUE WHERE id=$1',[id]);
  }
  res.redirect(302,'/dashboard');
});

app.get('/.well-known/oauth-protected-resource',(_req,res)=>json(res,200,{
  resource:RESOURCE,authorization_servers:[BACKEND],scopes_supported:['codx.remote'],
  bearer_methods_supported:['header'],resource_name:'Codx Remote'
}));
app.get('/.well-known/oauth-authorization-server',(_req,res)=>json(res,200,{
  issuer:BACKEND,authorization_endpoint:BACKEND+'/oauth/authorize',token_endpoint:BACKEND+'/oauth/token',
  registration_endpoint:BACKEND+'/oauth/register',response_types_supported:['code'],
  grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],
  token_endpoint_auth_methods_supported:['none'],scopes_supported:['codx.remote'],
  authorization_response_iss_parameter_supported:true
}));

app.post('/oauth/register',async(req,res)=>{
  try{
    const uris=Array.isArray(req.body?.redirect_uris)?req.body.redirect_uris.map(String):[];
    if(!uris.length)return json(res,400,{error:'invalid_client_metadata'});
    for(const uri of uris){
      const u=new URL(uri);
      const loopback=(u.protocol==='http:' && ['127.0.0.1','localhost','[::1]','::1'].includes(u.hostname));
      if(u.protocol!=='https:' && !loopback)return json(res,400,{error:'invalid_redirect_uri'});
    }
    const id=token(24);
    await q('INSERT INTO oauth_clients(client_id,redirect_uris_json,client_name,created_at) VALUES($1,$2,$3,$4)',
      [id,JSON.stringify(uris),String(req.body?.client_name||'MCP Client').slice(0,120),now()]);
    return json(res,201,{client_id:id,client_id_issued_at:Math.floor(now()/1000),redirect_uris:uris,
      client_name:String(req.body?.client_name||'MCP Client'),token_endpoint_auth_method:'none',
      grant_types:['authorization_code','refresh_token'],response_types:['code']});
  }catch(e){console.error(e);json(res,400,{error:'invalid_client_metadata'})}
});

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function validateAuthParams(p){
  const client=(await q('SELECT * FROM oauth_clients WHERE client_id=$1',[String(p.client_id||'')])).rows[0];
  if(!client)return {error:'invalid_client'};
  const uris=JSON.parse(client.redirect_uris_json||'[]'), redirect=String(p.redirect_uri||'');
  if(!uris.includes(redirect))return {error:'invalid_redirect_uri'};
  if(String(p.response_type||'')!=='code')return {error:'unsupported_response_type'};
  if(String(p.code_challenge_method||'')!=='S256'||!String(p.code_challenge||''))return {error:'invalid_request'};
  const resource=String(p.resource||RESOURCE);
  if(resource!==RESOURCE)return {error:'invalid_target'};
  return {client,redirect,resource,scope:String(p.scope||'codx.remote')};
}
function loginHtml(p,msg=''){
  const names=['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state','resource','scope'];
  const hidden=names.map(n=>'<input type="hidden" name="'+n+'" value="'+esc(p[n]||'')+'">').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codx Remote</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b12;color:#fff;font-family:system-ui}.c{width:min(92vw,430px);padding:28px;border:1px solid #293a55;border-radius:20px;background:#0f1726}.m{color:#91a0b5}input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;margin-top:10px}input{background:#090e17;border:1px solid #30405b;color:#fff}button{border:0;background:#3274f6;color:#fff;font-weight:700}.e{color:#ff9faf}</style></head><body><form class="c" method="post"><h1>Codx Remote</h1><p class="m">Autorize o ChatGPT a usar seus dispositivos Codx Remote.</p>'+ (msg?'<p class="e">'+esc(msg)+'</p>':'')+hidden+'<input type="email" name="email" placeholder="E-mail" required><input type="password" name="password" placeholder="Senha" required><button>Autorizar</button></form></body></html>';
}
app.all('/oauth/authorize',async(req,res)=>{
  try{
    const p=req.method==='POST'?req.body:req.query, v=await validateAuthParams(p);
    if(v.error)return res.status(400).type('text/plain').send(v.error);
    if(req.method==='GET')return res.type('html').send(loginHtml(p));
    const a=await verifyLogin(p.email,p.password);
    if(!a)return res.status(401).type('html').send(loginHtml(p,'E-mail ou senha incorretos.'));
    const code=token(32);
    await q(`INSERT INTO oauth_codes(code_hash,account_id,client_id,redirect_uri,code_challenge,resource,scope,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sha(code),a.id,String(p.client_id),v.redirect,String(p.code_challenge),v.resource,v.scope,now()+5*60*1000]);
    const target=new URL(v.redirect);target.searchParams.set('code',code);
    if(p.state)target.searchParams.set('state',String(p.state));
    target.searchParams.set('iss',BACKEND);
    res.redirect(302,target.toString());
  }catch(e){console.error(e);res.status(500).send('OAuth error')}
});
async function issueTokens(accountId,clientId,scope,resource){
  const at=token(32),rt=token(40),t=now();
  await Promise.all([
    q('INSERT INTO oauth_access(token_hash,account_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[sha(at),accountId,clientId,resource,scope,t+3600000]),
    q('INSERT INTO oauth_refresh(token_hash,account_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[sha(rt),accountId,clientId,resource,scope,t+30*24*3600000])
  ]);
  return {access_token:at,token_type:'Bearer',expires_in:3600,refresh_token:rt,scope};
}
app.post('/oauth/token',async(req,res)=>{
  try{
    const p=req.body||{},grant=String(p.grant_type||'');
    if(grant==='authorization_code'){
      const h=sha(String(p.code||'')),r=(await q('SELECT * FROM oauth_codes WHERE code_hash=$1',[h])).rows[0];
      if(!r||now()>Number(r.expires_at))return json(res,400,{error:'invalid_grant'});
      if(String(p.client_id||'')!==r.client_id||String(p.redirect_uri||'')!==r.redirect_uri)return json(res,400,{error:'invalid_grant'});
      const check=crypto.createHash('sha256').update(String(p.code_verifier||'')).digest('base64url');
      if(check!==r.code_challenge)return json(res,400,{error:'invalid_grant'});
      await q('DELETE FROM oauth_codes WHERE code_hash=$1',[h]);
      return json(res,200,await issueTokens(r.account_id,r.client_id,r.scope,r.resource));
    }
    if(grant==='refresh_token'){
      const h=sha(String(p.refresh_token||'')),r=(await q('SELECT * FROM oauth_refresh WHERE token_hash=$1',[h])).rows[0];
      if(!r||now()>Number(r.expires_at)||String(p.client_id||'')!==r.client_id)return json(res,400,{error:'invalid_grant'});
      await q('DELETE FROM oauth_refresh WHERE token_hash=$1',[h]);
      return json(res,200,await issueTokens(r.account_id,r.client_id,r.scope,r.resource));
    }
    return json(res,400,{error:'unsupported_grant_type'});
  }catch(e){console.error(e);json(res,500,{error:'token_error'})}
});

async function mcpHandler(req,res){
  try{
    const account=await accountForMcp(req);
    if(!account){
      res.setHeader('WWW-Authenticate','Bearer resource_metadata="'+BACKEND+'/.well-known/oauth-protected-resource", scope="codx.remote"');
      return json(res,401,rpcError(req.body?.id,-32001,'Codx Remote authentication required.'));
    }
    await normalizeUsage(account);
    if(req.method==='GET')return json(res,200,{name:'Codx Remote MCP',status:'ready',version:'0.7.1'});
    const msg=req.body||{};
    if(msg.method==='notifications/initialized')return json(res,204,null);
    if(msg.method==='initialize')return json(res,200,rpcResult(msg.id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'Codx Remote',version:'0.7.1'}}));
    if(msg.method==='ping')return json(res,200,rpcResult(msg.id,{}));
    if(msg.method==='tools/list')return json(res,200,rpcResult(msg.id,{tools:MCP_TOOLS}));
    if(msg.method!=='tools/call')return json(res,200,rpcError(msg.id,-32601,'Method not found'));
    const name=String(msg.params?.name||''),args={...(msg.params?.arguments||{})};
    if(name==='list_devices')return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:JSON.stringify(await listDevices(account.id),null,2)}]}));
    if(name==='who_am_i')return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:JSON.stringify({accountId:account.id,plan:account.plan,monthlyLimit:Number(account.monthly_limit),monthlyToolCalls:Number(account.monthly_tool_calls),totalToolCalls:Number(account.total_tool_calls),devices:await listDevices(account.id)},null,2)}]}));
    if(Number(account.monthly_tool_calls)>=Number(account.monthly_limit))return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:'Monthly Codx Remote usage limit reached.'}],isError:true}));
    const requested=String(args.deviceId||'');delete args.deviceId;
    const devices=(await listDevices(account.id)).filter(d=>d.online);
    const device=requested?devices.find(d=>d.deviceId===requested):(devices.length===1?devices[0]:null);
    if(!device)return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:devices.length?'More than one device is online. Pass deviceId.':'No Codx Remote device is online.'}],isError:true}));
    if(!MCP_TOOLS.some(t=>t.name===name))return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:'Unknown tool: '+name}],isError:true}));
    const id=crypto.randomUUID();
    await q('INSERT INTO commands(id,device_id,tool,args_json,status,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id,device.deviceId,name,JSON.stringify(args),'pending',now()]);
    const deadline=now()+50000;
    while(now()<deadline){
      const rr=(await q('SELECT * FROM results WHERE command_id=$1',[id])).rows[0];
      if(rr){
        await q('DELETE FROM results WHERE command_id=$1',[id]);
        await q('UPDATE accounts SET total_tool_calls=total_tool_calls+1,monthly_tool_calls=monthly_tool_calls+1 WHERE id=$1',[account.id]);
        return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:rr.ok?(rr.output||'(no output)'):(rr.error||'Command failed.')}],isError:!rr.ok}));
      }
      await new Promise(r=>setTimeout(r,650));
    }
    await q('DELETE FROM commands WHERE id=$1',[id]);
    return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:'Timed out waiting for the connected PC.'}],isError:true}));
  }catch(e){console.error(e);json(res,500,rpcError(req.body?.id,-32000,'Codx Remote backend error'))}
}

app.all('/mcp',mcpHandler);
app.all('/api/mcp',mcpHandler);

await initDb();
app.listen(PORT,'0.0.0.0',()=>console.log('Codx Remote backend 0.7.1 listening on',PORT));

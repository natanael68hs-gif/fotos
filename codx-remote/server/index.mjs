import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { q, initDb, pool } from './db.mjs';
import { runRequestedAccountReset } from './account-reset.mjs';
import { dashboardHtml, dashboardData, connectionFor, createMcpSession, activity } from './dashboard.mjs';
import { ACTIVITY_URI, ACTIVITY_META, activityResource } from './activity-widget.mjs';
import {
  now, token, sha, normalizeEmail, validEmail, passwordDigest, verifyPassword,
  monthKey, parseCookies, json, bearer, clip
} from './utils.mjs';

const PORT=Number(process.env.PORT||10000);
const SITE=(process.env.PUBLIC_SITE_URL||'https://codx-remote.onrender.com').replace(/\/$/,'');
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
    // Personal MCP keys are sent automatically by clients, without OAuth prompts.
    return accountByMcpKey(bt);
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

MCP_TOOLS.push({name:'show_activity',title:'Atividade Codx Remote',description:'Show the live, branded Codx Remote activity card with online devices and running remote operations. Use when the user wants to monitor computer work. Read-only and does not consume remote quota.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false},_meta:ACTIVITY_META});
const CODX_OAUTH=[{type:'oauth2',scopes:['codx.remote']}];
for(const tool of MCP_TOOLS){
  // Account summaries stay within this service; remote tools reach the user's PC.
  tool.annotations.openWorldHint=!['list_devices','who_am_i','show_activity'].includes(tool.name);
  tool.icons=[{src:BACKEND+'/assets/codx-symbol.png',mimeType:'image/png'}];
  tool.securitySchemes=CODX_OAUTH;
  tool._meta={...tool._meta,securitySchemes:CODX_OAUTH,'openai/toolInvocation/invoking':'Codx Remote · '+(tool.name==='run_powershell'?'Executando no computador…':'Consultando seu computador…'),'openai/toolInvocation/invoked':'Codx Remote · Concluído'};
}
async function activitySnapshot(accountId){
  const devices=await listDevices(accountId);
  const activeTools=(await q('SELECT c.device_id,c.tool,c.status FROM commands c JOIN devices d ON c.device_id=d.id WHERE d.account_id=$1',[accountId])).rows.map(c=>({deviceId:c.device_id,tool:c.tool,status:c.status}));
  return {devices,activeTools,updatedAt:now()};
}

app.get('/agent/agent.mjs',async(_req,res)=>{
  try{
    const code=await fs.readFile(AGENT_FILE,'utf8');
    res.type('text/javascript; charset=utf-8').send(code);
  }catch(e){
    console.error(e);
    res.status(500).type('text/plain').send('Agent unavailable');
  }
});

app.get('/install.ps1',(_req,res)=>res.type('text/plain; charset=utf-8').sendFile(path.join(PUBLIC_DIR,'install.ps1')));

app.get('/health',async(_req,res)=>{
  try{await q('SELECT 1');json(res,200,{ok:true,service:'codx-remote-backend',version:'0.9.5',storage:process.env.DATABASE_URL?'postgres':'memory',site:SITE})}
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
    return json(res,ok?200:500,{ok,write:true,read:true,cleanup:true,version:'0.9.5'});
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
    if(action==='mcp_config'){
      const account=await getAccount(d.account_id);
      if(!account?.email)return json(res,403,{error:'account_authorization_pending'});
      return json(res,200,{ok:true,config:{mcpServers:{codxRemote:{
        type:'http',url:RESOURCE,headers:{Authorization:'Bearer '+account.mcp_key}
      }}}});
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
    if(![BACKEND,SITE].includes(req.get('origin')))return json(res,403,{error:'invalid_origin'});
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
  const action=navAction||'<a class="nav-manage" href="/dashboard">Meus dispositivos</a>';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080c13"><title>'+esc(title)+' — Codx Remote</title><link rel="icon" href="/assets/codx-symbol.png"><link rel="stylesheet" href="/assets/redesign.css?v=0.9.0"></head><body><header class="site-nav"><div class="nav-inner"><a class="brand" href="'+MARKETING_SITE+'"><img class="brand-mark" src="/assets/codx-symbol.png" alt=""><img class="brand-name" src="/assets/codx-wordmark.png" alt="Codx Remote"></a><div class="nav-side">'+action+'</div></div></header>'+body+'<script src="/assets/redesign.js?v=0.9.0" type="module"></script></body></html>';
}

function pairingConsent(req,setupToken){
  return crypto.createHmac('sha256',parseCookies(req)[COOKIE]||'').update('pair-device:'+setupToken).digest('hex');
}
app.get('/setup',async(req,res)=>{
  const tokenValue=String(req.query.token||'');
  const setup=(await q('SELECT * FROM setup_tokens WHERE token_hash=$1',[sha(tokenValue)])).rows[0];
  if(!setup||now()>Number(setup.expires_at||0)){
    return res.status(400).type('html').send(page('Link expirado','<main class="auth-shell"><div class="auth-card"><span class="eyebrow">AUTORIZAÇÃO</span><h1>Link expirado</h1><p>Execute novamente o agente Codx Remote para gerar uma nova autorização.</p><a class="btn secondary" href="/install">Voltar para Install</a></div></main>'));
  }
  const signedIn=await sessionAccount(req);
  if(signedIn){
    const device=await deviceById(setup.device_id);
    return res.type('html').send(page('Vincular computador','<main class="auth-shell"><form class="auth-card" method="post" action="/setup"><span class="eyebrow"><span class="live-dot"></span> PC DETECTADO</span><h1>Vincule este computador.</h1><p><strong>'+esc(device?.device_name||'Seu desktop')+'</strong> ficará disponível para os assistentes conectados à sua conta.</p><p class="setting-help">Conta: '+esc(signedIn.email||signedIn.name||'Codx Remote')+'</p><input type="hidden" name="action" value="pair"><input type="hidden" name="token" value="'+esc(tokenValue)+'"><input type="hidden" name="pairing_consent" value="'+pairingConsent(req,tokenValue)+'"><button class="btn" style="width:100%">Vincular este computador</button></form></main>'));
  }
  const loginLink='/login?next='+encodeURIComponent('/setup?token='+encodeURIComponent(tokenValue));
  return res.type('html').send(page('Autorizar PC','<main class="auth-shell"><form class="auth-card" method="post" action="/setup"><span class="eyebrow"><span class="live-dot"></span> PC DETECTADO</span><h1>Autorize este computador</h1><p>Crie sua conta Codx Remote para vincular este PC e abrir o dashboard.</p><a class="btn secondary" style="width:100%;margin-bottom:20px" href="'+esc(loginLink)+'">Já tenho conta — vincular computador</a><input type="hidden" name="token" value="'+esc(tokenValue)+'"><div class="field"><label for="name">Nome</label><input id="name" name="name" autocomplete="name" required></div><div class="field"><label for="email">E-mail</label><input id="email" type="email" name="email" autocomplete="email" required></div><div class="field"><label for="password">Senha</label><input id="password" type="password" name="password" minlength="10" autocomplete="new-password" required></div><button class="btn" style="width:100%">Autorizar e abrir Dashboard</button><div class="auth-links">Este dispositivo será vinculado somente à sua conta.</div></form></main>','<a class="nav-manage" href="'+MARKETING_SITE+'">Site</a>'));
});

app.post('/setup',async(req,res)=>{
  try{
    const tokenValue=String(req.body?.token||'');
    const setup=(await q('SELECT * FROM setup_tokens WHERE token_hash=$1',[sha(tokenValue)])).rows[0];
    if(!setup||now()>Number(setup.expires_at||0))return res.status(400).send('Link expirado.');
    let account=await getAccount(setup.account_id);
    if(req.body?.action==='pair'){
      const target=await sessionAccount(req);
      if(!target)return res.status(401).send('Entre na sua conta para vincular o computador.');
      if(req.get('origin')!==BACKEND||String(req.body?.pairing_consent||'')!==pairingConsent(req,tokenValue))return res.status(403).send('invalid_consent');
      if(!account||account.email||!setup.device_id)return res.status(403).send('Este computador já possui uma conta.');
      const sourceId=account.id;
      const used=await q('DELETE FROM setup_tokens WHERE token_hash=$1 RETURNING token_hash',[sha(tokenValue)]);
      if(!used.rows.length)return res.status(400).send('Link já utilizado.');
      const paired=await q('UPDATE devices SET account_id=$1 WHERE id=$2 AND account_id=$3 AND revoked=FALSE RETURNING id',[target.id,setup.device_id,sourceId]);
      if(!paired.rows.length)return res.status(400).send('Computador indisponível.');
      if(!(await q('SELECT id FROM devices WHERE account_id=$1',[sourceId])).rows.length)await q('DELETE FROM accounts WHERE id=$1',[sourceId]);
      return res.redirect(303,'/dashboard');
    }
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
for(const route of ['privacy','terms'])app.get('/'+route,(_req,res)=>res.sendFile(path.join(PUBLIC_DIR,route,'index.html')));

app.get('/register',(req,res)=>res.type('html').send(page('Criar conta','<main class="auth-shell"><form class="auth-card" method="post" action="/register"><span class="eyebrow"><span class="live-dot"></span> CONTA CODX REMOTE</span><h1>Criar conta</h1><p>Gerencie computadores, uso mensal e autorizações em um só lugar.</p><div class="field"><label for="name">Nome</label><input id="name" name="name" autocomplete="name" required></div><div class="field"><label for="email">E-mail</label><input id="email" type="email" name="email" autocomplete="email" required></div><div class="field"><label for="password">Senha</label><input id="password" type="password" name="password" minlength="10" autocomplete="new-password" required></div><button class="btn" style="width:100%">Criar conta</button><div class="auth-links">Já tem conta? <a href="/login">Entrar</a></div></form></main>','<a class="nav-manage" href="/login">Entrar</a>')));

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

function authorizationReturn(value){
  if(typeof value!=='string'||!['/oauth/authorize?','/setup?'].some(prefix=>value.startsWith(prefix))||value.includes('\\'))return '/dashboard';
  const url=new URL(value,BACKEND);
  return url.origin===BACKEND&&['/oauth/authorize','/setup'].includes(url.pathname)&&!url.hash?url.pathname+url.search:'/dashboard';
}
app.get('/login',async(req,res)=>{
  const next=authorizationReturn(req.query.next);
  if(next!=='/dashboard'&&await sessionAccount(req))return res.redirect(303,next);
  return res.type('html').send(page('Login','<main class="auth-shell"><form class="auth-card" method="post" action="/login"><input type="hidden" name="next" value="'+esc(next)+'"><span class="eyebrow">BEM-VINDO DE VOLTA</span><h1>Entrar no Codx Remote</h1><p>Acesse seus dispositivos e continue de onde parou.</p><div class="field"><label for="email">E-mail</label><input id="email" type="email" name="email" autocomplete="email" required></div><div class="field"><label for="password">Senha</label><input id="password" type="password" name="password" autocomplete="current-password" required></div><button class="btn" style="width:100%">Entrar</button><div class="auth-links">Ainda não tem conta? <a href="/register">Criar conta</a></div></form></main>','<a class="nav-manage" href="/register">Criar conta</a>'));
});

app.post('/login',async(req,res)=>{
  const next=authorizationReturn(req.body?.next);
  const a=await verifyLogin(req.body?.email,req.body?.password);
  if(!a)return res.status(401).type('html').send(page('Login','<main class="auth"><div class="card"><h1>Login incorreto</h1><p class="muted">Confira e-mail e senha.</p><a class="btn" href="/login?next='+esc(encodeURIComponent(next))+'">Tentar novamente</a></div></main>'));
  await createSession(req,res,a.id);
  res.redirect(303,next);
});

app.post('/logout',async(req,res)=>{await clearSession(req,res);res.redirect(302,'/login')});

app.get('/dashboard/mcp-config',async(req,res)=>{
  const a=await sessionAccount(req);
  if(!a)return json(res,401,{error:'unauthorized'});
  if(req.query.format==='toml'){
    res.setHeader('Content-Disposition','attachment; filename="codx-remote-config.toml"');
    return res.type('text/plain').send('[mcp_servers.codxRemotePersonal]\nurl = '+JSON.stringify(RESOURCE)+
      '\nhttp_headers = { Authorization = '+JSON.stringify('Bearer '+a.mcp_key)+' }\n');
  }
  res.setHeader('Content-Disposition','attachment; filename="codx-remote-mcp.json"');
  return json(res,200,{mcpServers:{codxRemote:{
    type:'http',url:RESOURCE,headers:{Authorization:'Bearer '+a.mcp_key}
  }}});
});

app.post('/dashboard/mcp-key/rotate',async(req,res)=>{
  const a=await sessionAccount(req);
  if(!a)return json(res,401,{error:'unauthorized'});
  // Browsers send Origin for POST; reject requests from other sites.
  if(![BACKEND,SITE].includes(req.get('origin')))return json(res,403,{error:'invalid_origin'});
  const key=token(32);
  await q('UPDATE accounts SET mcp_key=$1,mcp_key_hash=$2 WHERE id=$3',[key,sha(key),a.id]);
  return res.redirect(303,'/dashboard');
});

app.get('/dashboard',async(req,res)=>{
  let a=await sessionAccount(req);
  if(!a)return res.redirect(302,'/login');
  a=await normalizeUsage(a);
  const data=await dashboardData(a,await listDevices(a.id));
  return res.type('html').send(dashboardHtml(data,{marketing:MARKETING_SITE,backend:BACKEND,resource:RESOURCE}));
});
app.get('/api/dashboard',async(req,res)=>{
  let a=await sessionAccount(req);if(!a)return json(res,401,{error:'unauthorized'});
  a=await normalizeUsage(a);
  return json(res,200,await dashboardData(a,await listDevices(a.id)));
});
app.get('/api/dashboard/usage.csv',async(req,res)=>{
  const a=await sessionAccount(req);if(!a)return json(res,401,{error:'unauthorized'});
  const rows=(await q('SELECT tool,status,duration_ms,created_at FROM usage_events WHERE account_id=$1 AND created_at>$2 ORDER BY created_at DESC',[a.id,now()-30*24*3600000])).rows;
  res.setHeader('Content-Disposition','attachment; filename="codx-remote-usage.csv"');
  const csvValue=v=>'"'+String(v).replace(/"/g,'""')+'"';
  return res.type('text/csv; charset=utf-8').send('date,tool,status,duration_ms\r\n'+rows.map(r=>[new Date(Number(r.created_at)).toISOString(),r.tool,r.status,r.duration_ms].map(csvValue).join(',')).join('\r\n'));
});
app.post('/api/dashboard/settings',async(req,res)=>{
  const a=await sessionAccount(req);if(!a)return json(res,401,{error:'unauthorized'});
  if(![BACKEND,SITE].includes(req.get('origin')))return json(res,403,{error:'invalid_origin'});
  const p=req.body||{};
  if(p.action==='profile'){
    const name=String(p.name||'').trim().slice(0,80);if(!name)return json(res,400,{error:'invalid_name'});
    await q('UPDATE accounts SET name=$1 WHERE id=$2',[name,a.id]);
  }else if(p.action==='preferences'){
    await q('INSERT INTO account_preferences(account_id,settings_json) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET settings_json=EXCLUDED.settings_json',[a.id,JSON.stringify({animations:p.animations!==false,autoRefresh:p.autoRefresh!==false})]);
  }else if(p.action==='password'){
    if(!await verifyLogin(a.email,p.currentPassword))return json(res,403,{error:'invalid_credentials'});
    if(String(p.newPassword||'').length<10)return json(res,400,{error:'password_too_short'});
    const digest=passwordDigest(p.newPassword);
    await q('UPDATE accounts SET password_salt=$1,password_hash=$2 WHERE id=$3',[digest.salt,digest.hash,a.id]);
    const current=sha(parseCookies(req)[COOKIE]||'');
    await q('DELETE FROM sessions WHERE account_id=$1 AND token_hash<>$2',[a.id,current]);
  }else if(p.action==='revoke_client'){
    const c=(await q('SELECT * FROM client_connections WHERE id=$1 AND account_id=$2',[String(p.connectionId||''),a.id])).rows[0];
    if(!c||c.auth_method!=='oauth')return json(res,404,{error:'connection_not_found'});
    await q('DELETE FROM oauth_refresh WHERE account_id=$1 AND client_id=$2',[a.id,c.oauth_client_id]);
    await q('DELETE FROM oauth_access WHERE account_id=$1 AND client_id=$2',[a.id,c.oauth_client_id]);
  }else return json(res,400,{error:'unknown_action'});
  return json(res,200,{ok:true});
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

app.get('/.well-known/openai-apps-challenge',(_req,res)=>{
  const challenge=String(process.env.OPENAI_APPS_CHALLENGE||'').trim();
  if(!challenge)return res.status(404).type('text/plain').send('not configured');
  res.setHeader('Cache-Control','no-store');
  return res.status(200).type('text/plain; charset=utf-8').send(challenge);
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
function authorizationPath(p){
  const names=['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state','resource','scope'];
  return '/oauth/authorize?'+new URLSearchParams(names.map(n=>[n,String(p[n]||'')])).toString();
}
function consentHtml(account,client,ticket){
  return page('Autorizar conexão','<main class="auth-shell"><form class="auth-card" method="post" action="/oauth/authorize"><span class="eyebrow"><span class="live-dot"></span> SUA CONTA, CONECTADA</span><h1>Seu assistente, conectado.</h1><p><strong>'+esc(client.client_name||'Cliente MCP')+'</strong> solicita acesso aos computadores da sua conta.</p><div class="setting-help" style="padding:18px 0"><strong>'+esc(account.name||'Sua conta Codx Remote')+'</strong><br>'+esc(account.email||'Conta vinculada ao seu computador')+'</div><p>Você permite consultar e editar arquivos, executar comandos e gerenciar processos nos seus dispositivos autorizados.</p><input type="hidden" name="consent_ticket" value="'+esc(ticket)+'"><button class="btn" style="width:100%" type="submit">Autorizar conexão</button><p class="setting-help">A conexão usa automaticamente sua sessão salva. Você pode revogar o acesso no dashboard.</p></form></main>');
}
function authorizationHeaders(res,registeredRedirect){
  // Keep form protection; OAuth may return only to this request's registered client.
  const callback=registeredRedirect?' '+new URL(registeredRedirect).origin:'';
  res.setHeader('Content-Security-Policy',"frame-ancestors 'none'; form-action 'self'"+callback);
  res.setHeader('X-Frame-Options','DENY');
}
app.get('/oauth/authorize',async(req,res)=>{
  try{
    authorizationHeaders(res);
    const p=req.query,v=await validateAuthParams(p);
    if(v.error)return res.status(400).type('text/plain').send(v.error);
    authorizationHeaders(res,v.redirect);
    const a=await sessionAccount(req);
    if(!a)return res.type('html').send(page('Conectar sua conta','<main class="auth-shell"><div class="auth-card"><span class="eyebrow">CONECTAR CODX REMOTE</span><h1>Conecte sua conta.</h1><p>Entre uma vez no Codx Remote. Depois, basta clicar em Autorizar conexão para usar seus computadores neste assistente.</p><a class="btn" style="width:100%" href="/login?next='+esc(encodeURIComponent(authorizationPath(p)))+'">Entrar para autorizar</a></div></main>'));
    await q('DELETE FROM oauth_consents WHERE expires_at<$1',[now()]);
    const ticket=token(32);
    await q('INSERT INTO oauth_consents(token_hash,account_id,session_hash,request_json,expires_at) VALUES($1,$2,$3,$4,$5)',
      [sha(ticket),a.id,sha(parseCookies(req)[COOKIE]),JSON.stringify(Object.fromEntries(new URLSearchParams(authorizationPath(p).split('?')[1]))),now()+10*60*1000]);
    return res.type('html').send(consentHtml(a,v.client,ticket));
  }catch(e){console.error(e);res.status(500).send('OAuth error')}
});
app.post('/oauth/authorize',async(req,res)=>{
  try{
    authorizationHeaders(res);
    const a=await sessionAccount(req);
    if(!a)return res.status(401).type('text/plain').send('Sua sessão expirou. Abra novamente a conexão no assistente.');
    if(req.get('origin')!==BACKEND)return res.status(403).type('text/plain').send('invalid_origin');
    const hash=sha(String(req.body?.consent_ticket||''));
    const consent=(await q('SELECT * FROM oauth_consents WHERE token_hash=$1',[hash])).rows[0];
    if(!consent||now()>Number(consent.expires_at)||consent.account_id!==a.id||consent.session_hash!==sha(parseCookies(req)[COOKIE]))return res.status(403).type('text/plain').send('Autorização expirada. Abra novamente a conexão no assistente.');
    const p=JSON.parse(consent.request_json),v=await validateAuthParams(p);
    if(v.error)return res.status(400).type('text/plain').send(v.error);
    authorizationHeaders(res,v.redirect);
    // Consume the session-bound consent once; parameters always come from the server.
    const used=await q('DELETE FROM oauth_consents WHERE token_hash=$1 RETURNING token_hash',[hash]);
    if(!used.rows.length)return res.status(403).type('text/plain').send('Autorização já utilizada.');
    const code=token(32);
    await q(`INSERT INTO oauth_codes(code_hash,account_id,client_id,redirect_uri,code_challenge,resource,scope,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sha(code),a.id,String(p.client_id),v.redirect,String(p.code_challenge),v.resource,v.scope,now()+5*60*1000]);
    const target=new URL(v.redirect);target.searchParams.set('code',code);
    if(p.state)target.searchParams.set('state',String(p.state));
    target.searchParams.set('iss',BACKEND);
    res.redirect(303,target.toString());
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
    if(account)await normalizeUsage(account);
    if(req.method==='GET'){
      res.setHeader('Allow','POST');
      return json(res,405,rpcError(null,-32600,'GET is not used by this Streamable HTTP endpoint.'));
    }
    const msg=req.body||{};
    if(msg.method==='notifications/initialized'){
      res.status(202).end();
      return;
    }
    if(msg.method==='initialize'){
      const requested=String(msg.params?.protocolVersion||'');
      const legacy=['2025-11-25','2025-06-18','2025-03-26'];
      const protocolVersion=legacy.includes(requested)?requested:'2025-11-25';
      if(account){
        const connectionId=await connectionFor(req,account,msg.params?.clientInfo||{name:'Cliente MCP'});
        res.setHeader('Mcp-Session-Id',await createMcpSession(account.id,connectionId));
      }
      return json(res,200,rpcResult(msg.id,{protocolVersion,capabilities:{tools:{listChanged:false},resources:{listChanged:false}},serverInfo:{name:'Codx Remote',version:'0.9.5',icons:[{src:BACKEND+'/assets/codx-symbol.png',mimeType:'image/png'}]}}));
    }
    if(account)await connectionFor(req,account);
    if(msg.method==='resources/list')return json(res,200,rpcResult(msg.id,{resources:[{uri:ACTIVITY_URI,name:'Codx Remote Activity',mimeType:'text/html;profile=mcp-app'}]}));
    if(msg.method==='resources/read')return json(res,200,msg.params?.uri===ACTIVITY_URI?rpcResult(msg.id,{contents:[activityResource(BACKEND)]}):rpcError(msg.id,-32002,'Resource not found'));

    if(msg.method==='ping')return json(res,200,rpcResult(msg.id,{}));
    if(msg.method==='tools/list')return json(res,200,rpcResult(msg.id,{tools:MCP_TOOLS}));
    if(msg.method!=='tools/call')return json(res,200,rpcError(msg.id,-32601,'Method not found'));
    if(!account){
      const challenge='Bearer resource_metadata="'+BACKEND+'/.well-known/oauth-protected-resource", scope="codx.remote", error="invalid_token", error_description="Connect your Codx Remote account to continue"';
      res.setHeader('WWW-Authenticate',challenge);
      return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:'Authentication required. Connect your Codx Remote account to continue.'}],_meta:{'mcp/www_authenticate':[challenge]},isError:true}));
    }
    const name=String(msg.params?.name||''),args={...(msg.params?.arguments||{})};
    if(name==='show_activity'){const snapshot=await activitySnapshot(account.id);return json(res,200,rpcResult(msg.id,{structuredContent:snapshot,content:[{type:'text',text:JSON.stringify(snapshot)}]}))}
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
        await activity(account.id,device.deviceId,name,rr.ok?'success':'failed',rr.duration_ms);
        return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:rr.ok?(rr.output||'(no output)'):(rr.error||'Command failed.')}],isError:!rr.ok}));
      }
      await new Promise(r=>setTimeout(r,650));
    }
    await q('DELETE FROM commands WHERE id=$1',[id]);
    await activity(account.id,device.deviceId,name,'timeout',50000);
    return json(res,200,rpcResult(msg.id,{content:[{type:'text',text:'Timed out waiting for the connected PC.'}],isError:true}));
  }catch(e){console.error(e);json(res,500,rpcError(req.body?.id,-32000,'Codx Remote backend error'))}
}

app.all('/mcp',mcpHandler);
app.all('/api/mcp',mcpHandler);
app.use((req,res)=>{if(req.method==='GET'&&req.accepts('html'))return res.status(404).sendFile(path.join(PUBLIC_DIR,'404.html'));return json(res,404,{error:'not_found'})});

await initDb();
await runRequestedAccountReset(pool);
export const server=app.listen(PORT,'0.0.0.0',()=>console.log('Codx Remote backend listening on',server.address().port));

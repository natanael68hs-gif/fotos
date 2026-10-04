import express from 'express';
import crypto from 'node:crypto';
import { q, initDb } from './db.mjs';
import {
  now, token, sha, normalizeEmail, validEmail, passwordDigest, verifyPassword,
  monthKey, parseCookies, json, bearer, clip
} from './utils.mjs';

const PORT=Number(process.env.PORT||10000);
const SITE=(process.env.PUBLIC_SITE_URL||'https://codx-remote-zrider.vercel.app').replace(/\/$/,'');
const RESOURCE=SITE+'/api/mcp';
const COOKIE='codx_session';
const SESSION_MS=30*24*60*60*1000;
const app=express();

app.disable('x-powered-by');
app.use(express.json({limit:'6mb'}));
app.use(express.urlencoded({extended:false,limit:'1mb'}));
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
  return SITE+'/authorize?setup='+encodeURIComponent(t);
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

app.get('/health',async(_req,res)=>{
  try{await q('SELECT 1');json(res,200,{ok:true,service:'codx-remote-backend',version:'0.5.0',site:SITE})}
  catch(e){json(res,500,{ok:false,error:String(e.message||e)})}
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
      dashboardUrl:SITE+'/dashboard'
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
      return json(res,200,{ok:true,authorized:!!account?.email,url:account?.email?SITE+'/dashboard':await setupLink(d.account_id,deviceId)});
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

app.get('/.well-known/oauth-protected-resource',(_req,res)=>json(res,200,{
  resource:RESOURCE,authorization_servers:[SITE],scopes_supported:['codx.remote'],
  bearer_methods_supported:['header'],resource_name:'Codx Remote'
}));
app.get('/.well-known/oauth-authorization-server',(_req,res)=>json(res,200,{
  issuer:SITE,authorization_endpoint:SITE+'/oauth/authorize',token_endpoint:SITE+'/oauth/token',
  registration_endpoint:SITE+'/oauth/register',response_types_supported:['code'],
  grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],
  token_endpoint_auth_methods_supported:['none'],scopes_supported:['codx.remote'],
  authorization_response_iss_parameter_supported:true
}));

app.post('/oauth/register',async(req,res)=>{
  try{
    const uris=Array.isArray(req.body?.redirect_uris)?req.body.redirect_uris.map(String):[];
    if(!uris.length)return json(res,400,{error:'invalid_client_metadata'});
    for(const uri of uris){const u=new URL(uri);if(u.protocol!=='https:')return json(res,400,{error:'invalid_redirect_uri'})}
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
    target.searchParams.set('iss',SITE);
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

app.all('/api/mcp',async(req,res)=>{
  try{
    const account=await accountForMcp(req);
    if(!account){
      res.setHeader('WWW-Authenticate','Bearer resource_metadata="'+SITE+'/.well-known/oauth-protected-resource", scope="codx.remote"');
      return json(res,401,rpcError(req.body?.id,-32001,'Codx Remote authentication required.'));
    }
    await normalizeUsage(account);
    if(req.method==='GET')return json(res,200,{name:'Codx Remote MCP',status:'ready',version:'0.5.0'});
    const msg=req.body||{};
    if(msg.method==='notifications/initialized')return json(res,204,null);
    if(msg.method==='initialize')return json(res,200,rpcResult(msg.id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'Codx Remote',version:'0.5.0'}}));
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
});

await initDb();
app.listen(PORT,'0.0.0.0',()=>console.log('Codx Remote backend 0.5.0 listening on',PORT));

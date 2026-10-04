import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

test('personal key connection, account isolation, rotation and OAuth compatibility', async t=>{
  process.env.PORT='0';
  delete process.env.DATABASE_URL;
  const { server }=await import('../index.mjs');
  const { q, pool }=await import('../db.mjs');
  const { sha }=await import('../utils.mjs');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const resource='https://codx-remote-api-zrider.onrender.com/mcp';
  const keys=['test-account-a-key','test-account-b-key'];
  for(let i=0;i<2;i++){
    await q(`INSERT INTO accounts(id,account_secret_hash,mcp_key_hash,mcp_key,manage_key_hash,manage_key,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,['account-'+i,sha('secret-'+i),sha(keys[i]),keys[i],sha('manage-'+i),'manage-'+i,Date.now()]);
    await q('INSERT INTO devices(id,account_id,device_name,secret_hash,created_at,last_seen) VALUES($1,$2,$3,$4,$5,$6)',
      ['device-'+i,'account-'+i,'PC '+i,sha('device-secret-'+i),Date.now(),Date.now()]);
  }
  const rpc=(credential,method='tools/call')=>fetch(base+'/mcp',{
    method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{name:'list_devices',arguments:{}}})
  });
  await t.test('anonymous clients discover tools but cannot access accounts or devices',async()=>{
    for(const credential of [undefined,'wrong-key']){
      for(const method of ['initialize','tools/list'])assert.equal((await rpc(credential,method)).status,200);
      const r=await rpc(credential);assert.equal(r.status,200);assert.match(r.headers.get('www-authenticate'),/resource_metadata/);
      const result=(await r.json()).result;assert.equal(result.isError,true);assert.ok(result._meta['mcp/www_authenticate']);
      assert.equal(JSON.stringify(result).includes('device-0'),false);
    }
  });
  await t.test('permanent keys initialize and list only their own devices',async()=>{
    for(let i=0;i<2;i++){
      assert.equal((await rpc(keys[i],'initialize')).status,200);
      const r=await rpc(keys[i]);assert.equal(r.status,200);
      const devices=JSON.parse((await r.json()).result.content[0].text);
      assert.deepEqual(devices.map(d=>d.deviceId),['device-'+i]);
    }
  });
  await t.test('OAuth bearer and legacy query key still work',async()=>{
    await q('INSERT INTO oauth_access(token_hash,account_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [sha('oauth-test-token'),'account-0','client',resource,'codx.remote',Date.now()+60000]);
    assert.equal((await rpc('oauth-test-token')).status,200);
    const legacy=await fetch(base+'/mcp?key='+keys[0],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_devices',arguments:{}}})});
    assert.equal(legacy.status,200);assert.equal((await legacy.json()).result.isError,undefined);
  });
  await t.test('device configuration requires an authorized, non-revoked device',async()=>{
    const deviceConfig=secret=>fetch(base+'/api/device?action=mcp_config',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},
      body:JSON.stringify({deviceId:'device-0'})
    });
    assert.equal((await deviceConfig('wrong-secret')).status,401);
    assert.equal((await deviceConfig('device-secret-0')).status,403);
    await q('UPDATE accounts SET email=$1 WHERE id=$2',['account-a@example.test','account-0']);
    const response=await deviceConfig('device-secret-0');
    assert.equal(response.status,200);
    assert.equal((await response.json()).config.mcpServers.codxRemote.headers.Authorization,'Bearer '+keys[0]);
    await q('UPDATE devices SET revoked=TRUE WHERE id=$1',['device-0']);
    assert.equal((await deviceConfig('device-secret-0')).status,401);
    await q('UPDATE devices SET revoked=FALSE WHERE id=$1',['device-0']);
  });
  await t.test('backend serves the same installer as the public static site',async()=>{
    const {readFile}=await import('node:fs/promises');
    const response=await fetch(base+'/install.ps1');
    assert.equal(response.status,200);
    assert.equal(await response.text(),await readFile(new URL('../public/install.ps1',import.meta.url),'utf8'));
  });
  await t.test('configuration download requires a valid dashboard session',async()=>{
    assert.equal((await fetch(base+'/dashboard/mcp-config')).status,401);
    await q('INSERT INTO sessions(token_hash,account_id,expires_at,created_at) VALUES($1,$2,$3,$4)',
      [sha('dashboard-session'),'account-0',Date.now()+60000,Date.now()]);
    const cookie='codx_session=dashboard-session';
    const r=await fetch(base+'/dashboard/mcp-config',{headers:{Cookie:cookie}});
    assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
    const config=await r.json();assert.equal(config.mcpServers.codxRemote.headers.Authorization,'Bearer '+keys[0]);
    assert.equal(config.mcpServers.codxRemote.url,resource);
    assert.equal(config.mcpServers.codxRemote.type,'http');
    const toml=await fetch(base+'/dashboard/mcp-config?format=toml',{headers:{Cookie:cookie}});
    assert.equal(toml.status,200);
    assert.match(await toml.text(),/http_headers = \{ Authorization = "Bearer test-account-a-key" \}/);
    const dashboard=await fetch(base+'/dashboard',{headers:{Cookie:cookie}});
    assert.match(await dashboard.text(),/Baixar configuração MCP/);
  });
  await t.test('rotation rejects foreign origins and invalidates only the selected account key',async()=>{
    const headers={Cookie:'codx_session=dashboard-session',Origin:'https://evil.example'};
    assert.equal((await fetch(base+'/dashboard/mcp-key/rotate',{method:'POST',headers})).status,403);
    assert.equal((await rpc(keys[0])).status,200);
    headers.Origin='https://codx-remote-api-zrider.onrender.com';
    assert.equal((await fetch(base+'/dashboard/mcp-key/rotate',{method:'POST',headers,redirect:'manual'})).status,303);
    assert.equal((await (await rpc(keys[0])).json()).result.isError,true);
    assert.equal((await rpc(keys[1])).status,200);
    const r=await fetch(base+'/dashboard/mcp-config',{headers});
    const key=(await r.json()).mcpServers.codxRemote.headers.Authorization.slice(7);
    assert.notEqual(key,keys[0]);assert.equal((await rpc(key)).status,200);
  });
  await t.test('dashboard exposes only account-scoped metadata and persists settings',async()=>{
    const headers={Cookie:'codx_session=dashboard-session',Origin:'https://codx-remote-api-zrider.onrender.com','Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/dashboard')).status,401);
    const info=await (await fetch(base+'/api/dashboard',{headers})).json();
    assert.deepEqual(info.devices.map(d=>d.deviceId),['device-0']);
    assert.equal(JSON.stringify(info).includes('mcp_key'),false);
    assert.equal(JSON.stringify(info).includes('secret_hash'),false);
    const save=body=>fetch(base+'/api/dashboard/settings',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await save({action:'profile',name:'Conta <A>'})).status,200);
    assert.equal((await save({action:'preferences',animations:false,autoRefresh:false})).status,200);
    const updated=await (await fetch(base+'/api/dashboard',{headers})).json();
    assert.equal(updated.account.name,'Conta <A>');assert.deepEqual(updated.settings,{animations:false,autoRefresh:false});
    const html=await (await fetch(base+'/dashboard',{headers})).text();assert.match(html,/Conta &lt;A&gt;/);assert.equal(html.includes('Conta <A>'),false);
    assert.equal((await fetch(base+'/api/dashboard/settings',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify({action:'profile',name:'Altered'})})).status,403);
    assert.equal((await fetch(base+'/api/dashboard-action',{method:'POST',headers,body:JSON.stringify({action:'revoke',deviceId:'device-1'})})).status,404);
  });
  await t.test('client identity survives stateless calls and OAuth revocation is scoped',async()=>{
    await q('INSERT INTO oauth_clients(client_id,redirect_uris_json,client_name,created_at) VALUES($1,$2,$3,$4)',['test-ui-client','[]','MCP Client',Date.now()]);
    await q('INSERT INTO oauth_access(token_hash,account_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[sha('ui-oauth'),'account-0','test-ui-client',resource,'codx.remote',Date.now()+60000]);
    const call=method=>fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ui-oauth'},body:JSON.stringify({jsonrpc:'2.0',id:91,method,params:method==='initialize'?{clientInfo:{name:'ChatGPT',version:'1'}}:{}})});
    const initialized=await call('initialize');assert.ok(initialized.headers.get('mcp-session-id'));assert.equal(initialized.status,200);
    await call('tools/list');
    const headers={Cookie:'codx_session=dashboard-session',Origin:'https://codx-remote-api-zrider.onrender.com','Content-Type':'application/json'};
    const info=await (await fetch(base+'/api/dashboard',{headers})).json();const client=info.connections.find(c=>c.name==='ChatGPT');assert.ok(client);assert.equal(client.kind,'chatgpt');assert.equal(client.authorized,true);
    const invalid=await fetch(base+'/api/dashboard/settings',{method:'POST',headers,body:JSON.stringify({action:'revoke_client',connectionId:'foreign-id'})});assert.equal(invalid.status,404);
    const revoked=await fetch(base+'/api/dashboard/settings',{method:'POST',headers,body:JSON.stringify({action:'revoke_client',connectionId:client.id})});assert.equal(revoked.status,200);
    assert.equal((await (await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ui-oauth'},body:JSON.stringify({jsonrpc:'2.0',id:92,method:'tools/call',params:{name:'list_devices',arguments:{}}})})).json()).result.isError,true);
    assert.equal((await rpc(keys[1])).status,200);
  });
  await t.test('branded activity resources and usage history stay private and do not consume quota',async()=>{
    const key=(await q('SELECT mcp_key FROM accounts WHERE id=$1',['account-0'])).rows[0].mcp_key;
    const call=body=>fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',id:95,...body})});
    const tools=(await (await call({method:'tools/list'})).json()).result.tools;assert.ok(tools.find(t=>t.name==='show_activity')._meta.ui.resourceUri);
    const before=(await q('SELECT monthly_tool_calls FROM accounts WHERE id=$1',['account-0'])).rows[0].monthly_tool_calls;
    const snapshot=(await (await call({method:'tools/call',params:{name:'show_activity',arguments:{}}})).json()).result.structuredContent;assert.deepEqual(snapshot.devices.map(d=>d.deviceId),['device-0']);
    assert.equal((await q('SELECT monthly_tool_calls FROM accounts WHERE id=$1',['account-0'])).rows[0].monthly_tool_calls,before);
    const uri=tools.find(t=>t.name==='show_activity')._meta.ui.resourceUri;
    const resourceResponse=(await (await call({method:'resources/read',params:{uri}})).json()).result.contents[0];assert.equal(resourceResponse.mimeType,'text/html;profile=mcp-app');assert.match(resourceResponse.text,/ui\/initialize/);assert.equal(resourceResponse._meta['openai/ui'].preferredDisplayMode,'inline');
    const {activity}=await import('../dashboard.mjs');await activity('account-0','device-0','read_file','success',123);await activity('account-1','device-1','write_file','failed',987);
    const headers={Cookie:'codx_session=dashboard-session'};const info=await (await fetch(base+'/api/dashboard',{headers})).json();assert.equal(info.events.length,1);assert.equal(info.events[0].tool,'read_file');
    const csv=await (await fetch(base+'/api/dashboard/usage.csv',{headers})).text();assert.match(csv,/read_file/);assert.equal(csv.includes('write_file'),false);assert.equal((await fetch(base+'/api/dashboard/usage.csv')).status,401);
  });
  await t.test('remote command completion records metadata without file contents or arguments',async()=>{
    const key=(await q('SELECT mcp_key FROM accounts WHERE id=$1',['account-0'])).rows[0].mcp_key;
    await q('UPDATE devices SET last_seen=$1 WHERE id=$2',[Date.now(),'device-0']);
    const resultPromise=fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'read_file',arguments:{path:'C:\\private-sensitive-file.txt',deviceId:'device-0'}}})});
    let command;
    for(let i=0;i<20&&!command;i++){
      const poll=await fetch(base+'/api/device?action=poll',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer device-secret-0'},body:JSON.stringify({deviceId:'device-0'})});command=(await poll.json()).command;
      if(!command)await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(command);assert.equal(command.tool,'read_file');
    const active=(await q('SELECT * FROM commands WHERE device_id=$1',['device-0'])).rows;assert.equal(active.length,1);
    const posted=await fetch(base+'/api/device?action=result',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer device-secret-0'},body:JSON.stringify({deviceId:'device-0',commandId:command.commandId,ok:true,output:'private-file-content',durationMs:420})});assert.equal(posted.status,200);
    const rpcResult=await (await resultPromise).json();assert.equal(rpcResult.result.content[0].text,'private-file-content');
    const info=await (await fetch(base+'/api/dashboard',{headers:{Cookie:'codx_session=dashboard-session'}})).json();assert.equal(info.events[0].tool,'read_file');assert.equal(info.events[0].durationMs,420);assert.equal(info.account.monthlyToolCalls,1);
    const rendered=JSON.stringify(info);assert.equal(rendered.includes('private-file-content'),false);assert.equal(rendered.includes('private-sensitive-file'),false);
  });
  await t.test('one-click OAuth consent uses the browser account and preserves PKCE and refresh',async()=>{
    const crypto=await import('node:crypto');
    const verifier='test-pkce-verifier-that-is-long-enough-for-oauth-123456789';
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const callback='http://127.0.0.1:50820/callback';
    const registered=await fetch(base+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[callback],client_name:'Codex <one-click>'})});
    assert.equal(registered.status,201);
    const client=(await registered.json()).client_id;
    const params=new URLSearchParams({client_id:client,redirect_uri:callback,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state:'test-state',scope:'codx.remote',resource});
    const authPath='/oauth/authorize?'+params;
    for(let i=0;i<2;i++)await q('INSERT INTO sessions(token_hash,account_id,expires_at,created_at) VALUES($1,$2,$3,$4)',[sha('consent-session-'+i),'account-'+i,Date.now()+60000,Date.now()]);
    const cookie=i=>'codx_session=consent-session-'+i;
    const consentPage=async i=>{
      const response=await fetch(base+authPath,{headers:{Cookie:cookie(i)}});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('x-frame-options'),'DENY');
      assert.equal(response.headers.get('content-security-policy'),"frame-ancestors 'none'; form-action 'self' http://127.0.0.1:50820");
      const html=await response.text();
      assert.match(html,/Autorizar conexão/);assert.match(html,/Codex &lt;one-click&gt;/);
      assert.equal(/type="(?:email|password)"/.test(html),false);
      for(const key of (await q('SELECT mcp_key FROM accounts')).rows)assert.equal(html.includes(key.mcp_key),false);
      return html.match(/name="consent_ticket" value="([^"]+)"/)[1];
    };
    const approve=(ticket,i=0,extra={},origin='https://codx-remote-api-zrider.onrender.com')=>{
      const headers={Cookie:cookie(i),'Content-Type':'application/x-www-form-urlencoded'};
      if(origin)headers.Origin=origin;else headers['Sec-Fetch-Site']='same-origin';
      return fetch(base+'/oauth/authorize',{method:'POST',redirect:'manual',headers,body:new URLSearchParams({consent_ticket:ticket,...extra})});
    };
    const approveViaRequestHost=ticket=>{
      const url=new URL(base);
      return fetch(base+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{
        Cookie:cookie(0),Origin:url.origin,Host:url.host,'Content-Type':'application/x-www-form-urlencoded'
      },body:new URLSearchParams({consent_ticket:ticket})});
    };
    const exchange=p=>fetch(base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(p)});
    const anonymous=await (await fetch(base+authPath)).text();
    assert.match(anonymous,/Entrar para autorizar/);assert.equal(/type="(?:email|password)"/.test(anonymous),false);
    const loginLink=anonymous.match(/href="(\/login\?next=[^"]+)"/)[1].replaceAll('&amp;','&');
    const returnUrl=new URL(new URL(loginLink,base).searchParams.get('next'),base);
    assert.equal(returnUrl.pathname,'/oauth/authorize');
    for(const [name,value] of params)assert.equal(returnUrl.searchParams.get(name),value);
    assert.equal((await fetch(base+'/oauth/authorize',{method:'POST',body:new URLSearchParams({email:'account-a@example.test',password:'ignored'})})).status,401);
    const ticket=await consentPage(0);
    assert.equal((await approve(ticket,1)).status,403);
    assert.equal((await approve(ticket,0,{},'https://evil.example')).status,403);
    assert.equal((await approve(await consentPage(0),0,{},'')).status,303);
    assert.equal((await approveViaRequestHost(await consentPage(0))).status,303);
    assert.equal((await approve('invented-ticket')).status,403);
    const approval=await approve(ticket,0,{account_id:'account-1',redirect_uri:'https://evil.example',state:'tampered'});
    assert.equal(approval.status,303);
    assert.equal(approval.headers.get('content-security-policy'),"frame-ancestors 'none'; form-action 'self' http://127.0.0.1:50820");
    const target=new URL(approval.headers.get('location'));
    assert.equal(target.origin,'http://127.0.0.1:50820');assert.equal(target.searchParams.get('state'),'test-state');assert.equal(target.searchParams.get('iss'),'https://codx-remote-api-zrider.onrender.com');
    assert.equal((await approve(ticket)).status,403);
    const tokenParams={grant_type:'authorization_code',client_id:client,redirect_uri:callback,code:target.searchParams.get('code'),code_verifier:verifier};
    assert.equal((await exchange({...tokenParams,code_verifier:'wrong'})).status,400);
    const issued=await exchange(tokenParams);assert.equal(issued.status,200);
    const credentials=await issued.json();assert.ok(credentials.refresh_token);
    const devices=JSON.parse((await (await rpc(credentials.access_token)).json()).result.content[0].text);
    assert.deepEqual(devices.map(d=>d.deviceId),['device-0']);
    assert.equal((await exchange(tokenParams)).status,400);
    const refreshParams={grant_type:'refresh_token',client_id:client,refresh_token:credentials.refresh_token};
    const refreshed=await exchange(refreshParams);assert.equal(refreshed.status,200);
    assert.equal((await rpc((await refreshed.json()).access_token)).status,200);
    assert.equal((await exchange(refreshParams)).status,400);
    const other=await approve(await consentPage(1),1);
    const otherToken=await (await exchange({...tokenParams,code:new URL(other.headers.get('location')).searchParams.get('code')})).json();
    assert.notEqual(otherToken.access_token,credentials.access_token);
    assert.deepEqual(JSON.parse((await (await rpc(otherToken.access_token)).json()).result.content[0].text).map(d=>d.deviceId),['device-1']);
    const expired=await consentPage(0);await q('UPDATE oauth_consents SET expires_at=$1 WHERE token_hash=$2',[Date.now()-1000,sha(expired)]);
    assert.equal((await approve(expired)).status,403);
    const switched=await consentPage(0);
    await q('UPDATE sessions SET account_id=$1 WHERE token_hash=$2',['account-1',sha('consent-session-0')]);
    assert.equal((await approve(switched)).status,403);
  });
  await t.test('login returns to consent without accepting an external redirect',async()=>{
    const {passwordDigest}=await import('../utils.mjs');
    const password='test-login-password-only';const digest=passwordDigest(password);
    await q('UPDATE accounts SET password_salt=$1,password_hash=$2 WHERE id=$3',[digest.salt,digest.hash,'account-0']);
    const login=next=>fetch(base+'/login',{method:'POST',redirect:'manual',body:new URLSearchParams({email:'account-a@example.test',password,next})});
    const next='/oauth/authorize?client_id=example&state=continue';
    const valid=await login(next);assert.equal(valid.status,303);assert.equal(valid.headers.get('location'),next);assert.match(valid.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
    for(const next of ['https://evil.example','//evil.example','/oauth/authorize?state=x#fragment','/dashboard'])assert.equal((await login(next)).headers.get('location'),'/dashboard');
    const incorrect=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:'account-a@example.test',password:'wrong',next})});
    assert.equal(incorrect.status,401);assert.match(await incorrect.text(),/next=%2Foauth%2Fauthorize/);
  });
  await t.test('account reset is one-time, snapshots old data and creates only the requested test account',async()=>{
    const {resetAccounts}=await import('../account-reset.mjs');
    const config={action:'reset_accounts',requestId:'12345678-1234-1234-1234-123456789abc',email:'codxremote@example.com',password:'teste1234'};
    const result=await resetAccounts(config,pool);
    assert.equal(result.status,'completed');assert.equal(result.previousAccounts,2);assert.equal(result.previousDevices,2);
    const accounts=(await q('SELECT * FROM accounts')).rows;assert.equal(accounts.length,1);assert.equal(accounts[0].email,config.email);
    assert.equal((await q('SELECT * FROM devices')).rows.length,0);assert.equal((await q('SELECT * FROM oauth_access')).rows.length,0);
    const archive=JSON.parse((await q('SELECT snapshot_json FROM admin_account_resets WHERE request_id=$1',[config.requestId])).rows[0].snapshot_json);
    assert.equal(archive.accounts.length,2);assert.equal(archive.devices.length,2);
    assert.equal((await resetAccounts(config,pool)).status,'already_completed');
    const login=await fetch(base+'/login',{method:'POST',redirect:'manual',body:new URLSearchParams({email:config.email,password:config.password})});assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/dashboard',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.deepEqual((await response.json()).devices,[]);
    assert.equal((await (await rpc(keys[1])).json()).result.isError,true);
    await assert.rejects(resetAccounts({...config,requestId:'invalid'},pool),/invalid_account_reset_request/);
  });
  await t.test('any newly installed desktop can be paired to the existing test account with session consent',async()=>{
    const {resetAccounts}=await import('../account-reset.mjs');
    const login=await fetch(base+'/login',{method:'POST',redirect:'manual',body:new URLSearchParams({email:'codxremote@example.com',password:'teste1234'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    for(const name of ['DESKTOP-ONE','DESKTOP-TWO']){
      const registered=await (await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceName:name})})).json();
      const setupUrl=new URL(registered.authorizeUrl);
      const setupPath=setupUrl.pathname+setupUrl.search;
      const unpaired=await (await fetch(base+setupPath)).text();assert.match(unpaired,/Já tenho conta/);
      const html=await (await fetch(base+setupPath,{headers:{Cookie:cookie}})).text();assert.match(html,/Vincular este computador/);assert.equal(/type="(?:email|password)"/.test(html),false);
      const consent=html.match(/name="pairing_consent" value="([^"]+)"/)[1];
      const pair=(token=consent,session=cookie,origin='https://codx-remote-api-zrider.onrender.com')=>{
        const headers={Cookie:session};
        if(origin)headers.Origin=origin;else headers['Sec-Fetch-Site']='same-origin';
        return fetch(base+'/setup',{method:'POST',redirect:'manual',headers,body:new URLSearchParams({action:'pair',token:setupUrl.searchParams.get('token'),pairing_consent:token})});
      };
      assert.equal((await pair('wrong')).status,403);assert.equal((await pair(consent,'')).status,401);
      assert.equal((await pair(consent,cookie,'https://evil.example')).status,403);
      assert.equal((await pair(consent,cookie,name==='DESKTOP-ONE'?'https://codx-remote-api-zrider.onrender.com':'')).status,303);assert.equal((await pair()).status,400);
      const account=(await q('SELECT * FROM accounts')).rows;assert.equal(account.length,1);
      const device=(await q('SELECT * FROM devices WHERE id=$1',[registered.deviceId])).rows[0];assert.equal(device.account_id,account[0].id);
      const exported=await (await fetch(base+'/api/device?action=mcp_config',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+registered.deviceSecret},body:JSON.stringify({deviceId:registered.deviceId})})).json();
      assert.equal(exported.config.mcpServers.codxRemote.headers.Authorization,'Bearer '+account[0].mcp_key);
      const claimedToken='claimed-'+name;
      await q('INSERT INTO setup_tokens(token_hash,account_id,device_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[sha(claimedToken),account[0].id,device.id,Date.now()+60000,Date.now()]);
      const claimed=await (await fetch(base+'/setup?token='+claimedToken,{headers:{Cookie:cookie}})).text();
      const proof=claimed.match(/name="pairing_consent" value="([^"]+)"/)[1];
      const stealing=await fetch(base+'/setup',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:'https://codx-remote-api-zrider.onrender.com'},body:new URLSearchParams({action:'pair',token:claimedToken,pairing_consent:proof})});
      assert.equal(stealing.status,403);
    }
    const info=await (await fetch(base+'/api/dashboard',{headers:{Cookie:cookie}})).json();assert.equal(info.devices.length,2);
    assert.equal((await resetAccounts({action:'reset_accounts',requestId:'12345678-1234-1234-1234-123456789abc',email:'codxremote@example.com',password:'teste1234'},pool)).status,'already_completed');
    assert.equal((await q('SELECT * FROM devices')).rows.length,2);
  });
});

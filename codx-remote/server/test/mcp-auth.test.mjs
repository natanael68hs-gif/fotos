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
  await t.test('anonymous and incorrect keys cannot initialize or enumerate tools',async()=>{
    for(const credential of [undefined,'wrong-key'])for(const method of ['initialize','tools/list','tools/call']){
      const r=await rpc(credential,method);assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/resource_metadata/);
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
    assert.equal((await fetch(base+'/mcp?key='+keys[0])).status,200);
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
    assert.equal((await rpc(keys[0])).status,401);
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
    const revoked=await fetch(base+'/api/dashboard/settings',{method:'POST',headers,body:JSON.stringify({action:'revoke_client',connectionId:client.id})});assert.equal(revoked.status,200);assert.equal((await call('tools/list')).status,401);
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
});

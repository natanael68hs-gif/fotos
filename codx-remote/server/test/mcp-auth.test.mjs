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
});

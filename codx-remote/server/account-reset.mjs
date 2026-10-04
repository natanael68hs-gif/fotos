import crypto from 'node:crypto';
import { token, sha, passwordDigest, normalizeEmail, validEmail, monthKey } from './utils.mjs';

// Run only through the hosting administrator's environment, never a public route.
// The request ID and private snapshot make the reset auditable and one-time.
export async function resetAccounts(config,pool){
  if(!config||config.action!=='reset_accounts'||!/^[a-f0-9-]{36}$/.test(config.requestId||''))throw new Error('invalid_account_reset_request');
  const email=normalizeEmail(config.email);
  if(!validEmail(email)||typeof config.password!=='string'||config.password.length<8)throw new Error('invalid_test_account_credentials');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Serialize administrative resets, including simultaneous service starts.
    if(process.env.DATABASE_URL)await client.query('SELECT pg_advisory_xact_lock(7423109)');
    const prior=await client.query('SELECT request_id FROM admin_account_resets WHERE request_id=$1',[config.requestId]);
    if(prior.rows.length){await client.query('COMMIT');return {status:'already_completed'}};
    const tables=['accounts','devices','sessions','setup_tokens','oauth_clients','oauth_codes','oauth_access','oauth_refresh','oauth_consents','client_connections','mcp_sessions','usage_events','commands','results','account_preferences'];
    if(process.env.DATABASE_URL)await client.query('LOCK TABLE '+tables.join(',')+' IN ACCESS EXCLUSIVE MODE');
    const snapshot={};
    for(const table of tables)snapshot[table]=(await client.query('SELECT * FROM '+table)).rows;
    await client.query('INSERT INTO admin_account_resets(request_id,snapshot_json,completed_at) VALUES($1,$2,$3)',[config.requestId,JSON.stringify(snapshot),Date.now()]);
    // Explicit order also clears results, which have no account foreign key.
    for(const table of ['results','commands','mcp_sessions','client_connections','usage_events','account_preferences','sessions','setup_tokens','oauth_consents','oauth_codes','oauth_access','oauth_refresh','devices','accounts'])await client.query('DELETE FROM '+table);
    const id=crypto.randomUUID(),secret=token(),mcpKey=token(),manageKey=token(),digest=passwordDigest(config.password);
    await client.query(`INSERT INTO accounts(id,name,email,password_salt,password_hash,account_secret_hash,mcp_key_hash,mcp_key,manage_key_hash,manage_key,usage_month,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,'Codx Remote Teste',email,digest.salt,digest.hash,sha(secret),sha(mcpKey),mcpKey,sha(manageKey),manageKey,monthKey(),Date.now()]);
    await client.query('COMMIT');
    return {status:'completed',previousAccounts:snapshot.accounts.length,previousDevices:snapshot.devices.length,accounts:1,devices:0};
  }catch(error){await client.query('ROLLBACK');throw error}
  finally{client.release()}
}

export async function runRequestedAccountReset(pool){
  const raw=process.env.CODX_ACCOUNT_RESET_REQUEST;
  if(!raw)return;
  const result=await resetAccounts(JSON.parse(raw),pool);
  console.log('[ACCOUNT RESET]',JSON.stringify(result));
}

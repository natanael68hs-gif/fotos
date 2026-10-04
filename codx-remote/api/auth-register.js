import crypto from 'node:crypto';
import { randomToken, putState, getState, deleteState, hash, json, readBody } from '../lib/state.js';
import { accountByEmail, setAccountCredentials } from '../lib/accounts.js';
import { createSession, normalizeUsage } from '../lib/session.js';

async function freshAccount() {
  const accountId = crypto.randomUUID();
  const mcpKey = randomToken(32);
  const manageKey = randomToken(32);
  const accountSecret = randomToken(32);
  const account = normalizeUsage({
    accountId, mcpKey, manageKey, devices: [], createdAt: Date.now(),
    totalToolCalls: 0, plan: 'Free', monthlyLimit: 500
  });
  await Promise.all([
    putState('state/accounts/'+accountId+'.json', account),
    putState('state/account-secret/'+hash(accountSecret)+'.json', {accountId}),
    putState('state/mcp-key/'+hash(mcpKey)+'.json', {accountId}),
    putState('state/manage-key/'+hash(manageKey)+'.json', {accountId})
  ]);
  return {account, accountSecret};
}

export default async function handler(req,res){
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const body=await readBody(req);
  const email=String(body.email||'');
  const password=String(body.password||'');
  const name=String(body.name||'').trim().slice(0,80);
  const setupToken=String(body.setupToken||'');

  if(await accountByEmail(email)) return json(res,409,{error:'email_in_use'});

  let account;
  let setup=null;
  if(setupToken){
    setup=await getState('state/setup/'+hash(setupToken)+'.json');
    if(!setup || Date.now()>Number(setup.expiresAt||0)) return json(res,400,{error:'invalid_setup'});
    account=await getState('state/accounts/'+setup.accountId+'.json');
    if(!account) return json(res,400,{error:'invalid_setup'});
  }else{
    account=(await freshAccount()).account;
  }

  try{
    account.name=name || email.split('@')[0];
    account=normalizeUsage(account);
    await setAccountCredentials(account,email,password);
    if(setupToken) await deleteState('state/setup/'+hash(setupToken)+'.json');
    await createSession(res,account.accountId);
    return json(res,200,{ok:true,redirect:'/dashboard'});
  }catch(error){
    return json(res,400,{error:String(error?.message||error)});
  }
}

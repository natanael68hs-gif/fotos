import crypto from 'node:crypto';
import { randomToken, putState, getState, deleteState, hash, json, readBody } from '../lib/state.js';
import { accountByEmail, setAccountCredentials, verifyAccountLogin } from '../lib/accounts.js';
import { createSession, clearSession, sessionAccount, normalizeUsage } from '../lib/session.js';

async function freshAccount(){
  const accountId=crypto.randomUUID();
  const mcpKey=randomToken(32), manageKey=randomToken(32), accountSecret=randomToken(32);
  const account=normalizeUsage({
    accountId,mcpKey,manageKey,devices:[],createdAt:Date.now(),
    totalToolCalls:0,plan:'Free',monthlyLimit:500
  });
  await Promise.all([
    putState('state/accounts/'+accountId+'.json',account),
    putState('state/account-secret/'+hash(accountSecret)+'.json',{accountId}),
    putState('state/mcp-key/'+hash(mcpKey)+'.json',{accountId}),
    putState('state/manage-key/'+hash(manageKey)+'.json',{accountId})
  ]);
  return account;
}

async function snapshot(account){
  normalizeUsage(account);
  const devices=[];
  for(const id of account.devices||[]){
    const d=await getState('state/devices/'+id+'.json');
    if(!d) continue;
    devices.push({
      deviceId:d.deviceId,deviceName:d.deviceName,
      online:!d.revoked && Date.now()-Number(d.lastSeen||0)<15000,
      lastSeen:d.lastSeen,revoked:!!d.revoked,toolCalls:Number(d.toolCalls||0)
    });
  }
  return {
    account:{
      accountId:account.accountId,
      name:account.name||account.email?.split('@')[0]||'Codx User',
      email:account.email||null,
      plan:account.plan||'Free',
      monthlyLimit:Number(account.monthlyLimit||500),
      monthlyToolCalls:Number(account.monthlyToolCalls||0),
      totalToolCalls:Number(account.totalToolCalls||0)
    },
    devices
  };
}

export default async function handler(req,res){
  const action=String(req.query.action||'');

  if(action==='register'){
    if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
    const body=await readBody(req);
    const email=String(body.email||''), password=String(body.password||'');
    const name=String(body.name||'').trim().slice(0,80), setupToken=String(body.setupToken||'');
    if(await accountByEmail(email)) return json(res,409,{error:'email_in_use'});

    let account;
    if(setupToken){
      const setup=await getState('state/setup/'+hash(setupToken)+'.json');
      if(!setup || Date.now()>Number(setup.expiresAt||0)) return json(res,400,{error:'invalid_setup'});
      account=await getState('state/accounts/'+setup.accountId+'.json');
      if(!account) return json(res,400,{error:'invalid_setup'});
      await deleteState('state/setup/'+hash(setupToken)+'.json');
    }else account=await freshAccount();

    try{
      account.name=name||email.split('@')[0];
      normalizeUsage(account);
      await setAccountCredentials(account,email,password);
      await createSession(res,account.accountId);
      return json(res,200,{ok:true,redirect:'/dashboard'});
    }catch(error){return json(res,400,{error:String(error?.message||error)})}
  }

  if(action==='login'){
    if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
    const body=await readBody(req);
    const account=await verifyAccountLogin(String(body.email||''),String(body.password||''));
    if(!account) return json(res,401,{error:'invalid_credentials'});
    await createSession(res,account.accountId);
    return json(res,200,{ok:true,redirect:'/dashboard'});
  }

  if(action==='logout'){
    if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
    await clearSession(req,res);
    return json(res,200,{ok:true});
  }

  if(action==='me'){
    const account=await sessionAccount(req);
    if(!account) return json(res,401,{error:'unauthorized'});
    return json(res,200,await snapshot(account));
  }

  return json(res,400,{error:'unknown_action'});
}

import { getState, json } from '../lib/state.js';
import { sessionAccount, normalizeUsage } from '../lib/session.js';

export default async function handler(req,res){
  const account=await sessionAccount(req);
  if(!account) return json(res,401,{error:'unauthorized'});
  normalizeUsage(account);
  const devices=[];
  for(const id of account.devices||[]){
    const d=await getState('state/devices/'+id+'.json');
    if(!d) continue;
    devices.push({
      deviceId:d.deviceId,
      deviceName:d.deviceName,
      online:!d.revoked && Date.now()-Number(d.lastSeen||0)<15000,
      lastSeen:d.lastSeen,
      revoked:!!d.revoked,
      toolCalls:Number(d.toolCalls||0)
    });
  }
  return json(res,200,{
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
  });
}

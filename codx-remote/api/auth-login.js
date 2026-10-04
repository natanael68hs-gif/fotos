import { json, readBody } from '../lib/state.js';
import { verifyAccountLogin } from '../lib/accounts.js';
import { createSession } from '../lib/session.js';

export default async function handler(req,res){
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const body=await readBody(req);
  const account=await verifyAccountLogin(String(body.email||''),String(body.password||''));
  if(!account) return json(res,401,{error:'invalid_credentials'});
  await createSession(res,account.accountId);
  return json(res,200,{ok:true,redirect:'/dashboard'});
}

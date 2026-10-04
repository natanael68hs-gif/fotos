import { json } from '../lib/state.js';
import { clearSession } from '../lib/session.js';
export default async function handler(req,res){
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  await clearSession(req,res);
  return json(res,200,{ok:true});
}

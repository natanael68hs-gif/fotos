import { getState, putState, json, readBody } from '../lib/state.js';
import { sessionAccount } from '../lib/session.js';

export default async function handler(req,res){
  const account=await sessionAccount(req);
  if(!account) return json(res,401,{error:'unauthorized'});
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});

  const body=await readBody(req);
  const action=String(body.action||'');
  const deviceId=String(body.deviceId||'');
  if(!(account.devices||[]).includes(deviceId)) return json(res,404,{error:'device_not_found'});
  const device=await getState('state/devices/'+deviceId+'.json');
  if(!device) return json(res,404,{error:'device_not_found'});

  if(action==='disconnect'){
    device.disconnectRequested=true;
    await putState('state/devices/'+deviceId+'.json',device);
    return json(res,200,{ok:true});
  }

  if(action==='revoke'){
    device.revoked=true;
    await putState('state/devices/'+deviceId+'.json',device);
    return json(res,200,{ok:true});
  }

  if(action==='rename'){
    device.deviceName=String(body.deviceName||device.deviceName).slice(0,120);
    await putState('state/devices/'+deviceId+'.json',device);
    return json(res,200,{ok:true});
  }

  return json(res,400,{error:'unknown_action'});
}

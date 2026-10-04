import crypto from 'node:crypto';

export const now = () => Date.now();
export const token = (bytes=32) => crypto.randomBytes(bytes).toString('base64url');
export const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

export function normalizeEmail(email){
  return String(email||'').trim().toLowerCase();
}
export function validEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}
export function passwordDigest(password, salt=crypto.randomBytes(16).toString('base64url')){
  const derived=crypto.scryptSync(String(password),salt,32);
  return {salt,hash:derived.toString('base64url')};
}
export function verifyPassword(password,salt,expected){
  try{
    const actual=crypto.scryptSync(String(password),String(salt),32);
    const exp=Buffer.from(String(expected),'base64url');
    return exp.length===actual.length && crypto.timingSafeEqual(actual,exp);
  }catch{return false}
}
export function monthKey(){
  const d=new Date();
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
export function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('=');
    if(i<0) continue;
    out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
export function json(res,status,body){
  if(status===204) return res.status(204).end();
  res.status(status).type('application/json').send(JSON.stringify(body));
}
export function bearer(req){
  const h=String(req.headers.authorization||'');
  return h.startsWith('Bearer ')?h.slice(7):'';
}
export function clip(v,max){
  const s=String(v??'');
  return s.length>max?s.slice(0,max):s;
}

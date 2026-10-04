import crypto from 'node:crypto';
import { hash, randomToken, putState, getState, deleteState } from './state.js';

const COOKIE = 'codx_session';
const MAX_AGE = 30 * 24 * 60 * 60;

function cookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}

export async function createSession(res, accountId) {
  const token = randomToken(36);
  await putState('state/sessions/' + hash(token) + '.json', {
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + MAX_AGE * 1000
  });
  res.setHeader('Set-Cookie',
    COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + MAX_AGE
  );
  return token;
}

export async function clearSession(req, res) {
  const token = cookies(req)[COOKIE];
  if (token) await deleteState('state/sessions/' + hash(token) + '.json');
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

export async function sessionAccount(req) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const s = await getState('state/sessions/' + hash(token) + '.json');
  if (!s?.accountId || Date.now() > Number(s.expiresAt || 0)) {
    if (s) await deleteState('state/sessions/' + hash(token) + '.json');
    return null;
  }
  return await getState('state/accounts/' + s.accountId + '.json');
}

export function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0');
}

export function normalizeUsage(account) {
  const current = monthKey();
  if (account.usageMonth !== current) {
    account.usageMonth = current;
    account.monthlyToolCalls = 0;
  }
  if (!account.plan) account.plan = 'Free';
  if (!Number.isFinite(Number(account.monthlyLimit))) account.monthlyLimit = 500;
  account.monthlyToolCalls = Number(account.monthlyToolCalls || 0);
  account.totalToolCalls = Number(account.totalToolCalls || 0);
  return account;
}

import crypto from 'node:crypto';
import { hash, putState, getState, deleteState } from './state.js';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const derived = crypto.scryptSync(String(password), salt, 32);
  return { salt, hash: derived.toString('base64url') };
}

export function verifyPassword(password, salt, expected) {
  try {
    const actual = crypto.scryptSync(String(password), String(salt), 32);
    const exp = Buffer.from(String(expected), 'base64url');
    return exp.length === actual.length && crypto.timingSafeEqual(actual, exp);
  } catch {
    return false;
  }
}

export async function accountByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const map = await getState('state/email/' + hash(normalized) + '.json');
  if (!map?.accountId) return null;
  return await getState('state/accounts/' + map.accountId + '.json');
}

export async function setAccountCredentials(account, email, password) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw new Error('invalid_email');
  if (String(password || '').length < 10) throw new Error('password_too_short');

  const existing = await accountByEmail(normalized);
  if (existing && existing.accountId !== account.accountId) throw new Error('email_in_use');

  if (account.email && account.email !== normalized) {
    await deleteState('state/email/' + hash(account.email) + '.json');
  }

  const p = hashPassword(password);
  account.email = normalized;
  account.passwordSalt = p.salt;
  account.passwordHash = p.hash;
  account.credentialsUpdatedAt = Date.now();

  await Promise.all([
    putState('state/accounts/' + account.accountId + '.json', account),
    putState('state/email/' + hash(normalized) + '.json', { accountId: account.accountId })
  ]);

  return account;
}

export async function verifyAccountLogin(email, password) {
  const account = await accountByEmail(email);
  if (!account?.passwordSalt || !account?.passwordHash) return null;
  return verifyPassword(password, account.passwordSalt, account.passwordHash) ? account : null;
}

import crypto from 'node:crypto';
import { put, get, list, del } from '@vercel/blob';

const ACCESS = 'public';

function masterKey() {
  const raw = process.env.STATE_MASTER_KEY;
  if (!raw) throw new Error('STATE_MASTER_KEY is not configured');
  return crypto.createHash('sha256').update(raw).digest();
}

export function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encryptObject(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const input = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  });
}

function decryptObject(text) {
  const box = JSON.parse(text);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(box.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(box.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plain.toString('utf8'));
}

export async function putState(pathname, value) {
  await put(pathname, encryptObject(value), {
    access: ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json'
  });
}

export async function getState(pathname) {
  try {
    const result = await get(pathname, { access: ACCESS, useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    return decryptObject(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export async function listState(prefix, limit = 100) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: Math.min(1000, limit - out.length) });
    out.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

export async function deleteState(pathname) {
  try { await del(pathname); } catch {}
}

export function json(res, status, body) {
  if (status === 204) return res.status(204).end();
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

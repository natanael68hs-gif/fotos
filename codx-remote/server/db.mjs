import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'codx-remote.db'));
db.pragma('journal_mode = WAL');
db.exec(
  'CREATE TABLE IF NOT EXISTS accounts (' +
  'id TEXT PRIMARY KEY,' +
  'account_secret_hash TEXT NOT NULL UNIQUE,' +
  'mcp_key_hash TEXT NOT NULL UNIQUE,' +
  'mcp_key TEXT NOT NULL,' +
  'manage_key_hash TEXT NOT NULL UNIQUE,' +
  'manage_key TEXT NOT NULL,' +
  'created_at INTEGER NOT NULL,' +
  'tool_calls INTEGER NOT NULL DEFAULT 0' +
  ');' +
  'CREATE TABLE IF NOT EXISTS devices (' +
  'id TEXT PRIMARY KEY,' +
  'account_id TEXT NOT NULL,' +
  'device_name TEXT NOT NULL,' +
  'secret_hash TEXT NOT NULL,' +
  'tools_json TEXT NOT NULL DEFAULT "[]",' +
  'created_at INTEGER NOT NULL,' +
  'last_seen INTEGER,' +
  'revoked INTEGER NOT NULL DEFAULT 0,' +
  'tool_calls INTEGER NOT NULL DEFAULT 0' +
  ');' +
  'CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);' +
  'CREATE TABLE IF NOT EXISTS calls (' +
  'id TEXT PRIMARY KEY,' +
  'account_id TEXT NOT NULL,' +
  'device_id TEXT NOT NULL,' +
  'tool_name TEXT NOT NULL,' +
  'ok INTEGER,' +
  'created_at INTEGER NOT NULL,' +
  'finished_at INTEGER,' +
  'duration_ms INTEGER' +
  ');'
);

export const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const now = () => Date.now();

export function createAccount() {
  const id = crypto.randomUUID();
  const accountSecret = token();
  const mcpKey = token();
  const manageKey = token();
  db.prepare(
    'INSERT INTO accounts(id,account_secret_hash,mcp_key_hash,mcp_key,manage_key_hash,manage_key,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, sha(accountSecret), sha(mcpKey), mcpKey, sha(manageKey), manageKey, now());
  return { account: db.prepare('SELECT * FROM accounts WHERE id=?').get(id), accountSecret };
}

export function accountBySecret(secret) {
  if (!secret) return null;
  return db.prepare('SELECT * FROM accounts WHERE account_secret_hash=?').get(sha(secret)) || null;
}

export function accountByMcpKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM accounts WHERE mcp_key_hash=?').get(sha(key)) || null;
}

export function accountByManageKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM accounts WHERE manage_key_hash=?').get(sha(key)) || null;
}

export function createDevice(accountId, deviceName) {
  const id = crypto.randomUUID();
  const secret = token();
  db.prepare(
    'INSERT INTO devices(id,account_id,device_name,secret_hash,tools_json,created_at,last_seen) VALUES(?,?,?,?,?,?,?)'
  ).run(id, accountId, deviceName, sha(secret), '[]', now(), now());
  return { id, secret };
}

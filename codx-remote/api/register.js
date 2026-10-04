import crypto from 'node:crypto';
import { hash, randomToken, putState, getState, json, readBody } from '../lib/state.js';

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + req.headers.host;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const body = await readBody(req);
  const deviceName = String(body.deviceName || 'Windows PC').slice(0, 120);
  let accountSecret = String(body.accountSecret || '');
  let account = null;

  if (accountSecret) {
    const lookup = await getState('state/account-secret/' + hash(accountSecret) + '.json');
    if (lookup?.accountId) account = await getState('state/accounts/' + lookup.accountId + '.json');
  }

  let createdAccount = false;
  if (!account) {
    createdAccount = true;
    accountSecret = randomToken(32);
    const accountId = crypto.randomUUID();
    const mcpKey = randomToken(32);
    const manageKey = randomToken(32);

    account = {
      accountId,
      mcpKey,
      manageKey,
      devices: [],
      createdAt: Date.now(),
      totalToolCalls: 0
    };

    await Promise.all([
      putState('state/accounts/' + accountId + '.json', account),
      putState('state/account-secret/' + hash(accountSecret) + '.json', { accountId }),
      putState('state/mcp-key/' + hash(mcpKey) + '.json', { accountId }),
      putState('state/manage-key/' + hash(manageKey) + '.json', { accountId })
    ]);
  }

  const deviceId = crypto.randomUUID();
  const deviceSecret = randomToken(32);
  const device = {
    deviceId,
    accountId: account.accountId,
    deviceName,
    secretHash: hash(deviceSecret),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    revoked: false,
    toolCalls: 0
  };

  account.devices = Array.from(new Set([...(account.devices || []), deviceId]));

  await Promise.all([
    putState('state/devices/' + deviceId + '.json', device),
    putState('state/accounts/' + account.accountId + '.json', account)
  ]);

  const base = baseUrl(req);
  let setupToken = null;
  let authorizeUrl = base + '/dashboard';

  if (!account.email) {
    setupToken = randomToken(32);
    await putState('state/setup/' + hash(setupToken) + '.json', {
      accountId: account.accountId,
      deviceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000
    });
    authorizeUrl = base + '/authorize?setup=' + encodeURIComponent(setupToken);
  }

  return json(res, 200, {
    ok: true,
    createdAccount,
    accountSecret,
    deviceId,
    deviceSecret,
    authorizeUrl,
    dashboardUrl: base + '/dashboard'
  });
}

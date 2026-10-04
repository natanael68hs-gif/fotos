import crypto from 'node:crypto';
import { putState, getState, deleteState, hash, randomToken, json } from '../lib/state.js';
import { setAccountCredentials, verifyAccountLogin } from '../lib/accounts.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const id = crypto.randomUUID();
  const email = 'selftest-' + id + '@example.invalid';
  const password = randomToken(18);
  const account = {
    accountId: id,
    mcpKey: randomToken(32),
    manageKey: randomToken(32),
    devices: [],
    createdAt: Date.now(),
    totalToolCalls: 0
  };

  try {
    await putState('state/accounts/' + id + '.json', account);
    await setAccountCredentials(account, email, password);
    const verified = await verifyAccountLogin(email, password);

    const token = randomToken(32);
    await putState('state/oauth-access/' + hash(token) + '.json', {
      accountId: id,
      clientId: 'selftest',
      scope: 'codx.remote',
      resource: 'https://codx-remote-zrider.vercel.app/api/mcp',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000
    });
    const tokenRecord = await getState('state/oauth-access/' + hash(token) + '.json');

    const ok = verified?.accountId === id && tokenRecord?.accountId === id;

    await Promise.all([
      deleteState('state/accounts/' + id + '.json'),
      deleteState('state/email/' + hash(email) + '.json'),
      deleteState('state/oauth-access/' + hash(token) + '.json')
    ]);

    return json(res, ok ? 200 : 500, {
      ok,
      credentials: verified?.accountId === id,
      oauthTokenState: tokenRecord?.accountId === id,
      version: '0.3.0'
    });
  } catch (error) {
    await Promise.all([
      deleteState('state/accounts/' + id + '.json'),
      deleteState('state/email/' + hash(email) + '.json')
    ]);
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
}

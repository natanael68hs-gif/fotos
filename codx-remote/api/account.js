import { hash, getState, json, readBody } from '../lib/state.js';
import { setAccountCredentials } from '../lib/accounts.js';

async function accountByManageKey(key) {
  const map = await getState('state/manage-key/' + hash(key) + '.json');
  if (!map?.accountId) return null;
  return await getState('state/accounts/' + map.accountId + '.json');
}

export default async function handler(req, res) {
  const key = String(req.query.key || '');
  const account = await accountByManageKey(key);
  if (!account) return json(res, 401, { error: 'invalid_manage_key' });

  if (req.method === 'GET') {
    return json(res, 200, {
      accountId: account.accountId,
      hasCredentials: !!(account.email && account.passwordHash),
      email: account.email || null
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const body = await readBody(req);
  const action = String(body.action || '');

  if (action === 'set_credentials') {
    try {
      const updated = await setAccountCredentials(
        account,
        String(body.email || ''),
        String(body.password || '')
      );

      return json(res, 200, {
        ok: true,
        hasCredentials: true,
        email: updated.email
      });
    } catch (error) {
      const code = String(error?.message || error);
      const status = code === 'email_in_use' ? 409 : 400;
      return json(res, status, { error: code });
    }
  }

  return json(res, 400, { error: 'unknown_action' });
}

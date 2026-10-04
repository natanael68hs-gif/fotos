import {
  hash, getState, putState, json, readBody
} from '../lib/state.js';

async function loadByManageKey(key) {
  const map = await getState('state/manage-key/' + hash(key) + '.json');
  if (!map?.accountId) return null;
  return await getState('state/accounts/' + map.accountId + '.json');
}

async function snapshot(account) {
  const devices = [];
  for (const id of account.devices || []) {
    const d = await getState('state/devices/' + id + '.json');
    if (!d) continue;
    devices.push({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      online: !d.revoked && Date.now() - Number(d.lastSeen || 0) < 15000,
      lastSeen: d.lastSeen,
      revoked: !!d.revoked,
      toolCalls: Number(d.toolCalls || 0)
    });
  }
  return {
    accountId: account.accountId,
    totalToolCalls: Number(account.totalToolCalls || 0),
    devices
  };
}

export default async function handler(req, res) {
  const key = String(req.query.key || '');
  const account = await loadByManageKey(key);
  if (!account) return json(res, 401, { error: 'invalid_manage_key' });

  if (req.method === 'GET') {
    return json(res, 200, await snapshot(account));
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const body = await readBody(req);
  const action = String(body.action || '');
  const deviceId = String(body.deviceId || '');
  if (!(account.devices || []).includes(deviceId)) return json(res, 404, { error: 'device_not_found' });

  const device = await getState('state/devices/' + deviceId + '.json');
  if (!device) return json(res, 404, { error: 'device_not_found' });

  if (action === 'revoke') {
    device.revoked = true;
    await putState('state/devices/' + deviceId + '.json', device);
    return json(res, 200, { ok: true });
  }

  if (action === 'rename') {
    device.deviceName = String(body.deviceName || device.deviceName).slice(0,120);
    await putState('state/devices/' + deviceId + '.json', device);
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: 'unknown_action' });
}

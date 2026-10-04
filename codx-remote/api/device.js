import {
  hash, randomToken, putState, getState, listState, deleteState,
  json, readBody, bearer
} from '../lib/state.js';

async function authenticate(req, deviceId) {
  if (!deviceId) return null;
  const device = await getState('state/devices/' + deviceId + '.json');
  if (!device || device.revoked) return null;
  if (hash(bearer(req)) !== device.secretHash) return null;
  return device;
}

export default async function handler(req, res) {
  const action = String(req.query.action || '');
  const body = req.method === 'POST' ? await readBody(req) : {};
  const deviceId = String(body.deviceId || req.query.deviceId || '');
  const device = await authenticate(req, deviceId);
  if (!device) return json(res, 401, { error: 'unauthorized' });

  if (action === 'rotate_links') {
    const account = await getState('state/accounts/' + device.accountId + '.json');
    if (!account) return json(res, 404, { error: 'account_not_found' });

    const oldMcpKey = account.mcpKey;
    const oldManageKey = account.manageKey;
    const newMcpKey = randomToken(32);
    const newManageKey = randomToken(32);

    account.mcpKey = newMcpKey;
    account.manageKey = newManageKey;

    await Promise.all([
      putState('state/accounts/' + account.accountId + '.json', account),
      putState('state/mcp-key/' + hash(newMcpKey) + '.json', { accountId: account.accountId }),
      putState('state/manage-key/' + hash(newManageKey) + '.json', { accountId: account.accountId }),
      deleteState('state/mcp-key/' + hash(oldMcpKey) + '.json'),
      deleteState('state/manage-key/' + hash(oldManageKey) + '.json')
    ]);

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = proto + '://' + req.headers.host;
    return json(res, 200, {
      ok: true,
      mcpUrl: base + '/api/mcp?key=' + encodeURIComponent(newMcpKey),
      manageUrl: base + '/?manage=' + encodeURIComponent(newManageKey)
    });
  }

  if (action === 'setup_url') {
    const account = await getState('state/accounts/' + device.accountId + '.json');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = proto + '://' + req.headers.host;

    if (account?.email) {
      return json(res, 200, { ok: true, authorized: true, url: base + '/dashboard' });
    }

    const setupToken = randomToken(32);
    await putState('state/setup/' + hash(setupToken) + '.json', {
      accountId: device.accountId,
      deviceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000
    });

    return json(res, 200, {
      ok: true,
      authorized: false,
      url: base + '/authorize?setup=' + encodeURIComponent(setupToken)
    });
  }

  if (action === 'heartbeat') {
    device.lastSeen = Date.now();
    const disconnect = !!device.disconnectRequested;
    if (disconnect) device.disconnectRequested = false;
    await putState('state/devices/' + deviceId + '.json', device);
    const account = await getState('state/accounts/' + device.accountId + '.json');
    return json(res, 200, {
      ok: true,
      revoked: false,
      disconnect,
      authorized: !!account?.email
    });
  }

  if (action === 'poll') {
    device.lastSeen = Date.now();
    await putState('state/devices/' + deviceId + '.json', device);

    const blobs = await listState('state/commands/' + deviceId + '/', 50);
    blobs.sort((a,b) => String(a.pathname).localeCompare(String(b.pathname)));

    for (const blob of blobs) {
      const command = await getState(blob.pathname);
      if (!command) continue;
      if (command.status === 'pending') {
        command.status = 'running';
        command.dispatchedAt = Date.now();
        await putState(blob.pathname, command);
        return json(res, 200, { command });
      }
      if (command.status === 'running' && Date.now() - Number(command.dispatchedAt || 0) > 60000) {
        command.status = 'running';
        command.dispatchedAt = Date.now();
        await putState(blob.pathname, command);
        return json(res, 200, { command });
      }
    }

    return json(res, 200, { command: null });
  }

  if (action === 'result') {
    const commandId = String(body.commandId || '');
    if (!commandId) return json(res, 400, { error: 'missing_command_id' });

    const result = {
      commandId,
      deviceId,
      ok: !!body.ok,
      output: typeof body.output === 'string' ? body.output.slice(0, 250000) : '',
      error: typeof body.error === 'string' ? body.error.slice(0, 50000) : '',
      durationMs: Number(body.durationMs || 0),
      finishedAt: Date.now()
    };

    device.lastSeen = Date.now();
    device.toolCalls = Number(device.toolCalls || 0) + 1;

    await Promise.all([
      putState('state/results/' + deviceId + '/' + commandId + '.json', result),
      putState('state/devices/' + deviceId + '.json', device),
      deleteState('state/commands/' + deviceId + '/' + commandId + '.json')
    ]);

    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: 'unknown_action' });
}

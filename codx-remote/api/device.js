import {
  hash, putState, getState, listState, deleteState,
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

  if (action === 'heartbeat') {
    device.lastSeen = Date.now();
    await putState('state/devices/' + deviceId + '.json', device);
    return json(res, 200, { ok: true, revoked: false });
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

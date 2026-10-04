import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { db, sha, token, now, createAccount, accountBySecret, accountByMcpKey, accountByManageKey, createDevice } from './db.mjs';

export const sockets = new Map();
const pending = new Map();

export function publicAccount(account, baseUrl) {
  return {
    accountId: account.id,
    mcpUrl: baseUrl + '/mcp?key=' + encodeURIComponent(account.mcp_key),
    manageUrl: baseUrl + '/manage?key=' + encodeURIComponent(account.manage_key),
    manageApi: baseUrl + '/api/manage?key=' + encodeURIComponent(account.manage_key)
  };
}

export function onlineDevices(accountId) {
  const rows = db.prepare('SELECT * FROM devices WHERE account_id=? AND revoked=0 ORDER BY created_at ASC').all(accountId);
  return rows.map(row => ({
    id: row.id,
    deviceName: row.device_name,
    online: sockets.has(row.id),
    lastSeen: row.last_seen,
    toolCalls: row.tool_calls,
    tools: JSON.parse(row.tools_json || '[]')
  }));
}

export function registerDevice(body, baseUrl) {
  const deviceName = String(body?.deviceName || 'Windows PC').slice(0,120);
  let accountSecret = String(body?.accountSecret || '');
  let account = accountBySecret(accountSecret);
  let createdAccount = false;

  if (!account) {
    const created = createAccount();
    account = created.account;
    accountSecret = created.accountSecret;
    createdAccount = true;
  }

  const device = createDevice(account.id, deviceName);
  return {
    ok: true,
    createdAccount,
    accountSecret,
    deviceId: device.id,
    deviceSecret: device.secret,
    relayWsUrl: baseUrl.replace(/^http/, 'ws') + '/device/ws',
    ...publicAccount(account, baseUrl)
  };
}

export function managerSnapshot(key, baseUrl) {
  const account = accountByManageKey(key);
  if (!account) return null;
  return {
    accountId: account.id,
    totalToolCalls: account.tool_calls,
    devices: onlineDevices(account.id),
    mcpUrl: publicAccount(account, baseUrl).mcpUrl
  };
}

export function managerAction(key, action, deviceId) {
  const account = accountByManageKey(key);
  if (!account) return { status: 401, body: { error: 'invalid_manage_key' } };
  const device = db.prepare('SELECT * FROM devices WHERE id=? AND account_id=?').get(deviceId, account.id);
  if (!device) return { status: 404, body: { error: 'device_not_found' } };

  if (action === 'revoke_device') {
    db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(deviceId);
    const ws = sockets.get(deviceId);
    try { ws?.close(4001, 'revoked'); } catch {}
    sockets.delete(deviceId);
    return { status: 200, body: { ok: true } };
  }

  if (action === 'shutdown_device') {
    const ws = sockets.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return { status: 409, body: { error: 'device_offline' } };
    ws.send(JSON.stringify({ type: 'shutdown' }));
    return { status: 200, body: { ok: true } };
  }

  return { status: 400, body: { error: 'unknown_action' } };
}

function selectDevice(accountId, requestedId) {
  const devices = onlineDevices(accountId).filter(d => d.online);
  if (requestedId) return devices.find(d => d.id === requestedId) || null;
  return devices.length === 1 ? devices[0] : null;
}

export function mergedTools(accountId) {
  const deviceTools = onlineDevices(accountId).flatMap(d => d.tools || []);
  const map = new Map();

  for (const t of deviceTools) {
    if (!t?.name || map.has(t.name)) continue;
    const schema = structuredClone(t.inputSchema || { type: 'object', properties: {} });
    schema.type = 'object';
    schema.properties ||= {};
    schema.properties.deviceId = {
      type: 'string',
      description: 'Optional Codx Remote device ID. Required when more than one device is online.'
    };
    map.set(t.name, { ...t, inputSchema: schema });
  }

  return [
    {
      name: 'list_devices',
      description: 'List Codx Remote devices and their online/offline state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    {
      name: 'who_am_i',
      description: 'Show Codx Remote account and usage information.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    ...map.values()
  ];
}

async function callDevice(account, device, name, args) {
  const ws = sockets.get(device.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Device is offline.');

  const callId = crypto.randomUUID();
  const started = now();
  db.prepare('INSERT INTO calls(id,account_id,device_id,tool_name,created_at) VALUES(?,?,?,?,?)')
    .run(callId, account.id, device.id, name, started);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error('Remote command timed out after 55 seconds.'));
    }, 55000);

    pending.set(callId, {
      resolve: result => {
        clearTimeout(timer);
        pending.delete(callId);
        const duration = now() - started;
        db.prepare('UPDATE calls SET ok=1,finished_at=?,duration_ms=? WHERE id=?').run(now(), duration, callId);
        db.prepare('UPDATE accounts SET tool_calls=tool_calls+1 WHERE id=?').run(account.id);
        db.prepare('UPDATE devices SET tool_calls=tool_calls+1,last_seen=? WHERE id=?').run(now(), device.id);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timer);
        pending.delete(callId);
        const duration = now() - started;
        db.prepare('UPDATE calls SET ok=0,finished_at=?,duration_ms=? WHERE id=?').run(now(), duration, callId);
        reject(error);
      }
    });

    ws.send(JSON.stringify({ type: 'call', id: callId, name, arguments: args || {} }));
  });
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

export async function handleMcp(key, msg) {
  const account = accountByMcpKey(key);
  if (!account) return { status: 401, body: rpcError(msg?.id, -32001, 'Invalid Codx Remote MCP key.') };

  if (msg?.method === 'notifications/initialized') return { status: 204, body: null };

  if (msg?.method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'Codx Remote', version: '0.1.0' }
      })
    };
  }

  if (msg?.method === 'ping') return { status: 200, body: rpcResult(msg.id, {}) };
  if (msg?.method === 'tools/list') return { status: 200, body: rpcResult(msg.id, { tools: mergedTools(account.id) }) };

  if (msg?.method === 'tools/call') {
    const name = String(msg.params?.name || '');
    const args = { ...(msg.params?.arguments || {}) };

    if (name === 'list_devices') {
      return { status: 200, body: rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(onlineDevices(account.id), null, 2) }] }) };
    }

    if (name === 'who_am_i') {
      const info = {
        accountId: account.id,
        totalToolCalls: account.tool_calls,
        devices: onlineDevices(account.id).map(d => ({ id: d.id, deviceName: d.deviceName, online: d.online }))
      };
      return { status: 200, body: rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }) };
    }

    const requestedDeviceId = args.deviceId ? String(args.deviceId) : '';
    delete args.deviceId;
    const device = selectDevice(account.id, requestedDeviceId);

    if (!device) {
      const online = onlineDevices(account.id).filter(d => d.online);
      const reason = online.length === 0
        ? 'No Codx Remote device is online.'
        : 'More than one device is online. Call list_devices and pass deviceId.';
      return { status: 200, body: rpcResult(msg.id, { content: [{ type: 'text', text: reason }], isError: true }) };
    }

    try {
      const result = await callDevice(account, device, name, args);
      return { status: 200, body: rpcResult(msg.id, result) };
    } catch (error) {
      return { status: 200, body: rpcResult(msg.id, { content: [{ type: 'text', text: String(error?.message || error) }], isError: true }) };
    }
  }

  return { status: 200, body: rpcError(msg?.id, -32601, 'Method not found') };
}

export function attachDeviceSocket(ws, deviceId) {
  sockets.set(deviceId, ws);
  db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), deviceId);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      const tools = Array.isArray(msg.tools) ? msg.tools : [];
      db.prepare('UPDATE devices SET device_name=?,tools_json=?,last_seen=? WHERE id=?')
        .run(String(msg.deviceName || 'PC').slice(0,120), JSON.stringify(tools), now(), deviceId);
      ws.send(JSON.stringify({ type: 'ready', deviceId }));
      return;
    }

    if (msg.type === 'heartbeat') {
      db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), deviceId);
      ws.send(JSON.stringify({ type: 'heartbeat_ack', ts: now() }));
      return;
    }

    if (msg.type === 'result') {
      const p = pending.get(String(msg.id || ''));
      if (!p) return;
      if (msg.error) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
    }
  });

  ws.on('close', () => {
    if (sockets.get(deviceId) === ws) sockets.delete(deviceId);
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), deviceId);
  });
}

export function validateDevice(deviceId, secret) {
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
  return !!device && !device.revoked && sha(secret) === device.secret_hash;
}

export function heartbeatSockets() {
  for (const [deviceId, ws] of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'server_ping', ts: now() })); } catch {}
    } else {
      sockets.delete(deviceId);
    }
  }
}

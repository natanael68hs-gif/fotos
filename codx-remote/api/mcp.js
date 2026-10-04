import crypto from 'node:crypto';
import {
  hash, putState, getState, deleteState, json, readBody, bearer
} from '../lib/state.js';
import { normalizeUsage } from '../lib/session.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const tools = [
  {
    name: 'list_devices',
    description: 'List Codx Remote devices and their online/offline status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'who_am_i',
    description: 'Show Codx Remote account usage and connected device summary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'system_info',
    description: 'Read basic system information from the connected Windows PC.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory on the connected PC.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        deviceId: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the connected PC.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxChars: { type: 'integer', minimum: 1, maximum: 250000, default: 100000 },
        deviceId: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'write_file',
    description: 'Create, replace, or append UTF-8 text on the connected PC.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', default: false },
        deviceId: { type: 'string' }
      },
      required: ['path','content'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'run_powershell',
    description: 'Run a PowerShell command on the connected PC and return stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        deviceId: { type: 'string' }
      },
      required: ['command'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'list_processes',
    description: 'List running processes on the connected PC.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 300, default: 100 },
        deviceId: { type: 'string' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }
];

async function loadAccountByKey(key) {
  const map = await getState('state/mcp-key/' + hash(key) + '.json');
  if (!map?.accountId) return null;
  return await getState('state/accounts/' + map.accountId + '.json');
}

async function loadAccountByBearer(token) {
  if (!token) return null;
  const session = await getState('state/oauth-access/' + hash(token) + '.json');
  if (!session?.accountId) return null;
  if (Date.now() > Number(session.expiresAt || 0)) {
    await deleteState('state/oauth-access/' + hash(token) + '.json');
    return null;
  }
  if (session.resource !== 'https://codx-remote-zrider.vercel.app/api/mcp') return null;
  return await getState('state/accounts/' + session.accountId + '.json');
}

async function loadDevices(account) {
  const out = [];
  for (const id of account.devices || []) {
    const d = await getState('state/devices/' + id + '.json');
    if (d && !d.revoked) {
      d.online = Date.now() - Number(d.lastSeen || 0) < 15000;
      out.push(d);
    }
  }
  return out;
}

async function chooseDevice(account, requestedId) {
  const devices = (await loadDevices(account)).filter(d => d.online);
  if (requestedId) return devices.find(d => d.deviceId === requestedId) || null;
  return devices.length === 1 ? devices[0] : null;
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export default async function handler(req, res) {
  const token = bearer(req);
  const key = String(req.query.key || '');
  const account = token ? await loadAccountByBearer(token) : await loadAccountByKey(key);

  if (!account) {
    res.setHeader(
      'WWW-Authenticate',
      'Bearer resource_metadata="https://codx-remote-zrider.vercel.app/.well-known/oauth-protected-resource", scope="codx.remote"'
    );
    return json(res, 401, error(req.body?.id, -32001, 'Codx Remote authentication required.'));
  }

  normalizeUsage(account);

  if (req.method === 'GET') {
    const devices = await loadDevices(account);
    return json(res, 200, {
      name: 'Codx Remote MCP',
      status: 'ready',
      onlineDevices: devices.filter(d => d.online).length
    });
  }

  if (req.method !== 'POST') return json(res, 405, error(null, -32600, 'Method not allowed'));

  const msg = await readBody(req);

  if (msg.method === 'notifications/initialized') return json(res, 204, null);

  if (msg.method === 'initialize') {
    return json(res, 200, result(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'Codx Remote', version: '0.4.0' }
    }));
  }

  if (msg.method === 'ping') return json(res, 200, result(msg.id, {}));
  if (msg.method === 'tools/list') return json(res, 200, result(msg.id, { tools }));

  if (msg.method !== 'tools/call') {
    return json(res, 200, error(msg.id, -32601, 'Method not found'));
  }

  const name = String(msg.params?.name || '');
  const args = { ...(msg.params?.arguments || {}) };

  if (name === 'list_devices') {
    const devices = await loadDevices(account);
    return json(res, 200, result(msg.id, {
      content: [{ type: 'text', text: JSON.stringify(devices.map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        online: d.online,
        lastSeen: d.lastSeen,
        toolCalls: Number(d.toolCalls || 0)
      })), null, 2) }]
    }));
  }

  if (name === 'who_am_i') {
    const devices = await loadDevices(account);
    return json(res, 200, result(msg.id, {
      content: [{ type: 'text', text: JSON.stringify({
        accountId: account.accountId,
        totalToolCalls: Number(account.totalToolCalls || 0),
        devices: devices.map(d => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          online: d.online
        }))
      }, null, 2) }]
    }));
  }

  if (Number(account.monthlyToolCalls || 0) >= Number(account.monthlyLimit || 500)) {
    return json(res, 200, result(msg.id, {
      content: [{ type: 'text', text: 'Monthly Codx Remote usage limit reached for this account.' }],
      isError: true
    }));
  }

  const requestedId = args.deviceId ? String(args.deviceId) : '';
  delete args.deviceId;
  const device = await chooseDevice(account, requestedId);

  if (!device) {
    const devices = (await loadDevices(account)).filter(d => d.online);
    const message = devices.length === 0
      ? 'No Codx Remote device is online.'
      : 'More than one device is online. Pass deviceId.';
    return json(res, 200, result(msg.id, {
      content: [{ type: 'text', text: message }],
      isError: true
    }));
  }

  if (!tools.some(t => t.name === name)) {
    return json(res, 200, result(msg.id, {
      content: [{ type: 'text', text: 'Unknown tool: ' + name }],
      isError: true
    }));
  }

  const commandId = crypto.randomUUID();
  await putState('state/commands/' + device.deviceId + '/' + commandId + '.json', {
    commandId,
    deviceId: device.deviceId,
    tool: name,
    args,
    status: 'pending',
    createdAt: Date.now()
  });

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const remote = await getState('state/results/' + device.deviceId + '/' + commandId + '.json');
    if (remote) {
      await deleteState('state/results/' + device.deviceId + '/' + commandId + '.json');

      account.totalToolCalls = Number(account.totalToolCalls || 0) + 1;
      account.monthlyToolCalls = Number(account.monthlyToolCalls || 0) + 1;
      normalizeUsage(account);
      await putState('state/accounts/' + account.accountId + '.json', account);

      return json(res, 200, result(msg.id, {
        content: [{
          type: 'text',
          text: remote.ok ? (remote.output || '(no output)') : (remote.error || 'Command failed.')
        }],
        isError: !remote.ok
      }));
    }
    await sleep(700);
  }

  return json(res, 200, result(msg.id, {
    content: [{ type: 'text', text: 'Timed out waiting for the connected PC. Keep Codx Remote running in PowerShell.' }],
    isError: true
  }));
}

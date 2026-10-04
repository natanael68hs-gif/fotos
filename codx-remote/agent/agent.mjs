import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVER = process.env.CODX_REMOTE_URL || 'https://codx-remote-zrider.vercel.app';
const ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodxRemote');
const CONFIG = path.join(ROOT, 'config.json');
const VERSION = '0.5.1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG, 'utf8')); }
  catch { return null; }
}

async function saveConfig(config) {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body.error || body.raw || ('HTTP ' + res.status));
  return body;
}

async function openUrl(url) {
  if (!url) return false;

  const authFile = path.join(ROOT, 'authorize.url');
  try { await fs.writeFile(authFile, url, 'utf8'); } catch {}

  const attempts = [
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath ' + JSON.stringify(url)]],
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]],
    ['explorer.exe', [url]]
  ];

  for (const [exe, args] of attempts) {
    try {
      await execFileAsync(exe, args, { windowsHide: true, timeout: 10000 });
      return true;
    } catch {}
  }

  console.log('[WARN] Browser could not be opened automatically.');
  console.log('[INFO] Run this in another PowerShell to open authorization:');
  console.log('Start-Process (Get-Content "$env:LOCALAPPDATA\\CodxRemote\\authorize.url" -Raw)');
  return false;
}

async function register(config) {
  const result = await request(SERVER + '/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceName: os.hostname(),
      accountSecret: config?.accountSecret || ''
    })
  });

  const next = {
    server: SERVER,
    accountSecret: result.accountSecret,
    deviceId: result.deviceId,
    deviceSecret: result.deviceSecret,
    deviceName: os.hostname(),
    version: VERSION,
    dashboardUrl: result.dashboardUrl || (SERVER + '/dashboard'),
    credentialsMigrated: true
  };

  await saveConfig(next);
  return { config: next, authorizeUrl: result.authorizeUrl || null };
}

function authHeaders(config) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer ' + config.deviceSecret
  };
}

async function heartbeat(config) {
  return request(SERVER + '/api/device?action=heartbeat', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ deviceId: config.deviceId, agentVersion: VERSION })
  });
}

async function rotateLegacyLinks(config) {
  return request(SERVER + '/api/device?action=rotate_links', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ deviceId: config.deviceId })
  });
}

async function setupUrl(config) {
  return request(SERVER + '/api/device?action=setup_url', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ deviceId: config.deviceId })
  });
}

async function poll(config) {
  return request(SERVER + '/api/device?action=poll', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ deviceId: config.deviceId })
  });
}

async function sendResult(config, command, payload) {
  return request(SERVER + '/api/device?action=result', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      deviceId: config.deviceId,
      commandId: command.commandId,
      tool: command.tool,
      ...payload
    })
  });
}

function clip(text, max = 250000) {
  text = String(text ?? '');
  return text.length > max ? text.slice(0, max) + '\n...[truncated]' : text;
}

async function executeTool(name, args = {}) {
  if (name === 'system_info') {
    return JSON.stringify({
      computerName: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      freeMemoryGB: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
      home: os.homedir(),
      uptimeSeconds: Math.floor(os.uptime())
    }, null, 2);
  }

  if (name === 'list_directory') {
    const target = path.resolve(String(args.path || '.'));
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows = [];
    for (const entry of entries.slice(0, 1000)) {
      const full = path.join(target, entry.name);
      let size = null;
      try { if (entry.isFile()) size = (await fs.stat(full)).size; } catch {}
      rows.push({
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        name: entry.name,
        path: full,
        size
      });
    }
    return JSON.stringify(rows, null, 2);
  }

  if (name === 'read_file') {
    const target = path.resolve(String(args.path || ''));
    const maxChars = Math.min(250000, Math.max(1, Number(args.maxChars || 100000)));
    return clip(await fs.readFile(target, 'utf8'), maxChars);
  }

  if (name === 'write_file') {
    const target = path.resolve(String(args.path || ''));
    const data = String(args.content ?? '');
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (args.append) await fs.appendFile(target, data, 'utf8');
    else await fs.writeFile(target, data, 'utf8');
    return JSON.stringify({
      ok: true, path: target,
      bytes: Buffer.byteLength(data, 'utf8'),
      append: !!args.append
    });
  }

  if (name === 'run_powershell') {
    const command = String(args.command || '');
    if (!command) throw new Error('Missing PowerShell command.');
    const options = {
      cwd: args.cwd ? path.resolve(String(args.cwd)) : undefined,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4
    };
    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        options
      );
      return clip((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : ''));
    } catch (error) {
      const stdout = error.stdout || '';
      const stderr = error.stderr || '';
      throw new Error(clip((stdout ? stdout + '\n' : '') + stderr + (stderr ? '\n' : '') + (error.message || 'PowerShell failed')));
    }
  }

  if (name === 'list_processes') {
    const limit = Math.min(300, Math.max(1, Number(args.limit || 100)));
    const script =
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First ' + limit +
      ' Id,ProcessName,CPU,WorkingSet | ConvertTo-Json -Depth 3';
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 * 2 }
    );
    return clip((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : ''));
  }

  throw new Error('Unknown tool: ' + name);
}

function banner(config, authorized) {
  console.clear();
  console.log('============================================================');
  console.log('                       CODX REMOTE');
  console.log('============================================================');
  console.log('');
  console.log('[OK] Codx Remote Agent ' + VERSION);
  console.log('[OK] Device: ' + config.deviceName);
  console.log('[OK] Status: Online');
  console.log(authorized ? '[OK] Account: Authorized' : '[..] Account: Waiting for authorization in browser');
  if (!authorized) console.log('[..] Authorization page: Render secure setup');
  console.log('');
  console.log('Dashboard opened in your browser.');
  console.log('Keep this PowerShell window open.');
  console.log('Press Ctrl+C to disconnect.');
  console.log('');
}

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\nCodx Remote disconnected.');
  setTimeout(() => process.exit(0), 100);
});

async function main() {
  await fs.mkdir(ROOT, { recursive: true });
  let config = await loadConfig();
  let authorizeUrl = null;

  if (!config?.deviceId || !config?.deviceSecret) {
    console.log('Registering this PC with Codx Remote...');
    const registered = await register(config);
    config = registered.config;
    authorizeUrl = registered.authorizeUrl;
  } else {
    delete config.mcpUrl;
    delete config.manageUrl;
    config.version = VERSION;
    config.dashboardUrl = SERVER + '/dashboard';
    await saveConfig(config);
  }

  let hb;
  try {
    hb = await heartbeat(config);
  } catch {
    console.log('Saved device session is no longer valid. Registering again...');
    const registered = await register(config);
    config = registered.config;
    authorizeUrl = registered.authorizeUrl;
    hb = await heartbeat(config);
  }

  if (hb.disconnect) process.exit(0);

  if (!config.credentialsMigrated) {
    try {
      await rotateLegacyLinks(config);
      config.credentialsMigrated = true;
      delete config.mcpUrl;
      delete config.manageUrl;
      await saveConfig(config);
      console.log('[OK] Legacy links protected.');
    } catch {}
  }

  if (!hb.authorized) {
    try {
      const setup = authorizeUrl ? { url: authorizeUrl } : await setupUrl(config);
      await openUrl(setup.url);
    } catch {
      await openUrl(SERVER + '/setup');
    }
  } else {
    try { await fs.unlink(path.join(ROOT, 'authorize.url')); } catch {}
    await openUrl(SERVER + '/dashboard');
  }

  banner(config, !!hb.authorized);

  let lastHeartbeat = 0;

  while (!stopping) {
    try {
      if (Date.now() - lastHeartbeat > 8000) {
        const status = await heartbeat(config);
        lastHeartbeat = Date.now();

        if (status.disconnect) {
          console.log('[REMOTE] Disconnect requested from dashboard.');
          stopping = true;
          break;
        }
      }

      const data = await poll(config);
      const command = data.command;

      if (!command) {
        await sleep(1200);
        continue;
      }

      const started = Date.now();
      console.log('[CALL] ' + command.tool + '  ' + new Date().toLocaleTimeString());

      try {
        const output = await executeTool(command.tool, command.args || {});
        await sendResult(config, command, {
          ok: true,
          output: clip(output),
          durationMs: Date.now() - started
        });
        console.log('[OK]   ' + command.tool + ' (' + (Date.now() - started) + ' ms)');
      } catch (error) {
        await sendResult(config, command, {
          ok: false,
          error: clip(error?.stack || error?.message || String(error), 50000),
          durationMs: Date.now() - started
        });
        console.log('[ERR]  ' + command.tool + ': ' + (error?.message || error));
      }
    } catch (error) {
      console.log('[WARN] Connection error: ' + (error?.message || error));
      await sleep(2500);
    }
  }

  console.log('Codx Remote disconnected.');
}

main().catch(error => {
  console.error('[FATAL] ' + (error?.stack || error));
  process.exit(1);
});

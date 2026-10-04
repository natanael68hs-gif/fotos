import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { db, sha } from './db.mjs';
import {
  registerDevice,
  managerSnapshot,
  managerAction,
  handleMcp,
  validateDevice,
  attachDeviceSocket,
  heartbeatSockets
} from './relay.mjs';

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || ('http://localhost:' + PORT)).replace(/\/$/, '');

function sendJson(res, status, body) {
  if (status === 204) return res.sendStatus(204);
  res.status(status).type('application/json').send(JSON.stringify(body));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => sendJson(res, 200, {
  ok: true,
  service: 'codx-remote-relay',
  publicBaseUrl: PUBLIC_BASE_URL
}));

app.post('/device/register', (req, res) => {
  sendJson(res, 200, registerDevice(req.body || {}, PUBLIC_BASE_URL));
});

app.get('/api/manage', (req, res) => {
  const snapshot = managerSnapshot(String(req.query.key || ''), PUBLIC_BASE_URL);
  if (!snapshot) return sendJson(res, 401, { error: 'invalid_manage_key' });
  sendJson(res, 200, snapshot);
});

app.post('/api/manage', (req, res) => {
  const result = managerAction(
    String(req.query.key || ''),
    String(req.body?.action || ''),
    String(req.body?.deviceId || '')
  );
  sendJson(res, result.status, result.body);
});

app.get('/manage', (req, res) => {
  const key = String(req.query.key || '');
  const snapshot = managerSnapshot(key, PUBLIC_BASE_URL);
  if (!snapshot) return res.status(401).type('text/plain').send('Invalid manager link.');

  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Codx Remote Manager</title>' +
    '<style>body{font-family:system-ui;background:#0b1018;color:#fff;max-width:900px;margin:40px auto;padding:20px}' +
    '.card{background:#121a27;border:1px solid #263247;border-radius:16px;padding:20px;margin:14px 0}' +
    'small{color:#91a0b5}button{background:#2563eb;border:0;color:white;border-radius:8px;padding:9px 12px;margin-right:8px;cursor:pointer}' +
    'button.danger{background:#b91c1c}code{word-break:break-all;color:#b9d2ff}</style></head>' +
    '<body><h1>Codx Remote Manager</h1><p><small>Atualiza automaticamente.</small></p>' +
    '<div class="card"><b>MCP URL</b><p><code id="mcp"></code></p><p>Total de chamadas: <span id="usage">0</span></p></div>' +
    '<div id="devices"></div><script>' +
    'const key=' + JSON.stringify(key) + ';' +
    'async function load(){const r=await fetch("/api/manage?key="+encodeURIComponent(key));const d=await r.json();' +
    'document.getElementById("mcp").textContent=d.mcpUrl||"";document.getElementById("usage").textContent=d.totalToolCalls||0;' +
    'document.getElementById("devices").innerHTML=(d.devices||[]).map(function(x){return "<div class=\"card\"><b>"+x.deviceName+"</b> - "+(x.online?"ONLINE":"offline")+"<br><small>ID: "+x.id+"<br>Chamadas: "+(x.toolCalls||0)+"<br>Ultimo sinal: "+(x.lastSeen?new Date(x.lastSeen).toLocaleString():"-")+"</small><p><button onclick=\"act(\\'shutdown_device\\',\\'"+x.id+"\\')\">Desconectar</button><button class=\"danger\" onclick=\"act(\\'revoke_device\\',\\'"+x.id+"\\')\">Revogar</button></p></div>"}).join("");}' +
    'async function act(action,deviceId){await fetch("/api/manage?key="+encodeURIComponent(key),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:action,deviceId:deviceId})});load();}' +
    'load();setInterval(load,4000);</script></body></html>';

  res.type('html').send(html);
});

app.get('/mcp', (req, res) => {
  const key = String(req.query.key || '');
  const account = db.prepare('SELECT id FROM accounts WHERE mcp_key_hash=?').get(sha(key));
  if (!account) return sendJson(res, 401, { error: 'invalid_key' });
  sendJson(res, 200, { name: 'Codx Remote MCP', status: 'ready' });
});

app.post('/mcp', async (req, res) => {
  const result = await handleMcp(String(req.query.key || ''), req.body || {});
  sendJson(res, result.status, result.body);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  if (url.pathname !== '/device/ws') return socket.destroy();

  const deviceId = url.searchParams.get('deviceId') || '';
  const secret = url.searchParams.get('secret') || '';
  if (!validateDevice(deviceId, secret)) return socket.destroy();

  wss.handleUpgrade(req, socket, head, ws => {
    ws.deviceId = deviceId;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => attachDeviceSocket(ws, ws.deviceId));

setInterval(heartbeatSockets, 15000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Codx Remote relay listening on :' + PORT);
  console.log('Public base URL: ' + PUBLIC_BASE_URL);
});

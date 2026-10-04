import { hash, randomToken, putState, getState } from '../lib/state.js';
import { verifyAccountLogin } from '../lib/accounts.js';

const BASE = 'https://codx-remote-zrider.vercel.app';
const RESOURCE = BASE + '/api/mcp';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function readForm(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

async function validateRequest(params) {
  const clientId = String(params.client_id || '');
  const client = await getState('state/oauth-clients/' + clientId + '.json');
  if (!client) return { error: 'invalid_client' };

  const redirectUri = String(params.redirect_uri || '');
  if (!client.redirectUris?.includes(redirectUri)) return { error: 'invalid_redirect_uri' };

  if (String(params.response_type || '') !== 'code') return { error: 'unsupported_response_type' };
  if (String(params.code_challenge_method || '') !== 'S256') return { error: 'invalid_request', detail: 'S256 PKCE required' };
  if (!String(params.code_challenge || '')) return { error: 'invalid_request', detail: 'code_challenge required' };

  const resource = String(params.resource || RESOURCE);
  if (resource !== RESOURCE) return { error: 'invalid_target' };

  const scope = String(params.scope || 'codx.remote');
  if (!scope.split(/\s+/).includes('codx.remote')) return { error: 'invalid_scope' };

  return { client, redirectUri, resource, scope };
}

function renderLogin(params, message = '') {
  const hidden = [
    'client_id','redirect_uri','response_type','code_challenge',
    'code_challenge_method','state','resource','scope'
  ].map(name => '<input type="hidden" name="' + name + '" value="' + esc(params[name] || '') + '">').join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar no Codx Remote</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d14;color:#f7f9fc;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.card{width:min(92vw,430px);background:#111927;border:1px solid #2b3850;border-radius:20px;padding:28px;box-shadow:0 30px 80px #0008}
h1{margin:0 0 8px;font-size:28px}.muted{color:#94a3b8;line-height:1.5;margin:0 0 22px}
label{display:block;font-size:13px;color:#b8c3d4;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;background:#0a101a;color:#fff;border:1px solid #334158;border-radius:10px;padding:12px}
button{width:100%;margin-top:20px;border:0;border-radius:10px;padding:13px;background:#3274f6;color:#fff;font-weight:700;cursor:pointer}
.err{background:#3a151b;border:1px solid #7f2633;color:#ffb7c0;padding:10px;border-radius:10px;margin:12px 0}
small{display:block;color:#748196;margin-top:15px;line-height:1.45}
</style>
</head>
<body>
<form class="card" method="post" action="/oauth/authorize">
<h1>Codx Remote</h1>
<p class="muted">Entre na sua conta Codx Remote para autorizar o ChatGPT a usar seus dispositivos conectados.</p>
${message ? '<div class="err">' + esc(message) + '</div>' : ''}
${hidden}
<label>E-mail</label><input type="email" name="email" autocomplete="username" required>
<label>Senha</label><input type="password" name="password" autocomplete="current-password" required>
<button type="submit">Autorizar ChatGPT</button>
<small>O ChatGPT receberá somente um token de acesso. Sua senha não é enviada ao ChatGPT.</small>
</form>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const params = req.query || {};
    const validation = await validateRequest(params);
    if (validation.error) {
      return res.status(400).type('text/plain').send(validation.detail || validation.error);
    }
    res.setHeader('Cache-Control','no-store');
    return res.status(200).type('html').send(renderLogin(params));
  }

  if (req.method !== 'POST') return res.status(405).end();

  const params = await readForm(req);
  const validation = await validateRequest(params);
  if (validation.error) {
    return res.status(400).type('text/plain').send(validation.detail || validation.error);
  }

  const account = await verifyAccountLogin(params.email, params.password);
  if (!account) {
    return res.status(401).type('html').send(renderLogin(params, 'E-mail ou senha incorretos.'));
  }

  const code = randomToken(32);
  const authCode = {
    accountId: account.accountId,
    clientId: String(params.client_id),
    redirectUri: validation.redirectUri,
    codeChallenge: String(params.code_challenge),
    resource: validation.resource,
    scope: validation.scope,
    expiresAt: Date.now() + 5 * 60 * 1000
  };

  await putState('state/oauth-codes/' + hash(code) + '.json', authCode);

  const target = new URL(validation.redirectUri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', String(params.state));
  target.searchParams.set('iss', BASE);

  res.statusCode = 302;
  res.setHeader('Location', target.toString());
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

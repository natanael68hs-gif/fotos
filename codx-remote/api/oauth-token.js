import crypto from 'node:crypto';
import { hash, randomToken, putState, getState, deleteState, json } from '../lib/state.js';

const BASE = 'https://codx-remote-zrider.vercel.app';
const RESOURCE = BASE + '/api/mcp';

async function readForm(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

function pkceS256(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

async function issueTokens(accountId, clientId, scope, resource) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(40);
  const now = Date.now();
  const access = {
    accountId,
    clientId,
    scope,
    resource,
    issuedAt: now,
    expiresAt: now + 60 * 60 * 1000
  };
  const refresh = {
    accountId,
    clientId,
    scope,
    resource,
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000
  };

  await Promise.all([
    putState('state/oauth-access/' + hash(accessToken) + '.json', access),
    putState('state/oauth-refresh/' + hash(refreshToken) + '.json', refresh)
  ]);

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const form = await readForm(req);
  const grantType = String(form.grant_type || '');

  if (grantType === 'authorization_code') {
    const code = String(form.code || '');
    const record = await getState('state/oauth-codes/' + hash(code) + '.json');
    if (!record) return json(res, 400, { error: 'invalid_grant' });
    if (Date.now() > Number(record.expiresAt || 0)) {
      await deleteState('state/oauth-codes/' + hash(code) + '.json');
      return json(res, 400, { error: 'invalid_grant' });
    }

    if (String(form.client_id || '') !== record.clientId) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (String(form.redirect_uri || '') !== record.redirectUri) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (String(form.resource || record.resource) !== record.resource || record.resource !== RESOURCE) {
      return json(res, 400, { error: 'invalid_target' });
    }

    const verifier = String(form.code_verifier || '');
    if (!verifier || pkceS256(verifier) !== record.codeChallenge) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    await deleteState('state/oauth-codes/' + hash(code) + '.json');
    return json(res, 200, await issueTokens(
      record.accountId,
      record.clientId,
      record.scope || 'codx.remote',
      record.resource
    ));
  }

  if (grantType === 'refresh_token') {
    const oldToken = String(form.refresh_token || '');
    const record = await getState('state/oauth-refresh/' + hash(oldToken) + '.json');
    if (!record || Date.now() > Number(record.expiresAt || 0)) {
      if (record) await deleteState('state/oauth-refresh/' + hash(oldToken) + '.json');
      return json(res, 400, { error: 'invalid_grant' });
    }

    if (String(form.client_id || '') !== record.clientId) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (String(form.resource || record.resource) !== record.resource || record.resource !== RESOURCE) {
      return json(res, 400, { error: 'invalid_target' });
    }

    await deleteState('state/oauth-refresh/' + hash(oldToken) + '.json');
    return json(res, 200, await issueTokens(
      record.accountId,
      record.clientId,
      record.scope || 'codx.remote',
      record.resource
    ));
  }

  return json(res, 400, { error: 'unsupported_grant_type' });
}

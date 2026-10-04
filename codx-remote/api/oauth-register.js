import { randomToken, putState, json, readBody } from '../lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const body = await readBody(req);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });

  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== 'https:') throw new Error('https_required');
    } catch {
      return json(res, 400, { error: 'invalid_redirect_uri' });
    }
  }

  const clientId = randomToken(24);
  const client = {
    clientId,
    redirectUris,
    clientName: String(body.client_name || 'MCP Client').slice(0,120),
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    createdAt: Date.now()
  };

  await putState('state/oauth-clients/' + clientId + '.json', client);

  return json(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    client_name: client.clientName,
    token_endpoint_auth_method: 'none',
    grant_types: client.grantTypes,
    response_types: client.responseTypes
  });
}

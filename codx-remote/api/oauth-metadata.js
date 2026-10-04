import { json } from '../lib/state.js';

const BASE = "https://codx-remote-zrider.vercel.app";

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  return json(res, 200, {
    issuer: BASE,
    authorization_endpoint: BASE + '/oauth/authorize',
    token_endpoint: BASE + '/oauth/token',
    registration_endpoint: BASE + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['codx.remote'],
    authorization_response_iss_parameter_supported: true
  });
}

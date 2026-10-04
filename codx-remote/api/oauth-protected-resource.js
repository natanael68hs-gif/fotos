import { json } from '../lib/state.js';

const BASE = "https://codx-remote-zrider.vercel.app";

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  return json(res, 200, {
    resource: BASE + '/api/mcp',
    authorization_servers: [BASE],
    scopes_supported: ['codx.remote'],
    bearer_methods_supported: ['header'],
    resource_name: 'Codx Remote'
  });
}

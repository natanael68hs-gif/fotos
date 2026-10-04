import crypto from 'node:crypto';
import { putState, getState, deleteState, json } from '../lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const id = crypto.randomUUID();
  const pathname = 'state/selftest/' + id + '.json';
  const sample = { ok: true, id, ts: Date.now(), text: 'codx-remote-state-test' };

  try {
    await putState(pathname, sample);
    const loaded = await getState(pathname);
    await deleteState(pathname);

    const ok = !!loaded && loaded.id === id && loaded.text === sample.text;
    return json(res, ok ? 200 : 500, {
      ok,
      storage: ok ? 'read-write-encrypted' : 'mismatch',
      version: '0.2.0'
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: String(error?.message || error)
    });
  }
}

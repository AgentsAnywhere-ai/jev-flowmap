import { put, drop } from './db.js';
import { requireSession } from './session.js';

// HTTP API. A developer's own program calls these against a documented contract.
export const routes = {
  'POST /api/signup': async (request) => {
    const { email } = await request.json();
    if (!email?.includes('@')) return json(400, { error: 'invalid_email' });
    const id = crypto.randomUUID();
    put(id, { id, email, plan: 'free' });
    put(`session:${id}`, { id, email, plan: 'free' });
    return json(201, { id }, { 'Set-Cookie': `session=${id}; HttpOnly` });
  },

  'GET /api/account': (request) => {
    const session = requireSession(request);
    if (!session.ok) return json(401, { error: session.reason });
    return json(200, session.account);
  },

  'DELETE /api/account': (request) => {
    const session = requireSession(request);
    if (!session.ok) return json(401, { error: session.reason });
    drop(session.account.id);
    return json(204, null);
  },
};

const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

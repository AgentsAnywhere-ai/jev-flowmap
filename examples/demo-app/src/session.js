import { get } from './db.js';

// Guard used by both the API and the account screen.
export function requireSession(request) {
  const token = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
  if (!token) return { ok: false, reason: 'no_session' };
  const account = get(`session:${token}`);
  if (!account) return { ok: false, reason: 'expired' };
  return { ok: true, account };
}

// Password hashing, session tokens, cookies and rate limiting.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { run } from './db.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'td_session';
export const SESSION_DAYS = 30;

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const newId = () => crypto.randomBytes(9).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('base64url') + '$' + key.toString('base64url');
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), 64);
  const expected = Buffer.from(hash, 'base64url');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Constant-time string comparison (hashes both sides so lengths match).
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

// ---------- Cookies ----------

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(request, token, maxAgeSec) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

// ---------- Request guards ----------

export function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd && fwd.split(',')[0].trim()) || request.headers.get('x-real-ip') || 'unknown';
}

// Reject cross-site writes: the browser always sends Origin on POST.
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// ---------- Rate limiting ----------

// Cheap per-instance limiter for high-volume reads. Serverless instances come
// and go, so this only blunts bursts; it costs no database work at all.
const memHits = new Map();
export function memLimit(key, max, windowMs) {
  const now = Date.now();
  let e = memHits.get(key);
  if (!e || e.reset <= now) {
    if (memHits.size > 5000) memHits.clear();
    e = { count: 0, reset: now + windowMs };
    memHits.set(key, e);
  }
  return ++e.count <= max;
}

// Durable fixed-window limiter shared by all instances. One row write per
// call, so it's reserved for logins and writes.
export async function dbLimit(key, max, windowMs) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const r = await run(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
    [key, windowStart],
  );
  return Number(r.rows[0].count) <= max;
}

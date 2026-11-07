import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail } from './local.ts';

const cookieName = '__Secure-paparazzi-admin';
const ttl = 90 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
let loadedFor = '';
function sessionFile() { return resolve(process.env.ADMIN_SESSIONS_FILE || 'data/admin-sessions.json'); }
function loadSessions() {
  const identity = sessionFile() + ':' + digest(process.env.ADMIN_ACCESS_TOKEN || '');
  if (loadedFor === identity) return;
  sessions.clear();
  try {
    const stored = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (stored.identity === digest(process.env.ADMIN_ACCESS_TOKEN || '') && Array.isArray(stored.sessions)) {
      for (const entry of stored.sessions) {
        if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && typeof entry[1] === 'number' && entry[1] > Date.now()) sessions.set(entry[0], entry[1]);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  loadedFor = identity;
}
function saveSessions() {
  const file = sessionFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + '.tmp', JSON.stringify({ identity: digest(process.env.ADMIN_ACCESS_TOKEN || ''), sessions: [...sessions] }), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
let failures = 0, windowStarted = 0;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const adminConfigured = () => {
  const token = process.env.ADMIN_ACCESS_TOKEN;
  return !!token && token.length >= 24 && token.length <= 256 && token !== process.env.ANTHROPIC_API_KEY;
};
function sessionKey(req: IncomingMessage) {
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : '';
}
export function isAdmin(req: IncomingMessage) {
  loadSessions();
  if (!adminConfigured()) return false;
  const key = sessionKey(req);
  if ((sessions.get(key) ?? 0) > Date.now()) return true;
  sessions.delete(key); return false;
}
export const adminOrigins = () => (process.env.ADMIN_ORIGINS || 'https://h.joun.cc').split(',').map(value => value.trim()).filter(Boolean);
export function requireAdminOrigin(req: IncomingMessage) {
  if (!adminOrigins().includes(req.headers.origin || '')) fail('공개 사이트의 관리자 화면에서 요청하세요.', 403);
}
export async function adminRoutes(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!['/api/admin/login', '/api/admin/logout'].includes(path)) return false;
  if (req.method !== 'POST') fail('POST 요청이 필요합니다.', 405);
  requireAdminOrigin(req);
  if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON 요청이 필요합니다.', 415);
  const send = (value: unknown) => { res.writeHead(200); res.end(JSON.stringify(value)); return true; };
  loadSessions();
  if (path === '/api/admin/logout') {
    sessions.delete(sessionKey(req));
    saveSessions();
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return send({ authenticated: false });
  }
  if (!adminConfigured()) fail('서버의 ADMIN_ACCESS_TOKEN 설정이 필요합니다.', 503);
  if (Date.now() - windowStarted >= 60000) { failures = 0; windowStarted = Date.now(); }
  if (failures >= 5) { res.setHeader('Retry-After', '60'); fail('인증 시도가 많습니다. 1분 뒤 다시 시도하세요.', 429); }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 1024) fail('입력이 너무 큽니다.', 413);
  }
  let input;
  try { input = JSON.parse(raw); } catch { fail('올바른 JSON 입력이 필요합니다.'); }
  const actual = typeof input?.token === 'string' && input.token.length <= 256 ? input.token : '';
  if (!timingSafeEqual(Buffer.from(digest(actual), 'hex'), Buffer.from(digest(process.env.ADMIN_ACCESS_TOKEN!), 'hex'))) {
    failures++; fail('관리자 접근 코드가 올바르지 않습니다.', 401);
  }
  failures = 0;
  for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
  sessions.delete(sessionKey(req));
  if (sessions.size >= 20) sessions.delete(sessions.keys().next().value!);
  const token = randomBytes(32).toString('hex');
  sessions.set(digest(token), Date.now() + ttl);
  saveSessions();
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl / 1000}`);
  return send({ authenticated: true });
}

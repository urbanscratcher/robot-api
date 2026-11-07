import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail, localFetch } from './local.ts';
import { adminOrigins, isAdmin, requireAdminOrigin } from './admin.ts';

const root = resolve(process.env.INSTAGRAM_AUTH_DIR || 'data/instagram');
const callbackPath = '/api/instagram/callback';
const cookieName = 'overheard_instagram_flow';
const ttl = 10 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type Account = { id: string; username: string };
export type InstagramConnection = { token: string; userId: string; version: string; host: 'graph.facebook.com' | 'graph.instagram.com'; secret?: string };
type Grant = { token: string; accounts: Account[]; selectedId: string | null; expiresAt: number | null; fingerprint: string };
type Flow = { bindingHash: string; completionHash?: string; createdAt: number; fingerprint: string; returnTo: string; code?: string; denied?: boolean };
const flowFile = (state: string, stage: string) => join(root, `${state}.${stage}.json`);
export function oauthConfig() {
  const { META_APP_ID: appId, META_APP_SECRET: secret, INSTAGRAM_CONFIG_ID: configId, INSTAGRAM_API_VERSION: version } = process.env;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI || `http://localhost:5174${callbackPath}`;
  let url: URL; try { url = new URL(redirectUri); } catch { return null; }
  if (!appId || !/^\d+$/.test(appId) || !secret || !configId || !/^\d+$/.test(configId) || !version || !/^v\d+\.\d+$/.test(version) || url.pathname !== callbackPath || url.search || url.hash || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
  return { appId, secret, configId, version, redirectUri, fingerprint: digest(JSON.stringify([appId, configId, version, redirectUri])) };
}
async function storeGrant(grant: Grant) {
  const config = oauthConfig(); if (!config) fail('Meta 앱 설정이 필요합니다.', 503);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(`overheard-instagram:${config.secret}`).digest();
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant)), cipher.final()]);
  const temp = join(root, `${randomBytes(16).toString('hex')}.tmp`);
  await writeFile(temp, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }), { mode: 0o600 });
  await rename(temp, join(root, 'connection.json'));
}
async function readGrant(): Promise<Grant | null> {
  const config = oauthConfig(); if (!config) return null;
  let raw: string;
  try { raw = await readFile(join(root, 'connection.json'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const box = JSON.parse(raw);
    const key = createHash('sha256').update(`overheard-instagram:${config.secret}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
    const grant: Grant = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'hex')), decipher.final()]).toString());
    return grant.fingerprint === config.fingerprint ? grant : null;
  } catch { return null; }
}
export async function getInstagramConnection(): Promise<InstagramConnection | null> {
  const { INSTAGRAM_SYSTEM_USER_ACCESS_TOKEN: systemToken, INSTAGRAM_SYSTEM_USER_ID: systemUserId, INSTAGRAM_API_VERSION: systemVersion } = process.env;
  if (systemToken && systemUserId && /^\d+$/.test(systemUserId) && systemVersion && /^v\d+\.\d+$/.test(systemVersion)) {
    return { token: systemToken, userId: systemUserId, version: systemVersion, host: 'graph.facebook.com', secret: process.env.META_APP_SECRET };
  }
  const config = oauthConfig();
  if (config) {
    const grant = await readGrant();
    if (!grant?.selectedId || grant.expiresAt && grant.expiresAt <= Date.now()) return null;
    return { token: grant.token, userId: grant.selectedId, version: config.version, host: 'graph.facebook.com', secret: config.secret };
  }
  // Previously configured Instagram Login accounts retain their original host.
  const { INSTAGRAM_ACCESS_TOKEN: token, INSTAGRAM_USER_ID: userId, INSTAGRAM_API_VERSION: version } = process.env;
  return token && userId && /^\d+$/.test(userId) && version && /^v\d+\.\d+$/.test(version) ? { token, userId, version, host: 'graph.instagram.com' } : null;
}
export async function instagramStatus() {
  const config = oauthConfig();
  const grant = await readGrant();
  const expired = !!(grant?.expiresAt && grant.expiresAt <= Date.now());
  const connection = await getInstagramConnection();
  const systemConfigured = !!(process.env.INSTAGRAM_SYSTEM_USER_ACCESS_TOKEN && process.env.INSTAGRAM_SYSTEM_USER_ID);
  return { configured: !!connection, oauthReady: !!config, redirectUri: config?.redirectUri ?? process.env.INSTAGRAM_REDIRECT_URI ?? `http://localhost:5174${callbackPath}`, accounts: expired || systemConfigured ? [] : grant?.accounts ?? [], selectedId: systemConfigured ? connection?.userId ?? null : grant?.selectedId ?? connection?.userId ?? null, expired: systemConfigured ? false : expired, mode: systemConfigured ? 'system-user' : config ? 'unified' : 'instagram', missing: [!process.env.META_APP_ID && 'META_APP_ID', !process.env.META_APP_SECRET && 'META_APP_SECRET', !process.env.INSTAGRAM_CONFIG_ID && 'INSTAGRAM_CONFIG_ID', !process.env.INSTAGRAM_API_VERSION && 'INSTAGRAM_API_VERSION'].filter(Boolean) };
}
export async function instagramGraph(config: InstagramConnection, path: string, params?: Record<string, string>) {
  const url = new URL(`https://${config.host}/${config.version}/${path}`);
  const proof = config.secret ? createHmac('sha256', config.secret).update(config.token).digest('hex') : undefined;
  if (!params && proof) url.searchParams.set('appsecret_proof', proof);
  let response: Response;
  try {
    response = await localFetch(url.toString(), {
      method: params ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}` },
      ...(params ? { body: new URLSearchParams({ ...params, ...(proof ? { appsecret_proof: proof } : {}) }) } : {}),
    }, 30000);
  } catch { fail('Meta 서버 연결 실패 또는 시간 초과입니다.', 502); }
  let data; try { data = await response.json(); } catch { fail('Meta 응답을 읽지 못했습니다.', 502); }
  if (!response.ok || data.error) fail(`인스타그램 요청 실패 (${response.status}, code ${data.error?.code ?? 'unknown'}). 계정 권한·토큰·공개 이미지 URL을 확인하세요.`, 502);
  return data;
}
async function jsonBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON 요청이 필요합니다.', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) fail('요청이 너무 큽니다.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { fail('올바른 JSON 객체가 필요합니다.'); }
}
function flowCookie(req: IncomingMessage) {
  const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!raw || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(raw)) return null;
  const [state, binding] = raw.split('.'); return { state, binding };
}
function clearCookie(res: ServerResponse) { res.setHeader('Set-Cookie', `${cookieName}=; Path=/api/instagram; HttpOnly; SameSite=Lax; Max-Age=0`); }
async function readFlow(state: string, stage: string): Promise<Flow | null> {
  try { return JSON.parse(await readFile(flowFile(state, stage), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
function checkFlow(flow: Flow) {
  const config = oauthConfig();
  if (!config || flow.fingerprint !== config.fingerprint || Date.now() - flow.createdAt > ttl) fail('로그인 요청이 만료되었거나 설정이 변경되었습니다. 검토 화면에서 다시 연결하세요.');
  return config;
}
function callbackPage(res: ServerResponse, flow: Flow, state: string, completion: string, denied: boolean) {
  const returnUrl = new URL(flow.returnTo);
  returnUrl.searchParams.set('instagram_flow', `${state}.${completion}`);
  returnUrl.hash = 'monitor-admin';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.writeHead(200);
  res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>인스타그램 연결</title><h1>${denied ? '로그인이 취소되었습니다.' : '로그인 응답을 받았습니다.'}</h1><p>시작한 기기의 모니터로 돌아가 연결을 완료하세요.</p><a href="${returnUrl.toString()}">모니터로 돌아가기</a></html>`);
}
export async function instagramRoutes(req: IncomingMessage, res: ServerResponse, publicRequest = false) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/instagram/')) return false;
  const send = (value: unknown) => { res.writeHead(200); res.end(JSON.stringify(value)); return true; };
  if (url.pathname === callbackPath && req.method === 'GET') {
    const stateValue = url.searchParams.get('state') ?? '';
    const stateParts = /^([a-f0-9]{64})(?:\.([a-f0-9]{64}))?$/.exec(stateValue);
    if (!stateParts) fail('유효하지 않은 로그인 응답입니다.');
    const state = stateParts[1]; const completion = stateParts[2] ?? '';
    const flow = await readFlow(state, 'pending');
    if (!flow) fail('이미 처리했거나 유효하지 않은 로그인 응답입니다.');
    checkFlow(flow);
    const code = url.searchParams.get('code');
    const denied = !!url.searchParams.get('error');
    if (!denied && (!code || code.length > 8192)) fail('로그인 인증 코드가 없습니다.');
    // Atomic claim also prevents two local/public API processes consuming one callback.
    const claim = flowFile(state, 'callback');
    try { await rename(flowFile(state, 'pending'), claim); } catch { fail('이미 처리한 로그인 응답입니다.', 409); }
    try { await writeFile(flowFile(state, 'returned'), JSON.stringify({ ...flow, ...(denied ? { denied: true } : { code }) }), { mode: 0o600, flag: 'wx' }); }
    finally { await unlink(claim).catch(() => {}); }
    // New flows carry the completion secret in the OAuth state suffix. Keep old
    // pending flows working through their browser cookie during rolling deploys.
    callbackPage(res, flow, state, completion, denied); return true;
  }
  if (publicRequest) {
    if (!isAdmin(req)) fail('관리자 인증 후 인스타그램 연결을 관리할 수 있습니다.', 403);
    requireAdminOrigin(req);
  }
  if (req.method !== 'POST') fail('지원하지 않는 요청입니다.', 405);
  const input = await jsonBody(req);
  if (url.pathname === '/api/instagram/connect') {
    const config = oauthConfig(); if (!config) fail('META_APP_ID·META_APP_SECRET·INSTAGRAM_CONFIG_ID·INSTAGRAM_API_VERSION 설정을 확인하세요.', 503);
    if (![...(publicRequest ? adminOrigins() : ['http://localhost:5174', 'http://127.0.0.1:5174'])].includes(req.headers.origin ?? '')) fail('모니터의 관리자 영역에서 연결을 시작하세요.', 403);
    const state = randomBytes(32).toString('hex'); const binding = randomBytes(32).toString('hex'); const completion = randomBytes(32).toString('hex');
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(root)) {
      if (!/^[a-f0-9]{64}\.(pending|returned)\.json$/.test(name)) continue;
      try {
        const saved = JSON.parse(await readFile(join(root, name), 'utf8')) as Flow;
        if (Date.now() - saved.createdAt > ttl) await unlink(join(root, name));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const old = flowCookie(req);
    if (old) { await unlink(flowFile(old.state, 'pending')).catch(() => {}); await unlink(flowFile(old.state, 'returned')).catch(() => {}); }
    await writeFile(flowFile(state, 'pending'), JSON.stringify({ bindingHash: digest(binding), completionHash: digest(completion), createdAt: Date.now(), fingerprint: config.fingerprint, returnTo: `${req.headers.origin}${publicRequest ? '/admin/' : '/'}` } satisfies Flow), { mode: 0o600, flag: 'wx' });
    res.setHeader('Set-Cookie', `${cookieName}=${state}.${binding}; Path=/api/instagram; HttpOnly; SameSite=Lax; Max-Age=600${publicRequest ? '; Secure' : ''}`);
    const login = new URL(`https://www.facebook.com/${config.version}/dialog/oauth`);
    login.search = new URLSearchParams({ client_id: config.appId, config_id: config.configId, redirect_uri: config.redirectUri, response_type: 'code', override_default_response_type: 'true', state: `${state}.${completion}` }).toString();
    return send({ url: login.toString() });
  }
  if (url.pathname === '/api/instagram/complete') {
    const cookie = flowCookie(req);
    const fallback = typeof input.flow === 'string' && /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(input.flow);
    const identity = cookie ?? (fallback ? { state: fallback[1], binding: fallback[2] } : null);
    if (!identity) return send({ status: 'idle' });
    const flow = await readFlow(identity.state, 'returned');
    if (!flow) {
      const pending = await readFlow(identity.state, 'pending');
      if (pending) { checkFlow(pending); return send({ status: 'pending' }); }
      clearCookie(res); return send({ status: 'idle' });
    }
    const cookieMatches = !!cookie && equal(flow.bindingHash, digest(cookie.binding));
    const fallbackMatches = !!fallback && !!flow.completionHash && equal(flow.completionHash, digest(fallback[2]));
    if (!cookieMatches && !fallbackMatches) fail('로그인을 시작한 브라우저에서 완료하세요.', 403);
    const config = checkFlow(flow);
    const claim = flowFile(identity.state, 'consuming');
    try { await rename(flowFile(identity.state, 'returned'), claim); } catch { return send({ status: 'processing' }); }
    if (cookie) clearCookie(res);
    try {
      if (flow.denied) fail('인스타그램 로그인을 취소했습니다. 다시 연결할 수 있습니다.');
      let response: Response;
      try {
        response = await localFetch(`https://graph.facebook.com/${config.version}/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ client_id: config.appId, client_secret: config.secret, redirect_uri: config.redirectUri, code: flow.code! }) }, 30000);
      } catch { fail('Meta 토큰 교환 연결 실패. 다시 로그인하세요.', 502); }
      let result; try { result = await response.json(); } catch { fail('Meta 토큰 응답을 읽지 못했습니다.', 502); }
      if (!response.ok || typeof result.access_token !== 'string' || !result.access_token) fail(`Meta 토큰 교환 실패 (code ${result.error?.code ?? 'unknown'}). App ID·시크릿·Redirect URL을 확인하고 다시 로그인하세요.`, 502);
      const graphConfig: InstagramConnection = { token: result.access_token, userId: '', host: 'graph.facebook.com', secret: config.secret, version: config.version };
      const accounts: Account[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ fields: 'id,username', limit: '100', ...(after ? { after } : {}) });
        const list = await instagramGraph(graphConfig, `me/assigned_instagram_accounts?${params}`);
        if (!Array.isArray(list.data)) fail('인스타그램 계정 목록을 읽지 못했습니다.', 502);
        for (const account of list.data) {
          if (typeof account.id === 'string' && /^\d+$/.test(account.id) && typeof account.username === 'string' && !accounts.some(a => a.id === account.id)) accounts.push({ id: account.id, username: account.username });
        }
        if (!list.paging?.next) break;
        after = list.paging?.cursors?.after;
        if (!after || page === 19) fail('계정 목록을 모두 읽지 못했습니다. 공유 계정 수를 줄인 뒤 다시 연결하세요.', 502);
      }
      if (!accounts.length) fail('공유된 Instagram 계정이 없습니다. 비즈니스 포트폴리오에서 계정을 선택하고 게시 권한을 승인한 뒤 다시 연결하세요. 기존 연결은 유지됩니다.');
      const expiresAt = typeof result.expires_in === 'number' && result.expires_in > 0 ? Date.now() + result.expires_in * 1000 : null;
      await storeGrant({ token: result.access_token, accounts, selectedId: accounts.length === 1 ? accounts[0].id : null, expiresAt, fingerprint: config.fingerprint });
      return send({ status: 'connected' });
    } finally { await unlink(claim).catch(() => {}); }
  }
  if (url.pathname === '/api/instagram/account') {
    const grant = await readGrant();
    if (!grant || grant.expiresAt && grant.expiresAt <= Date.now()) fail('인스타그램을 다시 연결하세요.', 409);
    if (!grant.accounts.some(a => a.id === input.userId)) fail('로그인으로 승인한 계정만 선택할 수 있습니다.');
    grant.selectedId = input.userId; await storeGrant(grant); return send({ selectedId: grant.selectedId });
  }
  fail('경로를 찾을 수 없습니다.', 404);
}

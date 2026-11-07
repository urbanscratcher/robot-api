import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('Unified OAuth: browser binding, one-time callback, encrypted grant, account selection and Graph host', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overheard-instagram-'));
  Object.assign(process.env, { INSTAGRAM_AUTH_DIR: dir, META_APP_ID: '123', META_APP_SECRET: 'test-secret', INSTAGRAM_CONFIG_ID: '456', INSTAGRAM_API_VERSION: 'v26.0', INSTAGRAM_REDIRECT_URI: 'https://n.joun.cc/api/instagram/callback' });
  const { instagramRoutes, instagramStatus, getInstagramConnection, instagramGraph } = await import('./instagram.ts');
  const nativeFetch = globalThis.fetch;
  let exchangeCount = 0, assigned: unknown[] = [{ id: '1001', username: 'first' }, { id: '1002', username: 'second' }];
  let failExchange = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const value = new URL(String(url));
    if (value.hostname !== 'graph.facebook.com') return nativeFetch(url, init);
    if (value.pathname.endsWith('/oauth/access_token')) {
      exchangeCount++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'), 'test-secret');
      assert.equal(body.get('redirect_uri'), process.env.INSTAGRAM_REDIRECT_URI);
      assert.equal(body.get('code'), 'test-code');
      if (failExchange) return Response.json({ error: { code: 190, message: 'test-secret provider message should be hidden' } }, { status: 400 });
      return Response.json({ access_token: 'private-system-token', expires_in: 3600 });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-system-token');
    if (value.pathname.endsWith('/assigned_instagram_accounts')) {
      assert.ok(value.searchParams.get('appsecret_proof'));
      return Response.json({ data: assigned });
    }
    assert.equal(value.pathname, '/v26.0/1002/media');
    assert.equal(new URLSearchParams(String(init?.body)).get('caption'), 'reviewed');
    return Response.json({ id: 'container' });
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try { await instagramRoutes(req, res, req.headers['x-public'] === '1'); }
    catch (e) { res.writeHead((e as { status?: number }).status ?? 500); res.end(JSON.stringify({ error: (e as Error).message })); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(path: string, options: { cookie?: string; public?: boolean; get?: boolean; body?: unknown } = {}) {
    const response = await nativeFetch(base + path, { method: options.get ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5174', ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.public ? { 'X-Public': '1' } : {}) }, ...(options.get ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data };
  }
  async function begin() {
    const response = await call('/api/instagram/connect'); assert.equal(response.status, 200);
    const url = new URL(response.data.url);
    assert.equal(url.origin, 'https://www.facebook.com');
    assert.equal(url.searchParams.get('config_id'), '456');
    assert.equal(url.searchParams.has('scope'), false);
    assert.equal(url.searchParams.get('override_default_response_type'), 'true');
    assert.equal(url.searchParams.get('redirect_uri'), process.env.INSTAGRAM_REDIRECT_URI);
    return { state: url.searchParams.get('state')!, cookie: response.cookie! };
  }
  const callback = (state: string, extra = 'code=test-code') => call(`/api/instagram/callback?state=${state}&${extra}`, { get: true, public: true });
  try {
    assert.equal((await instagramStatus()).configured, false);
    assert.equal((await call('/api/instagram/connect', { public: true })).status, 403);
    assert.equal((await call('/api/instagram/callback?state=bad&code=test-code', { get: true, public: true })).status, 400);
    const flow = await begin();
    assert.equal((await call('/api/instagram/complete', { cookie: flow.cookie })).data.status, 'pending');
    const received = await callback(flow.state); assert.equal(received.status, 200);
    assert.doesNotMatch(received.data, /test-code|private-system-token/);
    assert.ok(received.data.includes('href="http://localhost:5174/#monitor-admin"'));
    assert.equal(exchangeCount, 0, 'public callback must never exchange or expose tokens');
    assert.equal((await call('/api/instagram/complete')).data.status, 'idle');
    const forged = flow.cookie.split('.')[0] + '.' + '0'.repeat(64);
    assert.equal((await call('/api/instagram/complete', { cookie: forged })).status, 403);
    assert.equal((await call('/api/instagram/complete', { cookie: flow.cookie })).data.status, 'connected');
    assert.equal((await callback(flow.state)).status, 400);
    assert.equal((await call('/api/instagram/complete', { cookie: flow.cookie })).data.status, 'idle');
    assert.equal(exchangeCount, 1);
    const status = await instagramStatus();
    assert.equal(status.accounts.length, 2); assert.equal(status.configured, false);
    assert.doesNotMatch(JSON.stringify(status), /private-system-token|test-secret/);
    assert.doesNotMatch(await readFile(join(dir, 'connection.json'), 'utf8'), /private-system-token|test-secret/);
    assert.equal((await call('/api/instagram/account', { body: { userId: '9999' } })).status, 400);
    assert.equal((await call('/api/instagram/account', { body: { userId: '1002' } })).status, 200);
    const connected = await getInstagramConnection(); assert.equal(connected?.host, 'graph.facebook.com');
    assert.equal(connected?.userId, '1002');
    assert.equal((await instagramGraph(connected!, '1002/media', { caption: 'reviewed' })).id, 'container');
    assert.equal((await instagramStatus()).configured, true);
    const denied = await begin(); await callback(denied.state, 'error=access_denied');
    assert.equal((await call('/api/instagram/complete', { cookie: denied.cookie })).status, 400);
    assert.equal((await instagramStatus()).selectedId, '1002');
    assigned = [];
    const empty = await begin(); await callback(empty.state);
    assert.equal((await call('/api/instagram/complete', { cookie: empty.cookie })).status, 400);
    assert.equal((await instagramStatus()).selectedId, '1002', 'failed reconnection preserves the existing grant');
    failExchange = true;
    const bad = await begin(); await callback(bad.state);
    const failed = await call('/api/instagram/complete', { cookie: bad.cookie });
    assert.equal(failed.status, 502); assert.doesNotMatch(JSON.stringify(failed.data), /test-secret/);
    failExchange = false; assigned = [{ id: '1001', username: 'first' }];
    const single = await begin(); await callback(single.state);
    assert.equal((await call('/api/instagram/complete', { cookie: single.cookie })).status, 200);
    assert.equal((await instagramStatus()).selectedId, '1001');
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 3600001);
    assert.equal((await instagramStatus()).expired, true);
    assert.equal(await getInstagramConnection(), null);
    assert.equal((await readdir(dir)).filter(n => n.endsWith('.consuming.json') || n.endsWith('.returned.json')).length, 0);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
    t.mock.restoreAll();
  }
});

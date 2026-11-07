import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('public administrator login gates administrator operations, uses private session cookies, rejects CSRF and revokes logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paparazzi-admin-'));
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const adminToken = 'synthetic-admin-code-at-least-24-characters';
  const apiKey = 'synthetic-claude-key-never-returned';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    env: { ...process.env, API_PORT: String(port), ADMIN_SESSIONS_FILE: join(dir, 'admin-sessions.json'), TEXT_PROVIDER: 'ollama', ANTHROPIC_API_KEY: apiKey, ADMIN_ACCESS_TOKEN: adminToken, AI_SETTINGS_FILE: join(dir, 'settings.json'), AUTOMATION_STATE_FILE: join(dir, 'automation.json'), PUBLICATIONS_DIR: join(dir, 'publications'), INSTAGRAM_AUTH_DIR: join(dir, 'instagram') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, value?: unknown, cookie = '', origin: string | undefined = 'https://n.joun.cc') => fetch(base + path, {
    method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Overheard-Public': '1', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await call('/api/ai-settings')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, logs);
    const initial = await (await call('/api/ai-settings')).json();
    assert.equal(initial.editable, false); assert.equal(initial.adminAvailable, true); assert.equal(initial.enabled, true);
    assert.equal((await call('/api/ai-settings', { enabled: true })).status, 403);
    assert.equal((await call('/api/admin/login', { token: adminToken }, '', '')).status, 403);
    assert.equal((await call('/api/admin/login', { token: 'wrong' })).status, 401);
    assert.equal((await call('/api/publishing/status')).status, 403);
    assert.equal((await call('/api/publishing/restart', {})).status, 403);
    assert.equal((await call('/api/observations/missing/publish', { revision: 0 })).status, 403);
    assert.equal((await call('/api/publishing/piezo', { piezoLevel: 1 })).status, 403);
    const login = await call('/api/admin/login', { token: adminToken });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=7776000']) assert.ok(setCookie.includes(flag));
    const loginBody = await login.text(); assert.ok(!loginBody.includes(adminToken)); assert.ok(!loginBody.includes(apiKey));
    const cookie = setCookie.split(';')[0];
    const stored = await readFile(join(dir, 'admin-sessions.json'), 'utf8');
    assert.ok(!stored.includes(cookie.split('=')[1]));
    assert.ok(!stored.includes(adminToken));
    const restored = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', "import { isAdmin } from './server/admin.ts'; process.exit(isAdmin({ headers: { cookie: process.env.TEST_ADMIN_COOKIE } }) ? 0 : 1)"], {
      env: { ...process.env, ADMIN_ACCESS_TOKEN: adminToken, ADMIN_SESSIONS_FILE: join(dir, 'admin-sessions.json'), TEST_ADMIN_COOKIE: cookie }, encoding: 'utf8',
    });
    assert.equal(restored.status, 0, restored.stderr);

    assert.equal((await (await call('/api/ai-settings', undefined, cookie)).json()).editable, true);
    assert.equal((await call('/api/ai-settings', { enabled: true }, cookie, '')).status, 403);
    assert.equal((await call('/api/ai-settings', { enabled: true }, cookie, 'https://example.com')).status, 403);
    assert.equal((await call('/api/publishing/status', undefined, cookie)).status, 200);
    assert.equal((await call('/api/publishing/restart', {}, cookie, '')).status, 403);
    assert.equal((await call('/api/publishing/restart', undefined, cookie)).status, 405);
    assert.equal((await call('/api/publishing/piezo', { piezoLevel: 1 }, cookie, '')).status, 403);
    assert.equal((await call('/api/publishing/piezo', { piezoLevel: 1 }, cookie, 'https://example.com')).status, 403);
    assert.equal((await call('/api/publishing/piezo', { piezoLevel: 3 }, cookie)).status, 400);
    const piezo = await call('/api/publishing/piezo', { piezoLevel: 2 }, cookie);
    assert.equal(piezo.status, 200);
    assert.equal((await piezo.json()).level, 2);
    const cleared = await call('/api/publishing/piezo', { piezoLevel: 0 }, cookie);
    assert.deepEqual(await cleared.json(), { level: 0, expiresAt: null });
    const restart = await call('/api/publishing/restart', {}, cookie);
    assert.equal(restart.status, 200);
    assert.equal((await restart.json()).automation.accepting, true);
    assert.equal((await call('/api/observations', undefined, cookie)).status, 200);
    assert.equal((await call('/api/observations/missing/publish', { revision: 0 }, cookie)).status, 404);
    assert.equal((await call('/api/observations/missing/publish', { revision: 0 }, cookie, '')).status, 403);
    assert.equal((await call('/api/instagram/complete', {}, cookie)).status, 200);
    assert.equal((await call('/api/creations', {}, cookie)).status, 400);
    assert.equal((await call('/api/sessions', undefined, cookie)).status, 403);
    assert.equal((await call('/api/ai-settings', { enabled: false }, cookie)).status, 400);
    const changed = await call('/api/ai-settings', { enabled: true }, cookie);
    assert.equal(changed.status, 200); const body = await changed.text();
    assert.equal(JSON.parse(body).enabled, true); assert.ok(!body.includes(apiKey)); assert.ok(!body.includes(adminToken));
    assert.equal((await call('/api/admin/logout', {}, cookie)).status, 200);
    assert.equal((await (await call('/api/ai-settings', undefined, cookie)).json()).editable, false);
    assert.equal((await call('/api/ai-settings', { enabled: false }, cookie)).status, 403);
    assert.equal((await call('/api/publishing/status', undefined, cookie)).status, 403);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await call('/api/admin/login', { token: 'wrong' })).status, 401);
    assert.equal((await call('/api/admin/login', { token: adminToken })).status, 429);
    assert.ok(!logs.includes(apiKey)); assert.ok(!logs.includes(adminToken));
  } finally {
    const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await closed;
    await rm(dir, { recursive: true, force: true });
  }
});

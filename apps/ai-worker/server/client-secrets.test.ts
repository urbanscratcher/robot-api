import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('client build guard rejects leaked secrets and env files without printing their values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'client-secret-check-'));
  const script = fileURLToPath(new URL('../scripts/check-client-secrets.mjs', import.meta.url));
  const fake = 'synthetic-private-test-key-123456';
  const run = (extra = {}) => spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, ANTHROPIC_API_KEY: fake, ...extra }, encoding: 'utf8' });
  try {
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'app.js'), 'console.log("hello")');
    assert.equal(run().status, 0);
    await writeFile(join(dir, 'dist', 'app.js'), `const leaked = "${fake}";`);
    const leaked = run(); assert.equal(leaked.status, 1); assert.ok(leaked.stderr.includes('dist/app.js')); assert.ok(!leaked.stderr.includes(fake));
    await writeFile(join(dir, 'dist', 'app.js'), 'console.log("hello")');
    await writeFile(join(dir, 'dist', '.env'), 'EMPTY=');
    assert.equal(run().status, 1);
    await rm(join(dir, 'dist', '.env'));
    const exposed = run({ VITE_ANTHROPIC_API_KEY: fake });
    assert.equal(exposed.status, 1); assert.ok(!exposed.stderr.includes(fake));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

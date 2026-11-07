import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piezoStatus, receivePiezoLevel, setPiezoLevel } from './piezo.ts';

test('sensor levels hold for five minutes from the latest signal, ignore idle readings and expire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paparazzi-piezo-'));
  const previous = process.env.PUBLICATIONS_DIR;
  process.env.PUBLICATIONS_DIR = root;
  try {
    assert.deepEqual(await piezoStatus(0), { level: 0, expiresAt: null });
    assert.throws(() => receivePiezoLevel('1'), /piezoLevel/);
    assert.throws(() => receivePiezoLevel(3), /piezoLevel/);
    assert.deepEqual(await receivePiezoLevel(1, 1000), { level: 1, expiresAt: 301000 });
    assert.equal((await piezoStatus(300999)).level, 1);
    assert.deepEqual(await piezoStatus(301000), { level: 0, expiresAt: null });
    assert.deepEqual(await receivePiezoLevel(0, 2000), { level: 1, expiresAt: 301000 });
    assert.deepEqual(await receivePiezoLevel(2, 200000), { level: 2, expiresAt: 500000 });
    assert.equal((await piezoStatus(301000)).level, 2);
    assert.deepEqual(await receivePiezoLevel(2, 400000), { level: 2, expiresAt: 700000 });
    await Promise.all([receivePiezoLevel(1, 500000), receivePiezoLevel(2, 500001)]);
    assert.deepEqual(await piezoStatus(600000), { level: 2, expiresAt: 800001 });
    assert.deepEqual(await piezoStatus(800001), { level: 0, expiresAt: null });
    assert.deepEqual(await setPiezoLevel(1, 900000), { level: 1, expiresAt: 1200000 });
    assert.deepEqual(await setPiezoLevel(0, 900001), { level: 0, expiresAt: null });
    assert.deepEqual(await piezoStatus(900002), { level: 0, expiresAt: null });
    assert.throws(() => setPiezoLevel(3), /piezoLevel/);
  } finally {
    if (previous === undefined) delete process.env.PUBLICATIONS_DIR; else process.env.PUBLICATIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

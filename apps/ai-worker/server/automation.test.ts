import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('server pairs fresh inputs, rejects busy uploads without reading, and halts on uncertain publication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'automation-'));
  process.env.AUTOMATION_STATE_FILE = join(dir, 'state.json');
  process.env.TRANSCRIPTS_DATA_DIR = join(dir, 'transcripts');
  const previousPublications = process.env.PUBLICATIONS_DIR;
  process.env.PUBLICATIONS_DIR = join(dir, 'publications');
  const { setPiezoLevel, piezoStatus } = await import('./piezo.ts');
  const { receiveAutomatic, automationStatus, setAutomationRunner, resumeAutomation, restartAutomation } = await import('./automation.ts');
  const { saveTranscript, receivedTranscripts } = await import('./transcript-store.ts');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const elapse = async () => { t.mock.timers.tick(10_000); await delay(30); };
  const finalText = async (interactionId: string, text: string) => {
    const receipt = await saveTranscript(text, { interactionId, startedAt: '2026-11-07T00:00:00.000Z', endedAt: '2026-11-07T00:00:20.000Z' });
    return receiveAutomatic('text', async () => receipt);
  };
  let finish!: () => void;
  let count = 0;
  setAutomationRunner(async pair => {
    count++; assert.equal(pair.photoId, 'photo-1'); assert.equal(pair.text, 'hello');
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const waitFor = async (status: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await automationStatus()).status === status) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`Did not reach ${status}`);
  };
  try {
    await setPiezoLevel(2);
    await finalText('photo-1', 'hello');
    let read = false;
    await receiveAutomatic('photo', async () => ({ id: 'photo-1' }));
    assert.equal((await automationStatus()).status, 'waiting');
    await elapse();
    assert.equal((await automationStatus()).status, 'processing');
    for (const kind of ['photo', 'text'] as const) {
      await assert.rejects(receiveAutomatic(kind, async () => { read = true; return { id: 'extra' }; }), { status: 409 });
    }
    assert.equal(read, false);
    await assert.rejects(resumeAutomation(), { status: 409 });
    assert.equal((await piezoStatus()).level, 2, 'level stays selected during processing');
    finish(); await waitFor('waiting');
    assert.equal((await piezoStatus()).level, 0, 'completed publication resets the level');
    await setPiezoLevel(1);
    assert.equal(count, 1); assert.equal((await automationStatus()).hasPhoto, false);
    setAutomationRunner(async () => { throw Error('게시 결과 불명확'); });
    await receiveAutomatic('photo', async () => ({ id: 'photo-2' }));
    assert.equal((await automationStatus()).status, 'waiting');
    await finalText('photo-2', 'new');
    await elapse();
    await waitFor('halted');
    assert.equal((await piezoStatus()).level, 0, 'failed processing resets the level');
    await setPiezoLevel(2);
    assert.match((await automationStatus()).error!, /불명확/);
    await assert.rejects(receiveAutomatic('photo', async () => ({ id: 'photo-3' })), { status: 409 });
    await resumeAutomation();
    assert.equal((await piezoStatus()).level, 0, 'resuming resets the level');
    assert.equal((await automationStatus()).hasTranscript, false);
    // A body still being read owns the intake reservation.
    let release!: () => void;
    const first = receiveAutomatic('photo', async () => { await new Promise<void>(resolve => { release = resolve; }); return { id: 'photo-4' }; });
    await new Promise(resolve => setImmediate(resolve));
    const racingText = receiveAutomatic('text', async () => null);
    release(); await first;
    assert.equal(await racingText, null);
    await resumeAutomation();
    let timeoutPair: { photoId: string; text: string } | undefined;
    setAutomationRunner(async pair => { timeoutPair = pair; });
    await receiveAutomatic('photo', async () => ({ id: 'photo-timeout' }));
    t.mock.timers.tick(9_999);
    assert.equal(timeoutPair, undefined);
    t.mock.timers.tick(1);
    await delay(30);
    assert.equal(timeoutPair?.photoId, 'photo-timeout');
    assert.equal(timeoutPair?.text, '', 'no transcript generates from the photo alone');
    await finalText('photo-timeout', 'late text');
    assert.equal(timeoutPair?.text, '', 'late text cannot change an already started generation');
    await resumeAutomation();
    let aborted = false;
    let settle!: () => void;
    setAutomationRunner(async (_pair, signal) => {
      await new Promise<void>(resolve => {
        settle = resolve;
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      });
      signal.throwIfAborted();
    });
    await receiveAutomatic('photo', async () => ({ id: 'restart-photo' }));
    await finalText('restart-photo', 'restart');
    await elapse();
    await setPiezoLevel(2);
    let restarted = false;
    const restart = restartAutomation().then(value => { restarted = true; return value; });
    for (let i = 0; i < 100 && !aborted; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(restarted, false);
    await assert.rejects(receiveAutomatic('photo', async () => ({ id: 'during-restart' })), { status: 409 });
    await assert.rejects(restartAutomation(), { status: 409 });
    settle();
    const result = await restart;
    assert.equal((await piezoStatus()).level, 0, 'interrupting and restarting resets the level');
    assert.equal(result.accepting, true);
    assert.equal(result.hasPhoto, false);
    assert.equal(result.hasTranscript, false);
    assert.equal(result.eventId, null);
    assert.deepEqual(await receivedTranscripts(), [], 'restart clears stored transcript history');
    await receiveAutomatic('photo', async () => ({ id: 'restart-photo' }));
    assert.equal((await automationStatus()).status, 'waiting', 'old text cannot be reused after restart');
    await resumeAutomation();
    await finalText('text-after-restart', 'fresh');
    assert.equal((await receivedTranscripts()).length, 1, 'new text is stored after restart');
    assert.equal((await automationStatus()).hasTranscript, false);
    await resumeAutomation();
    await receiveAutomatic('photo', async () => ({ id: 'pending-restart' }));
    await setPiezoLevel(1);
    await restartAutomation();
    assert.equal((await piezoStatus()).level, 0, 'idle restart resets the level');
    assert.equal((await automationStatus()).hasPhoto, false);
    assert.deepEqual(await receivedTranscripts(), [], 'idle restart also clears history');
    await elapse();
    assert.equal((await automationStatus()).status, 'waiting', 'restart cancels the pending timer');

  } finally {
    if (previousPublications === undefined) delete process.env.PUBLICATIONS_DIR; else process.env.PUBLICATIONS_DIR = previousPublications;
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart preserves a halted receipt and never resumes an interrupted publish', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'automation-restart-'));
  const stateFile = join(dir, 'state.json');
  try {
    await writeFile(stateFile, JSON.stringify({ status: 'processing', eventId: 'phone-interrupted' }));
    for (let boot = 0; boot < 2; boot++) {
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        const automation = await import(${JSON.stringify(new URL('./automation.ts', import.meta.url).href)});
        automation.setAutomationRunner(async () => { throw Error('Must not run'); });
        console.log(JSON.stringify(await automation.automationStatus()));
      `], { env: { ...process.env, AUTOMATION_STATE_FILE: stateFile }, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const status = JSON.parse(child.stdout);
      assert.equal(status.status, 'halted');
      assert.equal(status.accepting, false);
      assert.equal(status.eventId, 'phone-interrupted');
      assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).status, 'halted');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

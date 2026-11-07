import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { receiveTranscript, latestTranscript, receivedTranscripts } from './transcripts.ts';

test('final transcripts pair only by interaction ID and preserve idempotent receipts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const elapse = async () => { t.mock.timers.tick(10_000); await delay(30); };
  const root = await mkdtemp(join(tmpdir(), 'transcripts-'));
  const previous = { token: process.env.OBSERVATION_TOKEN, root: process.env.TRANSCRIPTS_DATA_DIR };
  process.env.OBSERVATION_TOKEN = 'test-intake-token';
  process.env.TRANSCRIPTS_DATA_DIR = root;
  process.env.AUTOMATION_STATE_FILE = join(root, 'automation/state.json');
  const call = async (body: string, authorization = 'Bearer test-intake-token', contentType = 'application/json', method = 'POST') => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, headers: { authorization, 'content-type': contentType } });
    let status = 0, output = '';
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(value: string) { output = value; } };
    await receiveTranscript(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status, data: JSON.parse(output) };
  };
  try {
    assert.equal(await latestTranscript(), null);
    const result = await call(JSON.stringify({ text: '  한국어 대화 내용\n다음 문장  ' }));
    assert.equal(result.status, 201);
    assert.ok(Number.isFinite(Date.parse(result.data.receivedAt)));
    const saved = JSON.parse(await readFile(join(root, `${result.data.id}.json`), 'utf8'));
    assert.equal(saved.text, '한국어 대화 내용\n다음 문장');
    assert.deepEqual(await latestTranscript(), saved);
    await call(JSON.stringify({ text: '처리 대기 중 추가 입력' }));
    assert.equal((await receivedTranscripts()).length, 2);
    const { receiveAutomatic, setAutomationRunner, automationStatus } = await import('./automation.ts');
    const pairs: { photoId: string; text: string }[] = [];
    let finish!: () => void;
    setAutomationRunner(async pair => {
      pairs.push(pair);
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const segment = (interactionId: string, text: string) => ({
      interactionId, text, startedAt: '2026-11-07T00:00:00.000Z', endedAt: '2026-11-07T00:00:20.000Z',
    });
    const send = (interactionId: string, text: string) => call(JSON.stringify(segment(interactionId, text)));
    const finishGeneration = async () => {
      finish();
      for (let i = 0; i < 100 && (await automationStatus()).status !== 'waiting'; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal((await automationStatus()).status, 'waiting');
    };
    await receiveAutomatic('photo', async () => ({ id: 'photo-1' }));
    assert.equal(pairs.length, 0, 'legacy history must not start a new photo');
    await send('other-photo', '다른 구간');
    assert.equal(pairs.length, 0, 'a different interaction must not be paired');
    const final = await send('photo-1', '이 20초만');
    assert.equal(final.data.interactionId, 'photo-1');
    await elapse();
    assert.equal(pairs[0].text, '이 20초만');
    const matching = (await receivedTranscripts()).find(item => item.interactionId === 'photo-1')!;
    assert.equal(matching.endedAt, '2026-11-07T00:00:20.000Z');
    const duplicate = await send('photo-1', '이 20초만');
    assert.equal(duplicate.data.id, final.data.id, 'retries return the original receipt');
    await assert.rejects(send('photo-1', 'different final text'), { status: 409 });
    await assert.rejects(call(JSON.stringify({ ...segment('photo-1', '이 20초만'), endedAt: '2026-11-07T00:00:21.000Z' })), { status: 409 });
    await Promise.all([send('photo-2', '다음 20초'), send('photo-2', '다음 20초')]);
    await call(JSON.stringify({ text: 'legacy text while busy' }));
    assert.equal(pairs.length, 1, 'busy receipts must not launch another generation');
    await finishGeneration();
    await receiveAutomatic('photo', async () => ({ id: 'photo-2' }));
    await elapse();
    assert.equal(pairs[1].text, '다음 20초', 'text arriving first is matched by ID, not arrival order');
    await finishGeneration();
    await receiveAutomatic('photo', async () => ({ id: 'photo-3' }));
    await send('photo-1', '이 20초만');
    assert.equal(pairs.length, 2, 'an old final retry must not start the new photo');
    await send('photo-3', 'third interval');
    await elapse();
    assert.equal(pairs[2].text, 'third interval');
    await finishGeneration();
    const simultaneousPhoto = receiveAutomatic('photo', async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { id: 'photo-4' };
    });
    await Promise.all([simultaneousPhoto, send('photo-4', 'simultaneous interval')]);
    await elapse();
    assert.equal(pairs[3].text, 'simultaneous interval');
    await finishGeneration();
    for (const invalid of [
      { interactionId: 'photo-5' },
      { startedAt: '2026-11-07T00:00:00Z', endedAt: '2026-11-07T00:00:20Z' },
      segment('../bad', 'text'),
      { ...segment('photo-5', 'text'), startedAt: 'invalid' },
      { ...segment('photo-5', 'text'), endedAt: '2026-11-06T23:59:59Z' },
      { ...segment('photo-5', 'text'), endedAt: '2026-11-07T00:00:00Z' },
    ]) await assert.rejects(call(JSON.stringify({ text: 'text', ...invalid })), { status: 400 });
    for (const [body, auth, type, method, status] of [
      ['{}', '', 'application/json', 'POST', 401],
      ['{}', undefined, 'text/plain', 'POST', 415],
      ['{', undefined, undefined, undefined, 400],
      ['null', undefined, undefined, undefined, 400],
      ['{"text":"  "}', undefined, undefined, undefined, 400],
      [JSON.stringify({ text: 'a'.repeat(12001) }), undefined, undefined, undefined, 400],
      ['a'.repeat(65537), undefined, undefined, undefined, 413],
      ['{}', undefined, undefined, 'GET', 405],
    ] as const) {
      await assert.rejects(call(body, auth, type, method), { status });
    }
    assert.equal((await readdir(root)).filter(name => name.endsWith('.json')).length, 8);
  } finally {
    if (previous.token === undefined) delete process.env.OBSERVATION_TOKEN;
    else process.env.OBSERVATION_TOKEN = previous.token;
    if (previous.root === undefined) delete process.env.TRANSCRIPTS_DATA_DIR;
    else process.env.TRANSCRIPTS_DATA_DIR = previous.root;
    await rm(root, { recursive: true, force: true });
  }
});

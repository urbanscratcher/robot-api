import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
test('public POC returns three cards for selected stage without exposing saved publications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paparazzi-preview-'));
  let system = '', userContent = '', blurry = false;
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.format.required.includes('skip')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: { content: JSON.stringify({ skip: blurry }) } })); return; }
    system = body.messages[0].content; userContent = body.messages[1].content;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ headline: '눈길이 가는 작은 풍경', caption: '관측에 기반한 AI 초안', cards: [
      { crop: [0, 0, 0.75, 0.75], title: '처음 보이는 디테일', body: '사진 속 장면을 살펴봅니다.' }, { title: '어디에 시선이 머물렀나요', body: '당신은 무엇을 먼저 보셨나요?' },
    ] }) } }));
  });
  const mockPort = await listen(mock);
  const probe = createServer(); const port = await listen(probe);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './server/fixtures/claude-mock.ts', 'server/index.ts'], {
    env: { ...process.env, TEXT_PROVIDER: 'ollama', ANTHROPIC_API_KEY: 'synthetic-test-key', CLAUDE_FIXTURE_PORT: String(mockPort), API_PORT: String(port), OLLAMA_PORT: String(mockPort), AI_SETTINGS_FILE: join(dir, 'settings.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/api/ai-settings')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, logs);
    const image = `data:image/jpeg;base64,${(await readFile(new URL('./fixtures/publication.jpg', import.meta.url))).toString('base64')}`;
    const request = (value: unknown) => fetch(base + '/api/card-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Overheard-Public': '1' }, body: JSON.stringify(value) });
    assert.equal((await request({ image, piezoLevel: 9 })).status, 400);
    assert.equal((await request({ image: 'bad', piezoLevel: 1 })).status, 400);
    assert.equal((await request({ image, piezoLevel: 1, transcript: 123 })).status, 400);
    assert.equal((await request({ image, piezoLevel: 1, transcript: 'x'.repeat(8001) })).status, 400);
    const response = await request({ image, piezoLevel: 1, prompt: '관측 맥락', transcript: '  오늘 프로젝트 시연을 진행했어요.  ' });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.piezoLevel, 1); assert.equal(result.cards.length, 3);
    assert.match(system, /1단계: 조금 착한 기자/);
    assert.deepEqual(JSON.parse(userContent), { context: '관측 맥락', transcript: '오늘 프로젝트 시연을 진행했어요.' });
    for (const card of result.cards) assert.match(card.image, /^data:image\/jpeg;base64,/);
    const accepted = await fetch(base + '/api/card-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Overheard-Public': '1', Prefer: 'respond-async' }, body: JSON.stringify({ image, piezoLevel: 0 }) });
    assert.equal(accepted.status, 202);
    const job = await accepted.json();
    let completed;
    for (let attempt = 0; attempt < 100; attempt++) {
      const poll = await fetch(`${base}/api/card-preview/${job.id}`, { headers: { 'X-Overheard-Public': '1' } });
      assert.equal(poll.status, 200);
      completed = await poll.json();
      if (completed.status !== 'generating') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(completed.result.cards.length, 3);
    assert.equal(completed.result.piezoLevel, 0);
    blurry = true;
    const skipped = await request({ image, piezoLevel: 0 });
    assert.equal(skipped.status, 422);
    assert.match((await skipped.json()).error, /스킵/);
    assert.equal((await fetch(`${base}/api/card-preview/00000000-0000-0000-0000-000000000000`, { headers: { 'X-Overheard-Public': '1' } })).status, 404);
    assert.equal((await fetch(base + '/api/observations', { headers: { 'X-Overheard-Public': '1' } })).status, 403);
    assert.equal((await fetch(base + '/api/ai-settings', { method: 'POST', headers: { 'X-Overheard-Public': '1', 'Content-Type': 'application/json' }, body: '{"enabled":false}' })).status, 403);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => mock.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

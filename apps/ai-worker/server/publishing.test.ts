import { claudeFixture } from './fixtures/claude-mock.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('observation intake, durable drafts, revision checks and publish uncertainty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'overheard-publishing-'));
  process.env.AUTOMATION_STATE_FILE = join(dir, 'automation/state.json');
  process.env.AI_SETTINGS_FILE = join(dir, 'ai-settings.conf');
  await writeFile(process.env.AI_SETTINGS_FILE, JSON.stringify({ enabled: false }));
  process.env.PUBLICATIONS_DIR = dir;
  process.env.PUBLICATION_IMAGES_DIR = join(dir, 'images');
  process.env.PUBLISH_MEDIA_SECRET = 'image-secret';
  process.env.INSTAGRAM_MEDIA_ORIGIN = 'https://h.joun.cc';
  process.env.OBSERVATION_TOKEN = 'test-intake';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test-instagram';
  process.env.INSTAGRAM_USER_ID = '123';
  process.env.INSTAGRAM_API_VERSION = 'v25.0';
  const { publicationRoutes } = await import('./publishing.ts');
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  const nativeFetch = globalThis.fetch;
  let aiFails = false, publishFails = false, publishCount = 0;
  let sentCaption = '', sentImageUrl = '';
  t.mock.method(globalThis, 'fetch', claudeFixture(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/chat')) return new Response(JSON.stringify({ message: { content: aiFails ? 'bad json' : JSON.stringify({ caption: '관측 기사\n온도 23.5°C. AI 작성 초안.' }) } }));
    if (path.startsWith('https://graph.instagram.com/')) {
      if (path.includes('/media_publish')) { publishCount++; if (publishFails) throw Error('timeout after remote commit'); return Response.json({ id: 'published-1' }); }
      if (path.includes('fields=status_code')) return Response.json({ status_code: 'FINISHED' });
      sentImageUrl = new URLSearchParams(String(init?.body)).get('image_url')!;
      sentCaption = new URLSearchParams(String(init?.body)).get('caption')!;
      return Response.json({ id: 'container-1' });
    }
    return nativeFetch(url, init);
  }));
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try { if (!await publicationRoutes(req, res, new URL(req.url!, 'http://localhost').pathname)) { res.writeHead(404); res.end('{}'); } }
    catch (e) { if (!res.writableEnded) { res.writeHead((e as { status?: number }).status ?? 500); res.end(JSON.stringify({ error: (e as Error).message })); } }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(path: string, method = 'GET', data?: unknown, auth = true) {
    const response = await nativeFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-intake' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function settled(id: string) {
    for (let n = 0; n < 100; n++) { const r = await call(`/api/observations/${id}`); if (!['received','generating'].includes(r.data.status)) return r.data; await new Promise(r => setTimeout(r, 10)); }
    throw Error('Generation did not settle');
  }
  const input = { eventId: 'event-1', capturedAt: '2026-11-06T10:00:00+09:00', sensors: { temperatureC: 23.5 } };
  try {
    assert.equal((await call('/api/piezo', 'POST', { piezoLevel: 1 }, false)).status, 401);
    assert.equal((await call('/api/piezo', 'POST', { piezoLevel: '1' })).status, 400);
    assert.equal((await call('/api/piezo', 'POST', { piezoLevel: 3 })).status, 400);
    const sensor = await call('/api/piezo', 'POST', { piezoLevel: 2 });
    assert.equal(sensor.status, 200);
    assert.equal(sensor.data.level, 2);
    assert.ok(sensor.data.expiresAt > Date.now());
    assert.equal((await call('/api/publishing/status')).data.piezo.level, 2);
    assert.equal((await call('/api/piezo', 'POST', { piezoLevel: 0 })).data.level, 2);
    assert.equal((await call('/api/publishing/piezo', 'POST', { piezoLevel: 3 }, false)).status, 400);
    assert.equal((await call('/api/publishing/piezo', 'POST', { piezoLevel: 1 }, false)).data.level, 1);
    assert.equal((await call('/api/publishing/piezo', 'POST', { piezoLevel: 0 }, false)).data.level, 0);
    assert.equal((await call('/api/publishing/status')).data.piezo.level, 0);
    assert.equal((await call('/api/observations', 'POST', { ...input, sensors: { piezoLevel: 3 } })).status, 400);
    assert.equal((await call('/api/observations', 'POST', input, false)).status, 401);
    assert.equal((await call('/api/observations', 'POST', { ...input, eventId: '../bad' })).status, 400);
    assert.equal((await call('/api/observations', 'POST', { ...input, sensors: {} })).status, 400);
    assert.equal((await call('/api/observations', 'POST', input)).status, 202);
    const draft = await settled('event-1'); assert.equal(draft.status, 'draft');
    assert.equal((await call('/api/observations', 'POST', input)).status, 200);
    assert.equal((await call('/api/observations', 'POST', { ...input, sensors: Object.fromEntries(Object.entries(input.sensors).reverse()) })).status, 200);
    assert.equal((await call('/api/observations', 'POST', { ...input, sensors: { changed: true } })).status, 409);
    assert.equal((await call('/api/observations/event-1/publish', 'POST', { revision: draft.revision, accountId: '123' })).status, 400);
    assert.equal((await call('/api/observations/event-1', 'PATCH', { caption: 'bad', imageUrl: '', revision: -1 })).status, 409);
    assert.equal((await call('/api/observations/event-1', 'PATCH', { caption: 'bad', imageUrl: 'javascript:alert(1)', revision: draft.revision, accountId: '123' })).status, 400);
    const edited = await call('/api/observations/event-1', 'PATCH', { caption: '검토 완료 게시문', imageUrl: 'https://example.com/photo.jpg', revision: draft.revision, accountId: '123' });
    assert.equal(edited.status, 200);
    assert.equal((await call('/api/observations/event-1/publish', 'POST', { revision: draft.revision, accountId: '123' })).status, 409);
    assert.equal((await call('/api/mobile/publications/event-1', 'GET', undefined, false)).status, 401);
    assert.equal((await call('/api/mobile/publications/event-1')).data.status, 'review_required');
    const streamController = new AbortController();
    const stream = await nativeFetch(base + '/api/mobile/publications/event-1/events', { headers: { Authorization: 'Bearer test-intake' }, signal: streamController.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    const initialEvent = new TextDecoder().decode((await reader.read()).value);
    assert.match(initialEvent, /event: status/);
    assert.match(initialEvent, /"status":"review_required"/);
    const published = await call('/api/observations/event-1/publish', 'POST', { revision: edited.data.revision, accountId: '123' });
    assert.equal(published.data.status, 'published'); assert.equal(sentCaption, '검토 완료 게시문');
    let events = '';
    const timeout = setTimeout(() => streamController.abort(), 3000);
    try {
      while (!events.includes('event: published')) events += new TextDecoder().decode((await reader.read()).value);
      assert.match(events, /mediaId/);
    } finally { clearTimeout(timeout); streamController.abort(); }
    const receipt = await call('/api/mobile/publications/event-1');
    assert.equal(receipt.data.status, 'published');
    assert.equal(receipt.data.mediaId, published.data.mediaId);
    assert.equal(receipt.data.caption, undefined);
    assert.equal((await call('/api/mobile/publications')).data.items[0].eventId, 'event-1');
    await call('/api/observations/event-1/publish', 'POST', { revision: edited.data.revision, accountId: '123' });
    assert.equal(publishCount, 1);
    assert.equal((await call('/api/observations/event-1', 'PATCH', { caption: 'changed' })).status, 409);
    aiFails = true;
    await call('/api/observations', 'POST', { ...input, eventId: 'failed' });
    assert.equal((await settled('failed')).status, 'failed');
    aiFails = false;
    assert.equal((await call('/api/observations/failed/generate', 'POST', {})).data.status, 'draft');
    const second = await call('/api/observations/failed', 'PATCH', { caption: '다음 기사', imageUrl: 'https://example.com/next.jpg', revision: 1 });
    const jpeg = await readFile(new URL('./fixtures/publication.jpg', import.meta.url));
    const uploaded = await call('/api/observations/failed', 'PATCH', { caption: '다음 기사', imageUrl: '', image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, revision: second.data.revision });
    assert.equal(uploaded.status, 200); assert.ok(uploaded.data.uploadedImageId); assert.equal(uploaded.data.imageUrl, '');
    const preview = await nativeFetch(base + '/api/observations/failed/image');
    assert.equal(preview.status, 200); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), jpeg);
    assert.equal((await call('/api/observations/failed', 'PATCH', { caption: 'stale', imageUrl: '', revision: second.data.revision })).status, 409);
    publishFails = true;
    assert.equal((await call('/api/observations/failed/publish', 'POST', { revision: uploaded.data.revision, accountId: '123' })).data.status, 'unknown');
    assert.equal((await call('/api/observations/failed/publish', 'POST', { revision: uploaded.data.revision, accountId: '123' })).status, 409);
    assert.equal(publishCount, 2);
    assert.match(sentImageUrl, /^https:\/\/h\.joun\.cc\/api\/publish-images\/[a-f0-9]{64}\.jpg\?expires=/);
    await writeFile(join(dir, 'interrupted.json'), JSON.stringify({ ...draft, input: { ...input, eventId: 'interrupted' }, status: 'publishing', workerPid: undefined }));
    assert.equal((await call('/api/observations/interrupted')).data.status, 'unknown');
    for (const status of ['publishing', 'generating'] as const) {
      const active = { ...draft, input: { ...input, eventId: 'sibling' }, status, workerPid: process.ppid };
      await writeFile(join(dir, 'sibling.json'), JSON.stringify(active));
      assert.equal((await call('/api/observations/sibling')).data.status, status);
      assert.equal(JSON.parse(await readFile(join(dir, 'sibling.json'), 'utf8')).status, status);
    }
    assert.equal((await call('/api/observations/missing/generate', 'POST', {})).status, 404);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
    t.mock.restoreAll();
  }
});


test('mobile progress reports real stages and hides stale generation details', async () => {
  const { publicationStatus } = await import('./publication-events.ts');
  const item: import('../src/publishing.ts').Publication = {
    input: { eventId: 'progress', capturedAt: '', sensors: {} },
    status: 'generating', revision: 0, caption: 'private caption', imageUrl: '',
  };
  assert.equal(publicationStatus(item).status, 'ai_generating');
  for (let current = 1; current <= 4; current++) {
    item.phase = `카드뉴스 이미지 합성 중 (${current}/4)`;
    item.generationProgress = { stage: 'cards_generating', current, total: 4 };
    const status = publicationStatus(item);
    assert.equal(status.status, 'cards_generating');
    assert.equal(status.current, current);
    assert.equal(status.total, 4);
    assert.equal(status.phase, item.phase);
    assert.ok(!JSON.stringify(status).includes('private caption'));
  }
  for (const state of ['draft', 'publishing', 'published', 'failed', 'unknown'] as const) {
    item.status = state;
    const status = publicationStatus(item);
    assert.equal(status.status, state === 'draft' ? 'review_required' : state);
    assert.equal(status.current, null);
    assert.equal(status.total, null);
    assert.ok(!status.phase.includes('합성'));
  }
});

test('robot SSE follows atomic saves from another writer through review, publishing and completion', async () => {
  const { subscribePublication } = await import('./publication-events.ts');
  const { rename } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'robot-sse-'));
  const filename = join(dir, 'robot.json');
  const item: import('../src/publishing.ts').Publication = {
    input: { eventId: 'robot', capturedAt: '', sensors: {} },
    status: 'draft', revision: 0, caption: '', imageUrl: '',
  };
  await writeFile(filename, JSON.stringify(item));
  const server = createServer((_req, res) => subscribePublication(res, item, filename));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let output = '';
    const until = async (value: string) => {
      while (!output.includes(value)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        output += new TextDecoder().decode(chunk.value);
      }
    };
    await until('"status":"review_required"');
    for (const status of ['publishing', 'published'] as const) {
      await writeFile(`${filename}.tmp`, JSON.stringify({ ...item, status }));
      await rename(`${filename}.tmp`, filename);
      await until(`"status":"${status}"`);
    }
    assert.match(output, /event: status\ndata: .*"status":"publishing"/);
    assert.match(output, /event: published\ndata: .*"status":"published"/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

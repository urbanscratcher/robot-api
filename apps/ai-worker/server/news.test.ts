import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('public news exposes published and uncertain text and images, with stable article IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paparazzi-news-'));
  process.env.PUBLICATIONS_DIR = dir;
  process.env.PUBLICATION_IMAGES_DIR = join(dir, 'images');
  const { newsRoutes } = await import('./news.ts');
  const jpeg = await readFile(new URL('./fixtures/publication.jpg', import.meta.url));
  const imageId = 'a'.repeat(64);
  await mkdir(join(dir, 'images'));
  await writeFile(join(dir, 'images', `${imageId}.jpg`), jpeg);
  const original = { eventId: 'one', capturedAt: '2026-11-06T10:00:00Z', image: 'PRIVATE IMAGE', audio: 'PRIVATE AUDIO', sensors: { private: 'PRIVATE SENSOR' } };
  const item = { input: original, status: 'draft', revision: 1, caption: '<script>alert(1)</script>\n공개 본문', imageUrl: '', uploadedImageId: imageId, transcript: 'PRIVATE TRANSCRIPT', prompt: 'PRIVATE PROMPT', instagramUserId: 'PRIVATE ACCOUNT' };
  await writeFile(join(dir, 'one.json'), JSON.stringify(item));
  const server = createServer(async (req, res) => {
    try {
      if (!await newsRoutes(req, res, new URL(req.url!, 'http://localhost').pathname)) { res.writeHead(404); res.end(); }
    } catch (e) { res.writeHead((e as {status?: number}).status || 500); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const get = (path = '/api/news', method = 'GET') => fetch(base + path, { method });
  try {
    const controller = new AbortController();
    const stream = await fetch(base + '/api/news/events', { signal: controller.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    try {
      const update = reader.read();
      await writeFile(join(dir, 'live.json'), JSON.stringify({ ...item, status: 'unknown' }));
      const chunk = await Promise.race([update, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(Error('No live publication event')), 3000);
        timer.unref();
      })]);
      assert.match(new TextDecoder().decode(chunk.value), /event: published\ndata: \{\}/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
      await rm(join(dir, 'live.json'), { force: true });
    }
    assert.deepEqual(await (await get()).json(), { items: [] });
    assert.equal((await get('/api/news/one/images/0')).status, 404);
    for (const status of ['failed', 'generating', 'publishing', 'received', 'skipped']) {
      await writeFile(join(dir, 'one.json'), JSON.stringify({ ...item, status }));
      assert.deepEqual(await (await get()).json(), { items: [] });
    }
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...item, status: 'draft', newsPublishedAt: '2026-11-06T10:30:00Z' }));
    const newspaperOnly = await (await get()).json();
    assert.equal(newspaperOnly.items[0].id, 'one');
    assert.equal(newspaperOnly.items[0].publishedAt, '2026-11-06T10:30:00Z');
    assert.equal((await get(newspaperOnly.items[0].images[0])).status, 200);
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...item, status: 'unknown' }));
    const uncertain = await (await get()).json();
    assert.equal(uncertain.items[0].id, 'one');
    assert.equal(uncertain.items[0].publishedAt, original.capturedAt);
    assert.equal((await get(uncertain.items[0].images[0])).status, 200);
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...item, status: 'published', publishedAt: '2026-11-06T11:00:00Z' }));
    const response = await get();
    const text = await response.text();
    assert.ok(!text.includes('PRIVATE'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { items } = JSON.parse(text);
    assert.equal(items[0].id, 'one');
    assert.equal(items[0].caption, item.caption);
    assert.deepEqual(items[0].images, ['/api/news/one/images/0']);
    const photo = await get(items[0].images[0]);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
    assert.equal((await get('/api/news/one/images/1')).status, 404);
    assert.equal((await get('/api/news', 'POST')).status, 405);
    await writeFile(join(dir, 'two.json'), JSON.stringify({ ...item, status: 'published', publishedAt: '2026-11-06T12:00:00Z', cards: Array.from({ length: 4 }, (_, i) => ({ title: `카드 ${i}`, body: '내용', imageId })) }));
    const updated = await (await get()).json();
    assert.deepEqual(updated.items.map((i: {id: string}) => i.id), ['two', 'one']);
    assert.equal(updated.items[0].images.length, 4);
    assert.equal(updated.items[0].title, '카드 0');
    assert.equal((await get('/api/news/two/images/3')).status, 200);
    assert.equal((await get('/api/news/two/images/4')).status, 404);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

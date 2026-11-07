import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('uploaded images: JPEG validation, immutable storage and expiring public access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overheard-images-'));
  process.env.PUBLICATION_IMAGES_DIR = dir;
  process.env.PUBLISH_MEDIA_SECRET = 'image-test-secret';
  process.env.INSTAGRAM_MEDIA_ORIGIN = 'https://n.joun.cc';
  const { savePublicationImage, readPublicationImage, publicationImageUrl, publicImageRoute } = await import('./publication-images.ts');
  const jpeg = await readFile(new URL('./fixtures/publication.jpg', import.meta.url));
  const server = createServer(async (req, res) => {
    try { if (!await publicImageRoute(req, res)) { res.writeHead(404); res.end(); } }
    catch (e) { res.writeHead((e as { status?: number }).status ?? 500); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(savePublicationImage('data:image/jpeg;base64,YmFk'), /JPEG/);
    await assert.rejects(savePublicationImage('data:image/png;base64,YmFk'), /JPEG/);
    const id = await savePublicationImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    assert.deepEqual(await readPublicationImage(id), jpeg);
    assert.equal(await savePublicationImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`), id);
    await assert.rejects(readPublicationImage('../secret'), /찾을/);
    const url = new URL(publicationImageUrl(id));
    const response = await fetch(base + url.pathname + url.search);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    assert.equal((await fetch(base + url.pathname)).status, 403);
    const forged = new URL(url); forged.searchParams.set('signature', '0'.repeat(64));
    assert.equal((await fetch(base + forged.pathname + forged.search)).status, 403);
    const originalNow = Date.now(); t.mock.method(Date, 'now', () => originalNow + 3601000);
    assert.equal((await fetch(base + url.pathname + url.search)).status, 403);
  } finally {
    t.mock.restoreAll(); await new Promise<void>(r => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

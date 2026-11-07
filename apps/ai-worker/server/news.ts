import { readFile, readdir, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Publication } from '../src/publishing.ts';
import { readPublicationImage, sendPublicationImage } from './publication-images.ts';
import { fail } from './local.ts';

const root = resolve(process.env.PUBLICATIONS_DIR || 'data/publications');
const validId = /^[a-zA-Z0-9_-]{1,100}$/;
async function visibleArticle(id: string) {
  if (!validId.test(id)) fail('기사를 찾을 수 없습니다.', 404);
  let item: Publication;
  try { item = JSON.parse(await readFile(join(root, `${id}.json`), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  return item.status === 'published' || item.status === 'unknown' ? item : null;
}

export async function newsRoutes(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path !== '/api/news' && !path.startsWith('/api/news/')) return false;
  if (req.method !== 'GET') fail('읽기만 허용합니다.', 405);
  if (path === '/api/news/events') {
    await mkdir(root, { recursive: true });
    const watcher = watch(root, { persistent: false }, (_event, filename) => {
      const name = filename?.toString();
      if (!name?.endsWith('.json') || !validId.test(name.slice(0, -5))) return;
      void visibleArticle(name.slice(0, -5)).then(item => {
        if (item && !res.destroyed && !res.write('event: published\ndata: {}\n\n')) res.destroy();
      }).catch(() => {});
    });
    watcher.on('error', () => res.destroy());
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      if (!res.write(': heartbeat\n\n')) res.destroy();
    }, 15000);
    heartbeat.unref();
    res.once('close', () => { watcher.close(); clearInterval(heartbeat); });
    return true;
  }
  if (path === '/api/news') {
    let names: string[];
    try { names = await readdir(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; names = []; }
    const items = [];
    for (const name of names.filter(n => n.endsWith('.json') && validId.test(n.slice(0, -5)))) {
      const item = await visibleArticle(name.slice(0, -5));
      if (!item) continue;
      const id = name.slice(0, -5);
      const images = item.cards?.length
        ? item.cards.map((_, i) => `/api/news/${id}/images/${i}`)
        : item.uploadedImageId ? [`/api/news/${id}/images/0`] : item.imageUrl ? [item.imageUrl] : [];
      items.push({ id, title: item.cards?.[0]?.title || item.caption.split('\n').find(s => s.trim()) || '현장 기사',
        caption: item.caption, images, publishedAt: item.publishedAt || item.input.capturedAt });
    }
    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200); res.end(JSON.stringify({ items }));
    return true;
  }
  const match = /^\/api\/news\/([a-zA-Z0-9_-]{1,100})\/images\/([0-3])$/.exec(path);
  if (!match) fail('기사를 찾을 수 없습니다.', 404);
  const item = await visibleArticle(match[1]);
  if (!item) fail('기사를 찾을 수 없습니다.', 404);
  const index = Number(match[2]);
  const imageId = item.cards?.length ? item.cards[index]?.imageId : index === 0 ? item.uploadedImageId : undefined;
  if (!imageId) fail('이미지를 찾을 수 없습니다.', 404);
  sendPublicationImage(res, await readPublicationImage(imageId));
  return true;
}

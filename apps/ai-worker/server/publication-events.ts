import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Publication } from '../src/publishing.ts';

const clients = new Map<ServerResponse, string>();
const watched = new Set<ServerResponse>();
export function publicationStatus(item: Publication) {
  const progress = item.status === 'generating' ? item.generationProgress : undefined;
  const status = item.status === 'generating' ? (progress?.stage ?? 'ai_generating')
    : item.status === 'draft' ? 'review_required' : item.status;
  const labels = { received: '사진 수신 완료', ai_generating: 'AI 작성 중', cards_generating: '카드뉴스 생성 중', review_required: '검토 대기', publishing: '인스타그램 게시 중', published: '게시 완료', failed: '생성 실패', unknown: '게시 확인 필요', skipped: '초점·흔들림으로 스킵' };
  return {
    eventId: item.input.eventId, status,
    phase: item.status === 'generating' ? (item.phase ?? labels[status]) : labels[status],
    current: progress?.stage === 'cards_generating' ? progress.current : null,
    total: progress?.stage === 'cards_generating' ? progress.total : null,
    mediaId: item.mediaId ?? null, publishedAt: item.publishedAt ?? null,
  };
}
function event(res: ServerResponse, item: Publication) {
  const name = item.status === 'published' ? 'published' : 'status';
  return res.write(`event: ${name}\ndata: ${JSON.stringify(publicationStatus(item))}\n\n`);
}
export function subscribePublication(res: ServerResponse, item: Publication, filename?: string) {
  let last = JSON.stringify(publicationStatus(item));
  let pending = Promise.resolve();
  const refresh = () => {
    pending = pending.then(async () => {
      if (!filename || res.destroyed) return;
      const current: Publication = JSON.parse(await readFile(filename, 'utf8'));
      const next = JSON.stringify(publicationStatus(current));
      if (next !== last) {
        last = next;
        if (!event(res, current)) res.destroy();
      }
    }).catch(() => { res.destroy(); });
  };
  // Watch the directory because saves atomically replace the publication file.
  const watcher = filename ? watch(dirname(filename), { persistent: false }, (_type, name) => {
    if (!name || name.toString() === basename(filename)) refresh();
  }) : undefined;
  watcher?.on('error', () => res.destroy());
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.set(res, item.input.eventId);
  if (filename) watched.add(res);
  event(res, item);
  if (filename) refresh();
  const timer = setInterval(() => {
    if (!res.write(': heartbeat\n\n')) res.destroy();
  }, 15000);
  timer.unref();
  res.once('close', () => { clearInterval(timer); watcher?.close(); watched.delete(res); clients.delete(res); });
}
export function notifyPublication(item: Publication) {
  for (const [res, id] of clients) {
    if (!watched.has(res) && id === item.input.eventId && !res.destroyed && !event(res, item)) res.destroy();
  }
}
export function closePublicationEvents() {
  for (const res of clients.keys()) res.end();
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail } from './local.ts';
const root = resolve(process.env.PUBLICATION_IMAGES_DIR || 'data/publication-images');
function secret() { const value = process.env.PUBLISH_MEDIA_SECRET || process.env.META_APP_SECRET; if (!value) fail('게시 이미지용 서버 키가 필요합니다.', 503); return value; }
function signature(id: string, expires: string) { return createHmac('sha256', secret()).update(`${id}:${expires}`).digest('hex'); }
function dimensions(data: Buffer) {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) fail('JPEG 이미지가 필요합니다.');
  let p = 2;
  while (p + 4 <= data.length) {
    if (data[p++] !== 0xff) break;
    while (data[p] === 0xff) p++;
    const marker = data[p++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const size = data.readUInt16BE(p);
    if (size < 2 || p + size > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return { height: data.readUInt16BE(p + 3), width: data.readUInt16BE(p + 5) };
    p += size;
  }
  fail('JPEG 크기를 읽지 못했습니다. 다른 이미지를 선택하세요.');
}
export function validatePublicationImage(image: unknown) {
  if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('JPEG 이미지가 필요합니다.');
  const data = Buffer.from(image.split(',')[1], 'base64');
  if (data.length > 8 * 1024 * 1024) fail('이미지는 8MB 이하로 업로드하세요.', 413);
  const { width, height } = dimensions(data);
  if (width < 320 || width > 1440 || height < 1 || width / height < 0.8 || width / height > 1.91) fail('게시 이미지의 크기·비율이 지원 범위를 벗어났습니다. 화면에서 다시 업로드하세요.');
  return data;
}
export async function savePublicationImage(image: unknown) {
  const data = validatePublicationImage(image);
  const id = createHash('sha256').update(data).digest('hex');
  await mkdir(root, { recursive: true, mode: 0o700 });
  try { await writeFile(join(root, `${id}.jpg`), data, { mode: 0o600, flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  return id;
}
export async function readPublicationImage(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) fail('이미지를 찾을 수 없습니다.', 404);
  try { return await readFile(join(root, `${id}.jpg`)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('이미지를 찾을 수 없습니다.', 404); throw e; }
}
export function publicationImageUrl(id: string) {
  const source = process.env.INSTAGRAM_MEDIA_ORIGIN || process.env.INSTAGRAM_REDIRECT_URI;
  let origin: URL; try { origin = new URL(source ?? ''); } catch { fail('이미지 공개 주소 설정이 필요합니다. INSTAGRAM_MEDIA_ORIGIN을 설정하세요.', 503); }
  if (origin.protocol !== 'https:' || origin.username || origin.password) fail('게시 이미지에는 공개 HTTPS 주소가 필요합니다.', 503);
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  return `${origin.origin}/api/publish-images/${id}.jpg?expires=${expires}&signature=${signature(id, expires)}`;
}
export function sendPublicationImage(res: ServerResponse, data: Buffer) {
  res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
  res.writeHead(200); res.end(data);
}
export async function publicImageRoute(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/api\/publish-images\/([a-f0-9]{64})\.jpg$/.exec(url.pathname);
  if (!match || req.method !== 'GET') return false;
  const expires = url.searchParams.get('expires') ?? '', given = url.searchParams.get('signature') ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d{10}$/.test(expires) || +expires <= now || +expires > now + 3600 || !/^[a-f0-9]{64}$/.test(given)) fail('이미지 주소가 유효하지 않거나 만료되었습니다.', 403);
  const expected = signature(match[1], expires);
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) fail('이미지 주소가 유효하지 않습니다.', 403);
  sendPublicationImage(res, await readPublicationImage(match[1])); return true;
}

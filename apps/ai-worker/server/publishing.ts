import { receiveAutomatic, setAutomationBusyCheck, automationStatus, setAutomationRunner, setAutomationEvent, assertAutomationIdle, resumeAutomation, restartAutomation } from './automation.ts';
import { piezoStatus, receivePiezoLevel, setPiezoLevel, validatePiezoLevel } from './piezo.ts';
import { DEFAULT_COVER_CONTEXT, OBSERVATION_RULES } from './editorial-rules.ts';
import { chatFetch } from './ai.ts';
import { creativePost, shouldSkipPhoto } from './creative.ts';
import { cancelComfy } from './comfy.ts';
import { savePublicationImage, readPublicationImage, sendPublicationImage, publicationImageUrl } from './publication-images.ts';
import { getInstagramConnection, instagramGraph, instagramStatus } from './instagram.ts';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Observation, Publication } from '../src/publishing.ts';
import { fail, localPort } from './local.ts';
import { inspectWav, transcribeAudio } from './transcription.ts';
import { publicationStatus, subscribePublication, notifyPublication, closePublicationEvents } from './publication-events.ts';
import { instagramPublishingStatus, setInstagramPublishing } from './instagram-publishing-setting.ts';

const root = resolve(process.env.PUBLICATIONS_DIR || 'data/publications');
const busy = new Set<string>();
let creating = false;
let creative: { controller: AbortController; promptId?: string } | null = null;
export async function shutdownPublications() {
  closePublicationEvents();
  if (!creative) return;
  creative.controller.abort();
  if (creative.promptId) await cancelComfy(creative.promptId).catch(() => {});
}
const file = (id: string) => join(root, `${id}.json`);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const message = (e: unknown) => e instanceof Error ? e.message : '처리하지 못했습니다.';
async function save(item: Publication) {
  await mkdir(root, { recursive: true });
  const temp = `${file(item.input.eventId)}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ ...item, workerPid: process.pid }), { mode: 0o600 });
  await rename(temp, file(item.input.eventId));
  notifyPublication(item);
}
async function load(id: string): Promise<Publication> {
  if (!validId(id)) fail('유효하지 않은 eventId입니다.');
  let item: Publication & { workerPid?: number };
  try { item = JSON.parse(await readFile(file(id), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('관측을 찾을 수 없습니다.', 404); throw e; }
  // A sibling server may still be processing this shared publication.
  let workerAlive = false;
  const workerPid = item.workerPid;
  if (workerPid !== undefined && Number.isInteger(workerPid) && workerPid > 0 && workerPid !== process.pid) {
    try { process.kill(workerPid, 0); workerAlive = true; }
    catch (error) { workerAlive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  // In-flight work is never silently resumed after a process restart.
  if (!workerAlive && !item.awaitingInput && !busy.has(id) && ['received', 'generating', 'publishing'].includes(item.status)) {
    item.status = item.status === 'publishing' ? 'unknown' : 'failed';
    item.error = item.status === 'unknown' ? '게시 중 서버가 종료되었습니다. 인스타그램에서 게시 여부를 확인하세요. 자동 재시도하지 않습니다.' : '서버가 종료되어 생성이 중단되었습니다. 다시 생성하세요.';
    await save(item);
  }
  delete item.workerPid;
  return item;
}
async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(id)) fail('이 관측을 처리하고 있습니다.', 409);
  busy.add(id);
  try { return await work(); } finally { busy.delete(id); }
}
function validate(input: unknown): Observation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('JSON 객체가 필요합니다.');
  const value = input as Observation;
  if (!validId(value.eventId)) fail('eventId는 영문·숫자·밑줄·하이픈 1~100자입니다.');
  if (typeof value.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt))) fail('capturedAt은 시간대가 있는 ISO 8601 시각이어야 합니다.');
  if (!value.sensors || typeof value.sensors !== 'object' || Array.isArray(value.sensors) || Object.keys(value.sensors).length > 100 || !Object.entries(value.sensors).every(([k, v]) => k.length > 0 && k.length <= 100 && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 500))) fail('sensors에는 최대 100개의 문자열·숫자·불리언 값을 전달하세요.');
  if (value.sensors.piezoLevel !== undefined) validatePiezoLevel(value.sensors.piezoLevel);
  if (value.image !== undefined && (typeof value.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image))) fail('image는 JPEG·PNG·WebP base64 data URL이어야 합니다.');
  if (value.audio !== undefined) {
    if (typeof value.audio !== 'string' || !/^data:audio\/wav;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.audio)) fail('audio는 WAV base64 data URL이어야 합니다.');
    const audio = inspectWav(Buffer.from(value.audio.split(',')[1], 'base64'));
    if (audio.duration > 60) fail('음성은 최대 60초입니다.');
  }
  if (!Object.keys(value.sensors).length && !value.image && !value.audio) fail('센서값·사진·음성 중 하나가 필요합니다.');
  return { eventId: value.eventId, capturedAt: value.capturedAt, sensors: value.sensors, ...(value.image ? { image: value.image } : {}), ...(value.audio ? { audio: value.audio } : {}) };
}
async function generate(item: Publication) {
  item.status = 'generating'; item.generationProgress = undefined; item.error = undefined;
  await save(item);
  try {
    if (item.input.audio) {
      const result = await transcribeAudio(Buffer.from(item.input.audio.split(',')[1], 'base64'), process.env.WHISPER_URL || `http://127.0.0.1:${localPort(process.env.WHISPER_PORT, 8080)}`);
      item.transcript = result.text;
    }
    const response = await chatFetch({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        format: { type: 'object', required: ['caption'], properties: { caption: { type: 'string' } } },
        options: { temperature: 0.3, num_predict: 2000 },
        messages: [
          { role: 'system', content: OBSERVATION_RULES },
          { role: 'user', content: JSON.stringify({ capturedAt: item.input.capturedAt, sensors: item.input.sensors, transcript: item.transcript }), ...(item.input.image ? { images: [item.input.image.split(',')[1]] } : {}) },
        ],
      }),
    }, 240000);
    if (!response.ok) throw Error(`AI 기사 생성 실패 (${response.status})`);
    const data = await response.json();
    const result = JSON.parse(data.message?.content);
    if (typeof result.caption !== 'string' || !result.caption.trim() || [...result.caption].length > 2200) throw Error('AI 초안이 비어 있거나 2,200자를 초과합니다. 다시 생성하세요.');
    item.caption = result.caption.trim(); item.revision++; item.status = 'draft';
    item.newsPublishedAt ||= new Date().toISOString();
  } catch (e) { item.status = 'failed'; item.error = message(e); }
  await save(item);
}
async function generateCreative(item: Publication, signal?: AbortSignal) {
  if (creative) fail('다른 이미지·게시문을 생성하고 있습니다. 완료 후 다시 시도하세요.', 409);
  const task = { controller: new AbortController(), promptId: undefined as string | undefined };
  creative = task;
  const timer = setTimeout(() => task.controller.abort(), 15 * 60 * 1000); timer.unref();
  try {
    item.status = 'generating'; item.generationProgress = undefined; item.error = undefined; item.phase = '생성 준비 중'; await save(item);
    const generationSignal = signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal;
    item.phase = '사진 초점·흔들림 확인 중'; await save(item);
    if (await shouldSkipPhoto(item.input.image!, generationSignal)) {
      item.status = 'skipped'; item.phase = undefined;
      item.caption = ''; item.cards = undefined; item.uploadedImageId = undefined; item.imageUrl = '';
      item.generatedImagePrompt = undefined; item.imageSeed = undefined;
      await save(item);
      return;
    }
    const result = await creativePost(item.input.image!, item.prompt!, signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal, async (phase, progress) => { item.phase = phase; item.generationProgress = progress; await save(item); }, async id => { task.promptId = id; }, item.piezoLevel ?? 0, item.transcript || '');
    const cards = [];
    for (const [index, image] of result.images.entries()) {
      const imageId = await savePublicationImage(`data:image/jpeg;base64,${image.toString('base64')}`);
      cards.push({ imageId, ...result.cards[index] });
    }
    item.caption = result.caption; item.cards = cards; item.uploadedImageId = cards[0].imageId; item.imageUrl = '';
    item.generatedImagePrompt = result.imagePrompt; item.imageSeed = result.seed;
    item.revision++; item.status = 'draft'; item.phase = undefined;
    item.newsPublishedAt ||= new Date().toISOString();
  } catch (e) { item.status = 'failed'; item.phase = undefined; item.error = (task.controller.signal.aborted || signal?.aborted) ? '생성이 중단되었습니다. 다시 시도하세요.' : message(e); }
  finally { clearTimeout(timer); creative = null; }
  await save(item);
}
async function waitForContainer(config: NonNullable<Awaited<ReturnType<typeof getInstagramConnection>>>, id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await instagramGraph(config, `${id}?fields=status_code`);
    if (state.status_code === 'FINISHED') return;
    if (['ERROR', 'EXPIRED'].includes(state.status_code)) throw Error('이미지 처리 실패. 공개 JPEG URL과 이미지 규격을 확인하세요.');
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Error('이미지 처리 시간이 초과되었습니다. 잠시 후 다시 게시하세요.');
}
async function publish(item: Publication, accountId: unknown, signal?: AbortSignal) {
  if (item.status === 'published') return item;
  if (item.status !== 'draft') fail('검토 가능한 초안만 게시할 수 있습니다.', 409);
  // The exhibition newspaper is an independent publishing destination. Make the
  // reviewed article visible before attempting Instagram so a missing account or
  // any Graph API failure cannot prevent local publication.
  if (!item.newsPublishedAt) {
    item.newsPublishedAt = new Date().toISOString();
    await save(item);
  }
  if (!(await instagramPublishingStatus()).enabled) {
    item.status = 'draft'; item.error = undefined; item.instagramSkipped = true;
    await save(item);
    return item;
  }
  const config = await getInstagramConnection();
  if (!config) fail('인스타그램 연결 설정이 필요합니다.', 503);
  if (accountId !== config.userId) fail('게시 계정이 변경되었습니다. 최신 연결 계정을 확인하고 다시 검토하세요.', 409);
  const imageUrl = item.uploadedImageId ? publicationImageUrl(item.uploadedImageId) : item.imageUrl;
  if (!imageUrl) fail('게시할 이미지를 업로드하고 저장하세요.');
  item.status = 'publishing'; item.error = undefined; item.instagramSkipped = undefined; item.instagramUserId = config.userId;
  await save(item);
  let publishAttempted = false;
  try {
    let parameters: Record<string, string> = { image_url: imageUrl, caption: item.caption };
    if (item.cards?.length) {
      if (![3, 4].includes(item.cards.length)) throw Error('카드뉴스 전체를 준비한 뒤 게시하세요.');
      const children: string[] = [];
      for (const card of item.cards) {
        const child = await instagramGraph(config, `${config.userId}/media`, { image_url: publicationImageUrl(card.imageId), is_carousel_item: 'true' });
        if (typeof child.id !== 'string') throw Error('카드 이미지 컨테이너 ID가 없습니다.');
        await waitForContainer(config, child.id);
        children.push(child.id);
      }
      parameters = { media_type: 'CAROUSEL', children: children.join(','), caption: item.caption };
    }
    const container = await instagramGraph(config, `${config.userId}/media`, parameters);
    if (typeof container.id !== 'string') throw Error('인스타그램 컨테이너 ID가 없습니다.');
    item.containerId = container.id; await save(item);
    await waitForContainer(config, container.id);
    signal?.throwIfAborted();
    publishAttempted = true;
    const result = await instagramGraph(config, `${config.userId}/media_publish`, { creation_id: container.id });
    if (typeof result.id !== 'string') throw Error('게시 결과 ID를 받지 못했습니다.');
    item.mediaId = result.id; item.publishedAt = new Date().toISOString(); item.status = 'published';
    await save(item);
  } catch (e) {
    item.status = publishAttempted ? 'unknown' : 'draft';
    item.error = publishAttempted ? '게시 결과를 확정할 수 없습니다. 인스타그램에서 직접 확인하세요. 중복 방지를 위해 재게시를 차단했습니다.' : message(e);
    await save(item);
  }
  return item;
}
setAutomationBusyCheck(() => !!creative || creating || busy.size > 0);
setAutomationRunner(async ({ photoId, text }, signal) => {
  if (creative || creating || busy.size) fail('다른 작업이 실행 중입니다. 관리자 화면에서 확인하세요.', 409);
  const source = await load(photoId);
  const id = photoId;
  await setAutomationEvent(id);
  return await locked(id, async () => {
    const level = (await piezoStatus()).level;
    const item: Publication = { input: { ...source.input, sensors: { ...source.input.sensors, piezoLevel: level } },
      prompt: DEFAULT_COVER_CONTEXT, transcript: text, piezoLevel: level, status: 'received', caption: '', imageUrl: '', revision: 0 };
    await save(item);
    signal.throwIfAborted();
    await generateCreative(item, signal);
    signal.throwIfAborted();
    if (item.status === 'skipped') return 'skipped' as const;
    if (item.status !== 'draft' || item.cards?.length !== 3) throw Error(item.error || '카드뉴스 생성 실패');
    const instagramPublishing = await instagramPublishingStatus();
    const config = instagramPublishing.enabled ? await getInstagramConnection() : null;
    if (instagramPublishing.enabled && !config) return;
    await publish(item, config?.userId, signal);
    // Instagram is best-effort. The generated article has already been saved to
    // the newspaper, so remote failures must not halt subsequent observations.
    if (item.status as string === 'unknown') return 'skipped' as const;
  });
});
async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('Content-Type: application/json이 필요합니다.', 415);
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += chunk.length; if (length > 16 * 1024 * 1024) fail('입력은 16MB 이하입니다.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { fail('올바른 JSON 객체가 필요합니다.'); }
}
export async function publicationRoutes(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/api/mobile/publications' || path.startsWith('/api/mobile/publications/')) {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const token = process.env.OBSERVATION_TOKEN;
    const expected = Buffer.from(`Bearer ${token ?? ''}`);
    if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('수신 토큰이 필요합니다.', 401);
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); fail('GET 요청이 필요합니다.', 405); }
    if (path === '/api/mobile/publications') {
      await mkdir(root, { recursive: true });
      const items = await Promise.all((await readdir(root)).filter(n => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(n)).map(n => load(n.slice(0, -5))));
      items.sort((a, b) => b.input.capturedAt.localeCompare(a.input.capturedAt));
      res.writeHead(200); res.end(JSON.stringify({ items: items.slice(0, 20).map(publicationStatus), automation: await automationStatus() })); return true;
    }
    const match = /^\/api\/mobile\/publications\/([a-zA-Z0-9_-]{1,100})(\/events)?$/.exec(path);
    if (!match) fail('게시물을 찾을 수 없습니다.', 404);
    const item = await load(match[1]);
    if (match[2]) subscribePublication(res, item, file(item.input.eventId));
    else { res.writeHead(200); res.end(JSON.stringify(publicationStatus(item))); }
    return true;
  }
  if (path !== '/api/publishing/piezo' && path !== '/api/publishing/instagram' && path !== '/api/piezo' && !path.startsWith('/api/received-photos') && !path.startsWith('/api/observations') && path !== '/api/publishing/status' && path !== '/api/publishing/restart' && path !== '/api/creations') return false;
  const send = (data: unknown, status = 200) => { res.writeHead(status); res.end(JSON.stringify(data)); return true; };
  if (req.method === 'GET' && path === '/api/received-photos') {
    await mkdir(root, { recursive: true });
    const items = await Promise.all((await readdir(root)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(root, n), 'utf8')) as Publication));
    return send({ items: items.filter(item => item.input.image && !item.input.eventId.startsWith('create-')).sort((a, b) => b.input.capturedAt.localeCompare(a.input.capturedAt)).map(item => ({ eventId: item.input.eventId, capturedAt: item.input.capturedAt })) });
  }
  const received = /^\/api\/received-photos\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
  if (req.method === 'GET' && received) {
    const item = await load(received[1]);
    if (!item.input.image) fail('사진이 없는 관측입니다.', 404);
    return send({ image: item.input.image });
  }
  // Only the intake endpoint may cross the existing local-only boundary, with a token.
  if (req.method === 'POST' && (path === '/api/piezo' || path === '/api/observations' && !req.headers.origin)) {
    const token = process.env.OBSERVATION_TOKEN;
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token ?? ''}`);
    if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('수신 토큰이 필요합니다.', 401);
  }
  if (req.method === 'POST' && path === '/api/publishing/piezo') {
    const value = await body(req);
    return send(await setPiezoLevel(value.piezoLevel));
  }
  if (path === '/api/publishing/instagram') {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('POST 요청이 필요합니다.', 405); }
    const value = await body(req);
    return send(await setInstagramPublishing(value.enabled));
  }
  if (req.method === 'POST' && path === '/api/piezo') {
    const value = await body(req);
    return send(await receivePiezoLevel(value.piezoLevel));
  }
  if (req.method === 'POST' && path === '/api/creations') {
    await assertAutomationIdle();
    const value = await body(req);
    await assertAutomationIdle();
    if (value.transcript !== undefined && (typeof value.transcript !== 'string' || value.transcript.length > 8000)) fail('녹취는 8,000자 이내의 텍스트여야 합니다.');
    if (value.piezoLevel !== undefined && ![0, 1, 2].includes(value.piezoLevel)) fail('피에조 단계는 0, 1, 2 중 하나입니다.');
    if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 2000)) fail('기사 맥락은 2,000자 이내로 입력하세요.');
    const automatic = value.sourcePhotoId !== undefined || value.sourceTranscriptId !== undefined;
    if (automatic && (!validId(value.sourcePhotoId) || !validId(value.sourceTranscriptId) || typeof value.transcript !== 'string' || !value.transcript.trim() || value.cards !== undefined)) fail('자동 생성에는 사진 ID와 텍스트 ID, 텍스트가 필요합니다.');
    if (automatic) value.piezoLevel = (await piezoStatus()).level;
    const id = automatic ? `create-${createHash('sha256').update(JSON.stringify([value.sourcePhotoId, value.sourceTranscriptId])).digest('hex')}` : `create-${randomUUID()}`;
    if (automatic) {
      let existing: Publication | undefined;
      try { existing = await load(id); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      if (existing) {
        if (existing.input.image !== value.image || existing.transcript !== value.transcript.trim()) fail('같은 수신 ID에 다른 데이터가 있습니다.', 409);
        return send(existing);
      }
    }
    await assertAutomationIdle();
    if (value.cards !== undefined) {
      if (creative || creating) fail('다른 이미지·게시문을 생성하고 있습니다. 완료 후 다시 시도하세요.', 409);
      creating = true;
      try {
        if (!Array.isArray(value.cards) || value.cards.length !== 3 || typeof value.caption !== 'string' || !value.caption.trim() || [...value.caption].length > 2200) fail('카드 3장과 2,200자 이내의 게시문이 필요합니다.');
        const cards: NonNullable<Publication['cards']> = [];
        for (const card of value.cards) {
          if (!card || typeof card.title !== 'string' || card.title.length > 500 || typeof card.body !== 'string' || card.body.length > 4000) fail('카드 내용이 올바르지 않습니다.');
          cards.push({ title: card.title, body: card.body, imageId: await savePublicationImage(card.image) });
        }
        const item: Publication = { input: { eventId: `create-${randomUUID()}`, capturedAt: new Date().toISOString(), sensors: { piezoLevel: value.piezoLevel ?? 0 } }, status: 'draft', revision: 0, caption: value.caption, imageUrl: '', cards, uploadedImageId: cards[0].imageId, piezoLevel: value.piezoLevel ?? 0, newsPublishedAt: new Date().toISOString() };
        await save(item);
        return send(item, 201);
      } finally { creating = false; }
    }
    if (creative || creating) fail('다른 이미지·게시문을 생성하고 있습니다. 완료 후 다시 시도하세요.', 409);
    creating = true;
    try {
    // Validate the normalized JPEG before scheduling any AI work.
    await savePublicationImage(value.image);
    if (creative) fail('다른 이미지·게시문을 생성하고 있습니다. 완료 후 다시 시도하세요.', 409);
    const item: Publication = { input: { eventId: id, capturedAt: new Date().toISOString(), sensors: { piezoLevel: value.piezoLevel ?? 0 }, image: value.image }, prompt: value.prompt?.trim() || DEFAULT_COVER_CONTEXT, piezoLevel: value.piezoLevel ?? 0, transcript: value.transcript?.trim() || undefined, status: 'received', caption: '', imageUrl: '', revision: 0 };
    return await locked(id, async () => { await save(item); send(item, 202); await generateCreative(item); return true; });
    } finally { creating = false; }
  }
  if (path === '/api/publishing/restart') {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('POST 요청이 필요합니다.', 405); }
    return send({ automation: await restartAutomation() });
  }
  if (path === '/api/publishing/status') {
    if (req.method === 'POST') return send({ automation: await resumeAutomation() });
    const within = async <T>(label: string, work: Promise<T>, fallback: T) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => {
          console.warn(`[publishing-status] ${label} lookup timed out`); resolve(fallback);
        }, 1500); timer.unref?.(); })]);
      } finally { clearTimeout(timer!); }
    };
    const [instagram, instagramPublishing, piezo, automation] = await Promise.all([
      within('instagram', instagramStatus(), { configured: false, oauthReady: false, redirectUri: '', accounts: [], selectedId: null, expired: false, mode: 'instagram' as const, missing: [] }),
      within('instagram-publishing', instagramPublishingStatus(), { enabled: false }),
      within('piezo', piezoStatus(), { level: 0 as const, expiresAt: null }),
      within('automation', automationStatus(), { status: 'halted' as const, accepting: false, hasPhoto: false, hasTranscript: false, generateAt: null, eventId: null, error: '수신 상태 조회가 지연되고 있습니다.' }),
    ]);
    return send({ ...instagram, instagramPublishing, piezo, automation });
  }
  if (req.method === 'GET' && path === '/api/observations') {
    await mkdir(root, { recursive: true });
    const items = await Promise.all((await readdir(root)).filter(n => n.endsWith('.json')).map(n => load(n.slice(0, -5))));
    return send({ items: items.sort((a,b) => b.input.capturedAt.localeCompare(a.input.capturedAt)).map(({ input, ...item }) => ({ ...item, input: { ...input, image: undefined, audio: undefined } })) });
  }
  if (req.method === 'POST' && path === '/api/observations') {
    let accepted: Publication | undefined;
    await receiveAutomatic('photo', async () => {
      const input = validate(await body(req));
      if (!input.image) {
        await locked(input.eventId, async () => {
          let existing: Publication | undefined;
          try { existing = await load(input.eventId); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
          if (existing) {
            if (!isDeepStrictEqual(existing.input, input)) fail('같은 eventId에 다른 데이터가 있습니다.', 409);
            send(existing); return;
          }
          const item: Publication = { input, status: 'received', caption: '', imageUrl: '', revision: 0 };
          await save(item); send(item, 202); await generate(item);
        });
        return null;
      }
      try { await readFile(file(input.eventId)); fail('이미 수신한 eventId입니다.', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      accepted = { input, status: 'received', awaitingInput: true, caption: '', imageUrl: '', revision: 0 };
      await save(accepted);
      if (input.sensors.piezoLevel !== undefined) await receivePiezoLevel(input.sensors.piezoLevel);
      return { id: input.eventId };
    });
    return accepted ? send(accepted, 202) : true;
  }
  const match = /^\/api\/observations\/([a-zA-Z0-9_-]{1,100})(?:\/(generate|publish|image|cards\/[0-3]))?$/.exec(path);
  if (!match) return send({ error: 'Not found' }, 404);
  const [, id, action] = match;
  if (req.method === 'GET' && action?.startsWith('cards/')) {
    const item = await load(id);
    const card = item.cards?.[Number(action.split('/')[1])];
    if (!card) fail('카드 이미지를 찾을 수 없습니다.', 404);
    sendPublicationImage(res, await readPublicationImage(card.imageId)); return true;
  }
  if (req.method === 'GET' && action === 'image') {
    const item = await load(id);
    if (!item.uploadedImageId) fail('저장된 이미지가 없습니다.', 404);
    sendPublicationImage(res, await readPublicationImage(item.uploadedImageId)); return true;
  }
  if (req.method === 'GET' && !action) return send(await load(id));
  if (req.method !== 'POST' && req.method !== 'PATCH') return send({ error: 'Method not allowed' }, 405);
  await assertAutomationIdle();
  const input = await body(req);
  await load(id);
  await assertAutomationIdle();
  return locked(id, async () => {
    const item = JSON.parse(await readFile(file(id), 'utf8')) as Publication;
    if (req.method === 'PATCH' && !action) {
      if (item.status !== 'draft') fail('초안 상태에서만 수정할 수 있습니다.', 409);
      if (input.revision !== item.revision) fail('초안이 변경되었습니다. 새로고침 후 다시 검토하세요.', 409);
      if (typeof input.caption !== 'string' || !input.caption.trim() || [...input.caption].length > 2200) fail('게시문은 1~2,200자입니다.');
      if (typeof input.imageUrl !== 'string' || input.imageUrl.length > 2000) fail('이미지 URL을 확인하세요.');
      if (input.imageUrl) {
        let url: URL; try { url = new URL(input.imageUrl); } catch { fail('올바른 HTTPS 이미지 URL이 필요합니다.'); }
        if (url.protocol !== 'https:' || url.username || url.password) fail('인증 정보가 없는 HTTPS 이미지 URL이 필요합니다.');
      }
      if (item.cards?.length && (input.image !== undefined || input.removeImage === true || input.imageUrl)) fail('카드뉴스 이미지는 한 세트입니다. 전체 다시 생성으로 변경하세요.');
      if (input.image !== undefined) { item.uploadedImageId = await savePublicationImage(input.image); input.imageUrl = ''; }
      else if (input.removeImage === true || input.imageUrl) item.uploadedImageId = undefined;
      item.caption = input.caption.trim(); item.imageUrl = input.imageUrl; item.revision++; item.error = undefined;
      await save(item); return send(item);
    }
    if (req.method === 'POST' && action === 'generate') {
      if (!['failed', 'draft'].includes(item.status)) fail('현재 상태에서는 다시 생성할 수 없습니다.', 409);
      if (item.prompt) {
        if (input.piezoLevel !== undefined && ![0, 1, 2].includes(input.piezoLevel)) fail('피에조 단계는 0, 1, 2 중 하나입니다.');
        if (creative || creating) fail('다른 이미지·게시문을 생성하고 있습니다. 완료 후 다시 시도하세요.', 409);
        if (input.revision !== item.revision) fail('최신 초안에서 다시 생성하세요.', 409);
        creating = true;
        try {
          if (input.piezoLevel !== undefined) { item.piezoLevel = input.piezoLevel; item.input.sensors.piezoLevel = input.piezoLevel; }
          item.status = 'generating'; item.generationProgress = undefined; item.phase = '생성 준비 중'; item.error = undefined;
          await save(item); send(item, 202);
          await generateCreative(item); return true;
        } finally { creating = false; }
      }
      await generate(item); return send(item);
    }
    if (req.method === 'POST' && action === 'publish') {
      if (input.revision !== item.revision) fail('저장된 최신 초안을 검토한 뒤 게시하세요.', 409);
      return send(await publish(item, input.accountId));
    }
    return send({ error: 'Method not allowed' }, 405);
  });
}

import { claudeFixture } from './fixtures/claude-mock.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('photo and prompt produce paired draft, serialize generation, preserve source and block failed results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overheard-creative-'));
  process.env.OBSERVATION_TOKEN = 'test-intake';
  process.env.TRANSCRIPTS_DATA_DIR = join(dir, 'transcripts');
  process.env.AUTOMATION_STATE_FILE = join(dir, 'automation/state.json');
  process.env.AI_SETTINGS_FILE = join(dir, 'ai-settings.json'); process.env.TEXT_PROVIDER = 'ollama';
  process.env.PUBLICATIONS_DIR = join(dir, 'posts'); process.env.PUBLICATION_IMAGES_DIR = join(dir, 'images');
  process.env.INSTAGRAM_USER_ID = '123'; process.env.INSTAGRAM_ACCESS_TOKEN = 'test-token';
  process.env.PUBLISH_MEDIA_SECRET = 'test-secret'; process.env.INSTAGRAM_MEDIA_ORIGIN = 'https://example.com';
  process.env.INSTAGRAM_API_VERSION = 'v25.0';
  const graphRequests: { path: string; params: Record<string, string> }[] = [];
  let childFails = false;
  let holdPublish = false, uncertainPublish = false;
  let releasePublish: (() => void) | undefined;
  let seenSystem = '';
  const { publicationRoutes } = await import('./publishing.ts');
  const { receiveTranscript } = await import('./transcripts.ts');
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  const nativeFetch = globalThis.fetch;
  const jpeg = await readFile(new URL('./fixtures/publication.jpg', import.meta.url));
  let mode = 'hold', release: (() => void) | undefined, seenPrompt = '', seenImage = '', graph: any, cancelCount = 0;
  t.mock.method(globalThis, 'fetch', claudeFixture(async (url: string | URL | Request, init?: RequestInit) => {
    const value = new URL(String(url));
    if (value.pathname === '/api/chat') {
      const data = JSON.parse(String(init?.body));
      if (data.format.required.includes('skip')) return Response.json({ message: { content: JSON.stringify({ skip: mode === 'blurry' }) } });
      seenSystem = data.messages[0].content; seenPrompt = data.messages[1].content; seenImage = data.messages[1].images[0];
      if (mode === 'hold') await new Promise<void>(r => { release = r; });
      return Response.json({ message: { content: mode === 'badAI' ? 'invalid' : JSON.stringify({ caption: '창가에 놓인 테이블을 살펴봅니다.', headline: mode === 'badImage' ? '' : '창가에서 발견한 작은 풍경', cards: mode === 'badCards' ? [] : [{ crop: [0, 0, 0.75, 0.75], title: '창가의 작은 테이블', body: '사진 속 창가에 테이블이 놓여 있습니다. 시선을 붙잡은 디테일은 무엇일까요?' }, { title: '당신의 시선이 머문 곳은', body: '창가와 테이블, 어느 쪽에 먼저 눈이 갔나요?' }] }) } });
    }
    if (value.hostname === 'graph.instagram.com') {
      const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
      graphRequests.push({ path: value.pathname, params });
      if (value.pathname.endsWith('/media_publish')) {
        if (holdPublish) await new Promise<void>(resolve => { releasePublish = resolve; });
        if (uncertainPublish) throw Error('timeout after remote commit');
        return Response.json({ id: 'published-carousel' });
      }
      if (value.searchParams.has('fields')) return Response.json({ status_code: 'FINISHED' });
      if (childFails && params.is_carousel_item) return Response.json({ error: { code: 100 } }, { status: 400 });
      return Response.json({ id: `container-${graphRequests.length}` });
    }
    if (value.pathname === '/object_info') {
      const names = ['CheckpointLoaderSimple','LoadImage','ImageScaleToMaxDimension','VAEEncode','CLIPTextEncode','KSampler','VAEDecode','SaveImage'];
      return Response.json(Object.fromEntries(names.map(name => [name, { input: { required: name === 'CheckpointLoaderSimple' ? { ckpt_name: [['sd_xl_base_1.0.safetensors']] } : name === 'KSampler' ? { sampler_name: [['dpmpp_2m']], scheduler: [['karras']] } : {} } }])));
    }
    if (value.pathname === '/upload/image') return Response.json({ name: 'photo.jpg' });
    if (value.pathname === '/prompt') { const data = JSON.parse(String(init?.body)); graph = data.prompt; return Response.json({ prompt_id: data.prompt_id }); }
    if (value.pathname.startsWith('/history/')) {
      const id = value.pathname.split('/').at(-1)!;
      return Response.json({ [id]: mode === 'badImage' ? { status: { status_str: 'error', messages: [] } } : { outputs: { '9': { images: [{ filename: 'image.png', type: 'output', subfolder: '' }] } } } });
    }
    if (value.pathname === '/view') return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
    if (value.pathname.endsWith('/cancel')) { cancelCount++; return Response.json({ cancelled: true }); }
    return nativeFetch(url, init);
  }));
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try { if (req.url === '/api/transcripts') { await receiveTranscript(req, res); return; } await publicationRoutes(req, res, new URL(req.url!, 'http://localhost').pathname); }
    catch (e) { if (!res.writableEnded) { res.writeHead((e as { status?: number }).status ?? 500); res.end(JSON.stringify({ error: (e as Error).message })); } }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(path: string, method = 'GET', body?: unknown) {
    const r = await nativeFetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-intake' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  async function settled(id: string) {
    for (let n = 0; n < 3000; n++) { const r = await call(`/api/observations/${id}`); if (['draft','failed'].includes(r.data.status)) return r.data; await new Promise(r => setTimeout(r, 10)); }
    throw Error('Generation did not finish');
  }
  const image = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const input = { sourcePhotoId: 'photo-1', sourceTranscriptId: 'text-1', image, transcript: '오늘 프로젝트 시연을 했습니다.', prompt: '사진을 따뜻한 수채화 카페로 바꾸고 짧은 글을 써줘' };
  try {
    assert.equal((await call('/api/creations', 'POST', { ...input, transcript: {} })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...input, transcript: 'x'.repeat(8001) })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...input, piezoLevel: 3 })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...input, piezoLevel: '2' })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...input, prompt: 'x'.repeat(2001) })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...input, image: 'bad' })).status, 400);
    const previewInput = { caption: '미리보기에서 확인한 게시문', piezoLevel: 1, cards: Array.from({ length: 3 }, (_, index) => ({ title: `카드 ${index}`, body: '확인한 본문', image })) };
    assert.equal((await call('/api/creations', 'POST', { ...previewInput, cards: [] })).status, 400);
    assert.equal((await call('/api/creations', 'POST', { ...previewInput, cards: previewInput.cards.map(card => ({ ...card, image: 'bad' })) })).status, 400);
    const imported = await call('/api/creations', 'POST', previewInput);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.status, 'draft');
    assert.equal(imported.data.caption, previewInput.caption);
    assert.equal(imported.data.cards.length, 3);
    assert.equal(imported.data.uploadedImageId, imported.data.cards[0].imageId);
    assert.deepEqual((await call(`/api/observations/${imported.data.input.eventId}`)).data, imported.data);
    const cardResponse = await nativeFetch(`${base}/api/observations/${imported.data.input.eventId}/cards/0`);
    assert.deepEqual(Buffer.from(await cardResponse.arrayBuffer()), jpeg);
    const { receivePiezoLevel } = await import('./piezo.ts');
    await receivePiezoLevel(1);
    const created = await call('/api/creations', 'POST', input); assert.equal(created.status, 202);
    const id = created.data.input.eventId;
    const duplicate = await call('/api/creations', 'POST', input);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.input.eventId, id);
    assert.equal((await call('/api/creations', 'POST', { ...input, sourcePhotoId: 'photo-2' })).status, 409);
    assert.equal((await call('/api/creations', 'POST', { ...input, transcript: 'different' })).status, 409);
    assert.equal((await call(`/api/observations/${id}/publish`, 'POST', { revision: 0 })).status, 409);
    for (let n = 0; !release && n < 100; n++) await new Promise(r => setTimeout(r, 10));
    assert.ok(release); mode = 'ok'; release();
    const draft = await settled(id);
    assert.ok(draft.caption.endsWith('\n\n온정한 기자 (warm@paparazzi.bot)'));
    assert.equal(draft.status, 'draft', draft.error); assert.ok(draft.uploadedImageId); assert.equal(draft.input.image, image);
    assert.equal(draft.cards.length, 3); assert.equal(new Set(draft.cards.map((c: { imageId: string }) => c.imageId)).size, 3);
    assert.equal(draft.piezoLevel, 1); assert.match(seenSystem, /1단계: 조금 착한/);
    assert.equal(draft.prompt, input.prompt); assert.deepEqual(JSON.parse(seenPrompt), { context: input.prompt, transcript: input.transcript }); assert.equal(draft.transcript, input.transcript); assert.equal(seenImage, jpeg.toString('base64'));
    assert.equal(graph, undefined); assert.match(draft.generatedImagePrompt, /생성형 확장/); assert.equal(draft.revision, 1);
    const preview = await nativeFetch(`${base}/api/observations/${id}/image`);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg'); assert.ok((await preview.arrayBuffer()).byteLength > 1000);
    for (let index = 0; index < 3; index++) {
      const card = await nativeFetch(`${base}/api/observations/${id}/cards/${index}`);
      assert.equal(card.status, 200); assert.equal(card.headers.get('content-type'), 'image/jpeg');
    }
    assert.equal((await call(`/api/observations/${id}`, 'PATCH', { revision: 1, caption: draft.caption, imageUrl: '', removeImage: true })).status, 400);
    assert.equal((await call(`/api/observations/${id}/generate`, 'POST', { revision: 0 })).status, 409);
    mode = 'badImage';
    assert.equal((await call(`/api/observations/${id}/generate`, 'POST', { revision: 1 })).status, 202);
    const failed = await settled(id); assert.equal(failed.status, 'failed'); assert.equal(failed.caption, draft.caption); assert.equal(failed.uploadedImageId, draft.uploadedImageId);
    assert.equal(cancelCount, 0);
    assert.equal((await call(`/api/observations/${id}/publish`, 'POST', { revision: 1 })).status, 409);
    mode = 'badAI'; await call(`/api/observations/${id}/generate`, 'POST', { revision: 1 }); assert.equal((await settled(id)).status, 'failed');
    mode = 'badCards'; await call(`/api/observations/${id}/generate`, 'POST', { revision: 1 }); assert.equal((await settled(id)).status, 'failed');
    mode = 'ok'; await call(`/api/observations/${id}/generate`, 'POST', { revision: 1, piezoLevel: 2 }); const regenerated = await settled(id); assert.ok(regenerated.caption.endsWith('\n\n찬양해 기자 (praise@paparazzi.bot)')); assert.equal(regenerated.revision, 2); assert.equal(regenerated.piezoLevel, 2); assert.equal(regenerated.transcript, input.transcript); assert.equal(JSON.parse(seenPrompt).transcript, input.transcript); assert.match(seenSystem, /2단계: 完全|2단계: 완전 아첨/);
    const automatic = await call('/api/creations', 'POST', { image }); assert.equal(automatic.status, 202);
    assert.equal((await settled(automatic.data.input.eventId)).status, 'draft');
    childFails = true;
    const failedPublish = await call(`/api/observations/${id}/publish`, 'POST', { revision: 2, accountId: '123' });
    assert.equal(failedPublish.data.status, 'draft');
    assert.equal(graphRequests.filter(r => r.path.endsWith('/media_publish')).length, 0);
    childFails = false; graphRequests.length = 0;
    const published = await call(`/api/observations/${id}/publish`, 'POST', { revision: 2, accountId: '123' });
    assert.equal(published.data.status, 'published');
    const children = graphRequests.filter(r => r.params.is_carousel_item === 'true');
    assert.equal(children.length, 3);
    for (const [index, request] of children.entries()) assert.ok(request.params.image_url.includes(regenerated.cards[index].imageId));
    const parent = graphRequests.find(r => r.params.media_type === 'CAROUSEL');
    assert.ok(parent); assert.equal(parent.params.children.split(',').length, 3); assert.equal(parent.params.caption, regenerated.caption);
    assert.equal(graphRequests.filter(r => r.path.endsWith('/media_publish')).length, 1);
    await call(`/api/observations/${id}/publish`, 'POST', { revision: 2, accountId: '123' });
    assert.equal(graphRequests.filter(r => r.path.endsWith('/media_publish')).length, 1);
    const receivedAgain = await call('/api/creations', 'POST', input);
    assert.equal(receivedAgain.status, 200);
    assert.equal(receivedAgain.data.status, 'published');
    assert.equal(receivedAgain.data.mediaId, published.data.mediaId);
    assert.equal(graphRequests.filter(r => r.path.endsWith('/media_publish')).length, 1);
    const waitAutomation = async (status: string) => {
      for (let n = 0; n < 3000; n++) {
        const current = (await call('/api/publishing/status')).data.automation;
        if (current.status === status && (status !== 'waiting' || !current.hasPhoto)) return current;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`Automation did not reach ${status}`);
    };
    const finalText = (interactionId: string, text: string) => call('/api/transcripts', 'POST', {
      interactionId, text, startedAt: '2026-11-07T00:00:00.000Z', endedAt: '2026-11-07T00:00:20.000Z',
    });
    const photo = { eventId: 'phone-1', capturedAt: new Date().toISOString(), sensors: {}, image };
    mode = 'hold'; release = undefined; holdPublish = true;
    assert.equal((await call('/api/observations', 'POST', photo)).status, 202);
    assert.equal((await call('/api/mobile/publications/phone-1')).data.status, 'received');
    assert.equal((await finalText('phone-1', '새 휴대폰 대화')).status, 201);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    for (let n = 0; !release && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release);
    assert.equal((await finalText('unrelated-phone', '생성 중 대화')).status, 201);
    assert.equal((await call('/api/observations', 'POST', { ...photo, eventId: 'discarded' })).status, 409);
    assert.equal((await call('/api/creations', 'POST', { image })).status, 409);
    assert.equal((await call('/api/observations/discarded')).status, 404);
    mode = 'ok'; release();
    for (let n = 0; !releasePublish && n < 1000; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releasePublish);
    assert.equal((await call('/api/mobile/publications/phone-1')).data.status, 'publishing');
    assert.equal((await finalText('phone-2', '게시 중 대화')).status, 201);
    assert.equal((await call('/api/observations', 'POST', { ...photo, eventId: 'discarded-publish' })).status, 409);
    holdPublish = false; releasePublish();
    await waitAutomation('waiting');
    assert.equal((await call('/api/mobile/publications/phone-1')).data.status, 'published');
    assert.equal((await call('/api/observations/phone-1')).data.transcript, '새 휴대폰 대화');
    assert.equal((await call('/api/observations', 'POST', photo)).status, 409);
    uncertainPublish = true;
    assert.equal((await call('/api/observations', 'POST', { ...photo, eventId: 'phone-2' })).status, 202);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const readyForNext = await waitAutomation('waiting');
    assert.equal(readyForNext.accepting, true);
    assert.equal(readyForNext.hasPhoto, false);
    assert.equal(readyForNext.hasTranscript, false);
    assert.equal((await call('/api/mobile/publications/phone-2')).data.status, 'unknown');
    assert.equal((await call('/api/observations/phone-2')).data.transcript, '게시 중 대화');
    assert.match(seenPrompt, /게시 중 대화/);
    assert.doesNotMatch(seenPrompt, /생성 중 대화/);
    const attempted = graphRequests.filter(r => r.path.endsWith('/media_publish')).length;
    assert.equal((await call('/api/transcripts', 'POST', { text: '중단 중 대화' })).status, 201);
    assert.equal(graphRequests.filter(r => r.path.endsWith('/media_publish')).length, attempted);
    await call('/api/publishing/status', 'POST', {});
    assert.equal((await call('/api/publishing/status')).data.automation.hasPhoto, false);
    mode = 'blurry';
    const beforeSkip = graphRequests.length;
    await call('/api/observations', 'POST', { ...photo, eventId: 'blurry-photo' });
    await finalText('blurry-photo', '흐린 사진의 대화');
    const afterSkip = await waitAutomation('waiting');
    const skipped = (await call('/api/observations/blurry-photo')).data;
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.cards, undefined);
    assert.equal(skipped.caption, '');
    assert.equal(graphRequests.length, beforeSkip);
    assert.equal(afterSkip.accepting, true);
    assert.equal(afterSkip.hasPhoto, false);
    assert.equal(afterSkip.hasTranscript, false);
    assert.equal((await call('/api/mobile/publications/blurry-photo')).data.phase, '초점·흔들림으로 스킵');
    assert.equal((await finalText('after-skip', '다음 사진의 20초 대화')).status, 201);
    assert.equal((await call('/api/observations', 'POST', { ...photo, eventId: 'after-skip' })).status, 202);
    await waitAutomation('waiting');
    await call('/api/publishing/status', 'POST', {});

  } finally { release?.(); await (await import('./automation.ts')).restartAutomation().catch(() => {}); t.mock.restoreAll(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});

test('card validation reports the exact card and constraint', async () => {
  const { cardValidationError } = await import('./creative.ts');
  const cards = Array.from({ length: 2 }, () => ({ title: '제목', body: '본문' }));
  assert.equal(cardValidationError(cards), undefined);
  assert.match(cardValidationError([])!, /정확히 2개/);
  cards[1].body = '가'.repeat(141);
  assert.match(cardValidationError(cards)!, /3장 본문.*141자/);
  cards[1].body = '본문';
  assert.match(cardValidationError([{ ...cards[0], crop: [0, 0, 0.2, 1] }, cards[1]])!, /2장 크롭/);
  assert.equal(cardValidationError([{ ...cards[0], crop: [0.25, 0.25, 0.75, 0.75] }, cards[1]]), undefined);
  cards[0].title = '제목\n';
  assert.match(cardValidationError(cards)!, /2장 제목.*줄바꿈/);
});

test('invalid cards retry once with feedback, then report the remaining error', async t => {
  const { creativePost } = await import('./creative.ts');
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ caption: '게시문', headline: '제목', privacyRegions: [], cards: [] }) }] });
  });
  await assert.rejects(creativePost('data:image/jpeg;base64,AA==', '사진', new AbortController().signal, async () => {}, () => Promise.resolve()), /재생성 실패.*정확히 2개/);
  assert.equal(requests.length, 2);
  assert.match(requests[1].system, /이전 응답의 검증 오류.*정확히 2개/);
});

test('photo quality accepts only a boolean decision and preserves check failures', async t => {
  const { shouldSkipPhoto } = await import('./creative.ts');
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  let reply = '{"skip":false}';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }));
  const signal = new AbortController().signal;
  assert.equal(await shouldSkipPhoto('data:image/jpeg;base64,AA==', signal), false);
  reply = '{"skip":true}';
  assert.equal(await shouldSkipPhoto('data:image/jpeg;base64,AA==', signal), true);
  reply = '{"skip":"false"}';
  await assert.rejects(shouldSkipPhoto('data:image/jpeg;base64,AA==', signal), /有効|유효/);
  reply = 'invalid';
  await assert.rejects(shouldSkipPhoto('data:image/jpeg;base64,AA==', signal), /읽지 못했습니다/);
});

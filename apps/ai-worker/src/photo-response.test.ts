import { readApiResponse } from './api-response.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPhotoData, readPhotoResponse } from './photo-response.ts';

test('HTML response is explained without a JSON parse error', async () => {
  await assert.rejects(readPhotoResponse(new Response('<!DOCTYPE html>', { status: 502, headers: { 'Content-Type': 'text/html' } })), /HTTP 502/);
  assert.deepEqual(await readPhotoResponse(Response.json({ image: 'photo' })), { image: 'photo' });
});
test('temporary HTML response retries and returns the photo', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('<!DOCTYPE html>', { status: 502 }) : Response.json({ image: 'photo' }));
  assert.deepEqual(await fetchPhotoData('/api/received-photos/example'), { image: 'photo' });
  assert.equal(calls, 2);
});

test('API HTML and invalid JSON responses show a readable error', async () => {
  await assert.rejects(readApiResponse(new Response('<!DOCTYPE html>', { status: 524, headers: { 'Content-Type': 'text/html' } })), /HTTP 524/);
  await assert.rejects(readApiResponse(new Response('<!DOCTYPE html>', { headers: { 'Content-Type': 'application/json' } })), /서버 응답/);
  assert.deepEqual(await readApiResponse(Response.json({ status: 'completed' })), { status: 'completed' });
});

import { receiveAutomatic } from './automation.ts';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail } from './local.ts';

export { receivedTranscripts } from './transcript-store.ts';
import { receivedTranscripts, saveTranscript, type TranscriptSegment } from './transcript-store.ts';

export async function latestTranscript() {
  return (await receivedTranscripts()).at(-1) ?? null;
}

export async function receiveTranscript(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    fail('허용되지 않은 메서드입니다.', 405);
  }
  const token = process.env.OBSERVATION_TOKEN;
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token ?? ''}`);
  if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail('수신 토큰이 필요합니다.', 401);
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail('JSON 요청이 필요합니다.', 415);
  const receipt = await (async () => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 64 * 1024) fail('입력 크기는 64KB 이하로 제한됩니다.', 413);
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('올바른 JSON 입력이 필요합니다.'); }
    if (!value || Array.isArray(value) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 12000)
      fail('text는 비어 있지 않은 12,000자 이내의 대화 텍스트여야 합니다.');
    let segment: TranscriptSegment | undefined;
    if (value.interactionId !== undefined || value.startedAt !== undefined || value.endedAt !== undefined) {
      if (typeof value.interactionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.interactionId))
        fail('interactionId는 사진의 eventId와 같은 1~100자 영문·숫자·밑줄·하이픈이어야 합니다.');
      const isoTime = (input: unknown): string => {
        if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input)))
          fail('startedAt과 endedAt은 시간대를 포함한 ISO-8601 시각이어야 합니다.');
        return new Date(input).toISOString();
      };
      const startedAt = isoTime(value.startedAt), endedAt = isoTime(value.endedAt);
      if (endedAt <= startedAt) fail('endedAt은 startedAt보다 늦어야 합니다.');
      segment = { interactionId: value.interactionId, startedAt, endedAt };
    }
    return saveTranscript(value.text.trim(), segment);
  })();
  try {
    if (receipt.interactionId) await receiveAutomatic('text', async () => receipt);
  } catch (error) {
    // The final transcript remains available only for its matching photo.
    if ((error as { status?: number }).status !== 409) throw error;
  }
  res.writeHead(201);
  res.end(JSON.stringify({ id: receipt.id, receivedAt: receipt.receivedAt, interactionId: receipt.interactionId }));
}

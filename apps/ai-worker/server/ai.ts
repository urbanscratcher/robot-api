import { localFetch, fail } from './local.ts';

export const usesClaude = () => true;
export const textModel = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
export function aiSettings() {
  return { enabled: true, locked: true, configured: !!process.env.ANTHROPIC_API_KEY, model: textModel() };
}
export function setClaudeEnabled(enabled: boolean) {
  if (!enabled) fail('Claude API 전용입니다. 로컬 모델로 전환할 수 없습니다.');
  return aiSettings();
}

// Keep the existing chat response shape so article validation stays at each caller.
export async function chatFetch(init: RequestInit = {}, ms = 240000, signal?: AbortSignal) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) fail('Claude API 키가 없습니다. 서버 .env에 ANTHROPIC_API_KEY를 설정하세요.', 503);
  const input = JSON.parse(String(init.body)) as {
    format: unknown;
    options?: { num_predict?: number };
    messages: { role: string; content: string; images?: string[] }[];
  };
  const system = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const messages = input.messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: [
      ...(m.images || []).map(data => {
        const bytes = Buffer.from(data, 'base64');
        const media_type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/jpeg';
        return { type: 'image', source: { type: 'base64', media_type, data } };
      }),
      { type: 'text', text: m.content },
    ],
  }));
  let response: Response;
  try {
    response = await localFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: textModel(), max_tokens: input.options?.num_predict || 3000,
        system: system + '\nReturn only a JSON object matching this schema, without Markdown: ' + JSON.stringify(input.format),
        messages,
      }),
    }, ms, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    fail('Claude 연결 실패 또는 생성 시간 초과. 네트워크를 확인하세요.', 503);
  }
  if (!response.ok) {
    const reason = response.status === 401 ? 'API 키를 확인하세요.'
      : response.status === 402 ? 'API 결제 잔액을 확인하세요.'
      : response.status === 429 ? '사용 한도 또는 요청 빈도를 확인하세요.' : '모델 설정과 API 사용 가능 여부를 확인하세요.';
    fail(`Claude 생성 실패 (${response.status}). ${reason}`, 502);
  }
  let result: { stop_reason?: string; content?: { type: string; text?: string }[] };
  try { result = await response.json(); }
  catch { fail('Claude 응답 형식을 읽지 못했습니다. 다시 시도하세요.', 502); }
  if (!result || !Array.isArray(result.content)) fail('Claude 응답 형식이 올바르지 않습니다.', 502);
  if (result.stop_reason !== 'end_turn') fail('Claude 응답이 완료되지 않았습니다. 다시 생성하세요.', 502);
  const content = result.content?.filter(b => b.type === 'text').map(b => b.text || '').join('') || '';
  const cleaned = content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\s*```$/, '');
  if (!cleaned) fail('Claude 응답이 비어 있습니다. 다시 생성하세요.', 502);
  return Response.json({ message: { content: cleaned.split(key).join('[redacted]') } });
}

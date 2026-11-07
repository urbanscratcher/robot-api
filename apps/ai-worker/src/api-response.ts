export async function readApiResponse(response: Response) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw Error(`서버 연결이 끊겼거나 응답이 지연되었습니다 (HTTP ${response.status}). 잠시 후 다시 시도해 주세요.`);
  }
  try { return await response.json(); }
  catch { throw Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
}

export async function request<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.timeout(75000), cache: 'no-store', method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const data = await readApiResponse(response);
  if (!response.ok) throw Error(data.error || '요청에 실패했습니다.');
  return data;
}

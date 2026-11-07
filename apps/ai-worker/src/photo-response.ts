export async function readPhotoResponse(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw Error(`사진 서버가 정상 응답을 보내지 않았습니다 (HTTP ${response.status}). 잠시 후 자동으로 다시 확인합니다.`);
  }
  try { return await response.json(); }
  catch { throw Error('사진 서버의 응답을 읽지 못했습니다. 잠시 후 자동으로 다시 확인합니다.'); }
}

export async function fetchPhotoData<T>(path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(path, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (attempt === 0 && ([502, 503, 504, 520, 522, 524].includes(response.status) || response.ok && !response.headers.get('content-type')?.includes('application/json'))) {
      await response.body?.cancel();
      continue;
    }
    const data = await readPhotoResponse(response) as T & { error?: string };
    if (!response.ok) throw Object.assign(Error(data.error || '사진을 불러오지 못했습니다.'), { status: response.status });
    return data;
  }
}

import { useEffect, useRef, useState } from 'react';
import { readApiResponse } from './api-response';

export type Transcript = { id: string; text: string; receivedAt: string };

export function ReceivedTranscripts({ paused = false, onReceive }: { paused?: boolean; onReceive?: (item: Transcript | null) => void }) {
  const callback = useRef(onReceive);
  callback.current = onReceive;
  const [items, setItems] = useState<Transcript[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch('/api/received-transcripts', { signal: controller.signal, cache: 'no-store' });
        if (response.status === 403) { setLocked(true); setError(''); return; }
        const data = await readApiResponse(response);
        if (!response.ok) throw Error(data.error || '수신 텍스트를 불러오지 못했습니다.');
        if (controller.signal.aborted) return;
        setItems(data.items ?? (data.item ? [data.item] : [])); callback.current?.(data.item); setLoaded(true); setLocked(false); setError('');
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '수신 텍스트 조회 실패');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 4000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paused]);
  return <section className="received-transcript" aria-label="수신 텍스트">
    <h2>수신 텍스트</h2>
    <p className="setup-note">{locked ? '관리자 인증을 완료하면 휴대폰에서 보낸 텍스트를 볼 수 있습니다.' : paused ? 'AI 생성·뉴스 게시 중에는 새 텍스트 확인을 잠시 멈춥니다.' : '4초마다 휴대폰에서 보낸 새 텍스트를 확인합니다.'}</p>
    {!locked && !loaded && !error && <p role="status">수신 텍스트를 확인하고 있습니다.</p>}
    {!locked && loaded && items.length === 0 && !error && <p>아직 수신한 텍스트가 없습니다.</p>}
    {!locked && items.map(item => <div key={item.id}>
      <p className="setup-note">수신 시각: <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString('ko-KR')}</time></p>
      <p className="received-transcript-text">{item.text}</p>
    </div>)}
    {error && <p className="publication-error" role="alert">{error}</p>}
  </section>;
}

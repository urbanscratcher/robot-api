import { fetchPhotoData } from './photo-response';
import { useEffect, useRef, useState } from 'react';
import { preparePublicationImage } from './publication-image';

type Photo = { eventId: string; capturedAt: string };
export function ReceivedPhotos({ onSelect, onPreparing, paused = false }: { paused?: boolean; onPreparing: (value: boolean) => void; onSelect: (image: string, eventId: string) => void }) {
  const callbacks = useRef({ onSelect, onPreparing });
  callbacks.current = { onSelect, onPreparing };
  const selected = useRef('');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [locked, setLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (paused) {
      setLoading(false); callbacks.current.onPreparing(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await fetchPhotoData<{ items: Photo[] }>('/api/received-photos', controller.signal);
        if (controller.signal.aborted) return;
        setLocked(false); setLoaded(true); setError('');
        const latest = data.items[0];
        if (latest && latest.eventId !== selected.current) {
          setLoading(true); callbacks.current.onPreparing(true);
          const data = await fetchPhotoData<{ image: string }>(`/api/received-photos/${encodeURIComponent(latest.eventId)}`, controller.signal);
          if (typeof data.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(data.image)) throw Error('수신한 사진 형식이 올바르지 않습니다.');
          const blob = await (await fetch(data.image, { signal: controller.signal })).blob();
          const image = await preparePublicationImage(new File([blob], 'received-photo', { type: blob.type }));
          if (controller.signal.aborted) return;
          callbacks.current.onSelect(image, latest.eventId); selected.current = latest.eventId; setPhoto(latest);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if ((error as { status?: number }).status === 403) { setLocked(true); setError(''); }
        else setError(error instanceof Error ? error.message : '수신 사진 조회 실패');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false); callbacks.current.onPreparing(false);
          timer = setTimeout(() => void refresh(), 4000);
        }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paused]);
  return <section aria-label="최신 수신 사진">
    <h2>최신 수신 사진</h2>
    <p className="setup-note">{locked ? '관리자 인증을 완료하면 홈 서버에서 보낸 사진을 볼 수 있습니다.' : paused ? 'AI 생성·뉴스 게시 중에는 새 사진 확인을 잠시 멈춥니다.' : '4초마다 새 사진을 확인하고 최신 사진을 자동으로 표시합니다.'}</p>
    {!locked && !loaded && !error && <p role="status">수신 사진을 확인하고 있습니다.</p>}
    {!locked && loaded && !photo && !loading && !error && <p>아직 수신한 사진이 없습니다.</p>}
    {!locked && photo && <p>촬영 시각: {new Date(photo.capturedAt).toLocaleString('ko-KR')}</p>}
    {loading && <p role="status">최신 사진을 가져오고 있습니다.</p>}
    {error && <p className="publication-error" role="alert">{error}</p>}
  </section>;
}

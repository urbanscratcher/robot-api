import { request } from './api-response';
import { useEffect, useRef, useState } from 'react';
import { PiezoControl } from './PiezoControl';
import { ClaudeToggle } from './ClaudeToggle';
import { ReceivedTranscripts } from './ReceivedTranscripts';
import { PIEZO_LABELS, type Publication, type PiezoLevel } from './publishing';
import './publishing.css';

type Automation = { status: 'waiting' | 'processing' | 'halted'; accepting: boolean; hasPhoto: boolean; hasTranscript: boolean; eventId: string | null; error: string | null };
type Status = { configured: boolean; oauthReady: boolean; expired: boolean; mode: 'system-user' | 'unified' | 'instagram'; redirectUri: string; selectedId: string | null; accounts: { id: string; username: string }[]; automation: Automation; piezo: { level: PiezoLevel; expiresAt: number | null } };
export default function CardNewsApp() {
  const adminPanel = useRef<HTMLDetailsElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [error, setError] = useState('');
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [adminError, setAdminError] = useState('');
  const [message, setMessage] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [restartTick, setRestartTick] = useState(0);
  useEffect(() => {
    if (location.hash === '#monitor-admin' && adminPanel.current) adminPanel.current.open = true;
  }, []);
  async function act(work: () => Promise<void>) {
    setWorking(true); setAdminError(''); setMessage('');
    try { await work(); setRefreshTick(value => value + 1); }
    catch (error) { setAdminError(error instanceof Error ? error.message : '요청에 실패했습니다.'); }
    finally { setWorking(false); }
  }
  function returnedInstagramFlow() { return new URLSearchParams(location.search).get('instagram_flow'); }
  function clearReturnedInstagramFlow() {
    const url = new URL(location.href); url.searchParams.delete('instagram_flow');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  async function completeConnection() {
    const flow = returnedInstagramFlow();
    const result = await request<{ status: string }>('/api/instagram/complete', flow ? { flow } : {});
    if (result.status !== 'pending') clearReturnedInstagramFlow();
    if (result.status === 'connected') setMessage('인스타그램 연결을 완료했습니다.');
    if (result.status === 'pending') setMessage('인스타그램 로그인을 마친 뒤 연결 확인을 눌러주세요.');
  }
  async function connectInstagram(popup: Window | null) {
    if (!popup) throw Error('새 탭을 열 수 없습니다. 브라우저에서 팝업을 허용한 뒤 다시 시도하세요.');
    try {
      const login = await request<{ url: string }>('/api/instagram/connect', {});
      popup.location.replace(login.url);
      setMessage('새 탭에서 인스타그램 인증을 완료하세요. 이 화면은 그대로 두면 자동으로 연결됩니다.');
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const result = await request<{ status: string }>('/api/instagram/complete', {});
        if (result.status === 'connected') {
          popup.close();
          setMessage('인스타그램 연결을 완료했습니다.');
          return;
        }
        if (result.status === 'idle' && popup.closed) throw Error('인스타그램 인증이 완료되지 않았습니다. 다시 연결해 주세요.');
      }
      throw Error('인스타그램 인증 시간이 만료되었습니다. 다시 연결해 주세요.');
    } catch (error) {
      if (!popup.closed) popup.close();
      throw error;
    }
  }
  async function restart() {
    setRestarting(true);
    try {
      await act(async () => {
        const result = await request<{ automation: Automation }>('/api/publishing/restart', {});
        setStatus(current => current ? { ...current, piezo: { level: 0, expiresAt: null }, automation: result.automation } : current);
        setPublication(null);
        setRestartTick(value => value + 1);
        setMessage('피에조를 0단계로 돌리고 수신 텍스트와 대기 입력을 모두 초기화했습니다. 새 사진부터 보내주세요.');
      });
    } finally { setRestarting(false); }
  }
  useEffect(() => {
    if (!authorized) return;
    let active = true;
    const flow = returnedInstagramFlow();
    void request<{ status: string }>('/api/instagram/complete', flow ? { flow } : {}).then(result => {
      if (result.status !== 'pending') clearReturnedInstagramFlow();
      if (active && result.status === 'connected') { setMessage('인스타그램 연결을 완료했습니다.'); setRefreshTick(value => value + 1); }
    }).catch(error => { if (active) setAdminError(error.message); });
    return () => { active = false; };
  }, [authorized]);
  useEffect(() => {
    if (!authorized) { setStatus(null); setPublication(null); setError(''); setAdminError(''); setMessage(''); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await request<Status>('/api/publishing/status');
        const item = next.automation.eventId ? await request<Publication>(`/api/observations/${next.automation.eventId}`).catch(() => null) : null;
        if (!stopped) { setStatus(next); setPublication(item); setError(''); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : '상태 조회 실패'); }
      finally { if (!stopped) timer = setTimeout(() => void refresh(), 2000); }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [authorized, refreshTick]);
  const automation = status?.automation;
  const account = status?.accounts.find(account => account.id === status.selectedId);
  const level = status?.piezo.level ?? 0;
  const labels = { received: '수신 완료', generating: '카드뉴스 생성 중', draft: '게시 준비 중', publishing: '인스타그램 게시 중', published: '게시 완료', failed: '생성 실패', unknown: '게시 확인 필요', skipped: '초점·흔들림으로 스킵' };
  return <main className="publishing-shell card-preview-shell">
    <h1>파파라치 모니터</h1>
    <p>{status ? `피에조 ${level}단계 · ${PIEZO_LABELS[level]}` : '피에조 상태 확인 전'}</p>
    <section aria-label="자동 게시 상태">
      <div className="monitor-status-heading">
        <h2>자동 게시 상태</h2>
        {authorized && <button type="button" disabled={working || !status} aria-busy={restarting} onClick={() => void restart()}>{restarting ? '중단 후 재시작 중…' : '전체 중단 · 새로 시작'}</button>}
      </div>
      <p role="status">{!automation ? (authorized === false ? '관리자 인증 후 상태를 볼 수 있습니다.' : '서버 상태 확인 중…') : automation.status === 'halted' ? '자동 처리 중지 · 확인 필요' : automation.status === 'processing' ? (publication?.phase || (publication ? labels[publication.status] : '생성 준비 중')) : `수신 대기 · 사진 ${automation.hasPhoto ? '수신됨' : '대기'} · 텍스트 ${automation.hasTranscript ? '수신됨' : '대기'}`}</p>
      {automation?.status === 'waiting' && automation.hasPhoto && <p role="status">사진 수신 완료 · 10초 대기 후 자동 생성합니다. {automation.hasTranscript ? '텍스트 수신 완료' : '텍스트를 기다리는 중이며, 없으면 사진만 사용합니다.'}</p>}
      <p className="setup-note">사진 수신 후 10초가 지나면 카드뉴스를 생성해 자동 게시합니다. 그때까지 도착한 같은 촬영 ID의 텍스트를 함께 쓰고, 없으면 사진만 사용합니다.</p>
      {authorized && <p className="setup-note">새로 시작하면 진행 중인 자동 처리를 중단하고 수신 텍스트 기록과 대기 입력을 모두 초기화합니다. 이미 게시된 콘텐츠와 계정 연결 설정은 유지됩니다.</p>}
      {message && <p role="status">{message}</p>}
      {adminError && <p className="publication-error" role="alert">{adminError}</p>}
      {(error || automation?.error) && <p className="publication-error" role="alert">{error || automation?.error}</p>}
      {automation?.status === 'halted' && <a href="#monitor-admin" onClick={() => { if (adminPanel.current) adminPanel.current.open = true; }}>관리자 영역에서 게시 여부 확인·수신 재개</a>}
      {publication?.status === 'skipped' && <p>사진의 초점이나 흔들림으로 피사체를 알아보기 어려워 카드뉴스를 만들지 않았습니다. 다음 사진을 기다립니다.</p>}
      {publication?.status === 'published' && <p>인스타그램과 사이트 10곳에 게시했습니다. · 게시물 ID: {publication.mediaId}</p>}
    </section>
    {authorized && <ReceivedTranscripts key={restartTick} />}
    {publication?.cards && <section aria-label="최근 카드뉴스"><h2>최근 카드뉴스</h2>
      <div className="card-news-grid">{publication.cards.map((card, index, cards) => <figure key={card.imageId}>
        <img src={`/api/observations/${publication.input.eventId}/cards/${index}`} alt={card.title} />
        <figcaption>{index + 1} / {cards.length} · {card.title}</figcaption>
      </figure>)}</div><p className="card-caption">{publication.caption}</p>
    </section>}
    <details ref={adminPanel} id="monitor-admin" className="monitor-admin">
      <summary>관리자</summary>
      <ClaudeToggle onAccessChange={setAuthorized} />
      {status && <>
        <PiezoControl value={level} disabled={working} onChange={nextLevel => void act(async () => {
          const piezo = await request<Status['piezo']>('/api/publishing/piezo', { piezoLevel: nextLevel });
          setStatus(current => current ? { ...current, piezo } : current);
          setMessage(`피에조 ${piezo.level}단계를 적용했습니다.`);
        })} />
        <section className="instagram-connection" aria-label="인스타그램 연결">
          <div><h2>인스타그램 계정</h2><p>{status.mode === 'system-user' && status.configured ? `서버 시작 설정으로 연결됨 · 계정 ID: ${status.selectedId}` : status.configured ? (account ? `@${account.username} 계정에 자동 게시합니다.` : `연결된 계정 ID: ${status.selectedId}`) : status.expired ? '연결이 만료되었습니다. 다시 로그인하세요.' : '자동 게시할 계정을 연결하세요.'}</p></div>
          {status.mode !== 'system-user' && <>
            <button disabled={working || automation?.status === 'processing' || !status.oauthReady} onClick={() => {
              const popup = window.open('about:blank', 'instagram-oauth', 'popup,width=720,height=820');
              void act(() => connectInstagram(popup));
            }}>{status.configured ? '인스타그램 다시 연결' : '인스타그램 연결'}</button>
            <button disabled={working || automation?.status === 'processing'} onClick={() => void act(completeConnection)}>연결 확인</button>
            {!status.oauthReady && <p className="setup-note">서버의 Meta 앱 연결 설정이 필요합니다.</p>}
            <details><summary>연결 설정 정보</summary><p>Meta에 등록할 Redirect URL</p><code>{status.redirectUri}</code></details>
          </>}
          {status.mode !== 'system-user' && status.accounts.length > 1 && <label className="account-picker">게시 계정<select value={status.selectedId ?? ''} disabled={working || automation?.status === 'processing'} onChange={event => {
            const userId = event.target.value;
            if (userId) void act(async () => { await request('/api/instagram/account', { userId }); });
          }}><option value="" disabled>게시할 계정을 선택하세요</option>{status.accounts.map(account => <option key={account.id} value={account.id}>@{account.username}</option>)}</select></label>}
        </section>
        {automation?.status === 'halted' && <section aria-label="자동 처리 복구">
          <h2>수신 재개</h2>
          <p>인스타그램에서 마지막 게시 여부를 먼저 확인하세요. 재개하면 남아 있는 입력을 비우고 새 사진과 텍스트를 기다립니다.</p>
          <button disabled={working} onClick={() => void act(async () => { await request('/api/publishing/status', {}); setMessage('새 사진과 텍스트 수신을 재개했습니다.'); })}>게시 여부 확인 완료 · 새 입력 수신 재개</button>
        </section>}
      </>}
    </details>
  </main>;
}

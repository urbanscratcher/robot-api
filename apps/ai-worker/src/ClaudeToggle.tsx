import { readApiResponse } from './api-response';
import { useEffect, useState, type FormEvent } from 'react';

type Settings = { enabled: boolean; configured: boolean; editable: boolean; requiresAdmin?: boolean; adminAvailable?: boolean };
export function ClaudeToggle({ onAccessChange }: { onAccessChange?: (allowed: boolean) => void } = {}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [token, setToken] = useState('');
  useEffect(() => { if (settings) onAccessChange?.(settings.editable); }, [settings, onAccessChange]);
  async function refresh() {
    const response = await fetch('/api/ai-settings');
    if (!response.ok) throw Error('Claude 설정을 불러오지 못했습니다.');
    setSettings(await readApiResponse(response));
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ai-settings', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error('Claude 설정을 불러오지 못했습니다.');
      setSettings(await readApiResponse(response));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);
  async function request(path: string, value: unknown) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    const data = await readApiResponse(response);
    if (!response.ok) {
      if (response.status === 403) await refresh();
      throw Error(data.error || '요청을 처리하지 못했습니다.');
    }
    return data;
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    try { await request('/api/admin/login', { token }); await refresh(); setLoginOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : '인증 실패'); }
    finally { setToken(''); setPending(false); }
  }
  async function logout() {
    setPending(true); setError('');
    try { await request('/api/admin/logout', {}); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : '로그아웃 실패'); }
    finally { setPending(false); }
  }
  return <div className="claude-setting">
    <p>Claude API · {settings ? (settings.configured ? '연결 설정됨' : 'API 키 설정 필요') : '확인 중'}</p>
    <small>사진·텍스트는 Claude API로 처리합니다.</small>
    {settings?.requiresAdmin && (settings.editable
      ? <div><small>관리자 인증됨</small> <button type="button" disabled={pending} onClick={() => void logout()}>관리자 로그아웃</button></div>
      : settings.adminAvailable
        ? <><small>관리자 인증 후 모니터링과 게시 관리를 사용할 수 있습니다.</small>
          {!loginOpen ? <div><button type="button" onClick={() => { setLoginOpen(true); setError(''); }}>관리자 인증</button></div>
            : <form className="claude-admin-form" onSubmit={event => void login(event)}>
              <label>관리자 접근 코드<input type="password" name="admin-access-code" autoComplete="off" value={token} maxLength={256} disabled={pending} onChange={event => setToken(event.target.value)} required /></label>
              <small>Claude API 키가 아닌 별도의 관리자 코드입니다.</small>
              <div><button type="submit" disabled={pending || !token}>{pending ? '인증 중…' : '인증하기'}</button> <button type="button" disabled={pending} onClick={() => { setLoginOpen(false); setToken(''); }}>취소</button></div>
            </form>}</>
        : <small>관리자 인증 설정이 필요합니다.</small>)}
    {error && <small role="alert">{error}</small>}
  </div>;
}

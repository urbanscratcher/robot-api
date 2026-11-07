import { useCallback, useEffect, useState } from 'react';

type RobotStatus = {
  driving: boolean;
  online: boolean;
  synced?: boolean;
  hold?: boolean;
  seenMsAgo?: number | null;
};

function lastSeenText(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}분 전` : `${Math.round(minutes / 60)}시간 전`;
}

export function RobotControl() {
  const [robot, setRobot] = useState<RobotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/robot', { signal });
    if (!response.ok) throw Error('기계 상태를 불러오지 못했습니다.');
    setRobot(await response.json() as RobotStatus);
    setError('');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '상태 조회 실패');
    });
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  async function toggle() {
    if (!robot) return;
    const driving = !robot.driving;
    setBusy(true);
    setError('');
    setRobot(current => current ? { ...current, driving, synced: false } : current);
    try {
      const response = await fetch('/api/robot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driving, source: 'panel' }),
      });
      if (!response.ok) throw Error('기계 제어에 실패했습니다.');
      setRobot(await response.json() as RobotStatus);
    } catch (error) {
      setError(error instanceof Error ? error.message : '기계 제어에 실패했습니다.');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const detail = !robot
    ? '상태 확인 중…'
    : !robot.online
      ? `기계 연결 안 됨${robot.seenMsAgo != null ? ` · 마지막 확인 ${lastSeenText(robot.seenMsAgo)}` : ''} · 다시 연결되면 설정이 적용됩니다.`
      : robot.synced
        ? robot.hold ? '켜짐 설정 · 촬영 중이라 잠시 멈춰 있습니다.' : '기계에 반영되었습니다.'
        : '기계에 전달 중…';

  return <section className="robot-control" aria-label="기계 전원 제어">
    <div>
      <h2>기계 제어</h2>
      <p role="status">{detail}</p>
    </div>
    <button
      type="button"
      className={robot?.driving ? 'robot-toggle is-on' : 'robot-toggle'}
      aria-pressed={robot?.driving ?? false}
      disabled={!robot || busy}
      onClick={() => void toggle()}
    >
      {busy ? '전환 중…' : robot?.driving ? '켜짐 · 끄기' : '꺼짐 · 켜기'}
    </button>
    {error && <p className="publication-error" role="alert">{error}</p>}
  </section>;
}

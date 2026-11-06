import { useCallback, useEffect, useRef, useState } from 'react'
import { RobotFace, type Expression } from './components/RobotFace'
import { useCamera } from './hooks/useCamera'
import { AUTO_CAPTURE, OBSERVATION_TOKEN, OBSERVATION_URL, VISIT } from './config'
import { usePersonDetector } from './hooks/usePersonDetector'
import { sendObservation, sendTranscript } from './observation'
import { startListening, type SpeechSession } from './speech'
import {
  isPublicationProblem,
  isPublished,
  publicationStage,
  waitForAnyPublication,
  type PublicationConnection,
  type PublicationStatus,
} from './publication'

type CaptureState = { kind: 'idle' | 'busy' | 'ok' | 'error'; message: string }
type VisitState = { phase: 'idle' | 'running' | 'processing'; photos: number; until: number; eventId?: string }
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const VOICE_FILES = [
  '/audio/voice-1.wav',
  '/audio/voice-2.wav',
  '/audio/voice-3.wav',
  '/audio/voice-4.wav',
  '/audio/voice-5.wav',
]

interface WakeLockSentinelLike extends EventTarget {
  released: boolean
  release(): Promise<void>
}

export default function App() {
  const [expression, setExpression] = useState<Expression>('happy')
  const [glitchKey, setGlitchKey] = useState(0)
  const [glitching, setGlitching] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const secretTapRef = useRef({ count: 0, lastTap: 0 })
  const audioPlayersRef = useRef<HTMLAudioElement[]>([])
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastAudioIndexRef = useRef(-1)
  const glitchTimerRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const { videoRef, status, startCamera, stopCamera, captureFrame } = useCamera()

  const requestWakeLock = useCallback(async () => {
    if (document.visibilityState !== 'visible' || wakeLockRef.current) return
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock
    if (!wakeLock) return
    try {
      const sentinel = await wakeLock.request('screen')
      wakeLockRef.current = sentinel
      sentinel.addEventListener('release', () => { wakeLockRef.current = null }, { once: true })
    } catch {
      // Wake Lock is optional and can be rejected by iOS or battery settings.
    }
  }, [])

  // 아파하는 반응: 글리치 + 아픈 표정 + 녹음 재생. 화면 탭과 ESP32 피에조 충격이 같이 쓴다.
  const triggerHurt = useCallback(() => {
    setExpression('hurt')
    setGlitchKey((current) => current + 1)
    setGlitching(true)
    if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
    glitchTimerRef.current = window.setTimeout(() => setGlitching(false), 620)
    if (audioPlayersRef.current.length) {
      let nextIndex = Math.floor(Math.random() * audioPlayersRef.current.length)
      if (audioPlayersRef.current.length > 1 && nextIndex === lastAudioIndexRef.current) {
        nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (audioPlayersRef.current.length - 1))) % audioPlayersRef.current.length
      }
      currentAudioRef.current?.pause()
      if (currentAudioRef.current) currentAudioRef.current.currentTime = 0
      const player = audioPlayersRef.current[nextIndex]
      player.currentTime = 0
      player.onended = () => setExpression('happy')
      player.onerror = () => setExpression('happy')
      currentAudioRef.current = player
      lastAudioIndexRef.current = nextIndex
      // 소리를 못 내도(자동 재생 차단 등) 아픈 표정은 잠깐 보여준다.
      void player.play().catch(() => window.setTimeout(() => setExpression('happy'), 1500))
    } else window.setTimeout(() => setExpression('happy'), 1500)
  }, [])

  // iPhone은 사용자가 화면을 만진 뒤에만 소리를 낼 수 있다. 첫 터치 때 녹음 5개를 모두 소리 없이
  // 한 번 재생해 두면, 이후 피에조 충격처럼 터치 없이 온 신호에도 소리가 난다.
  const audioUnlockedRef = useRef(false)
  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current) return
    audioUnlockedRef.current = true
    audioPlayersRef.current.forEach((player) => {
      player.muted = true
      void player.play().then(() => {
        if (player !== currentAudioRef.current) { player.pause(); player.currentTime = 0 }
      }).catch(() => undefined).finally(() => { player.muted = false })
    })
  }, [])

  const handleTouch = useCallback((event: React.PointerEvent<HTMLElement>) => {
    unlockAudio()
    const inSecretCorner = event.clientX <= window.innerWidth * 0.16 && event.clientY <= window.innerHeight * 0.22
    if (inSecretCorner) {
      const now = performance.now()
      const nextCount = now - secretTapRef.current.lastTap < 700 ? secretTapRef.current.count + 1 : 1
      secretTapRef.current = { count: nextCount, lastTap: now }
      if (nextCount >= 3) {
        secretTapRef.current = { count: 0, lastTap: 0 }
        setAdminOpen(true)
        void startCamera()
      }
      return
    }

    secretTapRef.current = { count: 0, lastTap: 0 }
    triggerHurt()
    void startCamera()
    void requestWakeLock()
  }, [requestWakeLock, startCamera, triggerHurt, unlockAudio])

  // ESP32 피에조 충격: 서버(/api/events)가 'hurt'를 보내면 탭한 것처럼 아파한다.
  const [hurtLink, setHurtLink] = useState<'connecting' | 'open' | 'closed'>('connecting')
  useEffect(() => {
    const events = new EventSource('/api/events')
    events.onopen = () => setHurtLink('open')
    events.onerror = () => setHurtLink(events.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
    events.addEventListener('hurt', () => triggerHurt())
    return () => events.close()
  }, [triggerHurt])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      // iPhone Safari may only provide fullscreen through an installed PWA.
    }
  }, [])

  const restartCamera = useCallback(async () => {
    stopCamera()
    await startCamera()
  }, [startCamera, stopCamera])

  const [capture, setCapture] = useState<CaptureState>({ kind: 'idle', message: '' })
  const [publication, setPublication] = useState<PublicationStatus | null>(null)
  const [publicationConnection, setPublicationConnection] = useState<PublicationConnection>('connecting')

  // 취재: 사람을 보면 사진 3장(0·4·8초)을 찍어 /api/observations 로 보내고, 20초 동안 들은 말을
  // 글자로 바꿔 /api/transcripts 로 보낸다. 이후 published 신호가 올 때까지 사람 인식과 다음 취재를 멈춘다.
  const [visit, setVisit] = useState<VisitState>({ phase: 'idle', photos: 0, until: 0 })
  const visitPhaseRef = useRef<VisitState['phase']>('idle')
  const publicationAbortRef = useRef<AbortController | null>(null)
  const [, setClockTick] = useState(0)
  useEffect(() => {
    if (visit.phase === 'idle') return
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 500)
    return () => window.clearInterval(timer)
  }, [visit.phase])

  const runVisit = useCallback(async () => {
    if (visitPhaseRef.current !== 'idle') return
    if (!OBSERVATION_URL || !OBSERVATION_TOKEN) {
      setCapture({ kind: 'error', message: OBSERVATION_URL ? '토큰 미설정' : 'API 경로 미설정' })
      return
    }
    visitPhaseRef.current = 'running'
    setPublication(null)
    const startedAt = Date.now()
    setVisit({ phase: 'running', photos: 0, until: startedAt + VISIT.listenMs })
    setCapture({ kind: 'busy', message: '' })
    await startCamera()

    let speech: SpeechSession | null = null
    try { speech = startListening('ko-KR') } catch { speech = null }

    let photosSent = 0
    const publicationEventIds: string[] = []
    const photoJobs = VISIT.photoDelaysMs.map((delay) => sleep(delay).then(async () => {
      const photo = await captureFrame()
      if (!photo) return
      try {
        const { response, eventId } = await sendObservation({ image: photo })
        if (response.ok) {
          publicationEventIds.push(eventId)
          photosSent += 1
          setVisit((current) => ({ ...current, photos: photosSent }))
        }
      } catch {
        // 네트워크 오류: 아래 결과 메시지에 장수로만 드러난다.
      }
    }))

    await sleep(VISIT.listenMs)
    const text = speech ? await speech.stop() : ''
    await Promise.all(photoJobs)

    let transcriptResult: string
    if (!speech) transcriptResult = '음성 인식 미지원'
    else if (!text) transcriptResult = speech.lastError() === 'not-allowed' ? '마이크 거부' : '말소리 없음'
    else {
      try {
        const response = await sendTranscript(text)
        transcriptResult = response.ok ? '대화 전송' : `대화 실패 ${response.status}`
      } catch {
        transcriptResult = '대화 실패(네트워크)'
      }
    }
    const allOk = photosSent === VISIT.photoDelaysMs.length && transcriptResult === '대화 전송'
    setCapture({ kind: allOk ? 'ok' : 'error', message: `사진 ${photosSent}/${VISIT.photoDelaysMs.length} · ${transcriptResult}` })
    setLastTranscript(text)

    if (!publicationEventIds.length) {
      visitPhaseRef.current = 'idle'
      setVisit({ phase: 'idle', photos: 0, until: 0 })
      return
    }

    visitPhaseRef.current = 'processing'
    setVisit({ phase: 'processing', photos: photosSent, until: 0, eventId: publicationEventIds[0] })
    const controller = new AbortController()
    publicationAbortRef.current = controller
    try {
      const completed = await waitForAnyPublication(publicationEventIds, controller.signal, (update) => {
        if (update.kind === 'connection') setPublicationConnection(update.connection)
        else setPublication(update.publication)
      })
      setCapture({
        kind: 'ok',
        message: isPublished(completed.status)
          ? `게시 완료 · ${completed.eventId}`
          : `게시 관리자 전달 완료 · ${completed.eventId}`,
      })
    } catch {
      if (!controller.signal.aborted) setCapture({ kind: 'error', message: '게시 확인 연결 실패' })
      return
    } finally {
      if (publicationAbortRef.current === controller) publicationAbortRef.current = null
    }
    visitPhaseRef.current = 'idle'
    setVisit({ phase: 'idle', photos: 0, until: 0 })
  }, [captureFrame, startCamera])

  const [lastTranscript, setLastTranscript] = useState('')
  const [autoCapture, setAutoCapture] = useState(true)
  const onPersonPresent = useCallback(() => { void runVisit() }, [runVisit])
  const detector = usePersonDetector(
    videoRef,
    autoCapture && status === 'active' && visit.phase === 'idle',
    AUTO_CAPTURE,
    onPersonPresent,
  )

  const secondsLeft = Math.max(0, Math.ceil((visit.until - Date.now()) / 1000))
  const publicationText = publication
    ? `${publicationStage(publication)}${publication.error ? ` · ${publication.error}` : ''}`
    : publicationConnection === 'reconnecting' ? '상태 연결 재시도 중' : '게시 상태 연결 중'
  const statusText = visit.phase === 'running'
    ? `취재 중 · 사진 ${visit.photos}/${VISIT.photoDelaysMs.length} · 듣기 ${secondsLeft}초`
    : visit.phase === 'processing'
      ? publicationText
      : capture.message

  useEffect(() => {
    audioPlayersRef.current = VOICE_FILES.map((source) => {
      const audio = new Audio(source)
      audio.preload = 'auto'
      return audio
    })
    return () => {
      publicationAbortRef.current?.abort()
      if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
      audioPlayersRef.current.forEach((audio) => {
        audio.pause()
        audio.src = ''
      })
      audioPlayersRef.current = []
    }
  }, [])

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') void requestWakeLock()
    }
    document.addEventListener('visibilitychange', resume)
    return () => document.removeEventListener('visibilitychange', resume)
  }, [requestWakeLock])

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  // Expose frame capture for a future AI integration without adding server traffic.
  useEffect(() => {
    window.captureFrame = captureFrame
    return () => { delete window.captureFrame }
  }, [captureFrame])

  return (
    <main className="app" onPointerUp={handleTouch}>
      <div
        className={`face-stage${glitching ? ' is-glitching' : ''}`}
        style={glitching ? { animationName: glitchKey % 2 ? 'glitch-hit-a' : 'glitch-hit-b' } : undefined}
      >
        <RobotFace expression={expression} />
      </div>
      {glitching && <div key={glitchKey} className="glitch-overlay" aria-hidden="true" />}
      {import.meta.env.DEV && <div className={`camera-status status-${status}`}>camera: {status}</div>}
      {visit.phase === 'processing' && (
        <div
          className={`publication-stage${publication && isPublicationProblem(publication.status) ? ' is-problem' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="publication-stage-dot" aria-hidden="true" />
          <span>{publicationText}</span>
          {publicationConnection === 'reconnecting' && <small>재연결 중</small>}
        </div>
      )}
      <section
        className={`admin-panel${adminOpen ? ' is-open' : ''}`}
        onPointerUp={(event) => event.stopPropagation()}
        aria-label="관리자 패널"
        aria-hidden={!adminOpen}
      >
          <header className="admin-header">
            <div>
              <p className="admin-kicker">
                ROBOT FACE · 피에조 {hurtLink === 'open' ? '연결됨' : hurtLink === 'connecting' ? '연결 중' : '끊김'}
              </p>
              <h1>관리자 패널</h1>
            </div>
            {statusText && <p className={`capture-status capture-${visit.phase === 'running' ? 'busy' : publication && isPublicationProblem(publication.status) ? 'error' : capture.kind}`} role="status">{statusText}</p>}
            <button className="icon-button" type="button" onClick={() => setAdminOpen(false)} aria-label="관리자 패널 닫기">×</button>
          </header>

          <div className="admin-camera-card">
            <div className="camera-frame">
              <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
            </div>
            <div className="camera-meta">
              <span className={`status-dot status-${status}`} />
              <span>전면 카메라</span>
              <span className={`person-meta${detector.person && detector.person.score >= AUTO_CAPTURE.minScore ? ' is-present' : ''}`}>
                {detector.state === 'off' ? (autoCapture ? '사람 인식 대기' : '사람 인식 꺼짐')
                  : detector.state === 'loading' ? '사람 인식 준비 중…'
                  : detector.state === 'error' ? '사람 인식 실패'
                  : detector.person && detector.person.score >= AUTO_CAPTURE.minScore
                    ? `사람 ${Math.round(detector.person.score * 100)}%`
                    : '사람 없음'}
              </span>
              <strong>{status === 'active' ? '정상 작동 중' : status}</strong>
            </div>
            {lastTranscript && <p className="last-transcript">“{lastTranscript}”</p>}
          </div>

          <div className="admin-controls">
            <div className="admin-actions">
            <button
              type="button"
              className={autoCapture ? 'is-on' : undefined}
              onClick={() => setAutoCapture((on) => !on)}
              aria-pressed={autoCapture}
            >
              <span className="action-icon">◉</span>
              <span>자동 촬영 {autoCapture ? '켜짐' : '꺼짐'}</span>
            </button>
            <button
              type="button"
              className={visit.phase === 'running' ? 'is-recording' : undefined}
              onClick={() => { void runVisit() }}
              disabled={visit.phase !== 'idle'}
            >
              <span className="action-icon">●</span>
              <span>지금 취재</span>
            </button>
            <button type="button" onClick={toggleFullscreen}>
              <span className="action-icon">{isFullscreen ? '↙' : '↗'}</span>
              <span>{isFullscreen ? '전체화면 종료' : '전체화면 시작'}</span>
            </button>
            <button type="button" onClick={restartCamera}>
              <span className="action-icon">↻</span>
              <span>카메라 재시작</span>
            </button>
            </div>

            <p className="admin-note">iPhone Safari에서는 홈 화면에 추가한 앱으로 실행하면 가장 넓은 화면을 사용할 수 있습니다.</p>
          </div>
        </section>
    </main>
  )
}

declare global {
  interface Window {
    captureFrame?: () => Promise<Blob | null>
  }
}
